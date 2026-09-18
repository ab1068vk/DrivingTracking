import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * The Achievements page's canonical composition (P7 Stage 6.3, ledger entry #1,
 * Annex C rows **O28-O33** and **§C5.2**).
 *
 * What it replaces: a `(50)` page plus a `(200)` page, from which the whole of
 * progression — including its lifetime eligibility figures — was rebuilt on
 * every open. Past 200 retained trips those lifetime figures described a
 * truncation.
 *
 * §C5.2 separates the four `progressionStats` windows, and this composition
 * follows that separation exactly:
 *
 * - **only `allStats` is lifetime** → `p7.progression.lifetimeStats@1`, one
 *   bounded turn per invocation, never drained by a render;
 * - mastery-40, recent-20, previous-20 and the calendar windows are **bounded
 *   Q1 reads** — one page wide enough for the largest of them;
 * - XP, level, history and mission/ledger state keep their **existing** owner;
 * - badges, calibration and readiness are **Q9 only**.
 *
 * **No second progression owner is created.** Nothing here recomputes a track,
 * a mission or an XP total; the page's own builder still does that, from the
 * same rows it always used.
 */

/**
 * Rows the trip-count and calendar windows need.
 *
 * The widest trip-count window §C5.2 declares is mastery-40, so 60 covers every
 * one of them with headroom for a calendar week. It is not a user-visible
 * horizon, so it is not product semantics.
 */
export const PROGRESSION_WINDOW_ROWS = 60;

const LIFETIME_REDUCER = 'p7.progression.lifetimeStats@1';

export function useAchievementsData() {
  const rowsQuery = useQuery({
    queryKey: p7QueryKeys.history(`achievements:${PROGRESSION_WINDOW_ROWS}`, 'first'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage({
        sort: '-start_time', status: 'completed', limit: PROGRESSION_WINDOW_ROWS,
      });
      if (page.unavailable) return { rows: [], unavailable: page.unavailable };
      return { rows: (page.data ?? []).map(buildTripSummary), unavailable: null };
    },
    staleTime: 2 * 60 * 1000,
  });

  const completedQuery = useQuery({
    queryKey: p7QueryKeys.aggregate('achievements-completed', 'lifetime'),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global' }),
    staleTime: 2 * 60 * 1000,
  });

  const lifetimeQuery = useQuery({
    queryKey: p7QueryKeys.reduce('p7.progression.lifetimeStats', 1, 'lifetime'),
    queryFn: () => p7TripQueries.reducer({ reducer: LIFETIME_REDUCER, status: 'completed', limit: 200 }),
    staleTime: 5 * 60 * 1000,
  });

  const [continued, setContinued] = useState(null);
  const [finishing, setFinishing] = useState(false);

  const lifetimeResult = continued ?? lifetimeQuery.data;
  const lifetimeExact = lifetimeResult?.completeness === 'EXACT' && !lifetimeResult?.unavailable;
  const lifetimeStats = lifetimeResult?.unavailable
    ? null
    : (lifetimeExact ? lifetimeResult?.data : lifetimeResult?.data?.partial) ?? null;

  /**
   * Drive the lifetime tally to terminal EOF. Explicit and user-triggered: no
   * render, effect, focus or resume handler calls it, which is why the page
   * still registers no durable operation.
   */
  const finishLifetime = useCallback(async () => {
    if (lifetimeExact || finishing || !lifetimeResult?.continuation) return;
    setFinishing(true);
    try {
      let result = lifetimeResult;
      for (let turn = 0; turn < 500 && result?.continuation; turn += 1) {
        result = await p7TripQueries.reducer({
          reducer: LIFETIME_REDUCER, status: 'completed', limit: 200, continuation: result.continuation,
        });
        if (result?.unavailable || result?.completeness === 'EXACT') break;
      }
      setContinued(result ?? null);
    } finally {
      setFinishing(false);
    }
  }, [lifetimeExact, finishing, lifetimeResult]);

  const completedTotals = completedQuery.data?.unavailable ? null : completedQuery.data?.data?.totals;

  const lifetime = useMemo(() => {
    if (!lifetimeStats && !completedTotals) return null;
    return {
      eligibleTrips: Number.isFinite(lifetimeStats?.tripCount) ? lifetimeStats.tripCount : undefined,
      distanceKm: Number.isFinite(lifetimeStats?.distanceKm) ? lifetimeStats.distanceKm : undefined,
      completedTrips: Number.isFinite(completedTotals?.completedCount) ? completedTotals.completedCount : undefined,
      // Only a terminal reducer and a served aggregate make the block exact.
      exact: Boolean(lifetimeExact && completedTotals),
    };
  }, [lifetimeStats, completedTotals, lifetimeExact]);

  const settled = rowsQuery.data;

  return {
    windowTrips: (settled && Array.isArray(settled.rows)) ? settled.rows : [],
    windowUnavailable: settled?.unavailable ?? null,
    lifetime,
    lifetimeExact,
    lifetimeUnavailable: lifetimeResult?.unavailable ?? completedQuery.data?.unavailable ?? null,
    lifetimeReadiness: completedQuery.data?.p6Readiness ?? null,
    finishLifetime,
    finishingLifetime: finishing,
    isLoading: rowsQuery.isPending,
    isFetching: rowsQuery.isFetching || lifetimeQuery.isFetching,
    isSuccess: rowsQuery.isSuccess,
    isError: rowsQuery.isError,
    refetch: rowsQuery.refetch,
  };
}
