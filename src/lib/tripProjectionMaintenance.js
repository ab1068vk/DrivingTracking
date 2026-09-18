import { PROJECTION_STALE_VERSION, TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';

/**
 * Projection-local maintenance state (P3).
 *
 * Deliberately narrow: migration/backfill, completeness verification, tombstone
 * cleanup and the two bounded suppression states. This is **not** P5's general
 * maintenance coordinator — there is no budget scheduler, no priority class and
 * no cross-subsystem watermark table.
 *
 * Every state record is constant-size. Nothing here grows with retained history
 * or with the number of deletes.
 */

export const META_KEYS = Object.freeze({
  MIGRATION: 'projection_migration',
  VERIFY: 'projection_verify',
  DELETE_CLEANUP: 'projection_delete_cleanup',
  DELETE_SEQ: 'delete_seq',
  NATIVE_VISIBILITY: 'native_visibility',
  NATIVE_SUPPRESSION: 'native_suppression',
  NATIVE_ERASURE_PENDING: 'native_erasure_pending',
  FALLBACK_SUPPRESSION: 'fallback_suppression',
  MAINTENANCE: 'maintenance_state',
  /**
   * P4-C-F04: which of backfill / verification / cleanup the *next* coordinated
   * projection turn runs. It lives in `trip_meta` with every other projection
   * cursor because the projection domain owns its own phase; the coordinator
   * keeps nothing durable.
   */
  MAINTENANCE_PHASE: 'projection_maintenance_phase',
});

/** The one-subpass-per-turn sequence, in order. */
export const PROJECTION_MAINTENANCE_PHASES = Object.freeze(['backfill', 'verify', 'cleanup']);

/** Bounded legacy suppression sample; P3.5 native intake itself has no entry-count ceiling. */
export const NATIVE_SUPPRESSION_SAMPLE_MAX = 512;

/** Hard ceiling on explicit fallback-suppression ids before the global flag takes over. */
export const MAX_FALLBACK_SUPPRESSION_IDS = 512;

/** Bounded turn sizes. Total work stays O(N); each turn does not. */
export const BACKFILL_ROWS_PER_TURN = 8;
export const VERIFY_ROWS_PER_TURN = 256;
export const VERIFY_POINT_READS_PER_TURN = 8;
export const CLEANUP_ROWS_PER_TURN = 32;
export const CLEANUP_SOFT_TURN_BYTES = 2 * 1024 * 1024;

/**
 * P4-C-F09 — independent source-row reads one *repaired* row costs, beyond the
 * window read that discovered it.
 *
 * Repair does not reuse the row it was handed; every stage re-reads the source
 * so it cannot act on a stale copy:
 *
 *  1. `repairVerifiedMismatches` re-reads the row to classify it live vs orphan;
 *  2. the live path re-reads it in `repairProjectionsForRows` to decrypt the
 *     full trip - and the orphan path re-reads it inside the delete transaction;
 *  3. the live path re-reads it once more inside the guarded
 *     `commitProjectionRecord` transaction, which is what makes the write safe
 *     against a concurrent update.
 *
 * The orphan path therefore costs 2 and the live path 3. The live path is the
 * maximum, and eliminating any of these reads would weaken the guard, so they
 * are counted rather than removed.
 */
export const PROJECTION_REPAIR_READS_PER_MISMATCH = 3;

/**
 * A backfill row that needs a projection costs the same repair reads minus the
 * mismatch classification read: `repairProjectionsForRows` reads it, and the
 * guarded commit reads it again.
 */
export const PROJECTION_REPAIR_READS_PER_BACKFILL_ROW = 2;

/**
 * P4-C-F09 — records a single projection subpass may examine, derived from the
 * window constants above rather than asserted.
 *
 *  - backfill reads `BACKFILL_ROWS_PER_TURN` source rows, probes the projection
 *    row of each (2 x 8), and may repair every one of them
 *    (8 x `PROJECTION_REPAIR_READS_PER_BACKFILL_ROW`);
 *  - verification reads a source window *and* a projection window (2 x 256) and
 *    may repair up to `VERIFY_POINT_READS_PER_TURN` mismatches, each costing
 *    `PROJECTION_REPAIR_READS_PER_MISMATCH` further independent reads;
 *  - cleanup materializes at most one row past its window: 32 + 1.
 *
 * Only one of them runs per coordinated turn, so the slice ceiling is their
 * maximum, not their sum.
 */
export const BACKFILL_MAX_EXAMINED = (BACKFILL_ROWS_PER_TURN * 2)
  + (BACKFILL_ROWS_PER_TURN * PROJECTION_REPAIR_READS_PER_BACKFILL_ROW);

export const VERIFY_MAX_EXAMINED = (VERIFY_ROWS_PER_TURN * 2)
  + (VERIFY_POINT_READS_PER_TURN * PROJECTION_REPAIR_READS_PER_MISMATCH);

export const CLEANUP_MAX_EXAMINED = CLEANUP_ROWS_PER_TURN + 1;

export const PROJECTION_SUBPASS_MAX_EXAMINED = Math.max(
  BACKFILL_MAX_EXAMINED,
  VERIFY_MAX_EXAMINED,
  CLEANUP_MAX_EXAMINED,
);

export const defaultMigrationState = () => ({
  state: 'unseen', target_version: TRIP_PROJECTION_VERSION, cursor: null, converted: 0,
  started_at: null, updated_at: null,
});

export const defaultVerifyState = () => ({
  // Two independent positions: advancing only the source side can skip
  // unverified projection rows, and an orphan-only projection store would never
  // advance a source-only cursor at all.
  cursor: null, sourceCursor: null, projectionCursor: null,
  generation: 0, checked: 0, mismatches: 0, status: 'idle',
});

export const defaultCleanupState = () => ({
  cursor: null, sampledSeqStart: null, sampledSeqEnd: null, generation: 0, status: 'idle',
});

export const defaultNativeVisibility = () => ({ state: 'known', generation: 0, since: null });

export const defaultNativeErasurePending = () => ({ pending: false, since: null, attempts: 0 });

export const defaultFallbackSuppression = () => ({
  generation: 0, ids: {}, saturated: false, since: null,
});

// ─── native visibility ────────────────────────────────────────────────────────

/**
 * Record a delete against native visibility.
 *
 * A **successful** probe creates an exact per-id entry only when the journal
 * actually holds that id, so the set is bounded by the journal's own 64-entry
 * maximum and ordinary deletes never consume capacity. A **failed** probe writes
 * no per-id entry at all — it flips one global flag — so 100, 1,000 or 10,000
 * deletes during a bridge outage produce constant metadata.
 *
 * @returns {{ visibility: object, suppression: object }}
 */
export function recordDeleteForNative({ visibility, suppression, tripId, probe }) {
  const nextVisibility = { ...visibility };
  const nextSuppression = { ...suppression, ids: { ...suppression.ids } };

  if (probe.ok === false) {
    if (nextVisibility.state !== 'uncertain') {
      nextVisibility.state = 'uncertain';
      nextVisibility.generation = (nextVisibility.generation || 0) + 1;
      nextVisibility.since = probe.at ?? null;
    }
    return { visibility: nextVisibility, suppression: nextSuppression };
  }
  if (probe.present) {
    nextSuppression.ids[String(tripId)] = { at: probe.at ?? null };
  }
  return { visibility: nextVisibility, suppression: nextSuppression };
}

/**
 * Resolve an outage using the bounded journal snapshot: create exact suppression
 * only for ids that are both still tombstoned and present in the bounded probe.
 */
export function resolveNativeVisibility({ suppression, journalIds, tombstonedIds, at = null }) {
  const ids = { ...suppression.ids };
  const tombstoned = new Set(tombstonedIds.map(String));
  journalIds.slice(0, NATIVE_SUPPRESSION_SAMPLE_MAX).forEach((id) => {
    if (tombstoned.has(String(id))) ids[String(id)] = { at };
  });
  return {
    visibility: { state: 'known', generation: suppression.generation ?? 0, since: null },
    suppression: { ...suppression, ids },
  };
}

/** Native completions are hidden while visibility is uncertain or an erase is pending. */
export const nativeImportSuppressed = ({ visibility, erasurePending, suppression, tripId }) => (
  visibility.state === 'uncertain'
  || erasurePending.pending === true
  || Object.prototype.hasOwnProperty.call(suppression.ids, String(tripId))
);

// ─── fallback suppression ─────────────────────────────────────────────────────

/**
 * Add a deleted id to the fallback overlay.
 *
 * At most `MAX_FALLBACK_SUPPRESSION_IDS` explicit ids are ever stored. Insertion
 * beyond that does **not** append — it flips a global saturated flag — so 10,000
 * deletes cannot produce 10,000 entries. While saturated, fallback exposure fails
 * closed; the whole-blob rewrite stays background work and never becomes a
 * foreground prerequisite.
 */
export function suppressFallbackId(state, tripId, at = null) {
  if (state.saturated) return state;
  const key = String(tripId);
  if (Object.prototype.hasOwnProperty.call(state.ids, key)) return state;
  const count = Object.keys(state.ids).length;
  if (count >= MAX_FALLBACK_SUPPRESSION_IDS) {
    return { ...state, saturated: true, generation: (state.generation || 0) + 1, since: at };
  }
  return { ...state, ids: { ...state.ids, [key]: { at } } };
}

/** A fallback row may be exposed only when nothing suppresses it. */
export const fallbackRowVisible = (state, tripId) => (
  !state.saturated && !Object.prototype.hasOwnProperty.call(state.ids, String(tripId))
);

/** Saturation is fail-closed: the whole fallback is withheld, at O(1). */
export const fallbackReadable = (state) => state.saturated !== true;

/**
 * Clear suppression after a **verified** rewrite. Clearing bumps `delete_seq` so
 * a tombstone the cleanup cursor skipped while suppressed is revisited.
 */
export function clearFallbackSuppression(state, deleteSeq) {
  return {
    state: { ...defaultFallbackSuppression(), generation: (state.generation || 0) + 1 },
    deleteSeq: { value: (deleteSeq?.value || 0) + 1 },
  };
}

// ─── tombstone cleanup ────────────────────────────────────────────────────────

/**
 * Decide one bounded cleanup turn.
 *
 * IndexedDB has already materialized the first cursor value before its size can
 * be assessed — `secureDelete` can emit 1 MiB of random bytes as a 2 MiB hex
 * string — so the byte budget is charged **after** materialization and an
 * oversized first row is processed alone rather than pretended away.
 */
export function planCleanupTurn(rows) {
  const process = [];
  let charge = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const bytes = row.bytes ?? 0;
    if (index === 0 && bytes > CLEANUP_SOFT_TURN_BYTES) {
      return { process: [row], isolatedOversized: true };
    }
    if (process.length >= CLEANUP_ROWS_PER_TURN) break;
    if (process.length && charge + bytes > CLEANUP_SOFT_TURN_BYTES) break;
    process.push(row);
    charge += bytes;
  }
  return { process, isolatedOversized: false };
}

/** A tombstone is removable only when nothing can still recover its trip. */
export const tombstoneRemovable = ({ tripId, nativeSuppression, nativeVisibility, erasurePending, fallbackSuppression }) => {
  if (nativeVisibility.state === 'uncertain') return false;
  if (erasurePending.pending === true) return false;
  if (Object.prototype.hasOwnProperty.call(nativeSuppression.ids, String(tripId))) return false;
  if (fallbackSuppression.saturated) return false;
  if (Object.prototype.hasOwnProperty.call(fallbackSuppression.ids, String(tripId))) return false;
  return true;
};

/**
 * End-of-pass decision. A delete committed *behind* the cursor advanced
 * `delete_seq`, so the sweep restarts under a new generation instead of leaving
 * an old tombstone permanently skipped.
 */
export function finishCleanupPass(state, currentSeq) {
  if ((currentSeq ?? 0) > (state.sampledSeqEnd ?? 0)) {
    return {
      ...state, cursor: null, generation: (state.generation || 0) + 1,
      sampledSeqStart: currentSeq, sampledSeqEnd: currentSeq, status: 'sweeping',
    };
  }
  return { ...state, cursor: null, status: 'idle' };
}

// ─── completeness verifier ────────────────────────────────────────────────────

/**
 * One bounded merge step over two cursors that share the `['start_time','id']`
 * ordering. Count equality is deliberately not used: it hides a missing row plus
 * a compensating orphan.
 */
export function compareMergeRows(sourceRow, projectionRow) {
  if (!sourceRow && !projectionRow) return { done: true };
  if (sourceRow && !projectionRow) return { advance: 'source', verdict: 'missing_projection' };
  if (!sourceRow && projectionRow) return { advance: 'projection', verdict: 'orphan_projection' };

  const order = sourceRow.start_time === projectionRow.start_time
    ? (sourceRow.id === projectionRow.id ? 0 : (sourceRow.id < projectionRow.id ? -1 : 1))
    : (sourceRow.start_time < projectionRow.start_time ? -1 : 1);

  if (order < 0) return { advance: 'source', verdict: 'missing_projection' };
  if (order > 0) return { advance: 'projection', verdict: 'orphan_projection' };

  if (projectionRow.projection_version === PROJECTION_STALE_VERSION) {
    // A deterministic failure marker is an accounted state, not a mismatch.
    return { advance: 'both', verdict: 'known_marker' };
  }
  if (projectionRow.projection_version !== TRIP_PROJECTION_VERSION) {
    return { advance: 'both', verdict: 'wrong_version' };
  }
  if (String(projectionRow.source_revision ?? '') !== String(sourceRow.source_revision ?? '')) {
    return { advance: 'both', verdict: 'stale_revision' };
  }
  if (projectionRow.status !== sourceRow.status) return { advance: 'both', verdict: 'column_mismatch' };
  return { advance: 'both', verdict: 'ok' };
}

/** A tombstoned source with no projection is consistent, not an orphan. */
export const verdictIsConsistent = (verdict, sourceTombstoned) => (
  verdict === 'ok' || verdict === 'known_marker'
  || (verdict === 'missing_projection' && sourceTombstoned)
);
