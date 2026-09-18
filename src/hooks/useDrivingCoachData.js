import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';
import { isDriverMetricEligible } from '@/lib/phoneUseSummary';

/**
 * The Driving Coach page's canonical composition (P7 Stage 6.6, ledger entry
 * #4, Annex C rows **O19-O21**).
 *
 * What it replaces: a `(50)` page plus a `(200)` page gated only on the first
 * having loaded, so the second always fired. Every Coach analysis ran over
 * whichever of the two had arrived, and the historical-evidence audit — which
 * says "completed trips found" and "driver trips eligible" — reported the size
 * of that sample as though it were the driver's history.
 *
 * The declared graph:
 *
 * | Row | Source |
 * |---|---|
 * | **O19** the recent analyses | **Q1**, one bounded page, labelled `latest N` |
 * | **O20** the prior-window comparison | the same Q1 window the analyses use — never Q4/Q5 for this population |
 * | **O21** "all drives" / historical evidence | **Q4** for the `P-COMPLETED` count, **Q10** `p7.report.durationDistance@1` for the `P-DRIVER` count |
 *
 * §C1a.0 is what splits those last two. `totalCompleted` is `P-COMPLETED` and
 * the D1 owner can express it exactly. `driverEligible` is `P-DRIVER`, which no
 * aggregate owner can express — the `driver_metric_eligible` projection field
 * lets a **row** evaluate the predicate, it does not make D1 driver-filtered.
 * So the driver-eligible lifetime count comes from a named reducer, and O21
 * explicitly forbids serving it from a 50/200-row sample.
 *
 * The per-trip readiness terms (score / event / route evidence) are not keyed
 * by any owner and no reducer exists for them — the registry is frozen at 16 —
 * so they stay **window-scoped** and the page labels them that way rather than
 * presenting a sample as a lifetime.
 */

/**
 * The `latest N` analysis window.
 *
 * One bounded page at the public maximum, which is the widest the page ever
 * actually had. It is user-visible — the page names this number — so it is
 * product semantics and not an implementation detail.
 */
export const COACH_WINDOW_ROWS = 200;

/** The frozen per-trip segment fan-out. There is no N x Q2 on this page. */
export const COACH_DETAIL_FANOUT = 5;

const DRIVER_LIFETIME_REDUCER = 'p7.report.durationDistance@1';

const emptyPage = Object.freeze({ rows: [], completeness: null, continuation: null, unavailable: null });

const readWindow = async () => {
  const page = await p7TripQueries.historyPage({
    sort: '-start_time', status: 'completed', limit: COACH_WINDOW_ROWS,
  });
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

export function useDrivingCoachData() {
  const windowQuery = useQuery({
    queryKey: p7QueryKeys.history(`coach:${COACH_WINDOW_ROWS}`, 'first'),
    queryFn: readWindow,
    staleTime: 2 * 60 * 1000,
  });

  const completedQuery = useQuery({
    queryKey: p7QueryKeys.aggregate('coach-completed', 'lifetime'),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global' }),
    staleTime: 5 * 60 * 1000,
  });

  const driverQuery = useQuery({
    queryKey: p7QueryKeys.reduce('p7.report.durationDistance', 1, 'coach-lifetime'),
    queryFn: () => p7TripQueries.reducer({
      reducer: DRIVER_LIFETIME_REDUCER, status: 'completed', limit: 200,
    }),
    staleTime: 5 * 60 * 1000,
  });

  const [continued, setContinued] = useState(null);
  const [finishing, setFinishing] = useState(false);

  const driverResult = continued ?? driverQuery.data;
  const driverExact = driverResult?.completeness === 'EXACT' && !driverResult?.unavailable;
  const driverStats = driverResult?.unavailable
    ? null
    : (driverExact ? driverResult?.data : driverResult?.data?.partial) ?? null;

  /**
   * Drive the driver-eligible lifetime tally to terminal EOF.
   *
   * Explicit and user-triggered: no render, effect, focus or resume handler
   * calls it, which is why this page registers no durable operation.
   */
  const finishDriverLifetime = useCallback(async () => {
    if (driverExact || finishing || !driverResult?.continuation) return;
    setFinishing(true);
    try {
      let result = driverResult;
      for (let turn = 0; turn < 500 && result?.continuation; turn += 1) {
        result = await p7TripQueries.reducer({
          reducer: DRIVER_LIFETIME_REDUCER,
          status: 'completed',
          limit: 200,
          continuation: result.continuation,
        });
        if (result?.unavailable || result?.completeness === 'EXACT') break;
      }
      setContinued(result ?? null);
    } finally {
      setFinishing(false);
    }
  }, [driverExact, finishing, driverResult]);

  const settled = windowQuery.data && Array.isArray(windowQuery.data.rows) ? windowQuery.data : emptyPage;
  const completedTrips = settled.rows;

  // The `P-DRIVER` window, read from the approved projection boolean rather
  // than re-derived per consumer.
  const driverTrips = useMemo(
    () => completedTrips.filter(isDriverMetricEligible),
    [completedTrips]
  );

  const completedTotals = completedQuery.data?.unavailable ? null : completedQuery.data?.data?.totals ?? null;

  /**
   * The lifetime half of the historical-evidence audit, or `null` when neither
   * owner has answered — which the audit renders as its own state, never as a
   * zero and never as the size of the window.
   */
  const lifetimeEvidence = useMemo(() => {
    const totalCompleted = Number.isFinite(completedTotals?.completedCount)
      ? completedTotals.completedCount : null;
    const driverEligible = Number.isFinite(driverStats?.trip_count)
      ? driverStats.trip_count : null;
    if (totalCompleted == null && driverEligible == null) return null;
    return {
      totalCompleted,
      driverEligible,
      // Exact only when the served aggregate and a terminal reducer agree on
      // having finished; a partial reducer is a floor, not a total.
      exact: Boolean(totalCompleted != null && driverEligible != null && driverExact),
    };
  }, [completedTotals, driverStats, driverExact]);

  return {
    /** O19 — the labelled `latest N` window and its `P-DRIVER` rows. */
    completedTrips,
    driverTrips,
    windowRows: COACH_WINDOW_ROWS,
    // A full Q1 page is `EXACT` and still has more behind it; the window is
    // the whole population only when the continuation is null.
    windowExact: settled.continuation == null && !settled.unavailable,
    windowUnavailable: settled.unavailable,

    /** O21 — the lifetime evidence, from the owners that can express it. */
    lifetimeEvidence,
    lifetimeExact: driverExact && Boolean(completedTotals),
    lifetimeUnavailable: driverResult?.unavailable ?? completedQuery.data?.unavailable ?? null,
    lifetimeReadiness: completedQuery.data?.p6Readiness ?? null,
    finishDriverLifetime,
    finishingDriverLifetime: finishing,

    isLoading: windowQuery.isPending,
    isFetching: windowQuery.isFetching || completedQuery.isFetching || driverQuery.isFetching,
    isSuccess: windowQuery.isSuccess,
  };
}
