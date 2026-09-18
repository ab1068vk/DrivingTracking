import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * The Insights page's canonical composition (P7 Stage 6.5, ledger entry #5).
 *
 * What it replaces: a `(50)` page plus an ungated `(200)` page, from which
 * every date-windowed surface on the page was sliced. That is the failure this
 * stage exists to remove — the 200-row read is a **trip-count** window, and the
 * page presents its results as **date** windows. Past 200 retained trips a
 * "last 90 days" panel silently described the newest 200 drives instead, with
 * nothing on screen saying so.
 *
 * The declared graph:
 *
 * | Surface | Source |
 * |---|---|
 * | the analysis window (current + prior period, and the 12-week personal baseline) | **Q1**, one bounded date-range page per turn |
 * | the calendar grid the user is looking at | **Q1**, one bounded date-range page over that grid |
 * | which month the calendar opens on | **Q1**, the newest completed row |
 * | per-trip evidence | **Q2**, capped at 12 — never N x Q2 |
 *
 * **Every windowed Insights output is `P-DRIVER`** (`advancedInsights.js:181`,
 * `advancedInsightIntelligence.js:295,348`), so under Annex C §C1a.0 none of
 * them may be sourced from Q4 or Q5. The calendar is `P-COMPLETED` but keys
 * **local** days (`mediumInsights.js:196`), which a UTC bucket cannot express
 * (§C3.3). Both are therefore bounded Q1 range scans, not aggregate reads.
 *
 * Truthfulness: a window wider than one bounded page returns `PARTIAL` with a
 * continuation, and the page says so. It is never silently shortened, and the
 * continuation is driven only by an explicit user action.
 */

const DAY_MS = 86400000;

/**
 * The 12-week personal-baseline window (Annex C **O52**).
 *
 * The analysis scan is never narrower than this, because the baseline is a
 * calendar window rather than a slice of the selected period.
 */
export const INSIGHTS_BASELINE_DAYS = 84;

/** One bounded turn, at the public page maximum. */
export const INSIGHTS_WINDOW_PAGE_ROWS = 200;

/** The frozen per-trip evidence cap. There is no N x Q2 on this page. */
export const INSIGHTS_DETAIL_FANOUT = 12;

/** The calendar renders a six-week grid, so its scan covers exactly that. */
export const INSIGHTS_CALENDAR_GRID_DAYS = 42;

/**
 * The complete date window the analysis needs: the selected period, the prior
 * period it is compared against, and never less than the baseline window.
 *
 * A running experiment that started before all of those extends the range, so
 * its progress is measured over the drives it actually covers.
 */
export const insightsAnalysisRange = (periodDays, nowMs = Date.now(), experimentStartedAt = null) => {
  const days = Math.max(7, Number(periodDays) || 30);
  const span = Math.max(2 * days, INSIGHTS_BASELINE_DAYS);
  let fromMs = nowMs - span * DAY_MS;
  const experimentMs = experimentStartedAt ? Date.parse(String(experimentStartedAt)) : NaN;
  if (Number.isFinite(experimentMs) && experimentMs < fromMs) fromMs = experimentMs;
  return { fromMs, toMs: nowMs };
};

/** The month a calendar offset selects, as a local first-of-month date. */
export const insightsMonthDate = (monthOffset = 0, now = new Date()) => {
  const date = new Date(now);
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + Number(monthOffset || 0));
  return date;
};

/**
 * The six-week **local** grid `buildTripCalendarMonth` lays out for a month:
 * back to the Sunday on or before the 1st, then 42 local days.
 */
export const insightsCalendarRange = (monthDate) => {
  const start = new Date(monthDate);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(start);
  end.setDate(end.getDate() + INSIGHTS_CALENDAR_GRID_DAYS);
  return { fromMs: start.getTime(), toMs: end.getTime() };
};

/**
 * Which month the calendar should open on: this one when it has a drive, and
 * otherwise the month of the newest completed drive.
 *
 * The page used to answer this by scanning whichever rows were loaded, so a
 * driver whose last drive fell outside the loaded window was shown an empty
 * calendar. One newest-first row answers it exactly.
 */
export const insightsMonthOffset = (latestStartTime, now = new Date()) => {
  const latest = latestStartTime ? new Date(latestStartTime) : null;
  if (!latest || !Number.isFinite(latest.getTime())) return 0;
  return (latest.getFullYear() - now.getFullYear()) * 12 + latest.getMonth() - now.getMonth();
};

const emptyPage = Object.freeze({ rows: [], completeness: null, continuation: null, unavailable: null });

const readPage = async (request) => {
  const page = await p7TripQueries.historyPage(request);
  if (page.unavailable) {
    return { rows: [], completeness: null, continuation: null, unavailable: page.unavailable };
  }
  return {
    rows: (page.data ?? []).map(buildTripSummary),
    completeness: page.completeness,
    continuation: page.continuation,
    unavailable: null,
  };
};

const settled = (query, extended) => extended ?? (query.data && Array.isArray(query.data.rows) ? query.data : emptyPage);

/**
 * @param {{periodDays?: number, monthOffset?: number|null, experimentStartedAt?: string|null}} [options]
 */
export function useInsightsData(options = {}) {
  const { periodDays = 30, monthOffset = null, experimentStartedAt = null } = options;

  // One range per mount: a range recomputed on every render would re-key the
  // query on each tick and turn a bounded read into a loop.
  const [nowMs] = useState(() => Date.now());

  const analysisRange = useMemo(
    () => insightsAnalysisRange(periodDays, nowMs, experimentStartedAt),
    [periodDays, nowMs, experimentStartedAt]
  );

  const analysisRequest = useMemo(() => ({
    sort: '-start_time',
    status: 'completed',
    limit: INSIGHTS_WINDOW_PAGE_ROWS,
    range: analysisRange,
  }), [analysisRange]);

  const windowQuery = useQuery({
    queryKey: p7QueryKeys.history(`insights:${analysisRange.fromMs}:${analysisRange.toMs}`, 'first'),
    queryFn: () => readPage(analysisRequest),
    staleTime: 2 * 60 * 1000,
  });

  const latestQuery = useQuery({
    queryKey: p7QueryKeys.history('insights-latest:1', 'first'),
    queryFn: () => readPage({ sort: '-start_time', status: 'completed', limit: 1 }),
    staleTime: 2 * 60 * 1000,
  });

  const latestRow = settled(latestQuery, null).rows[0] ?? null;
  const defaultMonthOffset = useMemo(
    () => insightsMonthOffset(latestRow?.start_time ?? null),
    [latestRow?.start_time]
  );
  const effectiveMonthOffset = monthOffset == null ? defaultMonthOffset : monthOffset;

  const monthDate = useMemo(() => insightsMonthDate(effectiveMonthOffset), [effectiveMonthOffset]);
  const calendarRange = useMemo(() => insightsCalendarRange(monthDate), [monthDate]);

  const calendarQuery = useQuery({
    queryKey: p7QueryKeys.history(`insights-calendar:${calendarRange.fromMs}`, 'first'),
    queryFn: () => readPage({
      sort: '-start_time',
      status: 'completed',
      limit: INSIGHTS_WINDOW_PAGE_ROWS,
      range: calendarRange,
    }),
    staleTime: 2 * 60 * 1000,
  });

  const [extendedWindow, setExtendedWindow] = useState(null);
  const [extending, setExtending] = useState(false);

  const windowPage = settled(windowQuery, extendedWindow);
  // Q1's `completeness` describes the **page**: a full page is `EXACT` and
  // still carries a continuation. A claim about the *population* — "this is
  // all of them", "there is no more to read" — is true only when the
  // continuation is null. Reading `EXACT` as "complete" would label a
  // window as the whole history, which is the exact untruth P7 removes.
  const windowExact = windowPage.continuation == null && !windowPage.unavailable;

  /**
   * Read the rest of the analysis window, one bounded page per turn.
   *
   * Explicit and user-triggered. No render, effect, focus or resume handler
   * calls it, which is why this page still registers no durable operation:
   * more retained history costs more turns, never a wider turn.
   */
  const extendWindow = useCallback(async () => {
    if (windowExact || extending || !windowPage.continuation) return;
    setExtending(true);
    try {
      let rows = windowPage.rows;
      let page = windowPage;
      // Q1's `completeness` describes the page it answered, not the window: a
      // full page is `EXACT` and still carries a continuation. The scan ends
      // when the continuation is null, and only then.
      for (let turn = 0; turn < 500 && page.continuation; turn += 1) {
        const next = await readPage({ ...analysisRequest, cursor: page.continuation });
        if (next.unavailable) { page = { ...page, unavailable: next.unavailable }; break; }
        rows = rows.concat(next.rows);
        page = next;
      }
      setExtendedWindow({ ...page, rows });
    } finally {
      setExtending(false);
    }
  }, [analysisRequest, extending, windowExact, windowPage]);

  const calendarPage = settled(calendarQuery, null);

  return {
    /** The complete analysis date window, newest first. */
    windowTrips: windowPage.rows,
    windowExact,
    windowContinuation: windowPage.continuation,
    windowUnavailable: windowPage.unavailable,
    windowRange: analysisRange,
    extendWindow,
    extendingWindow: extending,

    /** The calendar grid the user is actually looking at. */
    calendarTrips: calendarPage.rows,
    calendarExact: calendarPage.continuation == null && !calendarPage.unavailable,
    calendarUnavailable: calendarPage.unavailable,
    monthOffset: effectiveMonthOffset,
    monthDate,

    /** Whether any completed drive exists at all, from one newest-first row. */
    hasAnyCompleted: Boolean(latestRow),
    latestCompletedAt: latestRow?.start_time ?? null,

    isLoading: windowQuery.isPending || latestQuery.isPending,
    isFetching: windowQuery.isFetching || calendarQuery.isFetching || latestQuery.isFetching,
  };
}
