import { useCallback, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';
import {
  PEAK_STRESS_MIN_TRIP_KM,
  SCORE_TIP_MIN_CONFIDENCE,
  SCORE_TIP_MIN_TRIP_KM,
} from '@/lib/tripInsights';

/**
 * The Report page's canonical composition (P7 Stage 6.7, ledger entry #8,
 * Annex C rows **O23-O26** and **O42-O75**).
 *
 * What it replaces: a single `limitedTripSummaryQueryOptions(200)` read that
 * every figure on the page was folded from. The report has a **period
 * selector** — 7 days, 30 days, 90 days, all — so past 200 retained drives the
 * "90 days" and "all time" reports silently described the newest 200 drives,
 * with a period label above them saying otherwise. That is the failure this
 * stage removes.
 *
 * Each row now comes from the named reducer Annex C assigns it, bound to the
 * selected window. A reducer is **one bounded turn per invocation**: more
 * retained history costs more turns, never a wider turn, and a tally short of
 * terminal EOF is reported as `PARTIAL` and rendered as a floor.
 *
 * | Window | Reducers |
 * |---|---|
 * | the selected period (**O24**) | `durationDistance@1`, `eventTotals@1`, `summaryExtrema@1`, `bucketProfiles@1`, `fatigue@1`, `economics@1`, `scoreTipTotals@1`, `dailySeries@1`, `dashboard.activityStats@1`, `ubi.terms@1` |
 * | the immediately preceding period (**O62**) | `durationDistance@1`, `eventTotals@1` — absent by design when the period is `all` |
 * | six complete calendar months (**O23**) | `monthlyEventTrend@1` |
 * | a rolling 12 months (the UBI mileage window) | `durationDistance@1` |
 * | 4 and 12 calendar weeks (**O52**) | bounded **Q1** date-range scans |
 * | lifetime (**O52** personal best, and the report period bounds) | `progression.records@1`, plus one newest-first and one oldest-first Q1 row |
 *
 * **O58 and O59 stay empty**, exactly as they render today: the `*_compliance`
 * objects and `route_points` are not in the projection, and the commute
 * grouping is unbounded in distinct routes, so no fixed-size reducer can
 * reproduce a populated version. P7 neither populates them nor issues N x Q2
 * to try.
 */

const DAY_MS = 86400000;
const MONTH_MS = 30 * DAY_MS;

/** O52's two calendar windows. */
export const REPORT_BASELINE_WEEKS = 4;
export const REPORT_PERCENTILE_WEEKS = 12;

/** The rolling window `ubiReport.js` scores mileage over. */
export const REPORT_MILEAGE_WINDOW_DAYS = 365;

/** One bounded turn per reducer invocation, at the public page maximum. */
export const REPORT_REDUCER_LIMIT = 200;

/** One bounded page per O52 window scan. */
export const REPORT_BASELINE_PAGE_ROWS = 200;

/**
 * **O57** — the daily chart's day window.
 *
 * `p7.report.dailySeries@1` holds one bucket per **declared** day and is capped
 * at 31, so a single invocation cannot cover a 90-day selection. The answer is
 * not to shorten the chart: O57 freezes the window as the selected period, and
 * a 31-day chart under a "90 days" heading is the untruth this phase removes.
 *
 * The window is instead split into a **fixed number of non-overlapping
 * segments of at most 31 local days**, each its own bounded invocation with its
 * own fixed-size accumulator, and the segments are merged in order into one
 * series. 90 days is three segments; 30 and 7 are one. Nothing grows with the
 * retained history, and no accumulator exceeds its declared bucket count.
 */
export const REPORT_DAILY_CAP = 31;

/** The number of local days each selectable period charts. */
export const reportDailyDayCount = (period, periodDays) => (
  period === 'all' ? 30 : Math.max(1, Number(periodDays) || 7)
);

/** The `YYYY-MM-DD` key of a date's **local** calendar day. */
const localDayKeyOf = (date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

/** Local midnight that starts the calendar day `date` falls in. */
const startOfLocalDay = (date) => {
  const start = new Date(date.getTime());
  start.setHours(0, 0, 0, 0);
  return start;
};

/**
 * Local midnight `offset` calendar days from the day `from` falls in.
 *
 * P7-IMPL-F03. Stepping by a fixed 86,400,000 ms is only the same thing where
 * every day is 24 hours long. On the spring-forward day a local day is 23 hours
 * and the fixed step lands **inside the previous day**, duplicating it and
 * dropping the transition day entirely; on fall-back it is 25 hours and the
 * step lands inside the same day. `setDate` steps the calendar itself and is
 * correct across both, because it re-resolves local midnight for the day it
 * lands on rather than assuming the offset never moved.
 */
const addLocalDays = (from, offset) => {
  const at = startOfLocalDay(from);
  at.setDate(at.getDate() + offset);
  // `setDate` keeps the wall-clock time it started from, which is midnight —
  // but on a DST day that wall-clock midnight may not exist, so normalize again.
  at.setHours(0, 0, 0, 0);
  return at;
};

/** `count` consecutive local calendar days ending on the day `endMs` falls in. */
const localDayKeys = (count, endMs) => {
  const days = [];
  const end = new Date(endMs);
  for (let index = count - 1; index >= 0; index -= 1) {
    days.push(localDayKeyOf(addLocalDays(end, -index)));
  }
  return days;
};

const localMonthKeys = (count, endMs) => {
  const months = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(endMs);
    date.setDate(1);
    date.setMonth(date.getMonth() - index);
    months.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`);
  }
  return months;
};

/** Every local day the chart covers, oldest first, with no gap or duplicate. */
export const reportDailyDays = (period, periodDays, nowMs = Date.now()) => (
  localDayKeys(reportDailyDayCount(period, periodDays), nowMs)
);

/**
 * The declared day window split into segments of at most `REPORT_DAILY_CAP`.
 *
 * Segments are contiguous and non-overlapping, and their concatenation is
 * exactly `reportDailyDays`. Each carries the half-open millisecond range its
 * own reducer turn is bound to.
 */
export const reportDailySegments = (period, periodDays, nowMs = Date.now()) => {
  const days = reportDailyDays(period, periodDays, nowMs);
  const end = new Date(nowMs);
  const segments = [];
  for (let start = 0; start < days.length; start += REPORT_DAILY_CAP) {
    const slice = days.slice(start, start + REPORT_DAILY_CAP);
    // Day `i` of `days` is the local calendar day `days.length - 1 - i` days
    // before the day `nowMs` falls in. A segment spans from **local midnight**
    // that starts its first day to local midnight that starts the day after its
    // last — the next local midnight, not "+24h" — so no row can fall between
    // two segments and none is covered by both, across a DST transition too.
    const firstIndex = start;
    const lastIndex = start + slice.length - 1;
    const fromDate = addLocalDays(end, -(days.length - 1 - firstIndex));
    const toDate = addLocalDays(end, -(days.length - 1 - lastIndex) + 1);
    segments.push({
      days: slice,
      range: { fromMs: fromDate.getTime(), toMs: toDate.getTime() },
    });
  }
  return segments;
};

const CURRENT_REDUCERS = Object.freeze([
  { slot: 'durationDistance', identity: 'p7.report.durationDistance@1' },
  { slot: 'eventTotals', identity: 'p7.report.eventTotals@1' },
  { slot: 'summaryExtrema', identity: 'p7.report.summaryExtrema@1' },
  { slot: 'bucketProfiles', identity: 'p7.report.bucketProfiles@1' },
  { slot: 'fatigue', identity: 'p7.report.fatigue@1' },
  { slot: 'economics', identity: 'p7.report.economics@1' },
  { slot: 'scoreTipTotals', identity: 'p7.report.scoreTipTotals@1' },
  { slot: 'activityStats', identity: 'p7.dashboard.activityStats@1' },
  { slot: 'ubiTerms', identity: 'p7.ubi.terms@1' },
  // O47's two extra branches, over the tip population.
  { slot: 'scoreTipNight', identity: 'p7.report.nightExposure@1', narrowTo: 'P-SCORETIP' },
  { slot: 'scoreTipWeighted', identity: 'p7.report.durationDistance@1', narrowTo: 'P-SCORETIP' },
]);

const PREVIOUS_REDUCERS = Object.freeze([
  { slot: 'durationDistance', identity: 'p7.report.durationDistance@1' },
  { slot: 'eventTotals', identity: 'p7.report.eventTotals@1' },
]);

/** The O24 window: a complete date window, or lifetime for `all`. */
export const reportWindow = (period, periodDays, nowMs = Date.now()) => {
  if (period === 'all') return null;
  return { fromMs: nowMs - periodDays * DAY_MS, toMs: nowMs };
};

/** **O62** — the immediately preceding window of equal length, or none. */
export const reportPreviousWindow = (period, periodDays, nowMs = Date.now()) => {
  if (period === 'all') return null;
  const cutoff = nowMs - periodDays * DAY_MS;
  return { fromMs: cutoff - periodDays * DAY_MS, toMs: cutoff };
};

/** **O52** — a whole number of calendar weeks back from the current week's start. */
export const reportCalendarWeeks = (weeks, now = new Date()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const from = new Date(start);
  from.setDate(from.getDate() - weeks * 7);
  return { fromMs: from.getTime(), toMs: now.getTime() };
};

const settledTerms = (result) => {
  if (!result || result.unavailable) return null;
  return (result.completeness === 'EXACT' ? result.data : result.data?.partial) ?? null;
};

const isExact = (result) => result?.completeness === 'EXACT' && !result?.unavailable;

const reducerQuery = (identity, {
  range, limit = REPORT_REDUCER_LIMIT, context, settings, keyScope, narrowTo = null,
}) => ({
  // The narrowing is part of the key: a narrowed answer and an unnarrowed one
  // are different answers from the same reducer.
  queryKey: p7QueryKeys.reduce(identity.split('@')[0], 1, narrowTo ? `${keyScope}:${narrowTo}` : keyScope),
  queryFn: () => p7TripQueries.reducer({
    reducer: identity, status: 'completed', range, limit, context, settings, narrowTo,
  }),
  staleTime: 2 * 60 * 1000,
});

const combineReducers = (entries) => (results) => {
  const bySlot = {};
  // P7-IMPL-F01/F03. Whether a *particular* reducer reached terminal EOF is a
  // different fact from whether the whole page did, and two surfaces need the
  // narrower one: O47 may only rank coaching tips over a terminal tally, and
  // O57 may only call the chart complete once every segment is terminal.
  const exactBySlot = {};
  let everyExact = results.length > 0;
  let unavailable = null;
  results.forEach((result, index) => {
    const data = result.data;
    bySlot[entries[index].slot] = settledTerms(data);
    exactBySlot[entries[index].slot] = isExact(data);
    if (!isExact(data)) everyExact = false;
    if (data?.unavailable && !unavailable) unavailable = data.unavailable;
  });
  return {
    terms: bySlot,
    exactBySlot,
    exact: everyExact,
    unavailable,
    isFetching: results.some((result) => result.isFetching),
    isPending: results.some((result) => result.isPending),
    continuations: results.map((result) => result.data?.continuation ?? null),
  };
};

const readPage = async (request) => {
  const page = await p7TripQueries.historyPage(request);
  if (page.unavailable) return { rows: [], exact: false, unavailable: page.unavailable };
  return {
    rows: (page.data ?? []).map(buildTripSummary),
    // Q1's `completeness` describes the **page**: a full page is `EXACT` and
    // still carries a continuation. A claim about the *population* — "this is
    // all of them", "there is no more to read" — is true only when the
    // continuation is null. Reading `EXACT` as "complete" would label a
    // window as the whole history, which is the exact untruth P7 removes.
    exact: page.continuation == null,
    unavailable: null,
  };
};

/**
 * @param {{period: string, periodDays: number, settings?: object,
 *          economicsContext?: object}} options
 *   `economicsContext` carries the per-trip `estimate` and `co2Saved` callbacks
 *   the economics reducer folds with, so O25 and O53 reproduce the page's own
 *   vehicle-aware arithmetic rather than a different one.
 */
export function useReportData({ period, periodDays, settings = {}, economicsContext = null } = {}) {
  const [nowMs] = useState(() => Date.now());

  const window = useMemo(() => reportWindow(period, periodDays, nowMs), [period, periodDays, nowMs]);
  const previousWindow = useMemo(
    () => reportPreviousWindow(period, periodDays, nowMs),
    [period, periodDays, nowMs]
  );
  const scope = period === 'all' ? 'all' : `${periodDays}d:${nowMs}`;

  /**
   * The settings the frozen population predicates read.
   *
   * `P-SCORETIP` and `P-PEAKSTRESS` are defined in terms of a minimum distance
   * and confidence. Without these the predicates default to `0` and the tip
   * population silently becomes every driver row — a wider set than the oracle
   * ever used.
   */
  const reducerSettings = useMemo(() => ({
    ...settings,
    scoreTipMinTripKm: SCORE_TIP_MIN_TRIP_KM,
    scoreTipMinConfidence: SCORE_TIP_MIN_CONFIDENCE,
    peakStressMinTripKm: PEAK_STRESS_MIN_TRIP_KM,
  }), [settings]);

  const dailySegments = useMemo(
    () => reportDailySegments(period, periodDays, nowMs),
    [period, periodDays, nowMs]
  );
  const dailyDays = useMemo(
    () => dailySegments.flatMap((segment) => segment.days),
    [dailySegments]
  );

  /**
   * Each reducer's declared context. The three that need one declare it before
   * a row is read, which is what keeps their accumulators fixed in size: the
   * day and month buckets exist up front, and the fatigue threshold is bound
   * into the continuation rather than re-read per turn.
   */
  const contextFor = useCallback((identity) => {
    if (identity === 'p7.report.economics@1') return economicsContext ?? undefined;
    // Each daily segment declares its own bucket list, so the context is
    // chosen per segment rather than per identity.
    if (identity === 'p7.report.dailySeries@1') return { days: dailyDays };
    if (identity === 'p7.report.fatigue@1') {
      const configured = Number(settings.threshold_long_drive_minutes);
      return {
        threshold_long_drive_minutes: Number.isFinite(configured) && configured >= 0 ? configured : 120,
      };
    }
    return undefined;
  }, [dailyDays, economicsContext, settings.threshold_long_drive_minutes]);

  // O57's segments are part of the current-window query set, so the whole
  // chart settles with the rest of the report rather than in a second pass.
  const currentEntries = useMemo(() => [
    ...CURRENT_REDUCERS,
    ...dailySegments.map((segment, index) => ({
      slot: `dailySeries:${index}`,
      identity: 'p7.report.dailySeries@1',
      segment,
    })),
  ], [dailySegments]);

  const current = useQueries({
    queries: currentEntries.map(({ slot, identity, narrowTo = null, segment = null }) => reducerQuery(identity, {
      range: segment ? segment.range : window,
      keyScope: segment ? `report-daily:${segment.days[0]}:${segment.days.length}` : `report:${slot}:${scope}`,
      context: segment ? { days: segment.days } : contextFor(identity),
      settings: reducerSettings,
      narrowTo,
    })),
    combine: combineReducers(currentEntries),
  });

  const previous = useQueries({
    queries: previousWindow
      ? PREVIOUS_REDUCERS.map(({ slot, identity }) => reducerQuery(identity, {
        range: previousWindow,
        keyScope: `report-prev:${slot}:${scope}`,
        settings: reducerSettings,
      }))
      : [],
    combine: combineReducers(PREVIOUS_REDUCERS),
  });

  // O23 — six complete calendar months, computed over the whole report
  // population rather than the selected period.
  const trendMonths = useMemo(() => localMonthKeys(6, nowMs), [nowMs]);
  const monthlyTrend = useQuery(reducerQuery('p7.report.monthlyEventTrend@1', {
    range: { fromMs: nowMs - 6 * MONTH_MS, toMs: nowMs },
    keyScope: `report-months:${trendMonths[0]}`,
    context: { months: trendMonths },
    settings,
  }));

  // The rolling 12-month mileage window `ubiReport.js` scores against, which is
  // a different window from the report period and so a separate invocation.
  const mileageWindow = useQuery(reducerQuery('p7.report.durationDistance@1', {
    range: { fromMs: nowMs - REPORT_MILEAGE_WINDOW_DAYS * DAY_MS, toMs: nowMs },
    keyScope: 'report-mileage:365d',
    settings,
  }));

  // O52 — the two calendar windows the personal baseline is computed over.
  const baselineRange = useMemo(() => reportCalendarWeeks(REPORT_BASELINE_WEEKS), []);
  const percentileRange = useMemo(() => reportCalendarWeeks(REPORT_PERCENTILE_WEEKS), []);

  const baselineScan = useQuery({
    queryKey: p7QueryKeys.history(`report-baseline:${percentileRange.fromMs}`, 'first'),
    queryFn: () => readPage({
      sort: '-start_time', status: 'completed',
      limit: REPORT_BASELINE_PAGE_ROWS, range: percentileRange,
    }),
    staleTime: 2 * 60 * 1000,
  });

  const records = useQuery(reducerQuery('p7.progression.records@1', {
    range: null, keyScope: 'report-records:lifetime', settings,
  }));

  // The observed bounds of the report period, for the exported UBI header. Two
  // bounded edge rows answer this exactly; folding the window would not.
  const newestRow = useQuery({
    queryKey: p7QueryKeys.history(`report-newest:${scope}`, 'first'),
    queryFn: () => readPage({ sort: '-start_time', status: 'completed', limit: 1, range: window }),
    staleTime: 2 * 60 * 1000,
  });
  const oldestRow = useQuery({
    queryKey: p7QueryKeys.history(`report-oldest:${scope}`, 'first'),
    queryFn: () => readPage({ sort: 'start_time', status: 'completed', limit: 1, range: window }),
    staleTime: 2 * 60 * 1000,
  });

  const [extended, setExtended] = useState(null);
  const [finishing, setFinishing] = useState(false);

  /**
   * Drive every unfinished reducer in the current window to terminal EOF.
   *
   * Explicit and user-triggered. Nothing on a render, effect, focus or resume
   * path calls it, which is why the Report registers no durable operation.
   */
  const finishReport = useCallback(async () => {
    if (finishing || current.exact) return;
    setFinishing(true);
    try {
      const finished = {};
      for (let index = 0; index < currentEntries.length; index += 1) {
        const { slot, identity, narrowTo = null, segment = null } = currentEntries[index];
        let result = { continuation: current.continuations[index], completeness: 'PARTIAL' };
        if (result.continuation == null) continue;
        for (let turn = 0; turn < 500 && result?.continuation; turn += 1) {
          result = await p7TripQueries.reducer({
            reducer: identity,
            status: 'completed',
            range: segment ? segment.range : window,
            limit: REPORT_REDUCER_LIMIT,
            continuation: result.continuation,
            context: segment ? { days: segment.days } : contextFor(identity),
            settings: reducerSettings,
            narrowTo,
          });
          if (result?.unavailable || result?.completeness === 'EXACT') break;
        }
        finished[slot] = result;
      }
      setExtended(finished);
    } finally {
      setFinishing(false);
    }
  }, [current.exact, current.continuations, contextFor, currentEntries, finishing, reducerSettings, window]);

  const terms = useMemo(() => {
    if (!extended) return current.terms;
    const merged = { ...current.terms };
    for (const [slot, result] of Object.entries(extended)) {
      const settled = settledTerms(result);
      if (settled) merged[slot] = settled;
    }
    return merged;
  }, [current.terms, extended]);

  /**
   * Terminal EOF per slot, after the explicit finish pass.
   *
   * A slot the finish pass drove to `EXACT` becomes terminal; one it could not
   * finish stays non-terminal. Nothing here infers terminality from the *shape*
   * of an answer — a preinitialized bucket list is the same length whether one
   * page or every page has been folded into it.
   */
  const termsExact = useMemo(() => {
    if (!extended) return current.exactBySlot;
    const merged = { ...current.exactBySlot };
    for (const [slot, result] of Object.entries(extended)) merged[slot] = isExact(result);
    return merged;
  }, [current.exactBySlot, extended]);

  /**
   * The segments merged into one ordered series.
   *
   * Concatenating in segment order reproduces `reportDailyDays` exactly, so
   * the chart has no gap, no duplicate day and no re-sorting step. A segment
   * that has not answered yet contributes nothing, and `dailyComplete` is
   * false until they all have.
   */
  const dailySeriesRows = useMemo(() => {
    const rows = [];
    for (let index = 0; index < dailySegments.length; index += 1) {
      const segment = terms[`dailySeries:${index}`];
      if (!Array.isArray(segment)) return rows;
      rows.push(...segment);
    }
    return rows;
  }, [dailySegments, terms]);

  /**
   * P7-IMPL-F03 — completeness is the **segments' terminal state**, not the
   * merged array's length.
   *
   * `dailySeries@1` preinitializes one bucket per declared day, so its very
   * first `PARTIAL` answer already carries every key the chart wants. Length
   * therefore proves nothing: a 90-day chart whose first segment has folded one
   * page of 200 drives looks exactly like a finished one. Only `EXACT` on every
   * segment means the window was actually read.
   */
  const dailyComplete = useMemo(() => (
    dailySeriesRows.length === dailyDays.length
    && dailySegments.every((_segment, index) => termsExact[`dailySeries:${index}`] === true)
  ), [dailyDays.length, dailySegments, dailySeriesRows.length, termsExact]);

  /**
   * How many of the declared days have actually been read to EOF.
   *
   * This is what the "N of M days so far" label must count. The merged row
   * count cannot serve: it reaches M on the first partial answer.
   */
  const dailyDaysSettled = useMemo(() => dailySegments.reduce(
    (total, segment, index) => (termsExact[`dailySeries:${index}`] === true ? total + segment.days.length : total),
    0,
  ), [dailySegments, termsExact]);

  const exact = current.exact || (extended != null
    && Object.values(extended).every((result) => isExact(result)));

  return {
    /** The O24 window and its terms, keyed by reducer identity. */
    window,
    previousWindow,
    terms,
    exact,
    /** Terminal EOF per reducer slot — never inferred from an answer's shape. */
    termsExact,
    /**
     * **O47** may only rank coaching tips once all three of its reducers are
     * terminal. Ranking a first-page tally would name a dominant risk event,
     * a night share and a weighted mean over whatever happened to be newest.
     */
    tipsExact: Boolean(
      termsExact.scoreTipTotals && termsExact.scoreTipNight && termsExact.scoreTipWeighted
    ),
    unavailable: current.unavailable,

    /** O62 — absent by design when the period is `all`. */
    previousTerms: previous.terms,
    previousExact: previousWindow ? previous.exact : false,
    hasPrevious: Boolean(previousWindow),

    /** O57 — the complete declared day window, and the merged ordered series. */
    dailyDays,
    dailySeries: dailySeriesRows,
    dailySegmentCount: dailySegments.length,
    dailyDaysSettled,
    // The chart may only be presented as the selected window once **every**
    // segment has reached terminal EOF. Until then the page says what it has.
    dailyComplete,

    /** O23 and the UBI mileage window. */
    monthlyTrend: settledTerms(monthlyTrend.data),
    monthlyTrendExact: isExact(monthlyTrend.data),
    mileageWindowKm: (Number(settledTerms(mileageWindow.data)?.distance_m) || 0) / 1000,
    mileageWindowExact: isExact(mileageWindow.data),

    /** O52 — the baseline rows and the lifetime personal best. */
    baselineTrips: baselineScan.data?.rows ?? [],
    baselineExact: Boolean(baselineScan.data?.exact),
    baselineRange,
    percentileRange,
    records: settledTerms(records.data),
    recordsExact: isExact(records.data),

    /** The observed bounds of the period, for the exported header. */
    periodStart: oldestRow.data?.rows?.[0]?.start_time ?? null,
    periodEnd: newestRow.data?.rows?.[0]?.end_time ?? newestRow.data?.rows?.[0]?.start_time ?? null,

    finishReport,
    finishingReport: finishing,

    isLoading: current.isPending,
    isFetching: current.isFetching || previous.isFetching || monthlyTrend.isFetching
      || baselineScan.isFetching || records.isFetching,
  };
}
