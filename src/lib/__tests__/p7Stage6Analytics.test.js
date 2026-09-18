import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));

import {
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  localTripRepository,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  finalizeP6BrowserExplicitTripBuild,
  queryP6AnalyticsAggregate,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { P7_COMPLETENESS, P7_UNAVAILABLE_CODES, p7EnvelopeViolations } from '@/lib/tripQueryContracts';
import { P7_CONSUMER_LEDGER } from '@/lib/tripProjectionConsumers';
import { buildFleetIntelligence } from '@/pages/Vehicles';
import { buildDriverProgression } from '@/lib/driverProgression';
import { PROGRESSION_WINDOW_ROWS } from '@/hooks/useAchievementsData';
import { trackingOverviewWeekRange } from '@/hooks/useTrackingOverviewData';
import {
  DASHBOARD_SCORE_TRIPS,
  dashboardAverageScore,
  dashboardTodayRange,
} from '@/hooks/useDashboardData';
import { P7_REDUCER_IMPLEMENTATIONS } from '@/lib/tripQueryReducers';
import { localDayKey } from '@/lib/queryReducers/populations';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import {
  INSIGHTS_BASELINE_DAYS,
  INSIGHTS_CALENDAR_GRID_DAYS,
  INSIGHTS_DETAIL_FANOUT,
  insightsAnalysisRange,
  insightsCalendarRange,
  insightsMonthOffset,
} from '@/hooks/useInsightsData';
import { COACH_DETAIL_FANOUT } from '@/hooks/useDrivingCoachData';
import { buildCoachEvidenceAudit } from '@/lib/coachPrograms';
import { P7_REDUCER_REGISTRY } from '@/lib/tripQueryContracts';
import {
  REPORT_BASELINE_WEEKS,
  REPORT_DAILY_CAP,
  REPORT_PERCENTILE_WEEKS,
  reportCalendarWeeks,
  reportDailyDays,
  reportDailySegments,
  reportPreviousWindow,
  reportWindow,
} from '@/hooks/useReportData';
import {
  componentScoreFromTerms,
  dayOfWeekFromProfile,
  fatigueFromTerms,
  peakStressFromProfile,
  reportInsightsFromTerms,
  reportSummaryFromTerms,
  scoreDistributionFromProfile,
  timeOfDayFromProfile,
} from '@/lib/reportTerms';
import { P7_POPULATION_PREDICATES } from '@/lib/queryReducers/populations';
import { P7_OUTPUTS_REPORT_BODY } from '@/lib/queryContracts/outputsReport';
import { generateReportSummary } from '@/lib/tripEngine';
import { analyzeDayOfWeek, analyzeTimeOfDay, calculateFatigueRisk, calculatePeakHourStress } from '@/lib/tripInsights';
import { computeUBIReport, computeUBIReportFromTerms } from '@/lib/ubiReport';
import { SRC_ROOT, withoutComments } from './helpers/p7ReleaseAudit';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 6 — analytics consumers.
 *
 * This stage carries the most user-visible semantic risk, so every assertion
 * here compares a migrated composition against an **independent fold** over the
 * seeded trips, not against a rendered string. The buckets are produced by the
 * real P6 browser update path, so the comparison is against a ledger the owner
 * actually built.
 */

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});

const DAY = 86400000;

const pageSource = (name) => withoutComments(
  readFileSync(path.join(SRC_ROOT, 'pages', name), 'utf8')
);

describe('P7 Stage 6.1 — TrackingOverview is one composition', () => {
  it('no longer reads a flat 200-row page or folds the same builder twice', () => {
    const source = pageSource('TrackingOverview.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).toContain('useTrackingOverviewData');
    // The double compute was `buildOverviewIntelligence(recentTrips)` merged
    // with `buildOverviewIntelligence(allTrips)`.
    expect(source).not.toContain('buildOverviewIntelligence(allTrips)');
    expect((source.match(/buildOverviewIntelligence\(/g) ?? [])).toHaveLength(2); // definition + one call
  });

  it('matches the Q graph and semantics its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/TrackingOverview.jsx');
    expect(entry.qGraph).toEqual(['Q1', 'Q4 (totals)']);
    expect(entry.semantics).toBe('totals EXACT from Q4; list labelled');
    expect(entry.legacy).toBe('(200) + double compute -> retire');
  });

  it('renders a not-ready ledger as its own state, never as zero drives', () => {
    const source = pageSource('TrackingOverview.jsx');
    expect(source).toContain('weekUnavailable');
    expect(source).toContain('Unavailable');
    // "No drives this week" and "the ledger has not been built" must not look
    // the same, so the chip carries its own copy for the second case.
    expect(source).toContain('still being prepared');
  });

  it('covers a complete 7-UTC-day window, aligned to day boundaries', () => {
    const now = Date.UTC(2026, 9, 15, 13, 47, 11);
    const range = trackingOverviewWeekRange(now);

    expect(range.toMs - range.fromMs).toBe(7 * DAY);
    // Both ends land on a UTC day boundary, which is the granularity the D1 day
    // buckets key and therefore the only window Q4 can answer exactly.
    expect(range.fromMs % DAY).toBe(0);
    expect(range.toMs % DAY).toBe(0);
    // The window includes today, so the newest complete bucket is covered.
    expect(range.toMs).toBe(Date.UTC(2026, 9, 16));
  });
});

describe('P7-V08 / P7-V09 — TrackingOverview week totals against an oracle', () => {
  let indexedDb;
  let observer;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip) => {
    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 600; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  /** Ten completed days plus one non-completed row, one trip per UTC day. */
  const BASE = Date.UTC(2026, 9, 1);
  const seed = async () => {
    const seeded = [];
    for (let index = 0; index < 10; index += 1) {
      const trip = {
        id: `ov-${index}`,
        status: 'completed',
        start_time: new Date(BASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(BASE + index * DAY + 5400000).toISOString(),
        distance_km: 12 + index,
        duration_seconds: 1800,
        score_overall: 85,
      };
      await queue(trip);
      seeded.push(trip);
    }
    await queue({
      id: 'ov-in-progress',
      status: 'in_progress',
      start_time: new Date(BASE + 2 * DAY + 3600000).toISOString(),
      distance_km: 999,
    });
    await drain();
    return seeded;
  };

  it('sums the requested window exactly, and excludes non-completed rows', async () => {
    const seeded = await seed();
    // Days 3..6 inclusive, half-open.
    const range = { fromMs: BASE + 3 * DAY, toMs: BASE + 7 * DAY };

    const result = await queryP6AnalyticsAggregate({ scope: 'global', ...range });

    // Independent oracle, folded here from the fixtures.
    const inWindow = seeded.filter((trip) => {
      const at = Date.parse(trip.start_time);
      return at >= range.fromMs && at < range.toMs;
    });
    expect(inWindow).toHaveLength(4);

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(result.data.totals.completedCount).toBe(inWindow.length);
    expect(result.data.totals.totalKm)
      .toBeCloseTo(inWindow.reduce((sum, trip) => sum + trip.distance_km, 0), 6);
    // The in-progress row is in the range but not in the population.
    expect(result.data.totals.totalKm).toBeLessThan(999);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  }, 180_000);

  it('costs the window, not the history: the same request after more history', async () => {
    await seed();
    const range = { fromMs: BASE + 3 * DAY, toMs: BASE + 7 * DAY };

    observer.reset();
    await queryP6AnalyticsAggregate({ scope: 'global', ...range });
    const small = observer.counts.statements;
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    // Twenty more days of history, outside the window.
    for (let index = 10; index < 30; index += 1) {
      await queue({
        id: `ov-${index}`,
        status: 'completed',
        start_time: new Date(BASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(BASE + index * DAY + 5400000).toISOString(),
        distance_km: 5,
        duration_seconds: 900,
        score_overall: 80,
      });
    }
    await drain();

    observer.reset();
    await queryP6AnalyticsAggregate({ scope: 'global', ...range });

    // A four-day window reads four day buckets whatever else is retained.
    expect(observer.counts.statements).toBe(small);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 300_000);

  it('P7-V15: an unbuilt ledger is OWNER_NOT_READY with no data, never a zero week', async () => {
    const result = await queryP6AnalyticsAggregate({
      scope: 'global', ...trackingOverviewWeekRange(Date.UTC(2026, 9, 15)),
    });

    expect(result.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.OWNER_NOT_READY);
    expect(result.data).toBeNull();
    expect(result.p6Readiness.complete).toBe(false);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  }, 60_000);

  it('P7-V10: reads the D1 owner rather than duplicating its ledger', async () => {
    await seed();
    const result = await queryP6AnalyticsAggregate({ scope: 'global' });

    // Q4 carries the owner's readiness verbatim, which is only possible because
    // it read the owner instead of recomputing beside it.
    expect(result.p6Readiness.domain).toBe(P6_DOMAIN_KEYS.ANALYTICS);
    expect(result.p6Readiness.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(result.data.bucketsRead).toBe(1);
  }, 180_000);
});

describe('P7 Stage 6.2 — Vehicles reads the D1 vehicle owner', () => {
  it('no longer derives lifetime figures from a fetched window', () => {
    const source = pageSource('Vehicles.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).toContain('useVehicleAnalytics');
    // The idle-gated second page existed only to widen that window.
    expect(source).not.toContain('scheduleVehiclesIdleWork');
  });

  it('matches the Q graph and caps its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/Vehicles.jsx');
    expect(entry.qGraph).toEqual(['Q4 per vehicle', 'Q1 (recent rows)']);
    expect(entry.caps.secondary).toBe('Q1 1 + Q4 <= vehicle count (fixed by fleet, not N)');
    expect(entry.semantics).toBe('per-vehicle totals EXACT from browser:vehicle:<id>:2');
    expect(entry.legacy).toBe('(100)+(200) -> retire');
  });

  it('treats an absent or foreign aggregate payload as "not served", never as zero', () => {
    // The fleet figures fall back to the rows only when the owner genuinely did
    // not answer; a zero-kilometre fleet is a measurement claim, not a state.
    const fleet = buildFleetIntelligence(
      [{ id: 'v1', name: 'One' }],
      [{ id: 't1', status: 'completed', vehicle_id: 'v1', distance_km: 12, start_time: new Date().toISOString() }],
      {},
      null,
    );
    expect(fleet.lifetimeExact).toBe(false);
    expect(fleet.completedTripCount).toBe(1);
    expect(fleet.totalKm).toBeCloseTo(12, 6);
  });

  it('prefers the owner totals over the row fold when the owner answered', () => {
    const lifetime = {
      fleet: { trips: 412, distanceKm: 5301.5 },
      byVehicleId: new Map([['v1', { trips: 400, distanceKm: 5200, score: 91 }]]),
    };
    const fleet = buildFleetIntelligence(
      [{ id: 'v1', name: 'One' }],
      [{ id: 't1', status: 'completed', vehicle_id: 'v1', distance_km: 12, start_time: new Date().toISOString() }],
      {},
      lifetime,
    );

    expect(fleet.lifetimeExact).toBe(true);
    // The bounded page held one 12 km trip; the fleet has 412 trips and 5301.5 km.
    expect(fleet.completedTripCount).toBe(412);
    expect(fleet.totalKm).toBeCloseTo(5301.5, 6);
    expect(fleet.busiestVehicle.trips).toBe(400);
    expect(fleet.busiestVehicle.distanceKm).toBeCloseTo(5200, 6);
    // Distance-weighted, taken from the owner rather than recomputed.
    expect(fleet.busiestVehicle.score).toBe(91);
    // Cost is per-trip economics no ledger keys, so it stays a recent-window
    // figure and says so rather than claiming to be lifetime.
    expect(fleet.busiestVehicle.costIsRecentWindow).toBe(true);
  });
});

describe('P7-V09 — per-vehicle totals against an independent oracle', () => {
  let indexedDb;
  let observer;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip) => {
    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 600; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  const VBASE = Date.UTC(2026, 10, 2);

  it('matches a per-vehicle fold computed from the seeded trips', async () => {
    const seeded = [];
    for (let index = 0; index < 12; index += 1) {
      const trip = {
        id: `veh-trip-${index}`,
        status: 'completed',
        start_time: new Date(VBASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(VBASE + index * DAY + 5400000).toISOString(),
        distance_km: 10 + index,
        duration_seconds: 1500,
        score_overall: 70 + index,
        vehicle_id: index % 2 === 0 ? 'car-a' : 'car-b',
      };
      await queue(trip);
      seeded.push(trip);
    }
    await drain();

    const carA = await queryP6AnalyticsAggregate({ scope: 'vehicle', vehicleId: 'car-a' });
    const oracle = seeded.filter((trip) => trip.vehicle_id === 'car-a');

    expect(carA.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(carA.data.totals.completedCount).toBe(oracle.length);
    expect(carA.data.totals.totalKm)
      .toBeCloseTo(oracle.reduce((sum, trip) => sum + trip.distance_km, 0), 6);

    // The distance-weighted score, which is what the page shows.
    const weight = oracle.reduce((sum, trip) => sum + trip.distance_km, 0);
    const product = oracle.reduce((sum, trip) => sum + trip.score_overall * trip.distance_km, 0);
    expect(carA.data.totals.scoreDistanceWeight).toBeCloseTo(weight, 6);
    expect(carA.data.totals.scoreDistanceProduct).toBeCloseTo(product, 6);

    // And the other vehicle is a different, non-overlapping population.
    const carB = await queryP6AnalyticsAggregate({ scope: 'vehicle', vehicleId: 'car-b' });
    expect(carB.data.totals.completedCount).toBe(seeded.length - oracle.length);
  }, 300_000);

  it('costs one bucket read per vehicle, whatever the history behind it', async () => {
    for (let index = 0; index < 8; index += 1) {
      await queue({
        id: `veh-b-${index}`,
        status: 'completed',
        start_time: new Date(VBASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(VBASE + index * DAY + 5400000).toISOString(),
        distance_km: 9,
        duration_seconds: 1200,
        score_overall: 80,
        vehicle_id: 'car-a',
      });
    }
    await drain();

    observer.reset();
    await queryP6AnalyticsAggregate({ scope: 'vehicle', vehicleId: 'car-a' });
    const small = observer.counts.statements;
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    for (let index = 8; index < 30; index += 1) {
      await queue({
        id: `veh-b-${index}`,
        status: 'completed',
        start_time: new Date(VBASE + index * DAY + 3600000).toISOString(),
        end_time: new Date(VBASE + index * DAY + 5400000).toISOString(),
        distance_km: 9,
        duration_seconds: 1200,
        score_overall: 80,
        vehicle_id: 'car-a',
      });
    }
    await drain();

    observer.reset();
    await queryP6AnalyticsAggregate({ scope: 'vehicle', vehicleId: 'car-a' });

    // One bucket, read once, whether the vehicle has 8 trips or 30.
    expect(observer.counts.statements).toBe(small);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  }, 300_000);
});

describe('P7 Stage 6.3 — Achievements composes, it does not re-own', () => {
  it('no longer rebuilds progression from a 200-row page', () => {
    const source = pageSource('Achievements.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).toContain('useAchievementsData');
  });

  it('never reaches the two whole-history rebuild readers', () => {
    const source = pageSource('Achievements.jsx');
    // Both call `rebuildAchievementAggregates` when stats are null, which is a
    // whole-history rebuild on a page path.
    expect(source).not.toContain('readAchievementBadges');
    expect(source).not.toContain('readCalibrationProgressFromAggregates');
  });

  it('keeps the frozen window separation of Annex C C5.2', () => {
    // Only `allStats` is lifetime. The widest trip-count window is mastery-40,
    // so one bounded page of 60 covers every windowed statistic with headroom.
    expect(PROGRESSION_WINDOW_ROWS).toBeGreaterThanOrEqual(40);
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/Achievements.jsx');
    expect(entry.qGraph).toContain('Q9');
    expect(entry.qGraph).toContain('progression/XP ledger facts');
    expect(entry.qGraph).toContain('Q10:p7.progression.records@1');
    expect(entry.legacy).toBe('(50)+(200) pair -> retire');
  });

  it('prefers the lifetime owners over the bounded rows for the eligibility block', () => {
    const rows = [
      { id: 'a', status: 'completed', start_time: '2026-05-01T10:00:00.000Z', distance_km: 20, duration_seconds: 1200, score_overall: 85 },
      { id: 'b', status: 'completed', start_time: '2026-05-02T10:00:00.000Z', distance_km: 18, duration_seconds: 1100, score_overall: 80 },
    ];

    const withoutOwner = buildDriverProgression(rows, {}, { ledger: null });
    // Falling back to the rows is what a caller with no owner gets.
    expect(withoutOwner.eligibility.eligibleTrips).toBe(2);
    expect(withoutOwner.eligibility.lifetimeExact).toBe(false);

    const withOwner = buildDriverProgression(rows, {}, {
      ledger: null,
      lifetime: { eligibleTrips: 640, completedTrips: 700, distanceKm: 9123.4, exact: true },
    });

    // The bounded page held two trips; the lifetime population is 640 of 700.
    expect(withOwner.eligibility.eligibleTrips).toBe(640);
    expect(withOwner.eligibility.completedTrips).toBe(700);
    expect(withOwner.eligibility.excludedTrips).toBe(60);
    expect(withOwner.eligibility.distanceKm).toBeCloseTo(9123.4, 1);
    expect(withOwner.eligibility.lifetimeExact).toBe(true);
    // Confidence is a lifetime judgement and follows the lifetime figures.
    expect(withOwner.eligibility.confidence).toBe('Strong');
  });

  it('keeps the windowed statistics on the bounded rows, not on the lifetime owner', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      id: `w-${index}`,
      status: 'completed',
      start_time: new Date(Date.UTC(2026, 4, 10 + index)).toISOString(),
      distance_km: 15,
      duration_seconds: 1200,
      score_overall: 60 + index,
    }));

    const progression = buildDriverProgression(rows, {}, {
      ledger: null,
      lifetime: { eligibleTrips: 999, completedTrips: 999, distanceKm: 50000, exact: true },
    });

    // A lifetime override must not leak into a trip-count window: current form
    // is computed from mastery/recent/previous over the rows actually supplied.
    expect(progression.eligibility.eligibleTrips).toBe(999);
    expect(progression.currentForm.score).not.toBeNull();
    expect(progression.latestTripId).toBe('w-7');
  });

  it('never substitutes P-COMPLETED or P-DRIVER for P-PROGRESSION', () => {
    // A completed trip below the distance minimum is not progression-eligible,
    // and the eligibility block reports exactly why.
    const rows = [
      { id: 'ok', status: 'completed', start_time: '2026-05-01T10:00:00.000Z', distance_km: 20, duration_seconds: 1200, score_overall: 85 },
      { id: 'short', status: 'completed', start_time: '2026-05-02T10:00:00.000Z', distance_km: 0.4, duration_seconds: 1200, score_overall: 85 },
      { id: 'brief', status: 'completed', start_time: '2026-05-03T10:00:00.000Z', distance_km: 20, duration_seconds: 30, score_overall: 85 },
      { id: 'unscored', status: 'completed', start_time: '2026-05-04T10:00:00.000Z', distance_km: 20, duration_seconds: 1200, score_overall: null },
    ];

    const progression = buildDriverProgression(rows, {}, { ledger: null });

    expect(progression.eligibility.eligibleTrips).toBe(1);
    expect(progression.eligibility.completedTrips).toBe(4);
    const byId = Object.fromEntries(
      progression.eligibility.exclusionReasons.map((reason) => [reason.id, reason.count])
    );
    expect(byId.distance).toBe(1);
    expect(byId.duration).toBe(1);
    expect(byId.score).toBe(1);
  });
});

describe('P7 Stage 6.4 — Dashboard is one composition', () => {
  it('no longer holds any of the four routine history acquisitions', () => {
    const source = pageSource('Dashboard.jsx');
    // The `(50)` page, the idle-gated `(200)` page, and both ad-hoc lookups.
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).not.toMatch(/listSummaries\s*\(/);
    expect(source).not.toContain('scheduleDashboardIdleWork');
    expect(source).not.toContain('fullHistoryEnabled');
    expect(source).toContain('useDashboardData');
  });

  it('matches the Q graph and semantics its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/Dashboard.jsx');
    expect(entry.qGraph).toEqual([
      'Q1', 'Q1 (single local day)', 'Q4 (lifetime totals)', 'Q10:p7.dashboard.activityStats@1',
    ]);
    expect(entry.legacy).toBe('(50)+(200) + ad-hoc listSummaries -> retire');
  });

  it('renders a not-ready lifetime owner as its own state, never as zero drives', () => {
    const source = pageSource('Dashboard.jsx');
    expect(source).toContain('lifetimeUnavailable');
    expect(source).toContain('still being prepared');
    // A Q10 residual that has not reached EOF is a floor, and says so.
    expect(source).toContain('at least this much so far');
  });

  it('O05: covers the complete local day, half-open, not a UTC bucket', () => {
    const noon = new Date(2026, 2, 14, 12, 30, 45, 123);
    const range = dashboardTodayRange(noon);

    expect(range.toMs - range.fromMs).toBe(DAY);
    const start = new Date(range.fromMs);
    expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()])
      .toEqual([0, 0, 0, 0]);
    expect(start.getDate()).toBe(14);
    // The half-open end is the next local midnight, so the last millisecond of
    // the local day is inside the window and the next day's first is not.
    expect(range.fromMs).toBeLessThanOrEqual(noon.getTime());
    expect(range.toMs).toBeGreaterThan(noon.getTime());
    expect(new Date(range.toMs - 1).getDate()).toBe(14);
    expect(new Date(range.toMs).getDate()).toBe(15);
  });
});

describe('P7 Stage 6.4 / Annex C §C5.1 — O04 average score oracle', () => {
  const componentScore = (trip) => ({
    value: Number.isFinite(trip.score_overall) ? trip.score_overall : null,
    evidence: trip.evidence ?? 'high',
  });

  const driverTrip = (id, distanceKm, score, extra = {}) => ({
    id, status: 'completed', distance_km: distanceKm, score_overall: score, ...extra,
  });

  it('weights by distance — a plain mean is a different number', () => {
    // One long low-scoring trip and one short high-scoring one. The plain mean
    // is 70; the distance-weighted mean is dragged toward the long trip.
    const rows = [driverTrip('long', 90, 40), driverTrip('short', 10, 100)];

    const { avgScore } = dashboardAverageScore(rows, componentScore);

    const plainMean = Math.round((40 + 100) / 2);
    const weighted = Math.round((40 * 90 + 100 * 10) / (90 + 10));
    expect(weighted).toBe(46);
    expect(plainMean).toBe(70);
    expect(avgScore).toBe(weighted);
    expect(avgScore).not.toBe(plainMean);
  });

  it('takes the latest ten, and an older eligible row cannot enter the window', () => {
    // Eleven scored driver rows, newest first. The eleventh is a 0 that would
    // visibly drag the mean down if the horizon were not honoured.
    const rows = [
      ...Array.from({ length: DASHBOARD_SCORE_TRIPS }, (_, i) => driverTrip(`recent-${i}`, 10, 80)),
      driverTrip('older', 10, 0),
    ];

    const { avgScore, scoredTripCount } = dashboardAverageScore(rows, componentScore);

    expect(scoredTripCount).toBe(DASHBOARD_SCORE_TRIPS);
    expect(avgScore).toBe(80);
    // The oracle over all eleven, which is the number a lifetime source gives.
    const overAll = Math.round(rows.reduce((sum, t) => sum + t.score_overall * t.distance_km, 0)
      / rows.reduce((sum, t) => sum + t.distance_km, 0));
    expect(overAll).toBe(73);
    expect(avgScore).not.toBe(overAll);
  });

  it('reads P-DRIVER, so passenger and excluded rows never reach the mean', () => {
    const population = [
      driverTrip('drove', 10, 90),
      driverTrip('rode-along', 10, 10, { was_driver: 'no' }),
      driverTrip('excluded', 10, 10, { excluded_from_driver_score: true }),
      driverTrip('flagged', 10, 10, { data_quality_flags: ['passenger_trip'] }),
    ];
    // The composition hands the helper rows already filtered by the approved
    // projection predicate; the same predicate is the oracle here.
    const driverRows = population.filter(isDriverMetricEligible);
    expect(driverRows.map((trip) => trip.id)).toEqual(['drove']);

    expect(dashboardAverageScore(driverRows, componentScore).avgScore).toBe(90);
    // With the population unfiltered the figure would be visibly different.
    expect(dashboardAverageScore(population, componentScore).avgScore).toBe(30);
  });

  it('skips unscored rows without letting them shrink the horizon', () => {
    const rows = [
      driverTrip('unscored', 10, null),
      ...Array.from({ length: DASHBOARD_SCORE_TRIPS }, (_, i) => driverTrip(`scored-${i}`, 10, 60 + i)),
    ];

    const { avgScore, scoredTripCount } = dashboardAverageScore(rows, componentScore);

    // `latest 10` counts rows, so one unscored row inside the window leaves
    // nine scored rows — it is not backfilled from older history.
    expect(scoredTripCount).toBe(DASHBOARD_SCORE_TRIPS - 1);
    const oracle = rows.slice(0, DASHBOARD_SCORE_TRIPS).filter((t) => t.score_overall != null);
    expect(avgScore).toBe(Math.round(
      oracle.reduce((sum, t) => sum + t.score_overall * t.distance_km, 0)
      / oracle.reduce((sum, t) => sum + t.distance_km, 0)
    ));
  });

  it('reports no score rather than a zero when nothing is scored', () => {
    expect(dashboardAverageScore([], componentScore))
      .toMatchObject({ avgScore: null, avgScoreEvidence: 'unavailable', scoredTripCount: 0 });
    expect(dashboardAverageScore([driverTrip('a', 10, null)], componentScore).avgScore).toBeNull();
    // A scored row with no distance carries no weight, so there is no mean.
    expect(dashboardAverageScore([driverTrip('b', 0, 90)], componentScore).avgScore).toBeNull();
  });

  it('carries the weakest evidence in the window, never the strongest', () => {
    const strong = [driverTrip('a', 10, 90, { evidence: 'high' })];
    expect(dashboardAverageScore(strong, componentScore).avgScoreEvidence).toBe('high');

    const mixed = [...strong, driverTrip('b', 10, 80, { evidence: 'developing' })];
    expect(dashboardAverageScore(mixed, componentScore).avgScoreEvidence).toBe('developing');

    const weakest = [...mixed, driverTrip('c', 10, 70, { evidence: 'low' })];
    expect(dashboardAverageScore(weakest, componentScore).avgScoreEvidence).toBe('low');
  });
});

describe('P7 Stage 6.4 — O03/O06 come from the reducer, in fixed space', () => {
  const implementation = P7_REDUCER_IMPLEMENTATIONS['p7.dashboard.activityStats@1'];

  /** Fold the registered reducer the way the runner does: ordered, one pass. */
  const fold = (rows) => implementation.finish(rows.reduce(implementation.fold, implementation.init()));

  it('counts distinct LOCAL days, which a UTC bucket would miscount', () => {
    // Three trips whose UTC dates are two distinct days, but which all fall in
    // one local day at +05:30.
    const rows = [
      { id: 'a', start_time: '2026-03-14T18:40:00.000Z', trip_utc_offset_minutes: 330, distance_km: 10, duration_seconds: 600 },
      { id: 'b', start_time: '2026-03-14T19:20:00.000Z', trip_utc_offset_minutes: 330, distance_km: 12, duration_seconds: 900 },
      { id: 'c', start_time: '2026-03-15T06:00:00.000Z', trip_utc_offset_minutes: 330, distance_km: 8, duration_seconds: 300 },
    ];

    const utcDays = new Set(rows.map((row) => row.start_time.slice(0, 10)));
    expect(utcDays.size).toBe(2);
    const localDays = new Set(rows.map((row) => localDayKey(row)));
    expect([...localDays]).toEqual(['2026-03-15']);

    // A UTC day bucket would report two active days for one day of driving.
    expect(fold(rows).active_local_days).toBe(localDays.size);
    expect(fold(rows).active_local_days).not.toBe(utcDays.size);
  });

  it('matches an independent fold for the terms no aggregate owner keys', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `act-${index}`,
      start_time: new Date(Date.UTC(2026, 4, 4 + Math.floor(index / 3), 9 + index)).toISOString(),
      trip_utc_offset_minutes: 0,
      distance_km: 5 + index * 2,
      duration_seconds: 600 + index * 60,
    }));

    const output = fold(rows);

    expect(output.trip_count).toBe(rows.length);
    expect(output.distance_m).toBeCloseTo(rows.reduce((s, r) => s + r.distance_km * 1000, 0), 6);
    expect(output.driving_seconds).toBe(rows.reduce((s, r) => s + r.duration_seconds, 0));
    expect(output.longest_trip_distance_m)
      .toBeCloseTo(Math.max(...rows.map((r) => r.distance_km)) * 1000, 6);
    expect(output.active_local_days).toBe(new Set(rows.map(localDayKey)).size);
    // O06's two means are derived from these terms, not accumulated separately.
    expect(output.distance_m / 1000 / output.trip_count)
      .toBeCloseTo(rows.reduce((s, r) => s + r.distance_km, 0) / rows.length, 6);
  });

  it('keeps the accumulator fixed in size as the history grows', () => {
    const keysFor = (count) => {
      const accumulator = Array.from({ length: count }, (_, index) => ({
        id: `n-${index}`,
        start_time: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
        trip_utc_offset_minutes: 0,
        distance_km: 3,
        duration_seconds: 300,
      })).reduce(implementation.fold, implementation.init());
      return Object.keys(accumulator).sort();
    };

    // The local-day count is exact without a day set: the ordered scan keeps
    // one last-seen key. More retained history must not widen the state.
    expect(keysFor(400)).toEqual(keysFor(4));
  });
});

describe('P7 Stage 6.5 — Insights queries the windows it presents', () => {
  it('no longer holds the (50) + (200) pair, and reads detail through Q2', () => {
    const source = pageSource('Insights.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).not.toContain('tripDetailQueryOptions');
    expect(source).toContain('useInsightsData');
    expect(source).toContain('p7DetailQueryOptions');
  });

  it('keeps the per-trip evidence fan-out capped, with no N x Q2', () => {
    const source = pageSource('Insights.jsx');
    expect(INSIGHTS_DETAIL_FANOUT).toBe(12);
    // The cap is applied to the id list before the fan-out is issued.
    expect(source).toContain('slice(0, INSIGHTS_DETAIL_FANOUT)');
    const fanOuts = source.match(/useQueries\s*\(/g) ?? [];
    expect(fanOuts).toHaveLength(1);
  });

  it('matches the Q graph and semantics its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/Insights.jsx');
    expect(entry.qGraph).toEqual([
      'Q1 (analysis window)', 'Q1 (calendar grid)', 'Q1 (newest row)', 'Q2 x<=12',
    ]);
    expect(entry.caps.detail).toBe(INSIGHTS_DETAIL_FANOUT);
    expect(entry.legacy).toBe('(50)+(200) -> retire');
  });

  it('distinguishes an empty window from an empty history, and both from a failure', () => {
    const source = pageSource('Insights.jsx');
    // "No completed drives at all" is answered by the newest-row read, not by
    // the window being empty — those are different facts and different copy.
    expect(source).toContain('hasAnyCompleted');
    expect(source).toContain('windowUnavailable');
    expect(source).toContain('could not read your drives');
    // An unfinished window is labelled and finishable, never silently short.
    expect(source).toContain('windowContinuation');
    expect(source).toContain('have not been read yet');
    expect(source).toContain('extendWindow');
  });

  it('covers the selected period, the prior period and the baseline window', () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);

    for (const periodDays of [7, 30, 90]) {
      const range = insightsAnalysisRange(periodDays, now);
      const spanDays = (range.toMs - range.fromMs) / DAY;

      expect(range.toMs).toBe(now);
      // The prior period is compared against the current one, so both are read.
      expect(spanDays).toBeGreaterThanOrEqual(2 * periodDays);
      // O52's personal baseline is a 12-week calendar window, not a slice of
      // the selection, so a 7-day selection still reads back 12 weeks.
      expect(spanDays).toBeGreaterThanOrEqual(INSIGHTS_BASELINE_DAYS);
    }

    expect((insightsAnalysisRange(7, now).toMs - insightsAnalysisRange(7, now).fromMs) / DAY)
      .toBe(INSIGHTS_BASELINE_DAYS);
    expect((insightsAnalysisRange(90, now).toMs - insightsAnalysisRange(90, now).fromMs) / DAY)
      .toBe(180);
  });

  it('extends the window back to a running experiment, so its progress is measured', () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const startedAt = new Date(now - 200 * DAY).toISOString();

    const withExperiment = insightsAnalysisRange(30, now, startedAt);
    expect(withExperiment.fromMs).toBe(Date.parse(startedAt));

    // A recent experiment is already inside the window and changes nothing.
    const recent = new Date(now - 5 * DAY).toISOString();
    expect(insightsAnalysisRange(30, now, recent))
      .toEqual(insightsAnalysisRange(30, now));
  });

  it('scans exactly the six-week LOCAL grid the calendar renders', () => {
    const monthDate = new Date(2026, 5, 1);
    const range = insightsCalendarRange(monthDate);

    expect((range.toMs - range.fromMs) / DAY).toBe(INSIGHTS_CALENDAR_GRID_DAYS);
    const start = new Date(range.fromMs);
    // The grid starts on the Sunday on or before the 1st, at LOCAL midnight —
    // which is why this cannot be served from a UTC day bucket.
    expect(start.getDay()).toBe(0);
    expect(start.getHours()).toBe(0);
    expect(start.getTime()).toBeLessThanOrEqual(monthDate.getTime());
    expect(monthDate.getTime() - start.getTime()).toBeLessThan(7 * DAY);
    // The grid covers the whole month it is laid out for.
    const monthEnd = new Date(2026, 6, 1).getTime();
    expect(range.toMs).toBeGreaterThanOrEqual(monthEnd);
  });

  it('opens the calendar on the month of the newest drive, exactly', () => {
    const now = new Date(2026, 5, 15);

    // A drive this month keeps the calendar on this month.
    expect(insightsMonthOffset(new Date(2026, 5, 2).toISOString(), now)).toBe(0);
    // The newest drive was in March, which is three months back — a fact the
    // page used to guess from whichever rows happened to be loaded.
    expect(insightsMonthOffset(new Date(2026, 2, 20).toISOString(), now)).toBe(-3);
    // Across a year boundary.
    expect(insightsMonthOffset(new Date(2025, 10, 4).toISOString(), now)).toBe(-7);
    // No drives at all: this month, not a guess.
    expect(insightsMonthOffset(null, now)).toBe(0);
  });

  it('lets the calendar read its own window rather than the analysis rows', () => {
    const source = withoutComments(
      readFileSync(path.join(SRC_ROOT, 'components/insights/InsightHistoryPanels.jsx'), 'utf8')
    );
    // The month selection is the caller's, because changing months changes
    // which window is queried — not which loaded rows are filtered.
    expect(source).toContain('calendarTrips');
    expect(source).toContain('onMonthOffsetChange');
    expect(source).not.toContain('initialCalendarMonthOffset');
    expect(source).toContain('buildTripCalendarMonth(calendarRows');
  });
});

describe('P7 Stage 6.6 — DrivingCoach separates its window from its history', () => {
  it('no longer holds the (50) + (200) pair, and reads detail through Q2', () => {
    const source = pageSource('DrivingCoach.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).not.toContain('tripDetailQueryOptions');
    expect(source).toContain('useDrivingCoachData');
    expect(source).toContain('p7DetailQueryOptions');
  });

  it('keeps the segment fan-out capped at five, with no N x Q2', () => {
    const source = pageSource('DrivingCoach.jsx');
    expect(COACH_DETAIL_FANOUT).toBe(5);
    expect(source).toContain('slice(0, COACH_DETAIL_FANOUT)');
    expect((source.match(/useQueries\s*\(/g) ?? [])).toHaveLength(1);
  });

  it('matches the Q graph and semantics its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/DrivingCoach.jsx');
    expect(entry.qGraph).toEqual([
      'Q1',
      'Q4 (P-COMPLETED lifetime)',
      'Q10:p7.report.durationDistance@1 (P-DRIVER lifetime)',
      'Q2 x<=5',
    ]);
    expect(entry.caps.detail).toBe(COACH_DETAIL_FANOUT);
    expect(entry.legacy).toBe('(50)+(200) -> retire');
  });

  it('sources the P-DRIVER lifetime count from a reducer, never from an aggregate', () => {
    const source = withoutComments(
      readFileSync(path.join(SRC_ROOT, 'hooks/useDrivingCoachData.js'), 'utf8')
    );
    // §C1a.0: no aggregate owner can express P-DRIVER, so the driver-eligible
    // lifetime count comes from a named reducer and the completed count from Q4.
    expect(source).toContain("'p7.report.durationDistance@1'");
    const reducerEntry = P7_REDUCER_REGISTRY.find((e) => e.identity === 'p7.report.durationDistance@1');
    expect(reducerEntry).toBeTruthy();
    expect(P7_REDUCER_IMPLEMENTATIONS['p7.report.durationDistance@1'].population).toBe('P-DRIVER');
    expect(P7_REDUCER_IMPLEMENTATIONS['p7.dashboard.activityStats@1'].population).toBe('P-COMPLETED');
  });

  it('O21: the evidence audit reports the history, not the size of its window', () => {
    // A window of four rows, three of them driver-eligible.
    const window = [
      { id: 'a', status: 'completed', score_overall: 80, distance_km: 12, start_time: '2026-05-01T09:00:00.000Z' },
      { id: 'b', status: 'completed', score_overall: 70, distance_km: 8, start_time: '2026-05-02T09:00:00.000Z' },
      { id: 'c', status: 'completed', score_overall: 60, distance_km: 9, start_time: '2026-05-03T09:00:00.000Z' },
      { id: 'd', status: 'completed', score_overall: 50, distance_km: 5, start_time: '2026-05-04T09:00:00.000Z', was_driver: 'no' },
    ];
    const drivers = window.filter(isDriverMetricEligible);
    expect(drivers).toHaveLength(3);

    // Without owners the audit describes the window, which is what the page
    // used to present as the driver's whole history.
    const windowed = buildCoachEvidenceAudit(window, drivers);
    expect(windowed.totalCompleted).toBe(4);
    expect(windowed.driverEligible).toBe(3);
    expect(windowed.lifetimeExact).toBe(false);

    const withOwners = buildCoachEvidenceAudit(window, drivers, {
      lifetime: { totalCompleted: 1840, driverEligible: 1712, exact: true },
    });
    expect(withOwners.totalCompleted).toBe(1840);
    expect(withOwners.driverEligible).toBe(1712);
    expect(withOwners.excludedDriver).toBe(128);
    expect(withOwners.lifetimeExact).toBe(true);
    // The window is still reported, because the readiness terms describe it.
    expect(withOwners.windowTrips).toBe(4);
  });

  it('keeps the per-trip readiness terms on the window they were measured over', () => {
    const window = [
      { id: 'a', status: 'completed', score_overall: 80, distance_km: 12, start_time: '2026-05-01T09:00:00.000Z' },
      { id: 'b', status: 'completed', distance_km: 8, start_time: '2026-05-02T09:00:00.000Z' },
    ];
    const audit = buildCoachEvidenceAudit(window, window, {
      lifetime: { totalCompleted: 900, driverEligible: 880, exact: true },
    });

    // A lifetime override must not leak into a term no owner keys: score /
    // event / route readiness are per-row predicates over the window only.
    expect(audit.scoreReady).toBeLessThanOrEqual(window.length);
    expect(audit.eventReady).toBeLessThanOrEqual(window.length);
    expect(audit.routeReady).toBeLessThanOrEqual(window.length);
    expect(audit.trendEligible).toBe(window.length);
  });

  it('labels a lifetime count that has not reached EOF, and offers to finish it', () => {
    const source = pageSource('DrivingCoach.jsx');
    // A partial tally is a floor: the copy says "so far" and the surface has an
    // explicit action to finish it. Nothing on a render path drives it.
    expect(source).toContain('lifetimeExact');
    expect(source).toContain('so far');
    expect(source).toContain('finishDriverLifetime');
    expect(source).toContain('still being prepared');

    const hook = withoutComments(
      readFileSync(path.join(SRC_ROOT, 'hooks/useDrivingCoachData.js'), 'utf8')
    );
    expect(hook).not.toMatch(/useEffect/);
    // Exactness requires both owners: a served aggregate and a terminal reducer.
    expect(hook).toContain('driverEligible != null && driverExact');
  });

  it('labels its analysis window as a window, on both audit surfaces', () => {
    const premium = withoutComments(
      readFileSync(path.join(SRC_ROOT, 'components/PremiumHistoricalEvidenceAuditCard.jsx'), 'utf8')
    );
    // The premium card renders the same five figures, so it must carry the
    // same distinction rather than presenting a sample as a history.
    expect(premium).toContain('lifetimeExact');
    expect(premium).toContain('windowLabel');
    expect(premium).toContain('latest ${windowTrips}');
  });
});

describe('P7 Stage 6.7 — Report queries the period it names', () => {
  it('holds no trip array and no limited-summary read', () => {
    const source = pageSource('Report.jsx');
    expect(source).not.toMatch(/limitedTripSummaryQueryOptions/);
    expect(source).toContain('useReportData');
    // Every figure used to be folded from `trips`. The array is gone.
    expect(source).not.toMatch(/generateReportSummary\(/);
    expect(source).not.toMatch(/analyzeTimeOfDay\(/);
    expect(source).not.toMatch(/calculatePeakHourStress\(/);
    expect(source).not.toMatch(/computeUBIReport\(/);
  });

  it('matches the Q graph and semantics its ledger entry declares', () => {
    const entry = P7_CONSUMER_LEDGER.find((e) => e.consumer === 'src/pages/Report.jsx');
    expect(entry.qGraph[0]).toContain('Q1');
    expect(entry.qGraph[1]).toContain('Q10');
    // §C1a.0: no aggregate owner may serve this page's P-DRIVER rows.
    expect(entry.qGraph.join(' ')).not.toMatch(/\bQ4\b/);
    expect(entry.qGraph.join(' ')).not.toMatch(/\bQ5\b/);
    expect(entry.caps.detail).toBe(0);
    expect(entry.legacy).toBe('(200) all-time sample -> retire');
  });

  it("O24: 'all' is a genuine lifetime, and every other period is its own window", () => {
    const now = Date.UTC(2026, 6, 20, 10, 0, 0);

    // A lifetime selection binds no range at all — not "the widest page".
    expect(reportWindow('all', 7, now)).toBeNull();
    expect(reportPreviousWindow('all', 7, now)).toBeNull();

    for (const [period, days] of [['week', 7], ['month', 30], ['quarter', 90]]) {
      const current = reportWindow(period, days, now);
      expect(current.toMs).toBe(now);
      expect((current.toMs - current.fromMs) / DAY).toBe(days);

      // O62: the immediately preceding window of equal length, adjacent and
      // half-open, so no drive is counted in both.
      const previous = reportPreviousWindow(period, days, now);
      expect(previous.toMs).toBe(current.fromMs);
      expect((previous.toMs - previous.fromMs) / DAY).toBe(days);
    }
  });

  it('O57: declares its day buckets up front, over the complete window', () => {
    const now = Date.UTC(2026, 6, 20, 10, 0, 0);

    expect(reportDailyDays('week', 7, now)).toHaveLength(7);
    expect(reportDailyDays('month', 30, now)).toHaveLength(30);
    expect(reportDailyDays('all', 7, now)).toHaveLength(30);
    // P7-IMPL-F03. This used to assert the truncation itself — 90 days charted
    // as 31 — which codified the defect rather than catching it. The reducer
    // bucket cap bounds one **invocation**; the window is covered by a fixed
    // number of segments, so the selected period is charted in full.
    expect(reportDailyDays('quarter', 90, now)).toHaveLength(90);
    expect(reportDailySegments('quarter', 90, now).length)
      .toBe(Math.ceil(90 / REPORT_DAILY_CAP));
    for (const segment of reportDailySegments('quarter', 90, now)) {
      expect(segment.days.length).toBeLessThanOrEqual(REPORT_DAILY_CAP);
    }

    const days = reportDailyDays('month', 30, now);
    expect(new Set(days).size).toBe(days.length);
    expect(days[days.length - 1]).toBe(days.slice().sort()[days.length - 1]);
  });

  it('O52: the baseline windows are calendar weeks, not a slice of the period', () => {
    const now = new Date(2026, 6, 22, 15, 0, 0);
    const four = reportCalendarWeeks(REPORT_BASELINE_WEEKS, now);
    const twelve = reportCalendarWeeks(REPORT_PERCENTILE_WEEKS, now);

    for (const range of [four, twelve]) {
      const start = new Date(range.fromMs);
      // Each window starts on a local week boundary (Sunday midnight).
      expect(start.getDay()).toBe(0);
      expect(start.getHours()).toBe(0);
    }
    expect((four.fromMs - twelve.fromMs) / DAY).toBe(8 * 7);
    // The 12-week window contains the 4-week one, so one scan serves both.
    expect(twelve.fromMs).toBeLessThan(four.fromMs);
  });
});

describe('P7 Stage 6.7 — the Report arithmetic is unchanged, only its source', () => {
  const rows = [
    { id: 'a', status: 'completed', driver_metric_eligible: true, start_time: '2026-05-04T08:30:00.000Z', distance_km: 20, duration_seconds: 1800, score_overall: 90, score_safety: 92, score_smoothness: 84, harsh_brakes_count: 1, rapid_accel_count: 0, sharp_turns_count: 2, speeding_events_count: 0 },
    { id: 'b', status: 'completed', driver_metric_eligible: true, start_time: '2026-05-04T18:10:00.000Z', distance_km: 10, duration_seconds: 900, score_overall: 70, score_safety: 66, score_smoothness: 74, harsh_brakes_count: 3, rapid_accel_count: 1, sharp_turns_count: 0, speeding_events_count: 4 },
    { id: 'c', status: 'completed', driver_metric_eligible: true, start_time: '2026-05-06T13:00:00.000Z', distance_km: 30, duration_seconds: 2700, score_overall: 80, score_safety: 81, score_smoothness: 79, harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0 },
    // Not driver-eligible: present in storage, absent from every Report row.
    { id: 'passenger', status: 'completed', driver_metric_eligible: false, start_time: '2026-05-06T14:00:00.000Z', distance_km: 500, duration_seconds: 9000, score_overall: 10, harsh_brakes_count: 99 },
  ];

  const foldFor = (identity, context = {}) => {
    const implementation = P7_REDUCER_IMPLEMENTATIONS[identity];
    const predicate = P7_POPULATION_PREDICATES[implementation.population];
    const folded = rows
      .filter((row) => predicate(row, {}))
      .reduce((acc, row) => implementation.fold(acc, row, { localDayKey, ...context }), implementation.init(context));
    return implementation.finish(folded);
  };

  const drivers = rows.filter((row) => row.driver_metric_eligible);

  it('O42-O46: the summary matches the builder it replaces, row for row', () => {
    const summary = reportSummaryFromTerms({
      durationDistance: foldFor('p7.report.durationDistance@1'),
      eventTotals: foldFor('p7.report.eventTotals@1'),
      extrema: foldFor('p7.report.summaryExtrema@1'),
    });
    const oracle = generateReportSummary(drivers);

    expect(summary.total_trips).toBe(oracle.total_trips);
    expect(summary.total_distance_km).toBeCloseTo(oracle.total_distance_km, 6);
    expect(summary.total_duration_seconds).toBe(oracle.total_duration_seconds);
    expect(summary.avg_score).toBe(oracle.avg_score);
    expect(summary.total_harsh_brakes).toBe(oracle.total_harsh_brakes);
    expect(summary.total_speeding_events).toBe(oracle.total_speeding_events);
    expect(summary.most_common_risk).toBe(oracle.most_common_risk);
    expect(summary.best_trip.id).toBe(oracle.best_trip.id);
    expect(summary.worst_trip.id).toBe(oracle.worst_trip.id);

    // The passenger row is in storage and in none of these figures.
    expect(summary.total_trips).toBe(3);
    expect(summary.total_harsh_brakes).toBeLessThan(99);
  });

  it('O48/O49: the hour and weekday profiles match their builders', () => {
    const profiles = foldFor('p7.report.bucketProfiles@1').profiles;

    const timeOfDay = timeOfDayFromProfile(profiles);
    const timeOracle = analyzeTimeOfDay(drivers);
    expect(timeOfDay.map((row) => [row.id, row.trips, row.avgScore, row.events]))
      .toEqual(timeOracle.map((row) => [row.id, row.trips, row.avgScore, row.events]));

    const dayOfWeek = dayOfWeekFromProfile(profiles);
    const dayOracle = analyzeDayOfWeek(drivers);
    expect(dayOfWeek.map((row) => [row.day, row.trips, row.avgScore, row.events]))
      .toEqual(dayOracle.map((row) => [row.day, row.trips, row.avgScore, row.events]));
  });

  it('O54: peak stress is the P-PEAKSTRESS mean of per-trip rates', () => {
    const profiles = foldFor('p7.report.bucketProfiles@1').profiles;
    const stress = peakStressFromProfile(profiles);
    const oracle = calculatePeakHourStress(drivers);

    expect(stress.peak_trip_count).toBe(oracle.peak_trip_count);
    expect(stress.off_peak_trip_count).toBe(oracle.off_peak_trip_count);
    expect(stress.peak_trips_event_rate).toBe(oracle.peak_trips_event_rate);
    expect(stress.off_peak_trips_event_rate).toBe(oracle.off_peak_trips_event_rate);
    expect(stress.stress_ratio).toBe(oracle.stress_ratio);
    expect(stress.insufficient_data).toBe(oracle.insufficient_data);
  });

  it('O73/O74: the distribution bands and component means match their builders', () => {
    const profiles = foldFor('p7.report.bucketProfiles@1').profiles;
    const distribution = scoreDistributionFromProfile(profiles);
    expect(distribution.map((band) => band.count)).toEqual([1, 1, 1, 0]);
    expect(distribution.reduce((sum, band) => sum + band.percent, 0)).toBeCloseTo(100, 6);

    const dd = foldFor('p7.report.durationDistance@1');
    // The same distance-weighted ladder `averageComponentScore` applies.
    const weighted = (field) => Math.round(
      drivers.reduce((sum, row) => sum + row[field] * row.distance_km, 0)
      / drivers.reduce((sum, row) => sum + row.distance_km, 0)
    );
    expect(componentScoreFromTerms(dd, 'safety')).toBe(weighted('score_safety'));
    expect(componentScoreFromTerms(dd, 'smoothness')).toBe(weighted('score_smoothness'));
  });

  it('O50: fatigue matches its builder, with the threshold bound in', () => {
    const threshold = 30;
    const terms = foldFor('p7.report.fatigue@1', { threshold_long_drive_minutes: threshold });
    const fatigue = fatigueFromTerms(terms, threshold);
    const oracle = calculateFatigueRisk(drivers, { threshold_long_drive_minutes: threshold });

    expect(fatigue).toEqual(oracle);
    // A different threshold is a different answer, which is why it is bound
    // into the continuation rather than re-read per turn.
    expect(fatigueFromTerms(
      foldFor('p7.report.fatigue@1', { threshold_long_drive_minutes: 120 }), 120
    ).long_trip_count).toBe(0);
  });

  it('O26: the UBI report is the same math over the declared terms', () => {
    const terms = foldFor('p7.ubi.terms@1');
    // The eight scalars are exactly the eight `ubiReport.js:53` consumes.
    expect(Object.keys(terms).sort()).toEqual([
      'distance_km', 'driving_minutes', 'harsh_brakes', 'night_driving_minutes',
      'rapid_accels', 'sharp_turns', 'speeding_events', 'trip_count',
    ]);

    const fromTerms = computeUBIReportFromTerms(terms, {}, { mileageWindowKm: 12000 });
    const oracle = computeUBIReport(drivers, {});

    expect(fromTerms.tripCount).toBe(oracle.tripCount);
    expect(fromTerms.totalKm).toBe(oracle.totalKm);
    expect(fromTerms.totalDrivingMinutes).toBe(oracle.totalDrivingMinutes);
    expect(fromTerms.insufficientData).toBe(oracle.insufficientData);
    if (!oracle.insufficientData) {
      // Every category except mileage reads the same terms; mileage is scored
      // over its own rolling 12-month window, supplied separately.
      for (const key of ['timeOfDay', 'hardBraking', 'acceleration', 'cornering', 'speedCompliance']) {
        expect(fromTerms.categories[key].score).toBe(oracle.categories[key].score);
      }
    }
  });

  it('O66/O67/O69: the clean, scored and active-day counts come from their owners', () => {
    const events = foldFor('p7.report.eventTotals@1');
    const activity = foldFor('p7.dashboard.activityStats@1');

    // One clean driver trip; the passenger row's 99 brakes are not counted.
    expect(events.report_clean_trip_count).toBe(1);
    expect(events.scored_trip_count).toBe(3);
    // Two distinct LOCAL days across three driver trips. `activityStats` is
    // P-COMPLETED, so the passenger row does count toward its days.
    expect(activity.active_local_days).toBe(new Set(rows.map(localDayKey)).size);
  });

  it('O58/O59 stay empty by source contract, and nothing tries to populate them', () => {
    const source = pageSource('Report.jsx');
    expect(source).toContain('const commutePatterns = [];');
    expect(source).toContain('const complianceChartData = [];');
    // No N x Q2 anywhere on this page.
    expect(source).not.toMatch(/useQueries\s*\(/);

    const o58 = P7_OUTPUTS_REPORT_BODY.find((row) => row.id === 'O58');
    const o59 = P7_OUTPUTS_REPORT_BODY.find((row) => row.id === 'O59');
    expect(o58.qGraph).toEqual([]);
    expect(o59.qGraph).toEqual([]);
  });

  it('O60: an export refuses a scan that did not reach the end of the period', () => {
    const source = pageSource('Report.jsx');
    expect(source).toContain('scanExportWindow');
    expect(source).toContain('refuseShortExport');
    // One trip resident: the writer emits a line per row rather than the page
    // holding a full-history array to hand to the CSV builder.
    expect(source).toContain('createTripCsvWriter');
    expect(source).toContain('writer.rowLine');
    expect(source).not.toContain('tripsToCSV(');
  });

  it('O62: a lifetime report has no prior period, and shows no zero delta', () => {
    const source = pageSource('Report.jsx');
    expect(source).toContain('hasPrevious');
    expect(source).toContain('Need prior period');

    // With no prior terms the deltas are null, which is what renders the
    // "Need prior period" copy rather than a 0.
    const insights = reportInsightsFromTerms({
      period: 'all',
      periodDays: 7,
      summary: reportSummaryFromTerms({ durationDistance: foldFor('p7.report.durationDistance@1') }),
      previousSummary: reportSummaryFromTerms({}),
      hasPrevious: false,
      activeLocalDays: 2,
      cleanTripCount: 1,
      scoredTripCount: 3,
      timeOfDayData: timeOfDayFromProfile(foldFor('p7.report.bucketProfiles@1').profiles),
      dayOfWeekData: dayOfWeekFromProfile(foldFor('p7.report.bucketProfiles@1').profiles),
      peakHourStress: peakStressFromProfile(foldFor('p7.report.bucketProfiles@1').profiles),
      riskRowsOf: (summary) => [{ count: Number(summary.total_harsh_brakes) || 0 }],
      nextActionFor: () => 'unchanged',
    });

    expect(insights.distanceDelta).toBeNull();
    expect(insights.scoreDelta).toBeNull();
    expect(insights.eventRateDelta).toBeNull();
    // `period === 'all'` makes coverage a ratio of active days to itself.
    expect(insights.coveragePercent).toBe(100);
  });
});
