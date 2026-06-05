// @ts-nocheck
// TODO: remove once the scoring migration no longer depends on loosely typed JS helpers.
import {
  saveExportToDownloads
} from '../../lib/nativeDownloads.js';
import {
  clamp,
  pearsonCorrelation
} from '../../lib/mathUtils.js';
import {
  detectTripStops,
  estimateTripEconomics,
  FATIGUE_HEATMAP_SEGMENT_SECONDS
} from '../../lib/tripInsights.js';
import {
  maskEventCoordinatesForPrivacy,
  maskTripForPrivacy
} from '../../lib/privacyZones.js';
import {
  COMPONENT_METRIC_KEYS,
  CSV_METRIC_COLUMNS,
  METRIC_REGISTRY,
  formatMetricMetadata
} from '../../lib/metricRegistry.js';
import {
  NIGHT_END_HOUR,
  NIGHT_END_TIME,
  NIGHT_START_HOUR,
  NIGHT_START_TIME,
  FATIGUE_SAFETY_PENALTY_SCALE,
  FATIGUE_SAFETY_MAX_PENALTY,
  PENALTY_SCALE_FACTOR
} from '../../lib/appConstants.js';
import {
  SCORING_VERSION,
  SCORING_CONSTANTS,
  calibrationStatusForMetrics,
  getProvisionalScoringConstants,
  scoringValue
} from '../../lib/scoringConstants.js';
import {
  formatEstimatedScore,
  isEstimatedScoreMetric
} from '../../lib/scoreDisplay.js';
import {
  createScoringPipelineContext
} from '../../lib/scoring/pipeline.js';
import {
  explainScores
} from '../../lib/scoring/explainer.js';
import type {
  ComponentScores,
  DrivingEvent,
  RoutePoint,
  ScoreProvenance,
  TripRecord,
  TripStats,
} from '@/types';

import {
  CLOSE_PROXIMITY_DECAY_BASE,
  CONFIDENCE_LEVELS,
  DEFAULT_THRESHOLDS,
  ECO_DEFAULTS,
  ECO_SPEED_STABILITY_CV_MULTIPLIER,
  EVENT_PENALTIES,
  EVENT_TYPES,
  FATIGUE_SEGMENT_SECONDS,
  FUEL_BAND_FULL_SCORE_MULTIPLIER,
  LEGACY_COMPONENT_FIELDS,
  MIN_BRAKE_ONSET_SMOOTHNESS_SEQUENCES,
  OBD_ECO_PENALTY_MAX,
  OBD_HIGH_THROTTLE_PCT,
  OBD_IDLE_RPM_MIN,
  OBD_OVER_REV_RPM,
  OBD_SPEED_FALLBACK_ACCURACY_M,
  OBD_SPEED_MAX_SAMPLE_AGE_MS,
  PHONE_USE_SAFETY_WEIGHT,
  PROVENANCE_THRESHOLD_KEYS,
  STOP_START_MAX_CYCLES_PER_5_KM,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY,
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN,
  STOP_START_MIN_HIGHWAY_DISTANCE_KM,
  STOP_START_MIN_URBAN_DISTANCE_KM,
  STOP_START_NORMALISATION_WINDOW_KM,
  SVI_DEFAULTS,
  TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH,
  TIRE_WEAR_DEFAULT_SPEED_TURN_KMH,
  buildDrivingThresholds,
  buildScoreConstantsSnapshot,
  buildScoreProvenance,
  cappedEvidenceLevel,
  componentConfidence,
  confidenceLevelFromNumeric,
  confidenceNumericValue,
  createComponentScore,
  ecoSettingNumber,
  getScoreProvenanceStatus,
  getTripComponentScore,
  isDiagnosticOnlyScoringEvent,
  normalizedEvidenceLevel,
  registeredComponentConfidence,
  reportedInvalidEcoThresholds,
  resolveEcoScoringConfig,
  settingNumber,
  stableSettingsFingerprint,
  weightedBlend
} from '../calibration/baseline.js';
import {
  CANDIDATE_TRIP_DEFAULTS,
  TRIP_STATES,
  accuracyMeters,
  activityConfidenceOf,
  activityTypeOf,
  calculateAcceleration,
  calculateBearing,
  calculateSegmentMetrics,
  calculateSpeedKmh,
  cleanRoutePoints,
  computeSmoothedAccelerations,
  countStableGpsPoints,
  finiteCoordinate,
  hasValidCoordinates,
  haversineDistance,
  haversineMeters,
  headingDiff,
  headingStdDev,
  isNearRecentParkedLocation,
  isStrongFootActivity,
  isVehicleActivity,
  movementNoiseFloorMeters,
  normalizeLocationPoint,
  parseTimestampMs,
  shouldAcceptLocationPoint,
  speedStdDev,
  timestampMs,
  toRad,
  trimParkedTail,
  validateCandidateTrip
} from '../utils/gps.js';
import {
  perpendicularDistanceMeters,
  simplifyRoute
} from '../route/downsampler.js';
import {
  average,
  calculateEstimatedPrivateDistanceKm,
  calculateRouteDistanceKm,
  calculateTerminalStoppedSeconds,
  classifyRoadType,
  classifyRoadTypesByPoint,
  createRoadTypeWindowSummary,
  createZoneLookup,
  finiteSpeed,
  finiteVehicleSpeed,
  gpsSpeedTimestampMs,
  inferSpeedZones,
  isLikelySpeedSpike,
  isPrivacyBoundaryPoint,
  nearestPointIndexByTimestamp,
  normalizeRoadTypeLabel,
  obdSpeedTimestampMs,
  percentileFromSorted,
  percentileValue,
  pointSpeedKmh,
  privacyZoneKey,
  reliablePointSpeed,
  roadTypeFromWindowSummary,
  round1,
  round2,
  safeMax,
  samePrivacyZoneBoundary,
  sortedInsert,
  sortedRemove,
  speedSourceForPoint,
  speedStdDevFromSummary,
  updateRoadTypeWindowSummary,
  vehicleSpeedKmh,
  zoneFromP85
} from '../route/osmLookup.js';
import {
  calculateEcoDrivingScore,
  calculateFuelBandScore,
  calculateHillDrivingScore,
  calculateJerkScore,
  calculateObdEcoSignals,
  calculateSpeedVariabilityIndex,
  standardDeviation,
  sviDistanceKm,
  unavailableSvi
} from './ecoScore.js';
import {
  LANE_CHANGE_BILATERAL_WINDOW_S,
  LANE_CHANGE_EVENT_TYPE,
  LANE_CHANGE_GPS_MAX_DELTA_DEG,
  LANE_CHANGE_GPS_MIN_DELTA_DEG,
  LANE_CHANGE_MAX_GPS_ACCURACY_M,
  LANE_CHANGE_MAX_LATERAL_G,
  LANE_CHANGE_MAX_NET_HEADING_DEG,
  LANE_CHANGE_MAX_SPEED_DROP_KMH,
  LANE_CHANGE_MIN_LATERAL_G,
  LANE_CHANGE_MIN_SPEED_KMH,
  LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD,
  calculateLaneChangingScore,
  detectHeadingDeviationEvents,
  detectHighwayMergeBehavior,
  detectLaneChanges,
  finiteSampleValue,
  firstPointAtOrAfter,
  headingBetweenPair,
  headingValueForLaneChange,
  normalizedLaneMotionSample,
  sampleTimestampMs,
  speedMaintainedInWindow
} from '../detection/harshAcceleration.js';
import {
  detectCloseProximityManeuverAlerts,
  detectNearMisses,
  detectStopStartPatterns,
  detectStopStartPatternsForMode,
  detectTailgateCycles,
  medianMovingSpeedKmh
} from '../detection/gpsTailgate.js';
import {
  calculateAngularStdDev,
  calculateWindowStats,
  detectErraticSpeedWindows,
  detectSpeedCreepWithThresholds,
  geometryHeadingForIndex,
  headingForIndex,
  headingVarianceForRange,
  isNearIntersectionOrRampContext,
  pointHasIntersectionOrRampContext,
  signedHeadingDelta,
  smoothHeading,
  stddev,
  usableHeadingSegment
} from '../detection/speeding.js';
import {
  BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS,
  BRAKING_GRADE_THRESHOLDS,
  analyzeIntersectionBehavior,
  analyzeParkingApproach,
  brakeOnsetSmoothnessGrade,
  brakingEfficiencyGrade,
  calculateBrakeOnsetSmoothness,
  calculateBrakingEfficiency,
  calculateCorneringConsistency,
  calculateOvertakeQualityScore,
  calculateReactionTimeProxy,
  calculateRoadTypeSegmentedScores,
  calculateSmoothBrakingRatio,
  calculateSpeedLimitCompliance,
  complianceFallbackLimit,
  contextualFallbackLimitKmh,
  detectSlipperyConditionProxy,
  extractBrakingSequences,
  getInferredLimitForPoint,
  hasSustainedLateralG,
  lateralGForTriplet,
  resolveEffectiveSpeedLimitForIndex,
  scoreBrakeOnsetSmoothness,
  setRoadTypeSegmentScorer,
  speedLimitForIndex
} from '../detection/cornering.js';
import {
  analyzeFatigueProgression,
  calculateSegmentStats,
  detectDrowsyDriving,
  detectHeadingDriftBeta,
  scoreFatigueSegment,
  scoreSegmentPoints
} from '../detection/headingDrift.js';
import {
  detectAggressiveOvertakes
} from '../detection/overtakePattern.js';
import {
  attachEventResult,
  detectDrivingEvents,
  detectPhoneProxy,
  detectPhoneUsageProxy,
  detectPhoneUseWindows,
  emptyPhoneUseResult,
  maskDetectedEventsForPrivacy,
  summarizePhoneUseEvents
} from '../detection/harshBraking.js';

type DrivingThresholds = Record<string, unknown>;
type ScoreFields = Record<string, unknown>;
type TimeInput = string | number | Date | null | undefined;
type ScoringContext = Record<string, unknown>;

export function calculateRouteSummary(
  points: RoutePoint[],
  startTime: TimeInput,
  endTime: TimeInput,
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const cleaned = cleanRoutePoints(points, thresholds);
  const stats = calculateTripStats(cleaned, startTime, endTime, thresholds, {
    raw_route_points: points,
  });
  const { events, phoneUse } = detectDrivingEvents(cleaned, thresholds, endTime);
  const scores = calculateTripScores(events, stats, cleaned, thresholds, stats.duration_seconds, phoneUse, { endTime });
  return { points: cleaned, stats, events, scores };
}

export function generatedTripId(prefix = 'trip'): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function splitTripAtStops(
  trip: TripRecord,
  minParkMinutes = 5,
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): TripRecord[] {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (routePoints.length < 2) return [];

  const minStopSeconds = Math.max(0, Number(minParkMinutes) || 0) * 60;
  const stops = detectTripStops(routePoints, {
    minStopSeconds,
    maxSpeedKmh: thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH,
  });
  const sortedPoints = [...routePoints].sort((a, b) => timestampMs(a) - timestampMs(b));

  if (!stops.length) {
    return [{
      ...trip,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: 1,
      route_points: sortedPoints,
    }];
  }

  const splitRanges = [];
  let segmentStartIndex = 0;

  for (const stop of stops) {
    const stopStartMs = new Date(stop.start_time).getTime();
    const stopEndMs = new Date(stop.end_time).getTime();
    const beforeStopEnd = sortedPoints.findIndex((point, index) => index >= segmentStartIndex && timestampMs(point) >= stopStartMs);
    const afterStopStart = sortedPoints.findIndex((point) => timestampMs(point) > stopEndMs);
    const endIndex = beforeStopEnd > segmentStartIndex ? beforeStopEnd - 1 : segmentStartIndex - 1;
    if (endIndex - segmentStartIndex + 1 >= 2) splitRanges.push([segmentStartIndex, endIndex]);
    segmentStartIndex = afterStopStart >= 0 ? afterStopStart : sortedPoints.length;
  }

  if (sortedPoints.length - segmentStartIndex >= 2) {
    splitRanges.push([segmentStartIndex, sortedPoints.length - 1]);
  }

  return splitRanges.map(([startIndex, endIndex], index) => {
    const segmentPoints = sortedPoints.slice(startIndex, endIndex + 1);
    const startTime = segmentPoints[0].timestamp;
    const endTime = segmentPoints[segmentPoints.length - 1].timestamp;
    const stats = calculateTripStats(segmentPoints, startTime, endTime, thresholds);
    const { events, phoneUse } = detectDrivingEvents(segmentPoints, thresholds, endTime);
    const scores = calculateTripScores(events, stats, segmentPoints, thresholds, stats.duration_seconds, phoneUse, { endTime });
    const drivingEvents = scores.driving_events || events;
    const economics = estimateTripEconomics({ ...stats, ...scores });

    return {
      ...stats,
      ...scores,
      co2_saved_kg: economics.co2_saved_kg,
      fuel_cost: economics.cost,
      fuel_used_liters: economics.liters,
      co2_kg: economics.co2_kg,
      fuel_saved_liters: economics.fuel_saved_liters,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: index + 1,
      status: 'completed',
      start_time: startTime,
      end_time: endTime,
      vehicle_id: trip?.vehicle_id ?? null,
      tag: trip?.tag ?? null,
      background_tracking: trip?.background_tracking ?? false,
      start_source: trip?.start_source || 'split',
      route_points: segmentPoints,
      route_points_raw_count: segmentPoints.length,
      driving_events: drivingEvents,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });
}

export function calculateFatigueScore(durationSeconds: number, routePoints: RoutePoint[] = []): ScoreFields {
  const durationMinutes = (durationSeconds || 0) / 60;
  const durationScore = Math.min(5, durationMinutes / 30);
  const points = Array.isArray(routePoints) ? routePoints : [];

  let timeScore = 0;
  if (points.length > 0) {
    const startHour = new Date(points[0].timestamp).getHours();
    if (startHour >= 2 && startHour < 5) timeScore = 5;
    else if (startHour >= 5 && startHour < 7) timeScore = 3;
    else if (startHour >= 13 && startHour < 15) timeScore = 2;
    else if (startHour >= 22 || startHour < 2) timeScore = 3;
    // FIX: Raise the 10pm-2am fatigue bucket to the elevated late-night risk tier.
  }

  const movingSpeeds = points
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed >= 15);
  const meanSpeed = movingSpeeds.length
    ? movingSpeeds.reduce((sum, speed) => sum + speed, 0) / movingSpeeds.length
    : 0;
  const speedCv = movingSpeeds.length >= 5 && meanSpeed > 0
    ? speedStdDev(movingSpeeds) / meanSpeed
    : 0;
  const speedVarianceScore = speedCv >= 0.70 ? 2 : speedCv >= 0.45 ? 1 : 0;

  const riskOnTenPointScale = Math.min(10, durationScore + timeScore + speedVarianceScore);
  return Math.round(riskOnTenPointScale * 10);
}

export function parseClockMinutes(value: unknown, fallbackHour: number): number {
  if (typeof value === 'string') {
    const [hour, minute = '0'] = value.split(':');
    const h = Number(hour);
    const m = Number(minute);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
  }
  return fallbackHour * 60;
}

export function isWithinClockWindow(minutes: number, startMinutes: number, endMinutes: number): boolean {
  const dayMinutes = 24 * 60;
  const normalized = ((minutes % dayMinutes) + dayMinutes) % dayMinutes;
  const start = ((startMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  const end = ((endMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  if (start === end) return false;
  return start < end
    ? normalized >= start && normalized < end
    : normalized >= start || normalized < end;
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000);
}

export function sunEventMinutes(date: Date, lat: number, lng: number, isSunrise: boolean): number {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 89.8) return null;

  const zenith = 90.833;
  const n = dayOfYear(date);
  const lngHour = lng / 15;
  const t = n + (((isSunrise ? 6 : 18) - lngHour) / 24);
  const meanAnomaly = (0.9856 * t) - 3.289;
  let trueLongitude = meanAnomaly
    + (1.916 * Math.sin(toRad(meanAnomaly)))
    + (0.020 * Math.sin(toRad(2 * meanAnomaly)))
    + 282.634;
  trueLongitude = ((trueLongitude % 360) + 360) % 360;

  let rightAscension = Math.atan(0.91764 * Math.tan(toRad(trueLongitude))) * 180 / Math.PI;
  rightAscension = ((rightAscension % 360) + 360) % 360;
  const longitudeQuadrant = Math.floor(trueLongitude / 90) * 90;
  const ascensionQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15;

  const sinDec = 0.39782 * Math.sin(toRad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(toRad(zenith)) - (sinDec * Math.sin(toRad(lat)))) / (cosDec * Math.cos(toRad(lat)));
  if (cosHour > 1 || cosHour < -1) return null;

  const hourAngle = isSunrise
    ? 360 - (Math.acos(cosHour) * 180 / Math.PI)
    : Math.acos(cosHour) * 180 / Math.PI;
  const localMeanTime = (hourAngle / 15) + rightAscension - (0.06571 * t) - 6.622;
  const utcMinutes = ((localMeanTime - lngHour) * 60) % (24 * 60);
  return ((utcMinutes - date.getTimezoneOffset()) % (24 * 60) + (24 * 60)) % (24 * 60);
}

export function createTripNightChecker(
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): (point: RoutePoint) => boolean {
  const fallbackStart = parseClockMinutes(
    thresholds.NIGHT_START_TIME,
    thresholds.NIGHT_START_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_START_HOUR
  );
  const fallbackEnd = parseClockMinutes(
    thresholds.NIGHT_END_TIME,
    thresholds.NIGHT_END_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_END_HOUR
  );

  if (thresholds.NIGHT_DETECTION_MODE !== 'sunset') {
    return (point) => {
      if (!point?.timestamp) return false;
      const date = new Date(point.timestamp);
      if (Number.isNaN(date.getTime())) return false;
      return isWithinClockWindow(date.getHours() * 60 + date.getMinutes(), fallbackStart, fallbackEnd);
    };
  }

  const representativeCoordinatesByDate = new Map();
  for (const point of routePoints || []) {
    if (!point?.timestamp || !hasValidCoordinates(point)) continue;
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDateKey(date);
    if (!representativeCoordinatesByDate.has(key)) {
      representativeCoordinatesByDate.set(key, { lat: Number(point.lat), lng: Number(point.lng) });
    }
  }

  const sunWindowByDate = new Map();
  return (point) => {
    if (!point?.timestamp) return false;
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) return false;

    const minutes = date.getHours() * 60 + date.getMinutes();
    const key = localDateKey(date);
    if (!sunWindowByDate.has(key)) {
      const coords = representativeCoordinatesByDate.get(key) || { lat: Number(point.lat), lng: Number(point.lng) };
      const sunset = sunEventMinutes(date, coords.lat, coords.lng, false);
      const sunrise = sunEventMinutes(date, coords.lat, coords.lng, true);
      sunWindowByDate.set(key, sunset != null && sunrise != null
        ? {
          start: sunset + (thresholds.NIGHT_SUNSET_OFFSET_MINUTES ?? 0),
          end: sunrise + (thresholds.NIGHT_SUNRISE_OFFSET_MINUTES ?? 0),
        }
        : null);
    }

    const sunWindow = sunWindowByDate.get(key);
    return sunWindow
      ? isWithinClockWindow(minutes, sunWindow.start, sunWindow.end)
      : isWithinClockWindow(minutes, fallbackStart, fallbackEnd);
  };
}

export function isNightDrivingTime(
  point: RoutePoint,
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): boolean {
  if (!point?.timestamp) return false;

  const date = new Date(point.timestamp);
  if (Number.isNaN(date.getTime())) return false;

  const minutes = date.getHours() * 60 + date.getMinutes();
  if (thresholds.NIGHT_DETECTION_MODE === 'sunset') {
    const sunset = sunEventMinutes(date, Number(point.lat), Number(point.lng), false);
    const sunrise = sunEventMinutes(date, Number(point.lat), Number(point.lng), true);
    if (sunset != null && sunrise != null) {
      return isWithinClockWindow(
        minutes,
        sunset + (thresholds.NIGHT_SUNSET_OFFSET_MINUTES ?? 0),
        sunrise + (thresholds.NIGHT_SUNRISE_OFFSET_MINUTES ?? 0)
      );
    }
  }

  return isWithinClockWindow(
    minutes,
    parseClockMinutes(thresholds.NIGHT_START_TIME, thresholds.NIGHT_START_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_START_HOUR),
    parseClockMinutes(thresholds.NIGHT_END_TIME, thresholds.NIGHT_END_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_END_HOUR)
  );
}

export function calculateNightPenalty(
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  if (!routePoints || routePoints.length === 0) return 0;

  const isNightForTrip = createTripNightChecker(routePoints, thresholds);
  let nightPoints = 0;
  let deepNightPoints = 0;
  for (const point of routePoints) {
    const hour = new Date(point.timestamp).getHours();
    if (isNightForTrip(point)) nightPoints++;
    if (hour >= 2 && hour < 5) deepNightPoints++;
  }

  const n = routePoints.length;
  const normalNightPoints = nightPoints - deepNightPoints;
  // FIX: Deep-night points are a subset of night points, so separate them before weighting.
  return (normalNightPoints / n) * 8 + (deepNightPoints / n) * 12;
  // FIX: Give deep-night points an exclusive higher weight instead of double-counting them.
}

// ─── Trip Statistics ───────────────────────────────────────────────────────────
/**
 * Calculate aggregate trip statistics from route points.
 *
 * @param {Array} points - GPS route points
 * @param {string} startTime - ISO timestamp
 * @param {string} endTime - ISO timestamp
 * @returns {Object} Trip statistics
 */
export function permissionLossEventTimesMs(context: ScoringContext = {}): number[] {
  const timeline = Array.isArray(context?.native_tracking_timeline)
    ? context.native_tracking_timeline
    : Array.isArray(context?.timeline)
      ? context.timeline
      : [];
  return timeline
    .filter((event) => event?.type === 'location_permission_lost')
    .map((event) => timestampMs(event))
    .filter(Number.isFinite);
}

export function gapContainsPermissionLoss(
  startPoint: RoutePoint,
  endPoint: RoutePoint,
  permissionLossTimes: number[] = []
): boolean {
  if (!permissionLossTimes.length) return false;
  const startMs = timestampMs(startPoint);
  const endMs = timestampMs(endPoint);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return permissionLossTimes.some((eventMs) => eventMs >= startMs && eventMs <= endMs);
}

export function intersectionScoringPoints(points: RoutePoint[] = [], context: ScoringContext = {}): RoutePoint[] {
  const candidates = [
    context?.intersection_scoring_points,
    context?.raw_route_points,
    context?.rawPoints,
    context?.route_points_raw,
  ];
  return candidates.find((candidate) => Array.isArray(candidate) && candidate.length) || points || [];
}

export function sanitizePrivateIntersectionStats(stats: ScoreFields = {}, removeCoordinates = false): ScoreFields {
  if (!removeCoordinates || !Array.isArray(stats.intersection_events)) return stats;
  return {
    ...stats,
    intersection_events: stats.intersection_events.map(({ lat, lng, ...event }) => ({
      ...event,
      coordinates_private: true,
    })),
  };
}

export function canUseSimpleLongRouteStats(points: RoutePoint[] = []): boolean {
  if (!Array.isArray(points) || points.length < 1500) return false;
  let firstSpeed = null;
  for (const point of points) {
    if (!hasValidCoordinates(point)) return false;
    if (
      point.privacy_boundary ||
      point.is_privacy_boundary ||
      point.intersection ||
      point.near_intersection ||
      point.ramp ||
      point.speed_limit_kmh != null ||
      point.altitude != null ||
      point.altitude_m != null
    ) return false;
    const speed = pointSpeedKmh(point);
    if (!Number.isFinite(speed)) return false;
    if (firstSpeed == null) firstSpeed = speed;
    if (Math.abs(speed - firstSpeed) > 0.5) return false;
  }
  return true;
}

export function calculateSimpleLongRouteStats(
  points: RoutePoint[] = [],
  startTime: TimeInput,
  endTime: TimeInput,
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): TripStats {
  let totalDistance = 0;
  let maxSpeed = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += haversineDistance(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    maxSpeed = Math.max(maxSpeed, pointSpeedKmh(points[i], thresholds) ?? 0);
  }
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const durationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  const avgSpeed = durationSeconds > 0 && totalDistance > 0 ? calculateSpeedKmh(totalDistance, durationSeconds) : 0;
  const roadType = maxSpeed >= 80 ? 'highway' : maxSpeed < 45 ? 'residential' : 'urban';
  const zone = zoneFromP85(maxSpeed);
  const nightChecker = createTripNightChecker(points, thresholds);
  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    estimated_private_distance_km: 0,
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    avg_running_speed_kmh: Math.round(avgSpeed * 10) / 10,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: 0,
    traffic_idle_seconds: 0,
    sustained_idle_seconds: 0,
    gap_seconds: 0,
    wall_clock_duration_seconds: Math.round(durationSeconds),
    duration_seconds: Math.round(durationSeconds),
    night_driving: points.some((point) => nightChecker(point)),
    fatigue_risk_score: calculateFatigueScore(durationSeconds, points),
    fatigue_risk_score_confidence: componentConfidence(
      totalDistance,
      METRIC_REGISTRY.fatigue_risk_score.minDistanceKm,
      points.length,
      METRIC_REGISTRY.fatigue_risk_score.minSamples
    ),
    road_type: roadType,
    dominant_road_type: roadType,
    highway_fraction: roadType === 'highway' ? 1 : 0,
    urban_fraction: roadType === 'urban' ? 1 : 0,
    residential_fraction: roadType === 'residential' ? 1 : 0,
    speed_zones: [{
      startIndex: 0,
      endIndex: points.length - 1,
      inferredZone: zone.inferredZone,
      inferredZoneKmh: zone.inferredZoneKmh,
      confidence: 'high',
      road_type: roadType,
      p85SpeedKmh: Math.round(maxSpeed),
      highway_fraction: roadType === 'highway' ? 1 : 0,
      limitSource: 'inferred',
      speedLimitSource: 'inferred',
    }],
    intersection_score: null,
    intersection_events: [],
    fatigue_progression: 'unknown',
    segment_scores: [],
    climb_distance_km: null,
    descent_distance_km: null,
    hill_infraction_count: 0,
    hill_infraction_rate_per_km: 0,
    hill_driving_score: null,
    hill_route: false,
    heading_drift_beta_window_count: 0,
    heading_drift_beta_weighted_contribution: 0,
    heading_drift_beta_score: null,
    heading_drift_beta_level: 'none',
    heading_drift_beta_confidence: 'insufficient_data',
    parking_approach_score: null,
    parking_approach_grade: 'insufficient_data',
    parking_stop_detected: false,
    parking_stop_duration_seconds: 0,
  };
}

export function calculateTripStats(
  points: RoutePoint[],
  startTime: TimeInput,
  endTime: TimeInput,
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds,
  context: ScoringContext = {}
): TripStats {
  if (!context?.raw_route_points && canUseSimpleLongRouteStats(points)) {
    return calculateSimpleLongRouteStats(points, startTime, endTime, thresholds);
  }
  const routePoints = (points || []).filter(hasValidCoordinates);
  const intersectionPoints = intersectionScoringPoints(points, context);
  const intersectionUsesAlternatePoints = intersectionPoints !== points;
  const intersectionStats = sanitizePrivateIntersectionStats(
    analyzeIntersectionBehavior(intersectionPoints, thresholds),
    intersectionUsesAlternatePoints
  );
  const estimatedPrivateDistanceKm = calculateEstimatedPrivateDistanceKm(points || []);
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const wallClockDurationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  const permissionLossTimes = permissionLossEventTimesMs(context);

  if (!routePoints || routePoints.length < 2) {
    const roadStats = classifyRoadType(routePoints || []);
    return {
      distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
      estimated_private_distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
      avg_speed_kmh: 0,
      avg_running_speed_kmh: 0,
      max_speed_kmh: 0,
      idle_time_seconds: 0,
      traffic_idle_seconds: 0,
      // FIX: Return explicit traffic idle even for short/empty trips so stats stay shape-compatible.
      sustained_idle_seconds: 0,
      // FIX: Return explicit sustained idle for eco scoring fallback compatibility.
      gap_seconds: 0,
      // FIX: Expose noise-filtered gap time without mixing it into moving or idle totals.
      wall_clock_duration_seconds: Math.round(wallClockDurationSeconds),
      duration_seconds: Math.round(wallClockDurationSeconds),
      night_driving: false,
      fatigue_risk_score: calculateFatigueScore(wallClockDurationSeconds, routePoints || []),
      fatigue_risk_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      ...roadStats,
      ...intersectionStats,
      fatigue_progression: 'unknown',
      segment_scores: [],
      speed_zones: [],
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
      hill_route: false,
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
      parking_approach_score: null,
      parking_approach_grade: 'insufficient_data',
      parking_stop_detected: false,
      parking_stop_duration_seconds: 0,
    };
  }

  let totalDistance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  let trafficIdleSeconds = 0;
  // FIX: Track short sub-5 km/h traffic stops separately from avoidable parked idle.
  let sustainedIdleSeconds = 0;
  // FIX: Track sustained sub-5 km/h idle for eco scoring instead of penalizing all idle.
  let gapSeconds = 0;
  // FIX: Track noise-filtered time excluded from moving and idle buckets.
  let permissionLossGapDetected = false;
  let idleRunStart = null;
  let idleRunDuration = 0;

  const flushIdleRun = () => {
    if (idleRunDuration <= 0) return;
    const parkedIdleSeconds = Math.max(300, thresholds.IDLE_EVENT_SECONDS ?? DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS);
    if (idleRunDuration >= parkedIdleSeconds) {
      sustainedIdleSeconds += idleRunDuration;
    } else {
      trafficIdleSeconds += idleRunDuration;
    }
    idleRunStart = null;
    idleRunDuration = 0;
  };
  // FIX: Classify each contiguous sub-5 km/h run once it ends or the trip ends.

  for (let i = 1; i < routePoints.length; i++) {
    const p = routePoints[i - 1];
    const c = routePoints[i];
    const rawDistance = haversineDistance(p.lat, p.lng, c.lat, c.lng);
    if (Number.isFinite(rawDistance)) totalDistance += rawDistance;

    const rawSpeed = Number(c.speed_kmh) || 0;
    if (rawSpeed > maxSpeed) maxSpeed = rawSpeed;

    const segment = calculateSegmentMetrics(p, c, thresholds);
    if (segment.dt <= 0) {
      flushIdleRun();
      continue;
    }
    if (segment.dt > 60 && gapContainsPermissionLoss(p, c, permissionLossTimes)) {
      permissionLossGapDetected = true;
    }
    if (segment.dt > 120) {
      const privateBoundarySegment = isPrivacyBoundaryPoint(p) &&
        isPrivacyBoundaryPoint(c) &&
        samePrivacyZoneBoundary(p, c);
      if (!privateBoundarySegment) {
        gapSeconds += segment.dt;
        flushIdleRun();
        continue;
      }
    }
    if (segment.isNoise) {
      flushIdleRun();
      continue;
    }

    const currPointSpeed = reliablePointSpeed(routePoints, i, thresholds);
    const currRawSpeed = pointSpeedKmh(routePoints[i], thresholds);
    const spd = currPointSpeed ?? (currRawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh);
    if (spd >= thresholds.STATIONARY_SPEED_KMH) {
      movingSeconds += segment.dt;
      flushIdleRun();
    }

    if (spd < thresholds.IDLE_SPEED_KMH) {
      if (!idleRunStart) idleRunStart = p.timestamp;
      idleRunDuration += segment.dt;
    }
  }

  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(routePoints, endTime, thresholds);
  if (terminalStoppedSeconds > 0) {
    if (!idleRunStart) idleRunStart = routePoints[routePoints.length - 1].timestamp;
    idleRunDuration += terminalStoppedSeconds;
  }

  flushIdleRun();

  totalDistance = Math.max(totalDistance, calculateRouteDistanceKm(points || [], thresholds));
  const idleTime = trafficIdleSeconds + sustainedIdleSeconds;
  // FIX: Keep legacy idle_time_seconds as the sum of traffic and sustained idle buckets.
  const effectiveMovingSeconds = movingSeconds;
  const durationSeconds = Math.max(0, wallClockDurationSeconds - gapSeconds);
  // Exclude background/noise-filtered tracking gaps from driving time and duration-based scoring.
  const dataGapDetected = permissionLossGapDetected && gapSeconds > 60;
  const isNightForTrip = createTripNightChecker(routePoints, thresholds);
  const nightDriving = routePoints.some(p => isNightForTrip(p));
  const avgSpeed = durationSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, durationSeconds)
    : 0;
  const avgRunningSpeed = effectiveMovingSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, effectiveMovingSeconds)
    : 0;
  const roadStats = classifyRoadType(routePoints);
  const speedZones = inferSpeedZones(routePoints, thresholds);
  const fatigueProgression = durationSeconds > 1800
    ? analyzeFatigueProgression(routePoints, start.getTime(), end.getTime(), thresholds)
    : { fatigue_progression: 'unknown', segment_scores: [] };
  const hillStats = calculateHillDrivingScore(routePoints, thresholds);
  const headingDriftStats = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED === false
    ? {
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
    }
    : detectHeadingDriftBeta(routePoints, durationSeconds, thresholds);
  const parkingStats = analyzeParkingApproach(routePoints, thresholds, endTime);

  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    estimated_private_distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    avg_running_speed_kmh: Math.round(avgRunningSpeed * 10) / 10,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: Math.round(idleTime),
    traffic_idle_seconds: Math.round(trafficIdleSeconds),
    // FIX: Return sub-90-second traffic idle separately for reporting/debugging.
    sustained_idle_seconds: Math.round(sustainedIdleSeconds),
    // Tracking gaps longer than two minutes are excluded from effective drive time.
    gap_seconds: Math.round(gapSeconds),
    wall_clock_duration_seconds: Math.round(wallClockDurationSeconds),
    duration_seconds: Math.round(durationSeconds),
    ...(dataGapDetected ? { score_confidence_flag: 'data_gap_detected' } : {}),
    night_driving: nightDriving,
    fatigue_risk_score: calculateFatigueScore(durationSeconds, routePoints),
    fatigue_risk_score_confidence: componentConfidence(
      totalDistance,
      METRIC_REGISTRY.fatigue_risk_score.minDistanceKm,
      routePoints.length,
      METRIC_REGISTRY.fatigue_risk_score.minSamples
    ),
    ...roadStats,
    speed_zones: speedZones,
    ...intersectionStats,
    ...fatigueProgression,
    ...hillStats,
    ...headingDriftStats,
    ...parkingStats,
  };
}

// ─── Scoring Engine ────────────────────────────────────────────────────────────
/**
 * Calculate trip scores from events and statistics.
 *
 * Scoring methodology:
 * - Start with 100 points
 * - Deduct for each risky event (severity-weighted)
 * - Apply bonuses for clean driving
 * - Sub-scores: Safety, Smoothness, Eco
 * - Overall = weighted average of sub-scores
 *
 * Safety (40%):    based on harsh brakes, speeding, sharp turns
 * Smoothness (35%): based on rapid accel, harsh brakes, turn smoothness
 * Eco (25%):        based on speeding, rapid accel, idle time
 *
 * @param {Array} events - Detected driving events
 * @param {Object} stats - Trip statistics (distance, duration, etc.)
 * @returns {Object} { overall, safety, smoothness, eco }
 */
export function calculateEngineStressScore(
  events: DrivingEvent[] = [],
  stats: TripStats = {},
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const basePenalty = { low: 2, medium: 5, high: 10 };
  const speedMultiplier = (speedKmh: number): number => (
    speedKmh >= 100 ? 3.0 : speedKmh >= 70 ? 2.0 : speedKmh >= 40 ? 1.3 : 1.0
  );
  let engineStressRaw = 0;
  let highSpeedAccelCount = 0;
  const obdEco = calculateObdEcoSignals(routePoints, thresholds);

  for (const event of events) {
    if (event.type !== EVENT_TYPES.RAPID_ACCELERATION) continue;
    const speed = Number(event.speed_kmh) || 0;
    engineStressRaw += (basePenalty[event.severity] || 0) * speedMultiplier(speed);
    if (speed >= 70) highSpeedAccelCount++;
  }
  engineStressRaw += (obdEco.obd_over_rev_count || 0) * 3;
  engineStressRaw += (obdEco.obd_high_throttle_count || 0) * 2;

  const distFactor = Math.max(1, stats.distance_km || 1);
  const score = Math.max(0, Math.round(100 - Math.min(engineStressRaw * (5 / distFactor), 100)));
  return {
    engine_stress_score: score,
    engine_stress_grade: score >= 90 ? 'low stress' : score >= 70 ? 'moderate' : score >= 50 ? 'high' : 'critical',
    high_speed_accel_count: highSpeedAccelCount,
  };
}

export function calculateTireWearUnits(events: DrivingEvent[] = []): ScoreFields {
  const severityBase = { low: 1, medium: 2.5, high: 5 };
  let units = 0;
  let missingSpeedEventCount = 0;
  const speedFactor = (event: DrivingEvent, referenceSpeed: number): number => {
    const speed = Number(event.speed_kmh);
    if (event.speed_kmh == null || event.speed_kmh === '' || !Number.isFinite(speed) || speed < 0) {
      missingSpeedEventCount++;
      return 1;
    }
    return (speed / referenceSpeed) ** 2;
  };
  for (const event of events) {
    if (event.type === EVENT_TYPES.HARSH_BRAKE) {
      units += (severityBase[event.severity] || 0) * speedFactor(event, TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH);
    }
    if (event.type === EVENT_TYPES.SHARP_TURN) {
      units += (severityBase[event.severity] || 0) * speedFactor(event, TIRE_WEAR_DEFAULT_SPEED_TURN_KMH);
    }
  }
  return {
    trip_tire_wear_units: round1(units),
    trip_tire_wear_has_missing_speed_data: missingSpeedEventCount > 0,
    trip_tire_wear_missing_speed_event_count: missingSpeedEventCount,
  };
}

export function calculateAggressiveDrivingScore(events: DrivingEvent[] = [], stats: TripStats = {}): number {
  const aggressiveEventTypes = new Set([
    EVENT_TYPES.HARSH_BRAKE,
    EVENT_TYPES.RAPID_ACCELERATION,
    EVENT_TYPES.SHARP_TURN,
    EVENT_TYPES.SPEEDING,
  ]);
  const rawPenalty = events.reduce((sum, event) => (
    aggressiveEventTypes.has(event.type)
      ? sum + (EVENT_PENALTIES[event.type]?.[event.severity] || 0)
      : sum
  ), 0);
  const avgJerkMs3 = stats.avg_jerk_ms3 ?? 0;
  const jerkPenalty = Math.min(Math.max((avgJerkMs3 - 0.3) * 20, 0), 25);
  const combinedPenalty = rawPenalty + jerkPenalty;
  const distFactor = Math.max(1, stats.distance_km || 1);
  const normalizedPenalty = Math.min(combinedPenalty * (5 / distFactor), 100);
  const score = Math.max(0, Math.round(100 - normalizedPenalty));
  return {
    aggressive_driving_score: score,
    aggressive_grade: score >= 90 ? 'calm' : score >= 75 ? 'moderate' : score >= 55 ? 'assertive' : 'aggressive',
    aggression_penalty_raw: rawPenalty,
  };
}

export function calculateDefensiveDrivingScore(scores: ScoreFields = {}): number | null {
  const blend = scoringValue('DEFENSIVE_SCORE_BLEND_WEIGHTS');
  const stopStartSampleCount = Number(
    scores.stop_start_pattern_sample_count ?? scores.stop_start_pattern_count ?? 0
  );
  const urbanStopStartCount = Number(scores.stop_start_pattern_urban_count ?? 0);
  const highwayStopStartCount = Number(scores.stop_start_pattern_highway_count ?? 0);
  const hasContextualStopStartEvidence =
    urbanStopStartCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN ||
    highwayStopStartCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY;
  const hasLegacyStopStartEvidence =
    urbanStopStartCount === 0 &&
    highwayStopStartCount === 0 &&
    stopStartSampleCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT;
  const stopStartPatternScoreForBlend = hasContextualStopStartEvidence || hasLegacyStopStartEvidence
    ? scores.stop_start_pattern_score
    : null;
  const defensiveScore = weightedBlend([
    { score: (scores.total_stops_detected || 0) > 0 ? scores.smooth_braking_ratio : null, weight: blend.smoothBraking },
    { score: scores.intersection_score, weight: blend.intersection },
    { score: scores.svi_score, weight: blend.speedVariability },
    { score: stopStartPatternScoreForBlend, weight: blend.stopStart },
  ]);
  return {
    defensive_driving_score: defensiveScore,
    defensive_grade: defensiveScore == null ? 'unavailable' : defensiveScore >= 90 ? 'exemplary' : defensiveScore >= 75 ? 'defensive' : defensiveScore >= 55 ? 'average' : 'reactive',
  };
}

export function stopStartScoreForContext(patternCount: number, distanceKm: number, minDistanceKm: number): number | null {
  if (distanceKm < minDistanceKm) return null;
  const maxObservedPatternCycles = (distanceKm / STOP_START_NORMALISATION_WINDOW_KM) * STOP_START_MAX_CYCLES_PER_5_KM;
  return Math.round(100 - clamp((patternCount / Math.max(1, maxObservedPatternCycles)) * 100, 0, 100));
}

export function highwayEvidenceDistanceKm(
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): number {
  return stopStartEvidenceDistances(routePoints, thresholds).highwayDistanceKm;
}

export function stopStartEvidenceDistances(
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const points = routePoints || [];
  if (points.length < 2) {
    return {
      highwayDistanceKm: 0,
      urbanDistanceKm: 0,
      medianMovingSpeedKmh: 0,
    };
  }
  const roadTypes = classifyRoadTypesByPoint(points);
  let highwayDistanceKm = 0;
  let urbanDistanceKm = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt <= 0 || segment.isNoise) continue;
    const distanceKm = segment.distanceM / 1000;
    if (roadTypes[i] === 'highway' || roadTypes[i - 1] === 'highway') {
      highwayDistanceKm += distanceKm;
    } else {
      urbanDistanceKm += distanceKm;
    }
  }
  return {
    highwayDistanceKm,
    urbanDistanceKm,
    medianMovingSpeedKmh: medianMovingSpeedKmh(points),
  };
}

export function calculateTripScores(
  events: DrivingEvent[] | { events?: DrivingEvent[]; phoneUse?: ScoreFields },
  stats: TripStats,
  routePoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds,
  durationSeconds = Number(stats?.duration_seconds) || 0,
  phoneUseOrOptions: ScoreFields = {},
  maybeOptions: ScoringContext = {}
): ScoreFields & { component_scores?: ComponentScores; score_provenance?: ScoreProvenance } {
  setRoadTypeSegmentScorer(calculateTripScores);
  const phoneUseFromEvents = events?.phoneUse || {};
  const options = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseOrOptions
    : maybeOptions;
  const privacyZones = Array.isArray(options?.privacyZones) ? options.privacyZones : [];
  const motionSamples = Array.isArray(options?.motionSamples) ? options.motionSamples : [];
  const orientationCalibration = options?.orientationCalibration || options?.phoneOrientation || null;
  const eventsListRaw = Array.isArray(events) ? events : events?.events || [];
  const eventsList = privacyZones.length
    ? eventsListRaw.map((event) => maskEventCoordinatesForPrivacy(event, privacyZones))
    : eventsListRaw;
  const serializableEventList = eventsList.filter((event) => event?.masked_for_privacy !== true);
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const diagnosticScoringOptions = { advancedSafetyEnabled };
  const scoringEvents = serializableEventList.filter((event) => !isDiagnosticOnlyScoringEvent(event, diagnosticScoringOptions));
  if (scoringEvents.some((event) => isDiagnosticOnlyScoringEvent(event, diagnosticScoringOptions))) {
    throw new Error('Diagnostic-only driving events must not be included in score penalties.');
  }
  const serializableEvents = serializableEventList
    .filter((event) => !(event?.type === EVENT_TYPES.PHONE_USE && (event.source === 'gps_proxy' || event.diagnostic_only === true)))
    .map((event) => ({ ...event }));
  const phoneUse = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseFromEvents
    : { ...phoneUseFromEvents, ...(phoneUseOrOptions || {}) };
  // Count events
  const counts = {
    [EVENT_TYPES.HARSH_BRAKE]: 0,
    [EVENT_TYPES.RAPID_ACCELERATION]: 0,
    [EVENT_TYPES.SHARP_TURN]: 0,
    [EVENT_TYPES.SPEEDING]: 0,
    [EVENT_TYPES.IDLE]: 0,
    [EVENT_TYPES.HEADING_DEVIATION]: 0,
    [EVENT_TYPES.HEADING_DEVIATION_LEGACY]: 0,
    [EVENT_TYPES.STOP_START_PATTERN]: 0,
    [EVENT_TYPES.TAILGATE_CYCLE]: 0,
    [EVENT_TYPES.ERRATIC_SPEED]: 0,
    [EVENT_TYPES.NEAR_MISS]: 0,
    [EVENT_TYPES.CLOSE_PROXIMITY]: 0,
    [EVENT_TYPES.AGGRESSIVE_OVERTAKE]: 0,
    [EVENT_TYPES.PHONE_USE]: 0,
  };
  let safetyPenalty = 0;
  let smoothnessPenalty = 0;
  let ecoPenalty = 0;
  let distractionPenalty = 0;

  for (const evt of serializableEventList) {
    if (counts[evt.type] !== undefined) counts[evt.type]++;
  }

  for (const evt of scoringEvents) {
    let p = EVENT_PENALTIES[evt.type]?.[evt.severity] ?? 0;
    if (
      [EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.SHARP_TURN].includes(evt.type) &&
      evt.speed_kmh != null
    ) {
      const speedFactor = 1 + Math.max(0, Math.min(1.5, (evt.speed_kmh - 30) / 60));
      p *= speedFactor;
    }
    if (evt.type === EVENT_TYPES.SPEEDING && (evt.speed_limit_source == null || evt.speed_limit_source === 'inferred')) {
      p *= 0.5;
    }
    // Safety uses scored driving evidence only; GPS-only advisory patterns stay diagnostic.
    if ([
      EVENT_TYPES.HARSH_BRAKE,
      EVENT_TYPES.SPEEDING,
      EVENT_TYPES.SHARP_TURN,
      EVENT_TYPES.ERRATIC_SPEED,
      EVENT_TYPES.PHONE_USE,
    ].includes(evt.type)) safetyPenalty += p;
    // Smoothness: deducts from harsh_brake, rapid_acceleration, sharp_turn
    if ([EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.SHARP_TURN].includes(evt.type)) smoothnessPenalty += p;
    // Eco: deducts from speeding, rapid_acceleration, idle
    if ([EVENT_TYPES.SPEEDING, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.IDLE].includes(evt.type)) ecoPenalty += p;
    if ([EVENT_TYPES.ERRATIC_SPEED, EVENT_TYPES.PHONE_USE].includes(evt.type)) distractionPenalty += p;
  }

  const speedCreep = advancedSafetyEnabled
    ? detectSpeedCreepWithThresholds(routePoints, thresholds)
    : {
      speed_creep_event_count: 0,
      max_speed_creep_kmh: 0,
      speed_creep_score: null,
      speed_creep_severity_counts: { low: 0, medium: 0, high: 0 },
    };
  const phoneUseResult = {
    ...emptyPhoneUseResult(),
    ...(advancedSafetyEnabled ? phoneUse : {}),
  };
  const confirmedPhoneScoreAvailable = (
    phoneUseResult.phone_use_score_available !== false &&
    Number.isFinite(Number(phoneUseResult.phone_use_score))
  );
  const diagnosticOvertakeCount = serializableEventList.filter((event) => event.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE).length;
  const proxyEvents = phoneUseResult.phone_proxy_events || (
    confirmedPhoneScoreAvailable
      ? []
      : phoneUseResult.phone_use_events || []
  );
  const phoneProxy = {
    phone_proxy_count: phoneUseResult.phone_proxy_count ?? proxyEvents.length,
    phone_proxy_risk: phoneUseResult.phone_proxy_risk || 'none',
  };
  const speedCreepPenalties = scoringValue('SPEED_CREEP_ECO_PENALTY_POINTS');
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.low || 0) * speedCreepPenalties.low;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.medium || 0) * speedCreepPenalties.medium;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.high || 0) * speedCreepPenalties.high;
  safetyPenalty += calculateNightPenalty(routePoints, thresholds);
  const fatiguePenalty = clamp(
    (Number(stats.fatigue_risk_score) || 0) * FATIGUE_SAFETY_PENALTY_SCALE,
    0,
    FATIGUE_SAFETY_MAX_PENALTY
  );

  const distKm = Math.max(1, stats.distance_km || 1);
  const phoneUseScoreDeduction = confirmedPhoneScoreAvailable
    ? Math.max(0, Math.min(100, 100 - Number(phoneUseResult.phone_use_score)))
    : null;
  const phoneUseRiskDeduction = scoringValue('PHONE_USE_RISK_DEDUCTION_POINTS')[phoneUseResult.phone_use_risk] ?? 0;
  const phoneUsePctDeduction = Math.max(0, Math.min(70, (phoneUseResult.phone_use_pct_of_trip || 0) * 0.5));
  const phoneUseDeduction = confirmedPhoneScoreAvailable
    ? Math.max(phoneUseScoreDeduction, phoneUseRiskDeduction, phoneUsePctDeduction)
    : 0;
  const SCORE_FLOOR = 0;
  const MAX_DEDUCTION = 100;
  const normalize = (totalPenalty: number): number => {
    const penaltyRate = totalPenalty / distKm;
    const deduction = Math.min(penaltyRate * PENALTY_SCALE_FACTOR, MAX_DEDUCTION);
    return Math.max(SCORE_FLOOR, Math.round(100 - deduction));
  };

  const baseSafety = Math.round(normalize(safetyPenalty));
  const baseSmoothness = Math.round(normalize(smoothnessPenalty));
  const baseEco = Math.round(normalize(ecoPenalty));
  const jerk = calculateJerkScore(routePoints, stats.distance_km || distKm);
  const ecoDriving = calculateEcoDrivingScore(routePoints, stats, thresholds);
  const svi = calculateSpeedVariabilityIndex(routePoints, thresholds);
  const fuelBand = calculateFuelBandScore(routePoints, thresholds);
  const merge = detectHighwayMergeBehavior(routePoints, thresholds);
  const smoothBraking = calculateSmoothBrakingRatio(routePoints, thresholds);
  const engineStress = calculateEngineStressScore(scoringEvents, stats, routePoints, thresholds);
  const tireWear = calculateTireWearUnits(scoringEvents);
  const statsHeadingDriftAvailable = stats && Object.prototype.hasOwnProperty.call(stats, 'heading_drift_beta_score');
  const headingDrift = advancedSafetyEnabled
    ? statsHeadingDriftAvailable
      ? {
        heading_drift_beta_window_count: stats.heading_drift_beta_window_count ?? 0,
        heading_drift_beta_weighted_contribution: stats.heading_drift_beta_weighted_contribution ?? 0,
        heading_drift_beta_score: stats.heading_drift_beta_score,
        heading_drift_beta_level: stats.heading_drift_beta_level ?? 'none',
        heading_drift_beta_confidence: stats.heading_drift_beta_confidence ?? 'insufficient_data',
      }
      : detectHeadingDriftBeta(routePoints, durationSeconds, thresholds)
    : {
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
    };
  const statsHillAvailable = stats && Object.prototype.hasOwnProperty.call(stats, 'hill_driving_score');
  const hill = statsHillAvailable
    ? {
      climb_distance_km: stats.climb_distance_km ?? null,
      descent_distance_km: stats.descent_distance_km ?? null,
      hill_infraction_count: stats.hill_infraction_count ?? 0,
      hill_infraction_rate_per_km: stats.hill_infraction_rate_per_km ?? 0,
      hill_driving_score: stats.hill_driving_score,
      hill_route: stats.hill_route ?? false,
    }
    : calculateHillDrivingScore(routePoints, thresholds);
  const statsParkingAvailable = stats && Object.prototype.hasOwnProperty.call(stats, 'parking_approach_score');
  const parking = statsParkingAvailable
    ? {
      parking_approach_score: stats.parking_approach_score,
      parking_approach_grade: stats.parking_approach_grade ?? 'insufficient_data',
      parking_stop_detected: stats.parking_stop_detected ?? false,
      parking_stop_duration_seconds: stats.parking_stop_duration_seconds ?? 0,
    }
    : analyzeParkingApproach(routePoints, thresholds, options.endTime ?? null);
  const closeProximityCount = counts[EVENT_TYPES.CLOSE_PROXIMITY];
  const closeProximityScore = closeProximityCount === 0
    ? null
    : Math.max(0, Math.round(100 * Math.pow(CLOSE_PROXIMITY_DECAY_BASE, closeProximityCount)));
  const aggressive = calculateAggressiveDrivingScore(scoringEvents, { ...stats, ...jerk });
  const tripDistanceKm = Number(stats.distance_km) || 0;
  const stopStartEvidence = stopStartEvidenceDistances(routePoints, thresholds);
  const highwayDistanceKm = stopStartEvidence.highwayDistanceKm;
  const urbanStopStartDistanceKm = stopStartEvidence.urbanDistanceKm;
  const urbanStopStartEligible = stopStartEvidence.medianMovingSpeedKmh > 0 && stopStartEvidence.medianMovingSpeedKmh < 50;
  const stopStartPatternCount = counts[EVENT_TYPES.STOP_START_PATTERN] + counts[EVENT_TYPES.TAILGATE_CYCLE];
  const highwayStopStartPatternCount = scoringEvents.filter((event) => (
    event?.type === EVENT_TYPES.TAILGATE_CYCLE ||
    (event?.type === EVENT_TYPES.STOP_START_PATTERN && event.stop_start_context !== 'urban')
  )).length;
  const urbanStopStartPatternCount = scoringEvents.filter((event) => (
    event?.type === EVENT_TYPES.STOP_START_PATTERN && event.stop_start_context === 'urban'
  )).length;
  const highwayStopStartPatternScore = stopStartScoreForContext(highwayStopStartPatternCount, highwayDistanceKm, STOP_START_MIN_HIGHWAY_DISTANCE_KM);
  const urbanStopStartPatternScore = urbanStopStartEligible
    ? stopStartScoreForContext(urbanStopStartPatternCount, urbanStopStartDistanceKm, STOP_START_MIN_URBAN_DISTANCE_KM)
    : null;
  const stopStartPatternScore = weightedBlend([
    { score: highwayStopStartPatternScore, weight: highwayDistanceKm },
    { score: urbanStopStartPatternScore, weight: urbanStopStartDistanceKm },
  ]);
  const distractionDeductionCap = thresholds.DISTRACTION_DEDUCTION_CAP ?? 70;
  const gpsDistractionDeduction = distractionPenalty * (3 / distKm);
  const distractionDeduction = confirmedPhoneScoreAvailable
    ? phoneUseDeduction
    : gpsDistractionDeduction;
  const distractionScore = Math.max(0, 100 - Math.min(distractionDeduction, distractionDeductionCap));
  const brakeOnset = calculateBrakeOnsetSmoothness(routePoints, scoringEvents, thresholds);
  const cornering = calculateCorneringConsistency(routePoints, thresholds);
  const brakingEfficiency = calculateBrakingEfficiency(routePoints, scoringEvents, thresholds);
  const compliance = calculateSpeedLimitCompliance(routePoints, stats, thresholds);
  const laneChangeScoreEnabled = thresholds.LANE_CHANGE_SCORE_ENABLED !== false;
  const laneChangeResult = options?.laneChangeResult || (
    advancedSafetyEnabled
      ? detectLaneChanges(routePoints, motionSamples, orientationCalibration, thresholds)
      : {
        lane_changes: [],
        lane_change_count: 0,
        unsafe_lane_changes: 0,
        confidence: 'unavailable',
        detection_method: 'disabled',
      }
  );
  const laneChanging = calculateLaneChangingScore(laneChangeResult, tripDistanceKm, thresholds);
  const laneChangingScoreValue = laneChangeScoreEnabled ? laneChanging.lane_changing_score : null;
  const overtakeQuality = calculateOvertakeQualityScore(routePoints, serializableEventList, thresholds);
  const slippery = detectSlipperyConditionProxy(routePoints, scoringEvents, thresholds);
  const routeSampleCount = routePoints.length;
  const altitudeSampleCount = routePoints.filter((point) => (
    Number.isFinite(Number(point?.altitude ?? point?.altitude_m))
  )).length;
  const evidenceFor = (componentKey: string, sampleCount: number, value: unknown, distanceKm = tripDistanceKm) => (
    registeredComponentConfidence(componentKey, distanceKm, sampleCount, value)
  );

  const brakingEvidence = evidenceFor('braking_efficiency', brakingEfficiency.braking_sequence_count, brakingEfficiency.braking_efficiency_score);
  const brakeOnsetEvidence = evidenceFor('brake_onset_smoothness', brakeOnset.brake_onset_sequence_count, brakeOnset.brake_onset_smoothness_score);
  const corneringEvidence = evidenceFor('cornering_consistency', cornering.corner_sample_count, cornering.cornering_consistency_score);
  const brakingScoreForSafety = brakingEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : brakingEfficiency.braking_efficiency_score;
  const complianceScoreForSafety = compliance.overall_compliance_score;
  const laneChangingScoreForSafety = laneChangingScoreValue;
  const phoneUseScoreForSafety = thresholds.PHONE_USE_AFFECTS_SCORE === false || !confirmedPhoneScoreAvailable
    ? null
    : phoneUseResult.phone_use_score;
  const jerkScoreForSmoothness = jerk.jerk_score_confidence === 'high' ? jerk.jerk_score : null;
  const sviScoreForSmoothness = svi.svi_score;
  const brakeOnsetScoreForSmoothness = brakeOnsetEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : brakeOnset.brake_onset_smoothness_score;
  const corneringScoreForSmoothness = corneringEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : cornering.cornering_consistency_score;
  const safetyBlend = scoringValue('SAFETY_SCORE_BLEND_WEIGHTS');
  const laneChangingSafetyWeight = laneChangingScoreForSafety == null
    ? 0
    : safetyBlend.laneChanging * (laneChanging.lane_changing_confidence_multiplier ?? 1);
  const safetyWithoutOvertake = weightedBlend([
    { score: baseSafety, weight: safetyBlend.base },
    { score: stopStartPatternScore, weight: safetyBlend.stopStart },
    { score: brakingScoreForSafety, weight: safetyBlend.braking },
    { score: complianceScoreForSafety, weight: safetyBlend.compliance },
    { score: phoneUseScoreForSafety, weight: safetyBlend.phoneUse ?? PHONE_USE_SAFETY_WEIGHT },
    { score: laneChangingScoreForSafety, weight: laneChangingSafetyWeight },
  ]) ?? baseSafety;
  let safety = safetyWithoutOvertake;
  safety = Math.min(100, safety + (slippery.safety_condition_bonus || 0));
  safety = Math.round(clamp(safety - fatiguePenalty, SCORE_FLOOR, 100));
  const smoothnessBlend = scoringValue('SMOOTHNESS_SCORE_BLEND_WEIGHTS');
  const smoothness = weightedBlend([
    { score: baseSmoothness, weight: smoothnessBlend.base },
    { score: jerkScoreForSmoothness, weight: smoothnessBlend.jerk },
    { score: sviScoreForSmoothness, weight: smoothnessBlend.speedVariability },
    { score: brakeOnsetScoreForSmoothness, weight: smoothnessBlend.brakeOnset },
    { score: corneringScoreForSmoothness, weight: smoothnessBlend.cornering },
  ]) ?? baseSmoothness;
  const ecoBlend = scoringValue('ECO_SCORE_BLEND_WEIGHTS');
  const eco = weightedBlend([
    { score: baseEco, weight: ecoBlend.base },
    { score: ecoDriving.eco_driving_score, weight: ecoBlend.ecoDriving },
    { score: fuelBand.fuel_band_score, weight: ecoBlend.fuelBand },
  ]) ?? baseEco;
  const intersectionScore = Number.isFinite(stats.intersection_score) ? stats.intersection_score : null;

  // Overall = weighted combination
  const overallBlend = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS');
  const overall = Math.min(100, weightedBlend([
    { score: safety, weight: overallBlend.safety },
    { score: smoothness, weight: overallBlend.smoothness },
    { score: eco, weight: overallBlend.eco },
    { score: intersectionScore, weight: overallBlend.intersection },
  ]) ?? Math.round((safety + smoothness + eco) / 3));
  const phoneUseRequiredForSafety = thresholds.PHONE_USE_AFFECTS_SCORE !== false;
  const hasGpsDistractionEvidence = routeSampleCount >= 2 || counts[EVENT_TYPES.ERRATIC_SPEED] > 0;
  const distractionValue = hasGpsDistractionEvidence || confirmedPhoneScoreAvailable ? Math.round(distractionScore) : null;
  const safetyEvidence = evidenceFor('safety', routeSampleCount, safety);
  const limitedSafetyEvidence = phoneUseScoreForSafety == null && phoneUseRequiredForSafety
    ? cappedEvidenceLevel(safetyEvidence, CONFIDENCE_LEVELS.DEVELOPING)
    : safetyEvidence;
  const overallEvidence = evidenceFor('overall', routeSampleCount, overall);
  const limitedOverallEvidence = intersectionScore == null || (phoneUseScoreForSafety == null && phoneUseRequiredForSafety)
    ? cappedEvidenceLevel(overallEvidence, CONFIDENCE_LEVELS.DEVELOPING)
    : overallEvidence;
  const componentEvidence = {
    overall: limitedOverallEvidence,
    safety: limitedSafetyEvidence,
    smoothness: evidenceFor('smoothness', routeSampleCount, smoothness),
    eco: evidenceFor('eco', routeSampleCount, eco),
    intersection: evidenceFor('intersection', stats.traffic_stop_count ?? 0, intersectionScore),
    distraction: evidenceFor('distraction', confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : counts[EVENT_TYPES.ERRATIC_SPEED], distractionValue),
    phone_use: evidenceFor('phone_use', phoneUseResult.phone_use_window_count ?? 0, confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null),
    stop_start_pattern: evidenceFor(
      'stop_start_pattern',
      stopStartPatternCount,
      stopStartPatternScore,
      highwayStopStartPatternScore != null ? highwayDistanceKm : urbanStopStartDistanceKm
    ),
    close_proximity: evidenceFor('close_proximity', closeProximityCount, closeProximityScore),
    smoothness_index: evidenceFor('smoothness_index', routeSampleCount, jerk.jerk_score),
    eco_driving: evidenceFor('eco_driving', routeSampleCount, ecoDriving.eco_driving_score),
    speed_variability: evidenceFor('speed_variability', svi.svi_moving_sample_count, svi.svi_score),
    fuel_band: evidenceFor('fuel_band', routeSampleCount, fuelBand.fuel_band_score),
    merge: evidenceFor('merge', merge.merge_event_count, merge.merge_score),
    smooth_braking: evidenceFor('smooth_braking', smoothBraking.total_stops_detected, smoothBraking.total_stops_detected > 0 ? smoothBraking.smooth_braking_score : null),
    engine_stress: evidenceFor('engine_stress', routeSampleCount, engineStress.engine_stress_score),
    speed_creep: evidenceFor('speed_creep', routeSampleCount, advancedSafetyEnabled ? speedCreep.speed_creep_score : null),
    heading_drift_beta: evidenceFor('heading_drift_beta', routeSampleCount, advancedSafetyEnabled ? headingDrift.heading_drift_beta_score : null),
    hill_driving: evidenceFor('hill_driving', altitudeSampleCount, hill.hill_driving_score),
    parking_approach: evidenceFor('parking_approach', routeSampleCount, routeSampleCount >= 3 ? parking.parking_approach_score : null),
    brake_onset_smoothness: brakeOnsetEvidence,
    cornering_consistency: corneringEvidence,
    braking_efficiency: brakingEvidence,
    speed_limit_compliance: evidenceFor('speed_limit_compliance', routeSampleCount, compliance.overall_compliance_score),
    lane_changing: evidenceFor('lane_changing', laneChanging.lane_change_count, laneChangingScoreValue, tripDistanceKm),
    overtake_quality: evidenceFor('overtake_quality', overtakeQuality.overtake_count, overtakeQuality.overtake_quality_score),
    aggressive_driving: evidenceFor('aggressive_driving', routeSampleCount, aggressive.aggressive_driving_score),
    fatigue_risk: evidenceFor('fatigue_risk', durationSeconds > 0 ? 1 : 0, stats.fatigue_risk_score),
  };
  const safetyConfidence = componentEvidence.safety;
  const smoothnessConfidence = componentEvidence.smoothness;
  const ecoConfidence = componentEvidence.eco;
  const distractionConfidence = componentEvidence.distraction;
  const overallConfidenceLevel = componentEvidence.overall;
  const scoreConfidence = confidenceNumericValue(overallConfidenceLevel);
  const scoreOrNull = (value: unknown, evidence: unknown): unknown => (
    evidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : value
  );
  const overallScoreValue = scoreOrNull(overall, componentEvidence.overall);
  const safetyScoreValue = scoreOrNull(safety, componentEvidence.safety);
  const smoothnessScoreValue = scoreOrNull(smoothness, componentEvidence.smoothness);
  const ecoScoreValue = scoreOrNull(eco, componentEvidence.eco);

  const componentScores = {
    score_overall: overallScoreValue,
    score_confidence: scoreConfidence,
    score_confidence_label: overallConfidenceLevel,
    score_safety: safetyScoreValue,
    score_safety_confidence: safetyConfidence,
    score_smoothness: smoothnessScoreValue,
    score_smoothness_confidence: smoothnessConfidence,
    score_eco: ecoScoreValue,
    score_eco_confidence: ecoConfidence,
    harsh_brakes_count: counts[EVENT_TYPES.HARSH_BRAKE],
    rapid_accel_count: counts[EVENT_TYPES.RAPID_ACCELERATION],
    sharp_turns_count: counts[EVENT_TYPES.SHARP_TURN],
    speeding_events_count: counts[EVENT_TYPES.SPEEDING],
    heading_deviation_count: counts[EVENT_TYPES.HEADING_DEVIATION],
    heading_deviations_per_10km: round1((counts[EVENT_TYPES.HEADING_DEVIATION] / distKm) * 10),
    heading_deviation_legacy_count: counts[EVENT_TYPES.HEADING_DEVIATION_LEGACY],
    heading_deviation_legacy_per_10km: round1((counts[EVENT_TYPES.HEADING_DEVIATION_LEGACY] / distKm) * 10),
    heading_deviation_available: advancedSafetyEnabled || counts[EVENT_TYPES.HEADING_DEVIATION] > 0,
    heading_deviation_scoring_enabled: advancedSafetyEnabled,
    stop_start_pattern_count: stopStartPatternCount,
    stop_start_pattern_sample_count: stopStartPatternCount,
    stop_start_pattern_score: stopStartPatternScore,
    stop_start_pattern_highway_count: highwayStopStartPatternCount,
    stop_start_pattern_urban_count: urbanStopStartPatternCount,
    stop_start_pattern_highway_score: highwayStopStartPatternScore,
    stop_start_pattern_urban_score: urbanStopStartPatternScore,
    stop_start_pattern_highway_distance_km: round2(highwayDistanceKm),
    stop_start_pattern_urban_distance_km: round2(urbanStopStartDistanceKm),
    stop_start_pattern_median_speed_kmh: round1(stopStartEvidence.medianMovingSpeedKmh),
    stop_start_pattern_score_confidence: componentEvidence.stop_start_pattern,
    distraction_events_count: counts[EVENT_TYPES.ERRATIC_SPEED],
    distraction_score: distractionValue,
    distraction_score_confidence: distractionConfidence,
    close_proximity_count: closeProximityCount,
    close_proximity_score: closeProximityScore,
    close_proximity_score_confidence: componentEvidence.close_proximity,
    overtake_event_count: diagnosticOvertakeCount,
    overtake_score: null,
    overtake_score_confidence: 'development_diagnostic_only',
    overtake_affects_score: false,
    intersection_score: intersectionScore,
    intersection_score_confidence: componentEvidence.intersection,
    ...jerk,
    jerk_score_confidence: componentEvidence.smoothness_index,
    ...ecoDriving,
    eco_driving_score_confidence: componentEvidence.eco_driving,
    ...svi,
    svi_score_confidence: componentEvidence.speed_variability,
    ...fuelBand,
    fuel_band_score_confidence: componentEvidence.fuel_band,
    ...merge,
    merge_score_confidence: componentEvidence.merge,
    ...smoothBraking,
    smooth_braking_score_confidence: componentEvidence.smooth_braking,
    ...engineStress,
    engine_stress_score_confidence: componentEvidence.engine_stress,
    ...tireWear,
    ...speedCreep,
    speed_creep_score_confidence: componentEvidence.speed_creep,
    ...phoneProxy,
    phone_use_events: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_events || []) : [],
    phone_use_window_count: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_window_count || 0) : 0,
    phone_use_total_seconds: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_total_seconds || 0) : 0,
    phone_use_risk: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_risk || 'none') : 'none',
    phone_use_score: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null,
    phone_use_score_available: confirmedPhoneScoreAvailable,
    phone_use_score_status: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_score_status || 'confirmed_signal') : 'usage_access_required',
    phone_use_score_confidence: confirmedPhoneScoreAvailable ? componentEvidence.phone_use : 'usage_access_required',
    phone_use_pct_of_trip: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_pct_of_trip || 0) : 0,
    phone_use_high_confidence_count: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_high_confidence_count || 0) : 0,
    phone_proxy_events: proxyEvents,
    ...headingDrift,
    heading_drift_beta_confidence: componentEvidence.heading_drift_beta,
    heading_drift_beta_available: advancedSafetyEnabled,
    ...hill,
    hill_driving_score_confidence: componentEvidence.hill_driving,
    ...parking,
    parking_approach_score_confidence: componentEvidence.parking_approach,
    ...brakeOnset,
    brake_onset_smoothness_confidence: componentEvidence.brake_onset_smoothness,
    ...cornering,
    cornering_consistency_score_confidence: componentEvidence.cornering_consistency,
    ...brakingEfficiency,
    braking_efficiency_score_confidence: componentEvidence.braking_efficiency,
    ...compliance,
    overall_compliance_score_confidence: componentEvidence.speed_limit_compliance,
    ...laneChanging,
    lane_changing_score: laneChangingScoreValue,
    lane_changing_safety_weight: laneChangingSafetyWeight,
    lane_change_detection_confidence: laneChangeResult.confidence,
    lane_change_detection_method: laneChangeResult.detection_method,
    lane_change_events: laneChangeResult.lane_changes || [],
    ...overtakeQuality,
    overtake_quality_score_confidence: componentEvidence.overtake_quality,
    overtake_quality_beta: false,
    overtake_quality_status: 'development_diagnostic_only',
    ...slippery,
    ...(options.includeRoadTypeSegments === false ? {} : calculateRoadTypeSegmentedScores(routePoints, scoringEvents, stats, thresholds)),
    ...aggressive,
    aggressive_driving_score_confidence: componentEvidence.aggressive_driving,
    driving_events: serializableEvents,
  };
  delete componentScores.speed_creep_severity_counts;

  const defensiveDriving = calculateDefensiveDrivingScore(componentScores);
  const scoredTrip = {
    ...componentScores,
    ...defensiveDriving,
    defensive_driving_score_confidence: evidenceFor('defensive_driving', routeSampleCount, defensiveDriving.defensive_driving_score),
  };
  const gpsSources = tripDistanceKm > 0 || routePoints.length > 0 || scoringEvents.length > 0 ? ['gps'] : [];
  const obdSpeedObserved = routePoints.some((point) => speedSourceForPoint(point, thresholds) === 'obd_bluetooth');
  const obdPowertrainObserved = routePoints.some((point) => (
    Number.isFinite(Number(point?.obd_rpm)) ||
    Number.isFinite(Number(point?.obd_throttle_pct)) ||
    Number.isFinite(Number(point?.obd_maf_gps))
  ));
  const osmSpeedLimitObserved = routePoints.some((point) => (
    ['openstreetmap', 'osm_highway_default'].includes(point?.speed_limit_source)
  ));
  const speedLimitSources = compliance.overall_compliance_score == null
    ? []
    : [...gpsSources, osmSpeedLimitObserved ? 'osm_speed_limit' : 'gps_inferred_speed_limit'];
  const phoneSources = confirmedPhoneScoreAvailable
    ? [...new Set(phoneUseResult.data_sources?.length ? phoneUseResult.data_sources : ['android_usage_access'])]
    : [];
  const combinedSources = (...sources: Array<string[] | string | null | undefined>): string[] => [
    ...new Set(sources.flat().filter((source): source is string => Boolean(source))),
  ];
  const vehicleSpeedSources = combinedSources(gpsSources, obdSpeedObserved ? ['obd_bluetooth'] : []);
  const laneChangingSources = laneChanging.lane_changing_confidence === 'imu_calibrated'
    ? combinedSources(gpsSources, ['device_motion_imu'])
    : gpsSources;
  const powertrainSources = combinedSources(vehicleSpeedSources, obdPowertrainObserved ? ['obd_bluetooth'] : []);
  const inferredSpeedLimitScoring = speedLimitSources.includes('gps_inferred_speed_limit');
  const inferredSpeedLimitNote = inferredSpeedLimitScoring
    ? 'Speed-limit compliance used inferred road-type limits because no posted OpenStreetMap maxspeed was available; speeding penalties are half-weighted.'
    : undefined;
  const joinedNote = (...notes: Array<string | undefined>): string | undefined => notes.filter(Boolean).join(' ') || undefined;
  const component_scores = {
    overall: createComponentScore(overallScoreValue, componentEvidence.overall, combinedSources(vehicleSpeedSources, phoneSources, speedLimitSources), {
      sampleCount: routeSampleCount,
      note: joinedNote(
        overallConfidenceLevel === CONFIDENCE_LEVELS.HIGH ? undefined : 'Some contributing signals are unavailable or still developing.',
        inferredSpeedLimitNote
      ),
    }),
    safety: createComponentScore(safetyScoreValue, componentEvidence.safety, combinedSources(vehicleSpeedSources, phoneSources, speedLimitSources), {
      sampleCount: routeSampleCount,
      note: joinedNote(
        phoneUseScoreForSafety == null && phoneUseRequiredForSafety ? 'Confirmed phone-use evidence is unavailable.' : undefined,
        inferredSpeedLimitNote
      ),
    }),
    smoothness: createComponentScore(smoothnessScoreValue, componentEvidence.smoothness, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    eco: createComponentScore(ecoScoreValue, componentEvidence.eco, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    intersection: createComponentScore(intersectionScore, componentEvidence.intersection, gpsSources, {
      sampleCount: stats.traffic_stop_count ?? 0,
      note: intersectionScore == null ? 'No qualifying traffic-stop evidence was recorded.' : undefined,
    }),
    distraction: createComponentScore(distractionValue, componentEvidence.distraction, combinedSources(gpsSources, phoneSources), {
      sampleCount: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : counts[EVENT_TYPES.ERRATIC_SPEED],
    }),
    phone_use: createComponentScore(
      confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null,
      componentEvidence.phone_use,
      phoneSources,
      {
        sampleCount: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : 0,
        note: confirmedPhoneScoreAvailable ? undefined : 'Android Usage Access is required for a scored phone-use signal.',
      }
    ),
    stop_start_pattern: createComponentScore(stopStartPatternScore, componentEvidence.stop_start_pattern, gpsSources, {
      sampleCount: stopStartPatternCount,
      note: 'GPS-only pattern estimate; it does not measure following distance.',
    }),
    close_proximity: createComponentScore(closeProximityScore, componentEvidence.close_proximity, gpsSources, {
      sampleCount: closeProximityCount,
      note: 'GPS brake-turn manoeuvre alert; object proximity is not measured.',
    }),
    smoothness_index: createComponentScore(jerk.jerk_score, componentEvidence.smoothness_index, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    eco_driving: createComponentScore(ecoDriving.eco_driving_score, componentEvidence.eco_driving, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    speed_variability: createComponentScore(svi.svi_score, componentEvidence.speed_variability, vehicleSpeedSources, {
      sampleCount: svi.svi_moving_sample_count,
    }),
    fuel_band: createComponentScore(fuelBand.fuel_band_score, componentEvidence.fuel_band, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    merge: createComponentScore(merge.merge_score, componentEvidence.merge, gpsSources, {
      sampleCount: merge.merge_event_count,
    }),
    smooth_braking: createComponentScore(
      smoothBraking.total_stops_detected > 0 ? smoothBraking.smooth_braking_score : null,
      componentEvidence.smooth_braking,
      gpsSources,
      { sampleCount: smoothBraking.total_stops_detected }
    ),
    engine_stress: createComponentScore(engineStress.engine_stress_score, componentEvidence.engine_stress, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    speed_creep: createComponentScore(
      advancedSafetyEnabled ? speedCreep.speed_creep_score : null,
      componentEvidence.speed_creep,
      gpsSources,
      { sampleCount: routeSampleCount }
    ),
    heading_drift_beta: createComponentScore(
      advancedSafetyEnabled ? headingDrift.heading_drift_beta_score : null,
      componentEvidence.heading_drift_beta,
      gpsSources,
      {
        sampleCount: routeSampleCount,
        note: 'GPS attention signal only - not a fatigue measurement.',
      }
    ),
    hill_driving: createComponentScore(hill.hill_driving_score, componentEvidence.hill_driving, combinedSources(gpsSources, ['gps_altitude']), {
      sampleCount: altitudeSampleCount,
      note: 'GPS altitude-derived estimate.',
    }),
    parking_approach: createComponentScore(routeSampleCount >= 3 ? parking.parking_approach_score : null, componentEvidence.parking_approach, gpsSources, {
      sampleCount: routeSampleCount,
    }),
    brake_onset_smoothness: createComponentScore(brakeOnset.brake_onset_smoothness_score, componentEvidence.brake_onset_smoothness, vehicleSpeedSources, {
      sampleCount: brakeOnset.brake_onset_sequence_count,
    }),
    cornering_consistency: createComponentScore(cornering.cornering_consistency_score, componentEvidence.cornering_consistency, vehicleSpeedSources, {
      sampleCount: cornering.corner_sample_count,
    }),
    braking_efficiency: createComponentScore(brakingEfficiency.braking_efficiency_score, componentEvidence.braking_efficiency, vehicleSpeedSources, {
      sampleCount: brakingEfficiency.braking_sequence_count,
    }),
    speed_limit_compliance: createComponentScore(compliance.overall_compliance_score, componentEvidence.speed_limit_compliance, speedLimitSources, {
      sampleCount: routeSampleCount,
      note: inferredSpeedLimitNote,
    }),
    lane_changing: createComponentScore(
      laneChangingScoreValue,
      componentEvidence.lane_changing,
      laneChangingSources,
      {
        sampleCount: laneChanging.lane_change_count,
        note: !laneChangeScoreEnabled
          ? 'Lane-changing scoring is disabled in Settings.'
          : laneChanging.lane_changing_score == null
            ? 'Requires at least 5 km and two detected lane-change manoeuvres.'
            : 'Diagnostic only until 200 dashcam-reviewed labeled trips reach 85% agreement and curved-road false positives stay below 10%; not included in Safety.',
      }
    ),
    overtake_quality: createComponentScore(overtakeQuality.overtake_quality_score, componentEvidence.overtake_quality, gpsSources, {
      sampleCount: overtakeQuality.overtake_count,
      note: 'Development diagnostic only; hidden from Trip Detail and excluded from scores.',
    }),
    aggressive_driving: createComponentScore(aggressive.aggressive_driving_score, componentEvidence.aggressive_driving, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    defensive_driving: createComponentScore(defensiveDriving.defensive_driving_score, evidenceFor('defensive_driving', routeSampleCount, defensiveDriving.defensive_driving_score), vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    fatigue_risk: createComponentScore(stats.fatigue_risk_score, componentEvidence.fatigue_risk, gpsSources, {
      sampleCount: durationSeconds > 0 ? 1 : 0,
      note: 'Driving-time proxy only; not a diagnosis of fatigue.',
    }),
  };
  const scorePipelineContext = createScoringPipelineContext({
    routePoints,
    events: scoringEvents,
    settings: thresholds,
    externalContext: { stats, component_scores },
    stages: {
      safety_base: { score: baseSafety, penalty: safetyPenalty },
      braking_efficiency: {
        score: brakingScoreForSafety,
        sequenceCount: brakingEfficiency.braking_sequence_count,
      },
      speed_compliance: {
        score: complianceScoreForSafety,
        highway: compliance.highway_compliance,
        urban: compliance.urban_compliance,
        residential: compliance.residential_compliance,
      },
      stop_start: {
        score: stopStartPatternScore,
        count: stopStartPatternCount,
        highwayScore: highwayStopStartPatternScore,
        urbanScore: urbanStopStartPatternScore,
      },
      lane_changing: {
        score: laneChangingScoreForSafety,
        effectiveWeight: laneChangingSafetyWeight,
        count: laneChanging.lane_change_count,
        confidence: laneChanging.lane_changing_confidence,
      },
      phone_use: {
        score: phoneUseScoreForSafety,
        risk: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_risk : 'none',
        scoreDeduction: phoneUseDeduction,
        totalSeconds: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_total_seconds : 0,
      },
      safety_blend: {
        score: safetyScoreValue,
        weights: safetyBlend,
        fatigueAdjusted: fatiguePenalty > 0,
      },
      smoothness_base: { score: baseSmoothness, penalty: smoothnessPenalty },
      jerk: { score: jerkScoreForSmoothness },
      svi: { score: sviScoreForSmoothness },
      brake_onset: { score: brakeOnsetScoreForSmoothness },
      cornering: { score: corneringScoreForSmoothness },
      smoothness_blend: { score: smoothnessScoreValue, weights: smoothnessBlend },
      eco: {
        score: ecoScoreValue,
        baseScore: baseEco,
        ecoDrivingScore: ecoDriving.eco_driving_score,
        fuelBandScore: fuelBand.fuel_band_score,
        weights: ecoBlend,
      },
      intersection: { score: intersectionScore },
      fatigue_adjustment: { deduction: fatiguePenalty },
      weather_adjustment: { skipped: true, reason: 'applied_after_trip_scoring_when_weather_context_exists' },
      overall_blend: { score: overallScoreValue, weights: overallBlend },
    },
  });
  return {
    ...scoredTrip,
    component_scores,
    score_explanation: explainScores(scorePipelineContext),
    score_provenance: buildScoreProvenance(component_scores, thresholds),
  };
}
