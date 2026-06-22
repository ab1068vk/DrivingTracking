import {
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';
import {
  getPrivacyZones,
  isPointInPrivacyZone,
  maskEventsForPrivacy,
  maskRoutePointsForPrivacy,
} from '@/lib/privacyZones';
import {
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
} from '@/lib/phoneUsageAccess';

const PRIVACY_POINT_FLAGS = Object.freeze([
  'masked_for_privacy',
  'privacy_gap',
  'privacy_boundary',
  'privacy_live_redacted',
]);

const KINEMATIC_FIELDS = Object.freeze([
  'speed',
  'speed_kmh',
  'speedKmh',
  'heading',
  'bearing',
  'course',
  'accuracy',
  'altitude',
]);

export function hasPrivacyRedactionMarker(item = {}) {
  const record = /** @type {Record<string, any>} */ (item || {});
  return Boolean(item && typeof item === 'object' && (
    PRIVACY_POINT_FLAGS.some((field) => record[field] === true) ||
    record.privacy_event_redacted === true ||
    record.privacy_zone_id
  ));
}

export function hasKinematicFields(item = {}) {
  const record = /** @type {Record<string, any>} */ (item || {});
  return Boolean(item && typeof item === 'object' && KINEMATIC_FIELDS.some((field) => record[field] != null));
}

export function rawKinematicPointsInsidePrivacyZones(points = [], zones = []) {
  if (!Array.isArray(points) || !Array.isArray(zones) || !zones.length) return [];
  return points.filter((point) => (
    point &&
    hasKinematicFields(point) &&
    !hasPrivacyRedactionMarker(point) &&
    Boolean(isPointInPrivacyZone(point, zones))
  ));
}

export function scoreInputTouchesPrivacyZone(routePoints = [], events = [], zones = []) {
  return (
    (Array.isArray(routePoints) && routePoints.some((point) => (
      hasPrivacyRedactionMarker(point) || Boolean(isPointInPrivacyZone(point, zones))
    ))) ||
    (Array.isArray(events) && events.some((event) => (
      hasPrivacyRedactionMarker(event) || Boolean(isPointInPrivacyZone(event, zones))
    )))
  );
}

export function prepareScoreInputsForPrivacy({
  routePoints = [],
  events = [],
  settings = {},
  zones = getPrivacyZones(settings),
} = {}) {
  const privacySettings = { ...settings, privacy_zones: zones };
  const maskedRoutePoints = maskRoutePointsForPrivacy(routePoints, privacySettings);
  const maskedEvents = maskEventsForPrivacy(events, privacySettings);
  const touchesPrivacyZone = scoreInputTouchesPrivacyZone(routePoints, events, zones) ||
    maskedRoutePoints.some(hasPrivacyRedactionMarker);

  return {
    routePoints: maskedRoutePoints,
    events: maskedEvents,
    zones,
    touchesPrivacyZone,
    trendExcluded: touchesPrivacyZone,
  };
}

export function assertScoreInputsDoNotContainRawZoneKinematics(routePoints = [], zones = []) {
  const leaked = rawKinematicPointsInsidePrivacyZones(routePoints, zones);
  if (leaked.length) {
    throw new Error(`Score input contains ${leaked.length} raw privacy-zone kinematic point(s)`);
  }
  return true;
}

/**
 * @param {{
 *   trip?: Record<string, any>,
 *   routePoints?: Array<Record<string, any>>,
 *   events?: Array<Record<string, any>>,
 *   thresholds?: any,
 *   settings?: Record<string, any>,
 *   endTime?: any,
 *   localKnowledgeResults?: any,
 *   phoneUse?: any,
 *   motionSamples?: Array<Record<string, any>>,
 *   orientationCalibration?: any,
 *   onScoreInput?: ((input: {routePoints: Array<Record<string, any>>, events: Array<Record<string, any>>, stats: Record<string, any>, privacyZones: Array<Record<string, any>>}) => void) | null,
 * }} options
 */
export function scoreTripWithPrivacyInputs({
  trip = {},
  routePoints = [],
  events = [],
  thresholds,
  settings = {},
  endTime = trip.end_time,
  localKnowledgeResults = null,
  phoneUse = null,
  motionSamples = [],
  orientationCalibration = null,
  onScoreInput = null,
} = {}) {
  const prepared = prepareScoreInputsForPrivacy({ routePoints, events, settings });
  const scoringRoutePoints = prepared.routePoints;
  const stats = calculateTripStats(scoringRoutePoints, trip.start_time, endTime, thresholds, {
    ...trip,
    raw_route_points: scoringRoutePoints,
  });
  const { events: detectedEvents, phoneUse: detectedPhoneUse } = detectDrivingEvents(
    scoringRoutePoints,
    thresholds,
    endTime,
    prepared.zones,
    { localKnowledgeResults, settings }
  );
  const scoringEvents = [...detectedEvents, ...prepared.events];
  const mergedPhoneUse = phoneUse || buildPhoneUseFromTripEvidence(
    trip,
    scoringRoutePoints,
    stats.duration_seconds,
    detectedPhoneUse
  );
  if (typeof onScoreInput === 'function') {
    onScoreInput({
      routePoints: scoringRoutePoints,
      events: scoringEvents,
      stats,
      privacyZones: prepared.zones,
    });
  }
  const scores = calculateTripScores(
    scoringEvents,
    stats,
    scoringRoutePoints,
    thresholds,
    stats.duration_seconds,
    mergedPhoneUse,
    {
      endTime,
      privacyZones: prepared.zones,
      localKnowledgeResults,
      settings,
      motionSamples,
      orientationCalibration,
    }
  );

  return {
    stats,
    detectedEvents,
    phoneUse: mergedPhoneUse,
    scores,
    routePoints: scoringRoutePoints,
    drivingEvents: maskEventsForPrivacy(
      mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || scoringEvents, mergedPhoneUse),
      { privacy_zones: prepared.zones }
    ),
    scoreInputPrivacy: {
      masked: true,
      touchedPrivacyZone: prepared.touchesPrivacyZone,
      trendExcluded: prepared.trendExcluded,
    },
  };
}
