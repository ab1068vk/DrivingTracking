import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));

import {
  PEAK_STRESS_MIN_TRIP_KM,
  SCORE_TIP_MIN_CONFIDENCE,
  SCORE_TIP_MIN_TRIP_KM,
  buildScoreTips,
  calculateCarbonImpact,
  estimateTripEconomics,
} from '@/lib/tripInsights';
import { COACHING_CONTENT } from '@/lib/coachingContent';
import { P7_REDUCER_IMPLEMENTATIONS } from '@/lib/tripQueryReducers';
import { P7_POPULATION_PREDICATES } from '@/lib/queryReducers/populations';
import {
  carbonFromTerms,
  economicsFromTerms,
  tipsFromTerms,
} from '@/lib/reportTerms';
import {
  REPORT_DAILY_CAP,
  reportDailyDayCount,
  reportDailyDays,
  reportDailySegments,
} from '@/hooks/useReportData';

/**
 * Corrections for the accepted Codex implementation findings.
 *
 * Each block reproduces the finding's evidence against the **pre-migration
 * oracle** — `buildScoreTips`, `estimateTripEconomics`, `calculateCarbonImpact`
 * — rather than against the new term shapes. That is what the original Stage-6
 * tests did not do, and it is why three output regressions reached review.
 */

const DAY = 86400000;
const BASE = Date.UTC(2026, 3, 1, 9);

/** Row defaults that clear `P-SCORETIP` eligibility unless a case overrides. */
const tipRow = (overrides = {}) => ({
  id: `t-${Math.random().toString(36).slice(2, 9)}`,
  status: 'completed',
  driver_metric_eligible: true,
  start_time: new Date(BASE).toISOString(),
  distance_km: 10,
  score_confidence: 0.9,
  score_overall: 80,
  night_driving: false,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  ...overrides,
});

const settings = {
  scoreTipMinTripKm: SCORE_TIP_MIN_TRIP_KM,
  scoreTipMinConfidence: SCORE_TIP_MIN_CONFIDENCE,
  peakStressMinTripKm: PEAK_STRESS_MIN_TRIP_KM,
};

/** Fold a reducer the way the runner does, with an optional narrowing. */
const fold = (identity, rows, { narrowTo = null, context = {} } = {}) => {
  const implementation = P7_REDUCER_IMPLEMENTATIONS[identity];
  const predicate = P7_POPULATION_PREDICATES[implementation.population];
  const narrowing = narrowTo ? P7_POPULATION_PREDICATES[narrowTo] : null;
  const folded = rows
    .filter((row) => predicate(row, settings))
    .filter((row) => !narrowing || narrowing(row, settings))
    .reduce((acc, row) => implementation.fold(acc, row, context), implementation.init(context));
  return implementation.finish(folded);
};

/** The delivered O47 output, built exactly as `Report.jsx` builds it. */
const deliveredTips = (rows) => tipsFromTerms(
  fold('p7.report.scoreTipTotals@1', rows),
  {
    night: fold('p7.report.nightExposure@1', rows, { narrowTo: 'P-SCORETIP' }),
    weighted: fold('p7.report.durationDistance@1', rows, { narrowTo: 'P-SCORETIP' }),
    windowTrips: fold('p7.report.durationDistance@1', rows).trip_count,
    messages: {
      harsh_brake: COACHING_CONTENT.harsh_brakes.scoreTip,
      rapid_acceleration: COACHING_CONTENT.rapid_accel.scoreTip,
      sharp_turn: COACHING_CONTENT.sharp_turns.scoreTip,
      speeding: COACHING_CONTENT.speeding.scoreTip,
    },
    emptyCopy: 'Not enough data yet. Record a few trips to unlock personalized coaching tips.',
    ineligibleCopy: 'Not enough data yet. Complete a trip of at least 2 km for coaching tips.',
    nightCopy: 'A large share of trips happen at night, where Road Sage applies extra safety risk. Keep routes familiar and take breaks on longer drives.',
    highScoreCopy: 'Your recent average is excellent. Keep the streak going by protecting smooth starts and early braking.',
    lowScoreCopy: COACHING_CONTENT.consistency.scoreTip,
  },
);

describe('P7-IMPL-F01 — O47 keeps every coaching-tip branch', () => {
  /** The pre-migration oracle is the reference for every case below. */
  const expectMatchesOracle = (rows) => {
    expect(deliveredTips(rows)).toEqual(buildScoreTips(rows));
  };

  it('dominant event only', () => {
    // Score 80 sits between the two score thresholds and no night share, so
    // the event tip is the only branch that fires.
    const rows = [
      tipRow({ harsh_brakes_count: 5 }),
      tipRow({ speeding_events_count: 1 }),
    ];
    const tips = deliveredTips(rows);
    expect(tips).toEqual([COACHING_CONTENT.harsh_brakes.scoreTip]);
    expectMatchesOracle(rows);
  });

  it('night share below, at, and above the 0.35 boundary', () => {
    const nightCopy = 'A large share of trips happen at night';

    // 3 of 10 = 0.30 — below.
    const below = Array.from({ length: 10 }, (_, index) => tipRow({ night_driving: index < 3 }));
    expect(deliveredTips(below).some((tip) => tip.startsWith(nightCopy))).toBe(false);
    expectMatchesOracle(below);

    // 7 of 20 = 0.35 exactly — the oracle uses `>=`, so it fires.
    const at = Array.from({ length: 20 }, (_, index) => tipRow({ night_driving: index < 7 }));
    expect(deliveredTips(at).some((tip) => tip.startsWith(nightCopy))).toBe(true);
    expectMatchesOracle(at);

    // 8 of 20 = 0.40 — above.
    const above = Array.from({ length: 20 }, (_, index) => tipRow({ night_driving: index < 8 }));
    expect(deliveredTips(above).some((tip) => tip.startsWith(nightCopy))).toBe(true);
    expectMatchesOracle(above);
  });

  it('the high-score boundary at 85', () => {
    const high = 'Your recent average is excellent';

    const at85 = [tipRow({ score_overall: 85 })];
    expect(deliveredTips(at85).some((tip) => tip.startsWith(high))).toBe(true);
    expectMatchesOracle(at85);

    const under = [tipRow({ score_overall: 84.9 })];
    expect(deliveredTips(under).some((tip) => tip.startsWith(high))).toBe(false);
    expectMatchesOracle(under);
  });

  it('the low-score boundary at 70', () => {
    const low = COACHING_CONTENT.consistency.scoreTip;

    const at70 = [tipRow({ score_overall: 70 })];
    expect(deliveredTips(at70)).not.toContain(low);
    expectMatchesOracle(at70);

    const under = [tipRow({ score_overall: 69.9 })];
    expect(deliveredTips(under)).toContain(low);
    expectMatchesOracle(under);
  });

  it('is distance-weighted, not a plain mean', () => {
    // A long low-scoring trip and a short high-scoring one: the plain mean is
    // 72.5 (no tip) while the weighted mean is 55 (the consistency tip).
    const rows = [
      tipRow({ distance_km: 90, score_overall: 50 }),
      tipRow({ distance_km: 10, score_overall: 95 }),
    ];
    expect(deliveredTips(rows)).toContain(COACHING_CONTENT.consistency.scoreTip);
    expectMatchesOracle(rows);
  });

  it('emits all three tips, in order, capped at three', () => {
    // Dominant event + night share + low score, all firing at once.
    const rows = Array.from({ length: 10 }, (_, index) => tipRow({
      night_driving: true,
      score_overall: 40,
      harsh_brakes_count: index === 0 ? 9 : 0,
    }));
    const tips = deliveredTips(rows);

    expect(tips).toHaveLength(3);
    expect(tips[0]).toBe(COACHING_CONTENT.harsh_brakes.scoreTip);
    expect(tips[1]).toMatch(/^A large share of trips happen at night/);
    expect(tips[2]).toBe(COACHING_CONTENT.consistency.scoreTip);
    expectMatchesOracle(rows);
  });

  it('excludes rows the P-SCORETIP eligibility bar rejects', () => {
    // Short and low-confidence rows are outside the tip population, and a
    // passenger row is outside the driver population that contains it.
    const rows = [
      tipRow({ harsh_brakes_count: 4 }),
      tipRow({ distance_km: 0.5, harsh_brakes_count: 99 }),
      tipRow({ score_confidence: 0.1, speeding_events_count: 99 }),
      tipRow({ driver_metric_eligible: false, sharp_turns_count: 99 }),
    ];

    const terms = fold('p7.report.scoreTipTotals@1', rows);
    expect(terms.eligible_trip_count).toBe(1);
    // The 99-event rows are in storage and in none of the counters.
    expect(terms.harsh_brake).toBe(4);
    expect(terms.speeding).toBe(0);
    expect(terms.sharp_turn).toBe(0);

    // The oracle itself has no driver filter, so it is compared on the rows
    // the Report page would already have narrowed to drivers.
    expect(deliveredTips(rows))
      .toEqual(buildScoreTips(rows.filter((row) => row.driver_metric_eligible)));
  });

  it('keeps both empty states distinct', () => {
    expect(deliveredTips([])).toEqual(buildScoreTips([]));
    const ineligible = [tipRow({ distance_km: 0.2 })];
    expect(deliveredTips(ineligible)).toEqual(buildScoreTips(ineligible));
  });

  it('narrows by intersection only — it can never widen a population', () => {
    const rows = [
      tipRow({ night_driving: true }),
      tipRow({ night_driving: true, distance_km: 0.4 }),
    ];
    const wide = fold('p7.report.nightExposure@1', rows);
    const narrowed = fold('p7.report.nightExposure@1', rows, { narrowTo: 'P-SCORETIP' });

    expect(wide.night_trip_count).toBe(2);
    expect(narrowed.night_trip_count).toBe(1);
    expect(narrowed.night_trip_count).toBeLessThanOrEqual(wide.night_trip_count);
  });
});

describe('P7-IMPL-F02 — O25 availability and O53 grades match their oracles', () => {
  const vehicle = { id: 'v1', fuel_type: 'gasoline', l_per_100km: 8 };

  it('counts fuel-savings availability, not a non-zero amount', () => {
    // An assigned vehicle driven exactly at its baseline saves 0.00 L, and
    // that is an available zero — the page must not read "Unavailable".
    const trip = {
      id: 'z', status: 'completed', driver_metric_eligible: true,
      start_time: new Date(BASE).toISOString(), distance_km: 10, duration_seconds: 900,
    };
    const estimate = estimateTripEconomics(trip, vehicle, {});
    expect(estimate.fuel_saved_available).toBe(true);
    expect(estimate.fuel_saved_liters).toBe(0);

    const terms = fold('p7.report.economics@1', [trip], {
      context: { estimate: (row) => estimateTripEconomics(row, vehicle, {}) },
    });
    expect(terms.fuel_saved_trip_count).toBe(1);
    expect(economicsFromTerms(terms).savedTripCount).toBe(1);
  });

  it('does not count an unassigned vehicle as available', () => {
    const trip = {
      id: 'u', status: 'completed', driver_metric_eligible: true,
      start_time: new Date(BASE).toISOString(), distance_km: 10, duration_seconds: 900,
    };
    const estimate = estimateTripEconomics(trip, null, {});
    expect(estimate.fuel_saved_available).toBe(false);

    const terms = fold('p7.report.economics@1', [trip], {
      context: { estimate: (row) => estimateTripEconomics(row, null, {}) },
    });
    expect(terms.fuel_saved_trip_count).toBe(0);
  });

  it('reproduces every carbon-grade boundary from calculateCarbonImpact', () => {
    // The two lower bands were the drift: `Getting There` and `Starting Out`.
    for (const saved of [0, 4.9, 5, 19.9, 20, 49.9, 50, 99.9, 100, 250]) {
      const fromTerms = carbonFromTerms({ co2_saved_kg: saved, co2_eligible_trip_count: 1 }, null);
      const oracle = calculateCarbonImpact(
        [{ status: 'completed', distance_km: 10, co2_saved_kg: saved }], {}, null
      );
      expect(fromTerms.carbon_grade, `saved=${saved}`).toBe(oracle.carbon_grade);
      expect(fromTerms.total_co2_saved_kg, `saved=${saved}`).toBe(oracle.total_co2_saved_kg);
      expect(fromTerms.trees_equivalent, `saved=${saved}`).toBe(oracle.trees_equivalent);
    }
  });

  it('keeps the EV grid-intensity availability ladder', () => {
    const ev = { id: 'ev', fuel_type: 'electric', kwh_per_100km: 16 };
    const trip = {
      id: 'e', status: 'completed', driver_metric_eligible: true,
      start_time: new Date(BASE).toISOString(), distance_km: 20, duration_seconds: 1200,
    };
    // Without a known grid intensity an EV cannot claim a CO2 saving.
    const unknown = estimateTripEconomics(trip, ev, {});
    expect(unknown.co2_saved_available).toBe(false);
    expect(unknown.co2_saved_kg).toBeNull();

    const known = estimateTripEconomics(trip, ev, { grid_co2_kg_per_kwh: 0.2 });
    expect(known.co2_saved_available).toBe(true);
    expect(Number.isFinite(known.co2_saved_kg)).toBe(true);
  });

  it('reports savings_available from the eligible count, as the oracle does', () => {
    expect(carbonFromTerms({ co2_saved_kg: 0, co2_eligible_trip_count: 0 }, null).savings_available)
      .toBe(false);
    expect(carbonFromTerms({ co2_saved_kg: 0, co2_eligible_trip_count: 2 }, null).savings_available)
      .toBe(true);
  });
});

describe('P7-IMPL-F03 — O57 renders the complete selected window', () => {
  const now = Date.UTC(2026, 6, 20, 15, 0, 0);

  it('charts the frozen day count for every selectable period', () => {
    expect(reportDailyDayCount('week', 7)).toBe(7);
    expect(reportDailyDayCount('month', 30)).toBe(30);
    expect(reportDailyDayCount('all', 7)).toBe(30);
    // The finding: 90 must be 90, not 31.
    expect(reportDailyDayCount('quarter', 90)).toBe(90);

    expect(reportDailyDays('quarter', 90, now)).toHaveLength(90);
  });

  it('splits 90 days into bounded segments, none above the reducer cap', () => {
    const segments = reportDailySegments('quarter', 90, now);

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      expect(segment.days.length).toBeLessThanOrEqual(REPORT_DAILY_CAP);
    }
    // A short period is a single segment: nothing changed for 7 or 30 days.
    expect(reportDailySegments('week', 7, now)).toHaveLength(1);
    expect(reportDailySegments('month', 30, now)).toHaveLength(1);
    expect(reportDailySegments('all', 7, now)).toHaveLength(1);
  });

  it('has no gap and no duplicate day across the segment boundaries', () => {
    const segments = reportDailySegments('quarter', 90, now);
    const merged = segments.flatMap((segment) => segment.days);

    expect(merged).toEqual(reportDailyDays('quarter', 90, now));
    expect(new Set(merged).size).toBe(90);
    // Strictly ascending, one local day apart, across every boundary.
    for (let index = 1; index < merged.length; index += 1) {
      const previous = new Date(`${merged[index - 1]}T12:00:00`);
      const current = new Date(`${merged[index]}T12:00:00`);
      const gapDays = Math.round((current - previous) / DAY);
      expect(gapDays, `${merged[index - 1]} -> ${merged[index]}`).toBe(1);
    }
  });

  it('binds each segment to a range that covers exactly its own local days', () => {
    const segments = reportDailySegments('quarter', 90, now);

    for (const segment of segments) {
      const first = new Date(`${segment.days[0]}T00:00:00`);
      const last = new Date(`${segment.days[segment.days.length - 1]}T00:00:00`);
      expect(segment.range.fromMs).toBe(first.getTime());
      expect(segment.range.toMs).toBe(last.getTime() + DAY);
    }
    // Ranges are contiguous and non-overlapping, so no row is counted twice
    // and none falls between two segments.
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].range.fromMs).toBe(segments[index - 1].range.toMs);
    }
  });

  it('keeps local-day grouping across a DST transition', () => {
    // US DST ends 2026-11-01. A day-count walk over UTC milliseconds would
    // drift here; local day keys must not.
    const dstNow = new Date(2026, 10, 5, 12, 0, 0).getTime();
    const days = reportDailyDays('quarter', 90, dstNow);

    expect(days).toHaveLength(90);
    expect(new Set(days).size).toBe(90);
    expect(days).toContain('2026-11-01');
    expect(days[days.length - 1]).toBe('2026-11-05');
  });
});
