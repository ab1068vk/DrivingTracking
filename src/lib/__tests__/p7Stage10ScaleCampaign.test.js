import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));

import {
  __projectionCountersForTests,
  __resetProjectionCountersForTests,
  localTripRepository,
  queryTripHistoryPage,
} from '@/lib/localTripRepository';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { p7EnvelopeViolations } from '@/lib/tripQueryContracts';
import { SRC_ROOT, withoutComments } from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 10 — the scale campaign.
 *
 * Every earlier stage proved a law at one or two sizes. This one proves the
 * law is a **law**: the cost of a page does not move with the size of the
 * history behind it, at **128 / 500 / 1 000 / 3 000 / 5 000** trips.
 *
 * 128 is not an arbitrary first tier — it is the original failure scale, the
 * size at which the app's history reads started to hurt. The tiers above it
 * exist to show the curve is flat, not merely acceptable at one point.
 *
 * Everything asserted here is counted by observers **outside** the
 * implementation: the IndexedDB boundary is instrumented directly, so the
 * numbers do not come from counters the code under test maintains about
 * itself. `projectionCounters` is read only where the *implementation's own*
 * claim is the thing being checked, and never as the measurement.
 */

const DAY = 86400000;
const BASE = Date.UTC(2026, 0, 1, 9);

/** The mandated tiers. The stretch tier runs separately. */
export const P7_SCALE_TIERS = Object.freeze([128, 500, 1000, 3000, 5000]);

let observer;

const install = () => {
  const fake = new FakeIndexedDb();
  observer = observeIndexedDb(fake);
  vi.stubGlobal('indexedDB', observer.factory);
  vi.stubGlobal('IDBKeyRange', fake.keyRange);
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

/**
 * Seed `count` trips.
 *
 * Ids are **reverse-lexical** against chronology, so any answer ordered by a
 * storage key rather than by the requested sort is visibly wrong rather than
 * coincidentally right.
 */
const seed = async (count) => {
  for (let index = 0; index < count; index += 1) {
    await localTripRepository.create({
      id: `trip-${String(count - index).padStart(5, '0')}`,
      status: index % 23 === 0 ? 'draft' : 'completed',
      start_time: new Date(BASE + index * DAY).toISOString(),
      end_time: new Date(BASE + index * DAY + 900000).toISOString(),
      distance_km: 4 + (index % 19),
      duration_seconds: 720 + (index % 13) * 45,
      score_overall: 55 + (index % 45),
      harsh_brakes_count: index % 5,
      rapid_accel_count: index % 4,
      sharp_turns_count: index % 3,
      speeding_events_count: index % 6,
      night_driving: index % 3 === 0,
      route_points: [{ lat: 43.6 + index * 1e-5, lng: -79.4 }],
    });
  }
};

describe('P7-V03 — history page bounds at every mandated tier', () => {
  beforeEach(install);

  const K = 25;

  /** One page read, measured from outside the implementation. */
  const measurePage = async () => {
    observer.reset();
    __resetProjectionCountersForTests();
    const page = await queryTripHistoryPage({ limit: K, status: 'completed' });
    return {
      page,
      rows: observer.counts.sourceRowsVisited,
      wholeStoreGetAlls: observer.counts.wholeStoreGetAlls,
      transactions: observer.counts.transactions,
      pointReads: observer.counts.pointReads,
      counters: __projectionCountersForTests(),
    };
  };

  it.each(P7_SCALE_TIERS)('holds at %i retained trips', async (tier) => {
    await seed(tier);
    const { page, rows, wholeStoreGetAlls, counters } = await measurePage();

    expect(page.unavailable ?? null).toBeNull();
    expect(page.data).toHaveLength(K);
    expect(p7EnvelopeViolations('Q1', page)).toEqual([]);

    // The three frozen bounds. `k + 1` is the lookahead that decides whether a
    // further page exists; nothing beyond it may be touched.
    expect(rows).toBeLessThanOrEqual(K + 1);
    expect(counters.fullTripDecrypts).toBe(0);
    expect(counters.projectionDecrypts).toBeLessThanOrEqual(K);

    // No whole-store read and no whole-history sort at any size.
    expect(wholeStoreGetAlls).toBe(0);
    expect(counters.historySorts).toBe(0);
  }, 600_000);

  it('costs the same at 5 000 trips as at 128 — the curve is flat', async () => {
    await seed(128);
    const small = await measurePage();

    // Same store, forty times the history.
    await seed(5000);
    const large = await measurePage();

    expect(small.page.data).toHaveLength(K);
    expect(large.page.data).toHaveLength(K);

    // The measurement that matters: identical, not merely similar.
    expect(large.rows).toBe(small.rows);
    expect(large.transactions).toBe(small.transactions);
    expect(large.counters.projectionDecrypts).toBe(small.counters.projectionDecrypts);
    expect(large.counters.fullTripDecrypts).toBe(0);
    expect(large.wholeStoreGetAlls).toBe(0);
  }, 900_000);

  it('pages the whole history in bounded turns, each costing the same', async () => {
    await seed(500);

    const seen = new Set();
    const perTurn = [];
    let cursor = null;
    for (let turn = 0; turn < 100; turn += 1) {
      observer.reset();
      const page = await queryTripHistoryPage({ limit: 50, status: 'completed', cursor });
      expect(page.unavailable ?? null).toBeNull();
      page.data.forEach((row) => seen.add(row.id));
      perTurn.push(observer.counts.sourceRowsVisited);
      // Q1 reports `EXACT` for a full page it answered exactly, and still
      // carries a continuation. The scan ends at a null continuation.
      if (!page.continuation) break;
      cursor = page.continuation;
    }

    // Every completed trip, seen exactly once: no duplicate and no gap.
    const completed = 500 - Math.ceil(500 / 23);
    expect(seen.size).toBe(completed);

    // More retained history buys more bounded turns, never a wider turn. The
    // last turn is short because the population ends, not because it degraded.
    const full = perTurn.slice(0, -1);
    expect(Math.max(...full)).toBeLessThanOrEqual(51);
    expect(new Set(full).size).toBe(1);
  }, 900_000);
});

describe('P7-V03 — the same bounds hold for a filtered and a ranged page', () => {
  beforeEach(install);

  it('does not widen for a status filter or a date range at scale', async () => {
    await seed(1000);

    observer.reset();
    __resetProjectionCountersForTests();
    const ranged = await queryTripHistoryPage({
      limit: 25,
      status: 'completed',
      // A window late in the history, so a naive implementation would have to
      // walk everything newer to reach it.
      range: { fromMs: BASE + 10 * DAY, toMs: BASE + 60 * DAY },
    });
    const rangedRows = observer.counts.sourceRowsVisited;
    const rangedCounters = __projectionCountersForTests();

    expect(ranged.unavailable ?? null).toBeNull();
    expect(rangedRows).toBeLessThanOrEqual(26);
    expect(rangedCounters.fullTripDecrypts).toBe(0);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    // Every returned row is genuinely inside the window.
    for (const row of ranged.data) {
      const at = Date.parse(row.start_time);
      expect(at).toBeGreaterThanOrEqual(BASE + 10 * DAY);
      expect(at).toBeLessThan(BASE + 60 * DAY);
    }
  }, 900_000);
});

describe('P7-V21 — a cold read is correct without a warm cache', () => {
  beforeEach(install);

  it('answers the same page on a cold store as on a repeated read', async () => {
    await seed(500);

    const first = await queryTripHistoryPage({ limit: 20, status: 'completed' });
    const second = await queryTripHistoryPage({ limit: 20, status: 'completed' });

    // No cache is load-bearing for correctness: the second read is not a
    // different answer, and the first was not a worse one.
    expect(second.data.map((row) => row.id)).toEqual(first.data.map((row) => row.id));
    expect(second.snapshot.generation).toBe(first.snapshot.generation);
    expect(second.snapshot.revision).toBe(first.snapshot.revision);
  }, 900_000);

  it('orders by the requested sort, not by the storage key', async () => {
    await seed(200);

    const page = await queryTripHistoryPage({ limit: 30, status: 'completed' });
    const ids = page.data.map((row) => row.id);
    const times = page.data.map((row) => Date.parse(row.start_time));

    // Newest first by time...
    expect(times).toEqual([...times].sort((left, right) => right - left));
    // ...which the seeding made the *ascending* id order, so an answer ordered
    // by key would be exactly reversed.
    expect(ids).toEqual([...ids].sort());
  }, 900_000);
});

describe('P7-V03 regression — a scan ends at a null continuation, not at EXACT', () => {
  it('is what Q1 actually promises', async () => {
    install();
    // Ninety completed rows and a page of 50: the first page is full, so Q1
    // reports EXACT *for that page* and still hands back a continuation.
    for (let index = 0; index < 90; index += 1) {
      await localTripRepository.create({
        id: `r-${String(90 - index).padStart(4, '0')}`,
        status: 'completed',
        start_time: new Date(BASE + index * DAY).toISOString(),
        distance_km: 5, duration_seconds: 900, score_overall: 80,
        route_points: [{ lat: 43.6, lng: -79.4 }],
      });
    }

    const first = await queryTripHistoryPage({ limit: 50, status: 'completed' });
    expect(first.data).toHaveLength(50);
    expect(first.completeness).toBe('EXACT');
    // The trap: EXACT here means "this page is exact", not "that was all".
    expect(first.continuation).not.toBeNull();

    const second = await queryTripHistoryPage({ limit: 50, status: 'completed', cursor: first.continuation });
    expect(second.data).toHaveLength(40);
    expect(second.continuation).toBeNull();
  }, 300_000);

  it('is how every Q1 scan-to-EOF loop is written', () => {
    // The scale campaign caught three loops that stopped on `EXACT` and would
    // have written a 50-row file as a complete period export. A source guard
    // keeps the mistake from coming back the next time one is written.
    const sources = {
      'pages/Report.jsx': readFileSync(path.join(SRC_ROOT, 'pages/Report.jsx'), 'utf8'),
      'pages/TrackingReportsLab.jsx': readFileSync(path.join(SRC_ROOT, 'pages/TrackingReportsLab.jsx'), 'utf8'),
      'hooks/useInsightsData.js': readFileSync(path.join(SRC_ROOT, 'hooks/useInsightsData.js'), 'utf8'),
    };
    for (const [name, text] of Object.entries(sources)) {
      const stripped = withoutComments(text);
      expect(stripped, name).not.toMatch(/completeness === 'EXACT'\s*\|\|\s*!\w*\.?continuation/);
      expect(stripped, name).not.toMatch(/continuation && \w+\.completeness !== 'EXACT'/);
    }
  });
});

describe('P7-V03 regression — a population claim comes from the continuation', () => {
  it('is how every Q1 page reader derives one', () => {
    // The same misreading in its other form. `windowExact`, `calendarExact`,
    // `baselineExact` and the bounded-window label are claims about the
    // *population* — "this is all of them". A full Q1 page is `EXACT` and
    // still has more behind it, so deriving those from `completeness` labels a
    // window as the whole history.
    //
    // Q10 is a different contract: its `EXACT` **is** terminal EOF, so the
    // reducer readers legitimately test `completeness` and are not listed here.
    const q1Readers = [
      'hooks/useBoundedTripWindow.js',
      'hooks/useInsightsData.js',
      'hooks/useDrivingCoachData.js',
    ];
    for (const relative of q1Readers) {
      const text = withoutComments(readFileSync(path.join(SRC_ROOT, relative), 'utf8'));
      expect(text, relative).not.toMatch(/(?:window|calendar|baseline)Exact[^\n]*completeness/i);
      expect(text, relative).not.toMatch(/exact:\s*page\.completeness/);
    }

    // And the Q8 composition still derives its own completeness from the Q1
    // continuation, which is what makes `EXACT` terminal for its consumers.
    const facade = withoutComments(readFileSync(path.join(SRC_ROOT, 'lib/tripQueryFacade.js'), 'utf8'));
    expect(facade).toContain('page.continuation ? P7_COMPLETENESS.PARTIAL : P7_COMPLETENESS.EXACT');
  });
});
