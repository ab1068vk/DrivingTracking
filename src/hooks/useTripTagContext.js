import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';

/**
 * Bounded tag context for a detail surface (P7 Stage 5, **Q7**).
 *
 * What it replaces on `TripDetail.jsx`: a 100-row summary query issued on every
 * detail open, purely to feed tag inference. A detail page is a by-id consumer;
 * fetching a list to render one trip is exactly the read-inside-detail the
 * phase exists to remove.
 *
 * Q7 is a single explicitly capped page. It owns **no continuation** and says
 * so: the result is complete for the contract that was requested, and
 * `cappedAt` is part of the answer rather than a hidden assumption.
 */

/** The tag-inference horizon. Not user-visible, so not product semantics. */
export const TAG_CONTEXT_MAX_RECENT = 25;

const EMPTY = Object.freeze({ trips: [], cappedAt: TAG_CONTEXT_MAX_RECENT });

/**
 * @param {{maxRecent?: number}} [options]
 * @returns {{trips: Array, cappedAt: number, unavailable: object|null}}
 */
export function useTripTagContext(options = {}) {
  const { maxRecent = TAG_CONTEXT_MAX_RECENT } = options;

  const query = useQuery({
    queryKey: p7QueryKeys.tagContext(maxRecent),
    queryFn: async () => {
      const result = await p7TripQueries.tagContext({ maxRecent });
      if (result.unavailable) return { ...EMPTY, unavailable: result.unavailable };
      return { ...(result.data ?? EMPTY), unavailable: null };
    },
    staleTime: 2 * 60 * 1000,
  });

  const settled = query.data;
  const data = (settled && Array.isArray(settled.trips)) ? settled : EMPTY;

  return {
    // Tag inference reads a *sample* of recent trips by design. An empty sample
    // means "no basis to infer from" and simply yields no inferred tag — it is
    // never presented to the user as a fact about their history.
    trips: data.trips,
    cappedAt: data.cappedAt ?? maxRecent,
    unavailable: data.unavailable ?? null,
    isPending: query.isPending,
  };
}
