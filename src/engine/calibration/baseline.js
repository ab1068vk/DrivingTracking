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

export const stableSettingsFingerprint = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableSettingsFingerprint).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSettingsFingerprint(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/**
 * Provisional multiplier for converting coefficient of variation in moving
 * speeds into the 0-100 eco speed-stability score. A CV of 0.5 maps to 25/100,
 * making very uneven speed control visible without zeroing the component.
 */
export const ECO_SPEED_STABILITY_CV_MULTIPLIER = scoringValue('ECO_SPEED_STABILITY_CV_MULTIPLIER');
// A perfect fuel-band score should require sustained efficient cruising, not a bare majority of samples.
export const FUEL_BAND_FULL_SCORE_MULTIPLIER = scoringValue('FUEL_BAND_FULL_SCORE_MULTIPLIER');
export const STOP_START_MIN_HIGHWAY_DISTANCE_KM = scoringValue('STOP_START_MIN_HIGHWAY_DISTANCE_KM');
export const STOP_START_MIN_URBAN_DISTANCE_KM = scoringValue('STOP_START_MIN_URBAN_DISTANCE_KM');
export const STOP_START_NORMALISATION_WINDOW_KM = scoringValue('STOP_START_NORMALISATION_WINDOW_KM');
export const STOP_START_MAX_CYCLES_PER_5_KM = scoringValue('STOP_START_MAX_CYCLES_PER_WINDOW');
/**
 * Minimum observed stop-start/tailgate cycles before the diagnostic score can
 * influence the defensive-driving blend. Below this, the sample is too sparse.
 */
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT');
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY') ?? STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT;
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN') ?? 1;
export const FATIGUE_SEGMENT_SECONDS = FATIGUE_HEATMAP_SEGMENT_SECONDS;
export const PHONE_USE_SAFETY_WEIGHT = scoringValue('PHONE_USE_SAFETY_WEIGHT');
export const OBD_SPEED_FALLBACK_ACCURACY_M = 15;
export const OBD_SPEED_MAX_SAMPLE_AGE_MS = 2500;
export const OBD_IDLE_RPM_MIN = 500;
export const OBD_OVER_REV_RPM = 3500;
export const OBD_HIGH_THROTTLE_PCT = 75;
export const OBD_ECO_PENALTY_MAX = 15;
/**
 * Provisional brake-turn manoeuvre alert score decay per detected GPS proxy event.
 * Not calibrated to incident, crash, or following-distance outcome data.
 */
export const CLOSE_PROXIMITY_DECAY_BASE = scoringValue('CLOSE_PROXIMITY_DECAY_BASE');
/**
 * Provisional reference speeds used to scale tire-wear units by squared speed.
 * These defaults are diagnostic approximations, not calibrated wear estimates.
 */
export const TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH = scoringValue('TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH');
export const TIRE_WEAR_DEFAULT_SPEED_TURN_KMH = scoringValue('TIRE_WEAR_DEFAULT_SPEED_TURN_KMH');
/** Retired multiplier retained as a neutral compatibility constant. */
export const HEADING_DRIFT_CIRCADIAN_MULTIPLIER = scoringValue('HEADING_DRIFT_CIRCADIAN_MULTIPLIER');
export const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: 'high',
  DEVELOPING: 'developing',
  LOW: 'low',
  UNAVAILABLE: 'unavailable',
});
export { SCORING_VERSION };
/**
 * @typedef {'high'|'developing'|'low'|'unavailable'} EvidenceLevel
 * @typedef {{
 *   value: number|null,
 *   evidence: EvidenceLevel,
 *   dataSource: string[],
 *   sampleCount?: number,
 *   note?: string
 * }} ComponentScore
 */
export const ECO_DEFAULTS = Object.freeze({
  CRUISE_SCORE_MULTIPLIER: scoringValue('ECO_CRUISE_SCORE_MULTIPLIER'),
  IDLE_PENALTY_MULTIPLIER: scoringValue('ECO_IDLE_PENALTY_MULTIPLIER'),
  IDLE_MAX_PENALTY: scoringValue('ECO_IDLE_MAX_PENALTY'),
});
export const SVI_DEFAULTS = Object.freeze({
  MOVING_SPEED_FLOOR_KMH: 5,
  MIN_MOVING_SAMPLES: 10,
  MIN_STRATUM_SAMPLES: 6,
  HIGHWAY_MIN_KMH: 80,
  /**
   * Provisional city/urban SVI calibration: each 1 km/h of within-stratum
   * speed standard deviation deducts 1 point, so 10 km/h maps to 90/100.
   */
  CITY_MULTIPLIER: 1,
  /**
   * Provisional highway SVI calibration: each 1 km/h of within-stratum speed
   * standard deviation deducts 2 points, so 10 km/h maps to 80/100.
   */
  HIGHWAY_MULTIPLIER: 2,
});
export let reportedInvalidEcoThresholds = false;

/**
 * Road Sage Trip Engine
 * Core logic for trip tracking, event detection, and scoring.
 * All thresholds are configurable via the THRESHOLDS object.
 */

// ─── Default Thresholds ────────────────────────────────────────────────────────
export const DEFAULT_THRESHOLDS = {
  // Harsh braking: deceleration > 3.5 m/s2, a common telematics trigger.
  HARSH_BRAKE_MS2: scoringValue('HARSH_BRAKE_MS2'),
  // Rapid acceleration: > 3.0 m/s2, about 10.8 km/h per second gain.
  RAPID_ACCEL_MS2: scoringValue('RAPID_ACCEL_MS2'),
  // Sharp turn: heading change > 45° per GPS sample at > 30 km/h
  SHARP_TURN_G_LOW: scoringValue('SHARP_TURN_G_LOW'),
  SHARP_TURN_G_MEDIUM: scoringValue('SHARP_TURN_G_MEDIUM'),
  SHARP_TURN_G_HIGH: scoringValue('SHARP_TURN_G_HIGH'),
  // Speeding fallback: above 100 km/h when no open-source speed limit data is available.
  SPEEDING_FALLBACK_KMH: scoringValue('SPEEDING_FALLBACK_KMH'),
  SPEED_OVER_KMH: scoringValue('SPEED_OVER_KMH'),
  ECO_CRUISE_MIN_KMH: scoringValue('ECO_CRUISE_MIN_KMH'),
  ECO_CRUISE_MAX_KMH: scoringValue('ECO_CRUISE_MAX_KMH'),
  // Cruise score multiplier: 130 gives full credit when about 77% of moving samples are in the cruise band.
  ECO_CRUISE_SCORE_MULTIPLIER: ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER,
  // Idle penalty curve: each 1% of avoidable parked idle costs 1.5 points before the cap below.
  ECO_IDLE_PENALTY_MULTIPLIER: ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER,
  // Idle penalty cap: avoidable idling can reduce the eco-driving component by at most 25 points.
  ECO_IDLE_MAX_PENALTY: ECO_DEFAULTS.IDLE_MAX_PENALTY,
  // Moving sample floor: ignore GPS crawl/jitter below 15 km/h unless a city profile lowers this threshold.
  ECO_MIN_MOVING_KMH: scoringValue('ECO_MIN_MOVING_KMH'),
  // Idle threshold: speed < 5 km/h
  IDLE_SPEED_KMH: scoringValue('IDLE_SPEED_KMH'),
  // Idle event: idling for > 90 consecutive seconds
  IDLE_EVENT_SECONDS: scoringValue('IDLE_EVENT_SECONDS'),
  // Long drive: > 120 continuous minutes
  LONG_DRIVE_MINUTES: scoringValue('LONG_DRIVE_MINUTES'),
  // Night driving defaults: sunset/sunrise when coordinates exist, otherwise the shared fixed-hour window.
  NIGHT_DETECTION_MODE: 'sunset',
  NIGHT_START_TIME,
  NIGHT_END_TIME,
  NIGHT_START_HOUR,
  NIGHT_END_HOUR,
  NIGHT_SUNSET_OFFSET_MINUTES: 0,
  NIGHT_SUNRISE_OFFSET_MINUTES: 0,
  // Minimum trip distance to save (< 0.1 km = likely noise)
  MIN_TRIP_DISTANCE_KM: scoringValue('MIN_TRIP_DISTANCE_KM'),
  // Minimum trip duration
  MIN_TRIP_DURATION_SECONDS: scoringValue('MIN_TRIP_DURATION_SECONDS'),
  // GPS accuracy filter: ignore points with accuracy > 50m
  MAX_GPS_ACCURACY_M: scoringValue('MAX_GPS_ACCURACY_M'),
  // Ignore small point-to-point hops that are inside normal GPS drift.
  MIN_POINT_DISTANCE_M: scoringValue('MIN_POINT_DISTANCE_M'),
  // Do not trust low-speed GPS speed unless movement also backs it up.
  MIN_TRUSTED_SPEED_KMH: scoringValue('MIN_TRUSTED_SPEED_KMH'),
  // Stationary / crawling speed used to suppress jitter in stats and events.
  STATIONARY_SPEED_KMH: scoringValue('STATIONARY_SPEED_KMH'),
  // Count traffic-control stops from sustained low-speed windows without requiring a full idle event.
  TRAFFIC_STOP_SPEED_KMH: scoringValue('TRAFFIC_STOP_SPEED_KMH'),
  TRAFFIC_STOP_MIN_SECONDS: scoringValue('TRAFFIC_STOP_MIN_SECONDS'),
  TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS: scoringValue('TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS'),
  INTERSECTION_MIN_DISTANCE_KM: scoringValue('INTERSECTION_MIN_DISTANCE_KM'),
  MAX_SPEED_SPIKE_DELTA_KMH: scoringValue('MAX_SPEED_SPIKE_DELTA_KMH'),
  MAX_SPEED_SPIKE_RATIO: scoringValue('MAX_SPEED_SPIKE_RATIO'),
  MAX_ALTITUDE_ACCURACY_M: scoringValue('MAX_ALTITUDE_ACCURACY_M'),
  MIN_HILL_SEGMENT_DISTANCE_M: scoringValue('MIN_HILL_SEGMENT_DISTANCE_M'),
  HILL_GRADE_THRESHOLD_PCT: scoringValue('HILL_GRADE_THRESHOLD_PCT'),
  // GPS/altitude-derived proxy only: this provisional uphill acceleration threshold is not outcome-calibrated.
  HILL_ACCEL_THRESHOLD_MS2: scoringValue('HILL_ACCEL_THRESHOLD_MS2'),
  // Legacy absolute-count hill deduction retained in provenance; current scoring uses the per-km rate below.
  HILL_INFRACTION_PENALTY_POINTS: scoringValue('HILL_INFRACTION_PENALTY_POINTS'),
  // Provisional rate-based deduction per inferred hill infraction per hill-driving km.
  HILL_INFRACTION_PENALTY_POINTS_PER_KM: scoringValue('HILL_INFRACTION_PENALTY_POINTS_PER_KM'),
  MIN_SPEED_RAPID_ACCEL_KMH: scoringValue('MIN_SPEED_RAPID_ACCEL_KMH'),
  MIN_SPEED_HARSH_BRAKE_KMH: scoringValue('MIN_SPEED_HARSH_BRAKE_KMH'),
  STOP_START_DECEL_MS2: scoringValue('STOP_START_DECEL_MS2'),
  STOP_START_MIN_SPEED_KMH: scoringValue('STOP_START_MIN_SPEED_KMH'),
  STOP_START_CRUISE_SECONDS: scoringValue('STOP_START_CRUISE_SECONDS'),
  STOP_START_SPEED_DROP_KMH: scoringValue('STOP_START_SPEED_DROP_KMH'),
  STOP_START_URBAN_DECEL_MS2: scoringValue('STOP_START_URBAN_DECEL_MS2'),
  STOP_START_URBAN_MIN_SPEED_KMH: scoringValue('STOP_START_URBAN_MIN_SPEED_KMH'),
  STOP_START_URBAN_CRUISE_SECONDS: scoringValue('STOP_START_URBAN_CRUISE_SECONDS'),
  STOP_START_URBAN_SPEED_DROP_KMH: scoringValue('STOP_START_URBAN_SPEED_DROP_KMH'),
  HEADING_DEVIATION_MIN_SPEED_KMH: scoringValue('HEADING_DEVIATION_MIN_SPEED_KMH'),
  HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH: scoringValue('HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH'),
  HEADING_DEVIATION_MIN_TURN_RATE_DEG_S: scoringValue('HEADING_DEVIATION_MIN_TURN_RATE_DEG_S'),
  HEADING_DEVIATION_MAX_TURN_RATE_DEG_S: scoringValue('HEADING_DEVIATION_MAX_TURN_RATE_DEG_S'),
  HEADING_DEVIATION_MIN_WINDOW_SECONDS: scoringValue('HEADING_DEVIATION_MIN_WINDOW_SECONDS'),
  HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG: scoringValue('HEADING_DEVIATION_STRAIGHT_STD_MAX_DEG'),
  HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS: scoringValue('HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS'),
  CORNERING_MIN_SPEED_KMH: scoringValue('CORNERING_MIN_SPEED_KMH'),
  MERGE_ENTRY_SPEED_KMH: scoringValue('MERGE_ENTRY_SPEED_KMH'),
  MERGE_EXIT_SPEED_KMH: scoringValue('MERGE_EXIT_SPEED_KMH'),
  PARKING_LOOKBACK_SECONDS: scoringValue('PARKING_LOOKBACK_SECONDS'),
  MAX_TERMINAL_IDLE_SECONDS: scoringValue('MAX_TERMINAL_IDLE_SECONDS'),
  MANOEUVRE_ALERT_BRAKE_MS2: scoringValue('MANOEUVRE_ALERT_BRAKE_MS2'),
  MANOEUVRE_ALERT_TURN_DEG_S: scoringValue('MANOEUVRE_ALERT_TURN_DEG_S'),
  HEADING_DRIFT_STD_DEG: scoringValue('HEADING_DRIFT_STD_DEG'),
  threshold_phone_proxy_oscillations: scoringValue('PHONE_MICRO_STEER_COUNT'),
  PHONE_MICRO_STEER_COUNT: scoringValue('PHONE_MICRO_STEER_COUNT'),
  PHONE_MICRO_STEER_WINDOW_S: scoringValue('PHONE_MICRO_STEER_WINDOW_S'),
  PHONE_PROXY_MAX_ACCURACY_M: scoringValue('PHONE_PROXY_MAX_ACCURACY_M'),
  PHONE_CREEP_RATE_KMH_S: scoringValue('PHONE_CREEP_RATE_KMH_S'),
  PHONE_LANE_DRIFT_DEG: scoringValue('PHONE_LANE_DRIFT_DEG'),
  PHONE_COUPLING_THRESHOLD: scoringValue('PHONE_COUPLING_THRESHOLD'),
  PHONE_CONFIDENCE_THRESHOLD: scoringValue('PHONE_CONFIDENCE_THRESHOLD'),
  PHONE_MIN_WINDOW_S: scoringValue('PHONE_MIN_WINDOW_S'),
  PHONE_USE_DETECTION_ENABLED: true,
  PHONE_USE_AFFECTS_SCORE: true,
  LANE_CHANGE_SCORE_ENABLED: true,
  LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M: scoringValue('LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M'),
  LANE_CHANGE_CURVE_SUPPRESSION_SECONDS: scoringValue('LANE_CHANGE_CURVE_SUPPRESSION_SECONDS'),
  LANE_CHANGE_REGIONAL_YAW_DEG_S: scoringValue('LANE_CHANGE_REGIONAL_YAW_DEG_S'),
  LANE_CHANGE_HIGHWAY_YAW_DEG_S: scoringValue('LANE_CHANGE_HIGHWAY_YAW_DEG_S'),
  LANE_CHANGE_HIGHWAY_SPEED_KMH: scoringValue('LANE_CHANGE_HIGHWAY_SPEED_KMH'),
  threshold_speed_creep_kmh: scoringValue('SPEED_CREEP_THRESHOLD_KMH'),
  threshold_overtake_accel_ms2: scoringValue('OVERTAKE_ACCEL_THRESHOLD_MS2'),
  OVERTAKE_MIN_BASELINE_SPEED_KMH: scoringValue('OVERTAKE_MIN_BASELINE_SPEED_KMH'),
  OVERTAKE_MIN_STRAIGHT_DISTANCE_KM: scoringValue('OVERTAKE_MIN_STRAIGHT_DISTANCE_KM'),
  OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG: scoringValue('OVERTAKE_STRAIGHT_STD_MAX_DEG'),
  ADVANCED_SAFETY_DETECTION_ENABLED: true,
};

export const EVENT_TYPES = {
  HARSH_BRAKE: 'harsh_brake',
  RAPID_ACCELERATION: 'rapid_acceleration',
  SHARP_TURN: 'sharp_turn',
  SPEEDING: 'speeding',
  IDLE: 'idle',
  HEADING_DEVIATION: 'heading_deviation',
  HEADING_DEVIATION_LEGACY: 'heading_deviation_legacy',
  STOP_START_PATTERN: 'stop_start_pattern',
  TAILGATE_CYCLE: 'tailgate_cycle',
  ERRATIC_SPEED: 'erratic_speed',
  NEAR_MISS: 'near_miss',
  CLOSE_PROXIMITY: 'close_proximity',
  AGGRESSIVE_OVERTAKE: 'aggressive_overtake',
  PHONE_USE: 'phone_use',
};

export const isDiagnosticOnlyScoringEvent = (event = {}, { advancedSafetyEnabled = true } = {}) => (
  event?.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE ||
  (!advancedSafetyEnabled && event?.type === EVENT_TYPES.HEADING_DEVIATION) ||
  (event?.type === EVENT_TYPES.PHONE_USE && (event.source === 'gps_proxy' || event.diagnostic_only === true))
);

export const MIN_BRAKE_ONSET_SMOOTHNESS_SEQUENCES = 2;

export const EVENT_PENALTIES = scoringValue('EVENT_PENALTY_POINTS');

export function weightedBlend(components = []) {
  // Null is the only acceptable "not computed" input. Callers must not pass
  // neutral fallback scores such as 50, 75, or 100 to represent missing evidence.
  const valid = components
    .filter(({ score }) => score != null && score !== '')
    .map(({ score, weight }) => ({ score: Number(score), weight: Number(weight) }))
    .filter(({ score, weight }) => Number.isFinite(score) && Number.isFinite(weight) && weight > 0);
  const totalWeight = valid.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return null;
  return Math.round(valid.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight);
}

export function confidenceLevelFromNumeric(value) {
  if (!Number.isFinite(value) || value <= 0) return CONFIDENCE_LEVELS.UNAVAILABLE;
  if (value < 0.5) return CONFIDENCE_LEVELS.LOW;
  if (value < 0.8) return CONFIDENCE_LEVELS.DEVELOPING;
  return CONFIDENCE_LEVELS.HIGH;
}

export function confidenceNumericValue(level) {
  return {
    [CONFIDENCE_LEVELS.HIGH]: 1,
    [CONFIDENCE_LEVELS.DEVELOPING]: 0.65,
    [CONFIDENCE_LEVELS.LOW]: 0.25,
    [CONFIDENCE_LEVELS.UNAVAILABLE]: 0,
  }[level] ?? 0;
}

/**
 * Classify the evidence available for a registered component metric.
 * @param {number} distanceKm
 * @param {number} minDistKm
 * @param {number} sampleCount
 * @param {number} minSamples
 * @returns {EvidenceLevel}
 */
export function componentConfidence(distanceKm, minDistKm, sampleCount, minSamples) {
  const distance = Math.max(0, Number(distanceKm) || 0);
  const minimumDistance = Math.max(0, Number(minDistKm) || 0);
  const samples = Math.max(0, Number(sampleCount) || 0);
  const minimumSamples = Math.max(0, Number(minSamples) || 0);
  if (distance < minimumDistance || samples < minimumSamples) return CONFIDENCE_LEVELS.UNAVAILABLE;
  if (minimumDistance > 0 && distance < minimumDistance * 2) return CONFIDENCE_LEVELS.LOW;
  if (minimumDistance > 0 && distance < minimumDistance * 5) return CONFIDENCE_LEVELS.DEVELOPING;
  return CONFIDENCE_LEVELS.HIGH;
}

export function cappedEvidenceLevel(level, maximumLevel) {
  const rank = {
    [CONFIDENCE_LEVELS.UNAVAILABLE]: 0,
    [CONFIDENCE_LEVELS.LOW]: 1,
    [CONFIDENCE_LEVELS.DEVELOPING]: 2,
    [CONFIDENCE_LEVELS.HIGH]: 3,
  };
  return rank[level] > rank[maximumLevel] ? maximumLevel : level;
}

export function registeredComponentConfidence(componentKey, distanceKm, sampleCount, value) {
  if (value == null) return CONFIDENCE_LEVELS.UNAVAILABLE;
  const metric = METRIC_REGISTRY[COMPONENT_METRIC_KEYS[componentKey]];
  return componentConfidence(
    distanceKm,
    metric?.minDistanceKm ?? 0,
    sampleCount,
    metric?.minSamples ?? 1
  );
}

export function normalizedEvidenceLevel(evidence, value) {
  if (value == null) return CONFIDENCE_LEVELS.UNAVAILABLE;
  if (Object.values(CONFIDENCE_LEVELS).includes(evidence)) return evidence;
  if (['insufficient_data', 'insufficient_highway_distance', 'usage_access_required', 'beta_diagnostic_only'].includes(evidence)) {
    return CONFIDENCE_LEVELS.UNAVAILABLE;
  }
  if (evidence === 'observed_stops' || evidence === 'observed' || evidence === 'road_type_stratified') {
    return CONFIDENCE_LEVELS.HIGH;
  }
  if (evidence === 'partial_road_type_data') return CONFIDENCE_LEVELS.DEVELOPING;
  return confidenceLevelFromNumeric(Number(evidence));
}

/**
 * Build the stable evidence envelope used by score surfaces and exports.
 * @param {number|string|null|undefined} value
 * @param {EvidenceLevel|string|number} evidence
 * @param {string[]} dataSource
 * @param {{sampleCount?:number,note?:string}} options
 * @returns {ComponentScore}
 */
export function createComponentScore(value, evidence, dataSource = [], options = {}) {
  const numericValue = value == null || value === '' ? null : Number(value);
  const normalizedValue = Number.isFinite(numericValue) ? numericValue : null;
  const normalizedEvidence = normalizedEvidenceLevel(evidence, normalizedValue);
  const component = {
    value: normalizedEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : normalizedValue,
    evidence: normalizedEvidence,
    dataSource: [...new Set((Array.isArray(dataSource) ? dataSource : []).filter((source) => typeof source === 'string' && source))],
  };
  if (Number.isFinite(Number(options.sampleCount))) component.sampleCount = Math.max(0, Number(options.sampleCount));
  if (options.note) component.note = options.note;
  return component;
}

export const LEGACY_COMPONENT_FIELDS = Object.freeze({
  overall: { value: 'score_overall', evidence: 'score_confidence_label', fallbackEvidence: 'score_confidence' },
  safety: { value: 'score_safety', evidence: 'score_safety_confidence' },
  smoothness: { value: 'score_smoothness', evidence: 'score_smoothness_confidence' },
  eco: { value: 'score_eco', evidence: 'score_eco_confidence' },
  intersection: { value: 'intersection_score', evidence: 'intersection_score_confidence' },
  distraction: { value: 'distraction_score', evidence: 'distraction_score_confidence' },
  phone_use: { value: 'phone_use_score', evidence: 'phone_use_score_confidence' },
  stop_start_pattern: { value: 'stop_start_pattern_score', evidence: 'stop_start_pattern_score_confidence' },
  close_proximity: { value: 'close_proximity_score', evidence: 'close_proximity_score_confidence' },
  smoothness_index: { value: 'jerk_score', evidence: 'jerk_score_confidence' },
  eco_driving: { value: 'eco_driving_score', evidence: 'eco_driving_score_confidence' },
  speed_variability: { value: 'svi_score', evidence: 'svi_score_confidence' },
  fuel_band: { value: 'fuel_band_score', evidence: 'fuel_band_score_confidence' },
  merge: { value: 'merge_score', evidence: 'merge_score_confidence' },
  smooth_braking: { value: 'smooth_braking_score', evidence: 'smooth_braking_score_confidence' },
  engine_stress: { value: 'engine_stress_score', evidence: 'engine_stress_score_confidence' },
  speed_creep: { value: 'speed_creep_score', evidence: 'speed_creep_score_confidence' },
  heading_drift_beta: { value: 'heading_drift_beta_score', evidence: 'heading_drift_beta_confidence' },
  hill_driving: { value: 'hill_driving_score', evidence: 'hill_driving_score_confidence' },
  parking_approach: { value: 'parking_approach_score', evidence: 'parking_approach_score_confidence' },
  brake_onset_smoothness: { value: 'brake_onset_smoothness_score', evidence: 'brake_onset_smoothness_confidence' },
  cornering_consistency: { value: 'cornering_consistency_score', evidence: 'cornering_consistency_score_confidence' },
  braking_efficiency: { value: 'braking_efficiency_score', evidence: 'braking_efficiency_score_confidence' },
  speed_limit_compliance: { value: 'overall_compliance_score', evidence: 'overall_compliance_score_confidence' },
  overtake_quality: { value: 'overtake_quality_score', evidence: 'overtake_quality_score_confidence' },
  aggressive_driving: { value: 'aggressive_driving_score', evidence: 'aggressive_driving_score_confidence' },
  defensive_driving: { value: 'defensive_driving_score', evidence: 'defensive_driving_score_confidence' },
  fatigue_risk: { value: 'fatigue_risk_score', evidence: 'fatigue_risk_score_confidence' },
});

/**
 * Read the typed component contract, with a legacy flat-trip adapter for saved records.
 * @param {object} trip
 * @param {string} componentKey
 * @returns {ComponentScore}
 */
export function getTripComponentScore(trip = {}, componentKey) {
  const stored = trip?.component_scores?.[componentKey];
  if (stored && typeof stored === 'object') {
    return createComponentScore(stored.value, stored.evidence, stored.dataSource, {
      sampleCount: stored.sampleCount,
      note: stored.note,
    });
  }
  const legacy = LEGACY_COMPONENT_FIELDS[componentKey];
  if (!legacy) return createComponentScore(null, CONFIDENCE_LEVELS.UNAVAILABLE, []);
  const value = trip?.[legacy.value];
  const evidence = trip?.[legacy.evidence] ?? trip?.[legacy.fallbackEvidence] ?? (
    value == null ? CONFIDENCE_LEVELS.UNAVAILABLE : CONFIDENCE_LEVELS.LOW
  );
  return createComponentScore(value, evidence, [], {
    note: 'Legacy score record; rescore this trip to expose evidence sources.',
  });
}

export function settingNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ecoSettingNumber(value, fallback) {
  return value == null || value === '' ? fallback : settingNumber(value, fallback);
}

export function resolveEcoScoringConfig(thresholds) {
  const configured = thresholds && typeof thresholds === 'object' ? thresholds : {};
  const cruiseScoreMultiplier = Math.max(
    0,
    ecoSettingNumber(configured.ECO_CRUISE_SCORE_MULTIPLIER, ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER)
  );
  const idlePenaltyMultiplier = Math.max(
    0,
    ecoSettingNumber(configured.ECO_IDLE_PENALTY_MULTIPLIER, ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER)
  );
  const idleMaxPenalty = Math.max(
    0,
    ecoSettingNumber(configured.ECO_IDLE_MAX_PENALTY, ECO_DEFAULTS.IDLE_MAX_PENALTY)
  );
  const invalid = cruiseScoreMultiplier === 0 && idlePenaltyMultiplier === 0;

  if (invalid && !reportedInvalidEcoThresholds) {
    reportedInvalidEcoThresholds = true;
    console.error('Eco driving score unavailable: cruise and idle multipliers cannot both be zero.');
  }

  return { configured, cruiseScoreMultiplier, idlePenaltyMultiplier, idleMaxPenalty, invalid };
}

export function buildDrivingThresholds(settings = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    HARSH_BRAKE_MS2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    RAPID_ACCEL_MS2: settingNumber(settings.threshold_rapid_accel_ms2, DEFAULT_THRESHOLDS.RAPID_ACCEL_MS2),
    STOP_START_DECEL_MS2: settingNumber(settings.threshold_stop_start_decel_ms2 ?? settings.threshold_tailgate_decel_ms2, DEFAULT_THRESHOLDS.STOP_START_DECEL_MS2),
    SHARP_TURN_G_LOW: settingNumber(settings.threshold_sharp_turn_g_low, DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW),
    SHARP_TURN_G_MEDIUM: settingNumber(settings.threshold_sharp_turn_g_medium, DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM),
    SHARP_TURN_G_HIGH: settingNumber(settings.threshold_sharp_turn_g_high, DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH),
    SPEEDING_FALLBACK_KMH: settingNumber(settings.threshold_speeding_kmh, DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH),
    SPEED_OVER_KMH: settingNumber(settings.threshold_speed_over_kmh, DEFAULT_THRESHOLDS.SPEED_OVER_KMH),
    ECO_CRUISE_MIN_KMH: settingNumber(settings.threshold_eco_cruise_min_kmh, DEFAULT_THRESHOLDS.ECO_CRUISE_MIN_KMH),
    ECO_CRUISE_MAX_KMH: settingNumber(settings.threshold_eco_cruise_max_kmh, DEFAULT_THRESHOLDS.ECO_CRUISE_MAX_KMH),
    ECO_CRUISE_SCORE_MULTIPLIER: settingNumber(settings.eco_cruise_score_multiplier, DEFAULT_THRESHOLDS.ECO_CRUISE_SCORE_MULTIPLIER),
    ECO_IDLE_PENALTY_MULTIPLIER: settingNumber(settings.eco_idle_penalty_multiplier, DEFAULT_THRESHOLDS.ECO_IDLE_PENALTY_MULTIPLIER),
    ECO_IDLE_MAX_PENALTY: settingNumber(settings.eco_idle_max_penalty, DEFAULT_THRESHOLDS.ECO_IDLE_MAX_PENALTY),
    ECO_MIN_MOVING_KMH: settingNumber(settings.eco_min_moving_kmh, DEFAULT_THRESHOLDS.ECO_MIN_MOVING_KMH),
    IDLE_EVENT_SECONDS: settingNumber(settings.threshold_idle_seconds, DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS),
    LONG_DRIVE_MINUTES: settingNumber(settings.threshold_long_drive_minutes, DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES),
    MIN_SPEED_RAPID_ACCEL_KMH: settingNumber(settings.min_speed_rapid_accel_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_RAPID_ACCEL_KMH),
    MIN_SPEED_HARSH_BRAKE_KMH: settingNumber(settings.min_speed_harsh_brake_kmh, DEFAULT_THRESHOLDS.MIN_SPEED_HARSH_BRAKE_KMH),
    threshold_harsh_brake_ms2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    MANOEUVRE_ALERT_BRAKE_MS2: settingNumber(settings.threshold_manoeuvre_alert_brake_ms2 ?? settings.threshold_near_miss_brake_ms2, DEFAULT_THRESHOLDS.MANOEUVRE_ALERT_BRAKE_MS2),
    MANOEUVRE_ALERT_TURN_DEG_S: settingNumber(settings.threshold_manoeuvre_alert_turn_degs ?? settings.threshold_near_miss_turn_degs, DEFAULT_THRESHOLDS.MANOEUVRE_ALERT_TURN_DEG_S),
    HEADING_DRIFT_STD_DEG: settingNumber(settings.threshold_heading_drift_std_degs ?? settings.threshold_drowsy_heading_std, DEFAULT_THRESHOLDS.HEADING_DRIFT_STD_DEG),
    threshold_phone_proxy_oscillations: settingNumber(settings.threshold_phone_proxy_oscillations, DEFAULT_THRESHOLDS.threshold_phone_proxy_oscillations),
    PHONE_MICRO_STEER_COUNT: settingNumber(settings.phone_micro_steer_count ?? settings.threshold_phone_proxy_oscillations, DEFAULT_THRESHOLDS.PHONE_MICRO_STEER_COUNT),
    PHONE_MICRO_STEER_WINDOW_S: settingNumber(settings.phone_micro_steer_window_s, DEFAULT_THRESHOLDS.PHONE_MICRO_STEER_WINDOW_S),
    PHONE_PROXY_MAX_ACCURACY_M: settingNumber(settings.phone_proxy_max_accuracy_m, DEFAULT_THRESHOLDS.PHONE_PROXY_MAX_ACCURACY_M),
    PHONE_CREEP_RATE_KMH_S: settingNumber(settings.phone_creep_rate_kmh_s, DEFAULT_THRESHOLDS.PHONE_CREEP_RATE_KMH_S),
    PHONE_LANE_DRIFT_DEG: settingNumber(settings.phone_lane_drift_deg, DEFAULT_THRESHOLDS.PHONE_LANE_DRIFT_DEG),
    PHONE_COUPLING_THRESHOLD: settingNumber(settings.phone_coupling_threshold, DEFAULT_THRESHOLDS.PHONE_COUPLING_THRESHOLD),
    PHONE_CONFIDENCE_THRESHOLD: settings.phone_use_sensitivity === 'low'
      ? scoringValue('PHONE_LOW_SENSITIVITY_CONFIDENCE_THRESHOLD')
      : settings.phone_use_sensitivity === 'high'
        ? scoringValue('PHONE_HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD')
        : settingNumber(settings.phone_confidence_threshold, DEFAULT_THRESHOLDS.PHONE_CONFIDENCE_THRESHOLD),
    PHONE_MIN_WINDOW_S: settingNumber(settings.phone_min_window_s, DEFAULT_THRESHOLDS.PHONE_MIN_WINDOW_S),
    PHONE_USE_DETECTION_ENABLED: settings.phone_use_detection_enabled !== false,
    PHONE_USE_AFFECTS_SCORE: settings.phone_use_affects_score !== false,
    LANE_CHANGE_SCORE_ENABLED: settings.lane_change_score_enabled !== false,
    LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M: settingNumber(settings.lane_change_curve_suppression_deg_per_100m, DEFAULT_THRESHOLDS.LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M),
    LANE_CHANGE_CURVE_SUPPRESSION_SECONDS: settingNumber(settings.lane_change_curve_suppression_seconds, DEFAULT_THRESHOLDS.LANE_CHANGE_CURVE_SUPPRESSION_SECONDS),
    LANE_CHANGE_REGIONAL_YAW_DEG_S: settingNumber(settings.lane_change_regional_yaw_deg_s, DEFAULT_THRESHOLDS.LANE_CHANGE_REGIONAL_YAW_DEG_S),
    LANE_CHANGE_HIGHWAY_YAW_DEG_S: settingNumber(settings.lane_change_highway_yaw_deg_s, DEFAULT_THRESHOLDS.LANE_CHANGE_HIGHWAY_YAW_DEG_S),
    LANE_CHANGE_HIGHWAY_SPEED_KMH: settingNumber(settings.lane_change_highway_speed_kmh, DEFAULT_THRESHOLDS.LANE_CHANGE_HIGHWAY_SPEED_KMH),
    threshold_speed_creep_kmh: settingNumber(settings.threshold_speed_creep_kmh, DEFAULT_THRESHOLDS.threshold_speed_creep_kmh),
    threshold_overtake_accel_ms2: Math.max(3, settingNumber(settings.threshold_overtake_accel_ms2, DEFAULT_THRESHOLDS.threshold_overtake_accel_ms2)),
    OVERTAKE_MIN_BASELINE_SPEED_KMH: settingNumber(settings.overtake_min_baseline_speed_kmh, DEFAULT_THRESHOLDS.OVERTAKE_MIN_BASELINE_SPEED_KMH),
    OVERTAKE_MIN_STRAIGHT_DISTANCE_KM: settingNumber(settings.overtake_min_straight_distance_km, DEFAULT_THRESHOLDS.OVERTAKE_MIN_STRAIGHT_DISTANCE_KM),
    OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG: settingNumber(settings.overtake_straight_heading_std_max_deg, DEFAULT_THRESHOLDS.OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG),
    NIGHT_DETECTION_MODE: settings.night_detection_mode || DEFAULT_THRESHOLDS.NIGHT_DETECTION_MODE,
    NIGHT_START_TIME: settings.night_start_time || DEFAULT_THRESHOLDS.NIGHT_START_TIME,
    NIGHT_END_TIME: settings.night_end_time || DEFAULT_THRESHOLDS.NIGHT_END_TIME,
    NIGHT_SUNSET_OFFSET_MINUTES: settingNumber(settings.night_sunset_offset_minutes, DEFAULT_THRESHOLDS.NIGHT_SUNSET_OFFSET_MINUTES),
    NIGHT_SUNRISE_OFFSET_MINUTES: settingNumber(settings.night_sunrise_offset_minutes, DEFAULT_THRESHOLDS.NIGHT_SUNRISE_OFFSET_MINUTES),
    ADVANCED_SAFETY_DETECTION_ENABLED: settings.advanced_safety_detection_enabled !== false,
  };
}

// ─── Haversine Distance ────────────────────────────────────────────────────────
/** Dynamic scoring thresholds retained in stored provenance snapshots. */
export const PROVENANCE_THRESHOLD_KEYS = Object.freeze([
  'HARSH_BRAKE_MS2',
  'RAPID_ACCEL_MS2',
  'SHARP_TURN_G_LOW',
  'SHARP_TURN_G_MEDIUM',
  'SHARP_TURN_G_HIGH',
  'SPEEDING_FALLBACK_KMH',
  'SPEED_OVER_KMH',
  'ECO_CRUISE_MIN_KMH',
  'ECO_CRUISE_MAX_KMH',
  'ECO_CRUISE_SCORE_MULTIPLIER',
  'ECO_IDLE_PENALTY_MULTIPLIER',
  'ECO_IDLE_MAX_PENALTY',
  'ECO_MIN_MOVING_KMH',
  'IDLE_EVENT_SECONDS',
  'LONG_DRIVE_MINUTES',
  'TRAFFIC_STOP_SPEED_KMH',
  'TRAFFIC_STOP_MIN_SECONDS',
  'TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS',
  'INTERSECTION_MIN_DISTANCE_KM',
  'HILL_GRADE_THRESHOLD_PCT',
  'HILL_ACCEL_THRESHOLD_MS2',
  'HILL_INFRACTION_PENALTY_POINTS',
  'HILL_INFRACTION_PENALTY_POINTS_PER_KM',
  'MIN_SPEED_RAPID_ACCEL_KMH',
  'MIN_SPEED_HARSH_BRAKE_KMH',
  'STOP_START_DECEL_MS2',
  'STOP_START_MIN_SPEED_KMH',
  'STOP_START_CRUISE_SECONDS',
  'STOP_START_SPEED_DROP_KMH',
  'STOP_START_URBAN_DECEL_MS2',
  'STOP_START_URBAN_MIN_SPEED_KMH',
  'STOP_START_URBAN_CRUISE_SECONDS',
  'STOP_START_URBAN_SPEED_DROP_KMH',
  'MANOEUVRE_ALERT_BRAKE_MS2',
  'MANOEUVRE_ALERT_TURN_DEG_S',
  'HEADING_DRIFT_STD_DEG',
  'threshold_phone_proxy_oscillations',
  'PHONE_MICRO_STEER_COUNT',
  'PHONE_MICRO_STEER_WINDOW_S',
  'PHONE_PROXY_MAX_ACCURACY_M',
  'PHONE_CREEP_RATE_KMH_S',
  'PHONE_LANE_DRIFT_DEG',
  'PHONE_COUPLING_THRESHOLD',
  'PHONE_CONFIDENCE_THRESHOLD',
  'PHONE_MIN_WINDOW_S',
  'PHONE_USE_DETECTION_ENABLED',
  'PHONE_USE_AFFECTS_SCORE',
  'LANE_CHANGE_SCORE_ENABLED',
  'LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M',
  'LANE_CHANGE_CURVE_SUPPRESSION_SECONDS',
  'LANE_CHANGE_REGIONAL_YAW_DEG_S',
  'LANE_CHANGE_HIGHWAY_YAW_DEG_S',
  'LANE_CHANGE_HIGHWAY_SPEED_KMH',
  'LANE_CHANGING_SAFETY_WEIGHT',
  'threshold_speed_creep_kmh',
  'threshold_overtake_accel_ms2',
  'OVERTAKE_MIN_BASELINE_SPEED_KMH',
  'OVERTAKE_MIN_STRAIGHT_DISTANCE_KM',
  'OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG',
  'NIGHT_DETECTION_MODE',
  'NIGHT_START_TIME',
  'NIGHT_END_TIME',
  'NIGHT_SUNSET_OFFSET_MINUTES',
  'NIGHT_SUNRISE_OFFSET_MINUTES',
  'ADVANCED_SAFETY_DETECTION_ENABLED',
]);

/**
 * Capture score-affecting calibration inputs alongside persisted scores.
 * Formula changes remain governed by SCORING_VERSION.
 */
export function buildScoreConstantsSnapshot(thresholds = DEFAULT_THRESHOLDS) {
  const configured = thresholds && typeof thresholds === 'object' ? thresholds : DEFAULT_THRESHOLDS;
  const snapshot = Object.fromEntries(
    Object.entries(SCORING_CONSTANTS)
      .filter(([, entry]) => entry.affected_metrics.includes('score_overall'))
      .map(([key, entry]) => [key, entry.value])
  );
  PROVENANCE_THRESHOLD_KEYS.forEach((key) => {
    snapshot[key] = configured[key] ?? DEFAULT_THRESHOLDS[key];
  });
  return snapshot;
}

export function buildScoreProvenance(componentScores = {}, thresholds = DEFAULT_THRESHOLDS, computedAt = new Date().toISOString()) {
  const provisionalConstants = getProvisionalScoringConstants()
    .filter((entry) => entry.affected_metrics.includes('score_overall'))
    .map((entry) => entry.key);
  const constantsSnapshot = buildScoreConstantsSnapshot(thresholds);
  return {
    computed_at: computedAt,
    scoring_version: SCORING_VERSION,
    settings_version: stableSettingsFingerprint(constantsSnapshot),
    calibration_status: calibrationStatusForMetrics(['score_overall']),
    provisional_constants: provisionalConstants,
    components: Object.fromEntries(
      Object.entries(componentScores).map(([key, component]) => [
        key,
        component?.evidence ?? CONFIDENCE_LEVELS.UNAVAILABLE,
      ])
    ),
    constants_snapshot: constantsSnapshot,
  };
}

/**
 * Determine whether persisted scores were generated with the current inputs.
 */
export function getScoreProvenanceStatus(trip = {}, thresholds = DEFAULT_THRESHOLDS) {
  const provenance = trip?.score_provenance;
  if (!provenance || typeof provenance !== 'object') {
    return {
      status: 'missing',
      needsRescore: true,
      changedConstants: [],
      reason: 'No scoring provenance is stored for this trip.',
    };
  }
  if (provenance.calibration_status === 'unknown_legacy_unrescored') {
    return {
      status: 'unknown_legacy_unrescored',
      needsRescore: true,
      changedConstants: [],
      reason: `Legacy score has not been re-scored for version ${SCORING_VERSION}.`,
    };
  }
  const storedScoringVersion = trip.score_version || provenance.version || provenance.scoring_version || null;
  if (storedScoringVersion !== SCORING_VERSION) {
    return {
      status: 'outdated',
      needsRescore: true,
      changedConstants: [],
      reason: `Scored with version ${storedScoringVersion || 'unknown'}; current version is ${SCORING_VERSION}.`,
    };
  }
  const currentSnapshot = buildScoreConstantsSnapshot(thresholds);
  const storedSnapshot = provenance.constants_snapshot || {};
  const changedConstants = Object.keys(currentSnapshot).filter((key) => (
    JSON.stringify(storedSnapshot[key]) !== JSON.stringify(currentSnapshot[key])
  ));
  if (changedConstants.length) {
    return {
      status: 'outdated',
      needsRescore: true,
      changedConstants,
      reason: 'One or more scoring calibration inputs changed.',
    };
  }
  return {
    status: 'current',
    needsRescore: false,
    changedConstants: [],
    reason: null,
  };
}
