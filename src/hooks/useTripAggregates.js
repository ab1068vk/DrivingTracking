import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  calculateCarbonImpact,
  calculatePeakHourStress,
  computePersonalBaseline,
  identifyCommutePatterns,
} from '@/lib/tripInsights';

const EMPTY_BASELINE = {
  baseline_avg: null,
  baseline_confidence_interval: null,
  baseline_confidence_interval_label: null,
  baseline_trip_count: 0,
  baseline_includes_older_scores: false,
  baseline_label: null,
  this_week_avg: null,
  delta: null,
  trend: 'unknown',
  percentile: null,
  percentile_min_weeks: 4,
};

const EMPTY_PEAK_HOUR_STRESS = {
  peak_trips_event_rate: null,
  off_peak_trips_event_rate: null,
  stress_ratio: null,
  peak_stress_score: null,
  peak_stress_label: 'insufficient off-peak data',
  peak_trip_count: 0,
  off_peak_trip_count: 0,
  insufficient_data: true,
};

const EMPTY_CARBON_IMPACT = {
  total_co2_saved_kg: 0,
  eligible_trip_count: 0,
  savings_available: false,
  trees_equivalent: 0,
  carbon_grade: 'Getting Started',
};

const idle = () => new Promise((resolve) => {
  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    window.requestIdleCallback(resolve, { timeout: 10000 });
    return;
  }
  setTimeout(resolve, 0);
});

function tripsCacheKey(trips = []) {
  return trips.map((trip) => [
    trip.id,
    trip.updated_at,
    trip.score_overall ?? '',
    trip.score_version ?? trip.score_provenance?.version ?? trip.score_provenance?.scoring_version ?? '',
    trip.start_time ?? '',
    trip.distance_km ?? '',
    trip.duration_seconds ?? '',
    trip.harsh_brakes_count ?? 0,
    trip.rapid_accel_count ?? 0,
    trip.sharp_turns_count ?? 0,
    trip.speeding_events_count ?? 0,
    trip.vehicle_id ?? '',
    trip.co2_saved_kg ?? '',
    trip.route_points_raw_count ?? trip.route_points?.length ?? 0,
  ].join(':')).join('|');
}

function settingsCacheKey(settings = {}) {
  return [
    settings.units,
    settings.co2_baseline_kg_per_100km,
    settings.ev_kwh_per_100km,
    settings.grid_co2_kg_per_kwh,
    settings.tree_co2_kg_per_year,
  ].map((value) => value ?? '').join(':');
}

function vehiclesCacheKey(vehicles = []) {
  const list = Array.isArray(vehicles) ? vehicles : [];
  return list.map((vehicle) => [
    vehicle.id,
    vehicle.updated_at,
    vehicle.fuel_type,
    vehicle.fuel_efficiency_l_per_100km,
    vehicle.ev_kwh_per_100km,
  ].map((value) => value ?? '').join(':')).join('|');
}

export function useTripAggregates(completedTrips = [], settings = {}, vehicles = []) {
  const cacheKey = useMemo(() => ({
    trips: tripsCacheKey(completedTrips),
    settings: settingsCacheKey(settings),
    vehicles: vehiclesCacheKey(vehicles),
  }), [completedTrips, settings, vehicles]);

  const { data } = useQuery({
    queryKey: ['trip-aggregates', cacheKey],
    queryFn: async () => {
      await idle();
      return {
        baseline: computePersonalBaseline(completedTrips),
        peakHourStress: calculatePeakHourStress(completedTrips),
        commutePatterns: identifyCommutePatterns(completedTrips),
        carbonImpact: calculateCarbonImpact(completedTrips, settings, vehicles),
      };
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    networkMode: 'always',
    placeholderData: (previous) => previous,
  });

  return data ?? {
    baseline: EMPTY_BASELINE,
    peakHourStress: EMPTY_PEAK_HOUR_STRESS,
    commutePatterns: [],
    carbonImpact: EMPTY_CARBON_IMPACT,
  };
}
