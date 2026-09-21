import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';
import { summarizeDistanceWeightedScore } from '@/lib/driverScoreSummary';

/**
 * The Dashboard's canonical composition (P7 Stage 6.4, ledger entry #2,
 * Annex C rows **O01-O06**).
 *
 * What it replaces: four routine history acquisitions — a `(50)` page, an
 * idle-gated `(200)` page, and two ad-hoc `listSummaries({limit:50})` lookups
 * on the trip-ending paths. Every lifetime figure on the page was derived from
 * whichever of those windows happened to be loaded, so past 200 retained trips
 * the activity block described a truncation.
 *
 * The declared graph:
 *
 * | Row | Source |
 * |---|---|
 * | **O01/O02** lifetime trips and distance | **Q4** over the completed-only D1 owner |
 * | **O03** driving time, **O06** active days / longest trip | **Q10** `p7.dashboard.activityStats@1` — D1 keys no duration, and `active_local_days` is a **local**-day count a UTC bucket cannot express |
 * | **O04** average score | **one bounded Q1 page**, latest ten `P-DRIVER` scored rows, distance-weighted |
 * | **O05** today | a bounded **Q1 date-range** scan of the complete **local** day |
 *
 * **O04 and O05 may not be served from Q4, D1 or a native aggregate.** Those
 * owners express `P-COMPLETED` and a UTC day, and either substitution would
 * change the number on screen.
 */

/**
 * Rows the windowed `P-DRIVER` computations need.
 *
 * The widest is O04's latest ten *scored, driver-eligible* rows, so the page
 * reads enough that passenger and unscored rows cannot starve it.
 */
export const DASHBOARD_WINDOW_ROWS = 60;

/** The O04 horizon, frozen by Annex C C5.1. */
export const DASHBOARD_SCORE_TRIPS = 10;

const ACTIVITY_REDUCER = 'p7.dashboard.activityStats@1';
const DAY_MS = 86400000;

/** The complete local day, which is what O05 means by "today". */
export const dashboardTodayRange = (now = new Date()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return { fromMs: start.getTime(), toMs: start.getTime() + DAY_MS };
};

const emptyPage = Object.freeze({ rows: [], unavailable: null });

const pageQueryFn = (request) => async () => {
  const page = await p7TripQueries.historyPage(request);
  if (page.unavailable) return { rows: [], unavailable: page.unavailable };
  return { rows: (page.data ?? []).map(buildTripSummary), unavailable: null };
};

const settledRows = (query) => {
  const settled = query.data;
  return (settled && Array.isArray(settled.rows)) ? settled : emptyPage;
};

/**
 * @param {{periodDays?: number|null}} [options] `null` for the lifetime
 *   selection, a day count for the windowed one.
 */
/**
 * DPD-024, second half: the page's Refresh forwarded only the 60-row window's
 * `refetch`, so pressing it could not move the lifetime totals, the today page or
 * the activity reducer -- the three things a user pressing Refresh after a long
 * background catch-up is actually waiting for. Refresh must refresh what the page
 * shows. Resolves with the window result so existing callers are unchanged.
 */
export function composeDashboardRefetch(queries) {
  return Promise.all(queries.map((query) => query.refetch()))
    .then(([windowResult]) => windowResult);
}

export function useDashboardData(options = {}) {
  const { periodDays = null } = options;

  const windowPage = useQuery({
    queryKey: p7QueryKeys.history(`dashboard:${DASHBOARD_WINDOW_ROWS}`, 'first'),
    queryFn: pageQueryFn({ sort: '-start_time', status: 'completed', limit: DASHBOARD_WINDOW_ROWS }),
    staleTime: 60 * 1000,
  });

  const todayRange = useMemo(() => dashboardTodayRange(), []);
  const todayPage = useQuery({
    queryKey: p7QueryKeys.history(`dashboard-today:${todayRange.fromMs}`, 'first'),
    queryFn: pageQueryFn({
      sort: '-start_time', status: 'completed', limit: 200, range: todayRange,
    }),
    staleTime: 60 * 1000,
  });

  const lifetime = useQuery({
    queryKey: p7QueryKeys.aggregate('dashboard-lifetime', 'lifetime'),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global' }),
    staleTime: 60 * 1000,
  });

  const activityRange = useMemo(() => {
    if (!Number.isFinite(periodDays) || periodDays <= 0) return null;
    const now = Date.now();
    return { fromMs: now - periodDays * DAY_MS, toMs: now };
  }, [periodDays]);

  const activity = useQuery({
    queryKey: p7QueryKeys.reduce('p7.dashboard.activityStats', 1, activityRange ? `${periodDays}d` : 'lifetime'),
    queryFn: () => p7TripQueries.reducer({
      reducer: ACTIVITY_REDUCER, status: 'completed', range: activityRange, limit: 200,
    }),
    staleTime: 60 * 1000,
  });

  // DPD-024: the page's own Refresh used to forward only the 60-row window's
  // refetch, so pressing it could not move the lifetime totals, the today page
  // or the activity reducer -- the three things a user pressing Refresh after a
  // long background catch-up is actually waiting for.
  // React Query rebuilds its result object on every render (`getOptimisticResult`
  // returns a fresh literal), so depending on the query objects would make this
  // callback -- and therefore the `refetch` this hook returns -- a new function on
  // every render. Before this change `refetch` was `windowPage.refetch`, a stable
  // bound method, and `Dashboard.jsx` puts it in a `useCallback` whose result feeds
  // a `useEffect` dependency: an unstable identity there re-registers a window
  // listener on every render, including each tick of the 5 s elapsed timer.
  //
  // `refetch` itself is a stable bound method on the query observer, so naming the
  // four of them keeps the identity steady and keeps exhaustive-deps satisfied
  // without a suppression.
  const windowRefetch = windowPage.refetch;
  const todayRefetch = todayPage.refetch;
  const lifetimeRefetch = lifetime.refetch;
  const activityRefetch = activity.refetch;
  const refetchAll = useCallback(
    () => composeDashboardRefetch([
      { refetch: windowRefetch },
      { refetch: todayRefetch },
      { refetch: lifetimeRefetch },
      { refetch: activityRefetch },
    ]),
    [windowRefetch, todayRefetch, lifetimeRefetch, activityRefetch]
  );

  const windowSettled = settledRows(windowPage);
  const completedTrips = windowSettled.rows;

  // The `P-DRIVER` population, read from the approved projection boolean rather
  // than re-derived per consumer.
  const driverTrips = useMemo(
    () => completedTrips.filter(isDriverMetricEligible),
    [completedTrips]
  );

  const activityResult = activity.data;
  const activityExact = activityResult?.completeness === 'EXACT' && !activityResult?.unavailable;
  const activityStats = activityResult?.unavailable
    ? null
    : (activityExact ? activityResult?.data : activityResult?.data?.partial) ?? null;

  const lifetimeTotals = lifetime.data?.unavailable ? null : lifetime.data?.data?.totals ?? null;

  return {
    /** The bounded recent list and the windowed `P-DRIVER` rows over it. */
    completedTrips,
    driverTrips,
    windowUnavailable: windowSettled.unavailable,

    /** O05 — the complete local day. */
    todayTrips: settledRows(todayPage).rows,
    todayUnavailable: settledRows(todayPage).unavailable,

    /** O01/O02 — lifetime trips and distance from the completed-only owner. */
    lifetimeTrips: Number.isFinite(lifetimeTotals?.completedCount) ? lifetimeTotals.completedCount : null,
    lifetimeDistanceKm: Number.isFinite(lifetimeTotals?.totalKm) ? lifetimeTotals.totalKm : null,
    lifetimeUnavailable: lifetime.data?.unavailable ?? null,
    lifetimeReadiness: lifetime.data?.p6Readiness ?? null,

    /** O03/O06 — the terms no aggregate owner keys. */
    activityStats,
    activityExact,
    activityContinuation: activityResult?.continuation ?? null,
    activityUnavailable: activityResult?.unavailable ?? null,

    isLoading: windowPage.isPending,
    isFetching: windowPage.isFetching || lifetime.isFetching || activity.isFetching,
    isSuccess: windowPage.isSuccess,
    isError: windowPage.isError,
    error: windowPage.error,
    refetch: refetchAll,
  };
}

/**
 * **O04** — the Dashboard average score, exactly as Annex C C5.1 freezes it.
 *
 * The latest ten `P-DRIVER` trips that have an overall component score,
 * **distance-weighted**: `round(sum(value x distance_km) / sum(distance_km))`,
 * `null` when no scored trip remains or the total distance is zero.
 *
 * It is a `latest N` window, not a lifetime figure. Serving it from a lifetime
 * aggregate would change the number on screen, so the rows come from one
 * bounded Q1 page and nothing else.
 *
 * @param {Array} driverTrips the `P-DRIVER` rows, newest first
 * @param {(trip: object) => {value: number|null, evidence?: string}} componentScore
 */
export function dashboardAverageScore(driverTrips = [], componentScore) {
  const summary = summarizeDistanceWeightedScore(driverTrips, componentScore, {
    limit: DASHBOARD_SCORE_TRIPS,
  });
  return {
    avgScore: summary.avgScore,
    avgScoreEvidence: summary.avgScoreEvidence,
    scoredTripCount: summary.scoredTripCount,
  };
}
