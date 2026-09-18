import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  P7_NAMED_FILTERS,
  advanceP7QueryEpoch,
  localTripRepository,
  queryTripAdjacent,
  queryTripHistoryPage,
  queryTripTagContext,
  readP7QuerySnapshot,
  registerP7NamedFilter,
} from '@/lib/localTripRepository';
import { encodeProjectionCursor } from '@/lib/tripProjectionQuery';
import { P7_COMPLETENESS, P7_UNAVAILABLE_CODES } from '@/lib/tripQueryContracts';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 2 — Q1 with browser cursor v2, measured against **real** repository
 * code driven through an IndexedDB double, with the page bounds observed at the
 * IndexedDB boundary rather than read from the repository's own counters.
 */

const settings = () => JSON.stringify({
  settings_defaults_version: 11,
  data_retention_days: 3650,
  raw_gps_retention_days: 3650,
  privacy_zones: [],
});

let observer;
let fakeDb;

/** Raw records of a store, read straight from the double — never via the repository. */
const storeRecords = (name) => {
  const database = [...fakeDb.databases.values()][0];
  return database.stores.get(name).records;
};

/** Decode a cursor v2 token without importing the encoder's private state. */
const decodeContinuation = (token) => JSON.parse(
  Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
);

const installStorage = () => {
  const fake = new FakeIndexedDb();
  fakeDb = fake;
  observer = observeIndexedDb(fake);
  vi.stubGlobal('indexedDB', observer.factory);
  const values = new Map([['drivesense_settings', settings()]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
};

/** Seed `count` completed trips, newest last, with the requested id shape. */
const seedTrips = async (count, { numericIds = false } = {}) => {
  const ids = [];
  for (let index = 0; index < count; index += 1) {
    const id = numericIds ? 1000 + index : `trip-${String(index).padStart(3, '0')}`;
    const startTime = new Date(Date.UTC(2026, 0, 1 + index, 12)).toISOString();
    await localTripRepository.create({
      id,
      status: 'completed',
      start_time: startTime,
      end_time: startTime,
      distance_km: 5 + index,
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });
    ids.push(id);
  }
  return ids;
};

/** Page a whole history through Q1 and return the ids in delivery order. */
const pageAll = async (request = {}) => {
  const delivered = [];
  const envelopes = [];
  let cursor = null;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = await queryTripHistoryPage({ ...request, cursor });
    envelopes.push(page);
    if (page.unavailable) break;
    delivered.push(...page.data.map((row) => row.id));
    if (!page.continuation) break;
    cursor = page.continuation;
  }
  return { delivered, envelopes };
};

describe('P7 Q1 — bounded history page with cursor v2', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    P7_NAMED_FILTERS.clear();
  });

  it('pages the whole history exactly once, in order, with string ids', async () => {
    const ids = await seedTrips(7);
    const { delivered } = await pageAll({ limit: 3, status: 'completed' });

    expect(delivered).toHaveLength(ids.length);
    expect(new Set(delivered).size).toBe(ids.length);
    // Newest first is the default sort.
    expect(delivered).toEqual([...ids].reverse());
  });

  it('carries the keyset position at its stored key type, never stringified', async () => {
    const ids = await seedTrips(5, { numericIds: true });

    // The law is about the *keyset position*, which must match the type the
    // index actually holds — not about the row model, whose `id` the projection
    // schema normalizes for display.
    const storedType = typeof [...storeRecords('trips').keys()][0];
    const page = await queryTripHistoryPage({ limit: 2, status: 'completed' });
    const position = decodeContinuation(page.continuation);

    expect(position.key.t).toBe(storedType);
    expect(typeof position.key.id).toBe(storedType);

    const { delivered } = await pageAll({ limit: 2, status: 'completed' });
    expect(delivered.map(String)).toEqual([...ids].reverse().map(String));
    expect(new Set(delivered).size).toBe(ids.length);
  });

  it('keeps source rows visited bounded by the page, not by retained history', async () => {
    await seedTrips(12);

    observer.reset();
    const first = await queryTripHistoryPage({ limit: 3, status: 'completed' });
    const smallHistoryRows = observer.counts.sourceRowsVisited;

    expect(first.data).toHaveLength(3);
    // k + 1: one row past the page proves `hasMore` without reading another page.
    expect(smallHistoryRows).toBeLessThanOrEqual(3 + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    // The same fixed request against a larger history must not read more rows.
    await seedTrips(12);
    observer.reset();
    const again = await queryTripHistoryPage({ limit: 3, status: 'completed' });

    expect(again.data).toHaveLength(3);
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(3 + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  });

  it('returns EXACT with no continuation when the scan reaches the end', async () => {
    await seedTrips(2);
    const page = await queryTripHistoryPage({ limit: 10, status: 'completed' });

    expect(page.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(page.continuation).toBeNull();
    expect(page.unavailable).toBeUndefined();
    expect(page.snapshot.authority).toBe('browser');
  });

  it('distinguishes a genuinely empty complete page from an unavailable one', async () => {
    const page = await queryTripHistoryPage({ limit: 5, status: 'completed' });

    expect(page.data).toEqual([]);
    expect(page.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(page.unavailable).toBeUndefined();
  });
});

describe('P7 Q1 — the frozen public limit', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  it('refuses an out-of-range limit instead of clamping it', async () => {
    await seedTrips(3);
    for (const limit of [0, 201, 1000, 2.5, '10']) {
        const page = await queryTripHistoryPage({ limit, status: 'completed' });
      expect(page.unavailable?.code, `limit ${String(limit)}`)
        .toBe(P7_UNAVAILABLE_CODES.REQUEST_TOO_LARGE);
      expect(page.data).toBeNull();
    }
    const ok = await queryTripHistoryPage({ limit: 200, status: 'completed' });
    expect(ok.unavailable).toBeUndefined();
  });
});

describe('P7 Q1 — cursor rejection matrix (A2.5)', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  const firstPage = () => queryTripHistoryPage({ limit: 2, status: 'completed' });

  it('refuses a v1 projection cursor rather than upgrading it', async () => {
    await seedTrips(5);
    const legacy = encodeProjectionCursor({
      sort: '-start_time', status: 'completed', startTime: '2026-01-03T12:00:00.000Z', id: 'trip-002',
    });

    const page = await queryTripHistoryPage({ limit: 2, status: 'completed', cursor: legacy });

    expect(page.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_VERSION_UNSUPPORTED);
    expect(page.data).toBeNull();
  });

  it('refuses a tampered cursor before returning any row', async () => {
    await seedTrips(5);
    const page = await firstPage();
    const tampered = `${page.continuation.slice(0, -4)}AAAA`;

    const refused = await queryTripHistoryPage({ limit: 2, status: 'completed', cursor: tampered });

    expect([
      P7_UNAVAILABLE_CODES.CURSOR_MALFORMED,
      P7_UNAVAILABLE_CODES.CURSOR_RESTART_REQUIRED,
    ]).toContain(refused.unavailable?.code);
    expect(refused.data).toBeNull();
  });

  it('refuses a cursor presented against a different query', async () => {
    await seedTrips(5);
    const page = await firstPage();

    const mismatched = await queryTripHistoryPage({
      limit: 2, status: 'completed', sort: 'start_time', cursor: page.continuation,
    });

    expect(mismatched.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_QUERY_MISMATCH);
    expect(mismatched.data).toBeNull();
  });

  it('refuses an outstanding cursor after an insert, then restarts cleanly', async () => {
    const ids = await seedTrips(5);
    const page = await firstPage();
    const before = await readP7QuerySnapshot();

    await localTripRepository.create({
      id: 'trip-late',
      status: 'completed',
      start_time: new Date(Date.UTC(2026, 0, 20, 12)).toISOString(),
      end_time: new Date(Date.UTC(2026, 0, 20, 12)).toISOString(),
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });

    const after = await readP7QuerySnapshot();
    expect(after.revision).toBeGreaterThan(before.revision);

    const stale = await queryTripHistoryPage({ limit: 2, status: 'completed', cursor: page.continuation });
    expect(stale.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_RESTART_REQUIRED);
    expect(stale.data).toBeNull();

    // A restart then yields the exact oracle set once, in order.
    const { delivered } = await pageAll({ limit: 2, status: 'completed' });
    expect(delivered).toEqual(['trip-late', ...[...ids].reverse()]);
  });

  it('refuses every outstanding cursor after a delete, via the conservative epoch', async () => {
    await seedTrips(5);
    const page = await firstPage();
    const before = await readP7QuerySnapshot();

    await localTripRepository.delete('trip-000');

    const after = await readP7QuerySnapshot();
    expect(after.generation).not.toBe(before.generation);

    const stale = await queryTripHistoryPage({ limit: 2, status: 'completed', cursor: page.continuation });
    expect(stale.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_RESTART_REQUIRED);
  });

  it('advances the epoch explicitly for a bulk mutation class', async () => {
    await seedTrips(2);
    const before = await readP7QuerySnapshot();
    await advanceP7QueryEpoch('restore');
    const after = await readP7QuerySnapshot();

    expect(after.generation).not.toBe(before.generation);
    expect(after.revision).toBeGreaterThan(before.revision);
  });
});

describe('P7 Q1 — named budgeted filters (A2.7)', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  it('refuses an unregistered filter key instead of quietly ignoring it', async () => {
    await seedTrips(3);
    const page = await queryTripHistoryPage({
      limit: 2, status: 'completed', filter: { vehicleId: 'v-1' },
    });

    expect(page.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED);
    expect(page.unavailable.reason).toBe('vehicleId');
    expect(page.data).toBeNull();
  });

  it('reports PARTIAL with a continuation when the budget stops the scan short', async () => {
    await seedTrips(9);
    // A registered predicate that matches one row in three: filling a page of 3
    // would need more source rows than one page budget allows.
    registerP7NamedFilter('everyThird', (row) => /[036]$/.test(String(row.id)));

    const page = await queryTripHistoryPage({
      limit: 3, status: 'completed', filter: { everyThird: true },
    });

    expect(page.data.length).toBeLessThan(3);
    expect(page.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    // Never a short page presented as "no more results".
    expect(page.continuation).not.toBeNull();

    const { delivered } = await pageAll({ limit: 3, status: 'completed', filter: { everyThird: true } });
    expect(delivered).toEqual(['trip-006', 'trip-003', 'trip-000']);
  });

  it('serves a date range from the existing index and reports it EXACT', async () => {
    await seedTrips(10);
    const fromMs = Date.UTC(2026, 0, 4, 0);
    const toMs = Date.UTC(2026, 0, 7, 0);

    const page = await queryTripHistoryPage({
      limit: 50, status: 'completed', range: { fromMs, toMs },
    });

    expect(page.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(page.continuation).toBeNull();
    // Half-open [from, to): the 4th, 5th and 6th seeded days.
    expect(page.data.map((row) => row.id)).toEqual(['trip-005', 'trip-004', 'trip-003']);
  });
});

describe('P7 Q6 — adjacent trip', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  it('returns the neighbouring trip with one bounded window, not a list', async () => {
    await seedTrips(5);

    observer.reset();
    const older = await queryTripAdjacent('trip-002', 'previous', { status: 'completed' });

    expect(older.data.id).toBe('trip-001');
    expect(older.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(older.continuation).toBeNull();
    // One anchor point read plus one row past it — never a page of candidates.
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(2);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    const newer = await queryTripAdjacent('trip-002', 'next', { status: 'completed' });
    expect(newer.data.id).toBe('trip-003');
  });

  it('reports a proven end of history as EXACT with no row, never as unavailable', async () => {
    await seedTrips(3);
    const beyond = await queryTripAdjacent('trip-000', 'previous', { status: 'completed' });

    expect(beyond.unavailable).toBeUndefined();
    expect(beyond.data).toBeNull();
    expect(beyond.completeness).toBe(P7_COMPLETENESS.EXACT);
  });

  it('reports a missing anchor as DETAIL_NOT_FOUND with no data', async () => {
    await seedTrips(2);
    const missing = await queryTripAdjacent('trip-does-not-exist', 'previous');

    expect(missing.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.DETAIL_NOT_FOUND);
    expect(missing.data).toBeNull();
  });
});

describe('P7 Q7 — bounded tag context', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  it('serves tag inference from one capped page and says it is capped', async () => {
    await seedTrips(8);

    observer.reset();
    const context = await queryTripTagContext({ maxRecent: 3 });

    expect(context.data.cappedAt).toBe(3);
    expect(context.data.trips).toHaveLength(3);
    expect(context.completeness).toBe(P7_COMPLETENESS.EXACT);
    // An explicitly capped contract owns no continuation and must not invent one.
    expect(context.continuation).toBeNull();
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(3 + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  });
});
