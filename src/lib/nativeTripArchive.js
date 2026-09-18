import { registerPlugin } from '@capacitor/core';

const NativeArchive = registerPlugin('DriveSenseArchive');

export class CanonicalArchiveError extends Error {
  constructor(code, message = code, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CanonicalArchiveError';
    this.code = code;
  }
}

const invoke = async (method, payload = {}) => {
  try {
    const fn = NativeArchive?.[method];
    if (typeof fn !== 'function') throw new Error('Native archive plugin method is unregistered');
    return await fn(payload);
  } catch (error) {
    const message = String(error?.message || error || 'Native canonical archive unavailable');
    const code = message.includes('RECOVERY') || message.includes('SENTINEL')
      ? 'RECOVERY_REQUIRED'
      : message.includes('LOW_SPACE')
        ? 'LOW_SPACE_BLOCKED'
        : message.includes('LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE')
          ? 'LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE'
        : message.includes('REQUEST_TOO_LARGE')
          ? 'REQUEST_TOO_LARGE'
          : 'CANONICAL_UNAVAILABLE';
    throw new CanonicalArchiveError(code, message, error);
  }
};

// F05 receipt boundaries only. Preserve typed native failures and charge bridge
// payload encodings/decoded results in addition to native SQLite observations.
const invokePrivacyReceipt = async (method, payload = {}) => {
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const sent = bytes(payload);
  try {
    const result = await NativeArchive[method](payload);
    if (!Number.isSafeInteger(result?.itemsWorked) || result.itemsWorked < 0
      || !Number.isSafeInteger(result?.bytesWorked) || result.bytesWorked < 0) {
      return { state: 'PRIVACY_RECEIPT_FAILED', itemsWorked: 0, bytesWorked: sent + 2 * bytes(result ?? null), error: 'Missing native receipt accounting' };
    }
    return { ...result, bytesWorked: result.bytesWorked + sent + 2 * bytes(result) };
  } catch (error) {
    return { state: 'PRIVACY_RECEIPT_FAILED', itemsWorked: 0,
      bytesWorked: sent + 2 * bytes({ message: String(error?.message || error) }), error: String(error?.message || error) };
  }
};

const notifyP5Terminal = async (result) => {
  if (result?.done !== true && result?.leaseClosed !== true) return;
  const { admitP5ReviewedWork, P5_LIFECYCLE_JOB_KEYS } = await import('@/lib/appLifecycleWork');
  admitP5ReviewedWork(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC, {
    wake: result?.leaseClosed === true
      ? { type: 'export_lease', key: 'closed' }
      : { type: 'native_operation', key: 'idle' },
  });
};

const observeP5Health = async (health) => {
  if (health?.integrityDue !== true && health?.integritySuspicion !== true) return;
  const { admitP5ReviewedWork, P5_LIFECYCLE_JOB_KEYS } = await import('@/lib/appLifecycleWork');
  const healthy = health?.authorityState === 'NATIVE'
    && health?.recoveryState === 'HEALTHY'
    && health?.sentinelMatches === true;
  admitP5ReviewedWork(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_INTEGRITY_CHECKPOINT, {
    wake: healthy ? { type: 'canonical_health', key: 'healthy' } : null,
  });
};

export const nativeTripArchive = {
  health: async () => {
    const health = await invoke('getHealth');
    await observeP5Health(health);
    return health;
  },
  queryHistoryPage: (request) => invoke('queryHistoryPage', request),
  projectionFeed: (request) => invoke('getProjectionFeed', request),
  metadata: (tripId) => invoke('getTripMetadata', { tripId }).then((result) => result.item),
  adjacent: (tripId, direction, status = '') => invoke('queryAdjacentTrip', { tripId, direction, status }).then((result) => result.item),
  aggregates: (request = {}) => invoke('getTripAggregates', request),
  chartBuckets: (request) => invoke('getTripChartBuckets', request),
  tagContext: (maxRecent = 50) => invoke('getTripTagContext', { maxRecent }),
  sampleMetadata: (maxItems = 20, maxBytes = 128 * 1024) => invoke('sampleTripMetadata', { maxItems, maxBytes }),
  overview: (tripId, maxPoints = 900) => invoke('getTripOverviewTrack', { tripId, maxPoints }),
  tombstone: (tripId, reason = 'user_delete', dataRights = false) => invoke('tombstoneTrip', { tripId, reason, dataRights }),
  eraseGeneration: (reason = 'data_rights_erasure') => invoke('eraseTripArchiveGeneration', { reason }),
  eraseSpeedGeneration: (reason = 'data_rights_erasure') => invoke('eraseSpeedArchiveGeneration', { reason }),
  ingestJournal: (maxItems = 8, maxWorkBytes = 8 * 1024 * 1024) => invoke('ingestCompletedJournal', { maxItems, maxWorkBytes }),
  reportIndexedDbOpen: (payload) => invoke('reportIndexedDbOpen', payload),
  beginMigrationTrip: (descriptor) => invoke('beginMigrationTrip', descriptor),
  appendMigrationTripChunk: (payload) => invoke('appendMigrationTripChunk', payload),
  finishMigrationTrip: (operationId) => invoke('finishMigrationTrip', { operationId }),
  abortMigrationTrip: (operationId) => invoke('abortMigrationTrip', { operationId }),
  completeMigration: (payload) => invoke('completeMigration', payload),
  saveMigrationCheckpoint: (checkpoint) => invoke('saveMigrationCheckpoint', { checkpoint }),
  migrationCheckpoint: () => invoke('getMigrationCheckpoint'),
  quarantineLegacySource: (payload) => invoke('quarantineLegacySource', payload),
  beginTripCommit: (descriptor) => invoke('beginTripCommit', descriptor),
  appendTripCommitChunk: (payload) => invoke('appendTripCommitChunk', payload),
  finishTripCommit: (operationId) => invoke('finishTripCommit', { operationId }),
  abortTripCommit: (operationId) => invoke('abortTripCommit', { operationId }),
  openPayload: (tripId, revision = undefined) => invoke(
    'openTripPayload', revision == null ? { tripId } : { tripId, revision }
  ),
  readPayloadChunk: (handle, chunkIndex) => invoke('readTripPayloadChunk', { handle, chunkIndex }),
  closePayload: (handle) => invoke('closeTripPayload', { handle }),
  speedState: () => invoke('getSpeedState'),
  beginSpeedBucketBatch: (buckets) => invoke('beginSpeedBucketBatch', { buckets }),
  beginSpeedBucketBatchPlan: (bucketCount, { p6Automatic = false } = {}) => invoke(
    'beginSpeedBucketBatchPlan', { bucketCount, p6Automatic }
  ),
  addSpeedBucketDescriptors: (batchId, buckets) => invoke('addSpeedBucketDescriptors', { batchId, buckets }),
  sealSpeedBucketBatchPlan: (batchId) => invoke('sealSpeedBucketBatchPlan', { batchId }),
  appendSpeedBucketChunk: (payload) => invoke('appendSpeedBucketChunk', payload),
  finishSpeedBucketBatch: (batchId) => invoke('finishSpeedBucketBatch', { batchId }),
  abortSpeedBucketBatch: (batchId) => invoke('abortSpeedBucketBatch', { batchId }),
  querySpeedBucketMetadata: (bucketIds) => invoke('querySpeedBucketMetadata', { bucketIds }),
  querySpeedBucketPage: (cursor = '', maxItems = 32) => invoke('querySpeedBucketPage', { cursor, maxItems }),
  querySpeedEditorItems: (request = {}) => invoke('querySpeedEditorItems', request),
  getSpeedEditorItem: (kind, id) => invoke('getSpeedEditorItem', { kind, id }),
  beginSpeedMaintenance: (type, maxAgeDays = 180) => invoke('beginSpeedMaintenance', { type, maxAgeDays }),
  // P4-C-F08: the native table, not renderer memory, owns which maintenance job
  // a bounded step continues after a process restart.
  beginOrResumeSpeedMaintenance: (type, maxAgeDays = 180) => invoke('beginOrResumeSpeedMaintenance', { type, maxAgeDays }),
  stepSpeedMaintenance: (jobId, maxBuckets = 8) => invoke('stepSpeedMaintenance', { jobId, maxBuckets }),
  cancelSpeedMaintenance: (jobId) => invoke('cancelSpeedMaintenance', { jobId }),
  speedMaintenanceStatus: (jobId) => invoke('getSpeedMaintenanceStatus', { jobId }),
  tombstoneSpeedBuckets: (bucketIds, reason = 'removed_bucket') => invoke('tombstoneSpeedBuckets', { bucketIds, reason }),
  beginLegacySpeedMigration: (descriptor) => invoke('beginLegacySpeedMigration', descriptor),
  appendLegacySpeedCiphertext: (payload) => invoke('appendLegacySpeedCiphertext', payload),
  executeLegacySpeedMigration: (operationId) => invoke('executeLegacySpeedMigration', { operationId }),
  legacySpeedMigrationStatus: (operationId = '') => invoke('getLegacySpeedMigrationStatus', { operationId }),
  beginStreamBackup: (payload) => invoke('beginStreamBackup', payload),
  streamBackupStatus: async (operationId) => {
    const status = await invoke('getStreamBackupStatus', { operationId });
    await notifyP5Terminal(status);
    return status;
  },
  cancelStreamBackup: (operationId) => invoke('cancelStreamBackup', { operationId }),
  publishStreamBackup: async (operationId) => {
    const result = await invoke('publishStreamBackup', { operationId });
    await notifyP5Terminal(result);
    return result;
  },
  beginStreamBackupRestore: (backupOperationId, passphrase) => invoke('beginStreamBackupRestore', { backupOperationId, passphrase }),
  beginStreamBackupRestoreFromUri: (uri, passphrase) => invoke('beginStreamBackupRestoreFromUri', { uri, passphrase }),
  pickStreamBackupRestoreFile: () => invoke('pickStreamBackupRestoreFile'),
  rotateEnvelopeKekBatch: (targetKekVersion, maxItems = 50) => invoke('rotateEnvelopeKekBatch', { targetKekVersion, maxItems }),
  envelopeKekRotationStatus: () => invoke('getEnvelopeKekRotationStatus'),
  stepP5RawGpsRetention: (payload) => invoke('stepP5NativeRawGpsRetention', payload),
  runP5RawGpsRetentionNow: (payload) => invoke('runP5NativeRawGpsRetentionNow', payload),
  acknowledgeP6RetentionFreeze: (jobId, nextCursor = '', complete = false) => invoke('acknowledgeP6RetentionFreeze', { jobId, nextCursor, complete }),
  stepP5JournalReconcile: () => invoke('stepP5JournalManifestReconcile'),
  stepP5Integrity: () => invoke('stepP5ArchiveIntegrityCheckpoint'),
  stepP5ResidueGc: () => invoke('stepP5ArchiveResidueGc'),
  p5PrivacyReceipts: () => invokePrivacyReceipt('getP5PrivacyReceipts'),
  acknowledgeP5PrivacyReceipt: (operationId) => invokePrivacyReceipt('acknowledgeP5PrivacyReceipt', { operationId }),
  runP5BlobDeepAudit: (jobId = '') => invoke('runP5BlobDeepAudit', { jobId }),
  runP5JournalRegistryBootstrap: () => invoke('runP5JournalRegistryBootstrap'),
  cancelP5JournalRegistryBootstrap: () => invoke('cancelP5JournalRegistryBootstrap'),
  stepP6TripDerived: () => invoke('stepP6TripDerived'),
  queueP6ExplicitTripSubjects: (tripIds = [], includeRoad = false) => (
    invoke('queueP6ExplicitTripSubjects', { tripIds, includeRoad })
  ),
  resetP6AnalyticsDerived: (phase = 'CONTRIBUTIONS') => invoke('resetP6AnalyticsDerived', { phase }),
  invalidateP6AnalyticsForSettings: (settingsVersion, reason = 'SETTINGS_OR_VEHICLE_CHANGED') => (
    invoke('invalidateP6AnalyticsForSettings', { settingsVersion, reason })
  ),
  finalizeP6ExplicitTripBuild: (includeRoad = false) => invoke('finalizeP6ExplicitTripBuild', { includeRoad }),
  stepP6RoadMemory: () => invoke('stepP6RoadMemory'),
  acknowledgeP6RoadMemory: (payload) => invoke('acknowledgeP6RoadMemory', payload),
  stepP6AffectedSelection: () => invoke('stepP6AffectedSelection'),
  createP6AffectedSelection: (payload) => invoke('createP6AffectedSelection', payload),
  acknowledgeP6AffectedSelection: (requestId, matched) => invoke('acknowledgeP6AffectedSelection', { requestId, matched }),
  queryP6GeometryPreviewPage: (cursor = '', maxItems = 40) => invoke('queryP6GeometryPreviewPage', { cursor, maxItems }),
  queryP6AchievementStats: (now = Date.now()) => invoke('queryP6AchievementStats', { now }),
  beginP6ComponentRepair: (candidateIds = []) => invoke('beginP6ComponentRepair', { candidateIds }),
  stepP6ComponentRepair: () => invoke('stepP6ComponentRepair'),
  acknowledgeP6ComponentRepair: (payload) => invoke('acknowledgeP6ComponentRepair', payload),
};

const decodeBase64 = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export async function readNativeTripPayload(tripId, revision = undefined) {
  const opened = await invoke('openTripPayload', revision == null ? { tripId } : { tripId, revision });
  const decoder = new TextDecoder();
  let json = '';
  try {
    for (let chunkIndex = 0; chunkIndex < opened.chunkCount; chunkIndex += 1) {
      const chunk = await invoke('readTripPayloadChunk', { handle: opened.handle, chunkIndex });
      json += decoder.decode(decodeBase64(chunk.plaintextBase64), { stream: chunkIndex + 1 < opened.chunkCount });
    }
    return JSON.parse(json);
  } finally {
    json = '';
    await invoke('closeTripPayload', { handle: opened.handle }).catch(() => {});
  }
}

/**
 * Iterate one top-level JSON array from canonical payload chunks without ever
 * constructing the complete payload or route array. Canonical trip JSON is a
 * top-level object; route points themselves remain individually bounded.
 */
export async function* iterateNativeTripJsonArray(tripId, propertyName = 'route_points') {
  const opened = await nativeTripArchive.openPayload(tripId);
  const decoder = new TextDecoder();
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let readingKey = false;
  let keyText = '';
  let candidateKey = null;
  let expectingKey = false;
  let awaitingTargetArray = false;
  let inTargetArray = false;
  let item = '';
  let itemDepth = 0;
  let itemInString = false;
  let itemEscaped = false;
  const MAX_ITEM_CHARS = 512 * 1024;

  const consume = function* (text) {
    for (const character of text) {
      if (inTargetArray) {
        if (!item) {
          if (/\s/.test(character) || character === ',') continue;
          if (character === ']') { inTargetArray = false; continue; }
        }
        item += character;
        if (item.length > MAX_ITEM_CHARS) throw new Error('TRIP_ROUTE_POINT_TOO_LARGE');
        if (itemInString) {
          if (itemEscaped) itemEscaped = false;
          else if (character === '\\') itemEscaped = true;
          else if (character === '"') itemInString = false;
          continue;
        }
        if (character === '"') { itemInString = true; continue; }
        if (character === '{' || character === '[') itemDepth += 1;
        else if (character === '}' || character === ']') itemDepth -= 1;
        if (itemDepth === 0 && item) {
          const parsed = JSON.parse(item);
          item = '';
          yield parsed;
        }
        continue;
      }

      if (awaitingTargetArray) {
        if (/\s/.test(character)) continue;
        if (character !== '[') throw new Error('TRIP_ROUTE_POINTS_NOT_ARRAY');
        awaitingTargetArray = false;
        inTargetArray = true;
        continue;
      }

      if (inString) {
        if (escaped) { if (readingKey) keyText += character; escaped = false; continue; }
        if (character === '\\') { if (readingKey) keyText += character; escaped = true; continue; }
        if (character === '"') {
          inString = false;
          if (readingKey) {
            candidateKey = JSON.parse(`"${keyText}"`);
            readingKey = false;
          }
          continue;
        }
        if (readingKey) keyText += character;
        continue;
      }

      if (character === '"') {
        inString = true;
        readingKey = objectDepth === 1 && expectingKey;
        keyText = '';
        continue;
      }
      if (character === '{' || character === '[') {
        objectDepth += 1;
        if (objectDepth === 1) expectingKey = true;
        continue;
      }
      if (character === '}' || character === ']') {
        objectDepth -= 1;
        continue;
      }
      if (objectDepth === 1 && character === ':') {
        expectingKey = false;
        if (candidateKey === propertyName) awaitingTargetArray = true;
        candidateKey = null;
        continue;
      }
      if (objectDepth === 1 && character === ',') {
        expectingKey = true;
        candidateKey = null;
      }
    }
  };

  try {
    for (let chunkIndex = 0; chunkIndex < opened.chunkCount; chunkIndex += 1) {
      const chunk = await nativeTripArchive.readPayloadChunk(opened.handle, chunkIndex);
      const bytes = decodeBase64(chunk.plaintextBase64);
      try {
        const text = decoder.decode(bytes, { stream: chunkIndex + 1 < opened.chunkCount });
        for (const value of consume(text)) yield value;
      } finally {
        bytes.fill(0);
      }
    }
    if (item || inTargetArray || awaitingTargetArray) throw new Error('TRIP_ROUTE_STREAM_TRUNCATED');
  } finally {
    item = '';
    keyText = '';
    await nativeTripArchive.closePayload(opened.handle).catch(() => {});
  }
}

/** Bounded direct-ingress writer used by streamed full-fidelity mutations. */
export async function createNativeTripCommitWriter(tripId) {
  const started = await nativeTripArchive.beginTripCommit({ tripId: String(tripId), sourceHash: '', expectedBytes: -1 });
  const maximum = Math.min(Number(started.maxChunkBytes) || 256 * 1024, 256 * 1024);
  let pending = new Uint8Array(maximum);
  let pendingBytes = 0;
  let chunkIndex = 0;
  let maximumBufferedBytes = 0;
  let closed = false;
  const flush = async () => {
    if (!pendingBytes) return;
    const chunk = pending.slice(0, pendingBytes);
    await nativeTripArchive.appendTripCommitChunk({
      operationId: started.operationId,
      chunkIndex,
      chunkBase64: encodeBase64Bytes(chunk),
    });
    maximumBufferedBytes = Math.max(maximumBufferedBytes, pendingBytes);
    chunk.fill(0);
    pendingBytes = 0;
    chunkIndex += 1;
  };
  const appendBytes = async (bytes) => {
    for (let offset = 0; offset < bytes.byteLength;) {
      const count = Math.min(maximum - pendingBytes, bytes.byteLength - offset);
      pending.set(bytes.subarray(offset, offset + count), pendingBytes);
      pendingBytes += count;
      offset += count;
      if (pendingBytes === maximum) await flush();
    }
  };
  return {
    operationId: started.operationId,
    async text(value) {
      const bytes = new TextEncoder().encode(String(value));
      try { await appendBytes(bytes); } finally { bytes.fill(0); }
    },
    async value(value) {
      await streamJsonValueChunks(value, maximum, appendBytes);
    },
    async finish() {
      await flush();
      pending.fill(0);
      const result = await nativeTripArchive.finishTripCommit(started.operationId);
      closed = true;
      return { ...result, maximumBufferedBytes };
    },
    async abort() {
      if (closed) return;
      closed = true;
      pending.fill(0);
      await nativeTripArchive.abortTripCommit(started.operationId).catch(() => {});
    },
  };
}

export async function readNativeSpeedBucket(bucketId) {
  const opened = await invoke('openSpeedBucketPayload', { bucketId });
  const decoder = new TextDecoder();
  let json = '';
  try {
    for (let chunkIndex = 0; chunkIndex < opened.chunkCount; chunkIndex += 1) {
      const chunk = await invoke('readSpeedBucketChunk', { handle: opened.handle, chunkIndex });
      json += decoder.decode(decodeBase64(chunk.plaintextBase64), { stream: chunkIndex + 1 < opened.chunkCount });
    }
    return JSON.parse(json);
  } finally {
    json = '';
    await invoke('closeSpeedBucketPayload', { handle: opened.handle }).catch(() => {});
  }
}

export const encodeBase64Bytes = (bytes) => {
  let binary = '';
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + block)));
  }
  return btoa(binary);
};

export const sha256Hex = async (bytes) => Array.from(
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
).map((value) => value.toString(16).padStart(2, '0')).join('');

const JSON_TEXT_BUFFER = 16 * 1024;

const streamJsonString = async (value, emit) => {
  await emit('"');
  let buffer = '';
  for (const character of String(value)) {
    buffer += JSON.stringify(character).slice(1, -1);
    if (buffer.length >= JSON_TEXT_BUFFER) {
      await emit(buffer);
      buffer = '';
    }
  }
  if (buffer) await emit(buffer);
  await emit('"');
};

const streamJsonValue = async (value, emit, ancestors, arrayElement = false) => {
  if (value === null || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    await emit('null');
    return;
  }
  if (typeof value === 'string') { await streamJsonString(value, emit); return; }
  if (typeof value === 'number') {
    await emit(Number.isFinite(value) ? JSON.stringify(value) : 'null');
    return;
  }
  if (typeof value === 'boolean') { await emit(value ? 'true' : 'false'); return; }
  if (typeof value === 'bigint') throw new TypeError('BigInt cannot be serialized as trip JSON');
  if (ancestors.has(value)) throw new TypeError('Circular trip payload');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      await emit('[');
      for (let index = 0; index < value.length; index += 1) {
        if (index) await emit(',');
        await streamJsonValue(value[index], emit, ancestors, true);
      }
      await emit(']');
      return;
    }
    if (typeof value?.toJSON === 'function') {
      await streamJsonValue(value.toJSON(), emit, ancestors, arrayElement);
      return;
    }
    await emit('{');
    let written = 0;
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
      if (written) await emit(',');
      await streamJsonString(key, emit);
      await emit(':');
      await streamJsonValue(child, emit, ancestors, false);
      written += 1;
    }
    await emit('}');
  } finally {
    ancestors.delete(value);
  }
};

/** Streams deterministic JSON in byte-bounded chunks without a whole-document string. */
export async function streamJsonValueChunks(value, maximumChunkBytes, onChunk) {
  const maxBytes = Math.max(1024, Math.min(256 * 1024, Number(maximumChunkBytes) || 256 * 1024));
  const encoder = new TextEncoder();
  let pending = new Uint8Array(maxBytes);
  let pendingBytes = 0;
  let emittedBytes = 0;
  let maximumObserved = 0;
  const flush = async () => {
    if (!pendingBytes) return;
    const chunk = pending.slice(0, pendingBytes);
    maximumObserved = Math.max(maximumObserved, chunk.byteLength);
    await onChunk(chunk);
    emittedBytes += chunk.byteLength;
    chunk.fill(0);
    pendingBytes = 0;
  };
  const emit = async (text) => {
    const encoded = encoder.encode(text);
    try {
      let offset = 0;
      while (offset < encoded.byteLength) {
        const copied = Math.min(maxBytes - pendingBytes, encoded.byteLength - offset);
        pending.set(encoded.subarray(offset, offset + copied), pendingBytes);
        pendingBytes += copied;
        offset += copied;
        if (pendingBytes === maxBytes) await flush();
      }
    } finally {
      encoded.fill(0);
    }
  };
  try {
    await streamJsonValue(value, emit, new Set());
    await flush();
    return { emittedBytes, maximumChunkBytes: maximumObserved };
  } finally {
    pending.fill(0);
  }
}

const streamTripOperation = async ({ trip, begin, append, finish, abort }) => {
  const start = await begin({ tripId: String(trip.id), sourceHash: '', expectedBytes: -1 });
  if (start.alreadyMigrated) return start;
  try {
    const chunkBytes = Math.min(Number(start.maxChunkBytes) || 256 * 1024, 256 * 1024);
    let chunkIndex = 0;
    const metrics = await streamJsonValueChunks(trip, chunkBytes, async (chunk) => {
      await append({
        operationId: start.operationId,
        chunkIndex,
        chunkBase64: encodeBase64Bytes(chunk),
      });
      chunkIndex += 1;
    });
    return { ...(await finish(start.operationId)), serializerMetrics: metrics };
  } catch (error) {
    if (typeof abort === 'function') await abort(start.operationId).catch(() => {});
    throw error;
  }
};

export const streamJsonToMigration = (trip) => streamTripOperation({
  trip,
  begin: (descriptor) => nativeTripArchive.beginMigrationTrip(descriptor),
  append: (payload) => nativeTripArchive.appendMigrationTripChunk(payload),
  finish: (operationId) => nativeTripArchive.finishMigrationTrip(operationId),
  // A failed migration finish may have placed the admitted source in native
  // quarantine. Do not erase that artifact from a generic JS catch path.
  abort: null,
});

export const streamJsonToCanonicalCommit = (trip) => streamTripOperation({
  trip,
  begin: (descriptor) => nativeTripArchive.beginTripCommit(descriptor),
  append: (payload) => nativeTripArchive.appendTripCommitChunk(payload),
  finish: (operationId) => nativeTripArchive.finishTripCommit(operationId),
  abort: (operationId) => nativeTripArchive.abortTripCommit(operationId),
});
