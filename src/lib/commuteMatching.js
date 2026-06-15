export const COMMUTE_MATCH_RADIUS_M = 225;

const routeCell = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latCellDegrees = COMMUTE_MATCH_RADIUS_M / 111320;
  const lngCellDegrees = COMMUTE_MATCH_RADIUS_M / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return `${Math.round(lat / latCellDegrees)},${Math.round(lng / lngCellDegrees)}`;
};

export function routeKeyForTrip(trip = {}) {
  if (typeof trip.route_key === 'string' && trip.route_key) return trip.route_key;
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (points.length < 2) return null;
  const start = routeCell(points[0]);
  const end = routeCell(points[points.length - 1]);
  if (!start || !end) return null;
  return `${start}|${end}`;
}
