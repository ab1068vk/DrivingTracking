import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';

/**
 * Comparison candidates for a detail surface (P7 Stage 5, **Q6**).
 *
 * What it replaces on `TrackingTripDetail.jsx`: a 100-row summary query issued
 * on every open to populate a comparison `<select>`. Ledger entry #19 declares
 * the candidates come from Q6 adjacency under a cap of 2 — the trip before and
 * the trip after — never from a 100-row list.
 *
 * Q6 is two point-anchored reads: one older neighbour, one newer. A proven end
 * of history is `EXACT` with no row, not an unavailable result, so the first or
 * last trip in the archive simply offers fewer candidates.
 */

const EMPTY = Object.freeze([]);

/**
 * @param {string|number|null} tripId the anchor trip
 * @param {{status?: string, enabled?: boolean}} [options]
 */
export function useTripComparisonCandidates(tripId, options = {}) {
  const { status = 'completed', enabled = true } = options;

  const query = useQuery({
    queryKey: p7QueryKeys.page('trip-comparison-candidates', `${tripId ?? 'none'}:${status}`),
    queryFn: async () => {
      const [older, newer] = await Promise.all([
        p7TripQueries.adjacent(tripId, 'previous', { status }),
        p7TripQueries.adjacent(tripId, 'next', { status }),
      ]);
      const unavailable = older.unavailable ?? newer.unavailable ?? null;
      if (unavailable) return { candidates: EMPTY, unavailable };
      // Newest first, matching the order the picker used to receive.
      const candidates = [newer.data, older.data].filter(Boolean);
      return { candidates, unavailable: null };
    },
    enabled: enabled && Boolean(tripId),
    staleTime: 2 * 60 * 1000,
  });

  const settled = query.data;
  const data = (settled && Array.isArray(settled.candidates)) ? settled : { candidates: EMPTY, unavailable: null };

  return {
    candidates: data.candidates,
    unavailable: data.unavailable,
    isPending: query.isPending,
  };
}
