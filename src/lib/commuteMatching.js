export const COMMUTE_MATCH_RADIUS_M = 225;

// Number(null) and Number('') are 0, so a redacted point stored as
// { lat: null, lng: null } would otherwise become a real-looking cell at 0,0
// instead of being skipped.
const finiteCoordinate = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const routeCell = (point) => {
  const lat = finiteCoordinate(point?.lat);
  const lng = finiteCoordinate(point?.lng);
  if (lat === null || lng === null) return null;
  const latCellDegrees = COMMUTE_MATCH_RADIUS_M / 111320;
  const lngCellDegrees = COMMUTE_MATCH_RADIUS_M / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
  return `${Math.round(lat / latCellDegrees)},${Math.round(lng / lngCellDegrees)}`;
};

const hasPrivacyMarker = (point = {}) => Boolean(
  point?.masked_for_privacy === true ||
  point?.privacy_gap === true ||
  point?.privacy_boundary === true ||
  point?.privacy_live_redacted === true ||
  point?.privacy_zone_id
);

export function routeKeyForTrip(trip = {}) {
  // Stored keys are local-only summary identifiers. Reuse them so lightweight
  // Coach summaries do not need to reload full route geometry.
  if (typeof trip.route_key === 'string' && trip.route_key) return trip.route_key;
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  // Newly derived keys use only retained public points; gap and boundary
  // markers are intentionally ignored.
  const publicPoints = points.filter((point) => !hasPrivacyMarker(point) && routeCell(point));
  if (publicPoints.length < 2) return null;
  const start = routeCell(publicPoints[0]);
  const end = routeCell(publicPoints[publicPoints.length - 1]);
  if (!start || !end) return null;
  return `${start}|${end}`;
}
