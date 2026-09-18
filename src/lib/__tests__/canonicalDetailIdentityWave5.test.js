import { QueryObserver } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REQUESTED_TRIP_ID_LENGTH,
  readRequestedTripId,
  resolveTrackingTripSubject,
  trackingTripPickerOptions,
  trackingTripSubjectState,
} from '@/lib/trackingTripSubject';

/**
 * Canonical Detail Identity / Freshness — Wave 5 (HPR-017 + HPR-018).
 *
 * One batch because both are the same authority problem seen from two sides: a
 * detail surface must resolve the exact trip it was asked about (HPR-017), and it
 * must still be showing that trip's current canonical state after the record
 * changes underneath it (HPR-018). Identity without freshness is a correct answer
 * that goes stale; freshness without identity refreshes the wrong subject.
 */

const flush = () => new Promise((done) => { setTimeout(done, 0); });

const summaryRow = (id, overrides = {}) => ({
  id,
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  distance_km: 12,
  ...overrides,
});

/**
 * A window that refuses to be searched.
 *
 * Reading any row but the first throws. Explicit resolution that touches this is
 * scanning the collection, which is the fix HPR-017 forbids — "the cap should be
 * bigger" and "walk pages until X appears" are the same defect at two sizes.
 */
const unscannableWindow = (length) => new Proxy(
  // The target is a real array, so `Array.isArray` and every array method behave
  // exactly as they do on the page's own bounded window.
  [],
  {
    get(target, property, receiver) {
      if (property === 'length') return length;
      if (property === '0') return length > 0 ? summaryRow('trip-newest') : undefined;
      if (typeof property === 'string' && /^\d+$/.test(property)) {
        throw new Error(`the window was scanned at index ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  },
);

// ---------------------------------------------------------------------------
// HPR-017 — explicit trip identity is authoritative
// ---------------------------------------------------------------------------

describe('HPR-017 — a named trip is the subject, whatever the window holds', () => {
  it('RED 1: resolves a trip that lies outside the destination window', () => {
    // Events/Evidence load 50 summaries, Map one 80-trip geometry page. The
    // requested trip is in neither.
    const window50 = Array.from({ length: 50 }, (_, index) => summaryRow(`trip-recent-${index}`));
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-archived-9001'),
      selectedTripId: '',
      summaries: window50,
    });

    expect(subject.tripId).toBe('trip-archived-9001');
    expect(subject.mode).toBe('explicit');
    // Not the newest row, and not "unavailable because it is not in the page".
    expect(subject.tripId).not.toBe('trip-recent-0');
    expect(subject.rejected).toBe(false);
  });

  it('RED 2: the wrong subject cannot be produced when trip A is named and B is newest', () => {
    const tripA = { id: 'trip-A', distance_km: 410, score: 41 };
    const tripB = summaryRow('trip-B', { distance_km: 3, score: 99 });
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-A'),
      summaries: [tripB, summaryRow('trip-C')],
    });
    const state = trackingTripSubjectState({
      subject,
      summaries: [tripB, summaryRow('trip-C')],
      detail: { data: tripA },
    });

    expect(subject.tripId).toBe('trip-A');
    expect(state.status).toBe('ready');
    expect(state.trip).toBe(tripA);
    // No mixed subject: the cheap row offered alongside the detail is A's or nothing,
    // never the first loaded row.
    expect(state.summary).toBeNull();
  });

  it('RED 2b: while A is still loading, no other trip stands in for it', () => {
    const tripB = summaryRow('trip-B');
    const state = trackingTripSubjectState({
      subject: resolveTrackingTripSubject({
        requested: readRequestedTripId('?trip=trip-A'),
        summaries: [tripB],
      }),
      summaries: [tripB],
      detail: { isPending: true },
    });

    expect(state.status).toBe('loading');
    expect(state.trip).toBeNull();
    expect(state.summary).toBeNull();
  });

  it('RED 2c: the same-id bounded row may render the subject early, and only that row', () => {
    const rowA = summaryRow('trip-A', { distance_km: 410 });
    const state = trackingTripSubjectState({
      subject: resolveTrackingTripSubject({
        requested: readRequestedTripId('?trip=trip-A'),
        summaries: [summaryRow('trip-B'), rowA],
      }),
      summaries: [summaryRow('trip-B'), rowA],
      detail: { isPending: true },
    });

    expect(state.summary).toBe(rowA);
    expect(state.summary.id).toBe('trip-A');
  });

  it('RED 3: a non-existent explicit id reports unavailable and substitutes nothing', () => {
    const summaries = [summaryRow('trip-B'), summaryRow('trip-C')];
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-deleted'),
      summaries,
    });
    const state = trackingTripSubjectState({ subject, summaries, detail: { isError: true } });

    expect(subject.tripId).toBe('trip-deleted');
    expect(state.status).toBe('unavailable');
    expect(state.trip).toBeNull();
    expect(state.summary).toBeNull();
    expect(state.notice).toContain('trip-deleted');
    expect(state.notice).toMatch(/No other trip has been shown in its place/);
  });

  it('RED 3b: a malformed explicit id is refused, never degraded to the newest trip', () => {
    const summaries = [summaryRow('trip-newest')];
    const oversized = 'x'.repeat(MAX_REQUESTED_TRIP_ID_LENGTH + 1);
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId(`?trip=${oversized}`),
      summaries,
    });
    const state = trackingTripSubjectState({ subject, summaries, detail: {} });

    expect(subject.mode).toBe('explicit');
    expect(subject.rejected).toBe(true);
    expect(subject.tripId).toBe('');
    expect(state.status).toBe('unavailable');
    expect(state.trip).toBeNull();
  });

  it('RED 3c: an empty or whitespace `trip=` is not a request at all', () => {
    const summaries = [summaryRow('trip-newest')];
    for (const search of ['?trip=', '?trip=%20%20']) {
      const subject = resolveTrackingTripSubject({
        requested: readRequestedTripId(search),
        summaries,
      });
      // Nothing was named, so the ordinary default stands.
      expect(subject.mode, search).toBe('default');
      expect(subject.tripId, search).toBe('trip-newest');
    }
  });

  it('RED 4: with no explicit id the destination keeps its newest-first default', () => {
    const summaries = [summaryRow('trip-newest'), summaryRow('trip-older')];
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?tab=sources'),
      summaries,
    });

    expect(subject.mode).toBe('default');
    expect(subject.tripId).toBe('trip-newest');
    expect(subject.rejected).toBe(false);
  });

  it('RED 4b: an empty store is empty, not an error', () => {
    const subject = resolveTrackingTripSubject({ requested: readRequestedTripId(''), summaries: [] });
    const state = trackingTripSubjectState({ subject, summaries: [], detail: {} });

    expect(subject.mode).toBe('none');
    expect(state.status).toBe('empty');
    expect(state.notice).toBe('No completed trip selected.');
  });

  it('a trip the user picks on the destination outranks the link that opened it', () => {
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-A'),
      selectedTripId: 'trip-B',
      summaries: [summaryRow('trip-B')],
    });

    expect(subject.mode).toBe('selected');
    expect(subject.tripId).toBe('trip-B');
  });

  it('accepts a URLSearchParams as well as a search string', () => {
    expect(readRequestedTripId(new URLSearchParams('trip=trip-A')).id).toBe('trip-A');
    expect(readRequestedTripId('trip=trip-A').id).toBe('trip-A');
    expect(readRequestedTripId(null).present).toBe(false);
  });

  it('offers the named trip in the picker when the window does not hold it', () => {
    const options = trackingTripPickerOptions({
      summaries: [summaryRow('trip-B'), summaryRow('trip-C')],
      tripId: 'trip-archived',
      subjectTrip: { id: 'trip-archived' },
      formatLabel: (trip) => `label:${trip.id}`,
    });

    expect(options[0].value).toBe('trip-archived');
    expect(options[0].outsideWindow).toBe(true);
    expect(options.map((option) => option.value)).toEqual(['trip-archived', 'trip-B', 'trip-C']);
  });

  it('does not duplicate the subject when the window already holds it', () => {
    const options = trackingTripPickerOptions({
      summaries: [summaryRow('trip-B'), summaryRow('trip-C')],
      tripId: 'trip-C',
      formatLabel: (trip) => trip.id,
    });

    expect(options.map((option) => option.value)).toEqual(['trip-B', 'trip-C']);
    expect(options.every((option) => option.outsideWindow === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HPR-017 — the scale law
// ---------------------------------------------------------------------------

describe('HPR-017 — explicit resolution does not depend on how much was driven', () => {
  const RETAINED = [0, 1, 10, 50, 80, 100, 1_000, 10_000, 100_000, 348_732, 5_000_000];

  it('never reads past the first row of the window to resolve a named trip', () => {
    for (const retained of RETAINED) {
      const subject = resolveTrackingTripSubject({
        requested: readRequestedTripId('?trip=trip-X'),
        summaries: unscannableWindow(retained),
      });
      expect(subject.tripId, `retained=${retained}`).toBe('trip-X');
    }
  });

  it('reads only the first row of the window for the no-id default', () => {
    for (const retained of RETAINED.filter((count) => count > 0)) {
      const subject = resolveTrackingTripSubject({
        requested: readRequestedTripId(''),
        summaries: unscannableWindow(retained),
      });
      expect(subject.tripId, `retained=${retained}`).toBe('trip-newest');
    }
  });

  it('holds the same shape whether the trip carries ten route points or a million', () => {
    // Identity work never touches the route. HPR-002/HPR-007's route computation
    // stays where Wave 3 left it.
    for (const points of [10, 1_000, 100_000, 1_000_000]) {
      const trip = { id: 'trip-X', route_point_count: points };
      let touched = 0;
      const guarded = new Proxy(trip, {
        get(target, property) {
          if (property === 'route_points') touched += 1;
          return Reflect.get(target, property);
        },
      });
      const state = trackingTripSubjectState({
        subject: resolveTrackingTripSubject({ requested: readRequestedTripId('?trip=trip-X') }),
        summaries: [],
        detail: { data: guarded },
      });
      expect(state.trip, `points=${points}`).toBe(guarded);
      expect(touched, `points=${points}`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// HPR-018 — one detail identity, reached by the source-change publication
// ---------------------------------------------------------------------------

describe('HPR-018 — the canonical detail identity', () => {
  let trips;
  let keys;

  beforeEach(async () => {
    vi.resetModules();
    ({ tripQueryKeys: keys, ...trips } = await import('@/api/trips'));
    trips.tripQueryKeys = keys;
  });

  it('builds one key for the legacy and the canonical entry point', async () => {
    const { p7QueryKeys, tripQueryKeys, tripDetailQueryOptions, p7DetailQueryOptions } = trips;

    expect(tripQueryKeys.detail('trip-X')).toEqual(p7QueryKeys.detail('trip-X'));
    expect(tripDetailQueryOptions('trip-X').queryKey)
      .toEqual(p7DetailQueryOptions('trip-X').queryKey);
    // The retired shape is gone: nothing builds `['trip', <id>]` any more.
    expect(tripQueryKeys.detail('trip-X')[0]).toBe('p7');
    expect(tripQueryKeys.detail('trip-X')).toEqual(['p7', 'detail', 'trip-X', '', '']);
  });

  it('keeps different trips on different identities', async () => {
    const { tripQueryKeys } = trips;
    expect(tripQueryKeys.detail('trip-A')).not.toEqual(tripQueryKeys.detail('trip-B'));
  });

  it('keeps the detail identity distinct from any list or projection key', async () => {
    const { tripQueryKeys, p7QueryKeys } = trips;
    const detail = JSON.stringify(tripQueryKeys.detail('trip-A'));
    for (const other of [
      tripQueryKeys.summaries,
      tripQueryKeys.limitedSummaries(50),
      tripQueryKeys.map,
      p7QueryKeys.history('tracking-events:50', 'first'),
      p7QueryKeys.geometry('map-screen'),
      p7QueryKeys.page('diagnostics', 'prod'),
    ]) {
      expect(JSON.stringify(other)).not.toBe(detail);
    }
  });

  it('carries the frozen detail cache policy unchanged', async () => {
    const { tripDetailQueryOptions, TRIP_DETAIL_STALE_TIME, TRIP_DETAIL_GC_TIME } = trips;
    const options = tripDetailQueryOptions('trip-X');
    expect(options.staleTime).toBe(TRIP_DETAIL_STALE_TIME);
    expect(options.gcTime).toBe(TRIP_DETAIL_GC_TIME);
    expect(TRIP_DETAIL_STALE_TIME).toBe(120_000);
    expect(TRIP_DETAIL_GC_TIME).toBe(300_000);
    expect(tripDetailQueryOptions('').enabled).toBe(false);
  });

  it('leaves the legacy `[trip, id]` key with no production builder', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/api/trips.js'), 'utf8');
    const factory = source.slice(
      source.indexOf('export const tripQueryKeys'),
      source.indexOf('export const TRIP_DETAIL_STALE_TIME'),
    );
    expect(factory).not.toMatch(/detail:\s*\(id\)\s*=>\s*\['trip'/);
    for (const page of ['src/pages/TripDetail.jsx', 'src/pages/MapScreen.jsx']) {
      const pageSource = readFileSync(resolve(process.cwd(), page), 'utf8');
      const code = pageSource.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      expect(code, page).not.toMatch(/setQueryData\(\s*\['trip',/);
      expect(code, page).not.toMatch(/queryKey:\s*\['trip',/);
    }
  });
});

describe('HPR-018 — a mounted detail converges when the canonical source changes', () => {
  let client;
  let sourceChange;
  let tripService;
  let tripDetailQueryOptions;
  let record;
  let getById;

  beforeEach(async () => {
    vi.resetModules();
    sourceChange = await import('@/lib/p7SourceChange');
    sourceChange.resetP7SourceChangeForTests();
    ({ tripService, tripDetailQueryOptions } = await import('@/api/trips'));
    // The production client and the production subscription, imported as they ship.
    ({ queryClientInstance: client } = await import('@/lib/query-client'));
    client.clear();
    record = {
      'trip-A': { id: 'trip-A', road_context_status: 'road data unavailable', score: 61 },
      'trip-B': { id: 'trip-B', road_context_status: 'road data unavailable', score: 88 },
    };
    getById = vi.spyOn(tripService, 'getById')
      .mockImplementation(async (id) => {
        const trip = record[id];
        if (!trip) throw new Error('Trip not found');
        return { ...trip };
      });
  });

  afterEach(() => {
    client?.clear();
    sourceChange.resetP7SourceChangeForTests();
    vi.restoreAllMocks();
  });

  /** One mounted consumer, subscribed exactly as a rendered page's `useQuery` is. */
  const mount = async (id) => {
    const observer = new QueryObserver(client, tripDetailQueryOptions(id));
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    return { observer, stop };
  };

  it('RED 5: a durable background update reaches a mounted detail with no remount, focus or refetch', async () => {
    const { observer, stop } = await mount('trip-A');
    expect(observer.getCurrentResult().data.road_context_status).toBe('road data unavailable');
    const reads = getById.mock.calls.length;

    // A production-equivalent durable enrichment: the record changes, then the
    // repository publishes the canonical source change after the commit.
    record['trip-A'] = { id: 'trip-A', road_context_status: 'road data recorded', score: 74 };
    sourceChange.publishP7SourceChange('trip_committed');
    await flush();
    await flush();

    // Nothing here remounted, focused the window, advanced `staleTime` or refetched.
    expect(getById.mock.calls.length).toBeGreaterThan(reads);
    expect(observer.getCurrentResult().data.road_context_status).toBe('road data recorded');
    expect(observer.getCurrentResult().data.score).toBe(74);
    stop();
  });

  it('RED 6: the updated trip converges and the other trip stays itself', async () => {
    const a = await mount('trip-A');
    const b = await mount('trip-B');

    record['trip-A'] = { id: 'trip-A', road_context_status: 'road data recorded', score: 74 };
    sourceChange.publishP7SourceChange('trip_committed');
    await flush();
    await flush();

    expect(a.observer.getCurrentResult().data.id).toBe('trip-A');
    expect(a.observer.getCurrentResult().data.score).toBe(74);
    // B refetched its own identity. It was never replaced by A.
    expect(b.observer.getCurrentResult().data.id).toBe('trip-B');
    expect(b.observer.getCurrentResult().data.score).toBe(88);
    a.stop();
    b.stop();
  });

  it('RED 8: no publication means no fabricated update', async () => {
    const { observer, stop } = await mount('trip-A');
    const reads = getById.mock.calls.length;

    // An enrichment attempt that fails before the canonical durable mutation
    // publishes nothing, so the mounted detail neither refetches nor changes.
    record['trip-A'] = { id: 'trip-A', road_context_status: 'road data recorded', score: 74 };
    await flush();
    await flush();

    expect(getById.mock.calls.length).toBe(reads);
    expect(observer.getCurrentResult().data.road_context_status).toBe('road data unavailable');
    stop();
  });

  it('a navigation race cannot render A\'s late answer as B', async () => {
    let releaseA = () => {};
    getById.mockImplementation(async (id) => {
      if (id === 'trip-A') {
        await new Promise((done) => { releaseA = done; });
        return { id: 'trip-A', score: 61 };
      }
      return { ...record[id] };
    });

    const a = new QueryObserver(client, tripDetailQueryOptions('trip-A'));
    const stopA = a.subscribe(() => {});
    const inFlight = a.refetch();
    const b = await mount('trip-B');
    expect(b.observer.getCurrentResult().data.id).toBe('trip-B');

    releaseA();
    await inFlight;
    await flush();

    // Two identities, two cache entries. A late answer lands on its own key.
    expect(b.observer.getCurrentResult().data.id).toBe('trip-B');
    expect(a.getCurrentResult().data.id).toBe('trip-A');
    stopA();
    b.stop();
  });

  it('a prefetch and the page that follows it are the same query, not two', async () => {
    const { tripQueryKeys } = await import('@/api/trips');
    // TripHistory prefetches on hover through the same options the page mounts.
    await client.prefetchQuery(tripDetailQueryOptions('trip-A'));
    const afterPrefetch = getById.mock.calls.length;

    const observer = new QueryObserver(client, tripDetailQueryOptions('trip-A'));
    const stop = observer.subscribe(() => {});
    await flush();

    expect(observer.getCurrentResult().data.id).toBe('trip-A');
    // The prefetch seeded the identity the page reads; it did not seed a second one.
    expect(getById.mock.calls.length).toBe(afterPrefetch);
    expect(client.getQueryCache().findAll({ queryKey: tripQueryKeys.detail('trip-A') }))
      .toHaveLength(1);
    stop();
  });

  it('a detail invalidation is scoped to the trip it names', async () => {
    const { tripQueryKeys } = await import('@/api/trips');
    const a = await mount('trip-A');
    const b = await mount('trip-B');
    const cache = client.getQueryCache();
    expect(cache.find({ queryKey: tripQueryKeys.detail('trip-A') })?.state.isInvalidated).toBe(false);

    // What a page-owned mutation does when its own record changes.
    await client.invalidateQueries({ queryKey: tripQueryKeys.detail('trip-A'), refetchType: 'none' });

    expect(cache.find({ queryKey: tripQueryKeys.detail('trip-A') })?.state.isInvalidated).toBe(true);
    // The other mounted trip is untouched: one identity per trip, so naming the
    // wrong id would refresh the wrong record and leave the right one stale.
    expect(cache.find({ queryKey: tripQueryKeys.detail('trip-B') })?.state.isInvalidated).toBe(false);
    a.stop();
    b.stop();
  });

  it('remounting after a source change reads the current canonical state', async () => {
    const first = await mount('trip-A');
    first.stop();

    record['trip-A'] = { id: 'trip-A', road_context_status: 'road data recorded', score: 74 };
    sourceChange.publishP7SourceChange('trip_committed');
    await flush();

    const second = await mount('trip-A');
    expect(second.observer.getCurrentResult().data.score).toBe(74);
    second.stop();
  });
});

describe('HPR-018 — one publication seam covers every background enrichment producer', () => {
  const read = (path) => readFileSync(resolve(process.cwd(), path), 'utf8');

  it('RED 7: road, speed and rescore enrichment all commit through tripService.update', () => {
    for (const producer of [
      'src/lib/roadContextQueue.js',
      'src/lib/localSpeedScoreRefresh.js',
      'src/lib/rescoringWorker.js',
    ]) {
      expect(read(producer), producer).toMatch(/tripService\.update\(/);
    }
  });

  it('the repository publishes the source change only after the durable write', () => {
    const repository = read('src/lib/localTripRepository.js');
    const commit = repository.slice(
      repository.indexOf('await idbTransactionDone(tx)'),
      repository.indexOf("publishP7SourceChange('trip_committed')"),
    );
    // Publication sits after the transaction completes, not beside it.
    expect(commit).not.toMatch(/publishP7SourceChange/);
    expect(repository).toMatch(/publishP7SourceChange\('trip_committed'\)/);
  });

  it("the page-owned detail invalidation names the page's own trip", () => {
    // `invalidateTripDetail` is the one place TripDetail says "my record changed".
    // Behavioural id-scoping is proved above; what is pinned here is that this
    // caller passes its own `id` rather than any other expression.
    const page = read('src/pages/TripDetail.jsx');
    const helper = page.slice(
      page.indexOf('const invalidateTripDetail = ()'),
      page.indexOf('const { data: trip, isLoading }'),
    );
    expect(helper).toContain('tripQueryKeys.detail(id)');
    expect(helper).toContain('tripAnalysisQueryKey(String(id))');
    expect(helper).not.toMatch(/tripQueryKeys\.detail\((?!id\))/);
  });

  it('the detail prefetch and the detail page ask the same question', () => {
    // A prefetch under a different identity seeds a cache entry the page will
    // never read, and the page then fetches again under its own.
    const history = read('src/pages/TripHistory.jsx');
    expect(history).toMatch(/prefetchQuery\(tripDetailQueryOptions\(trip\.id\)\)/);
    expect(history).not.toMatch(/prefetchQuery\(\s*\{[\s\S]{0,200}?queryKey:/);
  });

  it('the one subscriber still owns the refresh, and focus refetch stays off', () => {
    const client = read('src/lib/query-client.js');
    expect(client).toMatch(/subscribeP7SourceChange\(/);
    expect(client).toMatch(/queryKey: \['p7'\]/);
    expect(client).toMatch(/refetchType: 'active'/);
    // HPR-018 must not be "fixed" by refetching everything whenever the user
    // tabs back to the app.
    expect(client).toMatch(/refetchOnWindowFocus: false/);
  });
});

// ---------------------------------------------------------------------------
// The combined journey: the right trip, and then the right trip's new state
// ---------------------------------------------------------------------------

describe('Wave 5 — identity and freshness in one journey', () => {
  let client;
  let sourceChange;
  let tripService;
  let trips;

  beforeEach(async () => {
    vi.resetModules();
    sourceChange = await import('@/lib/p7SourceChange');
    sourceChange.resetP7SourceChangeForTests();
    trips = await import('@/api/trips');
    ({ tripService } = trips);
    ({ queryClientInstance: client } = await import('@/lib/query-client'));
    client.clear();
  });

  afterEach(() => {
    client?.clear();
    sourceChange.resetP7SourceChangeForTests();
    vi.restoreAllMocks();
  });

  it('opens the linked trip from outside the window, then follows it as it is enriched', async () => {
    // 120 retained trips. Y is newest; X is old enough to be outside every
    // destination window (50 summaries, one 80-trip geometry page).
    const window50 = Array.from({ length: 50 }, (_, index) => summaryRow(`trip-y${index}`));
    const store = {
      'trip-X': {
        id: 'trip-X',
        distance_km: 412,
        score: 44,
        road_context_status: 'road data unavailable',
        driving_events: [{ type: 'harsh_brake', timestamp: '2026-01-02T09:00:00.000Z' }],
      },
      'trip-y0': { id: 'trip-y0', distance_km: 3, score: 99, driving_events: [] },
    };
    const getById = vi.spyOn(tripService, 'getById').mockImplementation(async (id) => {
      if (!store[id]) throw new Error('Trip not found');
      return { ...store[id] };
    });

    // 1-2. The link names X, and X resolves despite being outside the window.
    const subject = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-X'),
      summaries: window50,
    });
    expect(subject.tripId).toBe('trip-X');
    expect(subject.mode).toBe('explicit');

    // 3. The destination's id-addressed detail read mounts and stays mounted.
    const observer = new QueryObserver(client, trips.tripDetailQueryOptions(subject.tripId));
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    let state = trackingTripSubjectState({
      subject, summaries: window50, detail: observer.getCurrentResult(),
    });
    expect(state.status).toBe('ready');
    expect(state.trip.id).toBe('trip-X');
    expect(state.trip.distance_km).toBe(412);
    expect(state.trip.road_context_status).toBe('road data unavailable');
    // One by-id read. No window was paged through to find X.
    expect(getById.mock.calls.map(([id]) => id)).toEqual(['trip-X']);

    // 4-5. A durable background enrichment of X, published the production way.
    store['trip-X'] = { ...store['trip-X'], road_context_status: 'road data recorded', score: 57 };
    sourceChange.publishP7SourceChange('trip_committed');
    await flush();
    await flush();

    // 6-7. X converged, and Y never stood in for it.
    state = trackingTripSubjectState({
      subject, summaries: window50, detail: observer.getCurrentResult(),
    });
    expect(state.status).toBe('ready');
    expect(state.trip.id).toBe('trip-X');
    expect(state.trip.road_context_status).toBe('road data recorded');
    expect(state.trip.score).toBe(57);
    expect(getById.mock.calls.every(([id]) => id === 'trip-X')).toBe(true);
    stop();

    // 8. The same route with an id nothing answers for reports unavailable.
    const missing = resolveTrackingTripSubject({
      requested: readRequestedTripId('?trip=trip-never-existed'),
      summaries: window50,
    });
    const missingObserver = new QueryObserver(client, trips.tripDetailQueryOptions(missing.tripId));
    const stopMissing = missingObserver.subscribe(() => {});
    await missingObserver.refetch().catch(() => {});
    await flush();
    const missingState = trackingTripSubjectState({
      subject: missing, summaries: window50, detail: missingObserver.getCurrentResult(),
    });

    expect(missingState.status).toBe('unavailable');
    expect(missingState.trip).toBeNull();
    expect(missingState.notice).toContain('trip-never-existed');
    stopMissing();
  });
});
