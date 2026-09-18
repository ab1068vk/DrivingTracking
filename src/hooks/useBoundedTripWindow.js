import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * One bounded Q1 window, for the consumers whose whole contract is "the latest
 * N, labelled" (P7 Stage 8; ledger entries #12, #13, #17, #26).
 *
 * What it replaces: `tripService.list({ sort, limit })`. That call reads
 * **every trip in the store** — `getAllTrips()` — decrypts each one in full,
 * sorts the whole array in memory and then slices `limit` rows off the front.
 * The `limit` argument described the *output*, never the work: a driver with
 * 5 000 trips paid 5 000 full-record decrypts so a page could show 100 rows.
 * Four pages did this on mount.
 *
 * Q1 reads exactly the page, through the cursor, from the projection.
 *
 * The rows are `buildTripSummary` projections. Every consumer of this helper
 * has a ledger entry declaring it needs no full payload to render its list —
 * per-trip fidelity resolves on the selected Q2 reads, which stay capped by UX.
 */

/**
 * @param {{queryId: string, limit: number, status?: string|null,
 *          sort?: string, staleTime?: number, enabled?: boolean}} options
 */
export function useBoundedTripWindow({
  queryId,
  limit,
  status = null,
  sort = '-start_time',
  staleTime = 2 * 60 * 1000,
  enabled = true,
}) {
  const query = useQuery({
    queryKey: p7QueryKeys.history(`${queryId}:${limit}`, 'first'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage({ sort, status, limit });
      if (page.unavailable) {
        return { rows: [], exact: false, continuation: null, unavailable: page.unavailable };
      }
      return {
        rows: (page.data ?? []).map(buildTripSummary),
        // Q1's `completeness` describes the **page**: a full page is `EXACT` and
        // still carries a continuation. A claim about the *population* — "this is
        // all of them", "there is no more to read" — is true only when the
        // continuation is null. Reading `EXACT` as "complete" would label a
        // window as the whole history, which is the exact untruth P7 removes.
        exact: page.continuation == null,
        continuation: page.continuation ?? null,
        unavailable: null,
      };
    },
    staleTime,
    enabled,
  });

  const settled = query.data;
  return {
    /** The bounded window, newest first. It is `latest N`, and is labelled so. */
    trips: settled?.rows ?? [],
    /** True only when the window is the whole population, not just the page. */
    exact: Boolean(settled?.exact),
    continuation: settled?.continuation ?? null,
    unavailable: settled?.unavailable ?? null,
    isLoading: query.isPending,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

/** The label a bounded window may carry. It never claims to be everything. */
export const boundedWindowLabel = (count, exact) => (
  exact ? `${count} trip${count === 1 ? '' : 's'}` : `latest ${count} trips`
);
