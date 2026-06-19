import { routeKeyForTrip } from '@/lib/commuteMatching';
import { buildCompactPhoneUseSummary } from '@/lib/phoneUseSummary';

export const TRIP_SUMMARY_VERSION = 1;

const DETAIL_ONLY_FIELDS = new Set([
  'route_points',
  'raw_route_points',
  'motion_samples',
  'phone_proxy_events',
  'phone_use_events',
  'native_phone_usage_events',
  'native_tracking_timeline',
  'fatigue_heatmap',
  'route_risk_segments',
]);

const hasReplayableRoute = (trip = {}) => {
  const points = Array.isArray(trip.route_points) ? trip.route_points : [];
  const pointCount = Number(trip.route_points_raw_count) || points.length;
  return pointCount >= 20 && points.some((point) => Number(point?.speed_kmh) > 0);
};

/**
 * Build the lightweight record used by list, dashboard, report, and coaching views.
 * Full route geometry and high-volume sensor collections remain in the trip detail store.
 * @returns {Record<string, any>}
 */
export function buildTripSummary(trip = {}) {
  const summary = /** @type {Record<string, any>} */ ({});
  Object.entries(trip || {}).forEach(([key, value]) => {
    if (!DETAIL_ONLY_FIELDS.has(key)) summary[key] = value;
  });

  return {
    ...summary,
    phone_use_summary: buildCompactPhoneUseSummary(trip),
    route_key: trip.route_key || routeKeyForTrip(trip),
    route_replay_available: trip.route_replay_available === true || hasReplayableRoute(trip),
    summary_version: TRIP_SUMMARY_VERSION,
  };
}
