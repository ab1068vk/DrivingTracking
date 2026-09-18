import { FakeIndexedDb } from './fakeIndexedDb';

// Test platform seams, not a substitute ledger/crypto implementation. Real
// Chromium transaction/lock/CryptoKey conformance is also exercised by E2E.
export function createAuditTestRuntime(values = new Map()) {
  const idb = new FakeIndexedDb();
  let tail = Promise.resolve(); let held = false;
  const locks = {
    request(_name, options, callback) {
      if (options.ifAvailable && held) return Promise.resolve(callback(null));
      const task = tail.then(async () => { held = true; try { return await callback({ name: _name }); } finally { held = false; } });
      tail = task.catch(() => undefined); return task;
    },
  };
  const storage = {
    get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), clear: () => values.clear(),
  };
  return { idb, values, storage, locks };
}
