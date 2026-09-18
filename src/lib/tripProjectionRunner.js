import { isSecureDeleteTombstone } from '@/lib/encryptedStore';
import {
  BACKFILL_ROWS_PER_TURN,
  CLEANUP_ROWS_PER_TURN,
  META_KEYS,
  VERIFY_POINT_READS_PER_TURN,
  VERIFY_ROWS_PER_TURN,
  compareMergeRows,
  defaultCleanupState,
  defaultFallbackSuppression,
  defaultMigrationState,
  defaultNativeErasurePending,
  defaultNativeVisibility,
  defaultVerifyState,
  finishCleanupPass,
  planCleanupTurn,
  tombstoneRemovable,
  verdictIsConsistent,
} from '@/lib/tripProjectionMaintenance';
import { PROJECTION_STALE_VERSION, TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';

/**
 * Bounded runners that actually drive the P3 maintenance state machines.
 *
 * Each `*Turn` performs one bounded unit of work and commits its cursor, so
 * total work may be O(N) while no single turn is. Every runner is resumable from
 * committed state and is never required before first render.
 *
 * IndexedDB access is injected so these are exercised against the same fake the
 * repository tests use, rather than against a parallel implementation.
 */

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve(undefined);
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

export const readMeta = async (db, storeName, key, fallback) => {
  if (!db.objectStoreNames.contains(storeName)) return fallback;
  const tx = db.transaction(storeName, 'readonly');
  const record = await idbRequest(tx.objectStore(storeName).get(key));
  return record?.value ?? fallback;
};

export const writeMeta = async (db, storeName, key, value) => {
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put({ key, value });
  await transactionDone(tx);
};

/**
 * Walk one bounded window of an index, resuming after `cursorKey`.
 * Rows are returned with their index key so a cursor can be committed.
 */
export async function readIndexWindow(db, { storeName, indexName, after, limit, direction = 'next' }) {
  const tx = db.transaction(storeName, 'readonly');
  const index = tx.objectStore(storeName).index(indexName);
  const range = after ? IDBKeyRange.lowerBound(after, true) : null;
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = range ? index.openCursor(range, direction) : index.openCursor(null, direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(undefined);
      rows.push({ key: cursor.key, value: cursor.value });
      // P4-C-F09: stop *before* stepping onto a row this window will not use.
      // Continuing first made the store materialize one extra record per window
      // that the turn then discarded - a real read nothing consumed.
      if (rows.length >= limit) return resolve(undefined);
      cursor.continue();
      return undefined;
    };
  });
  return rows;
}

/**
 * One backfill turn: convert at most `BACKFILL_ROWS_PER_TURN` source rows that
 * have no usable projection, then commit the cursor.
 *
 * Reaching the end of the index moves the state to `complete`. Nothing here is
 * required before first render — the bounded read path is correct at zero
 * progress because ordering comes from the source store.
 *
 * `examined` is the rows this *invocation* actually read — source index rows
 * plus the projection rows it probed for them. P4-C-F09: a turn that reads a
 * full window and converts nothing still consumed that window.
 *
 * @returns {Promise<{ state: object, converted: number, examined: number, done: boolean }>}
 */
export async function runBackfillTurn(db, {
  metaStore, tripStore, projectionStore, indexName, repair,
}) {
  const state = await readMeta(db, metaStore, META_KEYS.MIGRATION, defaultMigrationState());
  if (state.state === 'complete' && state.target_version === TRIP_PROJECTION_VERSION) {
    return { state, converted: 0, examined: 0, done: true };
  }

  const rows = await readIndexWindow(db, {
    storeName: tripStore,
    indexName,
    after: state.cursor,
    limit: BACKFILL_ROWS_PER_TURN,
  });

  if (!rows.length) {
    const next = {
      ...state, state: 'complete', cursor: null,
      target_version: TRIP_PROJECTION_VERSION, updated_at: Date.now(),
    };
    await writeMeta(db, metaStore, META_KEYS.MIGRATION, next);
    return { state: next, converted: 0, examined: 0, done: true };
  }

  const live = rows.filter(({ value }) => !isSecureDeleteTombstone(value));
  const candidates = [];
  if (live.length) {
    const tx = db.transaction(projectionStore, 'readonly');
    const store = tx.objectStore(projectionStore);
    const existing = await Promise.all(live.map(({ value }) => idbRequest(store.get(value.id))));
    live.forEach(({ value }, index) => {
      const record = existing[index];
      const usable = record
        && record.projection_version === TRIP_PROJECTION_VERSION
        && String(record.source_revision ?? '') === String(value.source_revision ?? '');
      // A matching deterministic marker is an accounted state, not work.
      const knownMarker = record
        && record.projection_version === PROJECTION_STALE_VERSION
        && record.failure_class
        && String(record.failed_source_revision ?? '') === String(value.source_revision ?? '')
        && record.failed_target_projection_version === TRIP_PROJECTION_VERSION;
      if (!usable && !knownMarker) {
        candidates.push({
          id: value.id,
          start_time: String(value.start_time ?? ''),
          status: String(value.status ?? ''),
          source_revision: value.source_revision ?? null,
        });
      }
    });
  }

  let converted = 0;
  let repairExamined = 0;
  if (candidates.length) {
    const repaired = await repair(candidates);
    // P4-C-F09: a repair callback may report the rows it independently re-read
    // as well as the projections it built. A plain number keeps the older
    // contract and reports no extra reads.
    if (repaired && typeof repaired === 'object') {
      converted = Math.max(0, Number(repaired.converted) || 0);
      repairExamined = Math.max(0, Number(repaired.examined) || 0);
    } else {
      converted = Math.max(0, Number(repaired) || 0);
    }
  }

  const next = {
    ...state,
    state: 'backfilling',
    target_version: TRIP_PROJECTION_VERSION,
    cursor: rows[rows.length - 1].key,
    converted: (state.converted || 0) + converted,
    started_at: state.started_at ?? Date.now(),
    updated_at: Date.now(),
  };
  await writeMeta(db, metaStore, META_KEYS.MIGRATION, next);
  // Source rows read, plus the projection row each live source row was probed
  // against, plus every source row the repair path independently re-read. All
  // of them are real reads this turn performed.
  return {
    state: next,
    converted,
    examined: rows.length + live.length + repairExamined,
    repairExamined,
    done: false,
  };
}

/**
 * One verifier turn: merge-walk source and projection cursors that share the
 * `['start_time','id']` ordering. Exact id-set equality, not count equality.
 */
export async function runVerifyTurn(db, { metaStore, tripStore, projectionStore, indexName, onMismatch }) {
  const state = await readMeta(db, metaStore, META_KEYS.VERIFY, defaultVerifyState());

  // Two-sided resume. A single shared cursor advanced from the source side can
  // jump over unverified projection rows when the first differences are
  // orphans, and with an orphan-only projection store it may never advance at
  // all. Each side therefore carries its own durable position.
  const sourceRows = await readIndexWindow(db, {
    storeName: tripStore, indexName, after: state.sourceCursor ?? state.cursor, limit: VERIFY_ROWS_PER_TURN,
  });
  const projectionRows = await readIndexWindow(db, {
    storeName: projectionStore, indexName, after: state.projectionCursor ?? state.cursor, limit: VERIFY_ROWS_PER_TURN,
  });

  if (!sourceRows.length && !projectionRows.length) {
    const next = {
      ...state, cursor: null, sourceCursor: null, projectionCursor: null,
      status: 'idle', generation: (state.generation || 0) + 1,
    };
    await writeMeta(db, metaStore, META_KEYS.VERIFY, next);
    return { state: next, done: true, mismatches: 0, examined: 0, checkedThisTurn: 0 };
  }

  const mismatched = [];
  let sourceIndex = 0;
  let projectionIndex = 0;
  let repairs = 0;
  while (
    (sourceIndex < sourceRows.length || projectionIndex < projectionRows.length)
    && repairs < VERIFY_POINT_READS_PER_TURN
  ) {
    const source = sourceRows[sourceIndex]?.value ?? null;
    const projection = projectionRows[projectionIndex]?.value ?? null;
    const result = compareMergeRows(source, projection);
    if (result.done) break;
    const tombstoned = source ? isSecureDeleteTombstone(source) : false;
    if (!verdictIsConsistent(result.verdict, tombstoned)) {
      mismatched.push({ id: (source ?? projection).id, verdict: result.verdict });
      repairs += 1;
    }
    if (result.advance === 'source') sourceIndex += 1;
    else if (result.advance === 'projection') projectionIndex += 1;
    else { sourceIndex += 1; projectionIndex += 1; }
  }

  // P4-C-F09: repair re-reads each mismatched source row - to classify it, to
  // rebuild it, and again inside the guarded commit. `onMismatch` reports how
  // many independent reads this invocation performed.
  let repairExamined = 0;
  if (mismatched.length && onMismatch) {
    repairExamined = Math.max(0, Number(await onMismatch(mismatched)) || 0);
  }

  const nextSourceCursor = sourceIndex > 0
    ? sourceRows[sourceIndex - 1].key
    : (state.sourceCursor ?? state.cursor ?? null);
  const nextProjectionCursor = projectionIndex > 0
    ? projectionRows[projectionIndex - 1].key
    : (state.projectionCursor ?? state.cursor ?? null);
  const next = {
    ...state,
    cursor: nextSourceCursor,
    sourceCursor: nextSourceCursor,
    projectionCursor: nextProjectionCursor,
    checked: (state.checked || 0) + sourceIndex,
    mismatches: (state.mismatches || 0) + mismatched.length,
    status: 'verifying',
  };
  await writeMeta(db, metaStore, META_KEYS.VERIFY, next);
  // P4-C-F09: two windows are read, plus every row the repair path
  // independently re-read, and that is what this turn consumed. `state.checked`
  // is a pass-to-date total and must never be reported as the cost of one
  // invocation.
  return {
    state: next,
    done: false,
    mismatches: mismatched.length,
    examined: sourceRows.length + projectionRows.length + repairExamined,
    repairExamined,
    checkedThisTurn: sourceIndex,
  };
}

/**
 * Is `target` strictly ahead of `current` in IndexedDB key order?
 *
 * `indexedDB.cmp` is the authority — keys are typed, and `42` orders before
 * `"42"` rather than equal to it. When it is unavailable the answer is "no",
 * which costs a re-scan from the index start but can never throw; guessing an
 * ordering here would be worse than being slow.
 */
const canAdvanceTo = (target, current) => {
  const idb = globalThis.indexedDB;
  if (typeof idb?.cmp !== 'function') return false;
  try {
    return idb.cmp(target, current) > 0;
  } catch {
    return false;
  }
};

/**
 * One tombstone-cleanup turn.
 *
 * Rows are read through the scalar `status` index because tombstones carry no
 * `start_time` and are therefore absent from every compound index. Byte charging
 * happens after materialization, and an oversized first row gets its own turn.
 */
export async function runCleanupTurn(db, { metaStore, stores, statusIndex, tombstoneStatus, measure }) {
  const state = await readMeta(db, metaStore, META_KEYS.DELETE_CLEANUP, defaultCleanupState());
  const seq = await readMeta(db, metaStore, META_KEYS.DELETE_SEQ, { value: 0 });
  const nativeVisibility = await readMeta(db, metaStore, META_KEYS.NATIVE_VISIBILITY, defaultNativeVisibility());
  const nativeSuppression = await readMeta(db, metaStore, META_KEYS.NATIVE_SUPPRESSION, { ids: {} });
  const erasurePending = await readMeta(db, metaStore, META_KEYS.NATIVE_ERASURE_PENDING, defaultNativeErasurePending());
  const fallbackSuppression = await readMeta(db, metaStore, META_KEYS.FALLBACK_SUPPRESSION, defaultFallbackSuppression());

  const sampled = state.sampledSeqEnd == null
    ? { ...state, sampledSeqStart: seq.value || 0, sampledSeqEnd: seq.value || 0 }
    : state;

  const tx = db.transaction(stores[0], 'readonly');
  const index = tx.objectStore(stores[0]).index(statusIndex);
  const candidates = [];
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(tombstoneStatus), 'next');
    request.onerror = () => reject(request.error);
    let positioned = sampled.cursor == null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || candidates.length >= CLEANUP_ROWS_PER_TURN + 1) return resolve(undefined);
      if (!positioned) {
        // Resume at a real cursor position rather than re-reading and
        // JS-skipping every previously visited tombstone. Scanning from the
        // index start each turn would make rows visited grow with accumulated
        // deletion history and the total sweep quadratic.
        //
        // But the jump is only legal when it moves forward. Every record here
        // shares the same index key, so IndexedDB throws `DataError` unless the
        // requested primary key is *strictly greater* than the cursor's current
        // one. After the previous turn deleted everything through the saved key,
        // a freshly opened cursor already starts past it — and the unconditional
        // call threw, stalling cleanup at its first deleting batch and never
        // reaching deep tombstones.
        positioned = true;
        if (canAdvanceTo(sampled.cursor, cursor.primaryKey)) {
          cursor.continuePrimaryKey(tombstoneStatus, sampled.cursor);
          return undefined;
        }
        // Already at or beyond the resume point: this row is the next one to
        // look at, so fall through and process it.
      }
      const record = cursor.value;
      candidates.push({ id: record.id, bytes: measure ? measure(record) : 0 });
      cursor.continue();
      return undefined;
    };
  });

  if (!candidates.length) {
    const next = finishCleanupPass(sampled, seq.value || 0);
    await writeMeta(db, metaStore, META_KEYS.DELETE_CLEANUP, {
      ...next, sampledSeqEnd: seq.value || 0, sampledSeqStart: next.cursor === null ? (seq.value || 0) : next.sampledSeqStart,
    });
    return { state: next, removed: 0, examined: 0, done: next.status === 'idle' };
  }

  const turn = planCleanupTurn(candidates);
  const removable = turn.process.filter(({ id }) => tombstoneRemovable({
    tripId: id, nativeSuppression, nativeVisibility, erasurePending, fallbackSuppression,
  }));

  if (removable.length) {
    const writeTx = db.transaction(stores, 'readwrite');
    stores.forEach((storeName) => {
      const store = writeTx.objectStore(storeName);
      removable.forEach(({ id }) => store.delete(id));
    });
    await transactionDone(writeTx);
  }

  const next = {
    ...sampled,
    cursor: turn.process[turn.process.length - 1].id,
    status: 'sweeping',
  };
  await writeMeta(db, metaStore, META_KEYS.DELETE_CLEANUP, next);
  // Candidates materialized, not only the rows that turned out to be removable.
  return {
    state: next,
    removed: removable.length,
    examined: candidates.length,
    done: false,
    isolatedOversized: turn.isolatedOversized,
  };
}
