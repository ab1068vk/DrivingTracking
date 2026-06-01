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
import type { RoutePoint, TripStats } from '@/types';

type DrivingThresholds = Record<string, unknown>;
type ScoreFields = Record<string, unknown>;

interface SviSample {
  index: number;
  speed: number;
}

interface SviGroup {
  multiplier: number;
  samples: SviSample[];
  deviation?: number;
  distanceKm?: number;
  score?: number;
}

export function calculateJerkScore(
  cleanPoints: RoutePoint[] = [],
  distanceKmOrThresholds: number | DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const thresholds = typeof distanceKmOrThresholds === 'number'
    ? DEFAULT_THRESHOLDS
    : distanceKmOrThresholds || DEFAULT_THRESHOLDS;
  const distanceKm = typeof distanceKmOrThresholds === 'number'
    ? (Number.isFinite(distanceKmOrThresholds) ? Math.max(0, distanceKmOrThresholds) : 0)
    : calculateRouteDistanceKm(cleanPoints, thresholds);

  if (!cleanPoints || cleanPoints.length < 3) {
    return {
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
      jerk_event_count: 0,
      avg_jerk_ms3: 0,
    };
  }

  let totalJerkPenalty = 0;
  let jerkEventCount = 0;
  let jerkAbsTotal = 0;
  let jerkSampleCount = 0;

  for (let i = 1; i < cleanPoints.length - 1; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const next = cleanPoints[i + 1];
    const dt1 = (timestampMs(curr) - timestampMs(prev)) / 1000;
    const dt2 = (timestampMs(next) - timestampMs(curr)) / 1000;
    if (dt1 <= 0 || dt2 <= 0 || dt1 > 60 || dt2 > 60) continue;
    const prevSegment = calculateSegmentMetrics(prev, curr, thresholds);
    const nextSegment = calculateSegmentMetrics(curr, next, thresholds);
    if (prevSegment.isNoise || nextSegment.isNoise) continue;

    const s0 = reliablePointSpeed(cleanPoints, i - 1, thresholds) ?? finiteSpeed(prev);
    const s1 = reliablePointSpeed(cleanPoints, i, thresholds) ?? finiteSpeed(curr);
    const s2 = reliablePointSpeed(cleanPoints, i + 1, thresholds) ?? finiteSpeed(next);
    if ((s0 + s1 + s2) / 3 < 8) continue;

    const v0 = s0 / 3.6;
    const v1 = s1 / 3.6;
    const v2 = s2 / 3.6;
    const a1 = (v1 - v0) / dt1;
    const a2 = (v2 - v1) / dt2;
    const jerk = (a2 - a1) / ((dt1 + dt2) / 2);
    const absJerk = Math.abs(jerk);
    if (!Number.isFinite(absJerk)) continue;

    jerkAbsTotal += absJerk;
    jerkSampleCount++;
    if (absJerk > 6) totalJerkPenalty += 4;
    else if (absJerk > 3) totalJerkPenalty += 2;
    else if (absJerk > 1.5) totalJerkPenalty += 1;
    if (absJerk > 1.5) jerkEventCount++;
  }

  if (distanceKm < 0.5 || jerkSampleCount === 0) {
    return {
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
      jerk_event_count: jerkEventCount,
      avg_jerk_ms3: round1(jerkSampleCount ? jerkAbsTotal / jerkSampleCount : 0),
    };
  }

  const distFactor = Math.max(1, distanceKm);
  const penaltyContribution = Math.min(totalJerkPenalty * (4 / distFactor), 100);
  const jerkScore = Math.max(0, 100 - penaltyContribution);
  return {
    jerk_score: Math.round(jerkScore),
    jerk_score_confidence: distanceKm < 3 ? 'low' : 'high',
    jerk_event_count: jerkEventCount,
    avg_jerk_ms3: round1(jerkSampleCount ? jerkAbsTotal / jerkSampleCount : 0),
  };
}

export function calculateHillDrivingScore(
  cleanPoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const maxAltitudeAccuracy = thresholds.MAX_ALTITUDE_ACCURACY_M ?? DEFAULT_THRESHOLDS.MAX_ALTITUDE_ACCURACY_M;
  const hasReliableAltitude = (point: RoutePoint | null | undefined): boolean => (
    Number.isFinite(point?.altitude) &&
    (!Number.isFinite(point?.altitude_accuracy) || point.altitude_accuracy <= maxAltitudeAccuracy)
  );
  const altitudePoints = cleanPoints.filter(hasReliableAltitude);
  if (!cleanPoints.length || altitudePoints.length / cleanPoints.length < 0.5) {
    return {
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_infraction_rate_per_km: 0,
      hill_driving_score: null,
      hill_route: false,
    };
  }

  let climbDistanceKm = 0;
  let descentDistanceKm = 0;
  let infractionCount = 0;
  let descentWindowStart = null;
  let descentWindowSpeed = 0;
  let previousReliableSpeed = null;
  const harshBrakeThreshold = thresholds.threshold_harsh_brake_ms2 ?? thresholds.HARSH_BRAKE_MS2 ?? DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2;
  const minHillDistanceM = thresholds.MIN_HILL_SEGMENT_DISTANCE_M ?? DEFAULT_THRESHOLDS.MIN_HILL_SEGMENT_DISTANCE_M;
  const hillGradeThreshold = thresholds.HILL_GRADE_THRESHOLD_PCT ?? DEFAULT_THRESHOLDS.HILL_GRADE_THRESHOLD_PCT;
  const hillAccelThreshold = Math.max(
    0,
    settingNumber(thresholds.HILL_ACCEL_THRESHOLD_MS2, DEFAULT_THRESHOLDS.HILL_ACCEL_THRESHOLD_MS2)
  );
  const hillInfractionPenaltyPointsPerKm = Math.max(
    0,
    settingNumber(
      thresholds.HILL_INFRACTION_PENALTY_POINTS_PER_KM,
      DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS_PER_KM
    )
  );

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    if (!hasReliableAltitude(prev) || !hasReliableAltitude(curr)) {
      previousReliableSpeed = null;
      descentWindowStart = null;
      continue;
    }

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 120) {
      previousReliableSpeed = null;
      descentWindowStart = null;
      continue;
    }

    const distanceM = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
    if (distanceM < minHillDistanceM) continue;

    const segment = calculateSegmentMetrics(prev, curr, thresholds);
    const pointSpeed = reliablePointSpeed(cleanPoints, i, thresholds);
    const rawSpeed = pointSpeedKmh(curr, thresholds);
    const speed = pointSpeed ?? rawSpeed ?? segment.impliedSpeedKmh;
    const gradient = ((curr.altitude - prev.altitude) / distanceM) * 100;
    const accelMs2 = previousReliableSpeed == null
      ? 0
      : calculateAcceleration(previousReliableSpeed, speed, dt);
    const isClimb = gradient >= hillGradeThreshold;
    const isDescent = gradient <= -hillGradeThreshold;

    if (isClimb) {
      climbDistanceKm += distanceM / 1000;
      if (!segment.isNoise && speed >= 15 && accelMs2 > hillAccelThreshold) infractionCount++;
      descentWindowStart = null;
    } else if (isDescent) {
      descentDistanceKm += distanceM / 1000;
      if (!segment.isNoise && speed >= 15 && accelMs2 < -harshBrakeThreshold) infractionCount++;

      if (!descentWindowStart || (timestampMs(curr) - timestampMs(descentWindowStart)) / 1000 > 10) {
        descentWindowStart = curr;
        descentWindowSpeed = speed;
      } else if (!segment.isNoise && speed >= 15 && speed - descentWindowSpeed > 15) {
        infractionCount++;
        descentWindowStart = curr;
        descentWindowSpeed = speed;
      }
    } else {
      descentWindowStart = null;
    }
    previousReliableSpeed = speed;
  }

  const hillDistanceKm = climbDistanceKm + descentDistanceKm;

  if (hillDistanceKm < 0.2) {
    return {
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_infraction_rate_per_km: 0,
      hill_driving_score: null,
      hill_route: false,
    };
  }

  const hillInfractionRatePerKm = infractionCount / Math.max(1, hillDistanceKm);
  const hillPenalty = hillInfractionRatePerKm * hillInfractionPenaltyPointsPerKm;

  return {
    climb_distance_km: Math.round(climbDistanceKm * 100) / 100,
    descent_distance_km: Math.round(descentDistanceKm * 100) / 100,
    hill_infraction_count: infractionCount,
    hill_infraction_rate_per_km: Math.round(hillInfractionRatePerKm * 100) / 100,
    hill_driving_score: Math.max(0, Math.round(100 - hillPenalty)),
    hill_route: true,
  };
}

export function calculateEcoDrivingScore(
  cleanPoints: RoutePoint[] = [],
  stats: TripStats = {},
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const ecoConfig = resolveEcoScoringConfig(thresholds);
  const obdEco = calculateObdEcoSignals(cleanPoints, thresholds);
  if (ecoConfig.invalid) {
    return {
      eco_driving_score: null,
      eco_score_confidence: 'invalid_thresholds',
      speed_stability: null,
      cruise_score: null,
      idle_penalty_points: null,
      ...obdEco,
    };
  }

  const { configured, cruiseScoreMultiplier, idlePenaltyMultiplier, idleMaxPenalty } = ecoConfig;
  const minMovingKmh = Math.max(0, settingNumber(configured.ECO_MIN_MOVING_KMH, DEFAULT_THRESHOLDS.ECO_MIN_MOVING_KMH));
  const movingSpeeds = cleanPoints
    .map((_, index) => reliablePointSpeed(cleanPoints, index, thresholds))
    .filter((speed) => Number.isFinite(speed) && speed >= minMovingKmh);

  if (movingSpeeds.length < 3) {
    return {
      eco_driving_score: null,
      eco_score_confidence: 'insufficient_data',
      speed_stability: null,
      cruise_score: null,
      idle_penalty_points: 0,
      ...obdEco,
    };
  }

  const mean = average(movingSpeeds);
  const variance = average(movingSpeeds.map((speed) => (speed - mean) ** 2));
  const cv = Math.sqrt(variance) / Math.max(1, mean);
  // CV is scale-normalized variability; 0.5 is already highly uneven, so this scores it near 25.
  const speedStability = Math.max(0, 100 - cv * ECO_SPEED_STABILITY_CV_MULTIPLIER);
  const configuredCruiseMin = settingNumber(configured.ECO_CRUISE_MIN_KMH, DEFAULT_THRESHOLDS.ECO_CRUISE_MIN_KMH);
  const configuredCruiseMax = settingNumber(configured.ECO_CRUISE_MAX_KMH, DEFAULT_THRESHOLDS.ECO_CRUISE_MAX_KMH);
  const cruiseMin = Math.min(configuredCruiseMin, configuredCruiseMax);
  const cruiseMax = Math.max(configuredCruiseMin, configuredCruiseMax);
  const cruiseRatio = movingSpeeds.filter((speed) => speed >= cruiseMin && speed <= cruiseMax).length / movingSpeeds.length;
  const cruiseScore = Math.min(100, cruiseRatio * cruiseScoreMultiplier);
  const gpsAvoidableIdleSeconds = stats.sustained_idle_seconds ?? stats.idle_time_seconds ?? 0;
  const avoidableIdleSeconds = Math.max(gpsAvoidableIdleSeconds, obdEco.obd_idle_seconds || 0);
  // FIX: Penalize sustained parked idle instead of unavoidable traffic-stop idle.
  const idleRatio = clamp(avoidableIdleSeconds / Math.max(1, stats.duration_seconds || 0), 0, 1);
  const idlePenalty = Math.min(idleMaxPenalty, idleRatio * idlePenaltyMultiplier);
  // FIX: Use a gentler eco idle curve capped at 25 points for avoidable idling.
  const ecoDrivingScore = Math.round(
    speedStability * 0.40 +
    cruiseScore * 0.35 +
    Math.max(0, 100 - idlePenalty) * 0.25 -
    (obdEco.obd_eco_penalty_points || 0)
  );

  return {
    eco_driving_score: clamp(ecoDrivingScore, 0, 100),
    eco_score_confidence: 'observed',
    speed_stability: Math.round(speedStability),
    cruise_score: Math.round(cruiseScore),
    idle_penalty_points: round1(idlePenalty),
    ...obdEco,
  };
}

export function unavailableSvi(sampleCount: number): ScoreFields {
  return {
    speed_variability_index: null,
    svi_score: null,
    svi_label: 'unknown',
    svi_score_confidence: 'insufficient_data',
    svi_moving_sample_count: sampleCount,
  };
}

export function standardDeviation(samples: number[]): number {
  const mean = average(samples);
  return Math.sqrt(average(samples.map((speed) => (speed - mean) ** 2)));
}

export function calculateObdEcoSignals(
  cleanPoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  let obdPowertrainSampleCount = 0;
  let obdIdleSeconds = 0;
  let obdOverRevCount = 0;
  let obdHighThrottleCount = 0;

  for (let i = 0; i < cleanPoints.length; i++) {
    const point = cleanPoints[i];
    const rpm = Number(point?.obd_rpm);
    const throttle = Number(point?.obd_throttle_pct);
    const hasRpm = Number.isFinite(rpm) && rpm > 0;
    const hasThrottle = Number.isFinite(throttle) && throttle >= 0;
    if (!hasRpm && !hasThrottle) continue;
    obdPowertrainSampleCount++;

    if (hasRpm && rpm >= OBD_OVER_REV_RPM) obdOverRevCount++;

    if (i > 0) {
      const prev = cleanPoints[i - 1];
      const segment = calculateSegmentMetrics(prev, point, thresholds);
      if (segment.dt > 0 && segment.dt <= 120 && !segment.isNoise) {
        const speed = reliablePointSpeed(cleanPoints, i, thresholds) ?? finiteSpeed(point, thresholds);
        const prevSpeed = reliablePointSpeed(cleanPoints, i - 1, thresholds) ?? finiteSpeed(prev, thresholds);
        const accelMs2 = calculateAcceleration(prevSpeed, speed, segment.dt);
        if (hasRpm && speed <= (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH) && rpm >= OBD_IDLE_RPM_MIN) {
          obdIdleSeconds += segment.dt;
        }
        if (hasThrottle && throttle >= OBD_HIGH_THROTTLE_PCT && accelMs2 > 0.8) {
          obdHighThrottleCount++;
        }
      }
    }
  }

  const stressRatio = obdPowertrainSampleCount > 0
    ? (obdOverRevCount + obdHighThrottleCount) / obdPowertrainSampleCount
    : 0;
  return {
    obd_powertrain_sample_count: obdPowertrainSampleCount,
    obd_idle_seconds: Math.round(obdIdleSeconds),
    obd_over_rev_count: obdOverRevCount,
    obd_high_throttle_count: obdHighThrottleCount,
    obd_eco_penalty_points: round1(Math.min(OBD_ECO_PENALTY_MAX, stressRatio * 40)),
  };
}

export function sviDistanceKm(
  samples: SviSample[],
  cleanPoints: RoutePoint[],
  thresholds: DrivingThresholds
): number {
  return samples.reduce((distance, sample) => {
    if (sample.index === 0) return distance;
    const segment = calculateSegmentMetrics(cleanPoints[sample.index - 1], cleanPoints[sample.index], thresholds);
    return segment.dt > 0 && segment.dt <= 120 && !segment.isNoise ? distance + segment.distanceKm : distance;
  }, 0);
}

export function calculateSpeedVariabilityIndex(
  cleanPoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  const samples = cleanPoints
    .map((_, index) => ({ index, speed: reliablePointSpeed(cleanPoints, index, thresholds) }))
    .filter((sample) => Number.isFinite(sample.speed) && sample.speed > SVI_DEFAULTS.MOVING_SPEED_FLOOR_KMH);

  if (samples.length < SVI_DEFAULTS.MIN_MOVING_SAMPLES) return unavailableSvi(samples.length);

  const groupedSamples = [
    {
      multiplier: SVI_DEFAULTS.CITY_MULTIPLIER,
      samples: samples.filter((sample) => sample.speed < SVI_DEFAULTS.HIGHWAY_MIN_KMH),
    },
    {
      multiplier: SVI_DEFAULTS.HIGHWAY_MULTIPLIER,
      samples: samples.filter((sample) => sample.speed >= SVI_DEFAULTS.HIGHWAY_MIN_KMH),
    },
  ];
  const scorableGroups = groupedSamples
    .filter((group) => group.samples.length >= SVI_DEFAULTS.MIN_STRATUM_SAMPLES)
    .map((group) => {
      const deviation = standardDeviation(group.samples.map((sample) => sample.speed));
      return {
        ...group,
        deviation,
        distanceKm: sviDistanceKm(group.samples, cleanPoints, thresholds),
        score: clamp(Math.round(100 - deviation * group.multiplier), 0, 100),
      };
    });

  if (!scorableGroups.length) return unavailableSvi(samples.length);

  const scoredDistanceKm = scorableGroups.reduce((sum, group) => sum + group.distanceKm, 0);
  const scoredSampleCount = scorableGroups.reduce((sum, group) => sum + group.samples.length, 0);
  const weightFor = (group: SviGroup): number => (
    scoredDistanceKm > 0 ? group.distanceKm / scoredDistanceKm : group.samples.length / scoredSampleCount
  );
  const svi = round1(scorableGroups.reduce((sum, group) => sum + group.deviation * weightFor(group), 0));
  const sviScore = Math.round(scorableGroups.reduce((sum, group) => sum + group.score * weightFor(group), 0));
  const sviLabel = sviScore >= 85
    ? 'very smooth'
    : sviScore >= 70
      ? 'smooth'
      : sviScore >= 50
        ? 'variable'
        : sviScore >= 25
          ? 'erratic'
          : 'very erratic';
  const scoredSamples = scorableGroups.reduce((sum, group) => sum + group.samples.length, 0);

  return {
    speed_variability_index: svi,
    svi_score: sviScore,
    svi_label: sviLabel,
    svi_score_confidence: scoredSamples === samples.length ? 'road_type_stratified' : 'partial_road_type_data',
    svi_moving_sample_count: samples.length,
  };
}

export function calculateFuelBandScore(
  cleanPoints: RoutePoint[] = [],
  thresholds: DrivingThresholds = DEFAULT_THRESHOLDS as DrivingThresholds
): ScoreFields {
  let totalMovingSeconds = 0;
  let optimalBandSeconds = 0;
  let highSpeedSeconds = 0;
  let cityCrawlSeconds = 0;

  for (let i = 1; i < cleanPoints.length; i++) {
    const prev = cleanPoints[i - 1];
    const curr = cleanPoints[i];
    const segment = calculateSegmentMetrics(prev, curr, thresholds);
    if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

    const pointSpeed = reliablePointSpeed(cleanPoints, i, thresholds);
    const rawSpeed = pointSpeedKmh(curr, thresholds);
    const speed = pointSpeed ?? (rawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh);
    const previousPointSpeed = reliablePointSpeed(cleanPoints, i - 1, thresholds) ?? finiteSpeed(prev, thresholds);
    const accelMs2 = calculateAcceleration(previousPointSpeed, speed, segment.dt);
    const rpm = Number(curr?.obd_rpm);
    const throttle = Number(curr?.obd_throttle_pct);
    const powertrainEfficient = (!Number.isFinite(rpm) || rpm < OBD_OVER_REV_RPM) &&
      (!Number.isFinite(throttle) || throttle < OBD_HIGH_THROTTLE_PCT);
    if (speed > 5) totalMovingSeconds += segment.dt;
    if (speed >= 60 && speed <= 90 && accelMs2 >= -0.5 && accelMs2 <= 0.5 && powertrainEfficient) {
      optimalBandSeconds += segment.dt;
    }
    if (speed > 100) highSpeedSeconds += segment.dt;
    if (speed > 5 && speed < 30) cityCrawlSeconds += segment.dt;
  }

  const optimalBandRatio = totalMovingSeconds > 0 ? Math.round((optimalBandSeconds / totalMovingSeconds) * 100) : 0;
  // Full credit starts at about 91% optimal-band time.
  const fuelBandScore = Math.min(100, Math.round(optimalBandRatio * FUEL_BAND_FULL_SCORE_MULTIPLIER));
  const bandLabel = fuelBandScore >= 80
    ? 'excellent cruise'
    : fuelBandScore >= 55
      ? 'good cruise'
      : fuelBandScore >= 35
        ? 'mixed'
        : 'stop-and-go';

  return {
    optimal_band_ratio: optimalBandRatio,
    fuel_band_score: fuelBandScore,
    band_label: bandLabel,
    high_speed_ratio: totalMovingSeconds > 0 ? Math.round((highSpeedSeconds / totalMovingSeconds) * 100) : 0,
    city_crawl_ratio: totalMovingSeconds > 0 ? Math.round((cityCrawlSeconds / totalMovingSeconds) * 100) : 0,
  };
}
