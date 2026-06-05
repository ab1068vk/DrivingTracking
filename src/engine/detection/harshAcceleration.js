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
  buildLaneChangeSuppressionWindows,
  isInsideLaneChangeSuppressionWindow
} from './laneCurvature.js';
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
} from '../scoring/ecoScore.js';

export function headingBetweenPair(prev, curr, fallbackPrev = null) {
  if (Number.isFinite(prev?.heading) && Number.isFinite(curr?.heading)) {
    return { h1: prev.heading, h2: curr.heading };
  }
  const h1 = Number.isFinite(prev?.heading)
    ? prev.heading
    : fallbackPrev
      ? calculateBearing(fallbackPrev.lat, fallbackPrev.lng, prev.lat, prev.lng)
      : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  const h2 = Number.isFinite(curr?.heading)
    ? curr.heading
    : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  return { h1, h2 };
}

export function signedHeadingDelta(from, to) {
  let diff = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(diff)) diff = 0;
  return diff;
}

export function headingForIndex(points, index) {
  const point = points[index];
  if (Number.isFinite(point?.heading)) return point.heading;
  if (index > 0) {
    const prev = points[index - 1];
    return calculateBearing(prev.lat, prev.lng, point.lat, point.lng);
  }
  if (points[index + 1]) {
    const next = points[index + 1];
    return calculateBearing(point.lat, point.lng, next.lat, next.lng);
  }
  return 0;
}

export function usableHeadingSegment(a, b) {
  if (!hasValidCoordinates(a) || !hasValidCoordinates(b)) return false;
  const segment = calculateSegmentMetrics(a, b);
  return segment.dt > 0 && segment.dt <= 8 && !segment.isNoise && segment.distanceM >= 8;
}

export function geometryHeadingForIndex(points, index) {
  const point = points[index];
  if (!point) return null;
  const prev = points[index - 1];
  const next = points[index + 1];
  if (usableHeadingSegment(prev, point) && usableHeadingSegment(point, next)) {
    return calculateBearing(prev.lat, prev.lng, next.lat, next.lng);
  }
  if (usableHeadingSegment(point, next)) {
    return calculateBearing(point.lat, point.lng, next.lat, next.lng);
  }
  if (usableHeadingSegment(prev, point)) {
    return calculateBearing(prev.lat, prev.lng, point.lat, point.lng);
  }
  return headingForIndex(points, index);
}

export function smoothHeading(points, index) {
  const headings = [index - 1, index, index + 1]
    .filter((candidateIndex) => candidateIndex >= 0 && candidateIndex < points.length)
    .filter((candidateIndex) => (
      candidateIndex === index ||
      usableHeadingSegment(points[Math.min(candidateIndex, index)], points[Math.max(candidateIndex, index)])
    ))
    .map((candidateIndex) => geometryHeadingForIndex(points, candidateIndex))
    .filter(Number.isFinite);
  if (!headings.length) return null;
  const sin = headings.reduce((sum, heading) => sum + Math.sin(heading * Math.PI / 180), 0) / headings.length;
  const cos = headings.reduce((sum, heading) => sum + Math.cos(heading * Math.PI / 180), 0) / headings.length;
  return ((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360;
}

export function headingVarianceForRange(points, startIndex, endIndex) {
  const headings = [];
  for (let i = Math.max(0, startIndex); i <= Math.min(points.length - 1, endIndex); i++) {
    const heading = smoothHeading(points, i);
    if (Number.isFinite(heading)) headings.push(heading);
  }
  return headingStdDev(headings);
}

export function pointHasIntersectionOrRampContext(point = {}) {
  const textValues = [
    point.road_type,
    point.road_class,
    point.highway,
    point.junction,
    point.osm_highway,
    point.osm_junction,
  ].map((value) => String(value || '').toLowerCase());
  return Boolean(
    point.intersection ||
    point.is_intersection ||
    point.near_intersection ||
    point.ramp ||
    point.is_ramp ||
    textValues.some((value) => value.includes('ramp') || value.includes('_link') || value.includes('roundabout'))
  );
}

export function isNearIntersectionOrRampContext(points = [], index = 0, radiusM = 200) {
  const current = points[index];
  if (!hasValidCoordinates(current)) return false;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!hasValidCoordinates(point)) continue;
    if (pointHasIntersectionOrRampContext(point)) {
      if (haversineMeters(current.lat, current.lng, point.lat, point.lng) <= radiusM) return true;
    }
  }

  let stopDistanceM = 0;
  for (let i = index - 1; i >= 0; i--) {
    const segment = calculateSegmentMetrics(points[i], points[i + 1]);
    if (segment.dt <= 0 || segment.dt > 30 || segment.isNoise) break;
    stopDistanceM += segment.distanceM;
    if (stopDistanceM > radiusM) break;
    if (finiteSpeed(points[i]) <= 12) return true;
  }
  stopDistanceM = 0;
  for (let i = index + 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i]);
    if (segment.dt <= 0 || segment.dt > 30 || segment.isNoise) break;
    stopDistanceM += segment.distanceM;
    if (stopDistanceM > radiusM) break;
    if (finiteSpeed(points[i]) <= 12) return true;
  }

  return false;
}

export function detectHeadingDeviationEvents(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 2) return [];

  const candidates = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const speed = Math.max(
      reliablePointSpeed(points, i - 1, thresholds) ?? finiteSpeed(prev),
      reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(curr)
    );
    const minSpeed = thresholds.HEADING_DEVIATION_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_SPEED_KMH;
    if (speed <= minSpeed) continue;

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
    const signedDelta = signedHeadingDelta(h1, h2);
    const turnRate = Math.abs(signedDelta) / dt;
    const minRate = thresholds.HEADING_DEVIATION_MIN_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_TURN_RATE_DEG_S;
    const maxRate = thresholds.HEADING_DEVIATION_MAX_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MAX_TURN_RATE_DEG_S;

    const highwaySpeed = thresholds.HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH;
    const windowStart = Math.max(0, i - 3);
    const windowEnd = Math.min(points.length - 1, i + 3);
    const windowPoints = points.slice(windowStart, windowEnd + 1);
    const windowDurationS = (timestampMs(points[windowEnd]) - timestampMs(points[windowStart])) / 1000;
    if (windowDurationS <= 0 || windowDurationS > 40) continue;
    const minWindowSeconds = thresholds.HEADING_DEVIATION_MIN_WINDOW_SECONDS ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_WINDOW_SECONDS;
    if (windowDurationS < minWindowSeconds) continue;
    const straightHeadingStdMax = thresholds.HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG;
    const approachHeadingStd = headingVarianceForRange(points, windowStart, Math.max(windowStart, i - 1));
    if (approachHeadingStd > straightHeadingStdMax) continue;
    const suppressionRadius = thresholds.HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS;
    if (isNearIntersectionOrRampContext(points, i, suppressionRadius)) continue;

    let leftChange = 0;
    let rightChange = 0;
    let totalAbsChange = Math.abs(signedDelta);
    const nearbyHeadingDeltas = [];
    for (let j = Math.max(1, windowStart + 1); j <= windowEnd; j++) {
      const a = headingForIndex(points, j - 1);
      const b = headingForIndex(points, j);
      const delta = signedHeadingDelta(a, b);
      const deltaSeconds = Math.abs(timestampMs(points[j]) - timestampMs(curr)) / 1000;
      const absDelta = Math.abs(delta);
      totalAbsChange += j === i ? 0 : absDelta;
      if (deltaSeconds <= 8 && absDelta >= 1.5 && absDelta <= 20) nearbyHeadingDeltas.push(delta);
      if (delta > 0) rightChange += delta;
      if (delta < 0) leftChange += Math.abs(delta);
    }
    const hasCounterSteer = nearbyHeadingDeltas.some((delta) => (
      (signedDelta > 0 && delta < 0) || (signedDelta < 0 && delta > 0)
    )) || (leftChange >= 2.5 && rightChange >= 2.5);

    const headings = windowPoints.map((_, offset) => headingForIndex(points, windowStart + offset));
    const startHeading = headings[0];
    const endHeading = headings[headings.length - 1];
    const netHeadingChange = Math.abs(signedHeadingDelta(startHeading, endHeading));
    const peakExcursion = headings.reduce((peak, heading) => Math.max(peak, Math.abs(signedHeadingDelta(startHeading, heading))), 0);
    const windowSpeeds = windowPoints.map((_, offset) => reliablePointSpeed(points, windowStart + offset, thresholds) ?? finiteSpeed(points[windowStart + offset]));
    const stableSpeed = speedStdDev(windowSpeeds) <= (speed >= highwaySpeed ? 12 : 8);
    const usableGpsShape = windowPoints.every((point, offset) => {
      if (point.accuracy != null && point.accuracy > 35) return false;
      if (offset === 0) return true;
      const segment = calculateSegmentMetrics(windowPoints[offset - 1], point, thresholds);
      return segment.dt > 0 && segment.dt <= 10 && !segment.isNoise && segment.distanceM >= 8;
    });
    if (!usableGpsShape) continue;
    const sCurveLaneChange = hasCounterSteer &&
      peakExcursion >= 5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 6 &&
      totalAbsChange >= 10 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const highwayLaneShift = speed >= highwaySpeed &&
      hasCounterSteer &&
      peakExcursion >= 4.5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 7 &&
      totalAbsChange >= 9 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const pointRateFits = turnRate >= minRate && turnRate <= maxRate;
    const pointRateLaneChange = pointRateFits &&
      hasCounterSteer &&
      peakExcursion >= 5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 6 &&
      totalAbsChange >= 10 &&
      totalAbsChange <= 32 &&
      stableSpeed;

    if (pointRateLaneChange || sCurveLaneChange || highwayLaneShift) {
      candidates.push({ point: curr, turnRate: Math.max(turnRate, totalAbsChange / windowDurationS), speed, pointIndex: i });
    }
  }

  const merged = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const candidateTime = timestampMs(candidate.point);
    if (previous && (candidateTime - previous.lastTime) / 1000 <= 3) {
      previous.lastTime = candidateTime;
      if (candidate.turnRate > previous.turnRate) {
        previous.turnRate = candidate.turnRate;
        previous.point = candidate.point;
        previous.speed = candidate.speed;
        previous.pointIndex = candidate.pointIndex;
      }
    } else {
      merged.push({ ...candidate, lastTime: candidateTime });
    }
  }

  const distanceKm = Math.max(1, calculateRouteDistanceKm(points, thresholds));
  const ratePer10Km = (merged.length / distanceKm) * 10;
  const severity = ratePer10Km >= 4 ? 'high' : ratePer10Km >= 2 ? 'medium' : 'low';

  return merged.map(({ point, turnRate, speed, pointIndex }) => ({
    type: EVENT_TYPES.HEADING_DEVIATION,
    severity,
    label: 'heading deviation event (diagnostic)',
    confidence: 'low',
    lat: point.lat,
    lng: point.lng,
    timestamp: point.timestamp,
    point_index: pointIndex,
    value: round1(turnRate),
    speed_kmh: Math.round(speed),
  }));
}

export const LANE_CHANGE_EVENT_TYPE = 'lane_change_detected';
export const LANE_CHANGE_MIN_SPEED_KMH = 65;
export const LANE_CHANGE_MIN_LATERAL_G = 0.08;
export const LANE_CHANGE_MAX_LATERAL_G = 0.35;
export const LANE_CHANGE_BILATERAL_WINDOW_S = 7;
export const LANE_CHANGE_MAX_NET_HEADING_DEG = 10;
export const LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD = -2.0;
export const LANE_CHANGE_MAX_GPS_ACCURACY_M = 20;
export const LANE_CHANGE_GPS_MIN_DELTA_DEG = 1.5;
export const LANE_CHANGE_GPS_MAX_DELTA_DEG = 8;
export const LANE_CHANGE_MAX_SPEED_DROP_KMH = 12;
export const LANE_CHANGE_HIGHWAY_SPEED_KMH = 100;
export const LANE_CHANGE_REGIONAL_YAW_DEG_S = 2.4;
export const LANE_CHANGE_HIGHWAY_YAW_DEG_S = 1.8;

export function finiteSampleValue(sample, key) {
  const value = Number(sample?.[key]);
  return Number.isFinite(value) ? value : null;
}

export function sampleTimestampMs(sample) {
  const value = sample?.timestamp_ms ?? sample?.timestamp ?? sample?.time;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

export function normalizedLaneMotionSample(sample = {}) {
  const ax = finiteSampleValue(sample, 'ax');
  const ay = finiteSampleValue(sample, 'ay');
  const az = finiteSampleValue(sample, 'az');
  const gx = finiteSampleValue(sample, 'gx');
  const gy = finiteSampleValue(sample, 'gy');
  const gz = finiteSampleValue(sample, 'gz');
  const gzDegS = finiteSampleValue(sample, 'gz_deg_s') ?? (gz != null ? gz * 180 / Math.PI : null);
  return {
    ...sample,
    timestamp_ms: sampleTimestampMs(sample),
    ax,
    ay,
    az,
    gx,
    gy,
    gz,
    gz_deg_s: gzDegS,
    has_axes: sample?.has_axes === true || (ax != null && ay != null && gzDegS != null),
  };
}

export function headingValueForLaneChange(points, index) {
  const point = points[index];
  const heading = Number(point?.heading ?? point?.bearing);
  return Number.isFinite(heading) ? heading : headingForIndex(points, index);
}

export function firstPointAtOrAfter(points = [], targetMs) {
  return points.find((point) => timestampMs(point) >= targetMs) || null;
}

export function speedMaintainedInWindow(points = [], startMs, endMs, baselineSpeed) {
  const windowSpeeds = points
    .filter((point) => {
      const ms = timestampMs(point);
      return ms >= startMs && ms <= endMs;
    })
    .map((point) => finiteSpeed(point))
    .filter(Number.isFinite);
  if (windowSpeeds.length < 2) return true;
  const minSpeed = Math.min(...windowSpeeds);
  const maxSpeed = Math.max(...windowSpeeds);
  return baselineSpeed - minSpeed <= LANE_CHANGE_MAX_SPEED_DROP_KMH && maxSpeed - minSpeed <= 20;
}

export function laneChangeYawThresholdForSpeed(speedKmh, thresholds = DEFAULT_THRESHOLDS) {
  const highwayCutoff = thresholds.LANE_CHANGE_HIGHWAY_SPEED_KMH ?? LANE_CHANGE_HIGHWAY_SPEED_KMH;
  const highwayYaw = thresholds.LANE_CHANGE_HIGHWAY_YAW_DEG_S ?? LANE_CHANGE_HIGHWAY_YAW_DEG_S;
  const regionalYaw = thresholds.LANE_CHANGE_REGIONAL_YAW_DEG_S ?? LANE_CHANGE_REGIONAL_YAW_DEG_S;
  return Number(speedKmh) > highwayCutoff ? highwayYaw : regionalYaw;
}

/**
 * Detect probable lane changes from calibrated IMU axes, with a lower-confidence
 * GPS bilateral-heading fallback for highway-speed trips.
 *
 * @param {Array<object>} cleanPoints GPS route points.
 * @param {Array<object>} motionSamples Raw or normalized IMU samples.
 * @param {object} orientationCalibration Result from calibratePhoneOrientation.
 * @param {object} thresholds Driving thresholds.
 * @returns {{lane_changes:Array<object>,lane_change_count:number,unsafe_lane_changes:number,confidence:string,detection_method:string}}
 */
export function detectLaneChanges(cleanPoints = [], motionSamples = [], orientationCalibration = null, thresholds = DEFAULT_THRESHOLDS) {
  const points = Array.isArray(cleanPoints) ? cleanPoints : [];
  const lateralAxis = orientationCalibration?.lateral_axis || null;
  const longitudinalAxis = orientationCalibration?.longitudinal_axis || null;
  const imuAvailable = orientationCalibration?.calibrated === true && lateralAxis && longitudinalAxis;

  if (!imuAvailable && points.length < 10) {
    return {
      lane_changes: [],
      lane_change_count: 0,
      unsafe_lane_changes: 0,
      confidence: 'insufficient_data',
      detection_method: 'unavailable',
    };
  }

  const normalizedSamples = (motionSamples || [])
    .map(normalizedLaneMotionSample)
    .filter((sample) => Number.isFinite(sample.timestamp_ms));
  const laneChanges = [];
  let suppressUntilMs = 0;
  const curvedRoadSuppressionWindows = buildLaneChangeSuppressionWindows(points, thresholds);

  const samplesInWindow = (startMs, endMs) => normalizedSamples.filter((sample) => (
    sample.timestamp_ms >= startMs && sample.timestamp_ms <= endMs
  ));

  for (let i = 2; i < points.length - 3; i++) {
    const p = points[i];
    const speed = reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(p);
    const acc = Number(p?.accuracy || 0);
    const tMs = timestampMs(p);
    const windowEnd = tMs + LANE_CHANGE_BILATERAL_WINDOW_S * 1000;
    if (tMs < suppressUntilMs) continue;
    if (isInsideLaneChangeSuppressionWindow(tMs, curvedRoadSuppressionWindows)) continue;
    if (speed < LANE_CHANGE_MIN_SPEED_KMH) continue;
    if (acc > LANE_CHANGE_MAX_GPS_ACCURACY_M) continue;
    if (!speedMaintainedInWindow(points, tMs, windowEnd, speed)) continue;

    const windowSamples = samplesInWindow(tMs - 500, windowEnd);

    if (imuAvailable && windowSamples.length >= 6) {
      const lateralValues = windowSamples
        .filter((sample) => sample.has_axes && finiteSampleValue(sample, lateralAxis) != null)
        .map((sample) => finiteSampleValue(sample, lateralAxis));
      const yawValues = windowSamples
        .map((sample) => finiteSampleValue(sample, 'gz_deg_s'))
        .filter((value) => value != null);

      if (lateralValues.length < 4 || yawValues.length < 4) continue;

      const peakLateral = Math.max(...lateralValues.map((value) => Math.abs(value))) / 9.80665;
      if (peakLateral < LANE_CHANGE_MIN_LATERAL_G) continue;
      if (peakLateral > LANE_CHANGE_MAX_LATERAL_G) continue;

      const yawThreshold = laneChangeYawThresholdForSpeed(speed, thresholds);
      const firstYaw = yawValues.find((value) => Math.abs(value) > yawThreshold);
      if (firstYaw == null) continue;
      const firstSign = Math.sign(firstYaw);
      const hasReversal = yawValues.some((value, index) => (
        index > 1 &&
        Math.abs(value) > yawThreshold &&
        Math.sign(value) !== 0 &&
        Math.sign(value) !== firstSign
      ));
      if (!hasReversal) continue;

      const pEnd = firstPointAtOrAfter(points, windowEnd);
      if (pEnd) {
        const hStart = headingValueForLaneChange(points, i);
        const hEnd = headingValueForLaneChange(points, points.indexOf(pEnd));
        if (!Number.isFinite(hStart) || !Number.isFinite(hEnd)) continue;
        const netChange = Math.abs(signedHeadingDelta(hStart, hEnd));
        if (netChange > LANE_CHANGE_MAX_NET_HEADING_DEG) continue;
      }

      const longitudinalValues = windowSamples
        .filter((sample) => sample.has_axes && finiteSampleValue(sample, longitudinalAxis) != null)
        .map((sample) => finiteSampleValue(sample, longitudinalAxis));
      const minLongitudinalMs2 = longitudinalValues.length ? Math.min(...longitudinalValues) : 0;
      const simultaneousBraking = minLongitudinalMs2 < LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD;

      laneChanges.push({
        type: LANE_CHANGE_EVENT_TYPE,
        timestamp: p.timestamp,
        lat: p.lat,
        lng: p.lng,
        speed_kmh: Math.round(speed),
        lateral_g: round2(peakLateral),
        direction: lateralValues[0] > 0 ? 'right' : 'left',
        simultaneous_braking: simultaneousBraking,
        detection_method: 'imu_yaw_bilateral',
        confidence: 'high',
      });
      suppressUntilMs = windowEnd;
      continue;
    }

    const h0 = headingValueForLaneChange(points, i - 1);
    const h1 = headingValueForLaneChange(points, i);
    if (!Number.isFinite(h0) || !Number.isFinite(h1)) continue;

    const initialDelta = signedHeadingDelta(h0, h1);
    if (Math.abs(initialDelta) < LANE_CHANGE_GPS_MIN_DELTA_DEG || Math.abs(initialDelta) > LANE_CHANGE_GPS_MAX_DELTA_DEG) continue;

    let foundReversal = false;
    let peakDelta = Math.abs(initialDelta);
    for (let j = i + 1; j < points.length; j++) {
      const pj = points[j];
      const tj = timestampMs(pj);
      if ((tj - tMs) / 1000 > LANE_CHANGE_BILATERAL_WINDOW_S) break;
      const hj = headingValueForLaneChange(points, j);
      if (!Number.isFinite(hj)) continue;
      const devFromStart = signedHeadingDelta(h0, hj);
      peakDelta = Math.max(peakDelta, Math.abs(devFromStart));
      const reversed = Math.sign(devFromStart) !== Math.sign(initialDelta) || Math.abs(devFromStart) < 0.8;
      if (reversed && peakDelta <= LANE_CHANGE_GPS_MAX_DELTA_DEG && Math.abs(devFromStart) <= LANE_CHANGE_MAX_NET_HEADING_DEG) {
        foundReversal = true;
        break;
      }
    }
    if (!foundReversal) continue;

    laneChanges.push({
      type: LANE_CHANGE_EVENT_TYPE,
      timestamp: p.timestamp,
      lat: p.lat,
      lng: p.lng,
      speed_kmh: Math.round(speed),
      lateral_g: null,
      direction: initialDelta > 0 ? 'right' : 'left',
      simultaneous_braking: false,
      detection_method: 'gps_bilateral_heading',
      confidence: 'low',
    });
    suppressUntilMs = windowEnd;
  }

  return {
    lane_changes: laneChanges,
    lane_change_count: laneChanges.length,
    unsafe_lane_changes: laneChanges.filter((laneChange) => laneChange.simultaneous_braking).length,
    confidence: imuAvailable ? 'imu_calibrated' : 'gps_only',
    detection_method: imuAvailable ? 'imu_yaw_bilateral' : 'gps_bilateral_heading',
    curved_road_suppression_window_count: curvedRoadSuppressionWindows.length,
  };
}

export function calculateLaneChangingScore(laneChangeResult = {}, distKm = 0, thresholds = DEFAULT_THRESHOLDS) {
  const laneChanges = Array.isArray(laneChangeResult?.lane_changes) ? laneChangeResult.lane_changes : [];
  const count = laneChanges.length;
  const distanceKm = Math.max(0, Number(distKm) || 0);
  const unsafeLaneChanges = Math.max(0, Number(laneChangeResult?.unsafe_lane_changes) || 0);
  const confidence = laneChangeResult?.confidence || 'insufficient_data';

  if (distanceKm < 5 || count < 2) {
    return {
      lane_changing_score: null,
      lane_changing_rate_per_10km: count > 0 && distanceKm > 0 ? round1((count / distanceKm) * 10) : 0,
      lane_change_count: count,
      unsafe_lane_changes: unsafeLaneChanges,
      lane_changing_grade: 'unavailable',
      lane_changing_confidence: 'insufficient_data',
      lane_changing_confidence_multiplier: confidence === 'gps_only' ? 0.7 : 1.0,
    };
  }

  const ratePer10Km = (count / distanceKm) * 10;
  const ratePenalty = clamp(Math.round(ratePer10Km * 6), 0, 40);
  const safetyPenalty = clamp(unsafeLaneChanges * 15, 0, 40);
  const confidenceMultiplier = confidence === 'imu_calibrated' ? 1.0 : 0.7;
  const rawScore = Math.max(0, 100 - ratePenalty - safetyPenalty);
  const laneChangingScore = clamp(Math.round(rawScore), 0, 100);

  return {
    lane_changing_score: laneChangingScore,
    lane_changing_rate_per_10km: round1(ratePer10Km),
    lane_change_count: count,
    unsafe_lane_changes: unsafeLaneChanges,
    lane_changing_grade: laneChangingScore >= 85 ? 'smooth' : laneChangingScore >= 70 ? 'acceptable' : laneChangingScore >= 50 ? 'frequent' : 'erratic',
    lane_changing_confidence: confidence,
    lane_changing_confidence_multiplier: confidenceMultiplier,
  };
}

export function detectHighwayMergeBehavior(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  let mergeEventCount = 0;
  let poorMergeCount = 0;
  let harshMergeCount = 0;
  let windowStart = null;
  let windowPeakAccel = 0;
  const entrySpeedThreshold = thresholds.MERGE_ENTRY_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_ENTRY_SPEED_KMH;
  const exitSpeedThreshold = thresholds.MERGE_EXIT_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_EXIT_SPEED_KMH;

  for (let i = 0; i < cleanPoints.length; i++) {
    const point = cleanPoints[i];
    const speed = finiteSpeed(point);
    if (!windowStart && speed > 20 && speed < entrySpeedThreshold) {
      windowStart = point;
      windowPeakAccel = 0;
      continue;
    }

    if (!windowStart) continue;

    const duration = (timestampMs(point) - timestampMs(windowStart)) / 1000;
    if (duration <= 0) continue;
    if (duration > 20) {
      windowStart = speed > 20 && speed < entrySpeedThreshold ? point : null;
      windowPeakAccel = 0;
      continue;
    }

    const previous = cleanPoints[i - 1];
    if (previous) {
      const dt = (timestampMs(point) - timestampMs(previous)) / 1000;
      if (dt > 0 && dt <= 10) {
        windowPeakAccel = Math.max(windowPeakAccel, calculateAcceleration(finiteSpeed(previous), speed, dt));
      }
    }

    if (speed >= exitSpeedThreshold) {
      const entrySpeed = finiteSpeed(windowStart);
      const exitSpeed = speed;
      const accelMs2 = ((exitSpeed / 3.6) - (entrySpeed / 3.6)) / duration;
      const quality = exitSpeed < exitSpeedThreshold || duration < 5
        ? 'poor'
        : accelMs2 > 3.8 || windowPeakAccel > 4.5
          ? 'harsh'
          : 'good';

      mergeEventCount++;
      if (quality === 'poor') poorMergeCount++;
      if (quality === 'harsh') harshMergeCount++;
      windowStart = null;
      windowPeakAccel = 0;
    }
  }

  return {
    merge_event_count: mergeEventCount,
    poor_merge_count: poorMergeCount,
    harsh_merge_count: harshMergeCount,
    merge_score: mergeEventCount > 0
      ? Math.max(0, Math.round(
        100 - (poorMergeCount / mergeEventCount) * 40 - (harshMergeCount / mergeEventCount) * 30
      ))
      : null,
  };
}
