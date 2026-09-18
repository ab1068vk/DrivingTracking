import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';
import { getP7SourceToken, subscribeP7SourceChange } from '@/lib/p7SourceChange';
import {
  q1SortFor,
  registerTripHistoryFilters,
  tripHistoryDateRange,
  tripHistoryFilterObject,
} from '@/lib/tripHistoryFilters';

/**
 * The history pages' **one** canonical top-level composition (P7 Stage 4,
 * consumer ledger entries #24 and #20).
 *
 * What it replaces on `TripHistory.jsx`: a `(100)` page plus a gated `(200)`
 * page, both fetched in full and then filtered, sorted and sliced in JS. Beyond
 * 200 retained trips that window was silently not the history — the page
 * reported "all" over a truncation.
 *
 * The composition is **Q1 with a real cursor**. Status and the date range are
 * index-served; the quick filter and tag selection are the registered named
 * budgeted filters; anything the budget could not finish comes back `PARTIAL`
 * with a real continuation, so "more available" is a fact the page states
 * rather than an assumption it hides.
 *
 * Accumulated rows are **page-owned and ephemeral**: a snapshot change refuses
 * the cursor, and this hook then discards what it accumulated and restarts,
 * because rows from two snapshots may never be combined.
 */

/** Rows fetched per Q1 turn. Not a user-visible window, so not product semantics. */
export const TRIP_HISTORY_FETCH_PAGE = 60;

/** How many turns one automatic "load more" interaction may consume. */
export const TRIP_HISTORY_TURNS_PER_REQUEST = 1;

const EMPTY = Object.freeze({ rows: [], cursor: null, completeness: null, unavailable: null });

/**
 * @param {{sortBy?: string, quickFilter?: string, dateFilter?: string,
 *          dateFrom?: string, dateTo?: string, selectedTags?: string[],
 *          tagMatchMode?: string, status?: string}} controls
 */
/**
 * The three population states this pagination can actually prove (HPR-001).
 *
 * `COMPLETE` requires an authoritative terminal read: a cursor that ran out
 * **and** no failed page behind it. A retained prefix whose continuation was
 * refused still has unread history, so a failed read is `COMPLETENESS_UNKNOWN`
 * rather than EOF — collapsing the two is what let a 60-row prefix claim to be
 * the whole matching population. Nothing else may promote the state: not the
 * row count, not the filtered count, not the absence of a load-more affordance.
 *
 * @param {{cursor?: unknown, unavailable?: unknown}} pagination
 * @returns {'COMPLETE'|'MORE_AVAILABLE'|'COMPLETENESS_UNKNOWN'}
 */
export function derivePopulationState({ cursor, unavailable } = {}) {
  if (unavailable) return 'COMPLETENESS_UNKNOWN';
  return cursor ? 'MORE_AVAILABLE' : 'COMPLETE';
}

export function useTripHistoryPageData(controls = {}) {
  const {
    sortBy = 'date_desc',
    quickFilter = 'all',
    dateFilter = 'all',
    dateFrom = '',
    dateTo = '',
    selectedTags = [],
    tagMatchMode = 'all',
    status = 'completed',
  } = controls;

  // Registering here rather than at module scope keeps the vocabulary tied to a
  // surface that actually uses it; the call is idempotent.
  useEffect(() => { registerTripHistoryFilters(); }, []);

  const request = useMemo(() => ({
    sort: q1SortFor(sortBy),
    status,
    range: tripHistoryDateRange(dateFilter, dateFrom, dateTo),
    filter: tripHistoryFilterObject({ quickFilter, selectedTags, tagMatchMode }),
    limit: TRIP_HISTORY_FETCH_PAGE,
  }), [sortBy, status, dateFilter, dateFrom, dateTo, quickFilter, selectedTags, tagMatchMode]);

  const requestId = useMemo(() => JSON.stringify(request), [request]);

  // Accumulated rows belong to this request identity only. A control change
  // mints a new identity and the accumulation starts again — it is never
  // carried across two different queries.
  const [accumulated, setAccumulated] = useState(EMPTY);
  const accumulatedFor = useRef(requestId);
  if (accumulatedFor.current !== requestId) {
    accumulatedFor.current = requestId;
    if (accumulated !== EMPTY) setAccumulated(EMPTY);
  }

  const firstPage = useQuery({
    queryKey: p7QueryKeys.history(requestId, 'first'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage(request);
      if (page.unavailable) {
        return { rows: [], cursor: null, completeness: null, unavailable: page.unavailable };
      }
      return {
        rows: (page.data ?? []).map(buildTripSummary),
        cursor: page.continuation,
        completeness: page.completeness,
        unavailable: null,
      };
    },
    staleTime: 2 * 60 * 1000,
  });

  const settled = firstPage.data;
  const base = (settled && Array.isArray(settled.rows)) ? settled : EMPTY;

  const [loadingMore, setLoadingMore] = useState(false);

  /**
   * AUD-001 / RL-002. React Query owns the first page and is invalidated by the
   * coordinator, but the continuation rows live HERE, outside the cache, and no
   * invalidation can reach them. Showing a refreshed page 1 above pages 2..n from the
   * previous snapshot is worse than showing nothing stale at all: the list would contain
   * the same trip twice, or silently drop one.
   *
   * So a source change discards the accumulation as well. The token is also captured
   * around each in-flight turn, because a `loadMore` that started before the change must
   * not append its answer afterwards.
   */
  const sourceToken = useRef(getP7SourceToken());
  useEffect(() => subscribeP7SourceChange(({ token }) => {
    sourceToken.current = token;
    setAccumulated((current) => (current === EMPTY ? current : EMPTY));
  }), []);

  const rows = useMemo(
    () => (accumulated.rows.length ? [...base.rows, ...accumulated.rows] : base.rows),
    [base.rows, accumulated.rows]
  );
  const cursor = accumulated.rows.length ? accumulated.cursor : base.cursor;
  const unavailable = accumulated.unavailable ?? base.unavailable;

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const turnToken = sourceToken.current;
    setLoadingMore(true);
    try {
      for (let turn = 0; turn < TRIP_HISTORY_TURNS_PER_REQUEST; turn += 1) {
         
        const page = await p7TripQueries.historyPage({ ...request, cursor });
        // The source moved while this turn was in flight: its rows belong to a snapshot
        // that no longer exists, so they are dropped rather than appended.
        if (sourceToken.current !== turnToken) return;
        if (page.unavailable) {
          // A refused cursor means the row set moved. Rows from two snapshots
          // are never combined, so the accumulation is discarded and the first
          // page refetches from the current snapshot.
          setAccumulated(EMPTY);
          if (String(page.unavailable.code).startsWith('CURSOR_')) {
            await firstPage.refetch();
          } else {
            setAccumulated({ ...EMPTY, unavailable: page.unavailable });
          }
          return;
        }
        setAccumulated((current) => ({
          rows: [...current.rows, ...(page.data ?? []).map(buildTripSummary)],
          cursor: page.continuation,
          completeness: page.completeness,
          unavailable: null,
        }));
        if (!page.continuation) return;
      }
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, request, firstPage]);

  const reset = useCallback(async () => {
    setAccumulated(EMPTY);
    await firstPage.refetch();
  }, [firstPage]);

  return {
    rows,
    /**
     * `true` while the scan has not reached the end of the requested range. The
     * page must label its totals and counts "at least N" while this holds.
     */
    hasMore: Boolean(cursor) && !unavailable,
    /**
     * The typed completeness authority. `hasMore` stays a request affordance —
     * it gates the load-more control — while this states what the read proved.
     */
    populationState: derivePopulationState({ cursor, unavailable }),
    completeness: accumulated.rows.length ? accumulated.completeness : base.completeness,
    unavailable,
    loadMore,
    loadingMore,
    reset,
    isPending: firstPage.isPending,
    isFetching: firstPage.isFetching || loadingMore,
    isError: firstPage.isError,
    error: firstPage.error,
    refetch: reset,
  };
}
