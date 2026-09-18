// The Report's local-day window is defined in the **viewer's** zone, so the DST
// discriminators below need a zone that actually has transitions. Set before
// anything that captures a `Date` is imported.
process.env.TZ = 'America/Toronto';

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
} from '@/lib/tripInsights';
import { COACHING_CONTENT } from '@/lib/coachingContent';
import { P7_REDUCER_IMPLEMENTATIONS } from '@/lib/tripQueryReducers';
import { P7_POPULATION_PREDICATES, localDayKey } from '@/lib/queryReducers/populations';
import { tipsFromTerms } from '@/lib/reportTerms';
import {
  REPORT_DAILY_CAP,
  reportDailyDays,
  reportDailySegments,
} from '@/hooks/useReportData';

/**
 * P7-IMPL-F01 and P7-IMPL-F03 — terminal semantics on the Report.
 *
 * The closure review accepted that the *terminal* O47 result reproduces
 * `buildScoreTips` exactly, and that 90 days is now split into bounded
 * invocations. Two things still made the page say something untrue while the
 * answer was still being assembled:
 *
 * 1. **O47 ranked a partial tally.** `tipsFromTerms` was handed
 *    `result.data.partial` and ranked it — an argmax, a 0.35 share and a mean
 *    against 85/70, all computed over whichever page happened to arrive first.
 * 2. **O57 called a partial chart complete.** `dailySeries@1` preinitializes
 *    one bucket per declared day, so its *first* partial answer already carries
 *    every key; inferring completeness from the merged array's length therefore
 *    labelled a 90-day heading over one page of drives.
 *
 * And underneath both, the window itself was stepped in fixed 86,400,000 ms
 * intervals, which is not a local calendar day on the two days a year it
 * matters.
 */

const BASE = Date.UTC(2026, 3, 1, 9);

const settings = {
  scoreTipMinTripKm: SCORE_TIP_MIN_TRIP_KM,
  scoreTipMinConfidence: SCORE_TIP_MIN_CONFIDENCE,
  peakStressMinTripKm: PEAK_STRESS_MIN_TRIP_KM,
};

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

const MESSAGES = {
  harsh_brake: COACHING_CONTENT.harsh_brakes.scoreTip,
  rapid_acceleration: COACHING_CONTENT.rapid_accel.scoreTip,
  sharp_turn: COACHING_CONTENT.sharp_turns.scoreTip,
  speeding: COACHING_CONTENT.speeding.scoreTip,
};

const COPY = {
  emptyCopy: 'Not enough data yet. Record a few trips to unlock personalized coaching tips.',
  ineligibleCopy: 'Not enough data yet. Complete a trip of at least 2 km for coaching tips.',
  nightCopy: 'A large share of trips happen at night, where Road Sage applies extra safety risk. Keep routes familiar and take breaks on longer drives.',
  highScoreCopy: 'Your recent average is excellent. Keep the streak going by protecting smooth starts and early braking.',
  lowScoreCopy: COACHING_CONTENT.consistency.scoreTip,
};

/**
 * Fold a reducer over one **page** of rows, as one bounded turn would.
 *
 * `carried` is the accumulator a continuation would have carried forward, so a
 * sequence of these is exactly a multi-turn Q10 run.
 */
const foldTurn = (identity, rows, { narrowTo = null, context = {}, carried = null } = {}) => {
  const implementation = P7_REDUCER_IMPLEMENTATIONS[identity];
  const predicate = P7_POPULATION_PREDICATES[implementation.population];
  const narrowing = narrowTo ? P7_POPULATION_PREDICATES[narrowTo] : null;
  const accumulator = rows
    .filter((row) => predicate(row, settings))
    .filter((row) => !narrowing || narrowing(row, settings))
    .reduce(
      (acc, row) => implementation.fold(acc, row, { ...context, localDayKey }),
      carried ?? implementation.init(context),
    );
  return { accumulator, terms: implementation.finish(accumulator) };
};

/** The Report's O47 call, with the terminal flag the page now passes. */
const reportTips = (terms, { night, weighted, windowTrips, exact }) => tipsFromTerms(terms, {
  night, weighted, windowTrips, exact, messages: MESSAGES, ...COPY,
});

describe('P7-IMPL-F01 — O47 ranks only a terminal tally', () => {
  /**
   * Two pages that rank differently. Page one is all harsh braking at a high
   * score; page two swamps it with speeding at a low score. Whatever the page
   * shows after turn one is a claim it has to take back.
   */
  const PAGE_ONE = [
    ...Array.from({ length: 6 }, () => tipRow({ harsh_brakes_count: 4, score_overall: 96 })),
  ];
  const PAGE_TWO = [
    ...Array.from({ length: 30 }, () => tipRow({
      speeding_events_count: 9, score_overall: 52, night_driving: true,
    })),
  ];

  it('shows the frozen not-enough-data copy while the tally is PARTIAL', () => {
    const totals = foldTurn('p7.report.scoreTipTotals@1', PAGE_ONE);
    const night = foldTurn('p7.report.nightExposure@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });
    const weighted = foldTurn('p7.report.durationDistance@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });

    const partial = reportTips(totals.terms, {
      night: night.terms, weighted: weighted.terms,
      windowTrips: PAGE_ONE.length, exact: false,
    });

    expect(partial).toEqual([COPY.emptyCopy]);
    // Specifically: no branch ranked. None of the four event tips, no night
    // tip, and neither score tip.
    for (const message of [...Object.values(MESSAGES), COPY.nightCopy, COPY.highScoreCopy, COPY.lowScoreCopy]) {
      expect(partial).not.toContain(message);
    }
  });

  it('the partial tally would have ranked differently from the terminal one', () => {
    // This is what makes the gate load-bearing rather than cosmetic: ranking
    // page one is not a rougher version of the answer, it is a different one.
    const pageOne = foldTurn('p7.report.scoreTipTotals@1', PAGE_ONE);
    const pageOneNight = foldTurn('p7.report.nightExposure@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });
    const pageOneWeighted = foldTurn('p7.report.durationDistance@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });

    const wouldHaveShown = reportTips(pageOne.terms, {
      night: pageOneNight.terms, weighted: pageOneWeighted.terms,
      windowTrips: PAGE_ONE.length, exact: true,
    });
    expect(wouldHaveShown).toContain(MESSAGES.harsh_brake);
    expect(wouldHaveShown).toContain(COPY.highScoreCopy);

    const terminal = reportTips(
      foldTurn('p7.report.scoreTipTotals@1', PAGE_TWO, { carried: pageOne.accumulator }).terms,
      {
        night: foldTurn('p7.report.nightExposure@1', PAGE_TWO, {
          narrowTo: 'P-SCORETIP', carried: pageOneNight.accumulator,
        }).terms,
        weighted: foldTurn('p7.report.durationDistance@1', PAGE_TWO, {
          narrowTo: 'P-SCORETIP', carried: pageOneWeighted.accumulator,
        }).terms,
        windowTrips: PAGE_ONE.length + PAGE_TWO.length,
        exact: true,
      }
    );
    expect(terminal).toContain(MESSAGES.speeding);
    expect(terminal).toContain(COPY.nightCopy);
    expect(terminal).toContain(COPY.lowScoreCopy);
    expect(terminal).not.toContain(MESSAGES.harsh_brake);
  });

  it('the terminal answer still equals the pre-migration oracle exactly', () => {
    const rows = [...PAGE_ONE, ...PAGE_TWO];
    const pageOne = foldTurn('p7.report.scoreTipTotals@1', PAGE_ONE);
    const pageOneNight = foldTurn('p7.report.nightExposure@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });
    const pageOneWeighted = foldTurn('p7.report.durationDistance@1', PAGE_ONE, { narrowTo: 'P-SCORETIP' });

    const terminal = reportTips(
      foldTurn('p7.report.scoreTipTotals@1', PAGE_TWO, { carried: pageOne.accumulator }).terms,
      {
        night: foldTurn('p7.report.nightExposure@1', PAGE_TWO, {
          narrowTo: 'P-SCORETIP', carried: pageOneNight.accumulator,
        }).terms,
        weighted: foldTurn('p7.report.durationDistance@1', PAGE_TWO, {
          narrowTo: 'P-SCORETIP', carried: pageOneWeighted.accumulator,
        }).terms,
        windowTrips: rows.length,
        exact: true,
      }
    );
    expect(terminal).toEqual(buildScoreTips(rows));
  });

  it('an empty terminal window keeps its own copy, not the partial one', () => {
    // The gate must not collapse the three empty states into one: "still
    // reading" and "nothing to read" are different facts.
    const none = reportTips(null, { night: null, weighted: null, windowTrips: 0, exact: true });
    expect(none).toEqual(buildScoreTips([]));
  });
});

describe('P7-IMPL-F03 — the O57 window is local calendar days', () => {
  /** Step the local calendar itself, which is the definition being asserted. */
  const calendarWalk = (count, endMs) => {
    const days = [];
    const at = new Date(endMs);
    at.setHours(0, 0, 0, 0);
    at.setDate(at.getDate() - (count - 1));
    for (let index = 0; index < count; index += 1) {
      days.push([
        at.getFullYear(),
        String(at.getMonth() + 1).padStart(2, '0'),
        String(at.getDate()).padStart(2, '0'),
      ].join('-'));
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
    }
    return days;
  };

  it('runs in the right zone for this discriminator to mean anything', () => {
    // A fixed-offset zone cannot reproduce either failure, so assert the
    // assumption rather than passing vacuously.
    expect(new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset())
      .not.toBe(new Date(Date.UTC(2026, 6, 15)).getTimezoneOffset());
  });

  it("Codex's spring-forward window covers March 8 and starts on December 10", () => {
    // The reproduction, verbatim: 90 days ending 2026-03-09T04:30Z produced 90
    // unique keys, omitted 2026-03-08, and reached back to 2025-12-09 instead.
    const end = Date.parse('2026-03-09T04:30:00.000Z');
    const days = reportDailyDays('quarter', 90, end);

    expect(days).toHaveLength(90);
    expect(new Set(days).size).toBe(90);
    expect(days).toContain('2026-03-08');
    expect(days[0]).toBe('2025-12-10');
    expect(days.at(-1)).toBe('2026-03-09');
    expect(days).toEqual(calendarWalk(90, end));
  });

  it('a fall-back window has no duplicated and no missing local day', () => {
    // 23:30 local on 2026-11-10: fixed stepping back across the 25-hour day
    // repeated 2026-11-01 and dropped 2026-08-13, leaving 89 distinct days
    // under a "90 days" heading.
    const end = Date.parse('2026-11-11T04:30:00.000Z');
    const days = reportDailyDays('quarter', 90, end);

    expect(days).toHaveLength(90);
    expect(new Set(days).size).toBe(90);
    expect(days).toContain('2026-11-01');
    expect(days).toContain('2026-08-13');
    expect(days).toEqual(calendarWalk(90, end));
  });

  it('every selectable period charts exactly the days it names', () => {
    for (const end of [
      Date.parse('2026-03-09T04:30:00.000Z'),
      Date.parse('2026-03-08T18:00:00.000Z'),
      Date.parse('2026-11-01T18:00:00.000Z'),
      Date.parse('2026-11-11T04:30:00.000Z'),
    ]) {
      expect(reportDailyDays('week', 7, end)).toHaveLength(7);
      expect(reportDailyDays('month', 30, end)).toHaveLength(30);
      expect(reportDailyDays('quarter', 90, end)).toHaveLength(90);
      // `all` keeps its frozen last-30 behaviour.
      expect(reportDailyDays('all', 90, end)).toEqual(calendarWalk(30, end));
      for (const [period, count] of [['week', 7], ['month', 30], ['quarter', 90]]) {
        expect(reportDailyDays(period, count, end)).toEqual(calendarWalk(count, end));
      }
    }
  });

  it('segments are contiguous at next-local-midnight across both transitions', () => {
    for (const end of [
      Date.parse('2026-03-09T04:30:00.000Z'),
      Date.parse('2026-03-08T18:00:00.000Z'),
      Date.parse('2026-11-01T18:00:00.000Z'),
      Date.parse('2026-11-11T04:30:00.000Z'),
    ]) {
      const segments = reportDailySegments('quarter', 90, end);
      expect(segments.length).toBe(Math.ceil(90 / REPORT_DAILY_CAP));
      expect(segments.flatMap((segment) => segment.days))
        .toEqual(reportDailyDays('quarter', 90, end));

      for (const segment of segments) {
        expect(segment.days.length).toBeLessThanOrEqual(REPORT_DAILY_CAP);
        // The bound is local midnight of the first day, and local midnight of
        // the day AFTER the last — not "+24h", which on a 25-hour day leaves an
        // hour of drives in no segment and on a 23-hour day puts an hour in two.
        const from = new Date(segment.range.fromMs);
        expect([from.getHours(), from.getMinutes()]).toEqual([0, 0]);
        const to = new Date(segment.range.toMs);
        expect([to.getHours(), to.getMinutes()]).toEqual([0, 0]);

        const afterLast = new Date(`${segment.days.at(-1)}T00:00:00`);
        afterLast.setDate(afterLast.getDate() + 1);
        afterLast.setHours(0, 0, 0, 0);
        expect(segment.range.toMs).toBe(afterLast.getTime());
        expect(segment.range.fromMs).toBe(new Date(`${segment.days[0]}T00:00:00`).getTime());
      }

      // No gap and no overlap between adjacent segments.
      for (let index = 1; index < segments.length; index += 1) {
        expect(segments[index].range.fromMs).toBe(segments[index - 1].range.toMs);
      }
    }
  });

  it('a segment covers every instant of the local days it declares', () => {
    // The concrete consequence of the "+24h" bound: a drive at 23:30 on the
    // fall-back day fell outside its own segment.
    const end = Date.parse('2026-11-01T18:00:00.000Z');
    const [segment] = reportDailySegments('week', 7, end);
    const lateOnTransitionDay = Date.parse('2026-11-02T03:30:00.000Z'); // 23:30 EDT-> EST Nov 1
    expect(segment.days).toContain('2026-11-01');
    expect(lateOnTransitionDay).toBeGreaterThanOrEqual(segment.range.fromMs);
    expect(lateOnTransitionDay).toBeLessThan(segment.range.toMs);
  });
});

describe('P7-IMPL-F03 — completeness is terminal state, never bucket count', () => {
  const days = ['2026-04-01', '2026-04-02', '2026-04-03'];
  const rows = days.map((date, index) => tipRow({
    start_time: `${date}T12:00:00.000Z`,
    trip_utc_offset_minutes: 0,
    distance_km: 10 + index,
  }));

  it('a PARTIAL daily answer already carries every declared bucket', () => {
    // The exact reason length cannot be the completeness signal.
    const firstTurn = foldTurn('p7.report.dailySeries@1', rows.slice(0, 1), { context: { days } });
    expect(firstTurn.terms).toHaveLength(days.length);
    expect(firstTurn.terms.map((bucket) => bucket.date)).toEqual(days);
    // ...and it is not the finished chart.
    const terminal = foldTurn('p7.report.dailySeries@1', rows.slice(1), {
      context: { days }, carried: firstTurn.accumulator,
    });
    expect(terminal.terms.map((bucket) => bucket.trips))
      .not.toEqual(firstTurn.terms.map((bucket) => bucket.trips));
  });

  it('the hook reports completeness from the segments, not the merged length', async () => {
    // The rule the hook now applies, stated against the hook's own source so a
    // future edit cannot quietly return to inferring it from a row count.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'hooks', 'useReportData.js'),
      'utf8'
    );
    expect(source).toContain('termsExact[`dailySeries:${index}`] === true');
    expect(source).not.toContain('dailyComplete: dailySeriesRows.length === dailyDays.length');
    // And the "N of M so far" count is settled days, not merged rows.
    expect(source).toContain('dailyDaysSettled');
  });
});
