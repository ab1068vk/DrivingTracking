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
  HEADING_DRIFT_CIRCADIAN_MULTIPLIER,
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
} from '../scoring/ecoScore.js';
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
} from './harshAcceleration.js';
import {
  detectCloseProximityManeuverAlerts,
  detectNearMisses,
  detectStopStartPatterns,
  detectStopStartPatternsForMode,
  detectTailgateCycles,
  medianMovingSpeedKmh
} from './gpsTailgate.js';

export function calculateWindowStats(speedArray = []) {
  const mean = average(speedArray);
  const variance = speedArray.length ? average(speedArray.map((speed) => (speed - mean) ** 2)) : 0;
  const stddev = Math.sqrt(variance);
  return {
    mean,
    stddev,
    oscillationRatio: stddev / Math.max(1, mean),
  };
}

export function stddev(values = []) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
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

export function calculateAngularStdDev(headings = []) {
  const finite = headings.filter((heading) => Number.isFinite(heading));
  if (finite.length < 2) return 0;

  const vectors = finite.map((heading) => {
    const rad = toRad(heading);
    return { x: Math.cos(rad), y: Math.sin(rad) };
  });
  const meanX = average(vectors.map((vector) => vector.x));
  const meanY = average(vectors.map((vector) => vector.y));
  const meanAngle = Math.atan2(meanY, meanX) * 180 / Math.PI;
  const deltas = finite.map((heading) => signedHeadingDelta(meanAngle, heading));
  return stddev(deltas);
}

export function detectErraticSpeedWindows(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const samples = cleanPoints
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: reliablePointSpeed(cleanPoints, index, thresholds) ?? finiteSpeed(point),
    }))
    .filter((sample) => (
      Number.isFinite(sample.timestamp) &&
      sample.speed_kmh >= 15 &&
      sample.speed_kmh <= 65
    ))
    .sort((a, b) => a.timestamp - b.timestamp);

  const events = [];
  let distractionDurationSeconds = 0;
  if (samples.length < 4) return Object.assign(events, { distraction_duration_seconds: 0 });

  const flagged = [];
  const firstTime = samples[0].timestamp;
  const lastTime = samples[samples.length - 1].timestamp;
  const reversalAt = new Array(samples.length).fill(0);
  const directionChangeIndexes = [];
  let priorDirection = 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].speed_kmh - samples[i - 1].speed_kmh;
    const direction = Math.abs(delta) >= 4 ? Math.sign(delta) : 0;
    if (direction === 0) continue;
    if (priorDirection !== 0 && direction !== priorDirection) reversalAt[i] = 1;
    priorDirection = direction;
    directionChangeIndexes.push(i);
  }
  const reversalPrefix = reversalAt.reduce((prefix, value) => {
    prefix.push(prefix[prefix.length - 1] + value);
    return prefix;
  }, [0]);
  let left = 0;
  let right = 0;
  let sum = 0;
  let sumSquares = 0;
  let directionCursor = 0;
  const minDeque = [];
  const maxDeque = [];
  let minHead = 0;
  let maxHead = 0;
  for (let start = firstTime; start <= lastTime - 30000; start += 5000) {
    const end = start + 30000;
    while (right < samples.length && samples[right].timestamp <= end) {
      const speed = samples[right].speed_kmh;
      sum += speed;
      sumSquares += speed * speed;
      while (minDeque.length > minHead && samples[minDeque[minDeque.length - 1]].speed_kmh >= speed) minDeque.pop();
      while (maxDeque.length > maxHead && samples[maxDeque[maxDeque.length - 1]].speed_kmh <= speed) maxDeque.pop();
      minDeque.push(right);
      maxDeque.push(right);
      right++;
    }
    while (left < right && samples[left].timestamp < start) {
      const speed = samples[left].speed_kmh;
      sum -= speed;
      sumSquares -= speed * speed;
      if (minDeque[minHead] === left) minHead++;
      if (maxDeque[maxHead] === left) maxHead++;
      left++;
    }
    while (directionCursor < directionChangeIndexes.length && directionChangeIndexes[directionCursor] <= left) {
      directionCursor++;
    }
    const count = right - left;
    if (count < 4 || samples[right - 1].timestamp - samples[left].timestamp < 25000) continue;

    const mean = sum / count;
    const deviation = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
    const oscillationRatio = deviation / Math.max(1, mean);
    const speedRange = samples[maxDeque[maxHead]].speed_kmh - samples[minDeque[minHead]].speed_kmh;
    const firstDirectionChange = directionChangeIndexes[directionCursor];
    const reversals = firstDirectionChange != null && firstDirectionChange < right
      ? reversalPrefix[right] - reversalPrefix[firstDirectionChange + 1]
      : 0;
    if (oscillationRatio > 0.28 && deviation >= 8 && speedRange >= 18 && reversals >= 2) {
      flagged.push({ start, end, point: samples[left].point });
    }
  }

  const merged = [];
  for (const window of flagged) {
    const previous = merged[merged.length - 1];
    if (previous && (window.start - previous.end) / 1000 < 10) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  for (const episode of merged) {
    const durationSeconds = Math.round((episode.end - episode.start) / 1000);
    if (durationSeconds < 20) continue;
    distractionDurationSeconds += durationSeconds;
    events.push({
      type: EVENT_TYPES.ERRATIC_SPEED,
      severity: durationSeconds > 120 ? 'high' : durationSeconds > 60 ? 'medium' : 'low',
      lat: episode.point.lat,
      lng: episode.point.lng,
      timestamp: episode.point.timestamp,
      value: durationSeconds,
    });
  }

  return Object.assign(events, { distraction_duration_seconds: distractionDurationSeconds });
}

export function detectSpeedCreepWithThresholds(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const creepThreshold = thresholds.threshold_speed_creep_kmh ?? DEFAULT_THRESHOLDS.threshold_speed_creep_kmh;
  const samples = cleanPoints
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: reliablePointSpeed(cleanPoints, index, thresholds),
      heading: headingForIndex(cleanPoints, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.speed_kmh) && sample.speed_kmh > 0);
  let count = 0;
  let maxCreep = 0;
  const severityCounts = { low: 0, medium: 0, high: 0 };
  let lastEventTime = 0;
  let end = -1;

  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.timestamp - lastEventTime < 30000) continue;
    while (end + 1 < samples.length && samples[end + 1].timestamp <= start.timestamp + 30000) end++;

    const window = samples.slice(i, end + 1);
    if (window.length < 3 || window[window.length - 1].timestamp - start.timestamp < 25000) continue;

    const headingStdDev = calculateAngularStdDev(window.map((sample) => sample.heading));
    if (headingStdDev >= 5) continue;

    const creep = window[window.length - 1].speed_kmh - window[0].speed_kmh;
    if (creep >= creepThreshold && window[window.length - 1].speed_kmh > 80) {
      const severity = creep >= 25 ? 'high' : creep >= 15 ? 'medium' : 'low';
      severityCounts[severity]++;
      count++;
      maxCreep = Math.max(maxCreep, creep);
      lastEventTime = start.timestamp;
    }
  }

  const distKm = Math.max(1, calculateRouteDistanceKm(cleanPoints, thresholds));
  const speedCreepRatePer10Km = (count / distKm) * 10;

  return {
    speed_creep_event_count: count,
    max_speed_creep_kmh: Math.round(maxCreep),
    speed_creep_rate_per_10km: round1(speedCreepRatePer10Km),
    speed_creep_score: Math.max(0, 100 - speedCreepRatePer10Km * 12),
    speed_creep_severity_counts: severityCounts,
  };
}
