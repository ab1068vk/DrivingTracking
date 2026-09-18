import {
  createDiagnosticsStorage,
  deleteDiagnosticsDatabase,
  MAX_FLUSH_BATCH,
  MAX_PRUNE_DELETES_PER_TX,
} from '@/lib/diagnosticsStorage';
import {
  bufferSuppressedDiagnostics,
  closeP0Span,
  markP0SpanFailure,
  openP0Span,
  recordP0Phase,
  tagP0DiagnosticsJob,
} from '@/lib/p0Probe';
import { suppressDiagnosticsPersistence } from '@/lib/p0ProbeArms';

export const DIAGNOSTICS_FALLBACK_MAX_RECORDS = 128;
export const DIAGNOSTICS_FALLBACK_MAX_BYTES = 256 * 1024;
export const DIAGNOSTICS_MIGRATION_STATES = Object.freeze([
  'unseen',
  'copying',
  'verifying',
  'cutover_committed',
  'legacy_delete_pending',
  'complete',
  'legacy_corrupt_preserved',
]);

const MIN_KEY = Number.MIN_SAFE_INTEGER;
const MAX_KEY = Number.MAX_SAFE_INTEGER;
const MIGRATION_META_PREFIX = 'migration:';
const CLEAR_META_PREFIX = 'clear_epoch:';
const CLEAR_STORAGE_PREFIX = 'roadsage_diagnostics_clear_epoch_';
const FALLBACK_STORAGE_PREFIX = 'roadsage_diagnostics_fallback_';
const CLEAR_SCAN_META_PREFIX = 'clear_scan:';
const COMPLETE_META_KEY = 'diagnostics_storage_v1_complete';
const ALL_KINDS = ['performance', 'system_log', 'app_experience'];

let defaultStorage;
const repositories = new Set();

const p0Now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const storageAvailable = (storage) => {
  try {
    return Boolean(storage && typeof storage.getItem === 'function');
  } catch {
    return false;
  }
};

const defaultLocalStorage = () => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const canonicalize = (value, seen = new WeakSet()) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('Diagnostics migration payload must be acyclic.');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => canonicalize(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
};

const sha256Hex = async (value, cryptoApi = globalThis.crypto) => {
  if (!cryptoApi?.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('SHA-256 is unavailable for diagnostics migration verification.');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const requestIdle = (callback) => {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(callback);
  return setTimeout(callback, 0);
};

const cancelIdle = (handle) => {
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
  else clearTimeout(handle);
};

const kindRange = (kind, width) => ({
  lower: [kind, ...Array(width - 1).fill(MIN_KEY)],
  upper: [kind, ...Array(width - 1).fill(MAX_KEY)],
});

const generationRange = (kind, generation) => ({
  lower: [kind, generation, 0],
  upper: [kind, generation, MAX_KEY],
});

const expiryRange = (kind, cutoffMs) => ({
  lower: [kind, MIN_KEY, MIN_KEY],
  // Existing retention semantics keep rows exactly on the boundary.
  upper: [kind, cutoffMs, MIN_KEY],
  upperOpen: true,
});

const fallbackKeyForKind = (kind) => `${FALLBACK_STORAGE_PREFIX}${kind}`;
const clearKeyForKind = (kind) => `${CLEAR_STORAGE_PREFIX}${kind}`;
const migrationKeyForKind = (kind) => `${MIGRATION_META_PREFIX}${kind}`;

const parseClearEpoch = (storage, kind) => {
  if (!storageAvailable(storage)) return 0;
  try {
    const value = Number(storage.getItem(clearKeyForKind(kind)) || 0);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
};

const stableMigrationRows = (rows) => rows.map((row, ordinal) => ({
  ordinal,
  payload: row.payload,
  options: row.options,
}));

const migrationChecksum = (rows, cryptoApi) => sha256Hex(canonicalize(stableMigrationRows(rows)), cryptoApi);

export const trimDiagnosticsFallback = (records) => {
  const bounded = records.slice(-DIAGNOSTICS_FALLBACK_MAX_RECORDS);
  let lower = 0;
  let upper = bounded.length;
  let best = { records: [], serialized: JSON.stringify({ version: 1, records: [] }) };
  while (lower <= upper) {
    const start = Math.floor((lower + upper) / 2);
    const candidate = bounded.slice(start);
    const serialized = JSON.stringify({ version: 1, records: candidate });
    if (new TextEncoder().encode(serialized).byteLength <= DIAGNOSTICS_FALLBACK_MAX_BYTES) {
      best = { records: candidate, serialized };
      upper = start - 1;
    } else {
      lower = start + 1;
    }
  }
  return best;
};

export const createDiagnosticsHistoryStore = (config, dependencies = {}) => {
  const {
    kind,
    legacyKey,
    capacity,
    pendingCap,
    flushDelayMs,
    jobName,
    orderIndex,
    orderWidth,
    mapLegacy,
  } = config;
  if (!ALL_KINDS.includes(kind)) throw new TypeError(`Unsupported diagnostics history kind: ${kind}`);
  if (typeof mapLegacy !== 'function') throw new TypeError('Diagnostics legacy mapper is required.');

  const storage = dependencies.storage ?? (defaultStorage ??= createDiagnosticsStorage());
  const local = Object.prototype.hasOwnProperty.call(dependencies, 'localStorage')
    ? dependencies.localStorage
    : defaultLocalStorage();
  const now = dependencies.now ?? (() => Date.now());
  const cryptoApi = dependencies.crypto ?? globalThis.crypto;
  const suppress = dependencies.suppressPersistence ?? suppressDiagnosticsPersistence;
  const onSuppressed = dependencies.bufferSuppressed ?? bufferSuppressedDiagnostics;
  const afterMigrationState = dependencies.afterMigrationState ?? (() => {});
  const retryDelayMs = dependencies.retryDelayMs ?? 250;

  let pending = [];
  let flushTimer = null;
  let flushPromise = null;
  let migrationPromise = null;
  let recoveryPromise = null;
  let fallbackRead = false;
  let fallbackCache = [];
  let clearEpoch = parseClearEpoch(local, kind);
  let idleMigration = null;
  let maintenanceIdle = null;

  const assertMigrationEpoch = (epoch) => {
    if (epoch !== clearEpoch) {
      throw new Error(`Diagnostics migration was superseded by clear for ${kind}.`);
    }
  };

  const readFallbackOnce = () => {
    if (fallbackRead || !storageAvailable(local)) return fallbackCache;
    fallbackRead = true;
    try {
      const parsed = JSON.parse(local.getItem(fallbackKeyForKind(kind)) || 'null');
      fallbackCache = parsed?.version === 1 && Array.isArray(parsed.records)
        ? parsed.records.slice(-DIAGNOSTICS_FALLBACK_MAX_RECORDS)
        : [];
    } catch {
      fallbackCache = [];
    }
    return fallbackCache;
  };

  const writeFallback = (records) => {
    if (!storageAvailable(local) || suppress()) return false;
    let prior = null;
    try {
      prior = local.getItem(fallbackKeyForKind(kind));
      const merged = new Map();
      [...readFallbackOnce(), ...records].forEach((record) => merged.set(record.eventUid, record));
      const bounded = trimDiagnosticsFallback([...merged.values()]);
      local.setItem(fallbackKeyForKind(kind), bounded.serialized);
      fallbackCache = bounded.records;
      return true;
    } catch {
      // localStorage setItem is atomic; leave the prior valid value untouched.
      if (prior !== null) {
        try {
          fallbackCache = JSON.parse(prior)?.records ?? fallbackCache;
        } catch {}
      }
      return false;
    }
  };

  const markMigrationState = async (state) => {
    assertMigrationEpoch(state.clearEpoch);
    await storage.setMeta(migrationKeyForKind(kind), state);
    assertMigrationEpoch(state.clearEpoch);
    afterMigrationState(state.state, structuredClone(state));
  };

  const maybeMarkGlobalComplete = async () => {
    const states = await Promise.all(ALL_KINDS.map((candidate) => storage.getMeta(migrationKeyForKind(candidate))));
    if (states.every((state) => state?.state === 'complete')) {
      await storage.setMeta(COMPLETE_META_KEY, { version: 1, completedAtMs: now() });
    }
  };

  const legacySnapshot = async (state = null) => {
    if (!storageAvailable(local)) return { raw: null, rows: [] };
    const raw = local.getItem(legacyKey);
    if (raw === null) return { raw: null, rows: [] };
    // P1 never writes the legacy key. Once a clear tombstone exists, any
    // remaining legacy bytes necessarily predate it and must not be migrated.
    if (clearEpoch > 0) return { raw, rows: [], invalidatedByClear: true };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { raw, corrupt: true, rows: [] };
    }
    if (!Array.isArray(parsed)) return { raw, corrupt: true, rows: [] };
    const frozenNowMs = state?.frozenNowMs ?? now();
    return { raw, rows: mapLegacy(parsed, frozenNowMs), frozenNowMs };
  };

  const resetStaleMigration = async (state) => {
    if (!state || Number(state.clearEpoch || 0) >= clearEpoch) return state;
    const reset = { state: 'unseen', clearEpoch, nextOrdinal: 0 };
    await markMigrationState(reset);
    return reset;
  };

  const runMigration = async () => {
    if (suppress()) return { state: 'suppressed' };
    let state = await resetStaleMigration(await storage.getMeta(migrationKeyForKind(kind)));
    state ??= { state: 'unseen', clearEpoch, nextOrdinal: 0 };
    const migrationEpoch = clearEpoch;
    assertMigrationEpoch(state.clearEpoch);
    if (['complete', 'legacy_corrupt_preserved'].includes(state.state)) return state;

    let snapshot = await legacySnapshot(state);
    assertMigrationEpoch(migrationEpoch);
    if (snapshot.corrupt) {
      state = { state: 'legacy_corrupt_preserved', clearEpoch: migrationEpoch, rawLength: snapshot.raw.length };
      await markMigrationState(state);
      await maybeMarkGlobalComplete();
      return state;
    }

    if (state.state === 'unseen') {
      const rawHash = await sha256Hex(snapshot.raw ?? '[]', cryptoApi);
      const generation = `${migrationEpoch}-${rawHash.slice(0, 20)}`;
      const checksum = await migrationChecksum(snapshot.rows, cryptoApi);
      state = {
        state: 'copying',
        clearEpoch: migrationEpoch,
        frozenNowMs: snapshot.frozenNowMs ?? now(),
        generation,
        retainedCount: snapshot.rows.length,
        checksum,
        nextOrdinal: 0,
      };
      await markMigrationState(state);
      snapshot = await legacySnapshot(state);
      assertMigrationEpoch(migrationEpoch);
    }

    if (state.state === 'copying') {
      const currentChecksum = await migrationChecksum(snapshot.rows, cryptoApi);
      if (snapshot.rows.length !== state.retainedCount || currentChecksum !== state.checksum) {
        throw new Error(`Diagnostics migration source changed during copy for ${kind}.`);
      }
      while (state.nextOrdinal < state.retainedCount) {
        const start = state.nextOrdinal;
        const rows = snapshot.rows.slice(start, start + MAX_FLUSH_BATCH);
        const records = rows.map((row, offset) => storage.prepareMigratedEvent(kind, row.payload, {
          ...row.options,
          clearEpoch: migrationEpoch,
          migrationGeneration: state.generation,
          migrationOrdinal: start + offset,
          migrationSource: legacyKey,
        }));
        await storage.appendPreparedEvents(records);
        assertMigrationEpoch(migrationEpoch);
        state = { ...state, nextOrdinal: start + records.length };
        await markMigrationState(state);
      }
      state = { ...state, state: 'verifying' };
      await markMigrationState(state);
    }

    if (state.state === 'verifying') {
      const copied = await storage.readEventsByIndex('by_kind_generation_ordinal', {
        range: generationRange(kind, state.generation),
        limit: Math.max(1, capacity),
      });
      const rows = copied.map((record) => ({ payload: record.payload, options: {
        payloadTimestampMs: record.payloadTimestampMs,
        ...(Object.prototype.hasOwnProperty.call(record, 'expiresAtMs') ? { expiresAtMs: record.expiresAtMs } : {}),
        ...(Object.prototype.hasOwnProperty.call(record, 'privacyClass') ? { privacyClass: record.privacyClass } : {}),
        ...(Object.prototype.hasOwnProperty.call(record, 'privacyRulesVersion') ? { privacyRulesVersion: record.privacyRulesVersion } : {}),
      } }));
      const checksum = await migrationChecksum(rows, cryptoApi);
      if (copied.length !== state.retainedCount || checksum !== state.checksum) {
        throw new Error(`Diagnostics migration verification failed for ${kind}.`);
      }
      state = { ...state, state: 'cutover_committed', verifiedAtMs: now() };
      await markMigrationState(state);
    }

    if (state.state === 'cutover_committed') {
      state = { ...state, state: 'legacy_delete_pending' };
      await markMigrationState(state);
    }

    if (state.state === 'legacy_delete_pending') {
      assertMigrationEpoch(migrationEpoch);
      if (storageAvailable(local)) local.removeItem(legacyKey);
      state = { ...state, state: 'complete', completedAtMs: now() };
      await markMigrationState(state);
      await maybeMarkGlobalComplete();
    }
    return state;
  };

  const ensureMigration = () => {
    if (!migrationPromise) {
      migrationPromise = runMigration().catch((error) => {
        migrationPromise = null;
        throw error;
      });
    }
    return migrationPromise;
  };

  const recoverFallback = async () => {
    if (suppress()) return;
    const rows = readFallbackOnce().filter((record) => record.clearEpoch >= clearEpoch);
    if (!rows.length && fallbackCache.length) {
      if (storageAvailable(local)) {
        try { local.removeItem(fallbackKeyForKind(kind)); } catch {}
      }
      fallbackCache = [];
      return;
    }
    if (!rows.length) return;
    for (let index = 0; index < rows.length; index += MAX_FLUSH_BATCH) {
      await storage.appendPreparedEvents(rows.slice(index, index + MAX_FLUSH_BATCH));
    }
    const stored = await storage.readEventsByUids(rows.map((record) => record.eventUid));
    const ids = new Set(stored.map((record) => record.eventUid));
    if (!rows.every((record) => ids.has(record.eventUid))) {
      throw new Error(`Diagnostics fallback verification failed for ${kind}.`);
    }
    if (storageAvailable(local)) local.removeItem(fallbackKeyForKind(kind));
    fallbackCache = [];
  };

  const ensureRecovery = () => {
    if (!recoveryPromise) {
      recoveryPromise = recoverFallback()
        .catch(() => {})
        .finally(() => { recoveryPromise = null; });
    }
    return recoveryPromise;
  };

  const pruneFixedExpiry = async (cutoffMs = now()) => {
    if (suppress()) return 0;
    const keys = await storage.readEventKeysByIndex('by_kind_expiry', {
      range: expiryRange(kind, cutoffMs),
      limit: MAX_PRUNE_DELETES_PER_TX,
    });
    if (keys.length) await storage.deleteEventUids(keys);
    return keys.length;
  };

  const pruneCapacity = async () => {
    if (suppress()) return 0;
    const count = await storage.countEventsByIndex('by_kind_ingest_seq', {
      range: kindRange(kind, 2),
    });
    const deleteCount = Math.min(Math.max(0, count - capacity), MAX_PRUNE_DELETES_PER_TX);
    if (!deleteCount) return 0;
    const keys = await storage.readEventKeysByIndex(orderIndex, {
      range: kindRange(kind, orderWidth),
      limit: deleteCount,
    });
    await storage.deleteEventUids(keys);
    return keys.length;
  };

  const pruneClearedEpochs = async ({ explicitClear = false } = {}) => {
    if ((!explicitClear && suppress()) || clearEpoch === 0) return { deleted: 0, scanned: 0 };
    const targetEpoch = clearEpoch;
    const cursorKey = `${CLEAR_SCAN_META_PREFIX}${kind}`;
    const priorCursor = await storage.getMeta(cursorKey);
    const lowerSeq = priorCursor?.clearEpoch === targetEpoch
      && Number.isSafeInteger(priorCursor?.ingestSeq)
      ? priorCursor.ingestSeq
      : MIN_KEY;
    const records = await storage.readEventsByIndex('by_kind_ingest_seq', {
      range: {
        lower: [kind, lowerSeq],
        lowerOpen: lowerSeq !== MIN_KEY,
        upper: [kind, MAX_KEY],
      },
      limit: MAX_PRUNE_DELETES_PER_TX,
    });
    if (clearEpoch !== targetEpoch) return { deleted: 0, scanned: records.length };
    const stale = records
      .filter((record) => record.clearEpoch < targetEpoch)
      .map((record) => record.eventUid);
    if (stale.length) await storage.deleteEventUids(stale);
    if (records.length === MAX_PRUNE_DELETES_PER_TX) {
      await storage.setMeta(cursorKey, { ingestSeq: records.at(-1).ingestSeq, clearEpoch: targetEpoch });
    } else {
      await storage.deleteMeta(cursorKey);
    }
    return { deleted: stale.length, scanned: records.length };
  };

  let explicitClearCleanupRequested = false;
  const scheduleMaintenance = ({ explicitClear = false } = {}) => {
    if (explicitClear) explicitClearCleanupRequested = true;
    if (maintenanceIdle !== null || (suppress() && !explicitClearCleanupRequested)) return maintenanceIdle;
    let scheduledHandle;
    scheduledHandle = requestIdle(async () => {
      let repeat = false;
      const runExplicitClearCleanup = explicitClearCleanupRequested;
      explicitClearCleanupRequested = false;
      try {
        let cleared;
        let expired = 0;
        let excess = 0;
        if (runExplicitClearCleanup) {
          // Clear owns only old-epoch removal. It remains active in P0 Arms
          // B/C without turning automatic migration/recovery/pruning back on.
          cleared = await pruneClearedEpochs({ explicitClear: true });
        } else {
          await ensureMigration();
          await ensureRecovery();
          cleared = await pruneClearedEpochs({ explicitClear: runExplicitClearCleanup });
          expired = await pruneFixedExpiry();
          excess = await pruneCapacity();
        }
        repeat = cleared.scanned === MAX_PRUNE_DELETES_PER_TX
          || expired === MAX_PRUNE_DELETES_PER_TX
          || excess === MAX_PRUNE_DELETES_PER_TX;
      } catch {
        // Best-effort diagnostics maintenance never recurses through system logging.
      } finally {
        const stillOwnsSchedule = maintenanceIdle === scheduledHandle;
        if (stillOwnsSchedule) maintenanceIdle = null;
        if (stillOwnsSchedule && (repeat || explicitClearCleanupRequested)) {
          scheduleMaintenance({
            explicitClear: runExplicitClearCleanup || explicitClearCleanupRequested,
          });
        }
      }
    });
    maintenanceIdle = scheduledHandle;
    return maintenanceIdle;
  };

  const flush = async () => {
    flushTimer = null;
    if (flushPromise || !pending.length) return flushPromise;
    if (suppress()) {
      const batch = pending.splice(0, MAX_FLUSH_BATCH);
      onSuppressed(jobName, batch.map((record) => record.payload));
      if (pending.length) scheduleFlush();
      return undefined;
    }
    const span = openP0Span('diagnostics_job');
    if (span) tagP0DiagnosticsJob(span, jobName);
    const prepareStart = span ? p0Now() : 0;
    const batch = pending.splice(0, MAX_FLUSH_BATCH);
    if (span) recordP0Phase(span, 'diag_transform', prepareStart, p0Now());
    let outcome = 'error';
    let request;
    try {
      request = span
        ? storage.appendPreparedEvents(batch, {
          now: p0Now,
          recordSync: (phase, start, end) => recordP0Phase(span, phase, start, end),
        })
        : storage.appendPreparedEvents(batch);
    } catch (error) {
      throw error;
    }
    flushPromise = (async () => {
      try {
        await request;
        if (batch.some((record) => record.clearEpoch < clearEpoch)) {
          await storage.deleteEventUids(batch.map((record) => record.eventUid));
        }
        try {
          await config.afterFlush?.({ batch, storage });
        } catch {
          // Caller notification is best-effort and cannot change durability.
        }
        const callbackStart = span ? p0Now() : 0;
        outcome = 'success';
        if (span) recordP0Phase(span, 'diag_transform', callbackStart, p0Now());
        scheduleMaintenance();
      } catch {
        markP0SpanFailure(span);
        const retryableBatch = batch.filter((record) => record.clearEpoch >= clearEpoch);
        pending = [...retryableBatch, ...pending].slice(0, pendingCap);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        const retryBatch = pending.splice(0, Math.min(MAX_FLUSH_BATCH, pending.length));
        try {
          await (span
            ? storage.appendPreparedEvents(retryBatch, {
              now: p0Now,
              recordSync: (phase, start, end) => recordP0Phase(span, phase, start, end),
            })
            : storage.appendPreparedEvents(retryBatch));
          scheduleMaintenance();
        } catch {
          writeFallback(retryBatch);
        }
      } finally {
        if (span) closeP0Span(span, outcome);
        flushPromise = null;
        if (pending.length) scheduleFlush();
      }
    })();
    return flushPromise;
  };

  const scheduleFlush = () => {
    if (flushTimer || flushPromise || !pending.length) return;
    if (pending.length >= MAX_FLUSH_BATCH) {
      flushTimer = setTimeout(flush, 0);
    } else {
      flushTimer = setTimeout(flush, flushDelayMs);
    }
  };

  const enqueue = (payload, eventOptions = {}) => {
    const record = storage.prepareEvent(kind, payload, { ...eventOptions, clearEpoch });
    pending.push(record);
    if (pending.length > pendingCap) pending.splice(0, pending.length - pendingCap);
    scheduleFlush();
    return record;
  };

  const read = async ({ nowMs = now(), includePending = true } = {}) => {
    let migrationState = null;
    try {
      migrationState = await ensureMigration();
      await ensureRecovery();
    } catch {
      // Incomplete migration keeps the legacy copy authoritative and readable.
    }
    let records = [];
    try {
      records = await storage.readEventsByIndex(orderIndex, {
        range: kindRange(kind, orderWidth),
        limit: capacity + pendingCap + DIAGNOSTICS_FALLBACK_MAX_RECORDS + MAX_FLUSH_BATCH,
        direction: config.direction ?? 'next',
      });
    } catch {}
    records = records.filter((record) => record.clearEpoch >= clearEpoch);
    if (!['cutover_committed', 'legacy_delete_pending', 'complete'].includes(migrationState?.state)) {
      records = records.filter((record) => !record.eventUid.startsWith('migration:'));
      try {
        const legacy = await legacySnapshot(migrationState);
        const migratedView = legacy.corrupt ? [] : legacy.rows.map((row, ordinal) => ({
          kind,
          eventUid: `legacy-view:${kind}:${ordinal}`,
          clearEpoch,
          ingestSeq: ordinal,
          payload: row.payload,
          ...row.options,
        }));
        records = [...records, ...migratedView];
      } catch {}
    }
    const fallback = readFallbackOnce().filter((record) => record.clearEpoch >= clearEpoch);
    const pendingRows = includePending ? pending : [];
    const byUid = new Map();
    [...records, ...fallback, ...pendingRows].forEach((record) => byUid.set(record.eventUid, record));
    const result = config.finalizeRead([...byUid.values()], nowMs).slice(0, capacity);
    scheduleMaintenance();
    return result;
  };

  const clear = () => {
    const nextEpoch = clearEpoch + 1;
    if (!storageAvailable(local)) return false;
    try {
      local.setItem(clearKeyForKind(kind), String(nextEpoch));
    } catch {
      return false;
    }
    clearEpoch = nextEpoch;
    // Removal is best effort after the tombstone. A failed removal cannot
    // resurrect legacy/fallback rows because reads and migration apply epoch.
    try { local.removeItem(legacyKey); } catch {}
    try { local.removeItem(fallbackKeyForKind(kind)); } catch {}
    pending = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (idleMigration) cancelIdle(idleMigration);
    idleMigration = null;
    if (maintenanceIdle !== null) cancelIdle(maintenanceIdle);
    maintenanceIdle = null;
    fallbackCache = [];
    migrationPromise = null;
    recoveryPromise = null;
    storage.setMeta(CLEAR_META_PREFIX + kind, clearEpoch).catch(() => {});
    storage.setMeta(migrationKeyForKind(kind), { state: 'unseen', clearEpoch, nextOrdinal: 0 }).catch(() => {});
    storage.deleteMeta(COMPLETE_META_KEY).catch(() => {});
    storage.deleteMeta(`${CLEAR_SCAN_META_PREFIX}${kind}`).catch(() => {});
    scheduleMaintenance({ explicitClear: true });
    return true;
  };

  const startBackgroundMigration = () => {
    if (idleMigration || suppress()) return;
    idleMigration = requestIdle(() => {
      idleMigration = null;
      ensureMigration().then(ensureRecovery).then(scheduleMaintenance).catch(() => {});
    });
  };

  const repository = Object.freeze({
    clear,
    enqueue,
    ensureMigration,
    flush,
    get pendingCount() { return pending.length; },
    get clearEpoch() { return clearEpoch; },
    read,
    scheduleMaintenance,
    startBackgroundMigration,
    storage,
  });
  repositories.add(repository);
  return repository;
};

export const resetDiagnosticsHistoryStoresForTests = () => {
  repositories.clear();
  defaultStorage?.close();
  defaultStorage = undefined;
};

export const eraseDiagnosticsHistoryForDataRights = async () => {
  repositories.forEach((repository) => repository.clear());
  const storages = new Set([...repositories].map((repository) => repository.storage));
  storages.forEach((storage) => storage.close());
  defaultStorage?.close();
  const result = await deleteDiagnosticsDatabase();
  repositories.clear();
  defaultStorage = undefined;
  return result;
};
