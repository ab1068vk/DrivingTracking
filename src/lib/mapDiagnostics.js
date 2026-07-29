// @ts-check

const numericCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null;
};

const countTripEvents = (trip) => (
  Array.isArray(trip?.driving_events)
    ? trip.driving_events.length
    : numericCount(trip?.driving_events_count) ?? 0
);

const countTripGpsPoints = (trip) => (
  numericCount(trip?.route_points_raw_count)
    ?? numericCount(trip?.route_points_map_count)
    ?? (Array.isArray(trip?.route_points) ? trip.route_points.length : 0)
);

/**
 * Builds the diagnostics represented by a set of routes shown together on the
 * map. Keeping this shared prevents premium and standard map presentations
 * from disagreeing about the same overview.
 */
export function buildMapDiagnosticsAggregate(trips = []) {
  const routeTrips = Array.isArray(trips) ? trips.filter(Boolean) : [];
  const distanceKm = routeTrips.reduce((total, trip) => total + (Number(trip?.distance_km) || 0), 0);
  const durationSeconds = routeTrips.reduce((total, trip) => total + (Number(trip?.duration_seconds) || 0), 0);
  const distanceWeightedAverageSpeed = routeTrips.reduce((total, trip) => {
    const distance = Number(trip?.distance_km) || 0;
    const averageSpeed = Number(trip?.avg_speed_kmh ?? trip?.avg_running_speed_kmh) || 0;
    return total + (distance * averageSpeed);
  }, 0);

  return {
    distance_km: distanceKm,
    duration_seconds: durationSeconds,
    max_speed_kmh: routeTrips.reduce((maximum, trip) => Math.max(maximum, Number(trip?.max_speed_kmh) || 0), 0),
    avg_speed_kmh: durationSeconds > 0
      ? distanceKm / (durationSeconds / 3600)
      : distanceKm > 0
        ? distanceWeightedAverageSpeed / distanceKm
        : 0,
    route_points_raw_count: routeTrips.reduce((total, trip) => total + countTripGpsPoints(trip), 0),
    driving_events_count: routeTrips.reduce((total, trip) => total + countTripEvents(trip), 0),
    traffic_stop_count: routeTrips.reduce((total, trip) => (
      total + (numericCount(trip?.traffic_stop_count) ?? numericCount(trip?.stop_count) ?? 0)
    ), 0),
  };
}
