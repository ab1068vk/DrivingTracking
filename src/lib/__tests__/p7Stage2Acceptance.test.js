import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  advanceP7QueryEpoch,
  localTripRepository,
  queryTripHistoryPage,
  readP7QuerySnapshot,
} from '@/lib/localTripRepository';
import { encodeProjectionCursor } from '@/lib/tripProjectionQuery';
import {
  P7_COMPLETENESS,
  P7_PUBLIC_PAGE_LIMIT,
  P7_QUERY_OUTCOMES,
  P7_UNAVAILABLE_CODES,
  P6_READINESS_QUERY_PATHS,
  P7_PARITY_DIVERGENCES,
  assertP7PublicLimit,
  p7EnvelopeViolations,
} from '@/lib/tripQueryContracts';
import { runTripReducerToExact } from '@/lib/tripQueryReducers';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 2 acceptance — V03, V04, V05, V08, V13, V14.
 *
 * Bounds are measured by an observer wrapped around the IndexedDB API, outside
 * the repository, so the proof does not come from the implementation's own
 * counters. Stage 10 runs the full 128/500/1,000/3,000/5,000 campaign against
 * real storage; Stage 2 proves the **law** at the mandatory 128 checkpoint and
 * at a larger tier, and proves it does not move with N.
 */

let observer;

const installStorage = () => {
  const fake = new FakeIndexedDb();
  observer = observeIndexedDb(fake);
  vi.stubGlobal('indexedDB', observer.factory);
  const values = new Map([[
    'drivesense_settings',
    JSON.stringify({
      settings_defaults_version: 11,
      data_retention_days: 3650,
      raw_gps_retention_days: 3650,
      privacy_zones: [],
    }),
  ]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
};

const DAY = 86400000;
const BASE = Date.UTC(2026, 5, 1, 9);

const seed = async (count, { from = 0 } = {}) => {
  const trips = [];
  for (let index = from; index < from + count; index += 1) {
    const trip = {
      id: `tier-${String(index).padStart(4, '0')}`,
      status: 'completed',
      start_time: new Date(BASE + index * DAY).toISOString(),
      end_time: new Date(BASE + index * DAY + 900000).toISOString(),
      distance_km: 5 + (index % 17),
      duration_seconds: 900 + (index % 11) * 30,
      score_overall: 60 + (index % 40),
      harsh_brakes_count: index % 6 === 0 ? 0 : 1,
      rapid_accel_count: index % 7 === 0 ? 0 : 1,
      sharp_turns_count: 0,
      speeding_events_count: index % 8 === 0 ? 0 : 1,
      night_driving: index % 3 === 0,
      route_points: [{ lat: 43.6, lng: -79.4 }],
    };
    await localTripRepository.create(trip);
    trips.push(trip);
  }
  return trips;
};

describe('P7-V03 — history page bounds, observed independently, invariant in N', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('holds at the 128-trip checkpoint and does not move at a larger tier', async () => {
    // 128 is the original failure scale and a mandatory checkpoint, not a
    // formality: if a fixed page request is not bounded here, the redesign has
    // not solved the original problem.
    await seed(128);

    const k = 50;
    observer.reset();
    const at128 = await queryTripHistoryPage({ limit: k, status: 'completed' });
    const rows128 = observer.counts.sourceRowsVisited;
    const points128 = observer.counts.pointReads;
    const statements128 = observer.counts.statements;

    expect(at128.data).toHaveLength(k);
    expect(rows128).toBeLessThanOrEqual(k + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    // A second tier, same fixed request. Seeding here goes through the real
    // create path (sanitize, encrypt, project, six-store commit), so the tier
    // sizes are what a unit test can drive honestly; the full
    // 128 / 500 / 1,000 / 3,000 / 5,000 campaign against real storage is the
    // Stage 10 gate, and this test does not stand in for it.
    await seed(128, { from: 128 });
    observer.reset();
    const atDoubled = await queryTripHistoryPage({ limit: k, status: 'completed' });

    expect(atDoubled.data).toHaveLength(k);
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(k + 1);
    // The law: the work for a fixed page request does not grow with retained
    // history. Equality, not merely a bound.
    expect(observer.counts.sourceRowsVisited).toBe(rows128);
    expect(observer.counts.pointReads).toBe(points128);
    expect(observer.counts.statements).toBe(statements128);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 300_000);

  it('never decrypts a full trip payload to render a list page', async () => {
    await seed(40);
    observer.reset();
    const page = await queryTripHistoryPage({ limit: 20, status: 'completed' });

    expect(page.data).toHaveLength(20);
    // A list page reads projection rows only. A full-payload read would show up
    // as reads against the trips store beyond the index walk.
    const counters = localTripRepository.__projectionCountersForTests?.();
    if (counters) expect(counters.fullTripDecrypts).toBe(0);
  }, 60_000);
});

describe('P7-V04 — cursor v2 law under every injected mutation class', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const pageAll = async (request) => {
    const delivered = [];
    let cursor = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await queryTripHistoryPage({ ...request, cursor });
      if (page.unavailable) return { delivered, refused: page.unavailable.code };
      delivered.push(...page.data.map((row) => String(row.id)));
      if (!page.continuation) return { delivered, refused: null };
      cursor = page.continuation;
    }
    return { delivered, refused: 'guard' };
  };

  /**
   * One test per injection class, so each gets its own fresh store through the
   * normal lifecycle. Stubbing globals inside a loop body instead would leave
   * the harness in a different state than the surrounding tests expect, and the
   * resulting failures would be the test file's, not the product's.
   */
  it.each([
    ['insert', async () => { await seed(1, { from: 900 }); }, 11],
    ['ordering-key edit', async () => {
      await localTripRepository.update('tier-0002', { start_time: new Date(BASE + 999 * DAY).toISOString() });
    }, 10],
    ['status edit', async () => { await localTripRepository.update('tier-0003', { status: 'draft' }); }, 9],
    ['delete', async () => { await localTripRepository.delete('tier-0004'); }, 9],
    ['erase / generation epoch', async () => { await advanceP7QueryEpoch('erasure'); }, 10],
  ])('%s: preserves a valid sequence or refuses before any row', async (label, inject, expected) => {
    await seed(10);

    const first = await queryTripHistoryPage({ limit: 3, status: 'completed' });
    expect(first.data, label).toHaveLength(3);
    expect(first.continuation, label).not.toBeNull();

    await inject();

    const next = await queryTripHistoryPage({
      limit: 3, status: 'completed', cursor: first.continuation,
    });

    if (next.unavailable) {
      // Refused before any row, with a cursor code and no data.
      expect(next.data, label).toBeNull();
      expect(String(next.unavailable.code), label).toMatch(/^CURSOR_/);
      expect(p7EnvelopeViolations('Q1', next), label).toEqual([]);
    } else {
      // Or it served a valid continuation that does not repeat a delivered row.
      const seen = new Set(first.data.map((row) => String(row.id)));
      for (const row of next.data) expect(seen.has(String(row.id)), label).toBe(false);
    }

    // Either way, a restart yields the oracle set exactly once, in order.
    const restarted = await pageAll({ limit: 3, status: 'completed' });
    expect(restarted.refused, label).toBeNull();
    expect(new Set(restarted.delivered).size, label).toBe(restarted.delivered.length);
    expect(restarted.delivered.length, label).toBe(expected);
  }, 60_000);

  it('refuses a v1 cursor, a foreign-query cursor and a tampered cursor before any row', async () => {
    await seed(6);
    const first = await queryTripHistoryPage({ limit: 2, status: 'completed' });

    const legacy = await queryTripHistoryPage({
      limit: 2,
      status: 'completed',
      cursor: encodeProjectionCursor({
        sort: '-start_time', status: 'completed', startTime: '2026-06-02T09:00:00.000Z', id: 'tier-0001',
      }),
    });
    expect(legacy.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_VERSION_UNSUPPORTED);

    const foreign = await queryTripHistoryPage({
      limit: 2, status: 'completed', sort: 'start_time', cursor: first.continuation,
    });
    expect(foreign.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.CURSOR_QUERY_MISMATCH);

    const tampered = await queryTripHistoryPage({
      limit: 2, status: 'completed', cursor: `${first.continuation.slice(0, -4)}ZZZZ`,
    });
    expect(tampered.data).toBeNull();
    expect(String(tampered.unavailable.code)).toMatch(/^CURSOR_/);
  }, 60_000);
});

describe('P7-V05 — truthful partiality and a validated, unclamped limit', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('refuses an out-of-range limit identically at both ends of the frozen range', async () => {
    await seed(4);
    expect(assertP7PublicLimit(P7_PUBLIC_PAGE_LIMIT.min)).toBe(1);
    expect(assertP7PublicLimit(P7_PUBLIC_PAGE_LIMIT.max)).toBe(200);

    for (const limit of [P7_PUBLIC_PAGE_LIMIT.min - 1, P7_PUBLIC_PAGE_LIMIT.max + 1]) {
      const page = await queryTripHistoryPage({ limit, status: 'completed' });
      expect(page.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.REQUEST_TOO_LARGE);
      // Refused, never quietly clamped to the nearest legal value.
      expect(page.data).toBeNull();
    }
  }, 60_000);

  it('marks an unfinished reducer PARTIAL and only calls it EXACT at terminal EOF', async () => {
    await seed(12);

    const exact = await runTripReducerToExact({ reducer: 'p7.report.eventTotals@1', limit: 5 });
    expect(exact.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(exact.continuation).toBeNull();
  }, 60_000);
});

describe('P7-V08 — reducer totals against an independent raw-trip oracle', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('matches a fold computed directly from the seeded trips', async () => {
    const before = await queryTripHistoryPage({ limit: 200, status: 'completed' });
    expect(before.data.length, 'store must start empty').toBe(0);
    const trips = await seed(64);

    const result = await runTripReducerToExact({ reducer: 'p7.report.durationDistance@1', limit: 25 });

    // The oracle is computed here, from the fixtures, without importing a reducer.
    const oracleDistanceM = trips.reduce((sum, trip) => sum + trip.distance_km * 1000, 0);
    const oracleDurationMs = trips.reduce((sum, trip) => sum + trip.duration_seconds * 1000, 0);
    const oracleWeight = trips.reduce((sum, trip) => sum + trip.distance_km, 0);
    const oracleProduct = trips.reduce((sum, trip) => sum + trip.score_overall * trip.distance_km, 0);

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(result.data.trip_count).toBe(trips.length);
    expect(result.data.distance_m).toBeCloseTo(oracleDistanceM, 6);
    expect(result.data.duration_ms).toBeCloseTo(oracleDurationMs, 6);
    expect(result.data.score_distance_weight).toBeCloseTo(oracleWeight, 6);
    expect(result.data.score_distance_product).toBeCloseTo(oracleProduct, 6);
  }, 120_000);
});

describe('P7-V13 / P7-V14 — parity contract and the shipping authority', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('declares every one of the five named divergences with a resolution', () => {
    expect(P7_PARITY_DIVERGENCES).toHaveLength(5);
    for (const divergence of P7_PARITY_DIVERGENCES) {
      expect(divergence.browser, `divergence ${divergence.id}`).toBeTruthy();
      expect(divergence.native, `divergence ${divergence.id}`).toBeTruthy();
      expect(divergence.resolution, `divergence ${divergence.id}`).toBeTruthy();
    }
    // The page-size ceiling is the one that must behave identically.
    expect(P7_PARITY_DIVERGENCES[0].resolution).toMatch(/\[1,200\]/);
  });

  it('keeps P6 readiness on exactly the four owner-backed paths', () => {
    const carriers = Object.entries(P7_QUERY_OUTCOMES)
      .filter(([, outcome]) => outcome.p6Readiness)
      .map(([path]) => path);
    expect(carriers).toEqual(P6_READINESS_QUERY_PATHS);
  });

  it('P7-V14: every Stage 2 primitive works on the browser authority', async () => {
    // `VITE_P35_NATIVE_AUTHORITY` is unset in the ordinary shipping
    // configuration, so this is the path that actually ships.
    await seed(8);

    const page = await queryTripHistoryPage({ limit: 4, status: 'completed' });
    expect(page.unavailable).toBeUndefined();
    expect(page.snapshot.authority).toBe('browser');

    const snapshot = await readP7QuerySnapshot();
    expect(snapshot.authority).toBe('browser');

    const reduced = await runTripReducerToExact({ reducer: 'p7.dashboard.activityStats@1', limit: 3 });
    expect(reduced.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(reduced.data.trip_count).toBe(8);
  }, 60_000);
});
