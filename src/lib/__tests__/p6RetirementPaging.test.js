import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (_key, fallback = null) => fallback),
  setJson: vi.fn(async () => {}),
  removeJson: vi.fn(async () => {}),
}));

import { P6_TRIP_DERIVED_STORES, openP6TripDerivedDatabase } from '@/lib/localTripRepository';
import { __testables } from '@/lib/p6TripDerivedState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const { deleteSupersededPage } = __testables;

/**
 * DPD-015 — a paged retirement must survive being resumed.
 *
 * `deleteSupersededPage` pages with `cursor.continuePrimaryKey(tripId, afterPrimaryKey)`.
 * The previous page deletes rows, so the reopened cursor can already sit at or
 * beyond the resume key — and `continuePrimaryKey` only moves forward. Real
 * IndexedDB answers that with
 *
 *   DataError: Failed to execute 'continuePrimaryKey' on 'IDBCursor':
 *   The parameter is less than or equal to this cursor's position.
 *
 * which rejected the retirement turn. The coordinator counts a rejected turn as
 * a failure, so the trip-derived job stopped being admitted and D1 advanced
 * roughly one subject per external lifecycle event. On an A54 at 500 trips that
 * left D1 at 199/500 with the Dashboard on its 200-trip bounded fallback.
 *
 * The `FakeIndexedDb` double used to accept the illegal call, which is exactly
 * why no suite caught this; it now enforces the spec constraint, so this
 * reproduces the device failure in-process.
 */
describe('DPD-015 paged superseded-row retirement resumes instead of throwing', () => {
  let indexedDb;
  const TRIP = 'paged-retire';

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_n, _o, operation) => operation({ name: 'x' }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /** `count` superseded rows plus a few current ones that must survive. */
  const seed = async ({ stale, current }) => {
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS);
    for (let index = 0; index < stale; index += 1) {
      store.put({
        key: `${TRIP}:stale:${String(index).padStart(4, '0')}`, tripId: TRIP,
        sourceBinding: 'browser', sourceRevision: 'stale-revision',
        ordinal: index, payload: { encrypted: true }, encodedBytes: 16, updatedAt: 1,
      });
    }
    for (let index = 0; index < current; index += 1) {
      store.put({
        key: `${TRIP}:current:${String(index).padStart(4, '0')}`, tripId: TRIP,
        sourceBinding: 'browser', sourceRevision: 'current-revision',
        ordinal: index, payload: { encrypted: true }, encodedBytes: 16, updatedAt: 1,
      });
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  };

  const rows = async () => {
    const db = await openP6TripDerivedDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'readonly')
          .objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  };

  /** Page exactly the way `retireSupersededTurn` does, carrying the cursor forward. */
  const drainPages = async (limit) => {
    let after = null;
    const pages = [];
    for (let page = 0; page < 200; page += 1) {
      const db = await openP6TripDerivedDatabase();
      let result;
      try {
        const tx = db.transaction(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'readwrite');
        result = await deleteSupersededPage(
          tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).index('by_trip'),
          TRIP, 'current-revision', after, limit,
        );
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
      pages.push(result);
      if (!result.hasMore) return pages;
      after = result.lastPrimaryKey;
    }
    throw new Error('paging did not terminate');
  };

  /**
   * The device case. Every row before the resume key is deleted by the first
   * page, so the reopened cursor lands *past* `afterPrimaryKey` and asking
   * `continuePrimaryKey` to go back there is a DataError. Survivors ahead of the
   * resume point (the `current: 5` case below) mask this by keeping the cursor
   * behind it, which is why a mixed fixture alone does not reproduce it.
   */
  it('resumes when the whole previous page was deleted, instead of raising DataError', async () => {
    await seed({ stale: 300, current: 0 });

    const pages = await drainPages(64);

    expect(pages.length, 'the scenario must actually page').toBeGreaterThan(1);
    expect(await rows()).toHaveLength(0);
  }, 60_000);

  it('resumes across pages and keeps rows of the current revision', async () => {
    await seed({ stale: 300, current: 5 });

    const pages = await drainPages(64);

    expect(pages.length, 'the scenario must actually page').toBeGreaterThan(1);
    const remaining = await rows();
    expect(remaining.filter((row) => row.sourceRevision === 'stale-revision')).toHaveLength(0);
    expect(remaining.filter((row) => row.sourceRevision === 'current-revision')).toHaveLength(5);
  }, 60_000);

  it('never scans more than the page limit in one call', async () => {
    await seed({ stale: 300, current: 5 });
    const pages = await drainPages(64);
    for (const page of pages) expect(page.scanned).toBeLessThanOrEqual(64);
  }, 60_000);

  it('makes forward progress on every page, so paging always terminates', async () => {
    await seed({ stale: 300, current: 5 });
    const pages = await drainPages(64);
    // A page that scanned nothing while reporting more work would spin forever.
    for (const page of pages.slice(0, -1)) expect(page.scanned).toBeGreaterThan(0);
  }, 60_000);

  it('keeps current-revision rows when there is nothing superseded to remove', async () => {
    await seed({ stale: 0, current: 20 });
    await drainPages(64);
    expect(await rows()).toHaveLength(20);
  }, 60_000);
});
