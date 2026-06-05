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

export function perpendicularDistanceMeters(point, lineStart, lineEnd) {
  const dx = lineEnd.lng - lineStart.lng;
  const dy = lineEnd.lat - lineStart.lat;
  if (dx === 0 && dy === 0) {
    return haversineMeters(point.lat, point.lng, lineStart.lat, lineStart.lng);
  }

  const t = ((point.lng - lineStart.lng) * dx + (point.lat - lineStart.lat) * dy) / (dx * dx + dy * dy);
  const tClamped = Math.max(0, Math.min(1, t));
  const closestLat = lineStart.lat + tClamped * dy;
  const closestLng = lineStart.lng + tClamped * dx;
  return haversineMeters(point.lat, point.lng, closestLat, closestLng);
}

export function simplifyRoute(points = [], toleranceMeters = 10, events = []) {
  const validPoints = points.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  if (validPoints.length <= 2) return validPoints;

  const keepFlags = new Array(validPoints.length).fill(false);
  keepFlags[0] = true;
  keepFlags[validPoints.length - 1] = true;

  for (const event of events || []) {
    if (!Number.isFinite(event?.lat) || !Number.isFinite(event?.lng)) continue;
    let nearestIndex = 0;
    let nearestMeters = Infinity;
    validPoints.forEach((point, index) => {
      const meters = haversineMeters(point.lat, point.lng, event.lat, event.lng);
      if (meters < nearestMeters) {
        nearestMeters = meters;
        nearestIndex = index;
      }
    });
    keepFlags[nearestIndex] = true;
  }

  const reduce = (start, end) => {
    if (end <= start + 1) return;

    let maxDistance = 0;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      if (keepFlags[i]) continue;
      const distance = perpendicularDistanceMeters(validPoints[i], validPoints[start], validPoints[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    if (maxDistance > toleranceMeters) {
      keepFlags[maxIndex] = true;
      reduce(start, maxIndex);
      reduce(maxIndex, end);
    }
  };

  const anchors = keepFlags
    .map((keep, index) => keep ? index : null)
    .filter((index) => index !== null)
    .sort((a, b) => a - b);

  for (let i = 1; i < anchors.length; i++) {
    reduce(anchors[i - 1], anchors[i]);
  }

  return validPoints.filter((_, index) => keepFlags[index]);
}
