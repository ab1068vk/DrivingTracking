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
} from './downsampler.js';

export function finiteVehicleSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed >= 0 && speed <= 260 ? speed : null;
}

export function obdSpeedTimestampMs(point) {
  return parseTimestampMs(point?.obd_speed_timestamp ?? point?.obd_data_timestamp);
}

export function gpsSpeedTimestampMs(point) {
  return parseTimestampMs(point?.gps_speed_timestamp ?? point?.timestamp ?? point?.time);
}

export function speedSourceForPoint(point, thresholds = DEFAULT_THRESHOLDS) {
  if (!point) return null;
  const gpsSpeed = finiteVehicleSpeed(point.speed_kmh);
  const obdSpeed = finiteVehicleSpeed(point.obd_speed_kmh);
  if (obdSpeed == null) return gpsSpeed == null ? null : 'gps';
  if (point.speed_source === 'obd' || point.vehicle_speed_source === 'obd') return 'obd_bluetooth';
  if (gpsSpeed == null) return 'obd_bluetooth';

  const fallbackAccuracy = thresholds.OBD_SPEED_FALLBACK_ACCURACY_M ?? OBD_SPEED_FALLBACK_ACCURACY_M;
  if (Number(point.accuracy) <= fallbackAccuracy) return 'gps';

  const gpsMs = gpsSpeedTimestampMs(point);
  const obdMs = obdSpeedTimestampMs(point);
  if (gpsMs != null && obdMs != null) {
    const maxAgeMs = thresholds.OBD_SPEED_MAX_SAMPLE_AGE_MS ?? OBD_SPEED_MAX_SAMPLE_AGE_MS;
    return obdMs >= gpsMs || Math.abs(gpsMs - obdMs) <= maxAgeMs ? 'obd_bluetooth' : 'gps';
  }
  return 'obd_bluetooth';
}

export function vehicleSpeedKmh(point, thresholds = DEFAULT_THRESHOLDS) {
  const source = speedSourceForPoint(point, thresholds);
  if (source === 'obd_bluetooth') return finiteVehicleSpeed(point?.obd_speed_kmh);
  return finiteVehicleSpeed(point?.speed_kmh);
}

export function finiteSpeed(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds) ?? 0;
}

export function pointSpeedKmh(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds);
}

export function isLikelySpeedSpike(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  thresholds = thresholds || DEFAULT_THRESHOLDS;
  const speed = pointSpeedKmh(points[index], thresholds);
  if (speed == null) return false;

  const previousSpeed = pointSpeedKmh(points[index - 1], thresholds);
  const nextSpeed = pointSpeedKmh(points[index + 1], thresholds);
  const neighborSpeeds = [previousSpeed, nextSpeed].filter((value) => value != null);
  if (!neighborSpeeds.length) return false;

  const spikeDelta = thresholds.MAX_SPEED_SPIKE_DELTA_KMH ?? DEFAULT_THRESHOLDS.MAX_SPEED_SPIKE_DELTA_KMH;
  const spikeRatio = thresholds.MAX_SPEED_SPIKE_RATIO ?? DEFAULT_THRESHOLDS.MAX_SPEED_SPIKE_RATIO;
  const neighborMax = Math.max(...neighborSpeeds);
  if (speed - neighborMax <= spikeDelta || speed <= Math.max(1, neighborMax) * spikeRatio) return false;

  let maxAdjacentImplied = 0;
  if (points[index - 1]) {
    const previousSegment = calculateSegmentMetrics(points[index - 1], points[index], thresholds);
    if (previousSegment.dt > 0 && previousSegment.dt <= 120 && !previousSegment.isNoise) {
      maxAdjacentImplied = Math.max(maxAdjacentImplied, previousSegment.impliedSpeedKmh);
    }
  }
  if (points[index + 1]) {
    const nextSegment = calculateSegmentMetrics(points[index], points[index + 1], thresholds);
    if (nextSegment.dt > 0 && nextSegment.dt <= 120 && !nextSegment.isNoise) {
      maxAdjacentImplied = Math.max(maxAdjacentImplied, nextSegment.impliedSpeedKmh);
    }
  }

  return speed - maxAdjacentImplied > spikeDelta;
}

export function reliablePointSpeed(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
  return isLikelySpeedSpike(points, index, thresholds) ? null : pointSpeedKmh(points[index], thresholds);
}

export function round1(value) {
  return Math.round(value * 10) / 10;
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}

export function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function safeMax(values = [], fallback = 0) {
  return values.length ? Math.max(...values) : fallback;
}

export function percentileValue(values, p) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function isPrivacyBoundaryPoint(point) {
  return point?.privacy_boundary === true || point?.is_privacy_boundary === true;
}

export function privacyZoneKey(point) {
  return point?.privacy_zone_id ?? point?.privacy_zone_label ?? point?.privacy_zone_name ?? point?.zone_id ?? null;
}

export function samePrivacyZoneBoundary(a, b) {
  const zoneA = privacyZoneKey(a);
  const zoneB = privacyZoneKey(b);
  return zoneA == null || zoneB == null || String(zoneA) === String(zoneB);
}

export function calculateEstimatedPrivateDistanceKm(points = [], { includeAdjacentBoundaries = true } = {}) {
  let distance = 0;
  let pendingBoundary = null;
  let crossedMaskedGap = false;

  for (const point of points || []) {
    const validBoundary = isPrivacyBoundaryPoint(point) && hasValidCoordinates(point);
    if (validBoundary) {
      if (
        pendingBoundary &&
        samePrivacyZoneBoundary(pendingBoundary, point) &&
        (crossedMaskedGap || includeAdjacentBoundaries)
      ) {
        distance += haversineDistance(pendingBoundary.lat, pendingBoundary.lng, point.lat, point.lng);
        pendingBoundary = null;
        crossedMaskedGap = false;
      } else {
        pendingBoundary = point;
        crossedMaskedGap = false;
      }
      continue;
    }

    if (!hasValidCoordinates(point)) {
      if (pendingBoundary) crossedMaskedGap = true;
      continue;
    }

    pendingBoundary = null;
    crossedMaskedGap = false;
  }

  return distance;
}

export function calculateRouteDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) distance += segment.distanceKm;
  }
  return distance + calculateEstimatedPrivateDistanceKm(points, { includeAdjacentBoundaries: false });
}

export function calculateTerminalStoppedSeconds(points = [], endTime = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!points?.length || !endTime) return 0;
  const lastIndex = points.length - 1;
  const lastPoint = points[lastIndex];
  const lastMs = timestampMs(lastPoint);
  const endMs = parseTimestampMs(endTime);
  if (endMs == null || endMs <= lastMs) return 0;

  const lastSpeed = reliablePointSpeed(points, lastIndex, thresholds) ?? finiteSpeed(lastPoint);
  const idleSpeed = thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH;
  if (lastSpeed >= idleSpeed) return 0;

  const maxTerminalIdle = thresholds.MAX_TERMINAL_IDLE_SECONDS ?? DEFAULT_THRESHOLDS.MAX_TERMINAL_IDLE_SECONDS;
  return Math.min(maxTerminalIdle, (endMs - lastMs) / 1000);
}

export function complianceFallbackLimit(roadType, thresholds = DEFAULT_THRESHOLDS) {
  if (roadType === 'highway') return thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  if (roadType === 'residential') return 40;
  return 60;
}

export function classifyRoadType(cleanPoints = []) {
  const speeds = cleanPoints
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed > 0);

  if (!speeds.length) {
    return {
      road_type: 'urban',
      avg_highway_speed_kmh: 0,
      avg_urban_speed_kmh: 0,
      highway_fraction: 0,
    };
  }

  const highwaySpeeds = speeds.filter((speed) => speed >= 80);
  const urbanSpeeds = speeds.filter((speed) => speed >= 20 && speed < 80);
  const residentialSpeeds = speeds.filter((speed) => speed < 20);
  const total = speeds.length;
  const fHighway = highwaySpeeds.length / total;
  const fUrban = urbanSpeeds.length / total;
  const fResidential = residentialSpeeds.length / total;
  const avgSpeed = average(speeds);

  let roadType = 'urban';
  if (fHighway >= 0.60) roadType = 'highway';
  else if (fHighway >= 0.30 && fUrban >= 0.30) roadType = 'mixed';
  else if (fResidential >= 0.50 && avgSpeed < 30) roadType = 'residential';

  return {
    road_type: roadType,
    avg_highway_speed_kmh: round1(average(highwaySpeeds)),
    avg_urban_speed_kmh: round1(average(urbanSpeeds)),
    highway_fraction: round1(fHighway * 100) / 100,
  };
}

export function normalizeRoadTypeLabel(roadType, point = {}) {
  if (roadType === 'highway' || roadType === 'urban' || roadType === 'residential') return roadType;
  const speed = finiteSpeed(point);
  if (speed >= 80) return 'highway';
  if (speed < 30) return 'residential';
  return 'urban';
}

export function classifyRoadTypesByPoint(routePoints = [], windowSize = 30) {
  const points = routePoints || [];
  const halfWindow = Math.max(1, Math.floor(windowSize / 2));
  return points.map((point, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(points.length, index + halfWindow + 1);
    return normalizeRoadTypeLabel(classifyRoadType(points.slice(start, end)).road_type, point);
  });
}

export function nearestPointIndexByTimestamp(routePoints = [], event = {}) {
  if (Number.isInteger(event.point_index) && event.point_index >= 0 && event.point_index < routePoints.length) {
    return event.point_index;
  }
  const eventMs = timestampMs(event);
  if (!Number.isFinite(eventMs)) return -1;
  let low = 0;
  let high = routePoints.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const middleMs = timestampMs(routePoints[middle]);
    if (middleMs === eventMs) return middle;
    if (middleMs < eventMs) low = middle + 1;
    else high = middle - 1;
  }
  const candidates = [low, high].filter((index) => index >= 0 && index < routePoints.length);
  return candidates.reduce((nearest, index) => (
    nearest < 0 || Math.abs(timestampMs(routePoints[index]) - eventMs) < Math.abs(timestampMs(routePoints[nearest]) - eventMs)
      ? index
      : nearest
  ), -1);
}

export function zoneFromP85(p85Speed) {
  if (p85Speed < 30) return { inferredZone: 'zone_30', inferredZoneKmh: 30 };
  if (p85Speed < 55) return { inferredZone: 'zone_50', inferredZoneKmh: 50 };
  if (p85Speed < 80) return { inferredZone: 'zone_60_70', inferredZoneKmh: 70 };
  if (p85Speed < 110) return { inferredZone: 'zone_80_100', inferredZoneKmh: 100 };
  return { inferredZone: 'zone_highway', inferredZoneKmh: 120 };
}

export function sortedInsert(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  values.splice(low, 0, value);
}

export function sortedRemove(values, value) {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < value) low = mid + 1;
    else if (values[mid] > value) high = mid - 1;
    else {
      values.splice(mid, 1);
      return;
    }
  }
}

export function percentileFromSorted(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

export function speedStdDevFromSummary(count, sum, sumSq) {
  if (count < 2) return 0;
  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return Math.sqrt(variance);
}

export function createRoadTypeWindowSummary() {
  return {
    total: 0,
    sum: 0,
    highway: 0,
    urban: 0,
    residential: 0,
  };
}

export function updateRoadTypeWindowSummary(summary, point, direction) {
  const speed = Number(point?.speed_kmh);
  if (!Number.isFinite(speed) || speed <= 0) return;
  summary.total += direction;
  summary.sum += speed * direction;
  if (speed >= 80) summary.highway += direction;
  else if (speed >= 20) summary.urban += direction;
  else summary.residential += direction;
}

export function roadTypeFromWindowSummary(summary) {
  if (!summary.total) {
    return {
      road_type: 'urban',
      highway_fraction: 0,
    };
  }

  const fHighway = summary.highway / summary.total;
  const fUrban = summary.urban / summary.total;
  const fResidential = summary.residential / summary.total;
  const avgSpeed = summary.sum / summary.total;
  let roadType = 'urban';
  if (fHighway >= 0.60) roadType = 'highway';
  else if (fHighway >= 0.30 && fUrban >= 0.30) roadType = 'mixed';
  else if (fResidential >= 0.50 && avgSpeed < 30) roadType = 'residential';

  return {
    road_type: roadType,
    highway_fraction: round1(fHighway * 100) / 100,
  };
}

export function createZoneLookup(zones = []) {
  let cursor = 0;
  return (index) => {
    while (cursor < zones.length && index > zones[cursor].endIndex) cursor++;
    const zone = zones[cursor];
    return zone && index >= zone.startIndex && index <= zone.endIndex ? zone : null;
  };
}

export function inferSpeedZones(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = (routePoints || [])
    .map((point, index) => ({ point, index, ts: timestampMs(point), speed: reliablePointSpeed(routePoints, index, thresholds) }))
    .filter((entry) => Number.isFinite(entry.ts) && hasValidCoordinates(entry.point));
  if (points.length < 2) return [];

  const zones = [];
  const speeds = [];
  const roadSummary = createRoadTypeWindowSummary();
  let speedSum = 0;
  let speedSumSq = 0;
  let speedCount = 0;
  let end = -1;

  const addEntry = (entry) => {
    if (Number.isFinite(entry.speed)) {
      sortedInsert(speeds, entry.speed);
      speedSum += entry.speed;
      speedSumSq += entry.speed * entry.speed;
      speedCount++;
    }
    updateRoadTypeWindowSummary(roadSummary, entry.point, 1);
  };

  const removeEntry = (entry) => {
    if (Number.isFinite(entry.speed)) {
      sortedRemove(speeds, entry.speed);
      speedSum -= entry.speed;
      speedSumSq -= entry.speed * entry.speed;
      speedCount--;
    }
    updateRoadTypeWindowSummary(roadSummary, entry.point, -1);
  };

  for (let start = 0; start < points.length - 1; start++) {
    const startTs = points[start].ts;
    while (end + 1 < points.length && points[end + 1].ts - startTs <= 60000) {
      end++;
      addEntry(points[end]);
    }
    if (end <= start) {
      removeEntry(points[start]);
      continue;
    }

    if (speeds.length < 2) {
      removeEntry(points[start]);
      continue;
    }

    const medianSpeed = percentileFromSorted(speeds, 50);
    const p85Speed = percentileFromSorted(speeds, 85);
    const deviation = speedStdDevFromSummary(speedCount, speedSum, speedSumSq);
    const { road_type: roadType, highway_fraction: highwayFraction } = roadTypeFromWindowSummary(roadSummary);
    const zone = zoneFromP85(p85Speed);
    const inferredLimitKmh = Math.min(zone.inferredZoneKmh, complianceFallbackLimit(roadType, thresholds));
    zones.push({
      startIndex: points[start].index,
      endIndex: points[end].index,
      inferredZone: zone.inferredZone,
      inferredZoneKmh: zone.inferredZoneKmh,
      inferredLimitKmh,
      confidence: deviation < 8 ? 'high' : deviation < 18 ? 'medium' : 'low',
      median_speed_kmh: round1(medianSpeed),
      p85_speed_kmh: round1(p85Speed),
      road_type: roadType,
      road_type_fraction: highwayFraction,
      speed_std_dev: round1(deviation),
      threshold_kmh: zone.inferredZone === 'zone_highway'
        ? thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH
        : zone.inferredZoneKmh + (thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH),
    });

    removeEntry(points[start]);
  }

  return zones;
}
