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
} from './speeding.js';
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
  speedLimitForIndex
} from './cornering.js';

export function calculateSegmentStats(points = [], thresholds = DEFAULT_THRESHOLDS) {
  const start = timestampMs(points[0]);
  const end = timestampMs(points[points.length - 1]);
  const distanceKm = calculateRouteDistanceKm(points, thresholds);
  const durationSeconds = Math.max(0, (end - start) / 1000);
  return {
    distance_km: distanceKm,
    duration_seconds: durationSeconds,
    avg_speed_kmh: durationSeconds > 0 ? calculateSpeedKmh(distanceKm, durationSeconds) : 0,
    idle_time_seconds: 0,
    fatigue_risk_score: 0,
    intersection_score: null,
  };
}

export function scoreSegmentPoints(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 3) return null;
  const { events, phoneUse } = detectDrivingEvents(points, thresholds);
  const stats = calculateSegmentStats(points, thresholds);
  return calculateTripScores(events, stats, points, thresholds, stats.duration_seconds, phoneUse).component_scores.overall.value;
}

export function scoreFatigueSegment(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 3) return null;

  const harshBrakeThreshold = thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  const rapidAccelThreshold = thresholds.RAPID_ACCEL_MS2 ?? DEFAULT_THRESHOLDS.RAPID_ACCEL_MS2;
  let distanceKm = 0;
  let penalty = 0;
  const speeds = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segment = calculateSegmentMetrics(prev, curr, thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

    distanceKm += segment.distanceKm;
    const prevSpeed = reliablePointSpeed(points, i - 1, thresholds) ?? finiteSpeed(prev);
    const currSpeed = reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(curr);
    speeds.push(currSpeed);

    const accelMs2 = calculateAcceleration(prevSpeed, currSpeed, segment.dt);
    if (accelMs2 < -harshBrakeThreshold) penalty += 6;
    if (accelMs2 > rapidAccelThreshold) penalty += 5;

    const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
    const headingRate = headingDiff(h1, h2) / segment.dt;
    if (currSpeed > 30 && headingRate > 25) penalty += 4;
  }

  if (speeds.length >= 3) {
    const variability = speedStdDev(speeds);
    if (variability > 25) penalty += 8;
    else if (variability > 15) penalty += 4;
  }

  const distFactor = Math.max(1, distanceKm);
  return Math.max(20, Math.round(100 - Math.min((penalty / distFactor) * 8, 80)));
}

export function analyzeFatigueProgression(cleanPoints = [], startTimeMs, endTimeMs, thresholds = DEFAULT_THRESHOLDS) {
  const start = Number.isFinite(startTimeMs) ? startTimeMs : timestampMs(cleanPoints[0]);
  const end = Number.isFinite(endTimeMs) ? endTimeMs : timestampMs(cleanPoints[cleanPoints.length - 1]);
  const totalDuration = end - start;
  if (!cleanPoints.length || totalDuration <= 0) {
    return { fatigue_progression: 'unknown', segment_scores: [] };
  }

  const segmentDurationMs = FATIGUE_SEGMENT_SECONDS * 1000;
  const segmentCount = Math.ceil(totalDuration / segmentDurationMs);
  const segments = Array.from({ length: segmentCount }, () => []);
  for (const point of cleanPoints) {
    const offset = timestampMs(point) - start;
    const index = Math.min(segmentCount - 1, Math.max(0, Math.floor(offset / segmentDurationMs)));
    segments[index].push(point);
  }

  const pointIndexes = new Map(cleanPoints.map((point, index) => [point, index]));
  const observed = segments
    .map((segment, index) => segment.length >= 3
      ? {
        start_index: pointIndexes.get(segment[0]),
        end_index: pointIndexes.get(segment[segment.length - 1]),
        minute_offset: Math.round((index * FATIGUE_SEGMENT_SECONDS / 60) * 10) / 10,
        score: scoreFatigueSegment(segment, thresholds),
      }
      : null)
    .filter(Boolean);
  if (observed.length < 3) {
    return { fatigue_progression: 'unknown', segment_scores: [] };
  }

  const third = Math.max(1, Math.floor(observed.length / 3));
  const earlyScore = average(observed.slice(0, third).map((segment) => segment.score));
  const lateScore = average(observed.slice(-third).map((segment) => segment.score));
  const degradation = earlyScore - lateScore;
  const fatigueProgression = degradation >= 20
    ? 'significant'
    : degradation >= 10
      ? 'moderate'
      : degradation >= 0
        ? 'slight'
        : 'improving';

  return {
    fatigue_progression: fatigueProgression,
    fatigue_heatmap: { segments: observed, segment_seconds: FATIGUE_SEGMENT_SECONDS },
    segment_scores: observed.map((segment) => segment.score),
    degradation: Math.round(degradation),
  };
}

export function detectHeadingDriftBeta(cleanPoints = [], durationSeconds = 0, thresholds = DEFAULT_THRESHOLDS) {
  if (!cleanPoints || cleanPoints.length < 4 || durationSeconds <= 0) {
    return {
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
    };
  }

  const headingThreshold = thresholds.HEADING_DRIFT_STD_DEG ?? thresholds.threshold_drowsy_heading_std ?? DEFAULT_THRESHOLDS.HEADING_DRIFT_STD_DEG;
  const startTime = timestampMs(cleanPoints[0]);
  const timestamps = cleanPoints.map((point) => timestampMs(point));
  const speeds = cleanPoints.map((point) => finiteSpeed(point));
  const headingRadians = cleanPoints.map((_, index) => toRad(headingForIndex(cleanPoints, index)));
  let headingDriftWindowCount = 0;
  let weightedScore = 0;
  let end = -1;
  let speedSum = 0;
  let speedSumSq = 0;
  let fastSpeedCount = 0;
  let sinSum = 0;
  let cosSum = 0;

  const addIndex = (index) => {
    const speed = speeds[index];
    speedSum += speed;
    speedSumSq += speed * speed;
    if (speed > 80) fastSpeedCount++;
    sinSum += Math.sin(headingRadians[index]);
    cosSum += Math.cos(headingRadians[index]);
  };

  const removeIndex = (index) => {
    const speed = speeds[index];
    speedSum -= speed;
    speedSumSq -= speed * speed;
    if (speed > 80) fastSpeedCount--;
    sinSum -= Math.sin(headingRadians[index]);
    cosSum -= Math.cos(headingRadians[index]);
  };

  for (let i = 0; i < cleanPoints.length; i++) {
    const startMs = timestamps[i];
    while (end + 1 < cleanPoints.length && timestamps[end + 1] <= startMs + 300000) {
      end++;
      addIndex(end);
    }

    const windowLength = end - i + 1;
    if (windowLength < 4) {
      removeIndex(i);
      continue;
    }
    if ((timestamps[end] - startMs) < 270000) {
      removeIndex(i);
      continue;
    }
    if (fastSpeedCount !== windowLength) {
      removeIndex(i);
      continue;
    }

    const sinMean = sinSum / windowLength;
    const cosMean = cosSum / windowLength;
    const R = Math.sqrt(sinMean * sinMean + cosMean * cosMean);
    const windowHeadingStdDev = (R < 1 ? Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) : 0) * 180 / Math.PI;
    const windowSpeedStdDev = speedStdDevFromSummary(windowLength, speedSum, speedSumSq);
    if (windowHeadingStdDev > headingThreshold && windowSpeedStdDev < 6) {
      const elapsedFraction = Math.max(0, (startMs - startTime) / 1000) / Math.max(1, durationSeconds);
      weightedScore += (1 + elapsedFraction);
      headingDriftWindowCount++;
      const nextIndex = i + Math.max(1, windowLength - 1);
      while (i < nextIndex && i < cleanPoints.length) {
        removeIndex(i);
        i++;
      }
      i--;
      continue;
    }

    removeIndex(i);
  }

  const riskScore = Math.min(100, Math.round(weightedScore * 15));
  return {
    heading_drift_beta_window_count: headingDriftWindowCount,
    heading_drift_beta_weighted_contribution: round2(weightedScore),
    heading_drift_beta_score: riskScore,
    heading_drift_beta_level: riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : riskScore > 0 ? 'low' : 'none',
    heading_drift_beta_confidence: 'low',
  };
}

// Compatibility export for callers compiled against older versions.
export const detectDrowsyDriving = detectHeadingDriftBeta;
