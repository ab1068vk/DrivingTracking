/**
 * Independent durable-footprint observer for P6 browser state.
 *
 * It walks the IndexedDB database directly and derives every byte from the
 * stored representation: record keys, record content and the entries each
 * declared index must maintain. It never reads a P6 accounting field
 * (`encodedBytes`, `plaintextBytes`, `proposedBytes`, `bytesWorked`) and never
 * imports a P6 module, so the measurement cannot inherit an error from the code
 * under test.
 */

const encoder = new TextEncoder();

export const durableValueBytes = (value) => {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 8;
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += durableValueBytes(item);
    return total;
  }
  let total = 0;
  for (const [key, item] of Object.entries(value)) {
    total += encoder.encode(key).byteLength + durableValueBytes(item);
  }
  return total;
};

const atKeyPath = (record, keyPath) => {
  let current = record;
  for (const part of String(keyPath).split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
};

const indexKeyBytes = (record, keyPath) => {
  if (Array.isArray(keyPath)) {
    let total = 0;
    for (const part of keyPath) {
      const value = atKeyPath(record, part);
      if (value === undefined) return 0;
      total += durableValueBytes(value);
    }
    return total;
  }
  const value = atKeyPath(record, keyPath);
  return value === undefined ? 0 : durableValueBytes(value);
};

/** Measured bytes for one store: records plus every index entry it carries. */
export const observeStoreBytes = (indexedDb, databaseName, storeName) => {
  const state = indexedDb.getStoreState(databaseName, storeName);
  if (!state) return { count: 0, recordBytes: 0, indexBytes: 0, bytes: 0 };
  const definitions = [...(state.indexes?.values?.() || [])];
  let recordBytes = 0;
  let indexBytes = 0;
  state.records.forEach((record, primaryKey) => {
    const keyBytes = durableValueBytes(primaryKey);
    recordBytes += keyBytes + durableValueBytes(record);
    for (const definition of definitions) {
      const entry = indexKeyBytes(record, definition.keyPath);
      if (entry > 0) indexBytes += entry + keyBytes;
    }
  });
  return {
    count: state.records.size,
    recordBytes,
    indexBytes,
    bytes: recordBytes + indexBytes,
  };
};

/** Measured bytes for a whole database, optionally restricted to some stores. */
export const observeDatabaseBytes = (indexedDb, databaseName, storeNames = null) => {
  const database = indexedDb.databases.get(databaseName);
  if (!database) return { bytes: 0, stores: {} };
  const names = storeNames || [...database.stores.keys()];
  const stores = {};
  let bytes = 0;
  for (const name of names) {
    const observation = observeStoreBytes(indexedDb, databaseName, name);
    stores[name] = observation;
    bytes += observation.bytes;
  }
  return { bytes, stores };
};
