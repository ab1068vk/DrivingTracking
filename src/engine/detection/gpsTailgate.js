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

export function medianMovingSpeedKmh(points = [], minSpeedKmh = 5) {
  const speeds = points
    .map((point) => finiteSpeed(point))
    .filter((speed) => Number.isFinite(speed) && speed > minSpeedKmh)
    .sort((a, b) => a - b);
  return speeds.length ? percentileFromSorted(speeds, 50) : 0;
}

export function detectStopStartPatternsForMode(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS, mode = 'highway') {
  if (!cleanPoints || cleanPoints.length < 3) return [];

  const events = [];
  const urbanMode = mode === 'urban';
  const decelThreshold = urbanMode
    ? thresholds.STOP_START_URBAN_DECEL_MS2 ?? DEFAULT_THRESHOLDS.STOP_START_URBAN_DECEL_MS2
    : thresholds.STOP_START_DECEL_MS2 ?? thresholds.TAILGATE_DECEL_MS2 ?? DEFAULT_THRESHOLDS.STOP_START_DECEL_MS2;
  const stopStartMinSpeed = urbanMode
    ? thresholds.STOP_START_URBAN_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.STOP_START_URBAN_MIN_SPEED_KMH
    : thresholds.STOP_START_MIN_SPEED_KMH ?? thresholds.FOLLOWING_GAP_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.STOP_START_MIN_SPEED_KMH;
  const cruiseSeconds = urbanMode
    ? thresholds.STOP_START_URBAN_CRUISE_SECONDS ?? DEFAULT_THRESHOLDS.STOP_START_URBAN_CRUISE_SECONDS
    : thresholds.STOP_START_CRUISE_SECONDS ?? thresholds.FOLLOWING_GAP_CRUISE_SECONDS ?? DEFAULT_THRESHOLDS.STOP_START_CRUISE_SECONDS;
  const speedDropThreshold = urbanMode
    ? thresholds.STOP_START_URBAN_SPEED_DROP_KMH ?? DEFAULT_THRESHOLDS.STOP_START_URBAN_SPEED_DROP_KMH
    : thresholds.STOP_START_SPEED_DROP_KMH ?? thresholds.FOLLOWING_GAP_SPEED_DROP_KMH ?? DEFAULT_THRESHOLDS.STOP_START_SPEED_DROP_KMH;
  const maxElapsedSeconds = urbanMode ? 8 : 12;
  const resetSpeed = urbanMode ? Math.max(12, stopStartMinSpeed - 12) : Math.max(25, stopStartMinSpeed - 20);
  let state = 'IDLE';
  let cruiseStartTime = null;
  let cruiseSpeed = 0;
  let decelStartTime = null;
  let maxDecel = 0;
  const resetState = () => {
    state = 'IDLE';
    cruiseStartTime = null;
    cruiseSpeed = 0;
    decelStartTime = null;
    maxDecel = 0;
  };

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    if (
      !hasValidCoordinates(prev) ||
      !hasValidCoordinates(curr) ||
      prev.masked_for_privacy === true ||
      curr.masked_for_privacy === true
    ) {
      resetState();
      continue;
    }
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) {
      resetState();
      continue;
    }

    const prevSpeed = finiteSpeed(prev);
    const currSpeed = finiteSpeed(curr);
    const accel = calculateAcceleration(prevSpeed, currSpeed, dt);

    if (state === 'IDLE') {
      if (currSpeed >= stopStartMinSpeed) {
        state = 'CRUISING';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      }
      continue;
    }

    if (state === 'CRUISING') {
      if (currSpeed >= stopStartMinSpeed) {
        cruiseSpeed = Math.max(cruiseSpeed, currSpeed);
      } else if ((timestampMs(curr) - cruiseStartTime) / 1000 < cruiseSeconds) {
        state = 'IDLE';
        cruiseStartTime = null;
        continue;
      }

      const harshBrake = accel <= -(thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2);
      if (accel < -decelThreshold && !harshBrake) {
        state = 'DECELERATING';
        decelStartTime = timestampMs(curr);
        maxDecel = Math.abs(accel);
      }
      continue;
    }

    if (state === 'DECELERATING') {
      maxDecel = Math.max(maxDecel, Math.abs(accel));
      const elapsed = (timestampMs(curr) - decelStartTime) / 1000;
      const speedDrop = cruiseSpeed - currSpeed;

      if (speedDrop >= speedDropThreshold && elapsed <= maxElapsedSeconds) {
        events.push({
          type: EVENT_TYPES.STOP_START_PATTERN,
          severity: maxDecel > 4.0 && speedDrop > 30 ? 'high' : maxDecel > 3.0 && speedDrop > 18 ? 'medium' : 'low',
          label: 'stop-start pattern (estimated)',
          confidence: 'low',
          stop_start_context: urbanMode ? 'urban' : 'highway',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          value: Math.round(speedDrop),
          speed_kmh: Math.round(cruiseSpeed),
        });
        state = currSpeed >= stopStartMinSpeed ? 'CRUISING' : 'IDLE';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      } else if (elapsed > maxElapsedSeconds || currSpeed < resetSpeed) {
        state = currSpeed >= stopStartMinSpeed ? 'CRUISING' : 'IDLE';
        cruiseStartTime = timestampMs(curr);
        cruiseSpeed = currSpeed;
      }
    }
  }

  return events;
}

export function detectCloseProximityManeuverAlerts(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const events = [];
  if (!cleanPoints || cleanPoints.length < 2) return events;

  const brakeThreshold = thresholds.MANOEUVRE_ALERT_BRAKE_MS2 ?? thresholds.threshold_near_miss_brake_ms2 ?? DEFAULT_THRESHOLDS.MANOEUVRE_ALERT_BRAKE_MS2;
  const turnThreshold = thresholds.MANOEUVRE_ALERT_TURN_DEG_S ?? thresholds.threshold_near_miss_turn_degs ?? DEFAULT_THRESHOLDS.MANOEUVRE_ALERT_TURN_DEG_S;
  let candidateDurationSeconds = 0;
  let peakCandidate = null;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 2) {
      candidateDurationSeconds = 0;
      peakCandidate = null;
      continue;
    }

    const speed2 = finiteSpeed(curr);
    if (speed2 < 30) {
      candidateDurationSeconds = 0;
      peakCandidate = null;
      continue;
    }

    const accelMs2 = calculateAcceleration(finiteSpeed(prev), speed2, dt);
    const { h1, h2 } = headingBetweenPair(prev, curr, cleanPoints[i - 2] || null);
    const headingRate = h1 != null && h2 != null ? headingDiff(h1, h2) / dt : 0;

    if (accelMs2 <= -brakeThreshold && headingRate >= turnThreshold) {
      candidateDurationSeconds += dt;
      if (!peakCandidate || accelMs2 < peakCandidate.accelMs2) {
        peakCandidate = { curr, i, accelMs2, headingRate, speed2 };
      }
    } else {
      candidateDurationSeconds = 0;
      peakCandidate = null;
    }

    if (candidateDurationSeconds >= 1.5 && peakCandidate) {
      events.push({
        type: EVENT_TYPES.CLOSE_PROXIMITY,
        severity: peakCandidate.accelMs2 < -5.5 && peakCandidate.headingRate > 60 ? 'high' : peakCandidate.accelMs2 < -4.5 && peakCandidate.headingRate > 45 ? 'medium' : 'low',
        label: 'close-proximity manoeuvre alert (estimated)',
        confidence: 'low',
        lat: peakCandidate.curr.lat,
        lng: peakCandidate.curr.lng,
        timestamp: peakCandidate.curr.timestamp,
        point_index: peakCandidate.i,
        speed_kmh: Math.round(peakCandidate.speed2),
        value: round1(Math.abs(peakCandidate.accelMs2)),
      });
      candidateDurationSeconds = 0;
      peakCandidate = null;
    }
  }

  return events;
}

export function detectStopStartPatterns(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const highwayEvents = detectStopStartPatternsForMode(cleanPoints, thresholds, 'highway');
  if (medianMovingSpeedKmh(cleanPoints) >= 50) return highwayEvents;

  const urbanEvents = detectStopStartPatternsForMode(cleanPoints, thresholds, 'urban');
  if (!highwayEvents.length) return urbanEvents;

  const eventTimes = highwayEvents
    .map((event) => timestampMs(event))
    .filter(Number.isFinite);
  const dedupedUrbanEvents = urbanEvents.filter((event) => {
    const eventMs = timestampMs(event);
    return !Number.isFinite(eventMs) || !eventTimes.some((existingMs) => Math.abs(existingMs - eventMs) <= 15000);
  });
  return [...highwayEvents, ...dedupedUrbanEvents].sort((a, b) => timestampMs(a) - timestampMs(b));
}

// Compatibility export for callers compiled against older versions.
export const detectTailgateCycles = detectStopStartPatterns;

// Compatibility export; new detections are manoeuvre alerts rather than near-miss claims.
export const detectNearMisses = detectCloseProximityManeuverAlerts;
