import { isRoutePointInsidePrivacyZone } from '@/lib/privacyZones';

const MAX_PREVIEW_SEGMENTS = 64;
const MAX_PREVIEW_TRIPS = 60;

const isProtectedRecord = (item = {}) => Boolean(
  item?.masked_for_privacy === true ||
  item?.privacy_gap === true ||
  item?.privacy_boundary === true ||
  item?.privacy_live_redacted === true ||
  item?.privacy_event_redacted === true ||
  item?.privacy_purged === true ||
  item?.privacy_zone_id
);

const classifyRecord = (item = {}, zones = []) => {
  if (isProtectedRecord(item)) return 'protected';
  if (zones.some((zone) => isRoutePointInsidePrivacyZone(item, zone))) return 'exposed';
  return 'retained';
};

const segmentPriority = Object.freeze({ retained: 0, protected: 1, exposed: 2 });

const compressSegments = (statuses = [], limit = MAX_PREVIEW_SEGMENTS) => {
  if (statuses.length <= limit) return statuses;
  const bucketSize = Math.ceil(statuses.length / limit);
  const output = [];
  for (let index = 0; index < statuses.length; index += bucketSize) {
    output.push(statuses
      .slice(index, index + bucketSize)
      .reduce((highest, status) => (
        segmentPriority[status] > segmentPriority[highest] ? status : highest
      ), 'retained'));
  }
  return output;
};

const countStatuses = (statuses = []) => statuses.reduce((counts, status) => ({
  ...counts,
  [status]: (counts[status] || 0) + 1,
}), { retained: 0, protected: 0, exposed: 0 });

const timestampMs = (trip = {}) => {
  const parsed = new Date(trip?.start_time || trip?.end_time || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Builds a coordinate-free before/after model. No address or GPS field is
 * copied into the result, so it is safe to keep in authenticated UI state.
 */
export function buildTripPrivacyPreview(trip = {}, zones = []) {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const drivingEvents = Array.isArray(trip?.driving_events) ? trip.driving_events : [];
  const pointStatuses = routePoints.map((point) => classifyRecord(point, zones));
  const eventStatuses = drivingEvents.map((event) => classifyRecord(event, zones));
  const pointCounts = countStatuses(pointStatuses);
  const eventCounts = countStatuses(eventStatuses);
  const afterStatuses = pointStatuses.map((status) => status === 'exposed' ? 'protected' : status);
  const beforeSegments = compressSegments(pointStatuses);
  const afterSegments = compressSegments(afterStatuses);
  const startStatus = pointStatuses[0] || 'retained';
  const endStatus = pointStatuses.at?.(-1) || 'retained';

  return {
    id: trip?.id == null ? '' : String(trip.id),
    startedAt: trip?.start_time || null,
    endedAt: trip?.end_time || null,
    pointCount: routePoints.length,
    eventCount: drivingEvents.length,
    affected: pointCounts.exposed + eventCounts.exposed > 0,
    exposureCount: pointCounts.exposed + eventCounts.exposed,
    before: {
      exposedPoints: pointCounts.exposed,
      exposedEvents: eventCounts.exposed,
      protectedPoints: pointCounts.protected,
      protectedEvents: eventCounts.protected,
      retainedPoints: pointCounts.retained,
      startStatus,
      endStatus,
      segments: beforeSegments,
    },
    after: {
      exposedPoints: 0,
      exposedEvents: 0,
      newlyProtectedPoints: pointCounts.exposed,
      newlyProtectedEvents: eventCounts.exposed,
      protectedPoints: pointCounts.protected + pointCounts.exposed,
      protectedEvents: eventCounts.protected + eventCounts.exposed,
      retainedPoints: pointCounts.retained,
      startStatus: startStatus === 'exposed' ? 'protected' : startStatus,
      endStatus: endStatus === 'exposed' ? 'protected' : endStatus,
      segments: afterSegments,
    },
  };
}

export function buildHistoricalPrivacyExposure(trips = [], zones = []) {
  const allPreviews = (Array.isArray(trips) ? trips : [])
    .map((trip) => ({
      ...buildTripPrivacyPreview(trip, zones),
      sortTimestamp: timestampMs(trip),
    }));
  const summary = allPreviews.reduce((totals, preview) => ({
    scannedTripCount: totals.scannedTripCount + 1,
    affectedTripCount: totals.affectedTripCount + (preview.affected ? 1 : 0),
    exposedPointCount: totals.exposedPointCount + preview.before.exposedPoints,
    exposedEventCount: totals.exposedEventCount + preview.before.exposedEvents,
    alreadyProtectedPointCount: totals.alreadyProtectedPointCount + preview.before.protectedPoints,
    alreadyProtectedEventCount: totals.alreadyProtectedEventCount + preview.before.protectedEvents,
  }), {
    scannedTripCount: 0,
    affectedTripCount: 0,
    exposedPointCount: 0,
    exposedEventCount: 0,
    alreadyProtectedPointCount: 0,
    alreadyProtectedEventCount: 0,
  });
  const previews = allPreviews
    .sort((a, b) => (
      Number(b.affected) - Number(a.affected) ||
      b.exposureCount - a.exposureCount ||
      b.sortTimestamp - a.sortTimestamp
    ))
    .slice(0, MAX_PREVIEW_TRIPS)
    .map(({ sortTimestamp, ...preview }) => preview);

  return { summary, previews };
}
