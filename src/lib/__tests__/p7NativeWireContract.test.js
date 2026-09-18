import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P7-IMPL-F05 — the JavaScript facade against the **real** native wire.
 *
 * Codex's objection to the previous evidence was not that the double was
 * absent, but that it was **friendly**: it answered `tripCount`, accepted
 * `limit`, returned `items` for tag context and injected projection fields, and
 * the facade agreed with it on every one — while Android does none of those
 * things. A double the facade author writes can only ever confirm the facade
 * author's beliefs.
 *
 * So the contract here is extracted from `DriveSenseArchivePlugin.java` and
 * `DriveSenseTripArchiveRepository.java` at test time. `contractChecked`
 * refuses an argument no Java code reads and a result key no Java code emits,
 * and `createNativeArchiveDouble` transcribes the repository's behaviour —
 * cursor identity, half-open range, the row projection, and which table each
 * aggregate comes from.
 *
 * **The seam this cannot cross.** It does not execute Dalvik, SQLite or the
 * Capacitor bridge, so it proves the *schema and behaviour transcribed from the
 * Java source* rather than a running Android process. Behaviour the Java has
 * that its source does not state — a SQLite planner choice, a JSON coercion in
 * the bridge — is out of reach here and stays with the Robolectric and
 * instrumentation suites. What it does close is the failure that actually
 * happened: a double and a facade agreeing about something the Java never did.
 */

const DAY = 86400000;
const BASE = Date.UTC(2026, 4, 1, 9);

/** Whole UTC days: the only window the day-bucket owner expresses exactly. */
const DAY_ALIGNED = Math.floor(BASE / DAY) * DAY;

const TRIPS = Array.from({ length: 60 }, (_, index) => ({
  id: `trip-${String(60 - index).padStart(4, '0')}`,
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
  privacy_mode: 'full',
  route_replay_available: true,
  route_points: [{ lat: 43.6, lng: -79.4 }, { lat: 43.61, lng: -79.41 }],
}));

const {
  BRIDGED_METHODS, contractChecked, nativeMethodContract,
  nativePageProjectionFields, nativePageRowKeys,
} = await import('./helpers/p7NativeWireContract.js');
const { createNativeArchiveDouble } = await import('./helpers/p7NativeArchiveDouble.js');

const raw = createNativeArchiveDouble(TRIPS);

/**
 * The JS archive wrapper's method names, and the plugin method each invokes.
 * The contract check is applied at the plugin boundary, which is where the
 * names actually have to agree.
 */
const checked = contractChecked({
  getHealth: () => raw.health(),
  queryHistoryPage: (request) => raw.queryHistoryPage(request),
  getTripAggregates: (request) => raw.aggregates(request),
  getTripChartBuckets: (request) => raw.chartBuckets(request),
  getTripTagContext: (request) => raw.tagContext(request.maxRecent),
  getTripOverviewTrack: (request) => raw.overview(request.tripId, request.maxPoints),
  queryAdjacentTrip: (request) => raw.adjacent(request.tripId, request.direction, request.status),
});

const archive = {
  counters: raw.counters,
  state: raw.state,
  health: () => checked.getHealth({}),
  queryHistoryPage: (request) => checked.queryHistoryPage(request),
  aggregates: (request) => checked.getTripAggregates(request),
  chartBuckets: (request) => checked.getTripChartBuckets(request),
  tagContext: (maxRecent) => checked.getTripTagContext({ maxRecent }),
  overview: (tripId, maxPoints) => checked.getTripOverviewTrack({ tripId, maxPoints }),
  adjacent: (tripId, direction, status) => checked.queryAdjacentTrip({ tripId, direction, status }),
};

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: new Proxy({}, { get: (_target, key) => globalThis.__p7Archive[key] }),
}));
globalThis.__p7Archive = archive;

let facade;

beforeEach(async () => {
  raw.counters.rowsScanned = 0;
  raw.counters.bucketRowsScanned = 0;
  raw.counters.pageRowsVisited = 0;
  raw.counters.bridgeCalls = 0;
  facade = await import('@/lib/nativeTripQueryFacade');
});

describe('P7-IMPL-F05 — the extracted contract is the one the facade speaks', () => {
  it('names every bridged method the facade uses', () => {
    for (const method of BRIDGED_METHODS) {
      const contract = nativeMethodContract(method);
      expect(contract.args, method).toBeInstanceOf(Set);
      expect(contract.results.size, method).toBeGreaterThan(0);
    }
  });

  it('Q4: the aggregate result key is liveCount, not tripCount', () => {
    // The original discriminator, stated against the Java rather than a double.
    const results = nativeMethodContract('getTripAggregates').results;
    expect(results.has('liveCount')).toBe(true);
    expect(results.has('tripCount')).toBe(false);
    expect(results.has('trip_count')).toBe(false);
  });

  it('Q5: the bucket cap argument is maxBuckets, not limit', () => {
    const args = nativeMethodContract('getTripChartBuckets').args;
    expect(args.has('maxBuckets')).toBe(true);
    expect(args.has('limit')).toBe(false);
  });

  it('Q7: the tag-context result key is recent, not items or trips', () => {
    const results = nativeMethodContract('getTripTagContext').results;
    expect(results.has('recent')).toBe(true);
    expect(results.has('trips')).toBe(false);
  });

  it('Q1: the range is a bound argument and part of the cursor identity', () => {
    const contract = nativeMethodContract('queryHistoryPage');
    expect(contract.args.has('fromMs')).toBe(true);
    expect(contract.args.has('toMs')).toBe(true);
    // The cursor the repository mints carries the range, so a continuation
    // cannot be replayed under a different window.
    expect(contract.results.has('range')).toBe(true);
  });

  it('the JavaScript and Java page projection lists are the same set', async () => {
    const { P7_NATIVE_PAGE_PROJECTION_FIELDS } = await import('@/lib/queryContracts/nativeProjection');
    expect(nativePageProjectionFields().sort())
      .toEqual([...P7_NATIVE_PAGE_PROJECTION_FIELDS].sort());
  });

  it('the real page row carries every field the frozen populations read', async () => {
    const keys = nativePageRowKeys();
    for (const field of [
      'driver_metric_eligible', 'score_confidence', 'score_overall', 'status',
      'distance_km', 'duration_seconds',
    ]) {
      expect(keys.has(field), field).toBe(true);
    }
  });
});

describe('P7-IMPL-F05 — Q1 over the real contract', () => {
  it('pages without duplicate or gap, and binds the cursor to the query', async () => {
    const seen = [];
    let cursor = null;
    for (let turn = 0; turn < 20; turn += 1) {
      const page = await facade.queryTripHistoryPage({ limit: 10, status: 'completed', cursor });
      expect(page.unavailable).toBeUndefined();
      seen.push(...page.data.map((row) => row.id));
      cursor = page.continuation;
      if (!cursor) break;
    }
    const completed = TRIPS.filter((trip) => trip.status === 'completed');
    expect(seen.length).toBe(completed.length);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a continuation replayed under a different date window', async () => {
    const window = { fromMs: BASE, toMs: BASE + 40 * DAY };
    const first = await facade.queryTripHistoryPage({
      limit: 5, status: 'completed', range: window,
    });
    expect(first.continuation).toBeTruthy();
    // Same cursor, different window: the bound query identity no longer matches.
    const replay = await facade.queryTripHistoryPage({
      limit: 5, status: 'completed',
      range: { fromMs: BASE + 10 * DAY, toMs: BASE + 50 * DAY },
      cursor: first.continuation,
    });
    expect(replay.data).toBeNull();
    expect(replay.unavailable.code).toBe('CURSOR_QUERY_MISMATCH');
  });

  it('refuses a continuation after the source snapshot moved', async () => {
    const first = await facade.queryTripHistoryPage({ limit: 5, status: 'completed' });
    expect(first.continuation).toBeTruthy();
    raw.state.seq += 1;
    const stale = await facade.queryTripHistoryPage({
      limit: 5, status: 'completed', cursor: first.continuation,
    });
    raw.state.seq -= 1;
    expect(stale.data).toBeNull();
    expect(stale.unavailable.code).toBe('CURSOR_RESTART_REQUIRED');
  });

  it('binds the date range into the native read rather than discarding rows', async () => {
    // Half-open [from, to): the day at `toMs` is excluded on both authorities.
    const from = BASE + 50 * DAY;
    const page = await facade.queryTripHistoryPage({
      limit: 100, status: 'completed', range: { fromMs: from, toMs: BASE + 55 * DAY },
    });
    const starts = page.data.map((row) => Date.parse(row.start_time));
    expect(starts.length).toBeGreaterThan(0);
    for (const at of starts) {
      expect(at).toBeGreaterThanOrEqual(from);
      expect(at).toBeLessThan(BASE + 55 * DAY);
    }
    // The page cost is the window, not the history in front of it: the archive
    // returned only rows in range, so nothing had to be thrown away here.
    expect(raw.queryHistoryPage.mock.calls.at(-1)[0].fromMs).toBe(from);
  });
});

describe('P7-IMPL-F05 — Q4 reads the bucket owner or refuses', () => {
  it('answers a bounded window from trip_aggregate_buckets, never a row scan', async () => {
    const result = await facade.queryP6AnalyticsAggregate({
      fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 30 * DAY, status: 'completed',
    });
    expect(result.unavailable).toBeUndefined();
    expect(result.completeness).toBe('EXACT');
    expect(result.data.totals.completedCount).toBeGreaterThan(0);
    // The discriminator: a bounded Q4 must not do SUM over trip_current.
    expect(raw.counters.rowsScanned).toBe(0);
    expect(raw.counters.bucketRowsScanned).toBeGreaterThan(0);
  });

  it('reproduces the same totals the row scan would have produced', async () => {
    const window = { fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 30 * DAY };
    const bucketed = await facade.queryP6AnalyticsAggregate({ ...window, status: 'completed' });
    // The row scan is inclusive of `toMs`; the bounded window is half-open,
    // so compare against the same last instant it actually covers.
    const scanned = await raw.aggregates({
      fromMs: window.fromMs, toMs: window.toMs - 1, status: 'completed',
    });
    expect(bucketed.data.totals.completedCount).toBe(scanned.liveCount);
    expect(bucketed.data.totals.totalKm).toBeCloseTo(scanned.totalDistance, 6);
    // §C2, once: kilometres in, metres and milliseconds out.
    expect(bucketed.data.totals.totalMeters).toBeCloseTo(scanned.totalDistance * 1000, 6);
    expect(bucketed.data.totals.totalDurationMs).toBeCloseTo(scanned.totalDuration * 1000, 6);
  });

  it('refuses a lifetime completed-only total rather than scanning for it', async () => {
    const result = await facade.queryP6AnalyticsAggregate({ status: 'completed' });
    expect(result.data).toBeNull();
    expect(result.unavailable.code).toBe('FILTER_UNSUPPORTED');
    expect(raw.counters.rowsScanned).toBe(0);
  });

  it('refuses a window the day buckets cannot express exactly', async () => {
    // A window that starts mid-day is not a whole number of day buckets.
    const result = await facade.queryP6AnalyticsAggregate({
      fromMs: DAY_ALIGNED + 9 * 3600000, toMs: DAY_ALIGNED + 30 * DAY, status: 'completed',
    });
    expect(result.data).toBeNull();
    expect(result.unavailable.code).toBe('FILTER_UNSUPPORTED');
    expect(result.unavailable.reason).toContain('day_aligned');
    expect(raw.counters.rowsScanned).toBe(0);
  });

  it('refuses a window wider than the bucket owner answers in one read', async () => {
    const result = await facade.queryP6AnalyticsAggregate({
      fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 5000 * DAY, status: 'completed',
    });
    expect(result.data).toBeNull();
    expect(result.unavailable.code).toBe('FILTER_UNSUPPORTED');
    expect(result.unavailable.reason).toContain('bucket_bound');
    expect(raw.counters.rowsScanned).toBe(0);
  });
});

describe('P7-IMPL-F05 — Q5, Q7 and Q9 against their real result shapes', () => {
  it('Q5 enforces the requested bucket cap through maxBuckets', async () => {
    // The archive refuses a range wider than twice its own cap, so the window
    // and the cap are chosen inside that rule — the truncation under test is
    // the LIMIT, not the range refusal.
    const result = await facade.queryP6AnalyticsDayBuckets({
      fromMs: BASE, toMs: BASE + 10 * DAY, status: 'completed', limit: 5,
    });
    expect(result.data.buckets.length).toBe(5);
    expect(raw.chartBuckets.mock.calls.at(-1)[0].maxBuckets).toBe(5);
    // Truncation is PARTIAL with the next bucket range, never a silent cut.
    expect(result.completeness).toBe('PARTIAL');
    expect(result.continuation.fromMs).toBeGreaterThan(BASE);
  });

  it('Q7 reads the tag context the plugin actually returns', async () => {
    const result = await facade.queryTripTagContext({ maxRecent: 7 });
    expect(result.completeness).toBe('EXACT');
    expect(result.data.trips.length).toBe(7);
    expect(result.data.trips[0].id).toBeTruthy();
  });

  it('Q9 carries the P6 owner readiness object verbatim, not a local shape', async () => {
    const { normalizeP6Readiness } = await import('@/lib/p6Contracts');
    const result = await facade.queryAchievementSurfaces({}, {});
    const readiness = result.p6Readiness;
    expect(readiness).toBeTruthy();
    // The frozen owner shape, key for key.
    expect(Object.keys(readiness).sort())
      .toEqual(Object.keys(normalizeP6Readiness({ domain: 'D1' })).sort());
    expect(readiness.domain).toBeTruthy();
    expect(Object.isFrozen(readiness)).toBe(true);
  });
});

describe('P7-IMPL-F05 — Q10 over the real projected row', () => {
  it('folds a real native page rather than an injected one', async () => {
    // The row shape is the Java one. Before the projection allowlist was
    // widened, `driver_metric_eligible` was absent and every P-DRIVER reducer
    // returned a confident zero over the same drives.
    const page = await facade.queryTripHistoryPage({ limit: 5, status: 'completed' });
    expect(page.data[0].driver_metric_eligible).toBe(true);
    expect(page.data[0].score_confidence).toBe(0.9);
    expect(page.data[0].harsh_brakes_count).toBeDefined();
  });

  it('reaches a nonzero terminal answer over native pages', async () => {
    let result = await facade.queryTripReducer({
      reducer: 'p7.report.durationDistance@1', status: 'completed', limit: 20,
    });
    for (let turn = 0; turn < 20 && result.continuation; turn += 1) {
      result = await facade.queryTripReducer({
        reducer: 'p7.report.durationDistance@1', status: 'completed', limit: 20,
        continuation: result.continuation,
      });
    }
    expect(result.completeness).toBe('EXACT');
    const completed = TRIPS.filter((trip) => trip.status === 'completed');
    expect(result.data.trip_count).toBe(completed.length);
    expect(result.data.distance_m).toBeCloseTo(
      completed.reduce((sum, trip) => sum + trip.distance_km, 0) * 1000, 3
    );
  });

  it('the P-SCORETIP population survives the native projection', async () => {
    let result = await facade.queryTripReducer({
      reducer: 'p7.report.scoreTipTotals@1', status: 'completed', limit: 20,
      settings: { scoreTipMinTripKm: 2, scoreTipMinConfidence: 0.5 },
    });
    for (let turn = 0; turn < 20 && result.continuation; turn += 1) {
      result = await facade.queryTripReducer({
        reducer: 'p7.report.scoreTipTotals@1', status: 'completed', limit: 20,
        settings: { scoreTipMinTripKm: 2, scoreTipMinConfidence: 0.5 },
        continuation: result.continuation,
      });
    }
    expect(result.completeness).toBe('EXACT');
    expect(result.data.eligible_trip_count).toBeGreaterThan(0);
  });
});

/**
 * P7-IMPL-F06 (native half) — the growth law through the **facade/plugin**
 * route, not the repository in isolation.
 *
 * The Robolectric campaign measures SQLite; Codex's objection was that it
 * bypasses the JavaScript facade and the plugin argument/result schema, and so
 * measures no bridge calls and no bridge payload at all. These tiers put the
 * same fixed requests to the facade over a small and a large retained history
 * and count what actually crosses the boundary.
 *
 * The two histories deliberately cover the **same calendar days**, so a bucket
 * count that tracked the window rather than the drives is held constant and the
 * only variable is how many drives are retained behind the request.
 */
describe('P7-IMPL-F06 — fixed native request work does not grow with history', () => {
  const DAY_ALIGNED = Math.floor(BASE / DAY) * DAY;
  const SPAN_DAYS = 60;

  const seed = (perDay) => Array.from({ length: SPAN_DAYS * perDay }, (_, index) => {
    const day = Math.floor(index / perDay);
    return {
      id: `scale-${String(index).padStart(6, '0')}`,
      status: 'completed',
      driver_metric_eligible: true,
      start_time: new Date(DAY_ALIGNED + day * DAY + (index % perDay) * 3600000).toISOString(),
      end_time: new Date(DAY_ALIGNED + day * DAY + (index % perDay) * 3600000 + 900000).toISOString(),
      distance_km: 5 + (index % 13),
      duration_seconds: 900,
      score_overall: 60 + (index % 40),
      score_confidence: 0.9,
      vehicle_id: 'car-a',
      privacy_mode: 'full',
      route_replay_available: true,
      harsh_brakes_count: index % 4,
    };
  });

  /** One fixed page and one fixed aggregate, measured at the bridge. */
  const measure = async (trips) => {
    const source = createNativeArchiveDouble(trips);
    const wrapped = contractChecked({
      getHealth: () => source.health(),
      queryHistoryPage: (request) => source.queryHistoryPage(request),
      getTripAggregates: (request) => source.aggregates(request),
      getTripChartBuckets: (request) => source.chartBuckets(request),
      getTripTagContext: (request) => source.tagContext(request.maxRecent),
      getTripOverviewTrack: (request) => source.overview(request.tripId, request.maxPoints),
      queryAdjacentTrip: (request) => source.adjacent(request.tripId, request.direction, request.status),
    });
    const previous = globalThis.__p7Archive;
    globalThis.__p7Archive = {
      health: () => wrapped.getHealth({}),
      queryHistoryPage: (request) => wrapped.queryHistoryPage(request),
      aggregates: (request) => wrapped.getTripAggregates(request),
      chartBuckets: (request) => wrapped.getTripChartBuckets(request),
      tagContext: (maxRecent) => wrapped.getTripTagContext({ maxRecent }),
      overview: (tripId, maxPoints) => wrapped.getTripOverviewTrack({ tripId, maxPoints }),
      adjacent: (tripId, direction, status) => wrapped.queryAdjacentTrip({ tripId, direction, status }),
    };
    try {
      source.counters.bridgeCalls = 0;
      source.counters.pageRowsVisited = 0;
      source.counters.rowsScanned = 0;
      source.counters.bucketRowsScanned = 0;

      const page = await facade.queryTripHistoryPage({ limit: 25, status: 'completed' });
      const aggregate = await facade.queryP6AnalyticsAggregate({
        scope: 'global', status: 'completed',
        fromMs: DAY_ALIGNED, toMs: DAY_ALIGNED + 30 * DAY,
      });
      return {
        page,
        aggregate,
        counters: { ...source.counters },
        pageBytes: new TextEncoder().encode(JSON.stringify(page.data ?? [])).length,
        aggregateBytes: new TextEncoder().encode(JSON.stringify(aggregate.data ?? null)).length,
      };
    } finally {
      globalThis.__p7Archive = previous;
    }
  };

  it('a 60x larger history costs the same page and the same aggregate', async () => {
    const small = await measure(seed(1));       // 60 drives
    const large = await measure(seed(60));      // 3,600 drives, same 60 days

    expect(small.page.data).toHaveLength(25);
    expect(large.page.data).toHaveLength(25);
    expect(large.aggregate.unavailable).toBeUndefined();

    // Identical, not similar: bridge calls, rows the page visited, and the
    // bytes that crossed back.
    expect(large.counters.bridgeCalls).toBe(small.counters.bridgeCalls);
    expect(large.counters.pageRowsVisited).toBe(small.counters.pageRowsVisited);
    expect(large.counters.pageRowsVisited).toBeLessThanOrEqual(26);
    expect(large.pageBytes).toBe(small.pageBytes);
    // The aggregate is a fixed-size object: the same terms, whatever the
    // history. Its byte count moves only by the digits in the numbers, so
    // the term set is the assertion and a small absolute cap is the bound.
    expect(Object.keys(large.aggregate.data.totals).sort())
      .toEqual(Object.keys(small.aggregate.data.totals).sort());
    expect(large.aggregateBytes).toBeLessThan(512);

    // Q4's work is the requested window in days, which both tiers share — and
    // it is never the drives behind it.
    expect(large.counters.bucketRowsScanned).toBe(small.counters.bucketRowsScanned);
    expect(large.counters.rowsScanned).toBe(0);
    expect(small.counters.rowsScanned).toBe(0);

    // The aggregate is still the true total over the larger history, so the
    // flat cost is not flat because the answer got smaller.
    expect(large.aggregate.data.totals.completedCount)
      .toBeGreaterThan(small.aggregate.data.totals.completedCount);
  });
});

/**
 * P7-IMPL-F05 (atomicity) — the facade's half of the snapshot refusal.
 *
 * `DriveSenseTripArchiveRepository.queryHistoryPage` now re-reads the archive's
 * generation and committed sequence after assembling a page and refuses to
 * publish one whose rows and identity would straddle two committed states. That
 * refusal has to arrive as the frozen *stale row set* outcome — not as a
 * storage fault, which a caller would surface as "your trips are unavailable" —
 * and it must publish no data and above all no continuation.
 */
describe('P7-IMPL-F05 — a page that straddled two committed states is refused', () => {
  const movedDuringPage = () => {
    const previous = globalThis.__p7Archive;
    globalThis.__p7Archive = {
      ...previous,
      queryHistoryPage: async () => { throw new Error('SNAPSHOT_MOVED_DURING_PAGE'); },
    };
    return () => { globalThis.__p7Archive = previous; };
  };

  it('maps the archive refusal to CURSOR_RESTART_REQUIRED, with nothing published', async () => {
    const restore = movedDuringPage();
    try {
      const page = await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
      expect(page.unavailable.code).toBe('CURSOR_RESTART_REQUIRED');
      expect(page.unavailable.reason).toBe('native_snapshot_moved_during_page');
      expect(page.data).toBeNull();
      // The whole point: no continuation can be minted from a mixed state.
      expect(page.continuation).toBeNull();
      expect(page.completeness).toBeNull();
    } finally { restore(); }
  });

  it('is not reported as a storage fault', async () => {
    const restore = movedDuringPage();
    try {
      const page = await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
      expect(page.unavailable.code).not.toBe('STORAGE_UNAVAILABLE');
      expect(page.unavailable.code).not.toBe('RECOVERY_REQUIRED');
    } finally { restore(); }
  });

  it('refuses a cursored turn the same way, so paging restarts rather than skips', async () => {
    const first = await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
    expect(first.continuation).toBeTruthy();
    const restore = movedDuringPage();
    try {
      const second = await facade.queryTripHistoryPage({
        limit: 10, status: 'completed', cursor: first.continuation,
      });
      expect(second.unavailable.code).toBe('CURSOR_RESTART_REQUIRED');
      expect(second.data).toBeNull();
      expect(second.continuation).toBeNull();
    } finally { restore(); }
  });

  it('the Java refusal string the facade matches really exists in the repository', async () => {
    // A mapping keyed on a message only works while the message is real.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const java = readFileSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'android', 'app', 'src',
      'main', 'java', 'com', 'drivesense', 'app', 'DriveSenseTripArchiveRepository.java'
    ), 'utf8');
    expect(java).toContain('SNAPSHOT_MOVED_DURING_PAGE');
    // And the page is stamped with the identity verified BEFORE its rows were
    // read, never with a sequence re-read after the fact.
    expect(java).toContain('response.put("canonicalSeq",sourceBefore.getLong("seq"))');
  });
});

/**
 * P7-IMPL-F05 (end-to-end envelope identity) — one successful envelope, one
 * source state.
 *
 * The Java page-assembly guard makes the *Java page* atomic. It does not make
 * the whole envelope atomic: the facade reads health **before** calling Java
 * and published that preflight identity as `snapshot`. On a first page there is
 * no incoming continuation to refuse against, so an archive that advanced
 * between the health read and the Java call produced one successful envelope
 * carrying two different source identities — `snapshot` said S while the
 * continuation minted beside it was bound to S+1.
 *
 * Annex A §A1.2a rule 4 makes `snapshot.generation`/`snapshot.revision` the
 * binding for every continuation, so those two may never disagree. §A1.1 puts
 * the same envelope — including its source identity — on **every** Q1–Q10
 * result, which is why Q7 is covered here too even though it owns no cursor.
 *
 * The interleaving is forced, not timed: the wrapper advances the archive
 * exactly once, between the facade's health read and the native call.
 */
describe('P7-IMPL-F05 — the envelope and its continuation describe one state', () => {
  /** Advance the archive exactly once, after health and before the native call. */
  const commitBetweenHealthAndCall = (methods) => {
    const previous = globalThis.__p7Archive;
    let armed = true;
    const advance = () => { if (armed) { armed = false; raw.state.seq += 1; } };
    const wrapped = { ...previous };
    for (const name of methods) {
      wrapped[name] = async (...args) => { advance(); return previous[name](...args); };
    }
    globalThis.__p7Archive = wrapped;
    return () => { globalThis.__p7Archive = previous; };
  };

  /** The source a cursor token is bound to, read straight out of the token. */
  const continuationSource = (token) => JSON.parse(Buffer.from(
    String(token).replace(/-/g, '+').replace(/_/g, '/'), 'base64'
  ).toString('utf8')).src;

  it('Q1 first page: preflight S, stable Java page S+1 — the envelope says S+1', async () => {
    const preflight = raw.state.seq;
    const restore = commitBetweenHealthAndCall(['queryHistoryPage']);
    let page;
    try {
      page = await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
    } finally { restore(); }

    expect(page.unavailable).toBeUndefined();
    expect(page.continuation).toBeTruthy();
    // The archive really did move between the health read and the call.
    expect(raw.state.seq).toBe(preflight + 1);
    // The published identity is the verified page identity, not the preflight.
    expect(page.snapshot.revision).toBe(preflight + 1);
    expect(page.snapshot.revision).not.toBe(preflight);
    // And it is the identity its own continuation is bound to.
    const source = continuationSource(page.continuation);
    expect(String(source.generation)).toBe(String(page.snapshot.generation));
    expect(Number(source.rev)).toBe(Number(page.snapshot.revision));
  });

  it('invariant: no successful Q1 envelope has snapshot != continuation source', async () => {
    // Ordinary paging, a filtered page, a ranged window and an interleaved
    // first page — every successful envelope, the same rule.
    const cases = [
      async () => facade.queryTripHistoryPage({ limit: 10, status: 'completed' }),
      async () => facade.queryTripHistoryPage({
        limit: 5, status: 'completed', filter: { vehicleId: 'car-a' },
      }),
      async () => facade.queryTripHistoryPage({
        limit: 5, status: 'completed', range: { fromMs: BASE, toMs: BASE + 40 * DAY },
      }),
      async () => {
        const restore = commitBetweenHealthAndCall(['queryHistoryPage']);
        try {
          return await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
        } finally { restore(); }
      },
    ];
    for (const run of cases) {
      const page = await run();
      if (page.unavailable || !page.continuation) continue;
      const source = continuationSource(page.continuation);
      expect(String(source.generation)).toBe(String(page.snapshot.generation));
      expect(Number(source.rev)).toBe(Number(page.snapshot.revision));
    }
  });

  it('a cursored turn still refuses when the source moved under it', async () => {
    // The accepted refusal is unchanged: publishing the verified identity on a
    // first page must not become a licence to resume across two states.
    const first = await facade.queryTripHistoryPage({ limit: 10, status: 'completed' });
    expect(first.continuation).toBeTruthy();
    const restore = commitBetweenHealthAndCall(['queryHistoryPage']);
    let second;
    try {
      second = await facade.queryTripHistoryPage({
        limit: 10, status: 'completed', cursor: first.continuation,
      });
    } finally { restore(); }
    expect(second.data).toBeNull();
    expect(second.unavailable.code).toBe('CURSOR_RESTART_REQUIRED');
    expect(second.continuation).toBeNull();
  });

  it('Q7: preflight S, capped data selected at S+1 — the envelope says S+1', async () => {
    const preflight = raw.state.seq;
    const restore = commitBetweenHealthAndCall(['tagContext']);
    let tags;
    try {
      tags = await facade.queryTripTagContext({ maxRecent: 7 });
    } finally { restore(); }

    expect(tags.unavailable).toBeUndefined();
    expect(raw.state.seq).toBe(preflight + 1);
    // The mandatory generic snapshot describes the data actually returned.
    expect(tags.snapshot.revision).toBe(preflight + 1);
    expect(tags.snapshot.revision).not.toBe(preflight);
    expect(String(tags.snapshot.generation)).toBe(String(raw.state.generation));

    // Q7's frozen contract is untouched: capped EXACT, no continuation, no
    // cursor outcome invented, and the cap it was asked for.
    expect(tags.completeness).toBe('EXACT');
    expect(tags.continuation).toBeNull();
    expect(tags.data.cappedAt).toBe(7);
    expect(tags.data.trips).toHaveLength(7);
    expect(tags.p6Readiness).toBeUndefined();
  });

  it('Q7 still reads the recent wire key and acquires no history', async () => {
    raw.counters.bridgeCalls = 0;
    const tags = await facade.queryTripTagContext({ maxRecent: 5 });
    expect(tags.data.trips).toHaveLength(5);
    expect(Object.keys(tags.data.trips[0]).sort())
      .toEqual(['id', 'route_key', 'start_time', 'tag', 'tag_sources', 'tags']);
    // One health read plus the tag-context call — never a page sweep.
    expect(raw.counters.bridgeCalls).toBeLessThanOrEqual(3);
  });

  it('the Java tag-context read binds its identity in the selecting statement', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const java = readFileSync(path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'android', 'app', 'src',
      'main', 'java', 'com', 'drivesense', 'app', 'DriveSenseTripArchiveRepository.java'
    ), 'utf8');
    // One statement, one snapshot: archive_meta drives the LEFT JOIN so the
    // identity comes back even when no trip row matches.
    expect(java).toContain('FROM archive_meta m LEFT JOIN');
    expect(java).toContain('JSONObject tagContextPage(');
    // And the opt-out that suppressed verification is gone.
    expect(java).not.toContain('publishesSnapshot",true');
  });
});
