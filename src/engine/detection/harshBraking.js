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
  BRAKING_GRADE_THRESHOLDS,
  analyzeIntersectionBehavior,
  analyzeParkingApproach,
  brakingEfficiencyGrade,
  calculateBrakingEfficiency,
  calculateCorneringConsistency,
  calculateOvertakeQualityScore,
  calculateRoadTypeSegmentedScores,
  calculateSpeedLimitCompliance,
  complianceFallbackLimit,
  contextualFallbackLimitKmh,
  detectSlipperyConditionProxy,
  getInferredLimitForPoint,
  hasSustainedLateralG,
  lateralGForTriplet,
  resolveEffectiveSpeedLimitForIndex,
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
import {
  detectAggressiveOvertakes
} from './overtakePattern.js';

export function emptyPhoneUseResult() {
  return {
    phone_use_events: [],
    phone_use_window_count: 0,
    phone_use_total_seconds: 0,
    phone_use_high_confidence_count: 0,
    phone_use_risk: 'none',
    phone_use_score: null,
    phone_use_score_available: false,
    phone_use_score_status: 'usage_access_required',
    phone_use_pct_of_trip: 0,
    phone_proxy_events: [],
    phone_proxy_count: 0,
    phone_proxy_risk: 'none',
    data_sources: [],
  };
}

export function summarizePhoneUseEvents(events = [], durationSeconds = 0) {
  const phoneEvents = events.filter((event) => event.type === EVENT_TYPES.PHONE_USE);
  const confirmedEvents = phoneEvents.filter((event) => event.source === 'android_usage_access');
  if (!confirmedEvents.length) {
    const proxyEvents = phoneEvents.filter((event) => event.source === 'gps_proxy' || event.diagnostic_only === true);
    const proxyRisk = proxyEvents.length > 0 ? 'possible' : 'none';
    return {
      ...emptyPhoneUseResult(),
      phone_proxy_events: proxyEvents,
      phone_proxy_count: proxyEvents.length,
      phone_proxy_risk: proxyRisk,
      data_sources: proxyEvents.length > 0 ? ['gps_proxy'] : [],
    };
  }
  const totalSeconds = confirmedEvents.reduce((sum, event) => sum + Number(event.durationS || event.duration_seconds || 0), 0);
  const highConfidenceCount = confirmedEvents.filter((event) => Number(event.confidence) >= 0.75).length;
  const anyVeryFast = confirmedEvents.some((event) => Number(event.speed_kmh) >= 100);
  const phoneUseRisk = highConfidenceCount >= 3 || totalSeconds > 90 || anyVeryFast
    ? 'high'
    : highConfidenceCount >= 1 || totalSeconds >= 30
      ? 'medium'
      : 'low';
  const scorePenalty = confirmedEvents.reduce((sum, event) => (
    sum + (event.severity === 'high' ? 20 : event.severity === 'medium' ? 8 : 3)
  ), 0) + (anyVeryFast ? 15 : 0);
  return {
    phone_use_events: confirmedEvents,
    phone_use_window_count: confirmedEvents.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: Math.max(0, Math.round(100 - scorePenalty)),
    phone_use_score_available: true,
    phone_use_score_status: 'android_usage_access',
    phone_use_pct_of_trip: round2((totalSeconds / Math.max(1, durationSeconds)) * 100),
    phone_proxy_events: [],
    phone_proxy_count: 0,
    phone_proxy_risk: 'none',
    data_sources: ['android_usage_access'],
  };
}

/**
 * Detect likely phone-use windows from multi-signal GPS behavior evidence.
 * @param {Array<{lat:number,lng:number,timestamp:string,speed_kmh?:number,heading?:number,accuracy?:number}>} routePoints - Cleaned route points.
 * @param {Object} thresholds - Driving thresholds from buildDrivingThresholds.
 * @returns {{phone_use_events:Array,phone_use_window_count:number,phone_use_total_seconds:number,phone_use_high_confidence_count:number,phone_use_risk:string,phone_use_score:number|null,phone_use_score_available:boolean,phone_use_score_status:string,phone_use_pct_of_trip:number,phone_proxy_events:Array,phone_proxy_count:number,phone_proxy_risk:string,phone_proxy_diagnostic_score?:number,data_sources:Array<string>}} Phone-use result.
 * @example
 * const phoneUse = detectPhoneUseWindows(routePoints, buildDrivingThresholds(settings));
 */
export function detectPhoneUseWindows(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (thresholds.PHONE_USE_DETECTION_ENABLED === false) return emptyPhoneUseResult();
  const points = routePoints || [];
  if (points.length < 3) return emptyPhoneUseResult();

  const samples = points
    .map((point, index) => ({
      point,
      index,
      timestamp: timestampMs(point),
      speed_kmh: reliablePointSpeed(points, index, thresholds) ?? finiteSpeed(point),
      heading: headingForIndex(points, index),
    }))
    .filter((sample) => Number.isFinite(sample.timestamp));
  if (samples.length < 3) return emptyPhoneUseResult();

  const votes = [];
  const addVote = (signal, startIndex, endIndex, strength) => {
    if (startIndex < 0 || endIndex <= startIndex || !Number.isFinite(strength) || strength <= 0) return;
    votes.push({
      signal,
      startIndex: Math.max(0, startIndex),
      endIndex: Math.min(points.length - 1, endIndex),
      strength: Math.max(0, strength),
    });
  };

  const signedHeadingDeltas = samples.map((sample, index) => {
    if (index === 0) return 0;
    return signedHeadingDelta(samples[index - 1].heading, sample.heading);
  });
  const speedDeltas = samples.map((sample, index) => {
    if (index === 0) return 0;
    return sample.speed_kmh - samples[index - 1].speed_kmh;
  });
  const accelSamples = samples.map((sample, index) => {
    if (index === 0) return 0;
    const dt = (sample.timestamp - samples[index - 1].timestamp) / 1000;
    return dt > 0 ? calculateAcceleration(samples[index - 1].speed_kmh, sample.speed_kmh, dt) : 0;
  });

  // Signal 1: micro-steering oscillations.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const windowSeconds = thresholds.PHONE_MICRO_STEER_WINDOW_S ?? 15;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + windowSeconds * 1000);
    if (window.length < 4) continue;
    const maxAccuracy = thresholds.PHONE_PROXY_MAX_ACCURACY_M ?? 20;
    if (window.some((sample) => Number.isFinite(Number(sample.point?.accuracy)) && Number(sample.point.accuracy) > maxAccuracy)) continue;
    let oscillations = 0;
    for (let j = 2; j < window.length; j++) {
      const globalIndex = window[j].index;
      const d1 = signedHeadingDeltas[Math.max(0, globalIndex - 1)];
      const d2 = signedHeadingDeltas[globalIndex];
      const bothMicro = Math.abs(d1) >= 3 && Math.abs(d1) <= 18 && Math.abs(d2) >= 3 && Math.abs(d2) <= 18;
      if (bothMicro && Math.sign(d1) !== Math.sign(d2)) oscillations++;
    }
    if (oscillations >= (thresholds.PHONE_MICRO_STEER_COUNT ?? 6)) {
      addVote('micro_steer', window[0].index, window[window.length - 1].index, Math.min(1, oscillations / 8));
      i += Math.max(1, Math.floor(window.length / 2));
    }
  }

  // Signal 2: speed creep without intent followed by abrupt correction.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 15000);
    if (window.length < 5) continue;
    const durationS = (window[window.length - 1].timestamp - window[0].timestamp) / 1000;
    if (durationS <= 0) continue;
    const speeds = window.map((sample) => sample.speed_kmh);
    const driftRate = (Math.max(...speeds) - Math.min(...speeds)) / durationS;
    const risingPairs = speeds.slice(1).filter((speed, index) => speed >= speeds[index] - 0.5).length;
    const trendIsMonotonic = risingPairs / Math.max(1, speeds.length - 1) >= 0.75 &&
      Math.max(...window.map((sample) => Math.abs(accelSamples[sample.index] || 0))) < 2.5;
    const after = samples.filter((sample) => sample.timestamp > window[window.length - 1].timestamp && sample.timestamp <= window[window.length - 1].timestamp + 3000);
    const correctionAbrupt = after.some((sample) => (accelSamples[sample.index] || 0) <= -1.5);
    if (driftRate >= (thresholds.PHONE_CREEP_RATE_KMH_S ?? 1.5) && trendIsMonotonic && correctionAbrupt) {
      addVote('speed_creep', window[0].index, window[window.length - 1].index, 0.7);
    }
  }

  // Signal 3: attention gap against rolling speed pattern.
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    if (sample.speed_kmh < 30) continue;
    const history = samples.filter((entry) => entry.timestamp >= sample.timestamp - 20000 && entry.timestamp < sample.timestamp);
    if (history.length < 5) continue;
    const rollingSpeed = average(history.map((entry) => entry.speed_kmh));
    if (Math.abs(sample.speed_kmh - rollingSpeed) < 8) continue;
    const gap = samples.filter((entry) => entry.timestamp >= sample.timestamp && entry.timestamp <= sample.timestamp + 5000);
    if (gap.length < 3 || gap[gap.length - 1].timestamp - gap[0].timestamp < 4000) continue;
    const noInput = gap.every((entry) => Math.abs(accelSamples[entry.index] || 0) <= 0.4);
    if (noInput) addVote('attention_gap', gap[0].index, gap[gap.length - 1].index, 0.8);
  }

  // Signal 4: lane drift and recovery.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 40) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 8000);
    if (window.length < 5) continue;
    const firstHalf = window.filter((sample) => sample.timestamp <= start.timestamp + 4000);
    if (firstHalf.length < 3) continue;
    const driftValues = firstHalf.map((sample) => signedHeadingDelta(firstHalf[0].heading, sample.heading));
    const driftMagnitude = Math.max(...driftValues.map(Math.abs));
    const peakOffset = driftValues.findIndex((value) => Math.abs(value) === driftMagnitude);
    const peak = firstHalf[Math.max(0, peakOffset)];
    const recovery = window[window.length - 1];
    const timeToRecover = Math.max(0.5, (recovery.timestamp - peak.timestamp) / 1000);
    const recoverySpeed = headingDiff(recovery.heading, peak.heading) / timeToRecover;
    if (driftMagnitude >= (thresholds.PHONE_LANE_DRIFT_DEG ?? 8) && recoverySpeed >= 3) {
      addVote('lane_drift', window[0].index, window[window.length - 1].index, Math.min(1, driftMagnitude / 20));
    }
  }

  // Signal 5: speed-heading decoupling.
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i];
    if (start.speed_kmh < 30) continue;
    const window = samples.filter((sample) => sample.timestamp >= start.timestamp && sample.timestamp <= start.timestamp + 20000);
    if (window.length < 8) continue;
    const headingChanges = window.map((sample) => Math.abs(signedHeadingDeltas[sample.index] || 0));
    const speedChanges = window.map((sample) => Math.abs(speedDeltas[sample.index] || 0));
    if (average(headingChanges) < 1 || average(speedChanges) < 0.2) continue;
    const correlation = pearsonCorrelation(headingChanges, speedChanges);
    const threshold = thresholds.PHONE_COUPLING_THRESHOLD ?? 0.15;
    if (correlation < threshold) {
      addVote('speed_heading_decoupling', window[0].index, window[window.length - 1].index, Math.min(1, (threshold - correlation) * 5));
    }
  }

  if (!votes.length) return emptyPhoneUseResult();

  const timeline = new Array(points.length).fill(0);
  for (const vote of votes) {
    for (let i = vote.startIndex; i <= vote.endIndex; i++) timeline[i] += vote.strength;
  }
  const kernel = [0.1, 0.2, 0.4, 0.2, 0.1];
  const smoothed = timeline.map((_, index) => kernel.reduce((sum, weight, kernelIndex) => {
    const sourceIndex = index + kernelIndex - 2;
    return sum + weight * (timeline[sourceIndex] || 0);
  }, 0));

  const confidenceThreshold = thresholds.PHONE_CONFIDENCE_THRESHOLD ?? 0.40;
  const runs = [];
  let startRun = null;
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] >= confidenceThreshold && startRun == null) startRun = i;
    if ((smoothed[i] < confidenceThreshold || i === smoothed.length - 1) && startRun != null) {
      const endRun = smoothed[i] < confidenceThreshold ? i - 1 : i;
      if (endRun >= startRun) runs.push({ startIndex: startRun, endIndex: endRun });
      startRun = null;
    }
  }

  const merged = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    const gapS = previous ? (timestampMs(points[run.startIndex]) - timestampMs(points[previous.endIndex])) / 1000 : Infinity;
    if (previous && gapS < 8) previous.endIndex = run.endIndex;
    else merged.push({ ...run });
  }

  const minWindowS = thresholds.PHONE_MIN_WINDOW_S ?? 4;
  const events = merged
    .map((run) => {
      const startTimeMs = timestampMs(points[run.startIndex]);
      const endTimeMs = timestampMs(points[run.endIndex]);
      const durationS = Math.max(0, (endTimeMs - startTimeMs) / 1000);
      if (durationS < minWindowS) return null;
      const midpointIndex = Math.round((run.startIndex + run.endIndex) / 2);
      const signalsTriggered = [...new Set(votes
        .filter((vote) => vote.startIndex <= run.endIndex && vote.endIndex >= run.startIndex)
        .map((vote) => vote.signal))];
      const windowSamples = samples.filter((sample) => sample.index >= run.startIndex && sample.index <= run.endIndex);
      const windowDeltas = windowSamples
        .slice(1)
        .map((sample, offset) => signedHeadingDelta(windowSamples[offset].heading, sample.heading));
      const cumulativeHeadingChange = windowDeltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
      const netHeadingChange = windowSamples.length >= 2
        ? headingDiff(windowSamples[0].heading, windowSamples[windowSamples.length - 1].heading)
        : 0;
      const sustainedTurnLike = netHeadingChange >= 35 || (
        durationS <= 12 &&
        cumulativeHeadingChange >= 70 &&
        !signalsTriggered.includes('micro_steer')
      );
      if (sustainedTurnLike && signalsTriggered.length < 2) return null;

      const meanSpeed = average(windowSamples.map((sample) => sample.speed_kmh));
      const confidence = Math.min(1, average(smoothed.slice(run.startIndex, run.endIndex + 1)));
      const hasPrimaryPhoneSignal = signalsTriggered.includes('micro_steer') ||
        signalsTriggered.includes('speed_creep');
      if (!hasPrimaryPhoneSignal) return null;
      const confidenceLevel = confidence < 0.55 ? 'low' : confidence < 0.75 ? 'medium' : 'high';
      const severity = confidence < 0.55 || meanSpeed < 50
        ? 'low'
        : confidence < 0.75 || meanSpeed < 80
          ? 'medium'
          : 'high';
      return {
        type: EVENT_TYPES.PHONE_USE,
        source: 'gps_proxy',
        diagnostic_only: true,
        startIndex: run.startIndex,
        endIndex: run.endIndex,
        point_index: midpointIndex,
        startTime: new Date(startTimeMs).toISOString(),
        endTime: new Date(endTimeMs).toISOString(),
        timestamp: new Date(startTimeMs).toISOString(),
        durationS: Math.round(durationS),
        duration_seconds: Math.round(durationS),
        lat: points[midpointIndex]?.lat,
        lng: points[midpointIndex]?.lng,
        speed_kmh: Math.round(meanSpeed),
        confidence: round2(confidence),
        confidence_level: confidenceLevel,
        signals_triggered: signalsTriggered,
        context_flags: sustainedTurnLike ? ['turn_or_merge_context'] : [],
        severity,
        value: round2(confidence),
      };
    })
    .filter(Boolean);

  const totalSeconds = events.reduce((sum, event) => sum + (event.durationS || 0), 0);
  const highConfidenceCount = events.filter((event) => event.confidence >= 0.75).length;
  const anyVeryFast = events.some((event) => event.speed_kmh >= 100);
  const phoneUseRisk = events.length === 0
    ? 'none'
    : highConfidenceCount >= 3 || totalSeconds > 90 || anyVeryFast
      ? 'high'
      : highConfidenceCount >= 1 || totalSeconds >= 30
        ? 'medium'
        : 'low';
  const scorePenalty = events.reduce((sum, event) => (
    sum + (event.severity === 'high' ? 20 : event.severity === 'medium' ? 8 : 3)
  ), 0) + (anyVeryFast ? 15 : 0);
  const tripDurationS = Math.max(1, (timestampMs(points[points.length - 1]) - timestampMs(points[0])) / 1000);

  return {
    phone_use_events: events,
    phone_use_window_count: events.length,
    phone_use_total_seconds: Math.round(totalSeconds),
    phone_use_high_confidence_count: highConfidenceCount,
    phone_use_risk: phoneUseRisk,
    phone_use_score: null,
    phone_use_score_available: false,
    phone_use_score_status: 'usage_access_required',
    phone_use_pct_of_trip: round2((totalSeconds / tripDurationS) * 100),
    phone_proxy_events: events,
    phone_proxy_count: events.length,
    phone_proxy_risk: phoneUseRisk === 'none' ? 'none' : phoneUseRisk === 'low' ? 'possible' : 'likely',
    phone_proxy_diagnostic_score: Math.max(0, Math.round(100 - scorePenalty)),
    data_sources: events.length > 0 ? ['gps_proxy'] : [],
  };
}

export function detectPhoneUsageProxy(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const result = detectPhoneUseWindows(cleanPoints, thresholds);
  return {
    phone_proxy_count: result.phone_use_window_count,
    phone_proxy_risk: result.phone_use_risk === 'none' ? 'none' : result.phone_use_risk === 'low' ? 'possible' : 'likely',
  };
}

export function detectPhoneProxy(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  return detectPhoneUsageProxy(cleanPoints, thresholds);
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

export function attachEventResult(events = [], phoneUse = emptyPhoneUseResult()) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safePhoneUse = phoneUse && typeof phoneUse === 'object' && !Array.isArray(phoneUse)
    ? phoneUse
    : emptyPhoneUseResult();
  return { events: safeEvents, phoneUse: safePhoneUse };
}

export function maskDetectedEventsForPrivacy(events = [], privacyZones = []) {
  return privacyZones?.length
    ? events.map((event) => maskEventCoordinatesForPrivacy(event, privacyZones))
    : events;
}

export function detectDrivingEvents(points, thresholds = DEFAULT_THRESHOLDS, endTime = null, privacyZones = []) {
  const events = [];
  if (!Array.isArray(points) || points.length < 3) return attachEventResult();

  const EVENT_COOLDOWN_SECONDS = {
    [EVENT_TYPES.HARSH_BRAKE]: 4,
    [EVENT_TYPES.RAPID_ACCELERATION]: 4,
    [EVENT_TYPES.SHARP_TURN]: 3,
    [EVENT_TYPES.SPEEDING]: 10,
  };
  const lastEventTime = {
    [EVENT_TYPES.HARSH_BRAKE]: null,
    [EVENT_TYPES.RAPID_ACCELERATION]: null,
    [EVENT_TYPES.SHARP_TURN]: null,
    [EVENT_TYPES.SPEEDING]: null,
  };
  const MIN_POINTS_BEFORE_EVENTS = 0;
  const MIN_SPEEDING_SECONDS = 3;
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const smoothedAccels = computeSmoothedAccelerations(points, thresholds);
  const configuredSpeedThreshold = thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  const inferredZones = inferSpeedZones(points, thresholds);
  const zoneForIndex = createZoneLookup(inferredZones);
  const roadTypesByPoint = classifyRoadTypesByPoint(points);

  let idleStart = null;
  let idleAccum = 0;
  let previousReliableSpeed = points[0]?.speed_kmh ?? 0;
  let acceptedSegmentCount = 0;
  let speedingAccumSeconds = 0;
  let speedingStart = null;
  let speedingPeakPoint = null;
  let speedingPeakSpeed = 0;
  let speedingZone = null;

  const canEmitEvent = (eventType, timestamp) => {
    const cooldownSeconds = EVENT_COOLDOWN_SECONDS[eventType];
    if (!cooldownSeconds) return true;

    const tsSec = new Date(timestamp).getTime() / 1000;
    if (!Number.isFinite(tsSec)) return true;

    const lastTime = lastEventTime[eventType];
    if (lastTime !== null && (tsSec - lastTime) < cooldownSeconds) return false;

    lastEventTime[eventType] = tsSec;
    return true;
  };

  const pushEvent = (event) => {
    if (!canEmitEvent(event.type, event.timestamp)) return false;
    events.push(event);
    return true;
  };

  const speedingSeverity = (speed, limit = null) => (
    limit != null
      ? speed > limit + 30 ? 'high' : speed > limit + 20 ? 'medium' : 'low'
      : speed > 160 ? 'high' : speed > 140 ? 'medium' : 'low'
  );

  const flushSpeedingWindow = () => {
    if (speedingAccumSeconds >= MIN_SPEEDING_SECONDS && speedingStart) {
      const eventPoint = speedingPeakPoint || speedingStart;
      const eventLimitKmh = speedingZone?.effectiveLimitKmh ?? speedingZone?.actualLimitKmh ?? speedingZone?.inferredLimitKmh ?? null;
      pushEvent({
        type: EVENT_TYPES.SPEEDING,
        severity: speedingSeverity(speedingPeakSpeed, eventLimitKmh),
        lat: eventPoint.lat,
        lng: eventPoint.lng,
        timestamp: speedingStart.timestamp,
        value: Math.round(speedingPeakSpeed),
        speed_kmh: Math.round(speedingPeakSpeed),
        speed_limit_kmh: eventLimitKmh,
        speed_limit_source: speedingZone?.limitSource ?? null,
        speed_limit_default_country: speedingZone?.speedLimitDefaultCountry ?? null,
        fallback_country: speedingZone?.speedLimitDefaultCountry ?? null,
        inferred_zone_kmh: speedingZone?.inferredZoneKmh ?? null,
        zone_confidence: speedingZone?.confidence ?? null,
      });
    }

    speedingAccumSeconds = 0;
    speedingStart = null;
    speedingPeakPoint = null;
    speedingPeakSpeed = 0;
    speedingZone = null;
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];

    const dt = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000; // seconds
    if (dt <= 0 || dt > 120) {
      flushSpeedingWindow();
      continue; // skip gaps > 2 minutes (possible pause)
    }

    const currSegment = calculateSegmentMetrics(prev, curr, thresholds);
    if (currSegment.isNoise) {
      flushSpeedingWindow();
      continue;
    }

    acceptedSegmentCount++;
    const speed2 = reliablePointSpeed(points, i, thresholds) ?? currSegment.impliedSpeedKmh;

    if (acceptedSegmentCount <= MIN_POINTS_BEFORE_EVENTS) {
      previousReliableSpeed = speed2;
      continue;
    }

    const smooth = [i - 1, i, i + 1].some((idx) => isLikelySpeedSpike(points, idx, thresholds))
      ? null
      : smoothedAccels[i];
    const speed1 = smooth?.speed_kmh ?? previousReliableSpeed;
    const rawAccel = dt <= 10 ? calculateAcceleration(previousReliableSpeed, speed2, dt) : null;
    const accel = smooth?.accel_ms2 ?? rawAccel;

    // ── Harsh Braking
    // Threshold: deceleration > 4.5 m/s² while above 20 km/h (to avoid parking noise)
    if (accel != null && accel < -thresholds.HARSH_BRAKE_MS2 && speed1 >= (thresholds.MIN_SPEED_HARSH_BRAKE_KMH ?? 25)) {
      pushEvent({
        type: EVENT_TYPES.HARSH_BRAKE,
        severity: Math.abs(accel) > 6 ? 'high' : Math.abs(accel) > 5 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        point_index: i,
        value: Math.abs(accel),
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Rapid Acceleration
    // Threshold: acceleration > 3.0 m/s2 from speed > 5 km/h
    if (accel != null && accel > thresholds.RAPID_ACCEL_MS2 && speed1 >= (thresholds.MIN_SPEED_RAPID_ACCEL_KMH ?? DEFAULT_THRESHOLDS.MIN_SPEED_RAPID_ACCEL_KMH)) {
      pushEvent({
        type: EVENT_TYPES.RAPID_ACCELERATION,
        severity: accel > 5 ? 'high' : accel > 4 ? 'medium' : 'low',
        lat: curr.lat,
        lng: curr.lng,
        timestamp: curr.timestamp,
        point_index: i,
        value: accel,
        speed_kmh: Math.round(speed1),
      });
    }

    // ── Sharp Turn
    // Sharp turns use lateral g, with stricter gates to avoid normal city corners.
    if (i > 1 && i < points.length - 1) {
      const lowG = thresholds.SHARP_TURN_G_LOW ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW;
      const mediumG = thresholds.SHARP_TURN_G_MEDIUM ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM;
      const highG = thresholds.SHARP_TURN_G_HIGH ?? DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH;
      const lateralG = lateralGForTriplet(points, i, thresholds);
      const h0 = smoothHeading(points, i - 1);
      const h2 = smoothHeading(points, i + 1);
      const rawHeadingChange = Number.isFinite(h0) && Number.isFinite(h2) ? headingDiff(h0, h2) : 0;

      if (
        rawHeadingChange >= 30 &&
        Number.isFinite(lateralG) &&
        lateralG >= lowG &&
        hasSustainedLateralG(points, i, lowG, thresholds)
      ) {
        pushEvent({
          type: EVENT_TYPES.SHARP_TURN,
          severity: lateralG >= highG ? 'high' : lateralG >= mediumG ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: curr.timestamp,
          point_index: i,
          value: Math.round(lateralG * 100) / 100,
          speed_kmh: Math.round(speed2),
        });
      }
    }

    // ── Speeding (fallback – no speed limit data)
    // Flag when speed exceeds OSM maxspeed + margin, or the fallback threshold.
    const speedLimitContext = resolveEffectiveSpeedLimitForIndex(points, i, thresholds, {
      zoneForIndex,
      roadTypesByPoint,
    });
    const {
      actualLimitKmh,
      effectiveLimitKmh,
      fallbackLimitKmh,
      inferredLimitKmh,
      inferredZone,
      limitSource,
      speedLimitSource,
      speedLimitDefaultCountry,
    } = speedLimitContext;
    const speedOverKmh = thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH;
    const segmentZone = {
      ...(inferredZone || {}),
      inferredZoneKmh: inferredZone?.inferredZoneKmh ?? inferredLimitKmh ?? fallbackLimitKmh,
      inferredLimitKmh,
      confidence: inferredZone?.confidence ?? 'fallback',
      road_type: inferredZone?.road_type ?? roadTypesByPoint[i] ?? 'urban',
      actualLimitKmh,
      effectiveLimitKmh,
      limitSource,
      speedLimitSource,
      speedLimitDefaultCountry,
    };
    const contextualSpeedingThreshold = effectiveLimitKmh != null
      ? effectiveLimitKmh + speedOverKmh
      : configuredSpeedThreshold + speedOverKmh;

    if (speed2 > contextualSpeedingThreshold) {
      if (!speedingStart) speedingStart = curr;
      speedingAccumSeconds += dt;
      speedingZone = segmentZone;
      if (speed2 > speedingPeakSpeed) {
        speedingPeakSpeed = speed2;
        speedingPeakPoint = curr;
        speedingZone = segmentZone;
      }
    } else {
      flushSpeedingWindow();
    }

    // ── Idle accumulation
    if (speed2 < thresholds.IDLE_SPEED_KMH) {
      if (!idleStart) idleStart = curr.timestamp;
      idleAccum += dt;
    } else {
      if (idleAccum >= thresholds.IDLE_EVENT_SECONDS) {
        events.push({
          type: EVENT_TYPES.IDLE,
          severity: idleAccum > 300 ? 'high' : idleAccum > 180 ? 'medium' : 'low',
          lat: curr.lat,
          lng: curr.lng,
          timestamp: idleStart,
          value: idleAccum,
        });
      }
      idleStart = null;
      idleAccum = 0;
      // FIX: Reset after an idle event window closes so a continuous stop emits only one IDLE event.
    }

    previousReliableSpeed = speed2;
  }

  flushSpeedingWindow();

  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(points, endTime, thresholds);
  if (terminalStoppedSeconds > 0) {
    const lastPoint = points[points.length - 1];
    if (!idleStart) idleStart = lastPoint.timestamp;
    idleAccum += terminalStoppedSeconds;
  }

  // Flush any open idle window at trip end.
  if (idleAccum >= thresholds.IDLE_EVENT_SECONDS && idleStart) {
    const lastPoint = points[points.length - 1];
    events.push({
      type: EVENT_TYPES.IDLE,
      severity: idleAccum > 300 ? 'high' : idleAccum > 180 ? 'medium' : 'low',
      lat: lastPoint.lat,
      lng: lastPoint.lng,
      timestamp: lastPoint.timestamp,
      value: Math.round(idleAccum),
    });
    idleAccum = 0;
    // FIX: Clear the flushed trip-end idle window to prevent duplicate IDLE handling.
  }

  const alwaysOnEvents = [
    detectStopStartPatterns(points, thresholds),
    detectErraticSpeedWindows(points, thresholds),
    detectHeadingDeviationEvents(points, thresholds),
  ];
  if (advancedSafetyEnabled) {
    alwaysOnEvents.push(
      detectAggressiveOvertakes(points, thresholds),
      detectCloseProximityManeuverAlerts(points, thresholds)
    );
  }
  const phoneUse = advancedSafetyEnabled ? detectPhoneUseWindows(points, thresholds) : emptyPhoneUseResult();
  const privacySafePhoneUse = privacyZones?.length && Array.isArray(phoneUse.phone_use_events)
    ? { ...phoneUse, phone_use_events: maskDetectedEventsForPrivacy(phoneUse.phone_use_events, privacyZones) }
    : phoneUse;
  const combined = events.concat(...alwaysOnEvents, privacySafePhoneUse.phone_use_events || []);
  return attachEventResult(maskDetectedEventsForPrivacy(combined, privacyZones), privacySafePhoneUse);
}
