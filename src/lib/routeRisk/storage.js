import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import {
  DB_NAME,
  DB_VERSION,
  ROUTE_RISK_RECORD_ID,
  ROUTE_RISK_STORE,
  TRIP_STORE,
} from '@/lib/localDbConfig';
import {
  MAX_SERIALIZED_LENGTH,
  MAX_STORED_CELLS,
  ROUTE_RISK_INDEX_KEY,
  ROUTE_RISK_INDEX_SCHEMA_VERSION,
} from '@/lib/routeRisk/constants';
import {
  buildRouteRiskIndexFromTrips,
  compactRouteRiskIndex,
  createRouteRiskIndexMap,
  mergeRouteRiskTripIntoIndexMap,
} from '@/lib/routeRisk/aggregate';

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const hasStore = (db, storeName) => db.objectStoreNames.contains(storeName);

const ensureTripStore = (db, transaction) => {
  const store = hasStore(db, TRIP_STORE)
    ? transaction.objectStore(TRIP_STORE)
    : db.createObjectStore(TRIP_STORE, { keyPath: 'id' });
  if (!store.indexNames.contains('start_time')) store.createIndex('start_time', 'start_time');
  if (!store.indexNames.contains('status')) store.createIndex('status', 'status');
};

const ensureRouteRiskStore = (db) => {
  if (!hasStore(db, ROUTE_RISK_STORE)) {
    db.createObjectStore(ROUTE_RISK_STORE, { keyPath: 'id' });
  }
};

const openRouteRiskDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    ensureTripStore(request.result, request.transaction);
    ensureRouteRiskStore(request.result);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const indexRecordFromMap = (index = new Map()) => {
  let entries = [...index.entries()].map(([key, value]) => [key, { ...value, key: value.key || key }]);
  if (JSON.stringify(entries).length > MAX_SERIALIZED_LENGTH) {
    entries = entries
      .sort((a, b) => (b[1].tripCount || 0) - (a[1].tripCount || 0))
      .slice(0, MAX_STORED_CELLS);
  }
  return {
    id: ROUTE_RISK_RECORD_ID,
    schemaVersion: ROUTE_RISK_INDEX_SCHEMA_VERSION,
    entries,
    indexedTripIds: index.metadata?.indexedTripIds || [],
    updatedAt: new Date().toISOString(),
  };
};

const mapFromIndexRecord = (record, privacyZones = []) => {
  if (!record) return createRouteRiskIndexMap();
  const entries = Array.isArray(record.entries) ? record.entries : Array.isArray(record) ? record : [];
  return compactRouteRiskIndex(
    createRouteRiskIndexMap(entries, {
      schemaVersion: record.schemaVersion,
      indexedTripIds: record.indexedTripIds || [],
      updatedAt: record.updatedAt,
    }),
    privacyZones
  );
};

async function saveToIndexedDb(record) {
  const db = await openRouteRiskDb();
  try {
    const tx = db.transaction(ROUTE_RISK_STORE, 'readwrite');
    tx.objectStore(ROUTE_RISK_STORE).put(record);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

async function loadFromIndexedDb() {
  const db = await openRouteRiskDb();
  try {
    const tx = db.transaction(ROUTE_RISK_STORE, 'readonly');
    return await idbRequest(tx.objectStore(ROUTE_RISK_STORE).get(ROUTE_RISK_RECORD_ID));
  } finally {
    db.close();
  }
}

async function deleteFromIndexedDb() {
  const db = await openRouteRiskDb();
  try {
    const tx = db.transaction(ROUTE_RISK_STORE, 'readwrite');
    tx.objectStore(ROUTE_RISK_STORE).delete(ROUTE_RISK_RECORD_ID);
    await transactionDone(tx);
  } finally {
    db.close();
  }
}

export async function saveRouteRiskIndex(index = new Map()) {
  const record = indexRecordFromMap(index);
  try {
    await saveToIndexedDb(record);
  } catch {
    await setJson(ROUTE_RISK_INDEX_KEY, record);
  }
}

export async function loadRouteRiskIndex(privacyZones = []) {
  try {
    return mapFromIndexRecord(await loadFromIndexedDb(), privacyZones);
  } catch {
    return mapFromIndexRecord(await getJson(ROUTE_RISK_INDEX_KEY, null), privacyZones);
  }
}

export async function hasRouteRiskIndex() {
  try {
    return Boolean(await loadFromIndexedDb());
  } catch {
    return Boolean(await getJson(ROUTE_RISK_INDEX_KEY, null));
  }
}

export async function mergeRouteRiskTripIntoIndex(trip = {}, privacyZones = []) {
  const index = await loadRouteRiskIndex(privacyZones);
  mergeRouteRiskTripIntoIndexMap(index, trip, privacyZones);
  await saveRouteRiskIndex(index);
  return index;
}

export async function rebuildRouteRiskIndex(trips = [], privacyZones = []) {
  const index = buildRouteRiskIndexFromTrips(trips, privacyZones);
  await saveRouteRiskIndex(index);
  return index;
}

export async function invalidateRouteRiskIndex() {
  try {
    await deleteFromIndexedDb();
  } catch {
    // Fall through to legacy/fallback deletion.
  }
  await removeJson(ROUTE_RISK_INDEX_KEY);
}
