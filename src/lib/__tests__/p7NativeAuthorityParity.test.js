import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P7-IMPL-F05 — the native authority's P7 query paths, and V08/V13 parity.
 *
 * Codex found `p7BrowserOnly` returning `AUTHORITY_UNAVAILABLE` with a
 * `*_native_pending` reason for every query, so the native half of the frozen
 * contract had never run. This exercises the opt-in native-authority
 * configuration as software: the archive bridge is a controllable double over
 * the **real** native contract shapes, and the same questions are put to both
 * authorities.
 *
 * This is not device work. It proves the facade, the envelopes, the §C2
 * conversions and the reducer parity; Android instrumentation on hardware
 * remains a separate, excluded campaign.
 */

const DAY = 86400000;
const BASE = Date.UTC(2026, 4, 1, 9);

/** Rows both authorities answer from, so a difference is a real difference. */
const TRIPS = Array.from({ length: 40 }, (_, index) => ({
  id: `trip-${String(40 - index).padStart(4, '0')}`,
  status: index % 11 === 0 ? 'draft' : 'completed',
  driver_metric_eligible: true,
  start_time: new Date(BASE + index * DAY).toISOString(),
  end_time: new Date(BASE + index * DAY + 900000).toISOString(),
  distance_km: 5 + (index % 13),
  duration_seconds: 600 + (index % 7) * 120,
  score_overall: 60 + (index % 35),
  score_confidence: 0.9,
  night_driving: index % 3 === 0,
  harsh_brakes_count: index % 4,
  rapid_accel_count: index % 3,
  sharp_turns_count: index % 5,
  speeding_events_count: index % 6,
  vehicle_id: index % 2 === 0 ? 'car-a' : 'car-b',
  route_points: [{ lat: 43.6, lng: -79.4 }, { lat: 43.61, lng: -79.41 }],
}));

const completed = TRIPS.filter((trip) => trip.status === 'completed');

/** A whole-UTC-day boundary, which is the only window Q4's buckets express. */
const DAY_ALIGNED = Math.floor(BASE / DAY) * DAY;

/**
 * The archive bridge double - the **faithful** one (P7-IMPL-F05).
 *
 * The double this replaced was written from the facade's expectations rather
 * than from the Java: it answered `tripCount` where the repository emits
 * `liveCount`, read `limit` where the repository reads `maxBuckets`, returned
 * `items` where the plugin returns `recent`, and handed the reducers projection
 * fields the page path never copied. It agreed with the facade about five
 * things Android does not do, and the suite was green throughout.
 *
 * `createNativeArchiveDouble` transcribes the repository's behaviour instead,
 * and `p7NativeWireContract.test.js` checks the argument and result names
 * against the Java sources directly.
 */
const { createNativeArchiveDouble } = await import('./helpers/p7NativeArchiveDouble.js');

const source = createNativeArchiveDouble(TRIPS);

/** Spy shims, so the existing call-site assertions keep working. */
const archive = {
  counters: source.counters,
  state: source.state,
  health: vi.fn((...args) => source.health(...args)),
  queryHistoryPage: vi.fn((...args) => source.queryHistoryPage(...args)),
  aggregates: vi.fn((...args) => source.aggregates(...args)),
  chartBuckets: vi.fn((...args) => source.chartBuckets(...args)),
  adjacent: vi.fn((...args) => source.adjacent(...args)),
  tagContext: vi.fn((...args) => source.tagContext(...args)),
  overview: vi.fn((...args) => source.overview(...args)),
};

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: new Proxy({}, { get: (_target, key) => archive[key] }),
}));

let nativeFacade;
let browserReducers;
let P7_COMPLETENESS;
let p7EnvelopeViolations;

beforeEach(async () => {
  vi.clearAllMocks();
  nativeFacade = await import('@/lib/nativeTripQueryFacade');
  browserReducers = await import('@/lib/tripQueryReducers');
  ({ P7_COMPLETENESS, p7EnvelopeViolations } = await import('@/lib/tripQueryContracts'));
});

afterEach(() => { vi.restoreAllMocks(); });

describe('P7-IMPL-F05 — every native P7 path answers its frozen envelope', () => {
  it('Q1 pages the native archive, in order, through a real cursor', async () => {
    const first = await nativeFacade.queryTripHistoryPage({ limit: 10, status: 'completed' });

    expect(first.unavailable ?? null).toBeNull();
    expect(p7EnvelopeViolations('Q1', first)).toEqual([]);
    expect(first.data).toHaveLength(10);
    expect(first.continuation).not.toBeNull();
    expect(first.snapshot.authority).toBe('native');
    // Generation and committed sequence bind the page, so a cursor minted
    // under one snapshot cannot be answered under another.
    expect(first.snapshot.generation).toBe('gen-7');
    expect(first.snapshot.revision).toBe(4211);

    const second = await nativeFacade.queryTripHistoryPage({
      limit: 10, status: 'completed', cursor: first.continuation,
    });
    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(20);

    // Newest first, and the seeded ids run the other way, so a key-ordered
    // answer would be visibly wrong.
    const times = first.data.map((row) => Date.parse(row.start_time));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('Q1 filters by vehicle over the native index, not in memory', async () => {
    const page = await nativeFacade.queryTripHistoryPage({
      limit: 50, status: 'completed', filter: { vehicleId: 'car-a' },
    });

    expect(page.data.every((row) => row.vehicle_id === 'car-a')).toBe(true);
    // The filter reached the bridge: it is a query parameter, not a post-filter.
    expect(archive.queryHistoryPage).toHaveBeenCalledWith(
      expect.objectContaining({ vehicleId: 'car-a', status: 'completed' })
    );
  });

  it('Q1 refuses a public limit outside [1, 200] and an unknown filter', async () => {
    const tooWide = await nativeFacade.queryTripHistoryPage({ limit: 500 });
    expect(tooWide.unavailable.code).toBe('REQUEST_TOO_LARGE');
    expect(tooWide.data).toBeNull();

    const unknown = await nativeFacade.queryTripHistoryPage({ limit: 10, filter: { favourite: true } });
    expect(unknown.unavailable.code).toBe('FILTER_UNSUPPORTED');
    expect(unknown.data).toBeNull();
    expect(p7EnvelopeViolations('Q1', unknown)).toEqual([]);
  });

  it('Q4 refuses a lifetime completed-only total instead of scanning for it', async () => {
    // `trip_aggregate_totals` is all-live. Answering from it would be a
    // different question, and scanning `trip_current` behind a bounded-looking
    // call is exactly what the contract forbids.
    const lifetime = await nativeFacade.queryP6AnalyticsAggregate({ scope: 'global' });

    expect(lifetime.unavailable.code).toBe('FILTER_UNSUPPORTED');
    expect(lifetime.data).toBeNull();
    expect(lifetime.continuation).toBeNull();
    expect(p7EnvelopeViolations('Q4', lifetime)).toEqual([]);
    expect(archive.aggregates).not.toHaveBeenCalled();
  });

  it('Q4 answers a bucket-bounded window exactly, in normalized units', async () => {
    // Whole UTC days: the bucket key is a UTC day, so only a day-aligned window
    // is expressible by it exactly.
    const range = { fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 20 * DAY };
    const result = await nativeFacade.queryP6AnalyticsAggregate({ scope: 'global', ...range });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);

    const oracle = completed.filter((row) => {
      const at = Date.parse(row.start_time);
      return at >= range.fromMs && at < range.toMs;
    });
    expect(result.data.totals.completedCount).toBe(oracle.length);
    // The discriminator: the bucket owner served it, not a row scan.
    expect(archive.aggregates).not.toHaveBeenCalled();
    expect(source.counters.rowsScanned).toBe(0);
    // §C2 written out: km at the source, metres internally.
    expect(result.data.totals.totalKm)
      .toBeCloseTo(oracle.reduce((sum, row) => sum + row.distance_km, 0), 6);
    expect(result.data.totals.totalMeters).toBeCloseTo(result.data.totals.totalKm * 1000, 6);
    // §C2: seconds at the source, milliseconds internally.
    expect(result.data.totals.totalDurationMs)
      .toBeCloseTo(oracle.reduce((sum, row) => sum + row.duration_seconds, 0) * 1000, 6);
  });

  it('Q5 returns normalized day buckets and a truthful truncation', async () => {
    const range = { fromMs: BASE, toMs: BASE + 40 * DAY };
    const full = await nativeFacade.queryP6AnalyticsDayBuckets(range);

    expect(full.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(p7EnvelopeViolations('Q5', full)).toEqual([]);
    expect(full.data.buckets.length).toBeGreaterThan(0);
    for (const bucket of full.data.buckets) {
      expect(bucket.totalMeters).toBeCloseTo(bucket.totalKm * 1000, 6);
    }

    const capped = await nativeFacade.queryP6AnalyticsDayBuckets({
      fromMs: BASE, toMs: BASE + 10 * DAY, limit: 5,
    });
    expect(capped.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    // PARTIAL implies a real continuation — here the next bucket range.
    expect(capped.continuation).not.toBeNull();
    expect(p7EnvelopeViolations('Q5', capped)).toEqual([]);
  });

  it('Q6 and Q7 answer their bounded contracts', async () => {
    const ordered = [...completed].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
    const adjacent = await nativeFacade.queryTripAdjacent(ordered[0].id, 'previous', { status: 'completed' });
    expect(p7EnvelopeViolations('Q6', adjacent)).toEqual([]);
    expect(adjacent.completeness).toBe(P7_COMPLETENESS.EXACT);

    const tags = await nativeFacade.queryTripTagContext({ maxRecent: 12 });
    expect(p7EnvelopeViolations('Q7', tags)).toEqual([]);
    expect(tags.data.cappedAt).toBe(12);
    expect(tags.data.trips).toHaveLength(12);
    // Tag context carries tag fields and the route key, and nothing else.
    expect(Object.keys(tags.data.trips[0]).sort())
      .toEqual(['id', 'route_key', 'start_time', 'tag', 'tag_sources', 'tags']);
  });

  it('Q8 hydrates exactly its page, with a constant number of crossings', async () => {
    archive.overview.mockClear();
    const page = await nativeFacade.queryTripGeometryPage({ limit: 6, maxPoints: 2 });

    expect(p7EnvelopeViolations('Q8', page)).toEqual([]);
    expect(page.data).toHaveLength(6);
    // One overview read per selected row, never a full payload open.
    expect(archive.overview).toHaveBeenCalledTimes(6);
    expect(page.data.every((row) => row.geometry.route_points.length <= 2)).toBe(true);
  });

  it('Q9 carries the P6 owner readiness object, not a locally invented one', async () => {
    // The archive's recovery state gates the answer; it is NOT readiness.
    // Readiness has exactly one owner on both authorities (Annex A and C),
    // and Q9 carries `normalizeP6Readiness` output unmodified.
    const previous = source.state.recoveryState;
    source.state.recoveryState = 'RECOVERY_REQUIRED';
    const notReady = await nativeFacade.queryAchievementSurfaces({}, {});
    source.state.recoveryState = previous;

    expect(notReady.unavailable.code).toBe('OWNER_NOT_READY');
    expect(notReady.unavailable.reason).toBe('native_archive_not_healthy');
    expect(notReady.data).toBeNull();

    const { normalizeP6Readiness } = await import('@/lib/p6Contracts');
    expect(Object.keys(notReady.p6Readiness).sort())
      .toEqual(Object.keys(normalizeP6Readiness({ domain: 'D1' })).sort());
    expect(p7EnvelopeViolations('Q9', notReady)).toEqual([]);
  });

  it('a bridge failure is a typed outcome, never a fall-through', async () => {
    archive.queryHistoryPage.mockRejectedValueOnce(new Error('device low space'));
    const lowSpace = await nativeFacade.queryTripHistoryPage({ limit: 10 });
    expect(lowSpace.unavailable.code).toBe('STORAGE_UNAVAILABLE');
    expect(lowSpace.data).toBeNull();

    archive.queryHistoryPage.mockRejectedValueOnce(new Error('RECOVERY_REQUIRED'));
    const recovery = await nativeFacade.queryTripHistoryPage({ limit: 10 });
    expect(recovery.unavailable.code).toBe('RECOVERY_REQUIRED');
  });
});

describe('P7-V13 — the two authorities answer the same questions the same way', () => {
  /** Fold a reducer over the browser rows, as the browser runner does. */
  const browserFold = async (identity, rows) => {
    const { P7_REDUCER_IMPLEMENTATIONS } = browserReducers;
    const { P7_POPULATION_PREDICATES } = await import('@/lib/queryReducers/populations');
    const implementation = P7_REDUCER_IMPLEMENTATIONS[identity];
    const predicate = P7_POPULATION_PREDICATES[implementation.population];
    return implementation.finish(
      rows.filter((row) => predicate(row, {}))
        .reduce((acc, row) => implementation.fold(acc, row, {}), implementation.init({}))
    );
  };

  it('Q10 over native pages equals the same reducer over the same rows', async () => {
    // The identical registered implementations, driven by the native Q1.
    const native = await nativeFacade.queryTripReducer({
      reducer: 'p7.report.eventTotals@1', status: 'completed', limit: 200,
    });
    expect(native.unavailable ?? null).toBeNull();
    expect(native.completeness).toBe(P7_COMPLETENESS.EXACT);

    const oracle = await browserFold('p7.report.eventTotals@1', completed);
    expect(native.data.harsh_brakes).toBe(oracle.harsh_brakes);
    expect(native.data.speeding_events).toBe(oracle.speeding_events);
    expect(native.data.completed_count).toBe(oracle.completed_count);
    expect(native.data.most_common_risk).toBe(oracle.most_common_risk);
  });

  it('Q10 pages the native archive in bounded turns to the same total', async () => {
    // Small pages force several turns; the tally must land in the same place.
    let result = await nativeFacade.queryTripReducer({
      reducer: 'p7.report.durationDistance@1', status: 'completed', limit: 7,
    });
    for (let turn = 0; turn < 50 && result.continuation; turn += 1) {
      result = await nativeFacade.queryTripReducer({
        reducer: 'p7.report.durationDistance@1', status: 'completed', limit: 7,
        continuation: result.continuation,
      });
    }

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    const oracle = await browserFold('p7.report.durationDistance@1', completed);
    expect(result.data.trip_count).toBe(oracle.trip_count);
    expect(result.data.distance_m).toBeCloseTo(oracle.distance_m, 6);
    expect(result.data.duration_ms).toBeCloseTo(oracle.duration_ms, 6);
  });

  it('the native aggregate and the native reducer agree after §C2', async () => {
    // V13's core claim: the same window, two owners, equal after the frozen
    // conversions — or a typed disposition. Here both can serve, so they must
    // agree to the last metre and millisecond.
    const range = { fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 20 * DAY };
    const aggregate = await nativeFacade.queryP6AnalyticsAggregate({ scope: 'global', ...range });

    const inWindow = completed.filter((row) => {
      const at = Date.parse(row.start_time);
      return at >= range.fromMs && at < range.toMs;
    });
    const reduced = await browserFold('p7.report.durationDistance@1', inWindow);

    expect(aggregate.data.totals.completedCount).toBe(reduced.trip_count);
    expect(aggregate.data.totals.totalMeters).toBeCloseTo(reduced.distance_m, 6);
    expect(aggregate.data.totals.totalDurationMs).toBeCloseTo(reduced.duration_ms, 6);
  });

  it('never answers a native question from the browser store', async () => {
    // There is no IndexedDB in this environment at all, so a path that fell
    // back to the browser store could not have produced an answer.
    expect(typeof globalThis.indexedDB).toBe('undefined');

    const page = await nativeFacade.queryTripHistoryPage({ limit: 5, status: 'completed' });
    const aggregate = await nativeFacade.queryP6AnalyticsAggregate({
      scope: 'global', fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 10 * DAY,
    });

    expect(page.data).toHaveLength(5);
    expect(aggregate.data.totals.completedCount).toBeGreaterThan(0);
    expect(archive.queryHistoryPage).toHaveBeenCalled();
    // Q4's owner is the bucket table, so that is the call that must have run.
    expect(archive.chartBuckets).toHaveBeenCalled();
  });
});
