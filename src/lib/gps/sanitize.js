const DEFAULT_COORD_PRECISION = 5;
const ALTITUDE_PRECISION_M = 1;

export function truncateCoord(value, precision = DEFAULT_COORD_PRECISION) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;

  const factor = Math.pow(10, precision);
  return Math.round(number * factor) / factor;
}

export function truncateRoutePoint(point) {
  if (!point || typeof point !== 'object') return point;

  const truncated = {
    ...point,
    lat: point.lat != null ? truncateCoord(point.lat) : point.lat,
    lng: point.lng != null ? truncateCoord(point.lng) : point.lng,
  };

  if (point.alt != null) truncated.alt = truncateAltitude(point.alt);
  if (point.altitude != null) truncated.altitude = truncateAltitude(point.altitude);

  return truncated;
}

function truncateAltitude(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Math.round(number / ALTITUDE_PRECISION_M) * ALTITUDE_PRECISION_M;
}

export function truncateRoutePoints(points) {
  if (!Array.isArray(points)) return points;
  return points.map(truncateRoutePoint);
}

export function truncateTripCoordinates(trip) {
  if (!trip || typeof trip !== 'object' || Array.isArray(trip)) return trip;

  return {
    ...trip,
    ...(Array.isArray(trip.route_points) ? { route_points: truncateRoutePoints(trip.route_points) } : {}),
    ...(Array.isArray(trip.raw_route_points) ? { raw_route_points: truncateRoutePoints(trip.raw_route_points) } : {}),
  };
}
