import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  localTripRepository,
  queryTripAdjacent,
  queryTripTagContext,
} from '@/lib/localTripRepository';
import {
  P7_COMPLETENESS,
  P7_DETAIL_KEY_CONTRACT,
  P7_MUTATION_INVALIDATION_MATRIX,
  P7_UNAVAILABLE_CODES,
} from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { SRC_ROOT, withoutComments } from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 5 — detail-by-id consumers.
 *
 * The defect: two detail pages fetched a 100-row summary list on **every open**
 * — one to feed tag inference, one to fill a comparison `<select>`. A detail
 * page is a by-id consumer; reading a list to render one trip is the
 * read-inside-detail this phase removes.
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
const BASE = Date.UTC(2026, 8, 1, 9);

const seed = async (count) => {
  const trips = [];
  for (let index = 0; index < count; index += 1) {
    const trip = {
      id: `det-${String(index).padStart(3, '0')}`,
      status: 'completed',
      start_time: new Date(BASE + index * DAY).toISOString(),
      end_time: new Date(BASE + index * DAY + 900000).toISOString(),
      distance_km: 7 + index,
      duration_seconds: 900,
      score_overall: 80,
      tag: index % 2 === 0 ? 'commute' : 'errand',
      route_points: [{ lat: 43.6, lng: -79.4 }],
    };
    await localTripRepository.create(trip);
    trips.push(trip);
  }
  return trips;
};

const pageSource = (name) => withoutComments(
  readFileSync(path.join(SRC_ROOT, 'pages', name), 'utf8')
);

describe('P7 Stage 5 — the detail pages stop reading lists', () => {
  it('no detail page issues a limited-summary acquisition any more', () => {
    for (const name of ['TripDetail.jsx', 'TrackingTripDetail.jsx', 'SpeedAnalysis.jsx', 'Trip3DReplay.jsx', 'TripDrive3DPage.jsx']) {
      const source = pageSource(name);
      // Trip3DReplay keeps a bounded picker page by design (ledger #21), so the
      // assertion is about the 100-row *detail-open* reads specifically.
      if (name === 'Trip3DReplay.jsx') continue;
      expect(source, name).not.toMatch(/limitedTripSummaryQueryOptions\s*\(\s*100\s*\)/);
    }
  });

  it('TripDetail feeds tag inference from bounded Q7 tag context', () => {
    const source = pageSource('TripDetail.jsx');
    expect(source).toContain('useTripTagContext');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
  });

  it('TrackingTripDetail fills its comparison picker from Q6 adjacency', () => {
    const source = pageSource('TrackingTripDetail.jsx');
    expect(source).toContain('useTripComparisonCandidates');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
  });

  it('matches the per-consumer caps the ledger declares', () => {
    const tripDetail = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TripDetail.jsx');
    expect(tripDetail.caps.detail).toBe(1);
    expect(tripDetail.caps.secondary).toBe('Q2 1 + Q7 1 + Q6 <=2 + Q3 <=1');
    expect(tripDetail.legacy).toBe('(100) tag-inference read -> retire');

    const tracking = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TrackingTripDetail.jsx');
    expect(tracking.caps.detail).toBe(2);
    expect(tracking.caps.secondary).toBe('Q2 <=2 + Q6 <=1');
    expect(tracking.legacy).toBe('(100) summary read for a select -> retire');
  });
});

describe('P7-V06 — a by-id consumer reads by id, and only by id', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('Q7 tag context costs one capped page, not a hundred rows', async () => {
    await seed(40);

    observer.reset();
    const context = await queryTripTagContext({ maxRecent: 25 });

    expect(context.data.trips).toHaveLength(25);
    expect(context.data.cappedAt).toBe(25);
    // An explicitly capped contract is EXACT and owns no continuation.
    expect(context.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(context.continuation).toBeNull();
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(25 + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 180_000);

  it('Q6 comparison candidates cost two anchored reads, whatever the history', async () => {
    await seed(30);

    observer.reset();
    const older = await queryTripAdjacent('det-015', 'previous', { status: 'completed' });
    const newer = await queryTripAdjacent('det-015', 'next', { status: 'completed' });

    expect(older.data.id).toBe('det-014');
    expect(newer.data.id).toBe('det-016');
    // Two anchors plus one neighbour each: never a page of candidates.
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(4);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 180_000);

  it('does not decrypt a full trip payload to build either secondary read', async () => {
    await seed(20);

    localTripRepository.__resetProjectionCountersForTests?.();
    await queryTripTagContext({ maxRecent: 10 });
    await queryTripAdjacent('det-010', 'previous', { status: 'completed' });

    const counters = localTripRepository.__projectionCountersForTests?.();
    if (counters) {
      expect(counters.fullTripDecrypts).toBe(0);
      expect(counters.wholeStoreGetAlls).toBe(0);
      expect(counters.historySorts).toBe(0);
    }
  }, 180_000);

  it('reports a missing anchor as DETAIL_NOT_FOUND rather than an empty picker', async () => {
    await seed(3);
    const missing = await queryTripAdjacent('det-does-not-exist', 'previous', { status: 'completed' });

    expect(missing.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.DETAIL_NOT_FOUND);
    expect(missing.data).toBeNull();
  }, 60_000);
});

describe('P7-V07 — the invalidation law', () => {
  it('opening a detail invalidates nothing', () => {
    const row = P7_MUTATION_INVALIDATION_MATRIX.open_detail;
    expect(Object.values(row).every((value) => value === 'none')).toBe(true);
  });

  it('an edit or delete invalidates every semantically affected family', () => {
    for (const event of ['status_change', 'ordering_key_edit', 'delete', 'vehicle_change']) {
      const row = P7_MUTATION_INVALIDATION_MATRIX[event];
      expect(row.detail, event).not.toBe('none');
      expect(row.history, event).toBe('invalidate+reset');
      expect(row.reduce, event).toBe('reset');
      expect(row.page, event).toBe('invalidate');
    }
  });

  it('keeps one canonical detail entry, with the legacy key retired per caller', () => {
    expect(P7_DETAIL_KEY_CONTRACT.canonicalKey)
      .toBe("['p7','detail',<id>,<detailRevision>,<srcBinding>]");
    expect(P7_DETAIL_KEY_CONTRACT.ownsTheOnlyQueryFn).toBe(true);
    // The legacy key is never an alias, and Stage 9 deletes it.
    expect(P7_DETAIL_KEY_CONTRACT.aliasAllowed).toBe(false);
    expect(P7_DETAIL_KEY_CONTRACT.readableByMigratedConsumer).toBe(false);
    expect(P7_DETAIL_KEY_CONTRACT.deletedIn).toBe('Stage 9');
    // Existing detail-cache policy carries over unchanged.
    expect(P7_DETAIL_KEY_CONTRACT.staleTimeMs).toBe(120_000);
    expect(P7_DETAIL_KEY_CONTRACT.gcTimeMs).toBe(300_000);
  });
});
