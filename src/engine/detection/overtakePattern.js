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
import {
  analyzeFatigueProgression,
  calculateSegmentStats,
  detectDrowsyDriving,
  detectHeadingDriftBeta,
  scoreFatigueSegment,
  scoreSegmentPoints
} from './headingDrift.js';

export function detectAggressiveOvertakes(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!cleanPoints || cleanPoints.length < 5) {
    return Object.assign(events, { overtake_event_count: 0, overtake_score: null, overtake_beta: true });
  }

  const accelThreshold = thresholds.threshold_overtake_accel_ms2 ?? DEFAULT_THRESHOLDS.threshold_overtake_accel_ms2;
  const baselineSpeedKmh = thresholds.OVERTAKE_MIN_BASELINE_SPEED_KMH ?? 80;
  const minimumStraightDistanceKm = thresholds.OVERTAKE_MIN_STRAIGHT_DISTANCE_KM ?? 1;
  const straightHeadingStdMaxDeg = thresholds.OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG ?? 4;
  let lastEventTime = 0;
  for (let i = 0; i < cleanPoints.length; i++) {
    const start = cleanPoints[i];
    const startMs = timestampMs(start);
    if (startMs - lastEventTime < 15000) continue;
    let baselineDistanceKm = 0;
    const baselinePoints = [start];
    for (let k = i; k > 0 && baselineDistanceKm < minimumStraightDistanceKm; k--) {
      const previous = cleanPoints[k - 1];
      const current = cleanPoints[k];
      const segment = calculateSegmentMetrics(previous, current, thresholds);
      if (segment.dt <= 0 || segment.dt > 10 || segment.isNoise || finiteSpeed(previous) < baselineSpeedKmh) break;
      baselineDistanceKm += segment.distanceKm;
      baselinePoints.unshift(previous);
    }
    const baselineHeadings = baselinePoints.map((point, index) => headingForIndex(baselinePoints, index));
    if (baselineDistanceKm < minimumStraightDistanceKm || calculateAngularStdDev(baselineHeadings) > straightHeadingStdMaxDeg) continue;
    const window = cleanPoints
      .slice(i)
      .filter((point) => timestampMs(point) >= startMs && timestampMs(point) <= startMs + 15000);
    if (window.length < 5 || !window.every((point) => finiteSpeed(point) > baselineSpeedKmh)) continue;

    let phase = 'NONE';
    let accelSeconds = 0;
    let accelEndMs = null;
    let changeMs = null;
    let changePoint = null;
    let maxAccel = 0;
    let minDecel = 0;
    let headingRatePeak = 0;
    let peakSpeedDelta = 0;
    let outboundDirection = 0;
    let returnDetected = false;
    const baselineHeading = baselineHeadings[baselineHeadings.length - 1];

    for (let j = 1; j < window.length; j++) {
      const prev = window[j - 1];
      const curr = window[j];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 5) continue;
      const prevSpeed = reliablePointSpeed(cleanPoints, i + j - 1, thresholds) ?? finiteSpeed(prev);
      const currSpeed = reliablePointSpeed(cleanPoints, i + j, thresholds) ?? finiteSpeed(curr);
      const accel = calculateAcceleration(prevSpeed, currSpeed, dt);
      const { h1, h2 } = headingBetweenPair(prev, curr, window[j - 2] || null);
      const signedTurnRate = signedHeadingDelta(h1, h2) / dt;
      const headingRate = Math.abs(signedTurnRate);
      peakSpeedDelta = Math.max(peakSpeedDelta, currSpeed - finiteSpeed(start));

      if (phase === 'NONE') {
        if (accel > accelThreshold) {
          accelSeconds += dt;
          maxAccel = Math.max(maxAccel, accel);
          if (accelSeconds >= 2) {
            phase = 'ACCEL';
            accelEndMs = timestampMs(curr);
          }
        } else {
          accelSeconds = 0;
        }
      } else if (phase === 'ACCEL') {
        maxAccel = Math.max(maxAccel, accel);
        if ((timestampMs(curr) - accelEndMs) / 1000 > 5) break;
        if (headingRate > 15) {
          phase = 'CHANGE';
          changeMs = timestampMs(curr);
          changePoint = curr;
          headingRatePeak = headingRate;
          outboundDirection = Math.sign(signedTurnRate);
        }
      } else if (phase === 'CHANGE') {
        headingRatePeak = Math.max(headingRatePeak, headingRate);
        const returnedHeading = headingDiff(baselineHeading, headingForIndex(window, j)) <= straightHeadingStdMaxDeg * 2;
        if (outboundDirection !== 0 && Math.sign(signedTurnRate) === -outboundDirection && headingRate > 15 && returnedHeading) {
          returnDetected = true;
        }
        if ((timestampMs(curr) - changeMs) / 1000 > 10) break;
        if (returnDetected && accel < -2.5 && peakSpeedDelta >= 12 && headingRatePeak >= 18) {
          minDecel = Math.min(minDecel, accel);
          const severity = maxAccel > 5.0 && minDecel < -4.0 && headingRatePeak > 30
            ? 'high'
            : maxAccel > 4.0 && minDecel < -3.0
              ? 'medium'
              : 'low';
          events.push({
            type: EVENT_TYPES.AGGRESSIVE_OVERTAKE,
            severity,
            lat: changePoint?.lat ?? curr.lat,
            lng: changePoint?.lng ?? curr.lng,
            timestamp: changePoint?.timestamp ?? curr.timestamp,
            value: round1(maxAccel),
            speed_kmh: Math.round(currSpeed),
            confidence_level: 'low',
            beta: true,
            diagnostic_only: true,
            signals_triggered: ['straight_highway_baseline', 'acceleration', 'bilateral_heading_return', 'deceleration'],
          });
          lastEventTime = startMs;
          break;
        }
      }
    }
  }

  return Object.assign(events, {
    overtake_event_count: events.length,
    overtake_score: null,
    overtake_beta: true,
  });
}
