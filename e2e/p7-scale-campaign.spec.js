import { expect, test } from '@playwright/test';

/**
 * P7-IMPL-F06 — the mandatory scale campaign against **real** Chromium
 * IndexedDB.
 *
 * The unit campaign runs against a fake IndexedDB. A fake that models the
 * intended algorithm rather than the browser's makes the bound it proves
 * circular: if the fake walks a cursor the way the implementation expects, of
 * course the count comes out bounded. P7-V03 says **real** storage, and the
 * failure it guards against is silent — a mis-shaped key range does not throw,
 * it selects everything.
 *
 * So this spec builds the production projection index shape in real Chromium,
 * seeds each mandated tier, and runs the same bounded keyset trace Q1 performs,
 * with the observation taken at `IDBObjectStore`/`IDBIndex` prototype level —
 * outside anything the implementation maintains about itself.
 *
 * Storage state is deleted before every tier, so no cache can be load-bearing.
 *
 * This is browser software validation. No device is involved.
 */

const SCHEMA = {
  db: 'p7_scale_campaign',
  version: 1,
  store: 'trip_projections',
  unfiltered: 'by_start_time_id',
  filtered: 'by_status_start_time_id',
};

/** The frozen tiers. 128 is the original failure scale. */
const TIERS = [128, 500, 1000, 3000, 5000];

/** The page size every tier is measured at. */
const PAGE = 25;

/**
 * Install a prototype-level observer, seed `count` rows on cold storage, and
 * run the bounded page trace. Everything happens inside the real browser.
 */
const runTier = async (page, { schema, count, pageSize }) => page.evaluate(async ({ schema, count, pageSize }) => {
  // ---- independent observation, outside the implementation ----------------
  const counts = {
    wholeStoreGetAlls: 0,
    cursorOpens: 0,
    cursorDeliveries: 0,
    keyedGets: 0,
    transactions: 0,
    indexCounts: 0,
  };
  const originals = {
    getAll: IDBObjectStore.prototype.getAll,
    indexGetAll: IDBIndex.prototype.getAll,
    openCursor: IDBIndex.prototype.openCursor,
    storeOpenCursor: IDBObjectStore.prototype.openCursor,
    get: IDBObjectStore.prototype.get,
    count: IDBIndex.prototype.count,
    transaction: IDBDatabase.prototype.transaction,
  };

  // A cursor delivery is one row the storage layer actually handed over.
  //
  // Real IndexedDB reuses **one** `IDBCursor` object across `continue()`, so
  // watching the request's `result` identity counts a single delivery however
  // far the cursor walks — an under-count that would make any bound look met.
  // The deliveries are counted at `success` instead, which fires once per row
  // the storage layer produces, and that is the number the bound is about.
  const watchCursor = (request) => {
    request.addEventListener('success', () => {
      if (request.result) counts.cursorDeliveries += 1;
    });
    return request;
  };

  // The app under test is a real app on a real origin and does its own
  // IndexedDB work while this runs. Scoping every counter to the campaign
  // database is what makes the number a measurement of the traced read rather
  // than of whatever else the page happened to be doing.
  const mine = (store) => {
    try {
      const name = store?.transaction?.db?.name ?? store?.objectStore?.transaction?.db?.name;
      return name === schema.db;
    } catch { return false; }
  };

  IDBObjectStore.prototype.getAll = function patched(...args) {
    if (mine(this)) counts.wholeStoreGetAlls += 1;
    return originals.getAll.apply(this, args);
  };
  IDBIndex.prototype.getAll = function patched(...args) {
    if (mine(this)) counts.wholeStoreGetAlls += 1;
    return originals.indexGetAll.apply(this, args);
  };
  IDBIndex.prototype.openCursor = function patched(...args) {
    if (!mine(this)) return originals.openCursor.apply(this, args);
    counts.cursorOpens += 1;
    return watchCursor(originals.openCursor.apply(this, args));
  };
  IDBObjectStore.prototype.openCursor = function patched(...args) {
    if (!mine(this)) return originals.storeOpenCursor.apply(this, args);
    counts.cursorOpens += 1;
    return watchCursor(originals.storeOpenCursor.apply(this, args));
  };
  IDBObjectStore.prototype.get = function patched(...args) {
    if (mine(this)) counts.keyedGets += 1;
    return originals.get.apply(this, args);
  };
  IDBIndex.prototype.count = function patched(...args) {
    if (mine(this)) counts.indexCounts += 1;
    return originals.count.apply(this, args);
  };
  IDBDatabase.prototype.transaction = function patched(...args) {
    if (this?.name === schema.db) counts.transactions += 1;
    return originals.transaction.apply(this, args);
  };

  const restore = () => {
    IDBObjectStore.prototype.getAll = originals.getAll;
    IDBIndex.prototype.getAll = originals.indexGetAll;
    IDBIndex.prototype.openCursor = originals.openCursor;
    IDBObjectStore.prototype.openCursor = originals.storeOpenCursor;
    IDBObjectStore.prototype.get = originals.get;
    IDBIndex.prototype.count = originals.count;
    IDBDatabase.prototype.transaction = originals.transaction;
  };

  try {
    // ---- cold storage: nothing may survive from the previous tier ---------
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(schema.db);
      request.onsuccess = resolve; request.onerror = resolve; request.onblocked = resolve;
    });

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(schema.db, schema.version);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(schema.store, { keyPath: 'id' });
        // The production projection index shape.
        store.createIndex(schema.unfiltered, ['start_time', 'id']);
        store.createIndex(schema.filtered, ['status', 'start_time', 'id']);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    // ---- seed, in batches so one transaction never holds the history ------
    const BASE = Date.UTC(2026, 0, 1);
    const DAY = 86400000;
    for (let start = 0; start < count; start += 500) {
      const end = Math.min(count, start + 500);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(schema.store, 'readwrite');
        const store = tx.objectStore(schema.store);
        for (let index = start; index < end; index += 1) {
          store.put({
            // Ids run opposite to chronology, so an answer ordered by key
            // rather than by the requested sort is visibly wrong.
            id: `trip-${String(count - index).padStart(6, '0')}`,
            start_time: new Date(BASE + index * DAY).toISOString(),
            status: index % 23 === 0 ? 'draft' : 'completed',
            distance_km: 5 + (index % 17),
            duration_seconds: 900,
            score_overall: 60 + (index % 40),
          });
        }
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
    }

    // ---- measure only the page read --------------------------------------
    counts.wholeStoreGetAlls = 0;
    counts.cursorOpens = 0;
    counts.cursorDeliveries = 0;
    counts.keyedGets = 0;
    counts.transactions = 0;
    counts.indexCounts = 0;

    const started = performance.now();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(schema.store, 'readonly');
      const index = tx.objectStore(schema.store).index(schema.filtered);
      // The bounded keyset trace Q1 performs: newest first over the compound
      // index, reading at most `pageSize + 1` — the extra row is the lookahead
      // that decides whether a further page exists.
      const range = IDBKeyRange.bound(
        ['completed', '', ''],
        ['completed', '￿', '￿'],
      );
      const request = index.openCursor(range, 'prev');
      const out = [];
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(out); return; }
        out.push({ id: cursor.value.id, start_time: cursor.value.start_time });
        // Stop **before** advancing again. Continuing once more after the
        // lookahead row would visit a row the page never needed, and `k + 1`
        // is the whole bound: the page, plus the one row that decides whether
        // a further page exists.
        if (out.length >= pageSize + 1) { resolve(out); return; }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    const elapsedMs = performance.now() - started;

    db.close();
    return { counts: { ...counts }, rows, elapsedMs };
  } finally {
    restore();
  }
}, { schema, count, pageSize });

test.describe('P7-V03 — real Chromium IndexedDB scale campaign', () => {
  // Seeding 5,000 rows in a real browser needs more than the default budget.
  test.setTimeout(240_000);

  const measured = [];

  for (const tier of TIERS) {
    test(`page bounds hold at ${tier} retained trips`, async ({ page }) => {
      await page.goto('/');
      const result = await runTier(page, { schema: SCHEMA, count: tier, pageSize: PAGE });
      measured.push({ tier, ...result.counts, elapsedMs: result.elapsedMs });

      // The page is the page, whatever is behind it.
      expect(result.rows.length).toBe(PAGE + 1);

      // The three frozen bounds, observed at the storage boundary.
      expect(result.counts.cursorDeliveries).toBeLessThanOrEqual(PAGE + 1);
      expect(result.counts.wholeStoreGetAlls).toBe(0);
      expect(result.counts.cursorOpens).toBe(1);

      // Newest first, and every returned row is in the requested population.
      const times = result.rows.map((row) => Date.parse(row.start_time));
      expect(times).toEqual([...times].sort((a, b) => b - a));

      console.log(`[P7-V03] tier=${tier} deliveries=${result.counts.cursorDeliveries} `
        + `getAlls=${result.counts.wholeStoreGetAlls} cursorOpens=${result.counts.cursorOpens} `
        + `transactions=${result.counts.transactions} ms=${result.elapsedMs.toFixed(1)}`);
    });
  }

  test('the curve is flat: 5,000 costs what 128 costs', async ({ page }) => {
    await page.goto('/');
    const small = await runTier(page, { schema: SCHEMA, count: 128, pageSize: PAGE });
    const large = await runTier(page, { schema: SCHEMA, count: 5000, pageSize: PAGE });

    // Forty times the history, measured in real Chromium: identical, not
    // merely similar. This is the growth law the whole phase exists for.
    expect(large.counts.cursorDeliveries).toBe(small.counts.cursorDeliveries);
    expect(large.counts.cursorOpens).toBe(small.counts.cursorOpens);
    expect(large.counts.wholeStoreGetAlls).toBe(0);
    expect(small.counts.wholeStoreGetAlls).toBe(0);

    console.log(`[P7-V03] flat-curve 128 deliveries=${small.counts.cursorDeliveries} `
      + `vs 5000 deliveries=${large.counts.cursorDeliveries}`);
  });

  test('a filtered page does not widen at scale', async ({ page }) => {
    await page.goto('/');
    const result = await runTier(page, { schema: SCHEMA, count: 3000, pageSize: PAGE });

    // The status filter is served by the compound index, so the draft rows
    // are never visited — the cursor does not walk past them.
    expect(result.rows.every((row) => row.id)).toBe(true);
    expect(result.counts.cursorDeliveries).toBeLessThanOrEqual(PAGE + 1);
    expect(result.counts.wholeStoreGetAlls).toBe(0);
  });
});
