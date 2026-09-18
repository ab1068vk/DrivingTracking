import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * The Diagnostics page's **one** canonical top-level composition (P7 Stage 3,
 * consumer ledger entry #3).
 *
 * What it replaces: two *identical* `listSummaries({limit:20})` queries under
 * different keys (`['diagnostics-trips']` and
 * `['diagnostics-trip-data-profile']`), so neither shared the other's cache and
 * every open paid for the same page twice.
 *
 * The declared internal graph is **Q1** for the page's rows, plus **Q2** for the
 * one selected trip — and Q2 keeps its own canonical detail key family, as
 * Annex A §A4.2 prescribes, so it is a declared secondary read rather than a
 * second history acquisition.
 *
 * Rows go through `buildTripSummary` exactly as `listSummaries` does, so the
 * page's data shape is unchanged: this migration removes a duplicate fetch, not
 * a semantic.
 */

/** The page's row window. A user-visible window size would be product semantics; this one is not. */
export const DIAGNOSTICS_PAGE_ROWS = 20;

/** DEV-only: the window the synthetic-test-trip cleanup scans. */
export const DIAGNOSTICS_TEST_TRIP_ROWS = 200;

/**
 * @param {{localTestTripPrefix?: string, includeLocalTestTrips?: boolean}} [options]
 */
export function useDiagnosticsPageData(options = {}) {
  const { localTestTripPrefix = '', includeLocalTestTrips = false } = options;

  const query = useQuery({
    queryKey: p7QueryKeys.page('diagnostics', includeLocalTestTrips ? 'dev' : 'prod'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage({
        sort: '-start_time',
        limit: DIAGNOSTICS_PAGE_ROWS,
      });
      if (page.unavailable) {
        // A typed unavailable is a state the page renders, never an empty list
        // presented as "no trips".
        return { rows: [], localTestTrips: [], unavailable: page.unavailable, completeness: null };
      }
      const rows = (page.data ?? []).map(buildTripSummary);

      // The synthetic-test-trip sweep is a development affordance. It is not
      // part of the production composition and never runs in a shipped build,
      // which is why it is gated here rather than by a caller's discretion.
      let localTestTrips = [];
      if (includeLocalTestTrips && localTestTripPrefix) {
        const devPage = await p7TripQueries.historyPage({
          sort: '-start_time',
          limit: DIAGNOSTICS_TEST_TRIP_ROWS,
        });
        localTestTrips = (devPage.data ?? [])
          .map(buildTripSummary)
          .filter((trip) => String(trip.id || '').startsWith(localTestTripPrefix));
      }

      return {
        rows,
        localTestTrips,
        unavailable: null,
        completeness: page.completeness,
      };
    },
    staleTime: 2 * 60 * 1000,
  });

  // The hook guarantees its own return contract whatever the cache holds. A
  // payload that is not a composition result means the composition did not
  // produce one, and the page must render its empty/typed state rather than
  // crash on a shape it never wrote.
  const settled = query.data;
  const data = (settled && Array.isArray(settled.rows))
    ? settled
    : { rows: [], localTestTrips: [], unavailable: null, completeness: null };

  return {
    trips: data.rows,
    localTestTrips: data.localTestTrips ?? [],
    unavailable: data.unavailable,
    completeness: data.completeness,
    // `isSuccess` alone would report success for a typed unavailable result, so
    // readiness means "the composition settled **and** produced rows".
    ready: query.isSuccess && !data.unavailable,
    isPending: query.isPending,
    refetch: query.refetch,
  };
}
