import { localTripRepository } from '@/lib/localTripRepository';
import { nativeTripArchive, sha256Hex, streamJsonToMigration } from '@/lib/nativeTripArchive';

let migrationPromise = null;

const initialPass = (phase, baseline = null) => ({
  phase,
  pageCursor: null,
  rowOffset: 0,
  visitedCount: 0,
  quarantineCount: 0,
  manifestHash: '0'.repeat(64),
  baseline,
});

const chainStep = async (priorHex, id, sourceHash) => {
  const bytes = new TextEncoder().encode(`${priorHex}\u0000${id}\u0000${sourceHash}`);
  try { return await sha256Hex(bytes); } finally { bytes.fill(0); }
};

const saveCheckpoint = async (state) => {
  await nativeTripArchive.saveMigrationCheckpoint({ ...state });
  return state;
};

/**
 * One or more bounded legacy-scan pages.
 *
 * `maxPages = 0` scans the pass to its end, which is what the historical
 * run-to-completion caller needs. A scheduler turn passes a page ceiling and
 * reads `passComplete` to decide whether it still has more work. `passComplete`
 * is deliberately not part of the persisted state: the manifest/pass checkpoint
 * schema is domain-owned and unchanged.
 */
async function scanLegacyPages(resume, phase, baseline = null, { maxPages = 0 } = {}) {
  const state = resume?.phase === phase ? { ...resume } : initialPass(phase, baseline);
  const pageCeiling = Math.max(0, Math.floor(Number(maxPages) || 0));
  let pages = 0;
  // P4-C-F09: `state.visitedCount` is the pass total. What a turn consumed is
  // what *this* invocation visited, which is what the coordinator budgets.
  let visited = 0;
  do {
    const pageCursor = state.pageCursor || null;
    const page = await localTripRepository.listLegacyMigrationPage({ cursor: pageCursor, limit: 50 });
    const rows = page.rows || [];
    for (let index = Math.max(0, Number(state.rowOffset) || 0); index < rows.length; index += 1) {
      const row = rows[index];
      let trip;
      try {
        try {
          trip = await localTripRepository.getLegacyTripForMigration(row.id);
          if (!trip) throw new Error('Legacy trip source record is missing');
        } catch (error) {
          state.quarantineCount += 1;
          state.manifestHash = await chainStep(state.manifestHash, String(row.id), 'UNREADABLE');
          if (phase === 'MIGRATING') {
            await nativeTripArchive.quarantineLegacySource({
              sourceLocator: `indexeddb:trips:${String(row.id)}`,
              knownMetadata: row,
              errorClass: String(error?.name || 'UnreadableLegacySource'),
              errorDetail: String(error?.message || error || 'Legacy source unreadable').slice(0, 240),
            });
          }
          trip = null;
        }
        if (trip) {
          // IndexedDB necessarily materializes one legacy record. Emit it
          // directly in bounded native-ingress chunks without another full
          // JSON string. Target admission/plugin/commit failures deliberately
          // escape: they are retryable target failures, not source corruption.
          const committed = await streamJsonToMigration(trip);
          const sourceHash = String(committed?.payloadHash || '');
          if (!/^[0-9a-f]{64}$/i.test(sourceHash)) throw new Error('Native migration did not return a source hash');
          state.manifestHash = await chainStep(state.manifestHash, String(row.id), sourceHash);
        }
      } finally {
        trip = null;
      }
      state.visitedCount += 1;
      visited += 1;
      state.rowOffset = index + 1;
      await saveCheckpoint(state);
    }
    if (!page.hasMore) {
      state.pageCursor = null;
      state.rowOffset = 0;
      return { state, passComplete: true, visited };
    }
    state.pageCursor = page.nextCursor;
    state.rowOffset = 0;
    await saveCheckpoint(state);
    pages += 1;
    if (pageCeiling > 0 && pages >= pageCeiling) return { state, passComplete: false, visited };
  } while (state.pageCursor);
  return { state, passComplete: true, visited };
}

const scanLegacy = async (resume, phase, baseline = null) => (
  (await scanLegacyPages(resume, phase, baseline)).state
);

/**
 * P4-C-F03. Only an exactly-verified promotion is terminal.
 *
 * `SHORTFALL` used to sit here too, which made an unverified cutover - the
 * state native reports as `RECOVERY_REQUIRED` - indistinguishable from success:
 * the turn answered `done`, the coordinator marked the logical job complete and
 * counted it towards `background-complete(E)`, and nothing ever surfaced or
 * retried it. It is now a finalize phase instead, so the comparison/promotion
 * is re-attempted when the authority condition it is waiting on changes.
 */
const MIGRATION_TERMINAL_PHASES = new Set(['VERIFIED']);

/**
 * The verification pass is complete and the only work left is the domain's own
 * comparison and exact promotion. `READY_TO_FINALIZE` is persisted by the turn
 * that finishes verification; `SHORTFALL` is the same position after a
 * promotion native refused.
 */
const MIGRATION_READY_TO_FINALIZE = 'READY_TO_FINALIZE';
const MIGRATION_FINALIZE_PHASES = new Set([MIGRATION_READY_TO_FINALIZE, 'SHORTFALL']);

let turnPromise = null;

const finishMigration = async (verifiedState, baseline) => {
  const stable = baseline.visitedCount === verifiedState.visitedCount &&
    baseline.quarantineCount === verifiedState.quarantineCount &&
    baseline.manifestHash === verifiedState.manifestHash;
  const result = await nativeTripArchive.completeMigration({
    expectedCount: baseline.visitedCount,
    visitedCount: stable ? verifiedState.visitedCount : baseline.visitedCount + 1,
    quarantineCount: baseline.quarantineCount + (stable ? 0 : 1),
    manifestHash: verifiedState.manifestHash,
  });
  await saveCheckpoint({
    phase: result?.verified ? 'VERIFIED' : 'SHORTFALL',
    visitedCount: verifiedState.visitedCount,
    quarantineCount: baseline.quarantineCount + (stable ? 0 : 1),
    manifestHash: verifiedState.manifestHash,
    // P4-C-F03: a refused promotion stays at the finalize position, so the
    // baseline the comparison needs must survive with it. The comparison
    // inputs are unchanged, so a later retry asks native exactly the same
    // question and can only promote once.
    baseline,
    result: { verified: result?.verified === true, authorityState: result?.authorityState || null },
  });
  return result;
};

async function runMigrationTurn({ maxPages }) {
  // Bounded unit 1: one existing journal ingest. Its own caps are unchanged.
  const journal = await nativeTripArchive.ingestJournal(8, 8 * 1024 * 1024);
  if (journal?.hasMore && (journal?.itemCount || 0) > 0) {
    return { outcome: 'hasMore', unit: 'journal', itemCount: journal.itemCount };
  }

  const stored = await nativeTripArchive.migrationCheckpoint().catch(() => ({ checkpoint: null }));
  const checkpoint = stored?.checkpoint || null;
  if (checkpoint?.phase && MIGRATION_TERMINAL_PHASES.has(checkpoint.phase)) {
    return { outcome: 'done', unit: 'already-verified', verified: checkpoint.result?.verified === true, itemCount: 0 };
  }

  // Bounded unit 4 (P4-C-F03): comparison and exact promotion alone, with no
  // verification-page traversal. An unverified result is never `done` - native
  // has put the archive in RECOVERY_REQUIRED, writes stay fail-closed, and the
  // turn defers on the same canonical-health condition every other authority
  // wait uses, so the next lifecycle epoch retries the promotion exactly once.
  if (checkpoint?.phase && MIGRATION_FINALIZE_PHASES.has(checkpoint.phase)) {
    const finalizeBaseline = checkpoint.baseline || checkpoint;
    const result = await finishMigration(checkpoint, finalizeBaseline);
    // A promotion turn traverses no rows: it is a comparison and a cutover, so
    // it truthfully consumes zero of the job's row budget (P4-C-F09).
    if (result?.verified === true) {
      return { outcome: 'done', unit: 'verified', verified: true, result, itemCount: 0 };
    }
    return {
      outcome: 'deferred',
      unit: 'shortfall',
      verified: false,
      code: 'RECOVERY_REQUIRED',
      authorityState: result?.authorityState || 'RECOVERY_REQUIRED',
      result,
      itemCount: 0,
    };
  }

  // Bounded unit 2: one page of the MIGRATING pass.
  if (!checkpoint || checkpoint.phase === 'MIGRATING') {
    const { state, passComplete, visited } = await scanLegacyPages(checkpoint, 'MIGRATING', null, { maxPages });
    if (!passComplete) return { outcome: 'hasMore', unit: 'migrating', visitedCount: state.visitedCount, itemCount: visited };
    await saveCheckpoint(initialPass('VERIFYING', {
      visitedCount: state.visitedCount,
      quarantineCount: state.quarantineCount,
      manifestHash: state.manifestHash,
    }));
    return { outcome: 'hasMore', unit: 'migrating-complete', visitedCount: state.visitedCount, itemCount: visited };
  }

  // Bounded unit 3: one page of the VERIFYING pass. The comparison and exact
  // promotion are deliberately NOT part of it (P4-C-F03): the last
  // verification page used to consume its page *and* the distinct promotion
  // operation in the same turn, which is two bounded units, not one.
  const { state, passComplete, visited } = await scanLegacyPages(checkpoint, 'VERIFYING', checkpoint.baseline, { maxPages });
  if (!passComplete) return { outcome: 'hasMore', unit: 'verifying', visitedCount: state.visitedCount, itemCount: visited };
  const baseline = state.baseline || checkpoint.baseline;
  await saveCheckpoint({
    phase: MIGRATION_READY_TO_FINALIZE,
    pageCursor: null,
    rowOffset: 0,
    visitedCount: state.visitedCount,
    quarantineCount: state.quarantineCount,
    manifestHash: state.manifestHash,
    baseline,
  });
  return { outcome: 'hasMore', unit: 'verifying-complete', visitedCount: state.visitedCount, itemCount: visited };
}

/**
 * One bounded migration scheduler turn.
 *
 * The coordinator owns when the next turn runs. Manifest, pass/row checkpoints,
 * two-pass verification, quarantine, source-vs-target failure classification,
 * low-space semantics and exact promotion/cutover all stay where they are.
 * Low-space is surfaced as `backoff` rather than a failure so a blocked device
 * waits instead of spinning.
 */
export function stepLegacyMigration({ maxPages = 1 } = {}) {
  if (turnPromise) return turnPromise;
  const pages = Math.max(1, Math.floor(Number(maxPages) || 1));
  turnPromise = runMigrationTurn({ maxPages: pages })
    .catch((error) => {
      if (error?.code === 'LOW_SPACE_BLOCKED') {
        return { outcome: 'backoff', unit: 'low-space', code: error.code };
      }
      if (error?.code === 'RECOVERY_REQUIRED') {
        return { outcome: 'deferred', unit: 'recovery', code: error.code };
      }
      return { outcome: 'failing', unit: 'migration', code: error?.code || 'MIGRATION_FAILED', error };
    })
    .finally(() => { turnPromise = null; });
  return turnPromise;
}

/** True while a bounded migration instance is mid-turn. */
export const isMigrationTurnInFlight = () => turnPromise !== null;

export async function migrateLegacyTripsToNativeArchive() {
  if (migrationPromise) return migrationPromise;
  migrationPromise = (async () => {
    let journal;
    do {
      journal = await nativeTripArchive.ingestJournal(8, 8 * 1024 * 1024);
    } while (journal?.hasMore && (journal?.itemCount || 0) > 0);

    const stored = await nativeTripArchive.migrationCheckpoint().catch(() => ({ checkpoint: null }));
    let checkpoint = stored?.checkpoint || null;
    let migrated;
    if (checkpoint?.phase === 'VERIFYING') {
      migrated = checkpoint.baseline;
    } else {
      migrated = await scanLegacy(checkpoint, 'MIGRATING');
      checkpoint = await saveCheckpoint(initialPass('VERIFYING', {
        visitedCount: migrated.visitedCount,
        quarantineCount: migrated.quarantineCount,
        manifestHash: migrated.manifestHash,
      }));
    }

    const verified = await scanLegacy(checkpoint, 'VERIFYING', migrated);
    const baseline = verified.baseline || migrated;
    const stable = baseline.visitedCount === verified.visitedCount &&
      baseline.quarantineCount === verified.quarantineCount &&
      baseline.manifestHash === verified.manifestHash;
    const result = await nativeTripArchive.completeMigration({
      expectedCount: baseline.visitedCount,
      visitedCount: stable ? verified.visitedCount : baseline.visitedCount + 1,
      quarantineCount: baseline.quarantineCount + (stable ? 0 : 1),
      manifestHash: verified.manifestHash,
    });
    await saveCheckpoint({
      phase: result?.verified ? 'VERIFIED' : 'SHORTFALL',
      visitedCount: verified.visitedCount,
      quarantineCount: baseline.quarantineCount + (stable ? 0 : 1),
      manifestHash: verified.manifestHash,
      result: { verified: result?.verified === true, authorityState: result?.authorityState || null },
    });
    return result;
  })().finally(() => { migrationPromise = null; });
  return migrationPromise;
}
