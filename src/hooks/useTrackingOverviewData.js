import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * The Tracking Overview page's **one** canonical composition (P7 Stage 6,
 * consumer ledger entry #15, Annex C row **O07**).
 *
 * What it replaces: a flat `(200)` acquisition that was sliced to 30 for the
 * visible list, and then folded **twice** — once over the 30 and once over the
 * 200 — so that the week chips could be merged back in. Beyond 200 retained
 * trips the week figures were quietly computed over a truncation.
 *
 * The declared graph is **Q1** for the bounded recent list plus **Q4** for the
 * week totals. Q4 reads the D1 owner's own day buckets, so the week figures are
 * `O(A)` in the requested range rather than proportional to retained history,
 * and they describe the window they actually cover rather than the page that
 * happened to be fetched.
 */

/** Rows the visible recent list shows. This is the page's existing horizon. */
export const OVERVIEW_RECENT_ROWS = 30;

/** Days in the week window. */
const WEEK_DAYS = 7;
const DAY_MS = 86400000;

/**
 * The week window as **complete UTC days**, which is the granularity the D1 day
 * buckets key and therefore the only window Q4 can answer exactly.
 *
 * The page previously used a rolling `now - 7x24h` cutoff. That boundary cannot
 * be expressed by a day bucket, so O07 freezes this output as a complete date
 * window; the chips below are labelled for the window they now describe.
 */
export const trackingOverviewWeekRange = (nowMs = Date.now()) => {
  const endOfToday = Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS;
  return { fromMs: endOfToday - WEEK_DAYS * DAY_MS, toMs: endOfToday };
};

const EMPTY_WEEK = Object.freeze({ trips: 0, distanceKm: 0 });

export function useTrackingOverviewData({ rows = OVERVIEW_RECENT_ROWS } = {}) {
  const range = useMemo(() => trackingOverviewWeekRange(), []);

  const recent = useQuery({
    queryKey: p7QueryKeys.history(`tracking-overview:${rows}`, 'first'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage({
        sort: '-start_time', status: 'completed', limit: rows,
      });
      if (page.unavailable) return { rows: [], unavailable: page.unavailable };
      return { rows: (page.data ?? []).map(buildTripSummary), unavailable: null };
    },
    staleTime: 60 * 1000,
  });

  const week = useQuery({
    queryKey: p7QueryKeys.aggregate('tracking-overview-week', `${range.fromMs}-${range.toMs}`),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global', ...range }),
    staleTime: 60 * 1000,
  });

  const recentSettled = recent.data;
  const recentRows = (recentSettled && Array.isArray(recentSettled.rows)) ? recentSettled.rows : [];

  const weekResult = week.data;
  const weekUnavailable = weekResult?.unavailable ?? null;
  const weekTotals = weekUnavailable
    ? EMPTY_WEEK
    : {
      trips: Number(weekResult?.data?.totals?.completedCount) || 0,
      distanceKm: Number(weekResult?.data?.totals?.totalKm) || 0,
    };

  return {
    recentTrips: recentRows,
    recentUnavailable: recentSettled?.unavailable ?? null,
    /** Week figures over a complete 7-UTC-day window, exact when available. */
    week: weekTotals,
    /**
     * `true` only when the D1 owner actually served the window. While false the
     * page shows the owner's state, never a zero: "no drives this week" and
     * "the ledger has not been built" are different facts.
     */
    weekExact: !weekUnavailable && weekResult?.completeness === 'EXACT',
    weekUnavailable,
    weekReadiness: weekResult?.p6Readiness ?? null,
    isPending: recent.isPending,
    isFetching: recent.isFetching || week.isFetching,
    refetch: recent.refetch,
  };
}
