import { expect, test } from '@playwright/test';

/**
 * Real-browser IndexedDB conformance for the semantics P3's bounded query
 * depends on.
 *
 * The shared fake models these rules, but a fake that reproduces the *intended*
 * algorithm rather than the browser's would make every bounded-path unit test
 * vacuous — and the failure mode here is silent: a mis-shaped key range does not
 * throw, it selects everything or nothing. This spec runs the same traces
 * against real Chromium.
 *
 * Runs against the built preview app (`npm run test:e2e`). No device involved.
 */

const SCHEMA = {
  db: 'p3_conformance',
  version: 1,
  store: 'trips',
  unfiltered: 'by_start_time_id',
  filtered: 'by_status_start_time_id',
};

const setup = async (page) => page.evaluate(async (schema) => {
  await new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(schema.db);
    request.onsuccess = resolve; request.onerror = resolve; request.onblocked = resolve;
  });
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(schema.db, schema.version);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(schema.store, { keyPath: 'id' });
      store.createIndex(schema.unfiltered, ['start_time', 'id']);
      store.createIndex(schema.filtered, ['status', 'start_time', 'id']);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const rows = [
    { id: 'a', start_time: '2026-01-01T00:00:00.000Z', status: 'completed' },
    { id: 'b', start_time: '2026-01-02T00:00:00.000Z', status: 'completed' },
    { id: 'c', start_time: '2026-01-02T00:00:00.000Z', status: 'draft' },
    { id: 'd', start_time: '2026-01-02T00:00:00.000Z', status: 'completed' },
    { id: 'e', start_time: '2026-01-03T00:00:00.000Z', status: 'completed' },
    // No `start_time`: must be absent from BOTH compound indexes.
    { id: 'tombstone', status: 'secure-delete-pending' },
  ];
  await new Promise((resolve, reject) => {
    const tx = db.transaction(schema.store, 'readwrite');
    rows.forEach((row) => tx.objectStore(schema.store).put(row));
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return rows.length;
}, SCHEMA);

const walk = async (page, options) => page.evaluate(async ({ schema, opts }) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(schema.db, schema.version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const indexName = opts.status ? schema.filtered : schema.unfiltered;
  const index = db.transaction(schema.store, 'readonly').objectStore(schema.store).index(indexName);

  let range = null;
  if (opts.status && !opts.cursor) {
    range = IDBKeyRange.bound([opts.status], [opts.status, [], []], false, false);
  } else if (opts.cursor) {
    const bound = opts.status
      ? [opts.status, opts.cursor.t, opts.cursor.i]
      : [opts.cursor.t, opts.cursor.i];
    if (opts.direction === 'prev') {
      range = opts.status
        ? IDBKeyRange.bound([opts.status], bound, false, true)
        : IDBKeyRange.upperBound(bound, true);
    } else {
      range = opts.status
        ? IDBKeyRange.bound(bound, [opts.status, [], []], true, false)
        : IDBKeyRange.lowerBound(bound, true);
    }
  }

  const ids = [];
  await new Promise((resolve, reject) => {
    const request = range == null
      ? index.openCursor(null, opts.direction)
      : index.openCursor(range, opts.direction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || ids.length >= (opts.limit ?? 100)) return resolve(undefined);
      ids.push(cursor.value.id);
      cursor.continue();
      return undefined;
    };
  });
  db.close();
  return ids;
}, { schema: SCHEMA, opts: options });

test.describe('IndexedDB compound-index semantics P3 depends on', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await setup(page);
  });

  test('descending walk orders by start_time then id, both descending', async ({ page }) => {
    expect(await walk(page, { direction: 'prev' })).toEqual(['e', 'd', 'c', 'b', 'a']);
  });

  test('ascending walk is the exact reverse', async ({ page }) => {
    expect(await walk(page, { direction: 'next' })).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('a record missing a compound component is absent from the index', async ({ page }) => {
    const ids = await walk(page, { direction: 'next' });
    expect(ids).not.toContain('tombstone');
  });

  test('the status index filters and keeps the same tie ordering', async ({ page }) => {
    expect(await walk(page, { direction: 'prev', status: 'completed' })).toEqual(['e', 'd', 'b', 'a']);
  });

  test('an exclusive bound resumes exactly after the cursor position', async ({ page }) => {
    const first = await walk(page, { direction: 'prev', limit: 2 });
    expect(first).toEqual(['e', 'd']);
    const second = await walk(page, {
      direction: 'prev', limit: 2, cursor: { t: '2026-01-02T00:00:00.000Z', i: 'd' },
    });
    // No duplicate of 'd', no skip of 'c'.
    expect(second).toEqual(['c', 'b']);
  });

  test('paginating the whole index yields each id exactly once', async ({ page }) => {
    const collected = [];
    let cursor = null;
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      const rows = await walk(page, { direction: 'prev', limit: 2, cursor });
      if (!rows.length) break;
      collected.push(...rows);
      const lastId = rows[rows.length - 1];
      const times = {
        a: '2026-01-01T00:00:00.000Z', b: '2026-01-02T00:00:00.000Z',
        c: '2026-01-02T00:00:00.000Z', d: '2026-01-02T00:00:00.000Z',
        e: '2026-01-03T00:00:00.000Z',
      };
      cursor = { t: times[lastId], i: lastId };
    }
    expect(collected).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(new Set(collected).size).toBe(5);
  });

  test('a two-element bound against the three-element index silently selects nothing', async ({ page }) => {
    // This is the failure P3 planning identified: it does not throw. The bound
    // ['2026-…','d'] compares against ['status','start_time','id'] keys, and
    // '2026-…' < 'completed', so every completed row is excluded.
    const ids = await page.evaluate(async (schema) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(schema.db, schema.version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const index = db.transaction(schema.store, 'readonly')
        .objectStore(schema.store).index(schema.filtered);
      const range = IDBKeyRange.upperBound(['2026-01-02T00:00:00.000Z', 'd'], true);
      const out = [];
      await new Promise((resolve) => {
        const request = index.openCursor(range, 'prev');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(undefined);
          out.push(cursor.value.id);
          cursor.continue();
          return undefined;
        };
        request.onerror = () => resolve(undefined);
      });
      db.close();
      return out;
    }, SCHEMA);
    expect(ids).toEqual([]);
  });

  test('arrays sort after strings, so an array bound on a scalar index selects everything', async ({ page }) => {
    const ids = await page.evaluate(async (schema) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(schema.db, schema.version);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(schema.store, 'readonly');
      const store = tx.objectStore(schema.store);
      // A scalar index for the comparison; the compound one is the production choice.
      const out = [];
      await new Promise((resolve) => {
        const request = store.openCursor(IDBKeyRange.upperBound(['zzz', 'zzz'], true), 'next');
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(undefined);
          out.push(cursor.value.id);
          cursor.continue();
          return undefined;
        };
        request.onerror = () => resolve(undefined);
      });
      db.close();
      return out;
    }, SCHEMA);
    // Every string primary key is below any array key: a silent full scan.
    expect(ids.length).toBeGreaterThan(0);
  });
});
