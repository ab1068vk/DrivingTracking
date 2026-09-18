import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';
import {
  readNativeSpeedBuckets,
  readNativeSpeedKnowledgeSample,
  writeNativeSpeedBuckets,
} from '@/lib/nativeSpeedKnowledgeStore';
import { nativeTripArchive, readNativeSpeedBucket } from '@/lib/nativeTripArchive';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  getEncryptedJson,
  isEncryptedPayload,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { decorateRoadMemoryCandidates } from '@/lib/roadMemoryIntelligence';
import {
  MAX_SAVED_SPEED_LIMIT_KMH,
  speedKnowledgeCellConfidence,
  speedKnowledgeCellEligibility,
} from '@/lib/speedKnowledgeCellPolicy';
import {
  P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES,
  P6_MAX_SPEED_PARTITION_BYTES,
  P6_READINESS_STATES,
} from '@/lib/p6Contracts';
import { registerP6BrowserDerivedReclaimer, requireBrowserP6DerivedStorage } from '@/lib/p6DerivedStorage';
import {
  getBrowserKeyProofGeneration,
  isBrowserKeyProofGenerationCurrent,
  withDurableKeyPublication,
  registerBrowserKeyReferenceDomain,
} from '@/lib/browserKeyReferences';

export const SPEED_KNOWLEDGE_STORAGE_KEY = 'speed_knowledge_v1';
export const SPEED_KNOWLEDGE_DB_NAME = 'drivesense_speed_knowledge';
export const SPEED_KNOWLEDGE_DB_VERSION = 4;
export const SPEED_KNOWLEDGE_SCHEMA_VERSION = 2;
export const SPEED_KNOWLEDGE_WRITE_AHEAD_KEY = 'speed_knowledge_v1_write_ahead';
export const SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY = 'speed_knowledge_native_mirror_v1';
export const SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY =
  'speed_knowledge_native_mirror_initialized_v1';
const SPEED_KNOWLEDGE_STORE = 'knowledge';
export const P6_SPEED_STORES = Object.freeze({
  CONTROL: 'p6_control',
  PARTITIONS: 'p6_partitions',
  MANIFESTS: 'p6_manifests',
  EDITOR_INDEX: 'p6_editor_index',
  STAGES: 'p6_stages',
  REPAIR: 'p6_component_repair',
  REPAIR_FRONTIER: 'p6_component_frontier',
});
export const P6_SPEED_AUTHORITY_KEY = 'authority';
export const P6_SPEED_E4_FENCE_KEY = 'e4_fence';
/**
 * The one durable record of the E4 cutover that does not live in IndexedDB.
 *
 * Post-cutover v2 is the authority, and the retired whole-model v1 store must
 * never quietly become the answer again. The authority record itself is an
 * IndexedDB row, so an installation whose IndexedDB has gone away would read
 * "no v2 record" as "still v1" and serve the predecessor model. This marker is
 * what makes that case a typed refusal instead.
 */
export const P6_SPEED_V2_CUTOVER_MARKER_KEY = 'p6_browser_speed_v2_cutover_v1';
export const P6_SPEED_AUTHORITY_UNREADABLE = 'BROWSER_V2_AUTHORITY_UNREADABLE';
export const P6_SPEED_EVIDENCE_SECRET_KEY = 'p6_evidence_hmac_key';
export const P6_SPEED_SCOPED_READ_REQUIRED = 'BROWSER_V2_SCOPED_READ_REQUIRED';
const P35_NATIVE_AUTHORITY_ENABLED = import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true';

const indexedDbEncryptionContext = (key) => (
  `indexeddb:${SPEED_KNOWLEDGE_DB_NAME}/${SPEED_KNOWLEDGE_STORE}:${key}`
);

const mutationTails = new Map();

const normalizedRevision = (value) => {
  const revision = Number(value?.knowledgeRevision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

export const normalizeSpeedKnowledgeMetadata = (value, {
  previous = null,
  increment = false,
  updatedAt = null,
} = {}) => {
  const next = value && typeof value === 'object' ? value : {};
  const revision = Math.max(normalizedRevision(next), normalizedRevision(previous)) +
    (increment ? 1 : 0);
  const existingUpdatedAt = String(next.knowledgeUpdatedAt || '').trim();
  return {
    ...next,
    schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
    knowledgeRevision: revision,
    knowledgeUpdatedAt: updatedAt || existingUpdatedAt || null,
  };
};

export const speedKnowledgeMetadata = (value) => {
  const normalized = normalizeSpeedKnowledgeMetadata(value);
  return {
    schemaVersion: normalized.schemaVersion,
    knowledgeRevision: normalized.knowledgeRevision,
    knowledgeUpdatedAt: normalized.knowledgeUpdatedAt,
  };
};

export const runSpeedKnowledgeStoreExclusive = (key, operation) => {
  const queueKey = String(key || SPEED_KNOWLEDGE_STORAGE_KEY);
  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request(`drivesense:${queueKey}`, { mode: 'exclusive' }, operation);
  }
  const previousTail = mutationTails.get(queueKey) || Promise.resolve();
  const result = previousTail.catch(() => {}).then(operation);
  const nextTail = result.catch(() => {});
  mutationTails.set(queueKey, nextTail);
  return result.finally(() => {
    if (mutationTails.get(queueKey) === nextTail) mutationTails.delete(queueKey);
  });
};

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const openDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }
  const request = indexedDB.open(SPEED_KNOWLEDGE_DB_NAME, SPEED_KNOWLEDGE_DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(SPEED_KNOWLEDGE_STORE)) {
      request.result.createObjectStore(SPEED_KNOWLEDGE_STORE, { keyPath: 'key' });
    }
    const create = (name, options = { keyPath: 'key' }) => (
      request.result.objectStoreNames.contains(name) ? null : request.result.createObjectStore(name, options)
    );
    create(P6_SPEED_STORES.CONTROL);
    const partitions = create(P6_SPEED_STORES.PARTITIONS);
    if (partitions) {
      partitions.createIndex('by_bucket_publication', ['bucketId', 'publicationVersion', 'ordinal']);
      partitions.createIndex('by_stage', ['stageId', 'bucketId', 'ordinal']);
    }
    const manifests = create(P6_SPEED_STORES.MANIFESTS, { keyPath: 'bucketId' });
    if (manifests) manifests.createIndex('by_bucket', 'bucketId');
    const editor = create(P6_SPEED_STORES.EDITOR_INDEX);
    if (editor) {
      editor.createIndex('by_kind_identity', ['kind', 'identity']);
      editor.createIndex('by_bucket_publication', ['bucketId', 'publicationVersion']);
      editor.createIndex('by_stage', 'stageId');
    }
    create(P6_SPEED_STORES.STAGES, { keyPath: 'stageId' });
    const repair = create(P6_SPEED_STORES.REPAIR, { keyPath: 'operationId' })
      || request.transaction?.objectStore?.(P6_SPEED_STORES.REPAIR);
    if (repair?.indexNames && !repair.indexNames.contains('by_state')) repair.createIndex('by_state', ['state', 'updatedAt', 'operationId']);
    const frontier = create(P6_SPEED_STORES.REPAIR_FRONTIER)
      || request.transaction?.objectStore?.(P6_SPEED_STORES.REPAIR_FRONTIER);
    if (frontier?.indexNames && !frontier.indexNames.contains('by_operation_round_state')) frontier.createIndex('by_operation_round_state', ['operationId', 'round', 'state', 'candidateId']);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const deleteDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb() || typeof indexedDB.deleteDatabase !== 'function') {
    resolve(false);
    return;
  }

  const request = indexedDB.deleteDatabase(SPEED_KNOWLEDGE_DB_NAME);
  request.onsuccess = () => resolve(true);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error(`IndexedDB delete blocked for ${SPEED_KNOWLEDGE_DB_NAME}`));
});

const p6SpeedControl = async (key) => {
  if (!canUseIndexedDb()) return null;
  const db = await openDb();
  try {
    const transaction = db.transaction(P6_SPEED_STORES.CONTROL, 'readonly');
    return await requestResult(transaction.objectStore(P6_SPEED_STORES.CONTROL).get(key)) || null;
  } finally { db.close(); }
};

export async function reclaimP6BrowserSpeedDerivedTurn({ scanLimit = 128 } = {}) {
  if (!canUseIndexedDb()) return { state: 'NO_RECLAIMABLE_DERIVED_DATA', reclaimedBytes: 0, hasMore: false };
  const db = await openDb();
  try {
    const read = db.transaction([P6_SPEED_STORES.PARTITIONS, P6_SPEED_STORES.EDITOR_INDEX,
      P6_SPEED_STORES.CONTROL], 'readonly');
    const readRows = (storeName) => new Promise((resolve, reject) => {
      const rows = []; const request = read.objectStore(storeName).openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const cursor = request.result; if (!cursor || rows.length >= scanLimit) return resolve(rows); rows.push({ key: cursor.primaryKey, value: cursor.value, storeName }); cursor.continue(); };
    });
    const partitionsPromise = readRows(P6_SPEED_STORES.PARTITIONS);
    const editorPromise = readRows(P6_SPEED_STORES.EDITOR_INDEX);
    const authorityPromise = requestResult(read.objectStore(P6_SPEED_STORES.CONTROL).get(P6_SPEED_AUTHORITY_KEY));
    const [partitionRows, editorRows, authority] = await Promise.all([
      partitionsPromise, editorPromise, authorityPromise,
    ]);
    await transactionDone(read);
    const rows = [...partitionRows, ...editorRows];
    const manifestRead = db.transaction(P6_SPEED_STORES.MANIFESTS, 'readonly');
    const manifestStore = manifestRead.objectStore(P6_SPEED_STORES.MANIFESTS);
    const bucketIds = [...new Set(rows.map((row) => row.value?.bucketId).filter(Boolean))];
    const manifests = new Map((await Promise.all(bucketIds.map(async (bucketId) => [
      bucketId, await requestResult(manifestStore.get(bucketId)),
    ]))));
    await transactionDone(manifestRead);
    const obsolete = rows.filter(({ value }) => {
        const manifest = manifests.get(value?.bucketId);
        if (manifest?.state === 'COMMITTED') return manifest.stageId !== value.stageId || manifest.publicationVersion !== value.publicationVersion;
        return authority?.stageId !== value.stageId || authority?.publicationVersion !== value.publicationVersion;
      })
      .sort((a, b) => (a.storeName === P6_SPEED_STORES.PARTITIONS ? 0 : 1)
        - (b.storeName === P6_SPEED_STORES.PARTITIONS ? 0 : 1)
        || (Number(a.value?.updatedAt) || 0) - (Number(b.value?.updatedAt) || 0)
        || String(a.key).localeCompare(String(b.key)))[0];
    if (!obsolete) return { state: 'NO_RECLAIMABLE_DERIVED_DATA', itemsWorked: rows.length, reclaimedBytes: 0, hasMore: false };
    const write = db.transaction(obsolete.storeName, 'readwrite');
    write.objectStore(obsolete.storeName).delete(obsolete.key); await transactionDone(write);
    const bytes = Number(obsolete.value?.encodedBytes) || p6JsonBytes(obsolete.value);
    return { state: 'RECLAIMED', kind: obsolete.storeName === P6_SPEED_STORES.PARTITIONS
      ? 'OBSOLETE_STAGE' : 'OBSOLETE_EDITOR_INDEX', itemsWorked: rows.length + 1,
      bytesWorked: bytes, reclaimedBytes: bytes, hasMore: rows.length > 1 };
  } finally { db.close(); }
}

const registeredSpeedDerivedReclaimer = () => reclaimP6BrowserSpeedDerivedTurn();
registerP6BrowserDerivedReclaimer(registeredSpeedDerivedReclaimer, 0);

const V1_AUTHORITY = Object.freeze({
  key: P6_SPEED_AUTHORITY_KEY, version: 1, state: 'ACTIVE', publicationVersion: 0,
});

const p6AuthorityUnreadable = (detail = '') => {
  const error = new Error(detail ? `${P6_SPEED_AUTHORITY_UNREADABLE}: ${detail}` : P6_SPEED_AUTHORITY_UNREADABLE);
  error.code = P6_SPEED_AUTHORITY_UNREADABLE;
  return error;
};

const p6ReadAuthorityEvidence = async () => {
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.CONTROL, P6_SPEED_STORES.PARTITIONS], 'readonly');
    const control = tx.objectStore(P6_SPEED_STORES.CONTROL);
    const authorityRequest = requestResult(control.get(P6_SPEED_AUTHORITY_KEY));
    const fenceRequest = requestResult(control.get(P6_SPEED_E4_FENCE_KEY));
    const partitionStore = tx.objectStore(P6_SPEED_STORES.PARTITIONS);
    const materialRequest = typeof partitionStore.openCursor !== 'function'
      ? Promise.resolve(false)
      : new Promise((resolve, reject) => {
      const request = partitionStore.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(Boolean(request.result));
    });
    const [authority, fence, hasV2Material] = await Promise.all([
      authorityRequest, fenceRequest, materialRequest,
    ]);
    return { authority, fence, hasV2Material };
  } finally { db.close(); }
};

export const readP6BrowserSpeedAuthority = async () => {
  if (isNativePlatform()) return { ...V1_AUTHORITY };
  const cutover = await getJson(P6_SPEED_V2_CUTOVER_MARKER_KEY, null).catch(() => null);
  if (!canUseIndexedDb()) {
    if (Number(cutover?.version) === 2) {
      // v2 holds authority and its store is unreachable. Serving v1 here would
      // be a post-cutover fallback to the retired whole model, so refuse.
      const error = new Error(P6_SPEED_AUTHORITY_UNREADABLE);
      error.code = P6_SPEED_AUTHORITY_UNREADABLE;
      throw error;
    }
    return { ...V1_AUTHORITY };
  }
  const { authority: record, fence, hasV2Material } = await p6ReadAuthorityEvidence();
  if (record?.version === 2 && record?.state === 'ACTIVE') {
    const publicationVersion = Number(record.publicationVersion) || 0;
    const markerPublication = Number(cutover?.publicationVersion) || 0;
    const markerPrevious = Number(cutover?.previousPublicationVersion) || 0;
    const markerCoversAuthority = Number(cutover?.version) === 2 && (
      markerPublication === publicationVersion
      || (cutover?.state === 'PREPARED' && markerPrevious === publicationVersion)
    );
    if (cutover && !markerCoversAuthority) {
      throw p6AuthorityUnreadable('authority and irreversible guard disagree');
    }
    if (!cutover || (cutover.state === 'PREPARED' && markerPublication === publicationVersion)) {
      await setJson(P6_SPEED_V2_CUTOVER_MARKER_KEY, {
        version: 2, state: 'ACTIVE', stageId: record.stageId,
        publicationVersion, activatedAt: Number(record.activatedAt) || Date.now(),
      });
    }
    return record;
  }
  if (Number(cutover?.version) === 2 && cutover?.state === 'ACTIVE') {
    throw p6AuthorityUnreadable('v2 guard exists but the authority row is missing');
  }
  // PREPARED is installed before the visibility transaction. While IndexedDB
  // is readable, an in-progress E4 fence proves that v1 remains the authority.
  // If IndexedDB disappears during this interval, the guard deliberately makes
  // the read fail closed instead of exposing the predecessor.
  const legalV1Conversion = fence?.state === 'CONVERSION_IN_PROGRESS'
    && (!cutover || (cutover?.state === 'PREPARED' && fence?.stageId === cutover?.stageId));
  if (hasV2Material && !legalV1Conversion) {
    throw p6AuthorityUnreadable('v2 material exists without a readable authority row');
  }
  return { ...V1_AUTHORITY };
};

export const isP6BrowserSpeedV2Authority = async () => (
  !isNativePlatform() && (await readP6BrowserSpeedAuthority()).version === 2
);

const p6MutationLeaseId = () => globalThis.crypto?.randomUUID?.()
  || `p6-speed-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const acquireP6V1MutationLease = async () => {
  const leaseId = p6MutationLeaseId();
  const db = await openDb();
  try {
    const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
    const store = tx.objectStore(P6_SPEED_STORES.CONTROL);
    const authority = await requestResult(store.get(P6_SPEED_AUTHORITY_KEY));
    const fence = await requestResult(store.get(P6_SPEED_E4_FENCE_KEY));
    if (authority?.version === 2) {
      tx.abort();
      const error = new Error(P6_SPEED_SCOPED_READ_REQUIRED);
      error.code = P6_SPEED_SCOPED_READ_REQUIRED;
      throw error;
    }
    if (fence?.state === 'CONVERSION_IN_PROGRESS') {
      tx.abort();
      const error = new Error('E4_CONVERSION_IN_PROGRESS');
      error.code = 'E4_CONVERSION_IN_PROGRESS';
      throw error;
    }
    store.put({ key: `mutation:${leaseId}`, leaseId, state: 'ACTIVE', createdAt: Date.now() });
    await transactionDone(tx);
    return leaseId;
  } finally { db.close(); }
};

const p6EvidenceKey = async () => {
  if (!globalThis.crypto?.subtle || !canUseIndexedDb()) throw new Error('P6_EVIDENCE_HMAC_UNAVAILABLE');
  const db = await openDb();
  try {
    const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readonly');
    const saved = await requestResult(tx.objectStore(P6_SPEED_STORES.CONTROL).get(P6_SPEED_EVIDENCE_SECRET_KEY));
    if (saved?.cryptoKey) return saved.cryptoKey;
  } finally { db.close(); }
  const generated = await globalThis.crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
  const writeDb = await openDb();
  try {
    const tx = writeDb.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
    const store = tx.objectStore(P6_SPEED_STORES.CONTROL);
    const saved = await requestResult(store.get(P6_SPEED_EVIDENCE_SECRET_KEY));
    if (!saved?.cryptoKey) store.put({ key: P6_SPEED_EVIDENCE_SECRET_KEY, cryptoKey: generated, createdAt: Date.now() });
    await transactionDone(tx);
    return saved?.cryptoKey || generated;
  } finally { writeDb.close(); }
};

export async function p6EvidenceMembershipToken({ sourceAuthority = '', tripId = '', sourceRevision = '', observationOrdinal = 0 } = {}) {
  const identity = `${String(sourceAuthority)}\n${String(tripId)}\n${String(sourceRevision)}\n${Math.max(0, Math.trunc(Number(observationOrdinal) || 0))}`;
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(
    'HMAC', await p6EvidenceKey(), new TextEncoder().encode(identity),
  ));
  return [...signature].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function beginP6BrowserComponentRepair(candidateIds = []) {
  const active = await readP6BrowserSpeedAuthority();
  const operationId = p6MutationLeaseId();
  const ids = [...new Set((candidateIds || []).map(String).filter(Boolean))].sort().slice(0, 128);
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.REPAIR, P6_SPEED_STORES.REPAIR_FRONTIER, P6_SPEED_STORES.CONTROL], 'readwrite');
    tx.objectStore(P6_SPEED_STORES.REPAIR).put({ operationId, speedGeneration: `browser-v2:${active.publicationVersion}`,
      algorithmVersion: 1, componentContentVersion: p6MutationLeaseId(), round: 0, state: 'READY',
      observationCursor: null, publicationTarget: 'SCOPED_SPEED_OWNER', updatedAt: Date.now() });
    ids.forEach((candidateId) => tx.objectStore(P6_SPEED_STORES.REPAIR_FRONTIER).put({
      key: `${operationId}:0:${candidateId}`, operationId, round: 0, candidateId, state: 'READY', updatedAt: Date.now(),
    }));
    await transactionDone(tx);
  } finally { db.close(); }
  return { state: 'READY', repairOperationId: operationId, itemsWorked: ids.length, bytesWorked: 0, hasMore: ids.length > 0 };
}

export async function stepP6BrowserComponentRepair() {
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.REPAIR, P6_SPEED_STORES.REPAIR_FRONTIER, P6_SPEED_STORES.CONTROL], 'readwrite');
    const repairIndex = tx.objectStore(P6_SPEED_STORES.REPAIR).index('by_state');
    let repair = await requestResult(repairIndex.get(IDBKeyRange.bound(['READY', 0, ''], ['READY', Number.MAX_SAFE_INTEGER, '\uffff'])));
    if (!repair) repair = await requestResult(repairIndex.get(IDBKeyRange.bound(['RUNNING', 0, ''], ['RUNNING', Number.MAX_SAFE_INTEGER, '\uffff'])));
    if (!repair) { await transactionDone(tx); return { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false }; }
    const active = await requestResult(tx.objectStore(P6_SPEED_STORES.CONTROL).get(P6_SPEED_AUTHORITY_KEY)).catch(() => null);
    if (`browser-v2:${active?.publicationVersion}` !== repair.speedGeneration) {
      tx.objectStore(P6_SPEED_STORES.REPAIR).put({ ...repair, state: 'REPAIR_ESCALATED', updatedAt: Date.now() });
      await transactionDone(tx); return { state: 'REPAIR_ESCALATED', repairOperationId: repair.operationId, itemsWorked: 1, bytesWorked: 0, hasMore: false };
    }
    const index = tx.objectStore(P6_SPEED_STORES.REPAIR_FRONTIER).index('by_operation_round_state');
    const frontier = await requestResult(index.get(IDBKeyRange.bound(
      [repair.operationId, repair.round, 'READY', ''], [repair.operationId, repair.round, 'READY', '\uffff'],
    )));
    if (frontier) {
      tx.objectStore(P6_SPEED_STORES.REPAIR).put({ ...repair, state: 'RUNNING', updatedAt: Date.now() });
      await transactionDone(tx); return { state: 'REPAIR_PAGE', repairOperationId: repair.operationId,
        candidateId: frontier.candidateId, round: repair.round, itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    const done = repair.round >= 1;
    tx.objectStore(P6_SPEED_STORES.REPAIR).put({ ...repair, round: done ? repair.round : 1,
      state: done ? 'COMPLETE' : 'READY', updatedAt: Date.now() });
    await transactionDone(tx); return { state: done ? 'COMPLETE' : 'ROUND_COMPLETE',
      repairOperationId: repair.operationId, round: done ? repair.round : 1, itemsWorked: 1, bytesWorked: 0, hasMore: !done };
  } finally { db.close(); }
}

export async function acknowledgeP6BrowserComponentRepair({ repairOperationId, candidateId, round = 0, discoveredCandidateIds = [] } = {}) {
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.REPAIR, P6_SPEED_STORES.REPAIR_FRONTIER], 'readwrite');
    const repairs = tx.objectStore(P6_SPEED_STORES.REPAIR); const repair = await requestResult(repairs.get(repairOperationId));
    const frontier = tx.objectStore(P6_SPEED_STORES.REPAIR_FRONTIER);
    const key = `${repairOperationId}:${round}:${candidateId}`; const row = await requestResult(frontier.get(key));
    if (!repair || !row || row.state !== 'READY') { tx.abort(); throw new Error('P6_REPAIR_ACK_STALE'); }
    frontier.put({ ...row, state: 'PROCESSED', updatedAt: Date.now() });
    const discovered = [...new Set((discoveredCandidateIds || []).map(String).filter(Boolean))].sort().slice(0, 128);
    if (round === 0) discovered.forEach((id) => frontier.put({ key: `${repairOperationId}:1:${id}`,
      operationId: repairOperationId, round: 1, candidateId: id, state: 'READY', updatedAt: Date.now() }));
    else if (discovered.length) repairs.put({ ...repair, state: 'REPAIR_ESCALATED', updatedAt: Date.now() });
    await transactionDone(tx);
    return { state: round === 1 && discovered.length ? 'REPAIR_ESCALATED' : 'ACKNOWLEDGED',
      itemsWorked: 1 + discovered.length, bytesWorked: 0, hasMore: !(round === 1 && discovered.length) };
  } finally { db.close(); }
}

const releaseP6V1MutationLease = async (leaseId) => {
  if (!leaseId || !canUseIndexedDb()) return;
  const db = await openDb();
  try {
    const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
    tx.objectStore(P6_SPEED_STORES.CONTROL).delete(`mutation:${leaseId}`);
    await transactionDone(tx);
  } finally { db.close(); }
};

const readIndexedDb = async (key) => {
  const db = await openDb();
  let storedValue = null;
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readonly');
    const record = await requestResult(transaction.objectStore(SPEED_KNOWLEDGE_STORE).get(key));
    storedValue = record?.value ?? null;
  } finally {
    db.close();
  }
  if (storedValue == null) return null;
  if (isEncryptedPayload(storedValue)) {
    return decryptSensitiveValue(storedValue, indexedDbEncryptionContext(key));
  }
  // One-time migration for repositories created before saved-road geometry
  // was encrypted. Rewriting happens only after the plaintext value is safely
  // loaded, so a crypto failure cannot destroy the recoverable legacy record.
  await writeIndexedDb(key, storedValue);
  recordSystemEvent('speed_knowledge_at_rest_migrated', {
    store: 'indexeddb',
  }, {
    category: 'storage',
    title: 'Saved road speeds encrypted',
  });
  return storedValue;
};

/**
 * AUD-007 round 5. Admission spans CAPTURE -> ENCRYPT -> DURABLE COMMIT.
 *
 * Round 4 fenced `setEncryptedJson` and the rewrap paths, but this producer selected the
 * outgoing key version, encrypted, and committed later with nothing held. A finalizer
 * running in that gap saw no admitted writer, proved zero, deleted the version, and this
 * write then published a durable row under a destroyed key — `KEY_VERSION_DESTROYED` on
 * the next read, far from the cause. The token is held until the row is durable or the
 * attempt is definitively abandoned.
 */
const writeIndexedDb = async (key, value) => withDurableKeyPublication(async () => {
  const leaseId = await acquireP6V1MutationLease();
  let db;
  try {
    const encryptedValue = await encryptSensitiveValue(value, indexedDbEncryptionContext(key));
    db = await openDb();
    const transaction = db.transaction([SPEED_KNOWLEDGE_STORE, P6_SPEED_STORES.CONTROL], 'readwrite');
    const control = transaction.objectStore(P6_SPEED_STORES.CONTROL);
    const lease = await requestResult(control.get(`mutation:${leaseId}`));
    const fence = await requestResult(control.get(P6_SPEED_E4_FENCE_KEY));
    const authority = await requestResult(control.get(P6_SPEED_AUTHORITY_KEY));
    if (!lease || fence?.state === 'CONVERSION_IN_PROGRESS' || authority?.version === 2) {
      transaction.abort();
      const error = new Error(fence?.state === 'CONVERSION_IN_PROGRESS'
        ? 'E4_CONVERSION_IN_PROGRESS' : P6_SPEED_SCOPED_READ_REQUIRED);
      error.code = error.message;
      throw error;
    }
    transaction.objectStore(SPEED_KNOWLEDGE_STORE).put({
      key,
      value: encryptedValue,
      updatedAt: new Date().toISOString(),
    });
    if (typeof control.delete === 'function') control.delete(`mutation:${leaseId}`);
    await transactionDone(transaction);
  } finally {
    db?.close();
    await releaseP6V1MutationLease(leaseId).catch(() => {});
  }
});

let migrationPromise = null;
const NATIVE_BUCKET_MIGRATION_KEY = 'drivesense_speed_bucket_migration_v1';

const readIndexedDbWrapper = async (key) => {
  const db = await openDb();
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readonly');
    return await requestResult(transaction.objectStore(SPEED_KNOWLEDGE_STORE).get(key)) || null;
  } finally {
    db.close();
  }
};

const decodedBase64Bytes = (value) => {
  const length = String(value || '').length;
  const padding = value?.endsWith('==') ? 2 : value?.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(length * 3 / 4) - padding);
};

const readNativePreferenceJsonStrict = async (key) => {
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key });
    if (value == null || value === '') return null;
    return JSON.parse(value);
  }
  // On the web the app writes these keys through `setJson`, which uses bare
  // localStorage; the Capacitor Preferences web backend stores under its own
  // prefixed key. Reading through Preferences here therefore looked past the
  // value the app had actually written, so E4 could never select a write-ahead
  // or legacy predecessor in a browser - the two places where a saved-speed
  // model lives when IndexedDB is unavailable or a v1 write was fenced off.
  // This read must use the same storage the write used, and it still does not
  // decrypt: the wrapper is compared, not opened.
  return await getJson(key, null) ?? null;
};

const explicitPredecessorSource = async () => {
  // A write-ahead value is a pending/newest commit by construction. Avoid decrypting
  // three whole candidates merely to sort their encrypted revisions.
  const writeAhead = await readNativePreferenceJsonStrict(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY);
  if (writeAhead != null) return { sourceId: 'preferences_write_ahead', context: `storage:${SPEED_KNOWLEDGE_WRITE_AHEAD_KEY}`, wrapper: writeAhead };
  if (canUseIndexedDb()) {
    const record = await readIndexedDbWrapper(SPEED_KNOWLEDGE_STORAGE_KEY);
    if (record?.value != null) return { sourceId: 'indexeddb', context: indexedDbEncryptionContext(SPEED_KNOWLEDGE_STORAGE_KEY), wrapper: record.value, updatedAt: record.updatedAt || null };
  }
  const legacy = await readNativePreferenceJsonStrict(SPEED_KNOWLEDGE_STORAGE_KEY);
  return legacy == null ? null : { sourceId: 'preferences_legacy', context: `storage:${SPEED_KNOWLEDGE_STORAGE_KEY}`, wrapper: legacy };
};

const rereadExplicitPredecessor = async (sourceId) => {
  if (sourceId === 'preferences_write_ahead') {
    return readNativePreferenceJsonStrict(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY);
  }
  if (sourceId === 'indexeddb') {
    return (await readIndexedDbWrapper(SPEED_KNOWLEDGE_STORAGE_KEY))?.value ?? null;
  }
  if (sourceId === 'preferences_legacy') {
    return readNativePreferenceJsonStrict(SPEED_KNOWLEDGE_STORAGE_KEY);
  }
  return null;
};

const p6JsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const p6Hex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
const p6Fingerprint = async (value) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) return p6Hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  let hash = 2166136261;
  bytes.forEach((item) => { hash = Math.imul(hash ^ item, 16777619) >>> 0; });
  return `fnv1a-${hash.toString(16)}-${bytes.byteLength}`;
};

const p6BucketId = (value) => {
  const geohash = String(value?.geohash || value?.sectionKey || '').trim().toLowerCase();
  return geohash.length >= 4 ? geohash.slice(0, 4) : '0000';
};

const p6Bucketize = (value = {}) => {
  const buckets = new Map();
  const bucket = (id) => {
    if (!buckets.has(id)) buckets.set(id, { cells: {}, corrections: [], excludedSections: [], roadMemory: { candidates: [] } });
    return buckets.get(id);
  };
  Object.entries(value.cells || {}).forEach(([geohash, cell]) => {
    bucket(String(geohash).slice(0, 4).toLowerCase() || '0000').cells[geohash] = cell;
  });
  for (const item of value.corrections || []) bucket(p6BucketId(item)).corrections.push(item);
  for (const item of value.excludedSections || []) bucket(p6BucketId(item)).excludedSections.push(item);
  for (const item of value.roadMemory?.candidates || []) bucket(p6BucketId(item)).roadMemory.candidates.push(item);
  const root = { ...value };
  delete root.cells;
  delete root.corrections;
  delete root.excludedSections;
  root.roadMemory = { ...(value.roadMemory || {}) };
  delete root.roadMemory.candidates;
  return { buckets, root };
};

const p6EmptyPartition = () => ({ cells: {}, corrections: [], excludedSections: [], roadMemory: { candidates: [] } });
const p6PartitionBucket = (document) => {
  const capacityBlocked = (encodedBytes, partitionKind) => {
    const error = new Error(P6_READINESS_STATES.CAPACITY_BLOCKED);
    error.code = P6_READINESS_STATES.CAPACITY_BLOCKED;
    error.encodedBytes = encodedBytes;
    error.partitionKind = partitionKind;
    throw error;
  };
  // Ordinal zero is the canonical/user partition. Automatic evidence never
  // enters it, so automatic growth cannot consume the manual rewrite margin.
  const canonical = {
    cells: { ...(document.cells || {}) },
    corrections: [...(document.corrections || [])],
    excludedSections: [...(document.excludedSections || [])],
    roadMemory: { candidates: [] },
  };
  const canonicalBytes = p6JsonBytes(canonical);
  if (canonicalBytes > P6_MAX_SPEED_PARTITION_BYTES) capacityBlocked(canonicalBytes, 'CANONICAL');
  const parts = [{ value: canonical, encodedBytes: canonicalBytes, partitionKind: 'CANONICAL' }];
  const automatic = [...(document.roadMemory?.candidates || [])].sort((left, right) => {
    const identity = (value) => String(value?.id || value?.candidateId || value?.sectionKey || value?.geohash || JSON.stringify(value));
    return identity(left).localeCompare(identity(right));
  });
  let current = p6EmptyPartition();
  const flushAutomatic = () => {
    if (!current.roadMemory.candidates.length) return;
    const bytes = p6JsonBytes(current);
    if (bytes > P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES) capacityBlocked(bytes, 'AUTOMATIC');
    parts.push({ value: current, encodedBytes: bytes, partitionKind: 'AUTOMATIC' });
    current = p6EmptyPartition();
  };
  automatic.forEach((candidate) => {
    current.roadMemory.candidates.push(candidate);
    if (p6JsonBytes(current) <= P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES) return;
    current.roadMemory.candidates.pop();
    flushAutomatic();
    current.roadMemory.candidates.push(candidate);
    const indivisibleBytes = p6JsonBytes(current);
    if (indivisibleBytes > P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES) {
      capacityBlocked(indivisibleBytes, 'AUTOMATIC');
    }
  });
  flushAutomatic();
  return parts;
};

const p6EditorRows = (bucketId, document) => {
  const rows = [];
  const add = (kind, values) => (values || []).forEach((item) => {
    for (const key of kind === 'exclusion'
      ? ['exclusionId', 'exclusionKey', 'id', 'sectionKey', 'geohash']
      : kind === 'candidate' ? ['id', 'candidateId', 'sectionKey', 'geohash']
        : ['id', 'ruleId', 'correctionId', 'sectionKey', 'geohash']) {
      const identity = String(item?.[key] || '').trim();
      if (identity) rows.push({ kind, identity, bucketId, item });
    }
  });
  add('correction', document.corrections);
  add('exclusion', document.excludedSections);
  add('candidate', document.roadMemory?.candidates);
  (document.roadMemory?.candidates || []).forEach((candidate) => {
    (candidate?.p6AutomaticEvidence?.receiptedEvidence || []).forEach((receipt) => {
      const identity = String(receipt?.sourceIdentity || '').trim();
      if (identity) rows.push({ kind: 'evidence', identity, bucketId, item: candidate });
    });
  });
  Object.entries(document.cells || {}).forEach(([identity, cell]) => {
    if (cell?.conflict === true) rows.push({ kind: 'conflict', identity, bucketId, item: { geohash: identity, ...cell } });
  });
  return rows;
};

const p6PrepareStageBucket = async ({ stageId, publicationVersion, bucketId, document,
  commitState = 'STAGED' }) => {
  const parts = p6PartitionBucket(document);
  const editorItems = p6EditorRows(bucketId, document);
  const encrypted = await Promise.all(parts.map((part, ordinal) => encryptSensitiveValue(part.value,
    `p6:speed-v2:${stageId}:${bucketId}:${publicationVersion}:${ordinal}`)));
  const proposedBytes = encrypted.reduce((sum, value) => sum + p6JsonBytes(value), 0);
  // The 280 MiB reserve exists to keep canonical writes possible, so it may
  // only refuse derived output. Ordinal zero is the CANONICAL partition: it
  // carries the user's own corrections, exclusions and review state, and a
  // manual correction has to succeed under exactly the pressure that blocks
  // automatically learned evidence.
  const derivedBytes = parts.reduce((sum, part, ordinal) => (
    part.partitionKind === 'CANONICAL' ? sum : sum + p6JsonBytes(encrypted[ordinal])
  ), 0);
  const now = Date.now();
  const partitionRows = parts.map((part, ordinal) => ({
    key: `${stageId}:${bucketId}:${ordinal}`, stageId, bucketId, publicationVersion, ordinal,
    partitionKind: part.partitionKind, commitState, payload: encrypted[ordinal],
    encodedBytes: part.encodedBytes, updatedAt: now,
  }));
  const editorRows = editorItems.map(({ item: _item, ...row }, index) => ({
    key: `${stageId}:${bucketId}:${row.kind}:${row.identity}:${index}`, stageId, publicationVersion,
    commitState, ...row,
  }));
  return { partitions: parts.length, proposedBytes, derivedBytes,
    itemsWorked: editorItems.length + parts.length, partitionRows, editorRows };
};

/**
 * AUD-007 round 5: admission spans CAPTURE -> ENCRYPT -> DURABLE COMMIT. A producer that
 * captures the outgoing key version and commits later with nothing held lets a finalizer
 * see no admitted writer, prove zero, delete the version, and this write then publishes
 * durable ciphertext under a destroyed key.
 */
const p6WriteStageBucket = async (options) => withDurableKeyPublication(async () => {
  const prepared = await p6PrepareStageBucket(options);
  if (prepared.derivedBytes > 0) await requireBrowserP6DerivedStorage(prepared.derivedBytes);
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.PARTITIONS, P6_SPEED_STORES.EDITOR_INDEX], 'readwrite');
    const partitionStore = tx.objectStore(P6_SPEED_STORES.PARTITIONS);
    prepared.partitionRows.forEach((row) => partitionStore.put(row));
    const editor = tx.objectStore(P6_SPEED_STORES.EDITOR_INDEX);
    prepared.editorRows.forEach((row) => editor.put(row));
    await transactionDone(tx);
  } finally { db.close(); }
  return prepared;
});

/**
 * Publish a complete browser-v2 generation through one authority boundary.
 * The out-of-band guard is durable before IndexedDB can expose the new
 * authority. Root publication, authority replacement and retirement of every
 * superseded scoped manifest then commit in one IndexedDB transaction.
 */
const publishP6BrowserSpeedGeneration = async ({
  stageId,
  publicationVersion,
  root,
  rootPayload,
  sourceFingerprint,
  sourceKeyVersion = 0,
  completeFence = null,
}) => {
  const current = await p6SpeedControl(P6_SPEED_AUTHORITY_KEY);
  const previousPublicationVersion = current?.version === 2
    ? Math.max(0, Number(current.publicationVersion) || 0)
    : 0;
  await setJson(P6_SPEED_V2_CUTOVER_MARKER_KEY, {
    version: 2,
    state: 'PREPARED',
    stageId,
    publicationVersion,
    previousPublicationVersion,
    preparedAt: Date.now(),
  });
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.CONTROL, P6_SPEED_STORES.PARTITIONS,
      P6_SPEED_STORES.MANIFESTS], 'readwrite');
    tx.objectStore(P6_SPEED_STORES.PARTITIONS).put({
      key: `${stageId}:__global__:0`, stageId, bucketId: '__global__', publicationVersion,
      ordinal: 0, commitState: 'COMMITTED', payload: rootPayload,
      encodedBytes: p6JsonBytes(root), updatedAt: Date.now(),
    });
    await new Promise((resolve, reject) => {
      const request = tx.objectStore(P6_SPEED_STORES.MANIFESTS).openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(undefined); return; }
        if (Number(cursor.value?.publicationVersion) !== Number(publicationVersion)
          || cursor.value?.stageId !== stageId) cursor.delete();
        cursor.continue();
      };
    });
    const control = tx.objectStore(P6_SPEED_STORES.CONTROL);
    const activatedAt = Date.now();
    control.put({
      key: P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE', stageId, publicationVersion,
      sourceFingerprint, sourceKeyVersion, activatedAt,
    });
    if (completeFence) control.put({ ...completeFence, state: 'COMPLETE', cursor: null, updatedAt: activatedAt });
    await transactionDone(tx);
  } finally { db.close(); }
  await setJson(P6_SPEED_V2_CUTOVER_MARKER_KEY, {
    version: 2, state: 'ACTIVE', stageId, publicationVersion, activatedAt: Date.now(),
  }).catch((error) => logSystemFailure('p6_browser_speed_cutover_marker_finalize', error));
};

const e4SourceCache = new Map();

const deleteStageRowsTurn = async (storeName, stageId, limit = 128) => {
  const db = await openDb();
  try {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const index = store.index('by_stage');
    const result = await new Promise((resolve, reject) => {
      let removed = 0;
      const range = storeName === P6_SPEED_STORES.PARTITIONS
        ? IDBKeyRange.bound([stageId, '', Number.MIN_SAFE_INTEGER], [stageId, '\uffff', Number.MAX_SAFE_INTEGER])
        : IDBKeyRange.only(stageId);
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || removed >= limit) return resolve({ removed, hasMore: Boolean(cursor) });
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
    });
    await transactionDone(tx);
    return result;
  } finally { db.close(); }
};

export async function beginP6BrowserSpeedMigration() {
  if (isNativePlatform()) throw new Error('E4_BROWSER_ONLY');
  return runSpeedKnowledgeStoreExclusive(SPEED_KNOWLEDGE_STORAGE_KEY, async () => {
    if ((await readP6BrowserSpeedAuthority()).version === 2) return { state: 'ALREADY_V2' };
    const selected = await explicitPredecessorSource();
    if (!selected) return { state: 'NO_LEGACY_SOURCE', legacyAuthorityPreserved: true };
    const fingerprint = await p6Fingerprint(selected.wrapper);
    const stageId = p6MutationLeaseId();
    const db = await openDb();
    try {
      const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
      const store = tx.objectStore(P6_SPEED_STORES.CONTROL);
      const activeMutation = await new Promise((resolve, reject) => {
        const request = store.openCursor(IDBKeyRange.bound('mutation:', 'mutation:\uffff'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(Boolean(request.result));
      });
      if (activeMutation) {
        tx.abort();
        return { state: 'WAITING_FOR_OWNER' };
      }
      store.put({
        key: P6_SPEED_E4_FENCE_KEY, state: 'CONVERSION_IN_PROGRESS', stageId,
        sourceId: selected.sourceId, sourceFingerprint: fingerprint,
        sourceKeyVersion: Math.max(0, Number(selected.wrapper?.key_version) || 0),
        publicationVersion: Date.now(), cursor: null, updatedAt: Date.now(),
      });
      await transactionDone(tx);
    } finally { db.close(); }
    return { state: 'CONVERSION_IN_PROGRESS', stageId, sourceId: selected.sourceId, sourceFingerprint: fingerprint };
  });
}

const p6DecodeE4Source = async (fence) => {
  if (e4SourceCache.has(fence.sourceFingerprint)) return e4SourceCache.get(fence.sourceFingerprint);
  const selected = await explicitPredecessorSource();
  if (!selected || selected.sourceId !== fence.sourceId || await p6Fingerprint(selected.wrapper) !== fence.sourceFingerprint) {
    const error = new Error('E4_PREDECESSOR_CHANGED'); error.code = 'E4_PREDECESSOR_CHANGED'; throw error;
  }
  const decoded = isEncryptedPayload(selected.wrapper)
    ? await decryptSensitiveValue(selected.wrapper, selected.context)
    : selected.wrapper;
  e4SourceCache.set(fence.sourceFingerprint, decoded);
  return decoded;
};

/**
 * AUD-007 REDESIGN: re-encrypts rows and commits them, so the pair is ONE publication.
 * The module-level rule was satisfied by other admitted functions in the same file
 * while this one encrypted outside admission entirely.
 */
export async function stepP6BrowserSpeedMigration() {
  return withDurableKeyPublication(async () => {
  const fence = await p6SpeedControl(P6_SPEED_E4_FENCE_KEY);
  if (!fence || fence.state !== 'CONVERSION_IN_PROGRESS') return { state: fence?.state || 'NOT_STARTED', done: fence?.state === 'COMPLETE', itemsWorked: 0, bytesWorked: 0 };
  const source = await p6DecodeE4Source(fence);
  const { buckets, root } = p6Bucketize(source);
  const ids = [...buckets.keys()].sort();
  const offset = Math.max(0, Number(fence.cursor?.bucketOffset) || 0);
  if (offset < ids.length) {
    const bucketId = ids[offset];
    const result = await p6WriteStageBucket({
      stageId: fence.stageId, publicationVersion: fence.publicationVersion, bucketId,
      document: buckets.get(bucketId), commitState: 'COMMITTED',
    });
    const db = await openDb();
    try {
      const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
      tx.objectStore(P6_SPEED_STORES.CONTROL).put({ ...fence, cursor: { bucketOffset: offset + 1 }, updatedAt: Date.now() });
      await transactionDone(tx);
    } finally { db.close(); }
    return { state: 'CONVERSION_IN_PROGRESS', cursor: { bucketOffset: offset + 1 }, itemsWorked: result.itemsWorked + 1, bytesWorked: result.proposedBytes, done: false };
  }
  const rootPayload = await encryptSensitiveValue(root, `p6:speed-v2:${fence.stageId}:__global__:${fence.publicationVersion}:0`);
  await requireBrowserP6DerivedStorage(p6JsonBytes(rootPayload));
  // The frozen rule is reselection, not a reread of the fenced kind: run the
  // whole WAL > IndexedDB > Preferences precedence again and require the same
  // selected kind as well as the same bytes and key version. Rereading only the
  // fenced source missed the case that matters most - a v1 write during
  // conversion is refused by the writer fence and falls back to the write-ahead
  // key, which then becomes the newest predecessor. The fenced IndexedDB value
  // is still byte-identical, so a same-kind reread would convert the stale model
  // and drop the user's newer correction at cutover.
  const reselected = await explicitPredecessorSource();
  const rereadWrapper = reselected?.wrapper ?? null;
  if (!rereadWrapper
    || reselected.sourceId !== fence.sourceId
    || await p6Fingerprint(rereadWrapper) !== fence.sourceFingerprint
    || Math.max(0, Number(rereadWrapper?.key_version) || 0) !== fence.sourceKeyVersion) {
    return { state: 'E4_PREDECESSOR_CHANGED', done: false, itemsWorked: 1, bytesWorked: p6JsonBytes(rereadWrapper) };
  }
  await publishP6BrowserSpeedGeneration({
    stageId: fence.stageId,
    publicationVersion: fence.publicationVersion,
    root,
    rootPayload,
    sourceFingerprint: fence.sourceFingerprint,
    sourceKeyVersion: fence.sourceKeyVersion,
    completeFence: fence,
  });
  e4SourceCache.delete(fence.sourceFingerprint);
  return { state: 'COMPLETE', done: true, itemsWorked: 2, bytesWorked: p6JsonBytes(rootPayload) };

  });
}

/**
 * Remove one bounded page of an abandoned E4 stage. The durable phase belongs
 * to the foreground operation, so process death never requires an unbounded
 * cleanup loop and the writer fence remains installed until all staged rows
 * are gone.
 */
export async function cancelP6BrowserSpeedMigrationTurn({ phase = 'PARTITIONS' } = {}) {
  const fence = await p6SpeedControl(P6_SPEED_E4_FENCE_KEY);
  if (!fence || fence.state === 'CANCELLED') {
    return { state: 'CANCELLED', done: true, cursor: null, itemsWorked: 0, bytesWorked: 0 };
  }
  if (fence.state === 'COMPLETE') {
    return { state: 'COMPLETE', done: true, cursor: null, itemsWorked: 0, bytesWorked: 0 };
  }
  if (phase === 'PARTITIONS') {
    const result = await deleteStageRowsTurn(P6_SPEED_STORES.PARTITIONS, fence.stageId);
    return {
      state: 'CANCEL_REQUESTED', done: false,
      cursor: { phase: result.hasMore ? 'PARTITIONS' : 'EDITOR_INDEX' },
      itemsWorked: result.removed, bytesWorked: 0,
    };
  }
  if (phase === 'EDITOR_INDEX') {
    const result = await deleteStageRowsTurn(P6_SPEED_STORES.EDITOR_INDEX, fence.stageId);
    return {
      state: 'CANCEL_REQUESTED', done: false,
      cursor: { phase: result.hasMore ? 'EDITOR_INDEX' : 'CONTROL' },
      itemsWorked: result.removed, bytesWorked: 0,
    };
  }
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.CONTROL, P6_SPEED_STORES.STAGES], 'readwrite');
    tx.objectStore(P6_SPEED_STORES.CONTROL).put({
      ...fence, state: 'CANCELLED', cursor: null, updatedAt: Date.now(),
    });
    tx.objectStore(P6_SPEED_STORES.STAGES).delete(fence.stageId);
    await transactionDone(tx);
  } finally { db.close(); }
  e4SourceCache.delete(fence.sourceFingerprint);
  return { state: 'CANCELLED', done: true, cursor: null, itemsWorked: 2, bytesWorked: 0 };
}

const p6VisibleBucketBinding = async (bucketId, authority = null) => {
  const active = authority || await readP6BrowserSpeedAuthority();
  if (active.version !== 2) return null;
  const db = await openDb();
  try {
    const tx = db.transaction(P6_SPEED_STORES.MANIFESTS, 'readonly');
    const manifest = await requestResult(tx.objectStore(P6_SPEED_STORES.MANIFESTS).get(bucketId));
    if (manifest?.state === 'COMMITTED') return manifest;
  } finally { db.close(); }
  return { bucketId, stageId: active.stageId, publicationVersion: active.publicationVersion };
};

const p6ReadV2Bucket = async (bucketId, authority = null) => {
  const binding = await p6VisibleBucketBinding(bucketId, authority);
  if (!binding) return null;
  const db = await openDb();
  let rows;
  try {
    const tx = db.transaction(P6_SPEED_STORES.PARTITIONS, 'readonly');
    const index = tx.objectStore(P6_SPEED_STORES.PARTITIONS).index('by_bucket_publication');
    rows = await new Promise((resolve, reject) => {
      const found = [];
      const request = index.openCursor(IDBKeyRange.bound(
        [bucketId, binding.publicationVersion, 0],
        [bucketId, binding.publicationVersion, Number.MAX_SAFE_INTEGER]
      ));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(found);
        if (cursor.value.stageId === binding.stageId && cursor.value.commitState === 'COMMITTED') found.push(cursor.value);
        cursor.continue();
      };
    });
  } finally { db.close(); }
  rows.sort((a, b) => a.ordinal - b.ordinal);
  const merged = p6EmptyPartition();
  for (const row of rows) {
    const value = await decryptSensitiveValue(row.payload,
      `p6:speed-v2:${row.stageId}:${bucketId}:${row.publicationVersion}:${row.ordinal}`);
    Object.assign(merged.cells, value?.cells || {});
    merged.corrections.push(...(value?.corrections || []));
    merged.excludedSections.push(...(value?.excludedSections || []));
    merged.roadMemory.candidates.push(...(value?.roadMemory?.candidates || []));
  }
  return merged;
};

export const readP6BrowserSpeedBuckets = async (geohashes = []) => {
  const authority = await readP6BrowserSpeedAuthority();
  if (authority.version !== 2) return null;
  // Global is stored as an arbitrary root object rather than a bucket shape.
  const db = await openDb();
  let root = {};
  try {
    const tx = db.transaction(P6_SPEED_STORES.PARTITIONS, 'readonly');
    const record = await requestResult(tx.objectStore(P6_SPEED_STORES.PARTITIONS)
      .get(`${authority.stageId}:__global__:0`));
    if (record?.commitState === 'COMMITTED') root = await decryptSensitiveValue(record.payload,
      `p6:speed-v2:${record.stageId}:__global__:${record.publicationVersion}:0`);
  } finally { db.close(); }
  const out = { ...root, cells: {}, corrections: [], excludedSections: [], roadMemory: { ...(root.roadMemory || {}), candidates: [] } };
  const buckets = [...new Set((geohashes || []).map((value) => String(value).slice(0, 4).toLowerCase()).filter(Boolean))];
  for (const bucketId of buckets) {
    const value = await p6ReadV2Bucket(bucketId, authority);
    if (!value) continue;
    Object.assign(out.cells, value.cells || {});
    out.corrections.push(...(value.corrections || []));
    out.excludedSections.push(...(value.excludedSections || []));
    out.roadMemory.candidates.push(...(value.roadMemory?.candidates || []));
  }
  return normalizeSpeedKnowledgeMetadata(out);
};

const p6PublishScopedBuckets = async (value, geohashes = []) => {
  const authority = await readP6BrowserSpeedAuthority();
  if (authority.version !== 2) return false;
  const scope = [...new Set((geohashes || []).map((item) => String(item).slice(0, 4).toLowerCase()).filter(Boolean))];
  if (!scope.length) {
    const error = new Error('BROWSER_V2_SCOPED_WRITE_REQUIRED'); error.code = error.message; throw error;
  }
  const { buckets } = p6Bucketize(value);
  const stageId = p6MutationLeaseId();
  const publicationVersion = Date.now();
  const results = [];
  for (const bucketId of scope) {
    try {
      results.push(await p6PrepareStageBucket({
        stageId, publicationVersion, bucketId, document: buckets.get(bucketId) || p6EmptyPartition(),
      }));
    } catch (error) {
      if (error?.code === P6_READINESS_STATES.CAPACITY_BLOCKED) {
        error.bucketId = bucketId;
        error.stageId = stageId;
        error.publicationVersion = publicationVersion;
      }
      throw error;
    }
  }
  const derivedBytes = results.reduce((sum, result) => sum + result.derivedBytes, 0);
  if (derivedBytes > 0) await requireBrowserP6DerivedStorage(derivedBytes);
  // One page may touch several prefix-4 buckets. Stage every prepared row in a
  // single transaction so database opens stay constant per bounded page.
  const stageDb = await openDb();
  try {
    const stage = stageDb.transaction([
      P6_SPEED_STORES.PARTITIONS, P6_SPEED_STORES.EDITOR_INDEX,
    ], 'readwrite');
    const partitions = stage.objectStore(P6_SPEED_STORES.PARTITIONS);
    const editor = stage.objectStore(P6_SPEED_STORES.EDITOR_INDEX);
    results.forEach((result) => {
      result.partitionRows.forEach((row) => partitions.put(row));
      result.editorRows.forEach((row) => editor.put(row));
    });
    await transactionDone(stage);
  } finally { stageDb.close(); }
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.MANIFESTS, P6_SPEED_STORES.PARTITIONS,
      P6_SPEED_STORES.EDITOR_INDEX], 'readwrite');
    const manifests = tx.objectStore(P6_SPEED_STORES.MANIFESTS);
    const partitions = tx.objectStore(P6_SPEED_STORES.PARTITIONS);
    const editor = tx.objectStore(P6_SPEED_STORES.EDITOR_INDEX);
    scope.forEach((bucketId, index) => {
      results[index].partitionRows.forEach((row) => partitions.put({ ...row, commitState: 'COMMITTED' }));
      results[index].editorRows.forEach((row) => editor.put({ ...row, commitState: 'COMMITTED' }));
      manifests.put({ bucketId, stageId, publicationVersion, partitionCount: results[index].partitions,
        state: 'COMMITTED', updatedAt: Date.now() });
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return true;
};

export async function queryP6BrowserSpeedEditorItems({ kind, cursor = '', maxItems = 50, filter = '', activeOnly = false } = {}) {
  const authority = await readP6BrowserSpeedAuthority();
  if (authority.version !== 2) return null;
  const maximum = Math.max(1, Math.min(100, Number(maxItems) || 50));
  let decodedCursor = null;
  try { decodedCursor = cursor ? JSON.parse(String(cursor)) : null; } catch { decodedCursor = { identity: String(cursor) }; }
  const lower = String(decodedCursor?.identity || '');
  const exactEvidenceIdentity = kind === 'evidence' && String(filter || '').trim()
    ? String(filter).trim()
    : null;
  const scanLimit = exactEvidenceIdentity ? maximum : Math.max(128, maximum * 4);
  const db = await openDb();
  let rows;
  try {
    const tx = db.transaction(P6_SPEED_STORES.EDITOR_INDEX, 'readonly');
    const index = tx.objectStore(P6_SPEED_STORES.EDITOR_INDEX).index('by_kind_identity');
    rows = await new Promise((resolve, reject) => {
      const found = [];
      const range = exactEvidenceIdentity
        ? IDBKeyRange.only([kind, exactEvidenceIdentity])
        : IDBKeyRange.bound([kind, lower], [kind, '\uffff'], Boolean(lower), false);
      const request = index.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const item = request.result;
        if (!item || found.length >= scanLimit + 1) return resolve(found);
        if (decodedCursor?.key && item.value.identity === decodedCursor.identity && item.primaryKey <= decodedCursor.key) {
          item.continue();
          return;
        }
        found.push({ ...item.value, __p6PrimaryKey: item.primaryKey }); item.continue();
      };
    });
  } finally { db.close(); }
  // Resolve every distinct bucket in this page with one database open. The
  // editor row is only an index hint; visibility still comes from the current
  // manifest/authority binding and encrypted partition rows.
  const pageRows = rows.slice(0, scanLimit);
  const bucketIds = [...new Set(pageRows.map((row) => String(row.bucketId || '')).filter(Boolean))];
  const bucketCache = new Map();
  if (bucketIds.length) {
    const bucketDb = await openDb();
    try {
      const tx = bucketDb.transaction([P6_SPEED_STORES.MANIFESTS, P6_SPEED_STORES.PARTITIONS], 'readonly');
      const manifests = tx.objectStore(P6_SPEED_STORES.MANIFESTS);
      const partitions = tx.objectStore(P6_SPEED_STORES.PARTITIONS).index('by_bucket_publication');
      const reads = bucketIds.map((bucketId) => {
        const manifestPromise = requestResult(manifests.get(bucketId));
        const rowsPromise = new Promise((resolve, reject) => {
          const found = [];
          const request = partitions.openCursor(IDBKeyRange.bound(
            [bucketId, Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
            [bucketId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
          ));
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const item = request.result;
            if (!item) { resolve(found); return; }
            found.push(item.value); item.continue();
          };
        });
        return Promise.all([manifestPromise, rowsPromise]).then(([manifest, partitionRows]) => ({
          bucketId, manifest, partitionRows,
        }));
      });
      const resolved = await Promise.all(reads);
      for (const { bucketId, manifest, partitionRows } of resolved) {
        const binding = manifest?.state === 'COMMITTED'
          ? manifest
          : { bucketId, stageId: authority.stageId, publicationVersion: authority.publicationVersion };
        const visibleRows = partitionRows.filter((row) => row.commitState === 'COMMITTED'
          && row.stageId === binding.stageId
          && Number(row.publicationVersion) === Number(binding.publicationVersion))
          .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
        const merged = p6EmptyPartition();
        for (const row of visibleRows) {
          const value = await decryptSensitiveValue(row.payload,
            `p6:speed-v2:${row.stageId}:${bucketId}:${row.publicationVersion}:${row.ordinal}`);
          Object.assign(merged.cells, value?.cells || {});
          merged.corrections.push(...(value?.corrections || []));
          merged.excludedSections.push(...(value?.excludedSections || []));
          merged.roadMemory.candidates.push(...(value?.roadMemory?.candidates || []));
        }
        bucketCache.set(bucketId, { binding, value: merged });
      }
    } finally { bucketDb.close(); }
  }
  const items = [];
  const needle = String(filter || '').toLowerCase();
  let examined = 0;
  let lastExamined = null;
  for (const row of pageRows) {
    examined += 1;
    lastExamined = row;
    if (row.commitState !== 'COMMITTED') continue;
    const cached = bucketCache.get(row.bucketId);
    const binding = cached?.binding;
    if (!binding || binding.stageId !== row.stageId || binding.publicationVersion !== row.publicationVersion) continue;
    const bucket = cached.value;
    const candidates = row.kind === 'correction' ? bucket.corrections
      : row.kind === 'exclusion' ? bucket.excludedSections
        : ['candidate', 'evidence'].includes(row.kind) ? bucket.roadMemory.candidates
          : Object.entries(bucket.cells || {}).map(([geohash, cell]) => ({ geohash, ...cell }));
    const match = candidates.find((item) => row.kind === 'evidence'
      ? (item?.p6AutomaticEvidence?.receiptedEvidence || [])
        .some((receipt) => String(receipt?.sourceIdentity || '') === row.identity)
      : Object.values(item || {}).some((value) => String(value) === row.identity));
    if (match && (!needle || JSON.stringify(match).toLowerCase().includes(needle)) && (!activeOnly || match.active === true)) items.push(match);
    if (items.length >= maximum) break;
  }
  const hasMore = rows.length > scanLimit || (items.length >= maximum && examined < rows.length);
  const result = {
    items, itemCount: items.length,
    nextCursor: hasMore && lastExamined
      ? JSON.stringify({ identity: lastExamined.identity, key: lastExamined.__p6PrimaryKey })
      : null,
    examinedCount: examined,
    bounded: true,
  };
  // The disposition owner immediately needs the same decrypted buckets. Keep
  // this non-enumerable so UI/editor callers retain their public page shape,
  // while one provenance page never reopens and decrypts each bucket again.
  Object.defineProperty(result, 'resolvedBuckets', {
    value: new Map([...bucketCache].map(([bucketId, cached]) => [bucketId, cached.value])),
    enumerable: false,
  });
  return result;
}

const p6ListV2BucketIds = async ({ after = '', limit = 32 } = {}) => {
  const authority = await readP6BrowserSpeedAuthority();
  if (authority.version !== 2) return { items: [], nextCursor: null };
  const baseFound = new Set();
  const manifestFound = new Set();
  const db = await openDb();
  try {
    const tx = db.transaction([P6_SPEED_STORES.PARTITIONS, P6_SPEED_STORES.MANIFESTS], 'readonly');
    const index = tx.objectStore(P6_SPEED_STORES.PARTITIONS).index('by_stage');
    const baseRead = new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.bound(
        [authority.stageId, String(after || ''), 0],
        [authority.stageId, '\uffff', Number.MAX_SAFE_INTEGER],
        Boolean(after), false
      ));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || baseFound.size >= limit + 1) return resolve();
        if (cursor.value.bucketId !== '__global__' && cursor.value.commitState === 'COMMITTED') baseFound.add(cursor.value.bucketId);
        cursor.continue();
      };
    });
    const manifestRead = new Promise((resolve, reject) => {
      const request = tx.objectStore(P6_SPEED_STORES.MANIFESTS).openCursor(
        String(after || '') ? IDBKeyRange.lowerBound(String(after), true) : null
      );
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || manifestFound.size >= limit + 1) return resolve();
        if (cursor.value?.state === 'COMMITTED') manifestFound.add(String(cursor.value.bucketId));
        cursor.continue();
      };
    });
    await Promise.all([baseRead, manifestRead]);
  } finally { db.close(); }
  const values = [...new Set([...baseFound, ...manifestFound])].sort();
  return { items: values.slice(0, limit), nextCursor: values.length > limit ? values[limit - 1] : null };
};

export async function migrateLegacySpeedKnowledgeExplicitly() {
  if (!isNativePlatform()) throw new Error('PRDE-1 is Android-only');
  const selected = await explicitPredecessorSource();
  if (!selected) return { state: 'NO_LEGACY_SOURCE', legacyAuthorityPreserved: true };
  if (!isEncryptedPayload(selected.wrapper) || typeof selected.wrapper.ciphertext !== 'string') {
    throw new Error('PRDE1_ENCRYPTED_PREDECESSOR_REQUIRED');
  }
  const ciphertext = selected.wrapper.ciphertext;
  const started = await nativeTripArchive.beginLegacySpeedMigration({
    sourceId: selected.sourceId,
    sourceContext: selected.context,
    sourceCiphertextHash: '',
    sourceRevision: 0,
    keyVersion: Math.max(0, Number(selected.wrapper.key_version) || 0),
    expectedCiphertextBytes: decodedBase64Bytes(ciphertext),
  });
  if (started.state === 'LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE') {
    await setJson(NATIVE_BUCKET_MIGRATION_KEY, started);
    return started;
  }
  const base64Slice = 256 * 1024;
  let chunkIndex = Number(started.nextChunkIndex) || 0;
  for (let offset = chunkIndex * base64Slice; offset < ciphertext.length; offset += base64Slice) {
    const slice = ciphertext.slice(offset, Math.min(ciphertext.length, offset + base64Slice));
    await nativeTripArchive.appendLegacySpeedCiphertext({
      operationId: started.operationId,
      chunkIndex,
      chunkBase64: slice,
    });
    chunkIndex += 1;
  }
  const nativeResult = await nativeTripArchive.executeLegacySpeedMigration(started.operationId);
  if (nativeResult?.state !== 'VERIFIED') {
    await setJson(NATIVE_BUCKET_MIGRATION_KEY, nativeResult);
    return nativeResult;
  }
  // The native verifier proves the staged ciphertext and target buckets. Before
  // allowing authority cutover, independently prove that the selected legacy
  // source is still readable and byte-identical. This comparison does not
  // decrypt or parse the predecessor and the second wrapper is released here.
  let reread = await rereadExplicitPredecessor(selected.sourceId);
  const sourceStillReadable = isEncryptedPayload(reread) &&
    reread.key_version === selected.wrapper.key_version &&
    reread.ciphertext === ciphertext;
  reread = null;
  const result = {
    ...nativeResult,
    sourceStillReadable,
    sourceCiphertextByteIdentical: sourceStillReadable,
    authorityFlipEligible: nativeResult.authorityFlipEligible === true && sourceStillReadable,
  };
  await setJson(NATIVE_BUCKET_MIGRATION_KEY, result);
  if (!sourceStillReadable) throw new Error('PRDE1_SOURCE_CHANGED_BEFORE_AUTHORITY_FLIP');
  return result;
}

const nativeSpeedAuthorityReady = async () => {
  if (!isNativePlatform() || !P35_NATIVE_AUTHORITY_ENABLED) return false;
  const [nativeStatus, verifiedStatus] = await Promise.all([
    nativeTripArchive.legacySpeedMigrationStatus().catch(() => null),
    getJson(NATIVE_BUCKET_MIGRATION_KEY, null).catch(() => null),
  ]);
  return nativeStatus?.state === 'VERIFIED' &&
    nativeStatus?.authorityFlipEligible === true &&
    verifiedStatus?.operationId === nativeStatus?.operationId &&
    verifiedStatus?.sourceCiphertextByteIdentical === true &&
    verifiedStatus?.authorityFlipEligible === true;
};

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

const cellBounds = (geohash) => {
  const hash = String(geohash || '').toLowerCase();
  if (!hash || hash.length > 12) return null;
  let even = true;
  const latitude = [-90, 90];
  const longitude = [-180, 180];
  for (const character of hash) {
    const value = GEOHASH_ALPHABET.indexOf(character);
    if (value < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const range = even ? longitude : latitude;
      const midpoint = (range[0] + range[1]) / 2;
      if ((value & (1 << bit)) !== 0) range[0] = midpoint;
      else range[1] = midpoint;
      even = !even;
    }
  }
  return {
    south: latitude[0],
    west: longitude[0],
    north: latitude[1],
    east: longitude[1],
  };
};

const exclusionBounds = (section = {}) => {
  const points = [
    ...(Array.isArray(section?.sectionPoints) ? section.sectionPoints : []),
    section,
  ].map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (points.length) {
    const south = Math.min(...points.map((point) => point.lat));
    const north = Math.max(...points.map((point) => point.lat));
    const west = Math.min(...points.map((point) => point.lng));
    const east = Math.max(...points.map((point) => point.lng));
    const latitudePad = 0.045 / 111;
    const cosine = Math.max(0.1, Math.cos(((south + north) / 2) * Math.PI / 180));
    const longitudePad = 0.045 / (111 * cosine);
    return {
      south: south - latitudePad,
      west: west - longitudePad,
      north: north + latitudePad,
      east: east + longitudePad,
    };
  }
  return cellBounds(section?.geohash);
};

const boundsOverlap = (left, right) => Boolean(left && right) &&
  left.south <= right.north && left.north >= right.south &&
  left.west <= right.east && left.east >= right.west;

const nativeTracedSectionPoints = (record = {}) => (
  (Array.isArray(record?.sectionPoints) ? record.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
      point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180 &&
      !(Math.abs(point.lat) < 0.001 && Math.abs(point.lng) < 0.001))
);

const cellOverlapsExcludedSection = (geohash, exclusions = []) => {
  const bounds = cellBounds(geohash);
  if (!bounds) return true;
  return (Array.isArray(exclusions) ? exclusions : []).some((section) => (
    boundsOverlap(bounds, exclusionBounds(section))
  ));
};

const eligibleNativeCell = (geohash, cell, value, nowMs = Date.now()) => {
  const eligibility = speedKnowledgeCellEligibility(cell, nowMs);
  return Boolean(cellBounds(geohash)) &&
    eligibility.eligible &&
    !cellOverlapsExcludedSection(geohash, value?.excludedSections);
};

const nativeCellsMirror = (value, nowMs = Date.now()) => Object.fromEntries(
  Object.entries(value?.cells && typeof value.cells === 'object' ? value.cells : {})
    .filter(([geohash, cell]) => eligibleNativeCell(geohash, cell, value, nowMs))
    .map(([geohash, cell]) => [geohash, {
      limitKmh: Number(cell.limitKmh),
      source: String(cell.source),
      confidence: speedKnowledgeCellConfidence(cell),
      verifiedAt: cell?.verifiedAt,
      lastVerifiedAt: cell?.lastVerifiedAt,
      appliedAt: cell?.appliedAt,
      lastUpdatedAt: cell?.lastUpdatedAt,
      expiresAt: cell?.expiresAt,
      verificationStatus: cell?.verificationStatus,
      evidenceCount: Number(cell?.evidenceCount) || 0,
      tripCount: Number(cell?.tripCount) || 0,
      tripEvidenceIds: [...new Set(
        (Array.isArray(cell?.tripEvidenceIds) ? cell.tripEvidenceIds : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )].slice(-100),
      conflict: false,
    }])
);

const nativeSpeedKnowledgeMirror = (value) => ({
  resolverContractVersion: 1,
  schemaVersion: Number(value?.schemaVersion) || SPEED_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeRevision: normalizedRevision(value),
  knowledgeUpdatedAt: value?.knowledgeUpdatedAt || null,
  cells: nativeCellsMirror(value),
  excludedSections: Array.isArray(value?.excludedSections)
    ? value.excludedSections.map((section) => ({
      id: section?.id,
      geohash: section?.geohash,
      lat: section?.lat,
      lng: section?.lng,
      reason: section?.reason,
      directionMode: section?.directionMode || 'both',
      directionBearing: section?.directionBearing,
      sectionPoints: Array.isArray(section?.sectionPoints)
        ? section.sectionPoints.map((point) => ({ lat: point?.lat, lng: point?.lng }))
        : undefined,
    }))
    : [],
  corrections: Array.isArray(value?.corrections)
    ? value.corrections
      .filter((correction) => (
        Number(correction?.limitKmh) > 0 &&
        Number(correction.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH &&
        nativeTracedSectionPoints(correction).length >= 2
      ))
      .map((correction) => ({
      id: correction?.id,
      ruleId: correction?.ruleId,
      geohash: correction?.geohash,
      lat: correction?.lat,
      lng: correction?.lng,
      coordinateSource: correction?.coordinateSource,
      limitKmh: Number(correction?.limitKmh),
      source: correction?.source,
      appliedAt: correction?.appliedAt,
      validFrom: correction?.validFrom ?? correction?.valid_from,
      expiresAt: correction?.expiresAt,
      qualifierStatus: correction?.qualifierStatus,
      directionMode: correction?.directionMode,
      directionBearing: correction?.directionBearing,
      timeRule: correction?.timeRule,
      sectionPoints: nativeTracedSectionPoints(correction),
    }))
    : [],
  roadMemory: {
    version: 3,
    candidates: Array.isArray(value?.roadMemory?.candidates)
      ? decorateRoadMemoryCandidates(value.roadMemory.candidates).candidates
        .filter((candidate) => candidate.canAffectScoreAndAlerts === true &&
          Number(candidate?.limitKmh) > 0 &&
          Number(candidate.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH &&
          nativeTracedSectionPoints(candidate).length >= 2)
        .map((candidate) => ({
          id: candidate?.id,
          geohash: candidate?.geohash,
          lat: candidate?.lat,
          lng: candidate?.lng,
          limitKmh: Number(candidate?.limitKmh),
          source: 'local_road_memory',
          confidence: candidate?.calibratedConfidence,
          evidenceConfidence: candidate?.evidenceConfidence,
          confidenceCalibrationFactor: Number(candidate?.effectiveConfidence) > 0
            ? Math.max(0, Math.min(1,
              Number(candidate?.calibratedConfidence) / Number(candidate.effectiveConfidence)
            ))
            : 0,
          canAffectScoreAndAlerts: true,
          tripCount: candidate?.tripCount,
          agreement: candidate?.agreement,
          lastObservedAt: candidate?.lastObservedAt,
          directionMode: candidate?.directionMode,
          directionBearing: candidate?.directionBearing,
          stage: 'operational',
          active: true,
          intelligenceValidated: true,
          timeProfilesAcceptedAt: candidate?.timeProfilesAcceptedAt ||
            (candidate?.reviewState === 'time_profiles_accepted' ? candidate?.reviewedAt : null),
          timeProfiles: (
            candidate?.timeProfilesAcceptedAt || candidate?.reviewState === 'time_profiles_accepted'
          ) && Array.isArray(candidate?.timeProfiles)
            ? candidate.timeProfiles
              .filter((profile) => profile?.eligible === true &&
                Number(profile?.limitKmh) > 0 && Number(profile.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH)
              .map((profile) => ({
                bucket: profile?.bucket,
                limitKmh: Number(profile?.limitKmh),
                tripCount: profile?.tripCount,
                agreement: profile?.agreement,
                eligible: true,
              }))
            : [],
          sectionPoints: nativeTracedSectionPoints(candidate),
        }))
      : [],
  },
});

const locationEmptySpeedKnowledge = (value = {}) => ({
  schemaVersion: Number(value?.schemaVersion) || SPEED_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeRevision: normalizedRevision(value),
  knowledgeUpdatedAt: value?.knowledgeUpdatedAt || null,
  cells: {},
  excludedSections: [],
  corrections: [],
  roadMemory: { version: 3, candidates: [] },
});

const privacyFilteredNativeKnowledge = async (value) => {
  const [{ getHydratedPrivacyZones }, { purgeSpeedKnowledgeDataForPrivacyZones }] = await Promise.all([
    import('@/lib/privacyZones'),
    import('@/lib/speedKnowledgePrivacy'),
  ]);
  const zones = await getHydratedPrivacyZones();
  if (!Array.isArray(zones)) throw new Error('Privacy-zone hydration returned invalid data');
  const filtered = purgeSpeedKnowledgeDataForPrivacyZones(value, zones);
  if (!filtered?.data || typeof filtered.data !== 'object') {
    throw new Error('Privacy-zone speed filter returned invalid data');
  }
  return filtered.data;
};

const replaceNativeSpeedKnowledgeMirror = async (value) => {
  // Removing first is intentional: if encryption or Preferences fails while
  // writing the replacement, Android must see no saved-road geometry instead
  // of continuing to use a stale mirror that may now overlap a privacy zone.
  await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
  await setEncryptedJson(
    SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
    nativeSpeedKnowledgeMirror(value)
  );
};

const syncNativeSpeedKnowledgeMirror = async (_key, value) => {
  if (!isNativePlatform()) {
    await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
    nativeMirrorStatus = { state: 'not_applicable', syncedAt: 0, error: '' };
    return;
  }
  // Write a native-readable one-way marker before the mirror can ever be
  // removed. Android uses legacy storage only on a proven pre-mirror upgrade;
  // once initialized, an absent mirror means fail closed, not "fall back".
  try {
    await setJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
  } catch (error) {
    // Keep the existing mirror and legacy value intact when the guard itself
    // cannot be persisted. Reporting the failure prevents a stale "synced"
    // UI state while still preserving the safe upgrade path.
    nativeMirrorStatus = {
      state: 'error',
      syncedAt: 0,
      error: error?.message || 'Native speed mirror migration marker failed',
    };
    logSystemFailure('speed_knowledge_native_mirror_marker', error, {
      key: SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
    });
    throw error;
  }
  try {
    let privacySafeValue;
    try {
      privacySafeValue = await privacyFilteredNativeKnowledge(value);
    } catch (privacyError) {
      // Never leave an older location-bearing mirror in place when current
      // privacy zones cannot be loaded or evaluated. The web store remains
      // intact and can repopulate the mirror after privacy filtering recovers.
      await replaceNativeSpeedKnowledgeMirror(locationEmptySpeedKnowledge(value));
      nativeMirrorStatus = {
        state: 'privacy_blocked',
        syncedAt: Date.now(),
        error: privacyError?.message || 'Native speed privacy filter failed',
      };
      logSystemFailure('speed_knowledge_native_privacy_filter', privacyError, {
        key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      });
      return;
    }
    await replaceNativeSpeedKnowledgeMirror(privacySafeValue);
    nativeMirrorStatus = { state: 'synced', syncedAt: Date.now(), error: '' };
  } catch (error) {
    // A failed write can be ambiguous on platform storage (for example, the
    // value may have been partially committed before the bridge rejected).
    // A second removal keeps background resolution fail-closed.
    await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY).catch((removalError) => {
      logSystemFailure('speed_knowledge_native_mirror_fail_closed_remove', removalError, {
        key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      });
    });
    nativeMirrorStatus = {
      state: 'error',
      syncedAt: 0,
      error: error?.message || 'Native speed mirror failed',
    };
    throw error;
  }
};

let nativeMirrorStatus = {
  state: 'unknown',
  syncedAt: 0,
  error: '',
};

export const getNativeSpeedKnowledgeMirrorStatus = () => ({ ...nativeMirrorStatus });

const syncNativeMirrorWithoutBlockingCanonicalMigration = async (value, phase) => {
  try {
    await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, value);
    return true;
  } catch (error) {
    // IndexedDB is the canonical in-app store. Native mirror availability is
    // reported independently and must never make valid canonical data unreadable.
    logSystemFailure('speed_knowledge_native_mirror_migration', error, {
      key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      phase,
    });
    return false;
  }
};

export const migrateSpeedKnowledgeToIndexedDb = async () => {
  if (!canUseIndexedDb()) return false;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const indexedValue = await readIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY);
      if (indexedValue != null) {
        const normalizedValue = normalizeSpeedKnowledgeMetadata(indexedValue);
        if (
          Number(indexedValue.schemaVersion) !== normalizedValue.schemaVersion ||
          Number(indexedValue.knowledgeRevision) !== normalizedValue.knowledgeRevision
        ) {
          await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, normalizedValue);
        }
        const mirrorSynced = await syncNativeMirrorWithoutBlockingCanonicalMigration(
          normalizedValue,
          'existing_indexeddb'
        );
        // Keep the legacy value available for an older native runtime until
        // the migration marker and replacement mirror are both safely stored.
        if (mirrorSynced) await removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY);
        return false;
      }
      const legacyStoredValue = await getJson(SPEED_KNOWLEDGE_STORAGE_KEY, null);
      const legacyValue = isEncryptedPayload(legacyStoredValue)
        ? await decryptSensitiveValue(
          legacyStoredValue,
          `storage:${SPEED_KNOWLEDGE_STORAGE_KEY}`
        )
        : legacyStoredValue;
      if (legacyValue == null) {
        const emptyValue = normalizeSpeedKnowledgeMetadata({ cells: {}, corrections: [] });
        await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, emptyValue);
        await syncNativeMirrorWithoutBlockingCanonicalMigration(emptyValue, 'new_empty_indexeddb');
        return false;
      }
      const migratedValue = normalizeSpeedKnowledgeMetadata(legacyValue);
      await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, migratedValue);
      const mirrorSynced = await syncNativeMirrorWithoutBlockingCanonicalMigration(
        migratedValue,
        'legacy_to_indexeddb'
      );
      if (mirrorSynced) await removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY);
      recordSystemEvent('speed_knowledge_indexeddb_migrated', {
        cell_count: Object.keys(legacyValue.cells || {}).length,
        correction_count: Array.isArray(legacyValue.corrections) ? legacyValue.corrections.length : 0,
      }, {
        category: 'storage',
        title: 'Saved road speeds migrated',
      });
      return true;
    })().catch((error) => {
      migrationPromise = null;
      logSystemFailure('speed_knowledge_indexeddb_migration', error);
      throw error;
    });
  }
  return migrationPromise;
};

export const speedKnowledgeStore = {
  isNativeAuthorityReady: async () => await nativeSpeedAuthorityReady() || await isP6BrowserSpeedV2Authority(),
  async getMetadata() {
    if (!await nativeSpeedAuthorityReady()) {
      const authority = await readP6BrowserSpeedAuthority();
      if (authority.version !== 2) return null;
      const global = await readP6BrowserSpeedBuckets([]);
      return { ...speedKnowledgeMetadata(global), speedGeneration: `browser-v2:${authority.publicationVersion}` };
    }
    const state = await nativeTripArchive.speedState();
    return {
      schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
      knowledgeRevision: Number(state?.lastSeq) || 0,
      knowledgeUpdatedAt: Number(state?.updatedAtMs) > 0
        ? new Date(state.updatedAtMs).toISOString()
        : null,
      bucketCount: Number(state?.bucketCount) || 0,
      itemCount: Number(state?.totalItemCount) || 0,
      approximateBytes: Number(state?.totalPayloadBytes) || 0,
      speedGeneration: state?.speedGeneration || null,
    };
  },
  async get(key = SPEED_KNOWLEDGE_STORAGE_KEY) {
    if (await nativeSpeedAuthorityReady()) throw new Error('NATIVE_SPEED_FULL_MODEL_FORBIDDEN');
    if (await isP6BrowserSpeedV2Authority()) {
      const error = new Error(P6_SPEED_SCOPED_READ_REQUIRED);
      error.code = P6_SPEED_SCOPED_READ_REQUIRED;
      throw error;
    }
    if (!canUseIndexedDb()) {
      const value = await getEncryptedJson(key, null);
      return value == null ? null : normalizeSpeedKnowledgeMetadata(value);
    }
    try {
      // Normal reads are strictly authority reads. They never run the legacy
      // transition or allocate PRDE-1; that operation is explicit above.
      const indexedValue = await readIndexedDb(key);
      const writeAheadValue = await getEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, null);
      if (indexedValue == null && writeAheadValue == null) {
        const legacy = await getEncryptedJson(key, null);
        return legacy == null ? null : normalizeSpeedKnowledgeMetadata(legacy);
      }
      const indexed = indexedValue == null ? null : normalizeSpeedKnowledgeMetadata(indexedValue);
      const writeAhead = writeAheadValue == null
        ? null
        : normalizeSpeedKnowledgeMetadata(writeAheadValue);
      if (normalizedRevision(writeAhead) > normalizedRevision(indexed)) {
        return writeAhead;
      }
      return indexed || writeAhead;
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_read', error, { key });
      const value = await getEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, null) ||
        await getEncryptedJson(key, null);
      return value == null ? null : normalizeSpeedKnowledgeMetadata(value);
    }
  },

  async set(key = SPEED_KNOWLEDGE_STORAGE_KEY, value) {
    const normalizedValue = normalizeSpeedKnowledgeMetadata(value);
    if (await nativeSpeedAuthorityReady()) throw new Error('NATIVE_SPEED_BUCKET_SCOPED_WRITE_REQUIRED');
    if (await isP6BrowserSpeedV2Authority()) {
      const error = new Error('BROWSER_V2_SCOPED_WRITE_REQUIRED');
      error.code = 'BROWSER_V2_SCOPED_WRITE_REQUIRED';
      throw error;
    }
    if (!canUseIndexedDb()) {
      await setEncryptedJson(key, normalizedValue);
      try {
        await syncNativeSpeedKnowledgeMirror(key, normalizedValue);
      } catch (error) {
        logSystemFailure('speed_knowledge_native_mirror_write', error, { key });
      }
      return;
    }
    if (isNativePlatform() && P35_NATIVE_AUTHORITY_ENABLED) {
      const error = new Error('Explicit saved-road migration must complete before native speed writes');
      error.code = 'LEGACY_SPEED_MIGRATION_REQUIRED';
      throw error;
    }
    try {
      await writeIndexedDb(key, normalizedValue);
      await removeEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY);
      await removeEncryptedJson(key);
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_write', error, { key });
      await setEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, normalizedValue);
    }
    try {
      await syncNativeSpeedKnowledgeMirror(key, normalizedValue);
    } catch (error) {
      logSystemFailure('speed_knowledge_native_mirror_write', error, { key });
    }
  },

  runExclusive(key = SPEED_KNOWLEDGE_STORAGE_KEY, operation) {
    return runSpeedKnowledgeStoreExclusive(key, operation);
  },

  async update(key = SPEED_KNOWLEDGE_STORAGE_KEY, updater) {
    if (typeof updater !== 'function') throw new TypeError('Speed knowledge updater must be a function');
    return runSpeedKnowledgeStoreExclusive(key, async () => {
      const current = normalizeSpeedKnowledgeMetadata((await this.get(key)) || {});
      const proposed = await updater(current);
      if (proposed === undefined) return current;
      const next = normalizeSpeedKnowledgeMetadata(proposed, {
        previous: current,
        increment: true,
        updatedAt: new Date().toISOString(),
      });
      await this.set(key, next);
      return next;
    });
  },
  async getForGeohashes(geohashes = []) {
    if (!await nativeSpeedAuthorityReady()) {
      if (await isP6BrowserSpeedV2Authority()) return readP6BrowserSpeedBuckets(geohashes);
      return this.get(SPEED_KNOWLEDGE_STORAGE_KEY);
    }
    return normalizeSpeedKnowledgeMetadata(await readNativeSpeedBuckets(geohashes));
  },
  async setForGeohashes(value, geohashes = [], options = {}) {
    const normalizedValue = normalizeSpeedKnowledgeMetadata(value);
    if (!await nativeSpeedAuthorityReady()) {
      if (await isP6BrowserSpeedV2Authority()) return p6PublishScopedBuckets(normalizedValue, geohashes);
      return this.set(SPEED_KNOWLEDGE_STORAGE_KEY, normalizedValue);
    }
    await writeNativeSpeedBuckets(normalizedValue, geohashes, options);
  },
  /**
   * Stream every speed bucket for an explicit whole-geography operation.
   *
   * Reserved for user-initiated export and backup, which are inherently
   * whole-geography. `onBucket` receives one bucket at a time and must not
   * accumulate them beyond what the artifact it is producing requires; nothing
   * on a read, lookup, learning or page-open path may call this.
   */
  async streamBuckets({ onBucket, signal = null } = {}) {
    if (typeof onBucket !== 'function') throw new TypeError('streamBuckets requires an onBucket handler');
    if (!await nativeSpeedAuthorityReady()) {
      if (!await isP6BrowserSpeedV2Authority()) return { bucketCount: 0, native: false, cancelled: false };
      let cursor = '';
      let bucketCount = 0;
      do {
        const page = await p6ListV2BucketIds({ after: cursor, limit: 32 });
        for (const bucketId of page.items) {
          if (signal?.aborted) return { bucketCount, native: true, browserV2: true, cancelled: true };
          await onBucket(bucketId, await p6ReadV2Bucket(bucketId));
          bucketCount += 1;
        }
        cursor = page.nextCursor || '';
      } while (cursor);
      return { bucketCount, native: true, browserV2: true, cancelled: false };
    }
    let cursor = '';
    let bucketCount = 0;
    do {
      if (signal?.aborted) return { bucketCount, native: true, cancelled: true };
      const page = await nativeTripArchive.querySpeedBucketPage(cursor, 32);
      for (const item of page.items || []) {
        if (signal?.aborted) return { bucketCount, native: true, cancelled: true };
        await onBucket(item.bucketId, await readNativeSpeedBucket(item.bucketId));
        bucketCount += 1;
      }
      cursor = page.nextCursor || '';
    } while (cursor);
    return { bucketCount, native: true, cancelled: false };
  },

  async getSample(maxBuckets = 8) {
    if (!await nativeSpeedAuthorityReady()) {
      if (await isP6BrowserSpeedV2Authority()) {
        const page = await p6ListV2BucketIds({ limit: Math.max(1, Math.min(32, Number(maxBuckets) || 8)) });
        return readP6BrowserSpeedBuckets(page.items);
      }
      return this.get(SPEED_KNOWLEDGE_STORAGE_KEY);
    }
    return normalizeSpeedKnowledgeMetadata(await readNativeSpeedKnowledgeSample(maxBuckets));
  },
  async queryEditorItems({ kind, cursor = '', maxItems = 50, maxBytes = 128 * 1024, filter = '', activeOnly = false } = {}) {
    if (!await nativeSpeedAuthorityReady()) {
      if (!await isP6BrowserSpeedV2Authority()) return null;
      return queryP6BrowserSpeedEditorItems({ kind, cursor, maxItems, filter, activeOnly });
    }
    return nativeTripArchive.querySpeedEditorItems({
      kind,
      cursor,
      maxItems: Math.max(1, Math.min(100, Number(maxItems) || 50)),
      maxBytes: Math.max(1024, Math.min(256 * 1024, Number(maxBytes) || 128 * 1024)),
      filter: String(filter || '').slice(0, 96),
      activeOnly: activeOnly === true,
    });
  },
  async getEditorItem(kind, id) {
    if (!await nativeSpeedAuthorityReady()) {
      if (!await isP6BrowserSpeedV2Authority()) return undefined;
      const page = await queryP6BrowserSpeedEditorItems({ kind, cursor: '', maxItems: 100, filter: String(id || '') });
      return page.items.find((item) => Object.values(item || {}).some((value) => String(value) === String(id))) || null;
    }
    const result = await nativeTripArchive.getSpeedEditorItem(kind, id);
    return result?.item ?? null;
  },
  async runMaintenance(type, { maxAgeDays = 180, signal, onProgress } = {}) {
    if (!await nativeSpeedAuthorityReady()) {
      if (!await isP6BrowserSpeedV2Authority()) return null;
      return { state: 'EXPLICIT_OPERATION_REQUIRED', operationType: type, processedBuckets: 0, changedBuckets: 0, removedItems: 0 };
    }
    let status = await nativeTripArchive.beginSpeedMaintenance(type, maxAgeDays);
    while (status?.state === 'RUNNING') {
      if (signal?.aborted) {
        await nativeTripArchive.cancelSpeedMaintenance(status.jobId);
        const error = new Error('Saved-road maintenance cancelled');
        error.name = 'AbortError';
        throw error;
      }
      status = await nativeTripArchive.stepSpeedMaintenance(status.jobId, 8);
      onProgress?.(status);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return status;
  },
  /**
   * One bounded speed-maintenance scheduler turn: either the existing
   * `beginSpeedMaintenance` handshake or exactly one existing 8-bucket
   * `stepSpeedMaintenance`. Generation binding, the bucket ceiling and the
   * domain status/cancellation contract are unchanged.
   */
  async stepMaintenanceTurn(type, { maxAgeDays = 180, jobId = null } = {}) {
    if (!await nativeSpeedAuthorityReady()) {
      return { state: 'UNAVAILABLE', hasMore: false, jobId: null, processedBuckets: 0, buckets: 0 };
    }
    // P4-C-F08: with no transient cursor - a fresh renderer, or the first turn
    // of an instance - the native domain resolves the identity itself, so a
    // process restart continues the durable RUNNING job instead of starting a
    // second one. The transient jobId is a cache, never the only locator.
    let status;
    if (jobId) {
      try {
        status = await nativeTripArchive.stepSpeedMaintenance(jobId, 8);
      } catch (error) {
        if (!/JOB_NOT_FOUND/i.test(String(error?.message || error?.code || ''))) throw error;
        status = await nativeTripArchive.beginOrResumeSpeedMaintenance(type, maxAgeDays);
      }
    } else {
      status = await nativeTripArchive.beginOrResumeSpeedMaintenance(type, maxAgeDays);
      // A resumed job is already past its handshake, so this turn owes a real
      // bounded step rather than another begin.
      if (status?.state === 'RUNNING' && Number(status?.processedBuckets) > 0) {
        status = await nativeTripArchive.stepSpeedMaintenance(status.jobId, 8);
      }
    }
    const processedBuckets = Math.max(0, Number(status?.processedBuckets) || 0);
    return {
      ...status,
      hasMore: status?.state === 'RUNNING',
      jobId: status?.jobId || jobId || null,
      processedBuckets,
    };
  },
};

export const readSpeedKnowledgeData = async ({ explicitFullModel = false } = {}) => {
  if (!await isP6BrowserSpeedV2Authority()) return speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY);
  if (!explicitFullModel) {
    const error = new Error(P6_SPEED_SCOPED_READ_REQUIRED);
    error.code = P6_SPEED_SCOPED_READ_REQUIRED;
    throw error;
  }
  const merged = await readP6BrowserSpeedBuckets([]);
  await speedKnowledgeStore.streamBuckets({
    onBucket: (_bucketId, bucket) => {
      Object.assign(merged.cells, bucket?.cells || {});
      merged.corrections.push(...(bucket?.corrections || []));
      merged.excludedSections.push(...(bucket?.excludedSections || []));
      merged.roadMemory.candidates.push(...(bucket?.roadMemory?.candidates || []));
    },
  });
  return normalizeSpeedKnowledgeMetadata(merged);
};

export async function retryNativeSpeedKnowledgeMirror() {
  const current = await readSpeedKnowledgeData({ explicitFullModel: true });
  await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, current);
  return getNativeSpeedKnowledgeMirrorStatus();
}

export const readSpeedKnowledgeMetadata = async () => {
  if (await nativeSpeedAuthorityReady()) {
    const state = await nativeTripArchive.speedState();
    return {
      schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
      knowledgeRevision: Number(state?.lastSeq) || 0,
      knowledgeUpdatedAt: Number(state?.updatedAtMs) > 0
        ? new Date(state.updatedAtMs).toISOString()
        : null,
      bucketCount: Number(state?.bucketCount) || 0,
      speedGeneration: state?.speedGeneration || null,
    };
  }
  if (await isP6BrowserSpeedV2Authority()) return speedKnowledgeStore.getMetadata();
  return speedKnowledgeMetadata(await readSpeedKnowledgeData());
};

export const readSpeedKnowledgeSample = async (maxBuckets = 8) => (
  speedKnowledgeStore.getSample(maxBuckets)
);

/** O(1) native storage summary for normal Settings/Diagnostics surfaces. */
export const readSpeedKnowledgeStorageSummary = async () => {
  if (!await nativeSpeedAuthorityReady()) return null;
  const state = await nativeTripArchive.speedState();
  return {
    nativeCanonical: true,
    bucketCount: Number(state?.bucketCount) || 0,
    itemCount: Number(state?.totalItemCount) || 0,
    approximateBytes: Number(state?.totalPayloadBytes) || 0,
    knowledgeRevision: Number(state?.lastSeq) || 0,
    knowledgeUpdatedAt: Number(state?.updatedAtMs) > 0
      ? new Date(state.updatedAtMs).toISOString()
      : null,
  };
};

/**
 * AUD-007 round 5: admission spans CAPTURE -> ENCRYPT -> DURABLE COMMIT. A producer that
 * captures the outgoing key version and commits later with nothing held lets a finalizer
 * see no admitted writer, prove zero, delete the version, and this write then publishes
 * durable ciphertext under a destroyed key.
 */
const replaceP6BrowserSpeedV2Explicit = async (value) => withDurableKeyPublication(async () => {
  const { buckets, root } = p6Bucketize(normalizeSpeedKnowledgeMetadata(value));
  const stageId = p6MutationLeaseId();
  const publicationVersion = Date.now();
  for (const [bucketId, document] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await p6WriteStageBucket({ stageId, publicationVersion, bucketId, document, commitState: 'COMMITTED' });
  }
  const rootPayload = await encryptSensitiveValue(root, `p6:speed-v2:${stageId}:__global__:${publicationVersion}:0`);
  await requireBrowserP6DerivedStorage(p6JsonBytes(rootPayload));
  const sourceFingerprint = await p6Fingerprint(value);
  await publishP6BrowserSpeedGeneration({
    stageId, publicationVersion, root, rootPayload, sourceFingerprint, sourceKeyVersion: 0,
  });
});

export const replaceSpeedKnowledgeData = async (value) => {
  if (await isP6BrowserSpeedV2Authority()) {
    await runSpeedKnowledgeStoreExclusive(SPEED_KNOWLEDGE_STORAGE_KEY,
      () => replaceP6BrowserSpeedV2Explicit(value));
  } else {
    await speedKnowledgeStore.update(SPEED_KNOWLEDGE_STORAGE_KEY, () => value);
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('speed-knowledge-changed', {
      detail: { action: 'replace_speed_knowledge' },
    }));
  }
};

export async function eraseSpeedKnowledgeForDataRights() {
  return runSpeedKnowledgeStoreExclusive(SPEED_KNOWLEDGE_STORAGE_KEY, async () => {
    const result = {
      store: `indexeddb:${SPEED_KNOWLEDGE_DB_NAME}/${SPEED_KNOWLEDGE_STORE}`,
      indexedDbDeleted: false,
      fallbackKey: SPEED_KNOWLEDGE_STORAGE_KEY,
      fallbackRemoved: false,
      writeAheadKey: SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      writeAheadRemoved: false,
      nativeMirrorKey: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      nativeMirrorRemoved: false,
      method: 'indexeddb_delete_and_mirror_remove',
    };

    // Prevent native legacy fallback during or after erasure even if an older
    // canonical Preferences value takes longer to remove.
    await Promise.resolve(setJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true)).catch(() => {});

    try {
      result.indexedDbDeleted = await deleteDb();
      migrationPromise = null;
    } catch (error) {
      result.method = 'mirror_remove_indexeddb_delete_failed';
      logSystemFailure('speed_knowledge_data_erasure_indexeddb', error, {});
    }

    await Promise.resolve(setEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY, {
      _secure_delete_tombstone: true,
      _secure_delete_at: Date.now(),
      random_padding: Math.random().toString(36).repeat(128),
    })).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY)).then(() => {
      result.fallbackRemoved = true;
    }).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY)).then(() => {
      result.writeAheadRemoved = true;
    }).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY)).then(() => {
      result.nativeMirrorRemoved = true;
    }).catch(() => {});

    if (result.indexedDbDeleted) {
      await removeJson(P6_SPEED_V2_CUTOVER_MARKER_KEY);
    }

    return result;
  });
}

// ─── AUD-007: speed knowledge as a registered key-reference domain ───────────
//
// Speed knowledge is NOT freely regenerable derived data: it carries the driver's own
// posted-limit corrections. If the root key that seals it is destroyed, those are gone.
// It is registered so a superseded version is retained until it is proven unreferenced.
//
// Conservative by construction: any inspection failure throws, which the registry
// records as UNKNOWN, which retains the key.

/** Bounded examination budget: exhaustion throws => UNKNOWN => the key is retained. */
const SPEED_KEY_REFERENCE_SCAN_LIMIT = 512;

export async function countSpeedKnowledgeKeyVersionReferences(version) {
  const target = Math.max(0, Number(version) || 0);
  if (!target) return 0;
  // Provably empty, not unknown: with no IndexedDB substrate and no native preference
  // store there is nowhere for speed ciphertext to live.
  if (!globalThis.indexedDB && !isNativePlatform()) return 0;
  const referencesVersion = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (value.encrypted === true && Number(value.key_version) === target) return true;
    return Object.values(value).some((nested) => (
      nested && typeof nested === 'object' && referencesVersion(nested)
    ));
  };
  // Read ENCRYPTED wrappers, never the decrypted knowledge: the point is to inspect
  // which key version seals them, and decrypting would defeat that if the key is the one
  // being retired.
  //
  // Round 2: the legacy whole-model record is NOT the only shipping consumer. The
  // browser-v2 authority stores its knowledge as per-bucket encrypted partitions, and
  // those carry the driver's own posted-limit corrections — they are user-authored data,
  // not regenerable cache, so missing them here would destroy exactly what must not be
  // destroyed.
  let wrapper = null;
  try {
    if (canUseIndexedDb()) {
      wrapper = (await readIndexedDbWrapper(SPEED_KNOWLEDGE_STORAGE_KEY))?.value ?? null;
    }
    if (wrapper == null) {
      wrapper = await readNativePreferenceJsonStrict(SPEED_KNOWLEDGE_STORAGE_KEY);
    }
  } catch {
    throw new Error('SPEED_KNOWLEDGE_KEY_REFERENCE_UNREADABLE');
  }
  if (wrapper != null && referencesVersion(wrapper)) return 1;

  if (!canUseIndexedDb()) return 0;
  let db;
  try {
    db = await openDb();
  } catch {
    throw new Error('SPEED_KNOWLEDGE_KEY_REFERENCE_UNREADABLE');
  }
  // Round 4. The proof resumes from a durable watermark for the same reason the rewrap
  // does: with more rows than one examination budget a restarting sweep can never reach
  // the end, so "zero references" stays permanently UNKNOWN and a converged key can never
  // be retired. Bounded-but-never-finishing is a leak, not a fail-safe.
  const stores = [P6_SPEED_STORES.PARTITIONS, P6_SPEED_STORES.CONTROL, P6_SPEED_STORES.STAGES];
  const cursorKey = SPEED_PROOF_CURSOR_KEY(target);
  try {
    // Round 6: the stamp is a per-process identity, not a counter. A counter restarts at
    // the same value after a process restart, so a watermark persisted before the restart
    // could alias as current and authorise skipping rows a writer inserted behind it.
    const stamp = getBrowserKeyProofGeneration();
    const stored = await readSpeedCursor(db, cursorKey);
    // Progress from an older epoch cannot authorize deletion: a writer admitted since then
    // may have inserted behind the watermark.
    const saved = isBrowserKeyProofGenerationCurrent(stored) ? stored : null;
    let storeIndex = Math.max(0, stores.indexOf(saved?.store));
    let afterKey = saved?.store === stores[storeIndex] ? saved?.afterKey ?? null : null;
    let budget = SPEED_KEY_REFERENCE_SCAN_LIMIT;

    while (storeIndex < stores.length) {
      const page = await scanSpeedStoreFrom(db, stores[storeIndex], afterKey,
        referencesVersion, 1, budget);
      budget -= page.examined;

      if (page.matched.length) {
        await writeSpeedCursor(db, cursorKey, null);
        return 1;                              // one reference is enough, and definitive
      }
      if (page.exhausted) {
        storeIndex += 1;
        afterKey = null;
        continue;
      }
      await writeSpeedCursor(db, cursorKey, {
        store: stores[storeIndex], afterKey: page.lastKey, ...stamp,
      });
      throw new Error('SPEED_KNOWLEDGE_KEY_REFERENCE_SCAN_BUDGET_EXHAUSTED');
    }

    await writeSpeedCursor(db, cursorKey, null);
    return 0;                                  // every store swept to the end, clean
  } finally {
    db.close();
  }
}

// ─── Round 3: real, bounded rewrap convergence ───────────────────────────────
//
// Round 2 counted these references and stopped, so the retiring version stayed live
// indefinitely. Rewrapping them is what lets rotation actually retire a key — and it has
// to be a REWRAP, never a rebuild: partition ordinal zero carries the driver's own
// posted-limit corrections and exclusions, which are not regenerable from anything.
//
// Every partition's AAD is derivable from the row itself, so the ciphertext is resealed
// under the new version with byte-identical plaintext. A row whose context cannot be
// derived is left alone and keeps the key retained.

/** Bounded page: a larger repository produces more turns, not a larger turn. */
const SPEED_KEY_REWRAP_ROWS_PER_TURN = 64;

/**
 * Round 4. Durable continuation for both the rewrap and the zero-reference proof.
 *
 * Cursor-bounded acquisition without cursor-bounded PROGRESS just re-walks the migrated
 * prefix every turn, so a large repository never reaches its tail and a converged key can
 * never be proven clean. Both sweeps now resume from a durable key watermark.
 */
const SPEED_REWRAP_CURSOR_KEY = (from, to) => `key-rewrap-cursor:${from}:${to}`;
const SPEED_PROOF_CURSOR_KEY = (version) => `key-proof-cursor:${version}`;

const readSpeedCursor = async (db, key) => {
  if (!db.objectStoreNames.contains(P6_SPEED_STORES.CONTROL)) return null;
  try {
    const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readonly');
    return (await requestResult(tx.objectStore(P6_SPEED_STORES.CONTROL).get(key)))?.cursor ?? null;
  } catch {
    return null;   // an unreadable watermark repeats a sweep; it never skips a row
  }
};

const writeSpeedCursor = async (db, key, cursor) => {
  if (!db.objectStoreNames.contains(P6_SPEED_STORES.CONTROL)) return;
  try {
    const tx = db.transaction(P6_SPEED_STORES.CONTROL, 'readwrite');
    const store = tx.objectStore(P6_SPEED_STORES.CONTROL);
    if (cursor) store.put({ key, cursor, updatedAt: Date.now() });
    else store.delete(key);
    await transactionDone(tx);
  } catch {
    // A watermark that will not persist costs a repeated sweep, never a false zero.
  }
};

/** Walk one speed store from `afterKey` (exclusive) under both a match and scan budget. */
const scanSpeedStoreFrom = async (db, storeName, afterKey, accept, limit, examineBudget) => {
  if (!db.objectStoreNames.contains(storeName)) {
    return { matched: [], lastKey: afterKey ?? null, examined: 0, exhausted: true };
  }
  const tx = db.transaction(storeName, 'readonly');
  const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
  return new Promise((resolve, reject) => {
    const matched = [];
    let examined = 0;
    let lastKey = afterKey ?? null;
    const request = tx.objectStore(storeName).openCursor(range);
    request.onerror = () => reject(request.error || new Error('speed key reference scan failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve({ matched, lastKey, examined, exhausted: true }); return; }
      lastKey = cursor.primaryKey;
      if (accept(cursor.value)) matched.push(cursor.value);
      examined += 1;
      if (matched.length >= limit || examined >= examineBudget) {
        resolve({ matched, lastKey, examined, exhausted: false });
        return;
      }
      cursor.continue();
    };
  });
};

const speedPartitionContext = (row) => {
  if (!row?.stageId || !row?.bucketId) return null;
  const publicationVersion = Number(row.publicationVersion);
  if (!Number.isFinite(publicationVersion)) return null;
  return `p6:speed-v2:${row.stageId}:${row.bucketId}:${publicationVersion}:${Number(row.ordinal) || 0}`;
};

/**
 * Rewrap one bounded page of speed references from `version` onto `targetVersion`.
 * @returns {Promise<{rewrapped: number, hasMore: boolean}>}
 */
export async function rewrapSpeedKnowledgeKeyVersion(version, targetVersion, options = {}) {
  const from = Math.max(0, Number(version) || 0);
  const to = Math.max(1, Number(targetVersion) || 1);
  const empty = { rewrapped: 0, examined: 0, cursor: null, hasMore: false };
  if (!from || from === to || !canUseIndexedDb()) return empty;

  let rewrapped = 0;
  let examined = 0;
  let hasMore = false;
  let nextCursor = null;
  const db = await openDb();
  try {
    // The legacy whole-model wrapper first: it is one record, and it is what the Android
    // native mirror still reads through.
    if (db.objectStoreNames.contains(SPEED_KNOWLEDGE_STORE)) {
      const record = await requestResult(db.transaction(SPEED_KNOWLEDGE_STORE, 'readonly')
        .objectStore(SPEED_KNOWLEDGE_STORE).get(SPEED_KNOWLEDGE_STORAGE_KEY));
      if (isEncryptedPayload(record?.value) && Number(record.value.key_version) === from) {
        try {
          const context = indexedDbEncryptionContext(SPEED_KNOWLEDGE_STORAGE_KEY);
          const plain = await decryptSensitiveValue(record.value, context);
          const resealed = await encryptSensitiveValue(plain, context, { keyVersion: to });
          const tx = db.transaction(SPEED_KNOWLEDGE_STORE, 'readwrite');
          tx.objectStore(SPEED_KNOWLEDGE_STORE).put({ ...record, value: resealed });
          await transactionDone(tx);
          rewrapped += 1;
        } catch {
          // Left on the old version; the reference keeps that version retained.
        }
      }
    }

    if (db.objectStoreNames.contains(P6_SPEED_STORES.PARTITIONS)) {
      const rowBudget = Math.max(1, Number(options.rowBudget) || SPEED_KEY_REWRAP_ROWS_PER_TURN);
      const cursorKey = SPEED_REWRAP_CURSOR_KEY(from, to);
      const startAfter = options.cursor !== undefined
        ? options.cursor
        : await readSpeedCursor(db, cursorKey);
      const page = await scanSpeedStoreFrom(
        db, P6_SPEED_STORES.PARTITIONS, startAfter,
        (row) => isEncryptedPayload(row?.payload) && Number(row.payload.key_version) === from,
        rowBudget, SPEED_KEY_REFERENCE_SCAN_LIMIT,
      );
      examined += page.examined;
      hasMore = !page.exhausted;
      nextCursor = page.exhausted ? null : page.lastKey;
      await writeSpeedCursor(db, cursorKey, nextCursor);
      for (const row of page.matched) {
        const context = speedPartitionContext(row);
        if (!context) continue;
        try {
          const plain = await decryptSensitiveValue(row.payload, context);
          const resealed = await encryptSensitiveValue(plain, context, { keyVersion: to });
          const tx = db.transaction(P6_SPEED_STORES.PARTITIONS, 'readwrite');
          tx.objectStore(P6_SPEED_STORES.PARTITIONS).put({ ...row, payload: resealed });
          await transactionDone(tx);
          rewrapped += 1;
        } catch {
          // Left on the old version; the reference keeps that version retained.
        }
      }
    }
  } finally {
    db.close();
  }
  return { rewrapped, examined, cursor: nextCursor, hasMore: hasMore && rewrapped > 0 };
}

registerBrowserKeyReferenceDomain({
  id: 'speed_knowledge',
  countReferences: countSpeedKnowledgeKeyVersionReferences,
  rewrapStep: async ({ fromVersion, toVersion, cursor, rowBudget }) => {
    const step = await rewrapSpeedKnowledgeKeyVersion(fromVersion, toVersion, { cursor, rowBudget });
    return {
      rewrapped: step.rewrapped,
      examined: step.examined,
      cursor: step.cursor,
      hasMore: step.hasMore,
    };
  },
});
