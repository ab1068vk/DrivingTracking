import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';

/**
 * Footer totals for a history surface (P7 Stage 4, Annex C row O08).
 *
 * What it replaces on `TrackingTripHistory.jsx`: a `reduce` over whatever rows
 * the page had fetched. With 200 rows fetched and 201 retained, that figure was
 * simply wrong, and nothing on screen said so.
 *
 * The totals come from the named reducer `p7.history.filteredTotals@1`, which
 * declares exactly the terms this footer shows: count, distance, duration,
 * event count and retained-route count. The reducer performs **one bounded turn
 * per invocation** — a render never drains its continuation — so a first paint
 * shows a truthful floor and the user can finish the tally deliberately.
 *
 * `EXACT` means the scan reached terminal EOF. Anything else is a floor and the
 * caller must label it "at least".
 */

const REDUCER = 'p7.history.filteredTotals@1';

const EMPTY_TOTALS = Object.freeze({
  count: 0, distance: 0, duration: 0, event_count: 0, route_retained_count: 0,
});

/**
 * @param {{status?: string, range?: object|null, limit?: number, enabled?: boolean}} [options]
 */
export function useTripHistoryTotals(options = {}) {
  const { status = 'completed', range = null, limit = 200, enabled = true } = options;

  const request = useMemo(
    () => ({ reducer: REDUCER, status, range, limit }),
    [status, range, limit]
  );
  const requestId = useMemo(() => JSON.stringify({ status, range, limit }), [status, range, limit]);

  const [continued, setContinued] = useState(null);
  const [finishing, setFinishing] = useState(false);

  const firstTurn = useQuery({
    queryKey: p7QueryKeys.reduce('p7.history.filteredTotals', 1, requestId),
    queryFn: () => p7TripQueries.reducer(request),
    enabled,
    staleTime: 2 * 60 * 1000,
  });

  const settled = continued ?? firstTurn.data;
  const unavailable = settled?.unavailable ?? null;
  const exact = settled?.completeness === 'EXACT';
  // A PARTIAL turn reports its running tally under `partial`; a terminal turn
  // reports the finished value directly. Neither is ever presented as the other.
  const totals = unavailable
    ? EMPTY_TOTALS
    : ((exact ? settled?.data : settled?.data?.partial) ?? EMPTY_TOTALS);

  /**
   * Drive the tally to terminal EOF. This is the explicit, user-triggered
   * finish path: it is never called from a render, an effect, a focus handler,
   * a resume handler or a cache invalidation.
   */
  const finish = useCallback(async () => {
    if (exact || unavailable || finishing) return;
    setFinishing(true);
    try {
      let result = settled;
      for (let turn = 0; turn < 500; turn += 1) {
        if (!result?.continuation) break;
        result = await p7TripQueries.reducer({ ...request, continuation: result.continuation });
        if (result?.unavailable) break;
        if (result?.completeness === 'EXACT') break;
      }
      setContinued(result ?? null);
    } finally {
      setFinishing(false);
    }
  }, [exact, unavailable, finishing, settled, request]);

  return {
    totals,
    /** `true` only at terminal EOF. While false the caller labels totals "at least". */
    exact,
    unavailable,
    finish,
    finishing,
    isPending: firstTurn.isPending,
  };
}
