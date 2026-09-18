import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  P7_NAMED_FILTERS,
  localTripRepository,
  queryTripHistoryPage,
} from '@/lib/localTripRepository';
import {
  CHRONOLOGICAL_SORTS,
  TRIP_HISTORY_FILTER_NAMES,
  isChronologicalSort,
  q1SortFor,
  registerTripHistoryFilters,
  tripHistoryDateRange,
  tripHistoryFilterObject,
} from '@/lib/tripHistoryFilters';
import { runTripReducerToExact } from '@/lib/tripQueryReducers';
import { P7_COMPLETENESS, P7_UNAVAILABLE_CODES } from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { findDuplicateHistoryAcquisitions, SRC_ROOT, withoutComments } from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 4 — history pagination on `TripHistory.jsx` and
 * `TrackingTripHistory.jsx`.
 *
 * The defect both pages shared was the false total: each fetched a 100/200-row
 * window, filtered and sorted it in JS, and presented the result as the history.
 * Beyond that window the page was simply wrong, and nothing on screen said so.
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
const BASE = Date.UTC(2026, 7, 3, 10);

const seed = async (count, overrides = () => ({})) => {
  const trips = [];
  for (let index = 0; index < count; index += 1) {
    const trip = {
      id: `hist-${String(index).padStart(3, '0')}`,
      status: 'completed',
      start_time: new Date(BASE + index * DAY).toISOString(),
      end_time: new Date(BASE + index * DAY + 900000).toISOString(),
      distance_km: 4 + index,
      duration_seconds: 900 + index * 10,
      score_overall: 55 + (index % 45),
      harsh_brakes_count: index % 4 === 0 ? 0 : 2,
      rapid_accel_count: 0,
      sharp_turns_count: 0,
      speeding_events_count: 0,
      is_favorite: index % 5 === 0,
      night_driving: index % 3 === 0,
      route_points_map_count: 4,
      route_points: [{ lat: 43.6, lng: -79.4 }],
      ...overrides(index),
    };
    await localTripRepository.create(trip);
    trips.push(trip);
  }
  return trips;
};

const pageSource = (name) => withoutComments(
  readFileSync(path.join(SRC_ROOT, 'pages', name), 'utf8')
);

describe('P7 Stage 4 — the pages are migrated, atomically', () => {
  it('neither history page issues a legacy limited-summary acquisition', () => {
    for (const name of ['TripHistory.jsx', 'TrackingTripHistory.jsx']) {
      const source = pageSource(name);
      expect(source, name).not.toMatch(/limitedTripSummaryQueryOptions\s*\(/);
      expect(source, name).not.toMatch(/tripService\.listSummaries\s*\(/);
    }
    expect(pageSource('TripHistory.jsx')).toContain('useTripHistoryPageData');
    expect(pageSource('TrackingTripHistory.jsx')).toContain('useTripHistoryPageData');
  });

  it('P7-V18: neither page performs a duplicate history acquisition', () => {
    const duplicates = findDuplicateHistoryAcquisitions().map((entry) => entry.file);
    expect(duplicates).not.toContain('pages/TripHistory.jsx');
    expect(duplicates).not.toContain('pages/TrackingTripHistory.jsx');
  });

  it('matches the Q graphs the ledger declares for both pages', () => {
    const tripHistory = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TripHistory.jsx');
    expect(tripHistory.qGraph).toEqual(['Q1 (cursor-paged)', 'Q4 (totals)']);
    expect(tripHistory.semantics).toBe('page EXACT or filtered PARTIAL + continuation');

    const tracking = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TrackingTripHistory.jsx');
    expect(tracking.qGraph).toContain('Q10:p7.history.filteredTotals@1 when unsupported');
    expect(tracking.semantics).toMatch(/never a 200-row recompute/);
  });

  it('P7-V16: the totals footer is no longer reduced over the fetched rows', () => {
    const source = pageSource('TrackingTripHistory.jsx');
    // The old footer summed whatever had been fetched and called it the total.
    expect(source).not.toMatch(/trips\.reduce\(/);
    expect(source).toContain('useTripHistoryTotals');
    // A floor is labelled a floor.
    expect(source).toContain('at least');
  });

  it('P7-V15: a typed unavailable renders its own state on both pages', () => {
    for (const name of ['TripHistory.jsx', 'TrackingTripHistory.jsx']) {
      const source = pageSource(name);
      expect(source, name).toMatch(/unavailable/);
      expect(source, name).toContain('not available right now');
    }
  });
});

describe('P7 Stage 4 — the registered filter vocabulary', () => {
  afterEach(() => { P7_NAMED_FILTERS.clear(); });

  it('registers exactly the names the pages already filter on', () => {
    registerTripHistoryFilters();
    expect([...P7_NAMED_FILTERS.keys()].sort()).toEqual([...TRIP_HISTORY_FILTER_NAMES].sort());
  });

  it('emits no filter entry for an inactive control', () => {
    expect(tripHistoryFilterObject({})).toEqual({});
    expect(tripHistoryFilterObject({ quickFilter: 'all', selectedTags: [] })).toEqual({});
    expect(tripHistoryFilterObject({ quickFilter: 'best' })).toEqual({ quickFilter: 'best' });
    // Tag order is normalized so two equivalent selections share one identity.
    expect(tripHistoryFilterObject({ selectedTags: ['b', 'a'], tagMatchMode: 'any' }))
      .toEqual({ tripTags: { tags: ['a', 'b'], mode: 'any' } });
  });

  it('maps only the chronological sorts onto the index', () => {
    expect(q1SortFor('date_desc')).toBe('-start_time');
    expect(q1SortFor('date_asc')).toBe('start_time');
    expect(isChronologicalSort('date_desc')).toBe(true);
    // A score or distance ordering is not index-served, so it may not claim to be.
    for (const sort of ['score_desc', 'score_asc', 'distance_desc', 'distance_asc']) {
      expect(isChronologicalSort(sort), sort).toBe(false);
      expect(q1SortFor(sort), sort).toBe('-start_time');
    }
    expect(Object.keys(CHRONOLOGICAL_SORTS)).toEqual(['date_desc', 'date_asc']);
  });

  it('translates every date control into a half-open index range', () => {
    expect(tripHistoryDateRange('all')).toBeNull();
    for (const filter of ['today', 'last_7', 'last_30', 'this_month']) {
      const range = tripHistoryDateRange(filter);
      expect(range, filter).toBeTruthy();
      expect(range.toMs, filter).toBeGreaterThan(range.fromMs);
    }
    const exact = tripHistoryDateRange('exact_day', '2026-08-05');
    expect(exact.toMs - exact.fromMs).toBe(DAY);
    // An unusable custom range is "no range", not a silently empty one.
    expect(tripHistoryDateRange('custom', '', '')).toBeNull();
  });
});

describe('P7 Stage 4 — bounds, partiality and restart, observed independently', () => {
  beforeEach(() => { installStorage(); registerTripHistoryFilters(); });
  afterEach(() => { vi.unstubAllGlobals(); P7_NAMED_FILTERS.clear(); });

  it('P7-V03: a page costs its page size, not the retained history', async () => {
    await seed(40);

    observer.reset();
    await queryTripHistoryPage({ sort: '-start_time', status: 'completed', limit: 30 });
    const small = observer.counts.sourceRowsVisited;
    expect(small).toBe(31);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    await seed(0);
    await seed(40, (index) => ({ id: `hist-b-${index}` }));
    observer.reset();
    await queryTripHistoryPage({ sort: '-start_time', status: 'completed', limit: 30 });

    expect(observer.counts.sourceRowsVisited).toBe(small);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 180_000);

  it('P7-V05: a starved filter returns PARTIAL with a real continuation, never a short complete page', async () => {
    // One favourite in five, so a page of 20 cannot be filled from one budget.
    await seed(40);

    const page = await queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 20, filter: { quickFilter: 'favorites' },
    });

    expect(page.data.length).toBeLessThan(20);
    expect(page.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    expect(page.continuation).not.toBeNull();
  }, 120_000);

  it('P7-V05: an unregistered filter key is refused rather than ignored', async () => {
    await seed(5);
    const page = await queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 5, filter: { notARegisteredName: true },
    });
    expect(page.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED);
    expect(page.data).toBeNull();
  }, 60_000);

  it('serves a date range from the index and reports it EXACT', async () => {
    await seed(20);
    const range = { fromMs: BASE + 3 * DAY, toMs: BASE + 6 * DAY };

    const page = await queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 50, range,
    });

    expect(page.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(page.continuation).toBeNull();
    // Half-open [from, to): the 4th, 5th and 6th seeded days.
    expect(page.data.map((row) => row.id)).toEqual(['hist-005', 'hist-004', 'hist-003']);
  }, 120_000);

  it('P7-V04: a cursor outstanding across a mutation is refused before any row', async () => {
    await seed(12);
    const first = await queryTripHistoryPage({ sort: '-start_time', status: 'completed', limit: 4 });
    expect(first.continuation).not.toBeNull();

    await localTripRepository.update('hist-002', { nickname: 'edited' });

    const stale = await queryTripHistoryPage({
      sort: '-start_time', status: 'completed', limit: 4, cursor: first.continuation,
    });
    expect(stale.data).toBeNull();
    expect(String(stale.unavailable.code)).toMatch(/^CURSOR_/);
  }, 120_000);

  it('P7-V16: footer totals come from the reducer over the whole population', async () => {
    const trips = await seed(25);

    const result = await runTripReducerToExact({
      reducer: 'p7.history.filteredTotals@1', status: 'completed', limit: 10,
    });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    // The oracle is computed here from the fixtures, not from a fetched window.
    expect(result.data.count).toBe(trips.length);
    expect(result.data.distance)
      .toBeCloseTo(trips.reduce((sum, trip) => sum + trip.distance_km, 0), 6);
    expect(result.data.duration)
      .toBeCloseTo(trips.reduce((sum, trip) => sum + trip.duration_seconds, 0), 6);
    expect(result.data.event_count)
      .toBe(trips.reduce((sum, trip) => sum + trip.harsh_brakes_count, 0));
  }, 180_000);
});
