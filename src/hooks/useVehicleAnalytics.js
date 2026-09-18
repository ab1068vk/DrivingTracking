import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { p7QueryKeys, p7TripQueries } from '@/api/trips';
import { buildTripSummary } from '@/lib/tripSummary';

/**
 * The Vehicles page's canonical composition (P7 Stage 6, ledger entry #25,
 * Annex C rows **O09** and **O10**).
 *
 * What it replaces: a `(100)` page plus an idle-gated `(200)` page, from which
 * the fleet's lifetime distance, per-vehicle distance, per-vehicle trip count
 * and per-vehicle score were all derived. Those are lifetime figures; deriving
 * them from a 200-row window made them wrong for any fleet with more history
 * than that, silently.
 *
 * The declared graph is **Q1** for the bounded recent rows the assignment and
 * service surfaces work on, plus **Q4 per vehicle** reading the D1 owner's own
 * `browser:vehicle:<id>:2` bucket — the owner that already keys exactly these
 * totals. No second vehicle-analytics owner is created, no browser vehicle
 * index is added, and no per-vehicle history scan is issued.
 *
 * The per-vehicle score is **distance-weighted**, which is what
 * `calculateAverageVehicleScore` computes and what `scoreDistanceProduct` /
 * `scoreDistanceWeight` key. The plain mean is a different metric and is not
 * substituted for it.
 */

/** Rows the assignment, suggestion and service surfaces work on. */
export const VEHICLE_RECENT_ROWS = 100;

const totalsFrom = (result) => {
  // `null` means "the owner did not serve this", and only a real Q4 envelope
  // counts as having served it. Treating an absent or foreign payload as
  // authoritative would report a zero-kilometre fleet as a measurement.
  if (!result || result.unavailable) return null;
  const totals = result.data?.totals;
  if (!totals || typeof totals !== 'object') return null;
  const weight = Number(totals.scoreDistanceWeight) || 0;
  return {
    trips: Number(totals.completedCount) || 0,
    distanceKm: Number(totals.totalKm) || 0,
    // Distance-weighted, never the plain mean.
    score: weight > 0 ? Math.round((Number(totals.scoreDistanceProduct) || 0) / weight) : null,
  };
};

/**
 * @param {Array<{id: any}>} vehicles the page's existing bounded vehicle list
 */
export function useVehicleAnalytics(vehicles = []) {
  const recent = useQuery({
    queryKey: p7QueryKeys.history(`vehicles:${VEHICLE_RECENT_ROWS}`, 'first'),
    queryFn: async () => {
      const page = await p7TripQueries.historyPage({
        sort: '-start_time', status: 'completed', limit: VEHICLE_RECENT_ROWS,
      });
      if (page.unavailable) return { rows: [], unavailable: page.unavailable };
      return { rows: (page.data ?? []).map(buildTripSummary), unavailable: null };
    },
    staleTime: 2 * 60 * 1000,
  });

  const fleet = useQuery({
    queryKey: p7QueryKeys.aggregate('vehicles-fleet', 'lifetime'),
    queryFn: () => p7TripQueries.aggregate({ scope: 'global' }),
    staleTime: 2 * 60 * 1000,
  });

  // One Q4 per vehicle. The fan-out is bounded by the size of the fleet, which
  // is fixed by the user's garage and never by retained history.
  const perVehicle = useQueries({
    queries: vehicles.map((vehicle) => ({
      queryKey: p7QueryKeys.aggregate('vehicle', String(vehicle.id)),
      queryFn: () => p7TripQueries.aggregate({ scope: 'vehicle', vehicleId: String(vehicle.id) }),
      staleTime: 2 * 60 * 1000,
    })),
  });

  const settled = recent.data;
  const rows = (settled && Array.isArray(settled.rows)) ? settled.rows : [];

  // `useQueries` returns a fresh array every render, so the memo keys on the
  // settled results rather than on the array identity.
  const perVehicleResults = perVehicle.map((entry) => entry.data);
  const perVehicleKey = perVehicleResults
    .map((entry) => (entry?.unavailable ? `u:${entry.unavailable.code}` : JSON.stringify(entry?.data?.totals ?? null)))
    .join('|');

  const lifetime = useMemo(() => {
    const fleetTotals = totalsFrom(fleet.data);
    const byVehicleId = new Map();
    vehicles.forEach((vehicle, index) => {
      const totals = totalsFrom(perVehicleResults[index]);
      if (totals) byVehicleId.set(String(vehicle.id), totals);
    });
    return {
      // `null` means the owner did not serve it. The caller must render that as
      // a state, never as a zero-kilometre fleet.
      fleet: fleetTotals,
      byVehicleId,
      available: Boolean(fleetTotals),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet.data, vehicles, perVehicleKey]);

  return {
    recentTrips: rows,
    recentUnavailable: settled?.unavailable ?? null,
    lifetime,
    lifetimeUnavailable: fleet.data?.unavailable ?? null,
    lifetimeReadiness: fleet.data?.p6Readiness ?? null,
    isPending: recent.isPending,
    isLoading: recent.isPending,
    isSuccess: recent.isSuccess,
  };
}
