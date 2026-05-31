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

export function analyzeIntersectionBehavior(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const trafficStopSpeedKmh = thresholds.TRAFFIC_STOP_SPEED_KMH ?? DEFAULT_THRESHOLDS.TRAFFIC_STOP_SPEED_KMH;
  const trafficStopMinSeconds = thresholds.TRAFFIC_STOP_MIN_SECONDS ?? DEFAULT_THRESHOLDS.TRAFFIC_STOP_MIN_SECONDS;
  const trafficStopMaxSampleGapSeconds = thresholds.TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS ?? DEFAULT_THRESHOLDS.TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS;
  const intersectionMinDistanceKm = thresholds.INTERSECTION_MIN_DISTANCE_KM ?? DEFAULT_THRESHOLDS.INTERSECTION_MIN_DISTANCE_KM;
  const distanceKm = calculateRouteDistanceKm(cleanPoints, thresholds);
  const intersectionEvents = [];
  let approachStart = null;
  let lastAboveStopPoint = null;
  let lowSpeedWindow = null;

  const closeLowSpeedWindow = (exitPoint) => {
    if (!lowSpeedWindow || !exitPoint) return;
    const stopDurationSeconds = (timestampMs(lowSpeedWindow.lastPoint) - timestampMs(lowSpeedWindow.firstPoint)) / 1000;
    const approachPoint = lowSpeedWindow.approachStart;
    const approachGapSeconds = approachPoint
      ? (timestampMs(lowSpeedWindow.firstPoint) - timestampMs(approachPoint)) / 1000
      : Infinity;
    if (
      lowSpeedWindow.sampleCount < 2 ||
      stopDurationSeconds < trafficStopMinSeconds ||
      !approachPoint ||
      approachGapSeconds <= 0 ||
      approachGapSeconds > 60
    ) return;

    const decel = Math.max(0, ((finiteSpeed(approachPoint) - lowSpeedWindow.minSpeed) / 3.6) / approachGapSeconds);
    const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
    const approachGrade = decel < 2.0
      ? 'smooth'
      : decel <= harshThreshold
        ? 'acceptable'
        : 'late';
    const rollingStop = lowSpeedWindow.minSpeed > 2.5;

    intersectionEvents.push({
      type: 'intersection',
      stop_type: rollingStop ? 'rolling_traffic_stop' : 'traffic_stop',
      approach_grade: approachGrade,
      rolling_stop: rollingStop,
      duration_seconds: Math.round(stopDurationSeconds),
      lat: lowSpeedWindow.firstPoint.lat,
      lng: lowSpeedWindow.firstPoint.lng,
      timestamp: lowSpeedWindow.firstPoint.timestamp,
    });
  };

  for (let i = 0; i < cleanPoints.length; i++) {
    const curr = cleanPoints[i];
    const prev = cleanPoints[i - 1];
    if (!hasValidCoordinates(curr) || curr.masked_for_privacy === true || !Number.isFinite(timestampMs(curr))) {
      approachStart = null;
      lastAboveStopPoint = null;
      lowSpeedWindow = null;
      continue;
    }

    const currSpeed = finiteSpeed(curr);
    if (currSpeed >= trafficStopSpeedKmh) {
      closeLowSpeedWindow(curr);
      lowSpeedWindow = null;

      if (
        hasValidCoordinates(prev) &&
        prev?.masked_for_privacy !== true &&
        finiteSpeed(prev) > 20 &&
        currSpeed < 20
      ) {
        approachStart = prev;
      } else if (currSpeed >= 20) {
        approachStart = curr;
      }
      lastAboveStopPoint = curr;
      continue;
    }

    const candidateApproach = approachStart || lastAboveStopPoint;
    if (!lowSpeedWindow) {
      lowSpeedWindow = {
        firstPoint: curr,
        lastPoint: curr,
        sampleCount: 1,
        minSpeed: currSpeed,
        approachStart: candidateApproach,
      };
      continue;
    }

    const gapSeconds = (timestampMs(curr) - timestampMs(lowSpeedWindow.lastPoint)) / 1000;
    if (gapSeconds <= 0 || gapSeconds > trafficStopMaxSampleGapSeconds) {
      lowSpeedWindow = {
        firstPoint: curr,
        lastPoint: curr,
        sampleCount: 1,
        minSpeed: currSpeed,
        approachStart: candidateApproach,
      };
      continue;
    }

    lowSpeedWindow.lastPoint = curr;
    lowSpeedWindow.sampleCount += 1;
    lowSpeedWindow.minSpeed = Math.min(lowSpeedWindow.minSpeed, currSpeed);
  }

  const stopCount = intersectionEvents.length;
  const rollingStopCount = intersectionEvents.filter((event) => event.rolling_stop).length;
  const smoothApproachCount = intersectionEvents.filter((event) => event.approach_grade === 'smooth').length;
  const lateCount = intersectionEvents.filter((event) => event.approach_grade === 'late').length;
  const penalty = lateCount * 10 + rollingStopCount * 3;
  const distFactor = Math.max(1, stopCount / 5);
  const hasScorableEvidence = distanceKm >= intersectionMinDistanceKm && stopCount > 0;
  const intersectionScore = hasScorableEvidence
    ? Math.max(0, 100 - penalty * (3 / distFactor))
    : null;

  return {
    intersection_score: intersectionScore == null ? null : Math.round(intersectionScore),
    intersection_score_confidence: distanceKm < intersectionMinDistanceKm
      ? 'insufficient_data'
      : stopCount === 0
        ? 'no_traffic_stops'
        : 'observed_stops',
    stop_count: stopCount,
    traffic_stop_count: stopCount,
    rolling_stop_count: rollingStopCount,
    smooth_approach_count: smoothApproachCount,
    intersection_events: intersectionEvents,
  };
}

export function calculateSmoothBrakingRatio(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  let state = 'MOVING';
  let windowPoints = [];
  let totalStops = 0;
  let harshStops = 0;

  const closeWindow = () => {
    if (windowPoints.length < 2) return;
    totalStops++;
    let harsh = false;
    for (let i = 1; i < windowPoints.length; i++) {
      const prev = windowPoints[i - 1];
      const curr = windowPoints[i];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 30) continue;
      if (calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt) < -harshThreshold) {
        harsh = true;
        break;
      }
    }
    if (harsh) harshStops++;
  };

  for (const point of cleanPoints) {
    const speed = finiteSpeed(point);
    if (state === 'MOVING') {
      if (speed >= 20) windowPoints = [point];
      else if (windowPoints.length && speed <= 5) {
        windowPoints.push(point);
        state = 'STOPPED';
        closeWindow();
      }
      else if (windowPoints.length && speed < 20 && speed > 5) {
        state = 'SLOWING';
        windowPoints.push(point);
      }
      continue;
    }

    if (state === 'SLOWING') {
      windowPoints.push(point);
      if (speed <= 5) {
        state = 'STOPPED';
        closeWindow();
      } else if (speed >= 25) {
        state = 'MOVING';
        windowPoints = [point];
      }
      continue;
    }

    if (state === 'STOPPED' && speed >= 10) {
      state = 'MOVING';
      windowPoints = speed >= 20 ? [point] : [];
    }
  }

  const smoothStops = Math.max(0, totalStops - harshStops);
  const smoothBrakingRatio = totalStops > 0 ? Math.round((smoothStops / totalStops) * 100) : null;
  return {
    total_stops_detected: totalStops,
    harsh_stops_count: harshStops,
    smooth_stops_count: smoothStops,
    smooth_braking_ratio: smoothBrakingRatio,
    smooth_braking_score: smoothBrakingRatio,
  };
}

/**
 * Extract contiguous braking sequences from route points.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} thresholds - Driving thresholds used for speed/noise filtering.
 * @param {{startSpeedKmh?:number,endSpeedKmh?:number,minEntryKmh?:number}} options - Sequence speed gates.
 * @returns {Array<{points:Array,entrySpeed:number,exitSpeed:number,durationS:number,distanceM:number}>} Braking sequences.
 * @example
 * const sequences = extractBrakingSequences(points, DEFAULT_THRESHOLDS, { minEntryKmh: 30 });
 */
export function extractBrakingSequences(routePoints, thresholds = DEFAULT_THRESHOLDS, {
  startSpeedKmh = 25,
  endSpeedKmh = 5,
  minEntryKmh = 25,
} = {}) {
  const points = routePoints || [];
  if (points.length < 2) return [];

  const sequences = [];
  let active = null;
  let lastAccelNegative = false;

  const finishSequence = (includePoint = null) => {
    if (!active || active.points.length < 2) {
      active = null;
      lastAccelNegative = false;
      return;
    }
    const sequencePoints = includePoint && active.points[active.points.length - 1] !== includePoint
      ? [...active.points, includePoint]
      : [...active.points];
    const entrySpeed = finiteSpeed(sequencePoints[0]);
    const exitSpeed = finiteSpeed(sequencePoints[sequencePoints.length - 1]);
    if (entrySpeed >= minEntryKmh && exitSpeed <= endSpeedKmh) {
      const durationS = Math.max(0, (timestampMs(sequencePoints[sequencePoints.length - 1]) - timestampMs(sequencePoints[0])) / 1000);
      let distanceM = 0;
      for (let j = 1; j < sequencePoints.length; j++) {
        distanceM += haversineMeters(sequencePoints[j - 1].lat, sequencePoints[j - 1].lng, sequencePoints[j].lat, sequencePoints[j].lng);
      }
      if (durationS > 0) {
        sequences.push({
          points: sequencePoints,
          entrySpeed: round1(entrySpeed),
          exitSpeed: round1(exitSpeed),
          durationS: round1(durationS),
          distanceM: round1(distanceM),
        });
      }
    }
    active = null;
    lastAccelNegative = false;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) {
      finishSequence();
      continue;
    }

    const prevSpeed = finiteSpeed(prev);
    const currSpeed = finiteSpeed(curr);
    const accel = calculateAcceleration(prevSpeed, currSpeed, dt);
    const decelerating = accel < -0.05 && currSpeed <= prevSpeed;

    if (!active) {
      if (decelerating && prevSpeed >= startSpeedKmh) {
        active = { points: [prev, curr] };
        lastAccelNegative = true;
        if (currSpeed <= endSpeedKmh) finishSequence();
      }
      continue;
    }

    if (decelerating || (lastAccelNegative && currSpeed <= prevSpeed + 1)) {
      active.points.push(curr);
      lastAccelNegative = decelerating;
      if (currSpeed <= endSpeedKmh) finishSequence();
      continue;
    }

    if (currSpeed <= endSpeedKmh) finishSequence(curr);
    else finishSequence();
  }

  finishSequence();
  return sequences;
}

export function scoreBrakeOnsetSmoothness(peakDecelerationMs2, rampDurationSeconds) {
  if (!Number.isFinite(peakDecelerationMs2) || peakDecelerationMs2 < 0) return null;
  if (!Number.isFinite(rampDurationSeconds) || rampDurationSeconds <= 0) return 0;
  const onsetRate = peakDecelerationMs2 / Math.max(0.1, rampDurationSeconds);
  const onsetPenalty = clamp(onsetRate * 8, 0, 60);
  const severityPenalty = clamp((peakDecelerationMs2 - 4.0) * 8, 0, 40);
  return Math.round(Math.max(0, 100 - onsetPenalty - severityPenalty));
}

export const BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS = {
  smooth: 85,
  controlled: 70,
  abrupt: 50,
};

export function brakeOnsetSmoothnessGrade(score) {
  if (score == null) return 'insufficient_data';
  if (score >= BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS.smooth) return 'smooth';
  if (score >= BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS.controlled) return 'controlled';
  if (score >= BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS.abrupt) return 'abrupt';
  return 'very_abrupt';
}

/**
 * Estimate brake-onset smoothness around harsh-brake events from GPS speed changes.
 * This does not measure driver reaction time because no external stimulus is observed.
 * @returns {{brake_onset_smoothness_score:number|null,avg_brake_onset_ramp_seconds:number,brake_onset_smoothness_grade:string,brake_onset_sequence_count:number,brake_onset_smoothness_confidence:string,brake_onset_disclaimer:string}}
 */
export function calculateBrakeOnsetSmoothness(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const targetEvents = (drivingEvents || []).filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE);
  const insufficient = (count = 0) => ({
    brake_onset_smoothness_score: null,
    avg_brake_onset_ramp_seconds: 0,
    brake_onset_smoothness_grade: 'insufficient_data',
    brake_onset_sequence_count: count,
    brake_onset_smoothness_confidence: 'low',
    brake_onset_disclaimer: 'Measures brake application smoothness during detected braking events, not human neurological reaction time.',
  });
  if (points.length < 2) {
    return insufficient();
  }

  const scores = [];
  const rampDurations = [];
  for (const event of targetEvents) {
    const eventIndex = nearestPointIndexByTimestamp(points, event);
    if (eventIndex <= 0) continue;
    const eventPoint = points[eventIndex];
    const eventSpeed = Number.isFinite(event.speed_kmh)
      ? event.speed_kmh
      : reliablePointSpeed(points, eventIndex, thresholds) ?? finiteSpeed(eventPoint);
    if (eventSpeed < (thresholds.MIN_SPEED_HARSH_BRAKE_KMH ?? DEFAULT_THRESHOLDS.MIN_SPEED_HARSH_BRAKE_KMH)) continue;

    const eventMs = timestampMs(eventPoint);
    let startIndex = eventIndex - 1;
    for (let i = eventIndex - 1; i > 0; i--) {
      const elapsed = (eventMs - timestampMs(points[i - 1])) / 1000;
      if (elapsed > 5) break;
      const dt = (timestampMs(points[i]) - timestampMs(points[i - 1])) / 1000;
      if (dt <= 0 || dt > 5) break;
      const deceleration = -calculateAcceleration(finiteSpeed(points[i - 1]), finiteSpeed(points[i]), dt);
      if (deceleration <= 0) break;
      startIndex = i - 1;
    }

    const rampDurationSeconds = Math.max(0, (eventMs - timestampMs(points[startIndex])) / 1000);
    let peakDecelerationMs2 = 0;
    for (let i = startIndex + 1; i <= eventIndex; i++) {
      const dt = (timestampMs(points[i]) - timestampMs(points[i - 1])) / 1000;
      if (dt <= 0 || dt > 5) continue;
      peakDecelerationMs2 = Math.max(
        peakDecelerationMs2,
        -calculateAcceleration(finiteSpeed(points[i - 1]), finiteSpeed(points[i]), dt)
      );
    }
    if (peakDecelerationMs2 <= 0) continue;
    scores.push(scoreBrakeOnsetSmoothness(peakDecelerationMs2, rampDurationSeconds));
    rampDurations.push(rampDurationSeconds);
  }

  if (scores.length < MIN_BRAKE_ONSET_SMOOTHNESS_SEQUENCES) {
    return insufficient(scores.length);
  }

  const score = Math.round(average(scores));
  return {
    brake_onset_smoothness_score: score,
    avg_brake_onset_ramp_seconds: round2(average(rampDurations)),
    brake_onset_smoothness_grade: brakeOnsetSmoothnessGrade(score),
    brake_onset_sequence_count: scores.length,
    brake_onset_smoothness_confidence: 'low',
    brake_onset_disclaimer: 'Measures brake application smoothness during detected braking events, not human neurological reaction time.',
  };
}

// Backward-compatible function name for integrations; public outputs use brake-onset language.
export function calculateReactionTimeProxy(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  return calculateBrakeOnsetSmoothness(routePoints, drivingEvents, thresholds);
}

export function lateralGForTriplet(points, index, thresholds = DEFAULT_THRESHOLDS) {
  if (index <= 0 || index >= points.length - 1) return null;
  const speed = reliablePointSpeed(points, index, thresholds);
  const minSpeed = thresholds.CORNERING_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.CORNERING_MIN_SPEED_KMH;
  if (!speed || speed < minSpeed) return null;
  const prev = points[index - 1];
  const curr = points[index];
  const next = points[index + 1];
  const prevSegment = calculateSegmentMetrics(prev, curr, thresholds);
  const nextSegment = calculateSegmentMetrics(curr, next, thresholds);
  if (prevSegment.dt <= 0 || nextSegment.dt <= 0 || prevSegment.dt > 8 || nextSegment.dt > 8) return null;
  if (prevSegment.isNoise || nextSegment.isNoise || prevSegment.distanceM < 8 || nextSegment.distanceM < 8) return null;
  const h0 = smoothHeading(points, index - 1);
  const h2 = smoothHeading(points, index + 1);
  if (!Number.isFinite(h0) || !Number.isFinite(h2)) return null;
  const rawHeadingChange = headingDiff(h0, h2);
  const effectiveDt = Math.max(1.5, prevSegment.dt + nextSegment.dt);
  const omegaRadPerSec = (rawHeadingChange * Math.PI / 180) / effectiveDt;
  return (speed / 3.6 * omegaRadPerSec) / 9.81;
}

export function hasSustainedLateralG(points, index, thresholdG, thresholds = DEFAULT_THRESHOLDS) {
  return [index - 1, index + 1].some((neighborIndex) => {
    const lateralG = lateralGForTriplet(points, neighborIndex, thresholds);
    return Number.isFinite(lateralG) && lateralG >= thresholdG;
  });
}

/**
 * Score consistency across all cornering samples, not only sharp-turn events.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} thresholds - Driving thresholds for GPS filtering.
 * @returns {{cornering_consistency_score:number|null,cornering_grade:string,mean_lateral_g:number,peak_lateral_g:number,corner_sample_count:number}} Cornering fields.
 * @example
 * const cornering = calculateCorneringConsistency(points, DEFAULT_THRESHOLDS);
 */
export function calculateCorneringConsistency(routePoints, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const cornerSamples = [];
  for (let i = 1; i < points.length - 1; i++) {
    const lateralG = lateralGForTriplet(points, i, thresholds);
    if (Number.isFinite(lateralG) && lateralG > 0.05) cornerSamples.push(lateralG);
  }

  if (cornerSamples.length < 5) {
    return {
      cornering_consistency_score: null,
      cornering_grade: 'insufficient_data',
      mean_lateral_g: 0,
      peak_lateral_g: 0,
      corner_sample_count: cornerSamples.length,
    };
  }

  const meanG = average(cornerSamples);
  const stdG = stddev(cornerSamples);
  const cv = stdG / Math.max(0.01, meanG);
  const peakG = safeMax(cornerSamples);
  const consistencyBase = Math.max(0, 100 - cv * 120);
  const peakPenalty = Math.max(0, (peakG - 0.50) * 60);
  const score = Math.max(0, Math.round(consistencyBase - peakPenalty));
  return {
    cornering_consistency_score: score,
    cornering_grade: score >= 85 ? 'fluid' : score >= 70 ? 'controlled' : score >= 50 ? 'variable' : 'erratic',
    mean_lateral_g: round2(meanG),
    peak_lateral_g: round2(peakG),
    corner_sample_count: cornerSamples.length,
  };
}

export const BRAKING_GRADE_THRESHOLDS = {
  urban: { progressive: 80, adequate: 60, abrupt: 40 },
  highway: { progressive: 88, adequate: 70, abrupt: 55 },
};

export function brakingEfficiencyGrade(score, roadType = 'urban') {
  if (score == null) return 'insufficient_data';
  const context = roadType === 'highway' ? 'highway' : 'urban';
  const thresholds = BRAKING_GRADE_THRESHOLDS[context];
  if (score >= thresholds.progressive) return 'progressive';
  if (score >= thresholds.adequate) return 'adequate';
  if (score >= thresholds.abrupt) return 'abrupt';
  return 'poor';
}

/**
 * Score progressive braking quality across meaningful full-stop sequences.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds, including HARSH_BRAKE_MS2.
 * @returns {{braking_efficiency_score:number|null,braking_efficiency_grade:string,braking_context:string,braking_sequence_count:number,avg_braking_smoothness:number}} Braking efficiency fields.
 * @example
 * const braking = calculateBrakingEfficiency(points, events, DEFAULT_THRESHOLDS);
 */
export function calculateBrakingEfficiency(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const roadType = classifyRoadType(routePoints).road_type === 'highway' ? 'highway' : 'urban';
  const sequences = extractBrakingSequences(routePoints, thresholds, {
    startSpeedKmh: 25,
    endSpeedKmh: 5,
    minEntryKmh: 25,
  });
  if (!sequences.length) {
    return {
      braking_efficiency_score: null,
      braking_efficiency_grade: 'insufficient_data',
      braking_context: roadType,
      braking_sequence_count: 0,
      avg_braking_smoothness: 0,
    };
  }

  const harshThreshold = thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  const sequenceScores = [];
  const smoothnessValues = [];

  for (const sequence of sequences) {
    const decelSamples = [];
    for (let i = 1; i < sequence.points.length; i++) {
      const prev = sequence.points[i - 1];
      const curr = sequence.points[i];
      const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
      if (dt <= 0 || dt > 30) continue;
      const accel = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
      if (accel < 0) decelSamples.push(Math.abs(accel));
    }
    if (!decelSamples.length) continue;

    const meanDecel = average(decelSamples);
    const smoothnessIndex = clamp(1 - (stddev(decelSamples) / Math.max(0.1, meanDecel)), 0, 1);
    const expectedMinDuration = sequence.entrySpeed / (3.6 * harshThreshold);
    const efficiencyRatio = expectedMinDuration > 0 ? sequence.durationS / expectedMinDuration : 0;
    const sequenceScore = Math.min(100, Math.round(
      Math.min(1, efficiencyRatio / 3) * 50 +
      smoothnessIndex * 50
    ));
    sequenceScores.push(sequenceScore);
    smoothnessValues.push(smoothnessIndex);
  }

  const score = sequenceScores.length ? Math.round(average(sequenceScores)) : null;
  return {
    braking_efficiency_score: score,
    braking_efficiency_grade: brakingEfficiencyGrade(score, roadType),
    braking_context: roadType,
    braking_sequence_count: sequences.length,
    avg_braking_smoothness: round2(average(smoothnessValues)),
  };
}

export function complianceFallbackLimit(roadType, thresholds = DEFAULT_THRESHOLDS) {
  if (roadType === 'highway') return thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  if (roadType === 'residential') return 40;
  return 60;
}

export function contextualFallbackLimitKmh(points = [], index = 0, zone = null, thresholds = DEFAULT_THRESHOLDS, roadTypes = null) {
  const roadType = roadTypes?.[index] || normalizeRoadTypeLabel(classifyRoadType(points.slice(Math.max(0, index - 15), index + 16)).road_type, points[index]);
  const roadLimit = complianceFallbackLimit(roadType, thresholds);
  if (Number.isFinite(Number(zone?.inferredZoneKmh)) && Number(zone.inferredZoneKmh) > 0) {
    return Math.min(Number(zone.inferredZoneKmh), roadLimit);
  }
  return roadLimit;
}

export function speedLimitForIndex(points = [], index) {
  const candidates = [
    points[index],
    points[index - 1],
    points[index + 1],
  ];
  for (const point of candidates) {
    const limitKmh = Number(point?.speed_limit_kmh);
    if (Number.isFinite(limitKmh) && limitKmh > 0) {
      return {
        limitKmh,
        source: point?.speed_limit_source || 'openstreetmap',
        defaultCountry: point?.fallback_country || point?.speed_limit_default_country || null,
      };
    }
  }
  return null;
}

export function resolveEffectiveSpeedLimitForIndex(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const speedLimit = speedLimitForIndex(points, index);
  const actualLimitKmh = speedLimit?.limitKmh ?? null;
  const zoneForIndex = options.zoneForIndex || createZoneLookup(options.inferredZones || inferSpeedZones(points, thresholds));
  const inferredZone = zoneForIndex(index);
  const roadTypesByPoint = options.roadTypesByPoint || classifyRoadTypesByPoint(points);
  const fallbackLimitKmh = contextualFallbackLimitKmh(points, index, inferredZone, thresholds, roadTypesByPoint);
  const inferredLimitKmh = Number.isFinite(Number(inferredZone?.inferredLimitKmh))
    ? Number(inferredZone.inferredLimitKmh)
    : (
      Number.isFinite(Number(inferredZone?.inferredZoneKmh))
        ? Math.min(Number(inferredZone.inferredZoneKmh), fallbackLimitKmh)
        : fallbackLimitKmh
    );
  const effectiveLimitKmh = actualLimitKmh ?? (Number.isFinite(inferredLimitKmh) && inferredLimitKmh > 0 ? inferredLimitKmh : null);

  return {
    actualLimitKmh,
    effectiveLimitKmh,
    fallbackLimitKmh,
    inferredLimitKmh: Number.isFinite(inferredLimitKmh) && inferredLimitKmh > 0 ? inferredLimitKmh : null,
    inferredZone,
    limitSource: speedLimit?.source ?? (effectiveLimitKmh != null ? 'inferred' : null),
    speedLimitSource: speedLimit?.source ?? null,
    speedLimitDefaultCountry: speedLimit?.defaultCountry ?? null,
  };
}

export function getInferredLimitForPoint(routePoints = [], point = null, thresholds = DEFAULT_THRESHOLDS, inferredZones = null) {
  const points = Array.isArray(routePoints) ? routePoints : [];
  if (!points.length) return null;

  let index = point ? points.indexOf(point) : -1;
  if (index < 0 && point?.timestamp) {
    const pointMs = timestampMs(point);
    index = points.findIndex((candidate) => timestampMs(candidate) === pointMs);
  }
  if (index < 0) index = points.length - 1;

  const context = resolveEffectiveSpeedLimitForIndex(points, index, thresholds, {
    inferredZones: Array.isArray(inferredZones) ? inferredZones : undefined,
  });
  return context.inferredLimitKmh ?? null;
}

/**
 * Calculate speed-limit compliance breakdown by inferred road type.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Object} stats - Trip stats, optionally including speed_zones.
 * @param {Object} thresholds - Driving thresholds for speed-over-limit tolerance.
 * @returns {{highway_compliance:Object|null,urban_compliance:Object|null,residential_compliance:Object|null,overall_compliance_score:number}} Compliance fields.
 * @example
 * const compliance = calculateSpeedLimitCompliance(points, stats, DEFAULT_THRESHOLDS);
 */
export function calculateSpeedLimitCompliance(routePoints, stats = {}, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const roadTypes = classifyRoadTypesByPoint(points);
  const zones = Array.isArray(stats.speed_zones) ? stats.speed_zones : inferSpeedZones(points, thresholds);
  const byType = {
    highway: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0 },
    urban: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0 },
    residential: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0 },
  };
  const speedOver = thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH;
  const zoneForIndex = createZoneLookup(zones);

  points.forEach((point, index) => {
    const speed = reliablePointSpeed(points, index, thresholds);
    if (!Number.isFinite(speed)) return;
    if (speed <= (thresholds.STATIONARY_SPEED_KMH ?? DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH)) return;
    const roadType = roadTypes[index] || 'urban';
    const zone = zoneForIndex(index);
    const speedLimit = speedLimitForIndex(points, index);
    const limit = speedLimit?.limitKmh ?? zone?.inferredZoneKmh ?? complianceFallbackLimit(roadType, thresholds);
    const bucket = byType[roadType];
    bucket.totalPoints++;
    bucket.limitTotal += limit;
    if (speedLimit) {
      bucket.actualLimitPoints++;
      if (speedLimit.source === 'openstreetmap') bucket.osmMaxspeedPoints++;
      if (speedLimit.source === 'osm_highway_default') bucket.osmDefaultPoints++;
    }
    bucket.maxSpeed = Math.max(bucket.maxSpeed, speed);
    if (speed > limit + speedOver) bucket.overLimitPoints++;
  });

  const build = (bucket) => {
    if (!bucket.totalPoints) return null;
    const inferredLimit = Math.round(bucket.limitTotal / bucket.totalPoints);
    const rate = 1 - bucket.overLimitPoints / bucket.totalPoints;
    const maxExcessKmh = Math.max(0, bucket.maxSpeed - inferredLimit);
    const limitSource = bucket.osmMaxspeedPoints > bucket.totalPoints / 2
      ? 'openstreetmap'
      : bucket.osmDefaultPoints > bucket.totalPoints / 2
        ? 'osm_highway_default'
        : 'inferred';
    const rawScore = clamp(Math.round(rate * 100 - maxExcessKmh * 0.5), 0, 100);
    const penaltyWeight = limitSource === 'inferred' ? 0.5 : 1;
    return {
      score: Math.round(100 - ((100 - rawScore) * penaltyWeight)),
      raw_score: rawScore,
      penalty_weight: penaltyWeight,
      confidence: round2(clamp(bucket.totalPoints / 30, 0, 1)),
      rate: round2(rate),
      max_excess_kmh: round1(maxExcessKmh),
      inferred_limit_kmh: inferredLimit,
      limit_source: limitSource,
      actual_limit_coverage: round2(bucket.actualLimitPoints / bucket.totalPoints),
      osm_maxspeed_coverage: round2(bucket.osmMaxspeedPoints / bucket.totalPoints),
      osm_highway_default_coverage: round2(bucket.osmDefaultPoints / bucket.totalPoints),
      point_count: bucket.totalPoints,
    };
  };

  const highway = build(byType.highway);
  const urban = build(byType.urban);
  const residential = build(byType.residential);
  const weighted = [highway, urban, residential].filter(Boolean);
  const totalPoints = weighted.reduce((sum, item) => sum + item.point_count, 0);
  const overall = totalPoints
    ? Math.round(weighted.reduce((sum, item) => sum + item.score * item.point_count, 0) / totalPoints)
    : null;

  return {
    highway_compliance: highway,
    urban_compliance: urban,
    residential_compliance: residential,
    overall_compliance_score: overall,
  };
}

/**
 * Score the quality of detected overtake windows.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number,heading?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string,timestamp?:string,speed_kmh?:number}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{overtake_quality_score:number|null,overtake_quality_grade:string,overtake_count:number,unsafe_reentry_count:number}} Overtake fields.
 * @example
 * const overtake = calculateOvertakeQualityScore(points, events, DEFAULT_THRESHOLDS);
 */
export function calculateOvertakeQualityScore(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  if (points.length < 2) {
    return {
      overtake_quality_score: null,
      overtake_quality_grade: 'none',
      overtake_count: 0,
      unsafe_reentry_count: 0,
    };
  }

  const windows = [];
  for (const event of drivingEvents || []) {
    const isOvertake = event.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE;
    if (!isOvertake) continue;
    const index = nearestPointIndexByTimestamp(points, event);
    if (index < 0) continue;
    const center = timestampMs(points[index]);
    const start = center - 4000;
    const end = center + 4000;
    windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ ...window });
  }

  if (!merged.length) {
    return {
      overtake_quality_score: null,
      overtake_quality_grade: 'none',
      overtake_count: 0,
      unsafe_reentry_count: 0,
    };
  }

  const harshBrakeTimes = (drivingEvents || [])
    .filter((event) => event.type === EVENT_TYPES.HARSH_BRAKE)
    .map((event) => timestampMs(event))
    .filter((time) => Number.isFinite(time));
  const windowScores = [];
  let unsafeReentryCount = 0;

  for (const window of merged) {
    const samples = points.filter((point) => {
      const time = timestampMs(point);
      return time >= window.start && time <= window.end;
    });
    if (samples.length < 2) continue;
    const speeds = samples.map((point, index) => reliablePointSpeed(samples, index, thresholds) ?? finiteSpeed(point));
    const entrySpeed = speeds[0];
    const peakSpeed = Math.max(...speeds);
    const speedDelta = peakSpeed - entrySpeed;
    if (speedDelta < 8 && !harshBrakeTimes.some((time) => time > window.end && time <= window.end + 5000)) continue;
    const headings = samples.map((point, index) => (
      Number.isFinite(point.heading) ? point.heading : headingForIndex(samples, index)
    ));
    const headingVariance = Math.pow(calculateAngularStdDev(headings), 2);
    const postOvertakeBrake = harshBrakeTimes.some((time) => time > window.end && time <= window.end + 5000);
    if (postOvertakeBrake) unsafeReentryCount++;
    const score = clamp(
      80 -
      (speedDelta > 30 ? 15 : speedDelta > 20 ? 8 : 0) -
      (headingVariance > 40 ? 15 : headingVariance > 20 ? 8 : 0) -
      (postOvertakeBrake ? 20 : 0),
      0,
      100
    );
    windowScores.push(score);
  }

  const score = windowScores.length ? Math.round(average(windowScores)) : null;
  return {
    overtake_quality_score: score,
    overtake_quality_grade: score == null ? 'none' : score >= 80 ? 'confident' : score >= 60 ? 'adequate' : score >= 40 ? 'borderline' : 'dangerous',
    overtake_count: merged.length,
    unsafe_reentry_count: unsafeReentryCount,
  };
}

/**
 * Detect possible wet or slippery conditions from unusually long stopping distances.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{slippery_proxy:string,wet_signal_count:number,wet_ratio:number,safety_condition_bonus:number,avg_distance_ratio:number}} Road-condition proxy fields.
 * @example
 * const conditions = detectSlipperyConditionProxy(points, events, DEFAULT_THRESHOLDS);
 */
export function detectSlipperyConditionProxy(routePoints, drivingEvents = [], thresholds = DEFAULT_THRESHOLDS) {
  const sequences = extractBrakingSequences(routePoints, thresholds, {
    startSpeedKmh: 30,
    endSpeedKmh: 5,
    minEntryKmh: 30,
  });
  const ratios = [];
  for (const sequence of sequences) {
    const entrySpeedMps = sequence.entrySpeed / 3.6;
    const theoreticalDryStoppingDistanceM = (entrySpeedMps * entrySpeedMps) / (2 * 0.75 * 9.81);
    if (theoreticalDryStoppingDistanceM > 0) {
      ratios.push(sequence.distanceM / theoreticalDryStoppingDistanceM);
    }
  }

  if (ratios.length < 3) {
    return {
      slippery_proxy: 'insufficient_data',
      wet_signal_count: 0,
      wet_ratio: 0,
      safety_condition_bonus: 0,
      avg_distance_ratio: round2(average(ratios)),
    };
  }

  const wetSignalCount = ratios.filter((ratio) => ratio > 1.5).length;
  const wetRatio = wetSignalCount / ratios.length;
  const slipperyProxy = wetRatio >= 0.50 ? 'likely_wet' : wetRatio >= 0.30 ? 'possible_wet' : 'appears_dry';
  return {
    slippery_proxy: slipperyProxy,
    wet_signal_count: wetSignalCount,
    wet_ratio: round2(wetRatio),
    safety_condition_bonus: slipperyProxy === 'likely_wet' ? 5 : slipperyProxy === 'possible_wet' ? 2 : 0,
    avg_distance_ratio: round2(average(ratios)),
  };
}

export function emptyPhoneUseResult() {
  return {
    phone_use_events: [],
    phone_use_window_count: 0,
    phone_use_total_seconds: 0,
    phone_use_pct_of_trip: 0,
    phone_use_risk: 'none',
    phone_use_score: null,
    phone_use_score_available: false,
    phone_use_score_confidence: 'usage_access_required',
    phone_proxy_events: [],
    phone_proxy_count: 0,
    phone_proxy_risk: 'none',
  };
}

export function summarizePhoneUseEvents(events = [], durationSeconds = 0) {
  const phoneEvents = (events || []).filter((event) => event?.type === EVENT_TYPES.PHONE_USE);
  if (!phoneEvents.length) return emptyPhoneUseResult();
  const totalSeconds = phoneEvents.reduce((sum, event) => sum + (Number(event.duration_seconds) || 0), 0);
  const pct = durationSeconds > 0 ? Math.round((totalSeconds / durationSeconds) * 1000) / 10 : 0;
  const risk = pct >= 8 ? 'high' : pct >= 3 ? 'medium' : 'low';
  const proxyEvents = phoneEvents.filter((event) => event.source === 'gps_proxy');
  return {
    ...emptyPhoneUseResult(),
    phone_use_events: phoneEvents,
    phone_use_window_count: phoneEvents.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_pct_of_trip: pct,
    phone_use_risk: risk,
    phone_proxy_events: proxyEvents,
    phone_proxy_count: proxyEvents.length,
    phone_proxy_risk: risk,
  };
}

export let roadTypeSegmentScorer = null;

export function setRoadTypeSegmentScorer(scorer) {
  roadTypeSegmentScorer = typeof scorer === 'function' ? scorer : null;
}

export function calculateRoadTypeSegmentFallbackScores(events = [], stats = {}) {
  const distKm = Math.max(1, Number(stats.distance_km) || 1);
  const penalty = (events || []).reduce((sum, event) => (
    sum + (EVENT_PENALTIES[event?.type]?.[event?.severity] || 0)
  ), 0);
  const score = Math.max(0, Math.round(100 - Math.min((penalty / distKm) * 2.5, 100)));
  return {
    score_overall: score,
    score_safety: score,
    score_smoothness: score,
    score_eco: score,
    score_confidence: Math.min(1, Math.max(0.25, distKm / 10)),
  };
}

/**
 * Score trip behavior independently across highway, urban, and residential route portions.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number}>} routePoints - Ordered GPS route points.
 * @param {Array<{type:string,timestamp?:string,point_index?:number}>} drivingEvents - Events from detectDrivingEvents.
 * @param {Object} stats - Trip stats.
 * @param {Object} thresholds - Driving thresholds.
 * @returns {{highway_score:Object|null,urban_score:Object|null,residential_score:Object|null,dominant_road_type:string}} Road-type scores.
 * @example
 * const segments = calculateRoadTypeSegmentedScores(points, events, stats, DEFAULT_THRESHOLDS);
 */
export function calculateRoadTypeSegmentedScores(routePoints, drivingEvents = [], stats = {}, thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  const roadTypes = classifyRoadTypesByPoint(points);
  const result = {
    highway_score: null,
    urban_score: null,
    residential_score: null,
    dominant_road_type: 'mixed',
  };
  if (points.length < 2) return result;

  const eventBuckets = { highway: [], urban: [], residential: [] };
  for (const event of drivingEvents || []) {
    const index = nearestPointIndexByTimestamp(points, event);
    const roadType = roadTypes[index];
    if (eventBuckets[roadType]) eventBuckets[roadType].push(event);
  }

  const typeMetrics = { highway: { distance: 0, seconds: 0 }, urban: { distance: 0, seconds: 0 }, residential: { distance: 0, seconds: 0 } };
  for (let i = 1; i < points.length; i++) {
    const type = roadTypes[i] || roadTypes[i - 1] || 'urban';
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise || !typeMetrics[type]) continue;
    typeMetrics[type].distance += segment.distanceKm;
    typeMetrics[type].seconds += segment.dt;
  }

  const distances = Object.entries(typeMetrics).sort((a, b) => b[1].distance - a[1].distance);
  if (distances[0]?.[1].distance > 0) {
    const top = distances[0];
    const second = distances[1];
    result.dominant_road_type = second && second[1].distance / top[1].distance > 0.55 ? 'mixed' : top[0];
  }

  for (const type of ['highway', 'urban', 'residential']) {
    const metric = typeMetrics[type];
    if (metric.distance < 2 || metric.seconds < 60) continue;
    const slice = points.filter((_, index) => roadTypes[index] === type);
    if (slice.length < 3) continue;
    const segmentStats = {
      distance_km: round2(metric.distance),
      duration_seconds: Math.round(metric.seconds),
      avg_speed_kmh: metric.seconds > 0 ? round1(calculateSpeedKmh(metric.distance, metric.seconds)) : 0,
      fatigue_risk_score: 0,
      intersection_score: null,
      idle_time_seconds: 0,
    };
    const segmentEvents = eventBuckets[type];
    const segmentPhoneUse = summarizePhoneUseEvents(segmentEvents, segmentStats.duration_seconds);
    const scoreSegment = roadTypeSegmentScorer || calculateRoadTypeSegmentFallbackScores;
    const segmentScores = scoreSegment(segmentEvents, segmentStats, slice, thresholds, segmentStats.duration_seconds, segmentPhoneUse, {
      includeRoadTypeSegments: false,
    });
    result[`${type}_score`] = {
      overall: segmentScores.score_overall,
      safety: segmentScores.score_safety,
      smoothness: segmentScores.score_smoothness,
      eco: segmentScores.score_eco,
      confidence: segmentScores.score_confidence,
      distance_km: round2(metric.distance),
      event_count: eventBuckets[type].length || segmentEvents.length,
    };
  }

  return result;
}

export function analyzeParkingApproach(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS, endTime = null) {
  if (!cleanPoints || cleanPoints.length < 3) {
    return {
      parking_approach_score: null,
      parking_approach_grade: 'insufficient_data',
      parking_stop_detected: false,
      parking_stop_duration_seconds: 0,
    };
  }

  const lastPoint = cleanPoints[cleanPoints.length - 1];
  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(cleanPoints, endTime, thresholds);
  const lookbackSeconds = thresholds.PARKING_LOOKBACK_SECONDS ?? DEFAULT_THRESHOLDS.PARKING_LOOKBACK_SECONDS;
  const cutoff = timestampMs(lastPoint) - lookbackSeconds * 1000;
  let startIndex = cleanPoints.findIndex((point) => timestampMs(point) >= cutoff);
  if (startIndex < 0) startIndex = Math.max(0, cleanPoints.length - 3);

  for (let i = cleanPoints.length - 1; i > 0; i--) {
    if (finiteSpeed(cleanPoints[i - 1]) >= 20 && finiteSpeed(cleanPoints[i]) < 20) {
      startIndex = Math.min(startIndex, i - 1);
      break;
    }
  }

  const window = cleanPoints.slice(startIndex);
  if (window.length < 3) {
    return {
      parking_approach_score: null,
      parking_approach_grade: 'insufficient_data',
      parking_stop_detected: finiteSpeed(lastPoint) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH),
      parking_stop_duration_seconds: Math.round(terminalStoppedSeconds),
    };
  }

  let penalty = 0;
  const harshThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1];
    const curr = window[i];
    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const accelMs2 = calculateAcceleration(finiteSpeed(prev), finiteSpeed(curr), dt);
    const { h1, h2 } = headingBetweenPair(prev, curr, window[i - 2] || null);
    const headingRate = headingDiff(h1, h2) / dt;
    if (accelMs2 < -harshThreshold) penalty += 15;
    if (headingRate > 30 && finiteSpeed(curr) > 8) penalty += 8;
    if (finiteSpeed(curr) - finiteSpeed(prev) > 5) penalty += 5;
  }

  const score = Math.max(0, 100 - penalty);
  return {
    parking_approach_score: score,
    parking_approach_grade: score >= 90 ? 'smooth' : score >= 70 ? 'acceptable' : 'rough',
    parking_stop_detected: finiteSpeed(lastPoint) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH),
    parking_stop_duration_seconds: Math.round(terminalStoppedSeconds),
  };
}
