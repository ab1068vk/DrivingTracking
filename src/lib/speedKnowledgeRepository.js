import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const SPEED_KNOWLEDGE_STORAGE_KEY = 'speed_knowledge_v1';
export const SPEED_KNOWLEDGE_DB_NAME = 'drivesense_speed_knowledge';
export const SPEED_KNOWLEDGE_DB_VERSION = 1;
const SPEED_KNOWLEDGE_STORE = 'knowledge';

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
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const readIndexedDb = async (key) => {
  const db = await openDb();
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readonly');
    const record = await requestResult(transaction.objectStore(SPEED_KNOWLEDGE_STORE).get(key));
    return record?.value ?? null;
  } finally {
    db.close();
  }
};

const writeIndexedDb = async (key, value) => {
  const db = await openDb();
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readwrite');
    transaction.objectStore(SPEED_KNOWLEDGE_STORE).put({
      key,
      value,
      updatedAt: new Date().toISOString(),
    });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};

let migrationPromise = null;

const nativeSpeedKnowledgeMirror = (value) => ({
  cells: {},
  corrections: Array.isArray(value?.corrections)
    ? value.corrections.map((correction) => ({
      id: correction?.id,
      ruleId: correction?.ruleId,
      geohash: correction?.geohash,
      lat: correction?.lat,
      lng: correction?.lng,
      coordinateSource: correction?.coordinateSource,
      limitKmh: correction?.limitKmh,
      source: correction?.source,
      appliedAt: correction?.appliedAt,
      expiresAt: correction?.expiresAt,
      directionMode: correction?.directionMode,
      directionBearing: correction?.directionBearing,
      timeRule: correction?.timeRule,
      sectionPoints: Array.isArray(correction?.sectionPoints)
        ? correction.sectionPoints.map((point) => ({ lat: point?.lat, lng: point?.lng }))
        : undefined,
    }))
    : [],
});

const syncNativeSpeedKnowledgeMirror = async (key, value) => {
  if (!isNativePlatform()) {
    await removeJson(key);
    return;
  }
  await setJson(key, nativeSpeedKnowledgeMirror(value));
};

export const migrateSpeedKnowledgeToIndexedDb = async () => {
  if (!canUseIndexedDb()) return false;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const indexedValue = await readIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY);
      if (indexedValue != null) {
        await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, indexedValue);
        return false;
      }
      const legacyValue = await getJson(SPEED_KNOWLEDGE_STORAGE_KEY, null);
      if (legacyValue == null) {
        const emptyValue = { cells: {}, corrections: [] };
        await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, emptyValue);
        await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, emptyValue);
        return false;
      }
      await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, legacyValue);
      await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, legacyValue);
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
  async get(key = SPEED_KNOWLEDGE_STORAGE_KEY) {
    if (!canUseIndexedDb()) return getJson(key, null);
    try {
      await migrateSpeedKnowledgeToIndexedDb();
      return await readIndexedDb(key);
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_read', error, { key });
      return getJson(key, null);
    }
  },

  async set(key = SPEED_KNOWLEDGE_STORAGE_KEY, value) {
    if (!canUseIndexedDb()) {
      await setJson(key, value);
      return;
    }
    try {
      await migrateSpeedKnowledgeToIndexedDb();
      await writeIndexedDb(key, value);
      await syncNativeSpeedKnowledgeMirror(key, value);
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_write', error, { key });
      await setJson(key, value);
    }
  },
};

export const readSpeedKnowledgeData = () => speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY);

export const replaceSpeedKnowledgeData = async (value) => {
  await speedKnowledgeStore.set(SPEED_KNOWLEDGE_STORAGE_KEY, value);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('speed-knowledge-changed', {
      detail: { action: 'replace_speed_knowledge' },
    }));
  }
};
