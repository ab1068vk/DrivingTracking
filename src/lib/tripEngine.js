import { saveExportToDownloads } from './nativeDownloads';
import { logSystemFailure, recordSystemEvent } from './systemLog';
import { clamp, pearsonCorrelation } from './mathUtils';
import { detectTripStops, estimateTripEconomics, FATIGUE_HEATMAP_SEGMENT_SECONDS } from './tripInsights';
import { createPrivacyExportSalt, isPointInPrivacyZone, maskEventCoordinatesForPrivacy, maskTripForPrivacyExport } from './privacyZones';
import { applyDifferentialPrivacyToAggregates } from './differentialPrivacy';
import {
  COMPONENT_METRIC_KEYS,
  CSV_METRIC_COLUMNS,
  METRIC_REGISTRY,
  formatMetricMetadata,
} from './metricRegistry';
import {
  NIGHT_END_HOUR,
  NIGHT_END_TIME,
  NIGHT_START_HOUR,
  NIGHT_START_TIME,
  FATIGUE_SAFETY_PENALTY_SCALE,
  FATIGUE_SAFETY_MAX_PENALTY,
  PENALTY_SCALE_FACTOR,
} from './appConstants';
import {
  SCORING_VERSION,
  SCORING_CONSTANTS,
  calibrationStatusForMetrics,
  getProvisionalScoringConstants,
  scoringValue,
} from './scoringConstants';
import { ECO_DEFAULTS } from './ecoDefaults';
import { formatEstimatedScore, isEstimatedScoreMetric } from './scoreDisplay';
import {
  alertMarginForConfidence,
  confidenceToPenaltyWeight,
  confidenceForSource,
  getRegionDefaultEstimate,
  roadContextFromGpsBehaviour,
  roadContextFromOsmType,
  canonicalSpeedTier,
  tierForSource,
} from './speedLimitSource';
import { geohashEncode, timeToBucket } from './localSpeedKnowledge';

// CHANGES (session):
// - Modified resolveEffectiveSpeedLimitForIndex to include tier, confidence, limitKmh, alertMarginKmh, and shouldAlert.
// - Added regional default estimate lookup and localKnowledge option to resolveEffectiveSpeedLimitForIndex.
// - Added prefetchLocalKnowledge and tier-provenance trip speed summary helpers.
// - Added 30-second overlapping segment P85 inference and GPS road-class derivation.
// - Added per-point confidence-weighted speed-limit scoring totals.
// - Renamed canonical regional default tier to REGION_DEFAULT.
// - Split user speed corrections into posted-sign confirmations and user-entered estimates.

/**
 * Provisional multiplier for converting coefficient of variation in moving
 * speeds into the 0-100 eco speed-stability score. A CV of 0.5 maps to 25/100,
 * making very uneven speed control visible without zeroing the component.
 */
export const ECO_SPEED_STABILITY_CV_MULTIPLIER = scoringValue('ECO_SPEED_STABILITY_CV_MULTIPLIER');
// A perfect fuel-band score should require sustained efficient cruising, not a bare majority of samples.
export const FUEL_BAND_FULL_SCORE_MULTIPLIER = scoringValue('FUEL_BAND_FULL_SCORE_MULTIPLIER');
const STOP_START_MIN_HIGHWAY_DISTANCE_KM = scoringValue('STOP_START_MIN_HIGHWAY_DISTANCE_KM');
const STOP_START_MIN_URBAN_DISTANCE_KM = scoringValue('STOP_START_MIN_URBAN_DISTANCE_KM');
export const STOP_START_NORMALISATION_WINDOW_KM = scoringValue('STOP_START_NORMALISATION_WINDOW_KM');
const STOP_START_MAX_CYCLES_PER_5_KM = scoringValue('STOP_START_MAX_CYCLES_PER_WINDOW');
/**
 * Minimum observed stop-start/tailgate cycles before the diagnostic score can
 * influence the defensive-driving blend. Below this, the sample is too sparse.
 */
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT');
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY') ?? STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT;
export const STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN = scoringValue('STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN') ?? 1;
export const FATIGUE_SEGMENT_SECONDS = FATIGUE_HEATMAP_SEGMENT_SECONDS;
export const PHONE_USE_SAFETY_WEIGHT = scoringValue('PHONE_USE_SAFETY_WEIGHT');
const OBD_SPEED_FALLBACK_ACCURACY_M = 15;
const OBD_SPEED_MAX_SAMPLE_AGE_MS = 2500;
const OBD_IDLE_RPM_MIN = 500;
const OBD_OVER_REV_RPM = 3500;
const OBD_HIGH_THROTTLE_PCT = 75;
const OBD_ECO_PENALTY_MAX = 15;
const MAX_REASONABLE_GPS_SPEED_KMH = 220;
const MAX_REASONABLE_OBD_SPEED_KMH = 260;
const ROUTE_GAP_SECONDS = 120;
const MIN_MANUAL_SAVE_SECONDS = 30;
const MANUAL_SPARSE_GPS_MIN_SECONDS = 30;
const MANUAL_SPARSE_GPS_MIN_SPEED_KMH = 10;
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
/**
 * Provisional circadian weighting for Heading Drift Beta windows starting
 * between 02:00 and 05:00 local time. NHTSA notes drowsy-driving crashes most
 * often occur from midnight to 06:00 during circadian dips and lists crossing
 * roadway lines as a drowsiness warning sign, but this 2.5x factor is not
 * calibrated to lane-keeping or crash outcome data.
 * @see https://www.nhtsa.gov/risky-driving/drowsy-driving
 */
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
export { ECO_DEFAULTS };
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
let reportedInvalidEcoThresholds = false;

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

const isDiagnosticOnlyScoringEvent = (event = {}, { advancedSafetyEnabled = true } = {}) => (
  event?.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE ||
  (!advancedSafetyEnabled && event?.type === EVENT_TYPES.HEADING_DEVIATION) ||
  (event?.type === EVENT_TYPES.PHONE_USE && (event.source === 'gps_proxy' || event.diagnostic_only === true))
);

const MIN_BRAKE_ONSET_SMOOTHNESS_SEQUENCES = 2;

export const EVENT_PENALTIES = scoringValue('EVENT_PENALTY_POINTS');
export const tierProvenance = Object.freeze({
  POSTED: 'posted_speed_limit',
  MAP_ESTIMATED: 'osm_highway_default',
  LEARNED_LOCAL: 'learned_local_limit',
  REGION_DEFAULT: 'regional_default_estimate',
  GPS_INFERRED: 'gps_inferred_limit',
  UNKNOWN: 'no_limit_data',
});

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

function confidenceLevelFromNumeric(value) {
  if (!Number.isFinite(value) || value <= 0) return CONFIDENCE_LEVELS.UNAVAILABLE;
  if (value < 0.5) return CONFIDENCE_LEVELS.LOW;
  if (value < 0.8) return CONFIDENCE_LEVELS.DEVELOPING;
  return CONFIDENCE_LEVELS.HIGH;
}

function confidenceNumericValue(level) {
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

function cappedEvidenceLevel(level, maximumLevel) {
  const rank = {
    [CONFIDENCE_LEVELS.UNAVAILABLE]: 0,
    [CONFIDENCE_LEVELS.LOW]: 1,
    [CONFIDENCE_LEVELS.DEVELOPING]: 2,
    [CONFIDENCE_LEVELS.HIGH]: 3,
  };
  return rank[level] > rank[maximumLevel] ? maximumLevel : level;
}

function registeredComponentConfidence(componentKey, distanceKm, sampleCount, value) {
  if (value == null) return CONFIDENCE_LEVELS.UNAVAILABLE;
  const metric = METRIC_REGISTRY[COMPONENT_METRIC_KEYS[componentKey]];
  return componentConfidence(
    distanceKm,
    metric?.minDistanceKm ?? 0,
    sampleCount,
    metric?.minSamples ?? 1
  );
}

function normalizedEvidenceLevel(evidence, value) {
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

const LEGACY_COMPONENT_FIELDS = Object.freeze({
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

function settingNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ecoSettingNumber(value, fallback) {
  return value == null || value === '' ? fallback : settingNumber(value, fallback);
}

function resolveEcoScoringConfig(thresholds) {
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
const PROVENANCE_THRESHOLD_KEYS = Object.freeze([
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
  return {
    computed_at: computedAt,
    scoring_version: SCORING_VERSION,
    calibration_status: calibrationStatusForMetrics(['score_overall']),
    provisional_constants: provisionalConstants,
    components: Object.fromEntries(
      Object.entries(componentScores).map(([key, component]) => [
        key,
        component?.evidence ?? CONFIDENCE_LEVELS.UNAVAILABLE,
      ])
    ),
    constants_snapshot: buildScoreConstantsSnapshot(thresholds),
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

/**
 * Calculate great-circle distance between two GPS points using Haversine formula.
 * @returns {number} Distance in kilometers
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const startLat = finiteCoordinate(lat1);
  const startLng = finiteCoordinate(lng1);
  const endLat = finiteCoordinate(lat2);
  const endLng = finiteCoordinate(lng2);
  if (startLat == null || startLng == null || endLat == null || endLng == null) return 0;

  const R = 6371; // Earth radius in km
  const dLat = toRad(endLat - startLat);
  const dLng = toRad(endLng - startLng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(startLat)) * Math.cos(toRad(endLat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  return haversineDistance(lat1, lng1, lat2, lng2) * 1000;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function finiteCoordinate(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasValidCoordinates(point) {
  return finiteCoordinate(point?.lat) != null && finiteCoordinate(point?.lng) != null;
}

function hasUsableManualTripCoordinates(point, thresholds = DEFAULT_THRESHOLDS) {
  const accuracy = point?.accuracy == null ? null : Number(point.accuracy);
  const maxAccuracyM = thresholds.MAX_GPS_ACCURACY_M ?? DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M;
  return hasValidCoordinates(point) &&
    (accuracy == null || !Number.isFinite(accuracy) || accuracy <= maxAccuracyM);
}

// ─── Heading Calculation ───────────────────────────────────────────────────────
/**
 * Calculate bearing (heading) between two GPS points.
 * @returns {number} Bearing in degrees (0-360)
 */
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const startLat = finiteCoordinate(lat1);
  const startLng = finiteCoordinate(lng1);
  const endLat = finiteCoordinate(lat2);
  const endLng = finiteCoordinate(lng2);
  if (startLat == null || startLng == null || endLat == null || endLng == null) return 0;

  const dLng = toRad(endLng - startLng);
  const rlat1 = toRad(startLat);
  const rlat2 = toRad(endLat);
  const y = Math.sin(dLng) * Math.cos(rlat2);
  const x = Math.cos(rlat1) * Math.sin(rlat2) - Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Get the smallest angular difference between two headings.
 * @returns {number} Angle in degrees (0-180)
 */
export function headingDiff(h1, h2) {
  let diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function headingStdDev(headings) {
  if (!headings || headings.length < 2) return 0;
  const valid = headings.filter(h => h != null && Number.isFinite(h));
  if (valid.length < 2) return 0;
  const sinMean = valid.reduce((s, h) => s + Math.sin(h * Math.PI / 180), 0) / valid.length;
  const cosMean = valid.reduce((s, h) => s + Math.cos(h * Math.PI / 180), 0) / valid.length;
  const R = Math.sqrt(sinMean * sinMean + cosMean * cosMean);
  const stdRad = R < 1 ? Math.sqrt(-2 * Math.log(Math.max(R, 1e-9))) : 0;
  return stdRad * 180 / Math.PI;
}

export function speedStdDev(speeds) {
  if (!speeds || speeds.length < 2) return 0;
  const valid = speeds.filter(s => Number.isFinite(s));
  if (valid.length < 2) return 0;
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
  return Math.sqrt(variance);
}

// ─── Speed Calculation ─────────────────────────────────────────────────────────
/**
 * Calculate speed between two GPS points.
 * @param {number} distKm - Distance in km
 * @param {number} durationSeconds - Time elapsed in seconds
 * @returns {number} Speed in km/h
 */
export function calculateSpeedKmh(distKm, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  return (distKm / durationSeconds) * 3600;
}

// ─── Acceleration Detection ────────────────────────────────────────────────────
/**
 * Calculate acceleration/deceleration from two speed readings.
 * Formula: a = (v2 - v1) / t
 * @param {number} speed1Kmh - Initial speed in km/h
 * @param {number} speed2Kmh - Final speed in km/h
 * @param {number} durationSeconds - Time elapsed in seconds
 * @returns {number} Acceleration in m/s² (negative = braking)
 */
export function calculateAcceleration(speed1Kmh, speed2Kmh, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  const v1 = speed1Kmh / 3.6; // convert to m/s
  const v2 = speed2Kmh / 3.6;
  return (v2 - v1) / durationSeconds;
}

function timestampMs(point) {
  const value = point?.timestamp ?? point?.time;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : Date.now();
}

function parseTimestampMs(value) {
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function accuracyMeters(point) {
  return Number.isFinite(point?.accuracy) ? Math.max(0, point.accuracy) : 0;
}

function movementNoiseFloorMeters(point, previousPoint, thresholds = DEFAULT_THRESHOLDS) {
  const bestAccuracy = Math.max(accuracyMeters(point), accuracyMeters(previousPoint));
  return Math.max(
    thresholds.MIN_POINT_DISTANCE_M ?? 8,
    Math.min(25, bestAccuracy * 0.6)
  );
}

export function calculateSegmentMetrics(previousPoint, point, thresholds = DEFAULT_THRESHOLDS) {
  if (!previousPoint || !point) {
    return {
      dt: 0,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: false,
    };
  }

  const dt = (timestampMs(point) - timestampMs(previousPoint)) / 1000;
  if (dt <= 0) {
    return {
      dt,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: true,
    };
  }

  if (!hasValidCoordinates(previousPoint) || !hasValidCoordinates(point)) {
    return {
      dt,
      distanceKm: 0,
      distanceM: 0,
      impliedSpeedKmh: 0,
      reportedSpeedKmh: pointSpeedKmh(point, thresholds),
      reliableSpeedKmh: 0,
      isNoise: true,
    };
  }

  const distanceKm = haversineDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
  const distanceM = distanceKm * 1000;
  const impliedSpeedKmh = calculateSpeedKmh(distanceKm, dt);
  const reportedSpeedKmh = pointSpeedKmh(point, thresholds);
  const noiseFloorM = movementNoiseFloorMeters(point, previousPoint, thresholds);
  const stationarySpeed = thresholds.STATIONARY_SPEED_KMH ?? 5;
  const trustedSpeed = thresholds.MIN_TRUSTED_SPEED_KMH ?? 18;

  const tinyMovement = distanceM < noiseFloorM;
  const displacementSaysStill = impliedSpeedKmh < stationarySpeed && distanceM < noiseFloorM * 1.5;
  const reportedDisagreesWithDisplacement = reportedSpeedKmh != null &&
    reportedSpeedKmh < trustedSpeed &&
    displacementSaysStill;
  const isNoise = tinyMovement || reportedDisagreesWithDisplacement;

  let reliableSpeedKmh = impliedSpeedKmh;
  if (!isNoise && reportedSpeedKmh != null) {
    const reportedCloseToImplied = Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= 12;
    const reportedTooLowForMovement = reportedSpeedKmh < trustedSpeed &&
      impliedSpeedKmh >= trustedSpeed &&
      !reportedCloseToImplied;
    const reportedStationaryWhileMoving = reportedSpeedKmh < stationarySpeed &&
      impliedSpeedKmh >= trustedSpeed;
    reliableSpeedKmh = reportedTooLowForMovement || reportedStationaryWhileMoving
      ? impliedSpeedKmh
      : reportedSpeedKmh;
  }

  return {
    dt,
    distanceKm,
    distanceM,
    impliedSpeedKmh,
    reportedSpeedKmh,
    reliableSpeedKmh: isNoise ? 0 : Math.max(0, reliableSpeedKmh),
    isNoise,
  };
}

export function computeSmoothedAccelerations(points, thresholds = DEFAULT_THRESHOLDS) {
  const result = new Array(points?.length || 0).fill(null);
  if (!points || points.length < 3) return result;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];
    const dtTotal = (timestampMs(next) - timestampMs(prev)) / 1000;

    if (dtTotal <= 0 || dtTotal > 15) continue;

    const segPrev = calculateSegmentMetrics(prev, curr, thresholds);
    const segNext = calculateSegmentMetrics(curr, next, thresholds);
    if (segPrev.isNoise || segNext.isNoise) continue;

    result[i] = {
      accel_ms2: calculateAcceleration(
        segPrev.reliableSpeedKmh,
        segNext.reliableSpeedKmh,
        dtTotal
      ),
      speed_kmh: segPrev.reliableSpeedKmh,
    };
  }

  return result;
}

export function normalizeLocationPoint(input) {
  if (!input) return null;

  const coords = input.coords || input;
  const lat = coords.latitude ?? input.lat;
  const lng = coords.longitude ?? input.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const timestampMs = input.timestamp ?? input.time ?? Date.now();
  const normalized = {
    lat,
    lng,
    speed_kmh: coords.speed != null ? Math.max(0, coords.speed * 3.6) : input.speed_kmh ?? null,
    heading: coords.heading ?? coords.bearing ?? coords.course ?? input.heading ?? null,
    accuracy: coords.accuracy ?? input.accuracy ?? null,
    altitude: coords.altitude ?? input.altitude ?? null,
    altitude_accuracy: coords.altitudeAccuracy ?? input.altitudeAccuracy ?? null,
    timestamp: new Date(timestampMs).toISOString(),
  };
  [
    'obd_speed_kmh',
    'obd_speed_timestamp',
    'obd_rpm',
    'obd_throttle_pct',
    'obd_engine_load_pct',
    'obd_coolant_temp_c',
    'obd_maf_gps',
    'obd_data_source',
    'obd_data_timestamp',
  ].forEach((key) => {
    if (input[key] != null) normalized[key] = input[key];
  });
  return normalized;
}

export function shouldAcceptLocationPoint(point, previousPoint = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!point || !hasValidCoordinates(point)) return false;
  if (point.accuracy != null && point.accuracy > thresholds.MAX_GPS_ACCURACY_M) return false;
  if (Number.isFinite(Number(point.speed_kmh)) && Number(point.speed_kmh) > MAX_REASONABLE_GPS_SPEED_KMH) return false;
  if (Number.isFinite(Number(point.obd_speed_kmh)) && Number(point.obd_speed_kmh) > MAX_REASONABLE_OBD_SPEED_KMH) return false;
  if (!previousPoint) return true;

  const dt = (new Date(point.timestamp).getTime() - new Date(previousPoint.timestamp).getTime()) / 1000;
  if (dt <= 0) return false;

  const segment = calculateSegmentMetrics(previousPoint, point, thresholds);
  if (segment.isNoise && dt < 45) return false;

  const impliedSpeed = segment.impliedSpeedKmh;
  const reportedSpeed = segment.reportedSpeedKmh ?? impliedSpeed;
  if (impliedSpeed > MAX_REASONABLE_GPS_SPEED_KMH || reportedSpeed > MAX_REASONABLE_GPS_SPEED_KMH) return false;

  return true;
}

export function getLocationPointRejectionReason(point, previousPoint = null, thresholds = DEFAULT_THRESHOLDS) {
  if (!point || !hasValidCoordinates(point)) return 'invalid_coordinates';
  if (point.accuracy != null && point.accuracy > thresholds.MAX_GPS_ACCURACY_M) {
    return `accuracy_too_poor_${Math.round(point.accuracy)}m`;
  }
  if (Number.isFinite(Number(point.speed_kmh)) && Number(point.speed_kmh) > MAX_REASONABLE_GPS_SPEED_KMH) {
    return `reported_speed_unreasonable_${Math.round(point.speed_kmh)}kmh`;
  }
  if (Number.isFinite(Number(point.obd_speed_kmh)) && Number(point.obd_speed_kmh) > MAX_REASONABLE_OBD_SPEED_KMH) {
    return `obd_speed_unreasonable_${Math.round(point.obd_speed_kmh)}kmh`;
  }
  if (!previousPoint) return null;

  const dt = (new Date(point.timestamp).getTime() - new Date(previousPoint.timestamp).getTime()) / 1000;
  if (dt <= 0) return 'timestamp_non_increasing';

  const segment = calculateSegmentMetrics(previousPoint, point, thresholds);
  if (segment.isNoise && dt < 45) return `noise_too_soon_dt${Math.round(dt)}s`;

  const impliedSpeed = segment.impliedSpeedKmh;
  const reportedSpeed = segment.reportedSpeedKmh ?? impliedSpeed;
  if (impliedSpeed > MAX_REASONABLE_GPS_SPEED_KMH) {
    return `implied_speed_unreasonable_${Math.round(impliedSpeed)}kmh`;
  }
  if (reportedSpeed > MAX_REASONABLE_GPS_SPEED_KMH) {
    return `reported_speed_unreasonable_${Math.round(reportedSpeed)}kmh`;
  }
  return null;
}

function isPrivacyRouteStorageStub(point) {
  return point?.masked_for_privacy === true &&
    (point?.privacy_gap === true || point?.privacy_live_redacted === true || point?.privacy_purged === true) &&
    !hasValidCoordinates(point);
}

export function cleanRoutePoints(points, thresholds = DEFAULT_THRESHOLDS) {
  let previousAcceptedGpsPoint = null;
  return (points || []).reduce((accepted, rawPoint) => {
    const point = normalizeLocationPoint(rawPoint) || rawPoint;
    if (isPrivacyRouteStorageStub(point)) {
      accepted.push(point);
      previousAcceptedGpsPoint = null;
      return accepted;
    }
    if (shouldAcceptLocationPoint(point, previousAcceptedGpsPoint, thresholds)) {
      const segment = previousAcceptedGpsPoint
        ? calculateSegmentMetrics(previousAcceptedGpsPoint, point, thresholds)
        : null;
      const acceptedPoint = segment?.dt > ROUTE_GAP_SECONDS
        ? { ...point, tracking_gap: true }
        : point;
      accepted.push(acceptedPoint);
      previousAcceptedGpsPoint = acceptedPoint;
    }
    return accepted;
  }, []);
}

export const TRIP_STATES = {
  IDLE: 'Idle',
  CANDIDATE: 'CandidateTrip',
  CONFIRMED: 'ConfirmedTrip',
  ENDING_REVIEW: 'EndingReview',
  SAVED: 'Saved',
  DISCARDED: 'Discarded',
};

export const CANDIDATE_TRIP_DEFAULTS = {
  REVIEW_TIMEOUT_MS: 3 * 60 * 1000,
  DISTANCE_M: 150,
  DISTANCE_PARKING_COOLDOWN_M: 250,
  MAX_SPEED_KMH: 10,
  MAX_SPEED_PARKING_COOLDOWN_KMH: 10,
  WALKING_SPEED_CUTOFF_KMH: 10,
  STABLE_POINTS: 4,
  STABLE_POINTS_PARKING_COOLDOWN: 5,
  MAX_ACCURACY_M: DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M,
  PARKING_COOLDOWN_MS: 5 * 60 * 1000,
  PARKING_COOLDOWN_RADIUS_M: 75,
};

function activityTypeOf(activity) {
  return String(activity?.type || activity?.activity || '').toLowerCase();
}

function activityConfidenceOf(activity) {
  const confidence = Number(activity?.confidence);
  return Number.isFinite(confidence) ? confidence : 0;
}

function isStrongFootActivity(activity) {
  const type = activityTypeOf(activity);
  return ['walking', 'running', 'on_foot', 'cycling', 'on_bicycle'].includes(type) &&
    activityConfidenceOf(activity) >= 75;
}

function isVehicleActivity(activity) {
  return activityTypeOf(activity) === 'in_vehicle' && activityConfidenceOf(activity) >= 65;
}

function countStableGpsPoints(points = [], maxAccuracyM = DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M) {
  return (points || []).filter((point) => {
    const accuracy = Number(point?.accuracy);
    return !Number.isFinite(accuracy) || accuracy <= maxAccuracyM;
  }).length;
}

export function isNearRecentParkedLocation(point, parkedLocation, options = {}) {
  if (!point || !parkedLocation) return false;
  const pointLat = Number(point.lat);
  const pointLng = Number(point.lng);
  const parkedLat = Number(parkedLocation.lat);
  const parkedLng = Number(parkedLocation.lng);
  if (![pointLat, pointLng, parkedLat, parkedLng].every(Number.isFinite)) return false;

  const parkedMs = parseTimestampMs(parkedLocation.timestamp) ?? Number(parkedLocation.timestamp_ms);
  if (!Number.isFinite(parkedMs)) return false;

  const nowMs = options.nowMs ?? Date.now();
  const cooldownMs = options.cooldownMs ?? CANDIDATE_TRIP_DEFAULTS.PARKING_COOLDOWN_MS;
  if (nowMs - parkedMs > cooldownMs) return false;

  const radiusM = options.radiusM ?? CANDIDATE_TRIP_DEFAULTS.PARKING_COOLDOWN_RADIUS_M;
  return haversineMeters(parkedLat, parkedLng, pointLat, pointLng) <= radiusM;
}

export function validateCandidateTrip({
  points = [],
  startTime = null,
  now = new Date().toISOString(),
  activity = null,
  nearParkedLocation = false,
  forceFinal = false,
  thresholds = DEFAULT_THRESHOLDS,
  options = {},
} = {}) {
  const config = { ...CANDIDATE_TRIP_DEFAULTS, ...options };
  const cleanPoints = cleanRoutePoints(points, thresholds);
  const stats = calculateTripStats(cleanPoints, startTime, now, thresholds);
  const stablePoints = countStableGpsPoints(cleanPoints, config.MAX_ACCURACY_M);
  const requiredDistanceM = nearParkedLocation ? config.DISTANCE_PARKING_COOLDOWN_M : config.DISTANCE_M;
  const requiredSpeedKmh = nearParkedLocation ? config.MAX_SPEED_PARKING_COOLDOWN_KMH : config.MAX_SPEED_KMH;
  const requiredStablePoints = nearParkedLocation ? config.STABLE_POINTS_PARKING_COOLDOWN : config.STABLE_POINTS;
  const strongFootSignal = isStrongFootActivity(activity);
  const vehicleActivity = isVehicleActivity(activity);
  const enoughGps = stablePoints >= requiredStablePoints;
  const enoughDistance = (stats.distance_km || 0) * 1000 >= requiredDistanceM;
  const vehicleSpeedSegment = (stats.max_speed_kmh || 0) >= requiredSpeedKmh;
  const startMs = parseTimestampMs(startTime);
  const nowMs = parseTimestampMs(now) ?? Date.now();
  const candidateAgeMs = startMs == null ? 0 : Math.max(0, nowMs - startMs);

  const result = {
    state: TRIP_STATES.CANDIDATE,
    confirmed: false,
    discarded: false,
    reason: null,
    title: null,
    cleanPoints,
    metrics: {
      distance_m: Math.round((stats.distance_km || 0) * 1000),
      max_speed_kmh: stats.max_speed_kmh || 0,
      stable_points: stablePoints,
      required_distance_m: requiredDistanceM,
      required_speed_kmh: requiredSpeedKmh,
      required_stable_points: requiredStablePoints,
      candidate_age_ms: candidateAgeMs,
      near_parked_location: nearParkedLocation,
      vehicle_activity: vehicleActivity,
      strong_foot_signal: strongFootSignal,
    },
  };

  if (strongFootSignal && (stats.max_speed_kmh || 0) <= config.WALKING_SPEED_CUTOFF_KMH) {
    return {
      ...result,
      state: TRIP_STATES.DISCARDED,
      discarded: true,
      reason: 'movement_looked_like_walking',
      title: 'Candidate discarded: walking/running signal detected',
    };
  }

  if (enoughGps && enoughDistance && vehicleSpeedSegment && !strongFootSignal) {
    return {
      ...result,
      state: TRIP_STATES.CONFIRMED,
      confirmed: true,
      reason: vehicleActivity ? 'activity_in_vehicle' : 'vehicle_speed_distance',
      title: 'Candidate confirmed: vehicle-like movement detected',
    };
  }

  if (forceFinal || candidateAgeMs >= config.REVIEW_TIMEOUT_MS) {
    if (!vehicleSpeedSegment) {
      return {
        ...result,
        state: TRIP_STATES.DISCARDED,
        discarded: true,
        reason: 'no_vehicle_speed_segment',
        title: 'Candidate discarded: no vehicle-speed segment',
      };
    }
    if (!enoughGps) {
      return {
        ...result,
        state: TRIP_STATES.DISCARDED,
        discarded: true,
        reason: 'unstable_gps_drift',
        title: 'Candidate discarded: unstable GPS drift',
      };
    }
    return {
      ...result,
      state: TRIP_STATES.DISCARDED,
      discarded: true,
      reason: 'gps_movement_too_short',
      title: 'Candidate discarded: GPS movement too short',
    };
  }

  return result;
}

export function trimParkedTail(points = [], {
  endTime = new Date().toISOString(),
  reason = '',
  activity = null,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const cleanPoints = cleanRoutePoints(points, thresholds);
  const originalEndTime = endTime;
  if (cleanPoints.length < 4) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const stopLikeReason = /park|still|foot|walking|gps|auto/i.test(String(reason || ''));
  const strongFootSignal = isStrongFootActivity(activity);
  if (!stopLikeReason && !strongFootSignal) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const vehicleSpeed = CANDIDATE_TRIP_DEFAULTS.MAX_SPEED_KMH;
  let lastVehicleIndex = -1;
  for (let i = cleanPoints.length - 1; i >= 0; i--) {
    if ((Number(cleanPoints[i].speed_kmh) || 0) >= vehicleSpeed) {
      lastVehicleIndex = i;
      break;
    }
  }

  if (lastVehicleIndex < 0 || lastVehicleIndex >= cleanPoints.length - 1) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  let keepThrough = Math.min(lastVehicleIndex + 1, cleanPoints.length - 1);
  for (let i = lastVehicleIndex + 1; i < cleanPoints.length; i++) {
    if ((Number(cleanPoints[i].speed_kmh) || 0) < (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH)) {
      keepThrough = i;
      break;
    }
  }

  const removedPoints = cleanPoints.length - (keepThrough + 1);
  if (removedPoints <= 0) {
    return {
      points: cleanPoints,
      endTime: originalEndTime,
      removedPoints: 0,
      trimmed: false,
      reason: null,
    };
  }

  const trimmedPoints = cleanPoints.slice(0, keepThrough + 1);
  return {
    points: trimmedPoints,
    endTime: trimmedPoints[trimmedPoints.length - 1]?.timestamp || originalEndTime,
    removedPoints,
    trimmed: true,
    reason: strongFootSignal ? 'walking_after_parking' : 'parked_tail_review',
  };
}

function perpendicularDistanceMeters(point, lineStart, lineEnd) {
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

export function calculateRouteSummary(points, startTime, endTime, thresholds = DEFAULT_THRESHOLDS) {
  const cleaned = cleanRoutePoints(points, thresholds);
  const stats = calculateTripStats(cleaned, startTime, endTime, thresholds, {
    raw_route_points: points,
  });
  const { events, phoneUse } = detectDrivingEvents(cleaned, thresholds, endTime);
  const scores = calculateTripScores(events, stats, cleaned, thresholds, stats.duration_seconds, phoneUse, { endTime });
  return { points: cleaned, stats, events, scores };
}

function tripTouchesPrivacyZone(routePoints = [], zones = []) {
  const points = Array.isArray(routePoints) ? routePoints : [];
  if (!points.length) return false;
  return points.some((point) => (
    point?.masked_for_privacy === true ||
    point?.privacy_boundary === true ||
    point?.privacy_gap === true ||
    Boolean(point?.privacy_zone_id) ||
    (Array.isArray(zones) && zones.length > 0 && Boolean(isPointInPrivacyZone(point, zones)))
  ));
}

export function applyDifferentialPrivacyToTripAggregates(trip = {}, routePoints = trip?.route_points, zones = []) {
  if (!trip || typeof trip !== 'object' || /** @type {any} */ (trip)._dpApplied === true) return trip;
  if (!tripTouchesPrivacyZone(routePoints, zones)) return trip;
  return applyDifferentialPrivacyToAggregates(trip);
}

function generatedTripId(prefix = 'trip') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function splitTripAtStops(trip, minParkMinutes = 5, thresholds = DEFAULT_THRESHOLDS) {
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  if (routePoints.length < 2) return [];

  const minStopSeconds = Math.max(0, Number(minParkMinutes) || 0) * 60;
  const stops = detectTripStops(routePoints, {
    minStopSeconds,
    maxSpeedKmh: thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH,
  });
  const sortedPoints = [...routePoints].sort((a, b) => timestampMs(a) - timestampMs(b));

  if (!stops.length) {
    return [{
      ...trip,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: 1,
      route_points: sortedPoints,
    }];
  }

  const splitRanges = [];
  let segmentStartIndex = 0;

  for (const stop of stops) {
    const stopStartMs = new Date(stop.start_time).getTime();
    const stopEndMs = new Date(stop.end_time).getTime();
    const beforeStopEnd = sortedPoints.findIndex((point, index) => index >= segmentStartIndex && timestampMs(point) >= stopStartMs);
    const afterStopStart = sortedPoints.findIndex((point) => timestampMs(point) > stopEndMs);
    const endIndex = beforeStopEnd > segmentStartIndex ? beforeStopEnd - 1 : segmentStartIndex - 1;
    if (endIndex - segmentStartIndex + 1 >= 2) splitRanges.push([segmentStartIndex, endIndex]);
    segmentStartIndex = afterStopStart >= 0 ? afterStopStart : sortedPoints.length;
  }

  if (sortedPoints.length - segmentStartIndex >= 2) {
    splitRanges.push([segmentStartIndex, sortedPoints.length - 1]);
  }

  return splitRanges.map(([startIndex, endIndex], index) => {
    const segmentPoints = sortedPoints.slice(startIndex, endIndex + 1);
    const startTime = segmentPoints[0].timestamp;
    const endTime = segmentPoints[segmentPoints.length - 1].timestamp;
    const stats = calculateTripStats(segmentPoints, startTime, endTime, thresholds);
    const { events, phoneUse } = detectDrivingEvents(segmentPoints, thresholds, endTime);
    const scores = calculateTripScores(events, stats, segmentPoints, thresholds, stats.duration_seconds, phoneUse, { endTime });
    const drivingEvents = scores.driving_events || events;
    const economics = estimateTripEconomics({ ...stats, ...scores });

    return {
      ...stats,
      ...scores,
      co2_saved_kg: economics.co2_saved_kg,
      fuel_cost: economics.cost,
      fuel_used_liters: economics.liters,
      co2_kg: economics.co2_kg,
      fuel_saved_liters: economics.fuel_saved_liters,
      id: generatedTripId('split'),
      split_parent_id: trip?.id ?? null,
      split_segment_index: index + 1,
      status: 'completed',
      start_time: startTime,
      end_time: endTime,
      vehicle_id: trip?.vehicle_id ?? null,
      tag: trip?.tag ?? null,
      background_tracking: trip?.background_tracking ?? false,
      start_source: trip?.start_source || 'split',
      route_points: segmentPoints,
      route_points_raw_count: segmentPoints.length,
      driving_events: drivingEvents,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });
}

// ─── Event Detection ───────────────────────────────────────────────────────────
function finiteVehicleSpeed(value) {
  const speed = Number(value);
  return Number.isFinite(speed) && speed >= 0 && speed <= MAX_REASONABLE_OBD_SPEED_KMH ? speed : null;
}

function obdSpeedTimestampMs(point) {
  return parseTimestampMs(point?.obd_speed_timestamp ?? point?.obd_data_timestamp);
}

function gpsSpeedTimestampMs(point) {
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

function finiteSpeed(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds) ?? 0;
}

function pointSpeedKmh(point, thresholds = DEFAULT_THRESHOLDS) {
  return vehicleSpeedKmh(point, thresholds);
}

function isLikelySpeedSpike(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS) {
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
  thresholds = thresholds || DEFAULT_THRESHOLDS;
  if (isLikelySpeedSpike(points, index, thresholds)) return null;
  const reportedSpeed = pointSpeedKmh(points[index], thresholds);
  const candidates = [];
  if (points[index - 1]) {
    const previousSegment = calculateSegmentMetrics(points[index - 1], points[index], thresholds);
    if (previousSegment.dt > 0 && previousSegment.dt <= ROUTE_GAP_SECONDS && !previousSegment.isNoise) {
      candidates.push(previousSegment.impliedSpeedKmh);
    }
  }
  if (points[index + 1]) {
    const nextSegment = calculateSegmentMetrics(points[index], points[index + 1], thresholds);
    if (nextSegment.dt > 0 && nextSegment.dt <= ROUTE_GAP_SECONDS && !nextSegment.isNoise) {
      candidates.push(nextSegment.impliedSpeedKmh);
    }
  }

  const derivedSpeed = candidates
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  if (!Number.isFinite(derivedSpeed)) return reportedSpeed;
  if (reportedSpeed == null) return derivedSpeed;

  const trustedSpeed = thresholds.MIN_TRUSTED_SPEED_KMH ?? DEFAULT_THRESHOLDS.MIN_TRUSTED_SPEED_KMH;
  const stationarySpeed = thresholds.STATIONARY_SPEED_KMH ?? DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH;
  const neighboringReportedSpeeds = [points[index - 1], points[index + 1]]
    .map((point) => pointSpeedKmh(point, thresholds))
    .filter((speed) => speed != null);
  const reportedStationaryWhileSustainedMovement = reportedSpeed < stationarySpeed &&
    derivedSpeed >= trustedSpeed &&
    neighboringReportedSpeeds.every((speed) => speed < stationarySpeed);
  return reportedStationaryWhileSustainedMovement
    ? derivedSpeed
    : reportedSpeed;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function safeMax(values = [], fallback = 0) {
  return values.length ? Math.max(...values) : fallback;
}

function percentileValue(values, p) {
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

function isPrivacyBoundaryPoint(point) {
  return point?.privacy_boundary === true || point?.is_privacy_boundary === true;
}

function privacyZoneKey(point) {
  return point?.privacy_zone_id ?? point?.privacy_zone_label ?? point?.privacy_zone_name ?? point?.zone_id ?? null;
}

function samePrivacyZoneBoundary(a, b) {
  const zoneA = privacyZoneKey(a);
  const zoneB = privacyZoneKey(b);
  return zoneA == null || zoneB == null || String(zoneA) === String(zoneB);
}

function calculateEstimatedPrivateDistanceKm(points = [], { includeAdjacentBoundaries = true } = {}) {
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

function calculateRouteDistanceKm(points = [], thresholds = DEFAULT_THRESHOLDS) {
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (
      segment.dt > 0 &&
      segment.dt <= 120 &&
      !segment.isNoise &&
      segment.impliedSpeedKmh <= MAX_REASONABLE_GPS_SPEED_KMH
    ) {
      distance += segment.distanceKm;
    }
  }
  return distance + calculateEstimatedPrivateDistanceKm(points, { includeAdjacentBoundaries: false });
}

/**
 * Decide whether a manually ended trip has enough movement evidence to save.
 *
 * Manual trips can have very sparse GPS on Android while the screen is locked.
 * The coordinate-displacement fallback intentionally skips the short segment
 * cap used by normal route distance, but still rejects impossible GPS jumps.
 */
export function reviewManualTripSave({ points = [], stats = {}, startTime, endTime, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const wallClockSeconds = Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round((endMs - startMs) / 1000))
    : 0;
  const durationSeconds = Math.max(Number(stats.duration_seconds) || 0, wallClockSeconds);
  const distanceKm = Number(stats.distance_km) || 0;
  const maxSpeedKmh = Number(stats.max_speed_kmh) || 0;

  const coordinatePoints = (points || []).filter((point) => hasUsableManualTripCoordinates(point, thresholds));
  const movingSpeedSamples = coordinatePoints.filter(
    (point) => Number(point?.speed_kmh) >= MANUAL_SPARSE_GPS_MIN_SPEED_KMH
  );

  const diag = {
    durationSeconds,
    distanceKm,
    coordinatePointCount: coordinatePoints.length,
    maxSpeedKmh,
    movingSpeedSampleCount: movingSpeedSamples.length,
    cumulativeCoordKm: 0,
  };

  if (durationSeconds < MIN_MANUAL_SAVE_SECONDS) {
    return { shouldSave: false, reason: 'manual_duration_too_short', ...diag };
  }

  const minDistKm = thresholds.MIN_TRIP_DISTANCE_KM ?? DEFAULT_THRESHOLDS.MIN_TRIP_DISTANCE_KM;
  if (distanceKm >= minDistKm) {
    return { shouldSave: true, reason: 'manual_distance_confirmed', ...diag };
  }

  if (coordinatePoints.length >= 2) {
    let cumulativeCoordKm = 0;
    for (let i = 1; i < coordinatePoints.length; i++) {
      const segment = calculateSegmentMetrics(coordinatePoints[i - 1], coordinatePoints[i], thresholds);
      if (
        segment.distanceKm > 0 &&
        !segment.isNoise &&
        segment.impliedSpeedKmh <= MAX_REASONABLE_GPS_SPEED_KMH
      ) {
        cumulativeCoordKm += segment.distanceKm;
      }
    }
    diag.cumulativeCoordKm = Math.round(cumulativeCoordKm * 1000) / 1000;
    if (cumulativeCoordKm >= minDistKm) {
      return { shouldSave: true, reason: 'manual_coordinate_displacement_confirmed', ...diag };
    }
  }

  if (
    durationSeconds >= MANUAL_SPARSE_GPS_MIN_SECONDS &&
    coordinatePoints.length >= 2 &&
    (movingSpeedSamples.length >= 2 || maxSpeedKmh >= MANUAL_SPARSE_GPS_MIN_SPEED_KMH)
  ) {
    return { shouldSave: true, reason: 'manual_sparse_gps_vehicle_speed', ...diag };
  }

  return { shouldSave: false, reason: 'manual_no_movement_evidence', ...diag };
}

function calculateTerminalStoppedSeconds(points = [], endTime = null, thresholds = DEFAULT_THRESHOLDS) {
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

function normalizeRoadTypeLabel(roadType, point = {}) {
  if (roadType === 'highway' || roadType === 'urban' || roadType === 'residential') return roadType;
  const speed = finiteSpeed(point);
  if (speed >= 80) return 'highway';
  if (speed < 30) return 'residential';
  return 'urban';
}

function classifyRoadTypesByPoint(routePoints = [], windowSize = 30) {
  const points = routePoints || [];
  const halfWindow = Math.max(1, Math.floor(windowSize / 2));
  return points.map((point, index) => {
    const start = Math.max(0, index - halfWindow);
    const end = Math.min(points.length, index + halfWindow + 1);
    return normalizeRoadTypeLabel(classifyRoadType(points.slice(start, end)).road_type, point);
  });
}

function nearestPointIndexByTimestamp(routePoints = [], event = {}) {
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

function zoneFromP85(p85Speed) {
  if (p85Speed < 30) return { inferredZone: 'zone_30', inferredZoneKmh: 30 };
  if (p85Speed < 55) return { inferredZone: 'zone_50', inferredZoneKmh: 50 };
  if (p85Speed < 80) return { inferredZone: 'zone_60_70', inferredZoneKmh: 70 };
  if (p85Speed < 110) return { inferredZone: 'zone_80_100', inferredZoneKmh: 100 };
  return { inferredZone: 'zone_highway', inferredZoneKmh: 120 };
}

function sortedInsert(values, value) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < value) low = mid + 1;
    else high = mid;
  }
  values.splice(low, 0, value);
}

function sortedRemove(values, value) {
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

function percentileFromSorted(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const index = (p / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function speedStdDevFromSummary(count, sum, sumSq) {
  if (count < 2) return 0;
  const mean = sum / count;
  const variance = Math.max(0, (sumSq / count) - (mean * mean));
  return Math.sqrt(variance);
}

function createRoadTypeWindowSummary() {
  return {
    total: 0,
    sum: 0,
    highway: 0,
    urban: 0,
    residential: 0,
  };
}

function updateRoadTypeWindowSummary(summary, point, direction) {
  const speed = Number(point?.speed_kmh);
  if (!Number.isFinite(speed) || speed <= 0) return;
  summary.total += direction;
  summary.sum += speed * direction;
  if (speed >= 80) summary.highway += direction;
  else if (speed >= 20) summary.urban += direction;
  else summary.residential += direction;
}

function roadTypeFromWindowSummary(summary) {
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

function createZoneLookup(zones = []) {
  let cursor = 0;
  return (index) => {
    while (cursor + 1 < zones.length && index >= zones[cursor + 1].startIndex) cursor++;
    for (let i = cursor; i >= 0; i--) {
      const zone = zones[i];
      if (!zone) continue;
      if (index >= zone.startIndex && index <= zone.endIndex) return zone;
      if (zone.endIndex < index) break;
    }
    return null;
  };
}

export function computeSegmentP85(points, windowSecs = 30, overlapFraction = 0.5) {
  const entries = (Array.isArray(points) ? points : [])
    .map((point, index) => ({
      point,
      index,
      ts: timestampMs(point),
      speed: Number(point?.speed_kmh ?? point?.speedKmh),
    }))
    .filter((entry) => Number.isFinite(entry.ts) && Number.isFinite(entry.speed) && hasValidCoordinates(entry.point));
  if (entries.length < 2) return [];

  const windowMs = Math.max(1, Number(windowSecs) || 30) * 1000;
  const stepMs = Math.max(1000, windowMs * Math.max(0.05, Math.min(1, Number(overlapFraction) || 0.5)));
  const firstTs = entries[0].ts;
  const lastTs = entries[entries.length - 1].ts;
  const windows = [];

  for (let startTs = firstTs; startTs <= lastTs; startTs += stepMs) {
    const endTs = startTs + windowMs;
    const samples = entries.filter((entry) => entry.ts >= startTs && entry.ts <= endTs);
    if (!samples.length) continue;
    const speeds = samples.map((entry) => entry.speed).sort((a, b) => a - b);
    const percentileIndex = Math.min(speeds.length - 1, Math.max(0, Math.floor((speeds.length - 1) * 0.85)));
    windows.push({
      windowStartIdx: samples[0].index,
      windowEndIdx: samples[samples.length - 1].index,
      p85Kmh: speeds[percentileIndex],
      midpointTimestamp: new Date(startTs + windowMs / 2).toISOString(),
    });
  }

  return windows;
}

export function computeGpsRoadClass(p85, stopDensity, turnDensity, headingStability) {
  const p85Speed = Number(p85);
  const stopDensityLow = Number(stopDensity) < 0.08;
  const stopDensityHigh = Number(stopDensity) >= 0.20;
  const turnDensityHigh = Number(turnDensity) >= 0.25;
  const headingStable = Number(headingStability) >= 0.75;
  if (p85Speed > 95 && stopDensityLow && headingStable) return 'motorway';
  if (p85Speed > 75 && stopDensityLow) return 'rural_or_arterial';
  if (stopDensityHigh || turnDensityHigh) return 'urban';
  return 'unknown';
}

function pointHasOsmHighwayType(point) {
  return Boolean(point?.osmHighwayType || point?.speed_limit_highway || point?.highway);
}

function roadTypeFromGpsRoadClass(gpsRoadClass, fallbackRoadType) {
  if (gpsRoadClass === 'motorway' || gpsRoadClass === 'rural_or_arterial') return 'highway';
  if (gpsRoadClass === 'urban') return 'urban';
  return fallbackRoadType || 'urban';
}

export function inferSpeedZones(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const normalizedPoints = (routePoints || []).map((point, index) => ({
    ...point,
    speed_kmh: reliablePointSpeed(routePoints, index, thresholds),
  }));
  const windows = computeSegmentP85(normalizedPoints, 30, 0.5);
  if (!windows.length) return [];

  return windows.map((window) => {
    const windowPoints = normalizedPoints.slice(window.windowStartIdx, window.windowEndIdx + 1);
    const speeds = windowPoints.map((point) => Number(point?.speed_kmh)).filter(Number.isFinite).sort((a, b) => a - b);
    const speedSum = speeds.reduce((sum, speed) => sum + speed, 0);
    const speedSumSq = speeds.reduce((sum, speed) => sum + speed * speed, 0);
    const roadSummary = createRoadTypeWindowSummary();
    windowPoints.forEach((point) => updateRoadTypeWindowSummary(roadSummary, point, 1));
    const { road_type: summaryRoadType, highway_fraction: highwayFraction } = roadTypeFromWindowSummary(roadSummary);
    const p85Speed = Number(window.p85Kmh);
    const medianSpeed = percentileFromSorted(speeds, 50);
    const deviation = speedStdDevFromSummary(speeds.length, speedSum, speedSumSq);
    const stopDensity = windowPoints.length
      ? windowPoints.filter((point) => Number(point?.speed_kmh) <= (thresholds.IDLE_SPEED_KMH ?? DEFAULT_THRESHOLDS.IDLE_SPEED_KMH)).length / windowPoints.length
      : 0;
    const headingChanges = [];
    for (let i = 1; i < windowPoints.length; i++) {
      const previousHeading = Number.isFinite(Number(windowPoints[i - 1]?.heading)) ? Number(windowPoints[i - 1].heading) : null;
      const currentHeading = Number.isFinite(Number(windowPoints[i]?.heading)) ? Number(windowPoints[i].heading) : null;
      if (previousHeading != null && currentHeading != null) headingChanges.push(Math.abs(headingDiff(previousHeading, currentHeading)));
    }
    const turnDensity = headingChanges.length
      ? headingChanges.filter((change) => change >= 25).length / headingChanges.length
      : 0;
    const headings = windowPoints.map((point) => Number(point?.heading)).filter(Number.isFinite);
    const headingStability = headings.length >= 2
      ? Math.max(0, 1 - calculateAngularStdDev(headings) / 45)
      : 1;
    const gpsRoadClass = windowPoints.some(pointHasOsmHighwayType)
      ? null
      : computeGpsRoadClass(p85Speed, stopDensity, turnDensity, headingStability);
    const roadType = gpsRoadClass
      ? roadTypeFromGpsRoadClass(gpsRoadClass, summaryRoadType)
      : summaryRoadType;
    const zone = zoneFromP85(p85Speed);
    const inferredLimitKmh = Math.min(zone.inferredZoneKmh, complianceFallbackLimit(roadType, thresholds));

    return {
      startIndex: window.windowStartIdx,
      endIndex: window.windowEndIdx,
      inferredZone: zone.inferredZone,
      inferredZoneKmh: zone.inferredZoneKmh,
      inferredLimitKmh,
      confidence: deviation < 8 ? 'high' : deviation < 18 ? 'medium' : 'low',
      median_speed_kmh: round1(medianSpeed),
      p85_speed_kmh: round1(p85Speed),
      midpointTimestamp: window.midpointTimestamp,
      road_type: roadType,
      gps_road_class: gpsRoadClass,
      road_type_fraction: highwayFraction,
      speed_std_dev: round1(deviation),
      stop_density: round2(stopDensity),
      turn_density: round2(turnDensity),
      heading_stability: round2(headingStability),
      threshold_kmh: zone.inferredZone === 'zone_highway'
        ? thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH
        : zone.inferredZoneKmh + (thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH),
    };
  });
}

export function calculateJerkScore(cleanPoints = [], distanceKmOrThresholds = DEFAULT_THRESHOLDS) {
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

export function calculateHillDrivingScore(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const maxAltitudeAccuracy = thresholds.MAX_ALTITUDE_ACCURACY_M ?? DEFAULT_THRESHOLDS.MAX_ALTITUDE_ACCURACY_M;
  const hasReliableAltitude = (point) => (
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

export function calculateEcoDrivingScore(cleanPoints = [], stats = {}, thresholds = DEFAULT_THRESHOLDS) {
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

function unavailableSvi(sampleCount) {
  return {
    speed_variability_index: null,
    svi_score: null,
    svi_label: 'unknown',
    svi_score_confidence: 'insufficient_data',
    svi_moving_sample_count: sampleCount,
  };
}

function standardDeviation(samples) {
  const mean = average(samples);
  return Math.sqrt(average(samples.map((speed) => (speed - mean) ** 2)));
}

function calculateObdEcoSignals(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
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

function sviDistanceKm(samples, cleanPoints, thresholds) {
  return samples.reduce((distance, sample) => {
    if (sample.index === 0) return distance;
    const segment = calculateSegmentMetrics(cleanPoints[sample.index - 1], cleanPoints[sample.index], thresholds);
    return segment.dt > 0 && segment.dt <= 120 && !segment.isNoise ? distance + segment.distanceKm : distance;
  }, 0);
}

export function calculateSpeedVariabilityIndex(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
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
  const weightFor = (group) => (
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

export function calculateFuelBandScore(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
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

function headingBetweenPair(prev, curr, fallbackPrev = null) {
  if (Number.isFinite(prev?.heading) && Number.isFinite(curr?.heading)) {
    return { h1: prev.heading, h2: curr.heading };
  }
  const h1 = Number.isFinite(prev?.heading)
    ? prev.heading
    : fallbackPrev
      ? calculateBearing(fallbackPrev.lat, fallbackPrev.lng, prev.lat, prev.lng)
      : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  const h2 = Number.isFinite(curr?.heading)
    ? curr.heading
    : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
  return { h1, h2 };
}

export function detectHeadingDeviationEvents(points = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!points || points.length < 2) return [];

  const candidates = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const speed = Math.max(
      reliablePointSpeed(points, i - 1, thresholds) ?? finiteSpeed(prev),
      reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(curr)
    );
    const minSpeed = thresholds.HEADING_DEVIATION_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_SPEED_KMH;
    if (speed <= minSpeed) continue;

    const dt = (timestampMs(curr) - timestampMs(prev)) / 1000;
    if (dt <= 0 || dt > 30) continue;

    const { h1, h2 } = headingBetweenPair(prev, curr, points[i - 2] || null);
    const signedDelta = signedHeadingDelta(h1, h2);
    const turnRate = Math.abs(signedDelta) / dt;
    const minRate = thresholds.HEADING_DEVIATION_MIN_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_TURN_RATE_DEG_S;
    const maxRate = thresholds.HEADING_DEVIATION_MAX_TURN_RATE_DEG_S ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MAX_TURN_RATE_DEG_S;

    const highwaySpeed = thresholds.HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH;
    const windowStart = Math.max(0, i - 3);
    const windowEnd = Math.min(points.length - 1, i + 3);
    const windowPoints = points.slice(windowStart, windowEnd + 1);
    const windowDurationS = (timestampMs(points[windowEnd]) - timestampMs(points[windowStart])) / 1000;
    if (windowDurationS <= 0 || windowDurationS > 40) continue;
    const minWindowSeconds = thresholds.HEADING_DEVIATION_MIN_WINDOW_SECONDS ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_MIN_WINDOW_SECONDS;
    if (windowDurationS < minWindowSeconds) continue;
    const straightHeadingStdMax = thresholds.HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG;
    const approachHeadingStd = headingVarianceForRange(points, windowStart, Math.max(windowStart, i - 1));
    if (approachHeadingStd > straightHeadingStdMax) continue;
    const suppressionRadius = thresholds.HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS ?? DEFAULT_THRESHOLDS.HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS;
    if (isNearIntersectionOrRampContext(points, i, suppressionRadius)) continue;

    let leftChange = 0;
    let rightChange = 0;
    let totalAbsChange = Math.abs(signedDelta);
    const nearbyHeadingDeltas = [];
    for (let j = Math.max(1, windowStart + 1); j <= windowEnd; j++) {
      const a = headingForIndex(points, j - 1);
      const b = headingForIndex(points, j);
      const delta = signedHeadingDelta(a, b);
      const deltaSeconds = Math.abs(timestampMs(points[j]) - timestampMs(curr)) / 1000;
      const absDelta = Math.abs(delta);
      totalAbsChange += j === i ? 0 : absDelta;
      if (deltaSeconds <= 8 && absDelta >= 1.5 && absDelta <= 20) nearbyHeadingDeltas.push(delta);
      if (delta > 0) rightChange += delta;
      if (delta < 0) leftChange += Math.abs(delta);
    }
    const hasCounterSteer = nearbyHeadingDeltas.some((delta) => (
      (signedDelta > 0 && delta < 0) || (signedDelta < 0 && delta > 0)
    )) || (leftChange >= 2.5 && rightChange >= 2.5);

    const headings = windowPoints.map((_, offset) => headingForIndex(points, windowStart + offset));
    const startHeading = headings[0];
    const endHeading = headings[headings.length - 1];
    const netHeadingChange = Math.abs(signedHeadingDelta(startHeading, endHeading));
    const peakExcursion = headings.reduce((peak, heading) => Math.max(peak, Math.abs(signedHeadingDelta(startHeading, heading))), 0);
    const windowSpeeds = windowPoints.map((_, offset) => reliablePointSpeed(points, windowStart + offset, thresholds) ?? finiteSpeed(points[windowStart + offset]));
    const stableSpeed = speedStdDev(windowSpeeds) <= (speed >= highwaySpeed ? 12 : 8);
    const usableGpsShape = windowPoints.every((point, offset) => {
      if (point.accuracy != null && point.accuracy > 35) return false;
      if (offset === 0) return true;
      const segment = calculateSegmentMetrics(windowPoints[offset - 1], point, thresholds);
      return segment.dt > 0 && segment.dt <= 10 && !segment.isNoise && segment.distanceM >= 8;
    });
    if (!usableGpsShape) continue;
    const sCurveLaneChange = hasCounterSteer &&
      peakExcursion >= 5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 6 &&
      totalAbsChange >= 10 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const highwayLaneShift = speed >= highwaySpeed &&
      hasCounterSteer &&
      peakExcursion >= 4.5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 7 &&
      totalAbsChange >= 9 &&
      totalAbsChange <= 32 &&
      stableSpeed;
    const pointRateFits = turnRate >= minRate && turnRate <= maxRate;
    const pointRateLaneChange = pointRateFits &&
      hasCounterSteer &&
      peakExcursion >= 5 &&
      peakExcursion <= 18 &&
      netHeadingChange <= 6 &&
      totalAbsChange >= 10 &&
      totalAbsChange <= 32 &&
      stableSpeed;

    if (pointRateLaneChange || sCurveLaneChange || highwayLaneShift) {
      candidates.push({ point: curr, turnRate: Math.max(turnRate, totalAbsChange / windowDurationS), speed, pointIndex: i });
    }
  }

  const merged = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    const candidateTime = timestampMs(candidate.point);
    if (previous && (candidateTime - previous.lastTime) / 1000 <= 3) {
      previous.lastTime = candidateTime;
      if (candidate.turnRate > previous.turnRate) {
        previous.turnRate = candidate.turnRate;
        previous.point = candidate.point;
        previous.speed = candidate.speed;
        previous.pointIndex = candidate.pointIndex;
      }
    } else {
      merged.push({ ...candidate, lastTime: candidateTime });
    }
  }

  const distanceKm = Math.max(1, calculateRouteDistanceKm(points, thresholds));
  const ratePer10Km = (merged.length / distanceKm) * 10;
  const severity = ratePer10Km >= 4 ? 'high' : ratePer10Km >= 2 ? 'medium' : 'low';

  return merged.map(({ point, turnRate, speed, pointIndex }) => ({
    type: EVENT_TYPES.HEADING_DEVIATION,
    severity,
    label: 'heading deviation event (beta)',
    confidence: 'low',
    lat: point.lat,
    lng: point.lng,
    timestamp: point.timestamp,
    point_index: pointIndex,
    value: round1(turnRate),
    speed_kmh: Math.round(speed),
  }));
}

const LANE_CHANGE_EVENT_TYPE = 'lane_change_detected';
const LANE_CHANGE_MIN_SPEED_KMH = 65;
const LANE_CHANGE_MIN_LATERAL_G = 0.08;
const LANE_CHANGE_MAX_LATERAL_G = 0.35;
const LANE_CHANGE_BILATERAL_WINDOW_S = 7;
const LANE_CHANGE_MAX_NET_HEADING_DEG = 10;
const LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD = -2.0;
const LANE_CHANGE_MAX_GPS_ACCURACY_M = 20;
const LANE_CHANGE_GPS_MIN_DELTA_DEG = 1.5;
const LANE_CHANGE_GPS_MAX_DELTA_DEG = 8;
const LANE_CHANGE_MAX_SPEED_DROP_KMH = 12;

function finiteSampleValue(sample, key) {
  const value = Number(sample?.[key]);
  return Number.isFinite(value) ? value : null;
}

function sampleTimestampMs(sample) {
  const value = sample?.timestamp_ms ?? sample?.timestamp ?? sample?.time;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const ms = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

function normalizedLaneMotionSample(sample = {}) {
  const ax = finiteSampleValue(sample, 'ax');
  const ay = finiteSampleValue(sample, 'ay');
  const az = finiteSampleValue(sample, 'az');
  const gx = finiteSampleValue(sample, 'gx');
  const gy = finiteSampleValue(sample, 'gy');
  const gz = finiteSampleValue(sample, 'gz');
  const gzDegS = finiteSampleValue(sample, 'gz_deg_s') ?? (gz != null ? gz * 180 / Math.PI : null);
  return {
    ...sample,
    timestamp_ms: sampleTimestampMs(sample),
    ax,
    ay,
    az,
    gx,
    gy,
    gz,
    gz_deg_s: gzDegS,
    has_axes: sample?.has_axes === true || (ax != null && ay != null && gzDegS != null),
  };
}

function headingValueForLaneChange(points, index) {
  const point = points[index];
  const heading = Number(point?.heading ?? point?.bearing);
  return Number.isFinite(heading) ? heading : headingForIndex(points, index);
}

function firstPointAtOrAfter(points = [], targetMs) {
  return points.find((point) => timestampMs(point) >= targetMs) || null;
}

function speedMaintainedInWindow(points = [], startMs, endMs, baselineSpeed) {
  const windowSpeeds = points
    .filter((point) => {
      const ms = timestampMs(point);
      return ms >= startMs && ms <= endMs;
    })
    .map((point) => finiteSpeed(point))
    .filter(Number.isFinite);
  if (windowSpeeds.length < 2) return true;
  const minSpeed = Math.min(...windowSpeeds);
  const maxSpeed = Math.max(...windowSpeeds);
  return baselineSpeed - minSpeed <= LANE_CHANGE_MAX_SPEED_DROP_KMH && maxSpeed - minSpeed <= 20;
}

/**
 * Detect probable lane changes from calibrated IMU axes, with a lower-confidence
 * GPS bilateral-heading fallback for highway-speed trips.
 *
 * @param {Array<object>} cleanPoints GPS route points.
 * @param {Array<object>} motionSamples Raw or normalized IMU samples.
 * @param {object} orientationCalibration Result from calibratePhoneOrientation.
 * @param {object} thresholds Driving thresholds.
 * @returns {{lane_changes:Array<object>,lane_change_count:number,unsafe_lane_changes:number,confidence:string,detection_method:string}}
 */
export function detectLaneChanges(cleanPoints = [], motionSamples = [], orientationCalibration = null, thresholds = DEFAULT_THRESHOLDS) {
  const points = Array.isArray(cleanPoints) ? cleanPoints : [];
  const lateralAxis = orientationCalibration?.lateral_axis || null;
  const longitudinalAxis = orientationCalibration?.longitudinal_axis || null;
  const imuAvailable = orientationCalibration?.calibrated === true && lateralAxis && longitudinalAxis;

  if (!imuAvailable && points.length < 10) {
    return {
      lane_changes: [],
      lane_change_count: 0,
      unsafe_lane_changes: 0,
      confidence: 'insufficient_data',
      detection_method: 'unavailable',
    };
  }

  const normalizedSamples = (motionSamples || [])
    .map(normalizedLaneMotionSample)
    .filter((sample) => Number.isFinite(sample.timestamp_ms));
  const laneChanges = [];
  let suppressUntilMs = 0;

  const samplesInWindow = (startMs, endMs) => normalizedSamples.filter((sample) => (
    sample.timestamp_ms >= startMs && sample.timestamp_ms <= endMs
  ));

  for (let i = 2; i < points.length - 3; i++) {
    const p = points[i];
    const speed = reliablePointSpeed(points, i, thresholds) ?? finiteSpeed(p);
    const acc = Number(p?.accuracy || 0);
    const tMs = timestampMs(p);
    const windowEnd = tMs + LANE_CHANGE_BILATERAL_WINDOW_S * 1000;
    if (tMs < suppressUntilMs) continue;
    if (speed < LANE_CHANGE_MIN_SPEED_KMH) continue;
    if (acc > LANE_CHANGE_MAX_GPS_ACCURACY_M) continue;
    if (!speedMaintainedInWindow(points, tMs, windowEnd, speed)) continue;

    const windowSamples = samplesInWindow(tMs - 500, windowEnd);

    if (imuAvailable && windowSamples.length >= 6) {
      const lateralValues = windowSamples
        .filter((sample) => sample.has_axes && finiteSampleValue(sample, lateralAxis) != null)
        .map((sample) => finiteSampleValue(sample, lateralAxis));
      const yawValues = windowSamples
        .map((sample) => finiteSampleValue(sample, 'gz_deg_s'))
        .filter((value) => value != null);

      if (lateralValues.length < 4 || yawValues.length < 4) continue;

      const peakLateral = Math.max(...lateralValues.map((value) => Math.abs(value))) / 9.80665;
      if (peakLateral < LANE_CHANGE_MIN_LATERAL_G) continue;
      if (peakLateral > LANE_CHANGE_MAX_LATERAL_G) continue;

      const firstYaw = yawValues.find((value) => Math.abs(value) > 2.0);
      if (firstYaw == null) continue;
      const firstSign = Math.sign(firstYaw);
      const hasReversal = yawValues.some((value, index) => (
        index > 1 &&
        Math.abs(value) > 2.0 &&
        Math.sign(value) !== 0 &&
        Math.sign(value) !== firstSign
      ));
      if (!hasReversal) continue;

      const pEnd = firstPointAtOrAfter(points, windowEnd);
      if (pEnd) {
        const hStart = headingValueForLaneChange(points, i);
        const hEnd = headingValueForLaneChange(points, points.indexOf(pEnd));
        if (!Number.isFinite(hStart) || !Number.isFinite(hEnd)) continue;
        const netChange = Math.abs(signedHeadingDelta(hStart, hEnd));
        if (netChange > LANE_CHANGE_MAX_NET_HEADING_DEG) continue;
      }

      const longitudinalValues = windowSamples
        .filter((sample) => sample.has_axes && finiteSampleValue(sample, longitudinalAxis) != null)
        .map((sample) => finiteSampleValue(sample, longitudinalAxis));
      const minLongitudinalMs2 = longitudinalValues.length ? Math.min(...longitudinalValues) : 0;
      const simultaneousBraking = minLongitudinalMs2 < LANE_CHANGE_NO_BRAKE_MS2_THRESHOLD;

      laneChanges.push({
        type: LANE_CHANGE_EVENT_TYPE,
        timestamp: p.timestamp,
        lat: p.lat,
        lng: p.lng,
        speed_kmh: Math.round(speed),
        lateral_g: round2(peakLateral),
        direction: lateralValues[0] > 0 ? 'right' : 'left',
        simultaneous_braking: simultaneousBraking,
        detection_method: 'imu_yaw_bilateral',
        confidence: 'high',
      });
      suppressUntilMs = windowEnd;
      continue;
    }

    const h0 = headingValueForLaneChange(points, i - 1);
    const h1 = headingValueForLaneChange(points, i);
    if (!Number.isFinite(h0) || !Number.isFinite(h1)) continue;

    const initialDelta = signedHeadingDelta(h0, h1);
    if (Math.abs(initialDelta) < LANE_CHANGE_GPS_MIN_DELTA_DEG || Math.abs(initialDelta) > LANE_CHANGE_GPS_MAX_DELTA_DEG) continue;

    let foundReversal = false;
    let peakDelta = Math.abs(initialDelta);
    for (let j = i + 1; j < points.length; j++) {
      const pj = points[j];
      const tj = timestampMs(pj);
      if ((tj - tMs) / 1000 > LANE_CHANGE_BILATERAL_WINDOW_S) break;
      const hj = headingValueForLaneChange(points, j);
      if (!Number.isFinite(hj)) continue;
      const devFromStart = signedHeadingDelta(h0, hj);
      peakDelta = Math.max(peakDelta, Math.abs(devFromStart));
      const reversed = Math.sign(devFromStart) !== Math.sign(initialDelta) || Math.abs(devFromStart) < 0.8;
      if (reversed && peakDelta <= LANE_CHANGE_GPS_MAX_DELTA_DEG && Math.abs(devFromStart) <= LANE_CHANGE_MAX_NET_HEADING_DEG) {
        foundReversal = true;
        break;
      }
    }
    if (!foundReversal) continue;

    laneChanges.push({
      type: LANE_CHANGE_EVENT_TYPE,
      timestamp: p.timestamp,
      lat: p.lat,
      lng: p.lng,
      speed_kmh: Math.round(speed),
      lateral_g: null,
      direction: initialDelta > 0 ? 'right' : 'left',
      simultaneous_braking: false,
      detection_method: 'gps_bilateral_heading',
      confidence: 'low',
    });
    suppressUntilMs = windowEnd;
  }

  return {
    lane_changes: laneChanges,
    lane_change_count: laneChanges.length,
    unsafe_lane_changes: laneChanges.filter((laneChange) => laneChange.simultaneous_braking).length,
    confidence: imuAvailable ? 'imu_calibrated' : 'gps_only',
    detection_method: imuAvailable ? 'imu_yaw_bilateral' : 'gps_bilateral_heading',
  };
}

export function calculateLaneChangingScore(laneChangeResult = {}, distKm = 0, thresholds = DEFAULT_THRESHOLDS) {
  const laneChanges = Array.isArray(laneChangeResult?.lane_changes) ? laneChangeResult.lane_changes : [];
  const count = laneChanges.length;
  const distanceKm = Math.max(0, Number(distKm) || 0);
  const unsafeLaneChanges = Math.max(0, Number(laneChangeResult?.unsafe_lane_changes) || 0);
  const confidence = laneChangeResult?.confidence || 'insufficient_data';

  if (distanceKm < 5 || count < 2) {
    return {
      lane_changing_score: null,
      lane_changing_rate_per_10km: count > 0 && distanceKm > 0 ? round1((count / distanceKm) * 10) : 0,
      lane_change_count: count,
      unsafe_lane_changes: unsafeLaneChanges,
      lane_changing_grade: 'unavailable',
      lane_changing_confidence: 'insufficient_data',
      lane_changing_confidence_multiplier: confidence === 'gps_only' ? 0.7 : 1.0,
    };
  }

  const ratePer10Km = (count / distanceKm) * 10;
  const ratePenalty = clamp(Math.round(ratePer10Km * 6), 0, 40);
  const safetyPenalty = clamp(unsafeLaneChanges * 15, 0, 40);
  const confidenceMultiplier = confidence === 'imu_calibrated' ? 1.0 : 0.7;
  const rawScore = Math.max(0, 100 - ratePenalty - safetyPenalty);
  const laneChangingScore = clamp(Math.round(rawScore), 0, 100);

  return {
    lane_changing_score: laneChangingScore,
    lane_changing_rate_per_10km: round1(ratePer10Km),
    lane_change_count: count,
    unsafe_lane_changes: unsafeLaneChanges,
    lane_changing_grade: laneChangingScore >= 85 ? 'smooth' : laneChangingScore >= 70 ? 'acceptable' : laneChangingScore >= 50 ? 'frequent' : 'erratic',
    lane_changing_confidence: confidence,
    lane_changing_confidence_multiplier: confidenceMultiplier,
  };
}

export function detectHighwayMergeBehavior(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS) {
  let mergeEventCount = 0;
  let poorMergeCount = 0;
  let harshMergeCount = 0;
  let windowStart = null;
  let windowPeakAccel = 0;
  const entrySpeedThreshold = thresholds.MERGE_ENTRY_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_ENTRY_SPEED_KMH;
  const exitSpeedThreshold = thresholds.MERGE_EXIT_SPEED_KMH ?? DEFAULT_THRESHOLDS.MERGE_EXIT_SPEED_KMH;

  for (let i = 0; i < cleanPoints.length; i++) {
    const point = cleanPoints[i];
    const speed = finiteSpeed(point);
    if (!windowStart && speed > 20 && speed < entrySpeedThreshold) {
      windowStart = point;
      windowPeakAccel = 0;
      continue;
    }

    if (!windowStart) continue;

    const duration = (timestampMs(point) - timestampMs(windowStart)) / 1000;
    if (duration <= 0) continue;
    if (duration > 20) {
      windowStart = speed > 20 && speed < entrySpeedThreshold ? point : null;
      windowPeakAccel = 0;
      continue;
    }

    const previous = cleanPoints[i - 1];
    if (previous) {
      const dt = (timestampMs(point) - timestampMs(previous)) / 1000;
      if (dt > 0 && dt <= 10) {
        windowPeakAccel = Math.max(windowPeakAccel, calculateAcceleration(finiteSpeed(previous), speed, dt));
      }
    }

    if (speed >= exitSpeedThreshold) {
      const entrySpeed = finiteSpeed(windowStart);
      const exitSpeed = speed;
      const accelMs2 = ((exitSpeed / 3.6) - (entrySpeed / 3.6)) / duration;
      const quality = exitSpeed < exitSpeedThreshold || duration < 5
        ? 'poor'
        : accelMs2 > 3.8 || windowPeakAccel > 4.5
          ? 'harsh'
          : 'good';

      mergeEventCount++;
      if (quality === 'poor') poorMergeCount++;
      if (quality === 'harsh') harshMergeCount++;
      windowStart = null;
      windowPeakAccel = 0;
    }
  }

  return {
    merge_event_count: mergeEventCount,
    poor_merge_count: poorMergeCount,
    harsh_merge_count: harshMergeCount,
    merge_score: mergeEventCount > 0
      ? Math.max(0, Math.round(
        100 - (poorMergeCount / mergeEventCount) * 40 - (harshMergeCount / mergeEventCount) * 30
      ))
      : null,
  };
}

function medianMovingSpeedKmh(points = [], minSpeedKmh = 5) {
  const speeds = points
    .map((point) => finiteSpeed(point))
    .filter((speed) => Number.isFinite(speed) && speed > minSpeedKmh)
    .sort((a, b) => a - b);
  return speeds.length ? percentileFromSorted(speeds, 50) : 0;
}

function detectStopStartPatternsForMode(cleanPoints = [], thresholds = DEFAULT_THRESHOLDS, mode = 'highway') {
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

function stddev(values = []) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function signedHeadingDelta(from, to) {
  let diff = ((to - from + 540) % 360) - 180;
  if (!Number.isFinite(diff)) diff = 0;
  return diff;
}

function headingForIndex(points, index) {
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

function usableHeadingSegment(a, b) {
  if (!hasValidCoordinates(a) || !hasValidCoordinates(b)) return false;
  const segment = calculateSegmentMetrics(a, b);
  return segment.dt > 0 && segment.dt <= 8 && !segment.isNoise && segment.distanceM >= 8;
}

function geometryHeadingForIndex(points, index) {
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

function smoothHeading(points, index) {
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

function headingVarianceForRange(points, startIndex, endIndex) {
  const headings = [];
  for (let i = Math.max(0, startIndex); i <= Math.min(points.length - 1, endIndex); i++) {
    const heading = smoothHeading(points, i);
    if (Number.isFinite(heading)) headings.push(heading);
  }
  return headingStdDev(headings);
}

function pointHasIntersectionOrRampContext(point = {}) {
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

function isNearIntersectionOrRampContext(points = [], index = 0, radiusM = 200) {
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

function emptyPhoneUseResult() {
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

function summarizePhoneUseEvents(events = [], durationSeconds = 0) {
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

const BRAKE_ONSET_SMOOTHNESS_GRADE_THRESHOLDS = {
  smooth: 85,
  controlled: 70,
  abrupt: 50,
};

function brakeOnsetSmoothnessGrade(score) {
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

function lateralGForTriplet(points, index, thresholds = DEFAULT_THRESHOLDS) {
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

function hasSustainedLateralG(points, index, thresholdG, thresholds = DEFAULT_THRESHOLDS) {
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

const BRAKING_GRADE_THRESHOLDS = {
  urban: { progressive: 80, adequate: 60, abrupt: 40 },
  highway: { progressive: 88, adequate: 70, abrupt: 55 },
};

function brakingEfficiencyGrade(score, roadType = 'urban') {
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

function complianceFallbackLimit(roadType, thresholds = DEFAULT_THRESHOLDS) {
  if (roadType === 'highway') return thresholds.SPEEDING_FALLBACK_KMH ?? DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH;
  if (roadType === 'residential') return 40;
  return 60;
}

function contextualFallbackLimitKmh(points = [], index = 0, zone = null, thresholds = DEFAULT_THRESHOLDS, roadTypes = null) {
  const roadType = roadTypes?.[index] || normalizeRoadTypeLabel(classifyRoadType(points.slice(Math.max(0, index - 15), index + 16)).road_type, points[index]);
  const roadLimit = complianceFallbackLimit(roadType, thresholds);
  if (Number.isFinite(Number(zone?.inferredZoneKmh)) && Number(zone.inferredZoneKmh) > 0) {
    return Math.min(Number(zone.inferredZoneKmh), roadLimit);
  }
  return roadLimit;
}

function speedLimitForIndex(points = [], index) {
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

function speedDefaultRegionFromSettings(settings = {}) {
  const raw = settings?.configurable_country_defaults || settings?.country_code || '';
  const [countryRaw, provinceRaw] = String(raw || '').split('-');
  const countryCode = countryRaw && countryRaw.toLowerCase() !== 'global'
    ? countryRaw.toUpperCase()
    : 'GLOBAL';
  const provinceCode = provinceRaw ? provinceRaw.toUpperCase() : null;
  return { countryCode, provinceCode };
}

export async function prefetchLocalKnowledge(points = [], knowledge = null) {
  const list = Array.isArray(points) ? points : [];
  if (!knowledge || typeof knowledge.getForPoint !== 'function') return list.map(() => null);

  const lookupByHash = new Map();
  const hashes = list.map((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const hash = geohashEncode(lat, lng, 6);
    const pointTime = timestampMs(point);
    const lookupKey = `${hash}:${Number.isFinite(pointTime) ? timeToBucket(pointTime) : 'none'}`;
    if (!lookupByHash.has(lookupKey)) {
      lookupByHash.set(lookupKey, knowledge.getForPoint(lat, lng, pointTime).catch(() => null));
    }
    return lookupKey;
  });
  const resolved = new Map();
  await Promise.all([...lookupByHash.entries()].map(async ([lookupKey, promise]) => {
    resolved.set(lookupKey, await promise);
  }));
  return hashes.map((lookupKey) => (lookupKey ? resolved.get(lookupKey) ?? null : null));
}

export function calculateTripSpeedSummary(routePoints = [], stats = {}, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const points = Array.isArray(routePoints) ? routePoints : [];
  const zones = Array.isArray(stats.speed_zones) ? stats.speed_zones : inferSpeedZones(points, thresholds);
  const zoneForIndex = createZoneLookup(zones);
  const roadTypesByPoint = options.roadTypesByPoint || classifyRoadTypesByPoint(points);
  const tierCounts = {
    POSTED: 0,
    MAP_ESTIMATED: 0,
    LEARNED_LOCAL: 0,
    REGION_DEFAULT: 0,
    GPS_INFERRED: 0,
    UNKNOWN: 0,
  };
  let confidenceTotal = 0;
  let counted = 0;
  let learnablePoints = 0;

  points.forEach((point, index) => {
    if (point?.speed_limit_source === 'openstreetmap' && Number(point?.speed_limit_kmh) > 0) learnablePoints++;
    const resolved = resolveEffectiveSpeedLimitForIndex(points, index, thresholds, {
      zoneForIndex,
      roadTypesByPoint,
      localKnowledge: options.localKnowledgeResults?.[index] ?? null,
      settings: options.settings || {},
    });
    const tierName = canonicalSpeedTier(resolved.tier || 'UNKNOWN');
    tierCounts[tierName] = (tierCounts[tierName] ?? 0) + 1;
    confidenceTotal += Number(resolved.confidence) || 0;
    counted++;
  });

  const total = Math.max(1, counted);
  const tierCoverage = Object.fromEntries(
    Object.entries(tierCounts).map(([tierName, count]) => [tierName, round2(count / total)])
  );
  const dominantTier = Object.entries(tierCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';
  const { countryCode, provinceCode } = speedDefaultRegionFromSettings(options.settings || {});
  const totalRawPenalty = Number(options.penaltyTotals?.totalRawPenalty) || 0;
  const totalWeightedPenalty = Number(options.penaltyTotals?.totalWeightedPenalty) || 0;

  return {
    tierCoverage,
    dominantTier,
    weightedConfidence: counted ? round2(confidenceTotal / counted) : 0,
    countryCode,
    provinceCode,
    learnablePoints,
    penaltyReductionFraction: round2((totalRawPenalty - totalWeightedPenalty) / Math.max(totalRawPenalty, 1)),
  };
}

export function resolveEffectiveSpeedLimitForIndex(points = [], index = 0, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const speedLimit = speedLimitForIndex(points, index);
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
  const localKnowledge = options.localKnowledge || null;
  const currentPoint = points[index] || {};
  const actualLimitKmh = speedLimit?.limitKmh ?? null;
  const actualSource = speedLimit?.source ?? null;
  let effectiveLimitKmh = actualLimitKmh;
  let source = actualSource;
  let learnedLocalConfidence = null;

  if (localKnowledge?.source === 'user_confirmed_posted_sign' && Number(localKnowledge.limitKmh) > 0) {
    effectiveLimitKmh = Number(localKnowledge.limitKmh);
    source = 'user_confirmed_posted_sign';
  } else if (actualLimitKmh != null) {
    effectiveLimitKmh = actualLimitKmh;
    source = actualSource;
  } else {
    const { countryCode, provinceCode } = speedDefaultRegionFromSettings(options.settings || {});
    const osmHighwayType = currentPoint.osmHighwayType || currentPoint.speed_limit_highway || currentPoint.highway || null;
    const roadCtx = roadContextFromOsmType(osmHighwayType)
      ?? roadTypesByPoint?.[index]
      ?? (Number.isFinite(Number(inferredZone?.inferredZoneKmh)) ? roadContextFromGpsBehaviour(Number(inferredZone.inferredZoneKmh)) : null);
    const regionalDefaultEstimate = getRegionDefaultEstimate(countryCode, provinceCode, roadCtx);
    if (regionalDefaultEstimate != null) {
      effectiveLimitKmh = countryCode === 'GLOBAL'
        ? Math.min(regionalDefaultEstimate, fallbackLimitKmh)
        : regionalDefaultEstimate;
      source = 'region_default_estimate';
    } else if (localKnowledge && Number(localKnowledge.limitKmh) > 0 && Number(localKnowledge.confidence) >= 0.55) {
      effectiveLimitKmh = Number(localKnowledge.limitKmh);
      source = localKnowledge.source === 'user_entered_estimate' || localKnowledge.source === 'user_correction'
        ? 'user_entered_estimate'
        : 'learned_local';
      learnedLocalConfidence = Number(localKnowledge.confidence);
    }
  }

  if (effectiveLimitKmh == null && Number.isFinite(inferredLimitKmh) && inferredLimitKmh > 0) {
    effectiveLimitKmh = inferredLimitKmh;
    source = 'inferred';
  }

  const tier = tierForSource(source);
  const confidence = confidenceForSource(source, learnedLocalConfidence);
  const alertMarginKmh = alertMarginForConfidence(confidence, thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH);

  return {
    actualLimitKmh,
    effectiveLimitKmh,
    limitKmh: effectiveLimitKmh,
    fallbackLimitKmh,
    inferredLimitKmh: Number.isFinite(inferredLimitKmh) && inferredLimitKmh > 0 ? inferredLimitKmh : null,
    inferredZone,
    limitSource: source,
    speedLimitSource: speedLimit?.source ?? null,
    speedLimitDefaultCountry: speedLimit?.defaultCountry ?? null,
    tier,
    confidence,
    alertMarginKmh,
    shouldAlert: (speedKmh) => (
      Number.isFinite(Number(speedKmh)) &&
      Number.isFinite(Number(effectiveLimitKmh)) &&
      Number(speedKmh) > Number(effectiveLimitKmh) + alertMarginKmh
    ),
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
export function calculateSpeedLimitCompliance(routePoints, stats = {}, thresholds = DEFAULT_THRESHOLDS, options = {}) {
  const points = routePoints || [];
  const roadTypes = classifyRoadTypesByPoint(points);
  const zones = Array.isArray(stats.speed_zones) ? stats.speed_zones : inferSpeedZones(points, thresholds);
  const byType = {
    highway: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0, confidenceTotal: 0, tierCounts: {}, totalRawPenalty: 0, totalWeightedPenalty: 0, totalPostedWeight: 0, penalizedPoints: 0 },
    urban: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0, confidenceTotal: 0, tierCounts: {}, totalRawPenalty: 0, totalWeightedPenalty: 0, totalPostedWeight: 0, penalizedPoints: 0 },
    residential: { totalPoints: 0, overLimitPoints: 0, maxSpeed: 0, limitTotal: 0, actualLimitPoints: 0, osmMaxspeedPoints: 0, osmDefaultPoints: 0, confidenceTotal: 0, tierCounts: {}, totalRawPenalty: 0, totalWeightedPenalty: 0, totalPostedWeight: 0, penalizedPoints: 0 },
  };
  const speedOver = thresholds.SPEED_OVER_KMH ?? DEFAULT_THRESHOLDS.SPEED_OVER_KMH;
  const zoneForIndex = createZoneLookup(zones);

  points.forEach((point, index) => {
    const speed = reliablePointSpeed(points, index, thresholds);
    if (!Number.isFinite(speed)) return;
    if (speed <= (thresholds.STATIONARY_SPEED_KMH ?? DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH)) return;
    const roadType = roadTypes[index] || 'urban';
    const speedLimitContext = resolveEffectiveSpeedLimitForIndex(points, index, thresholds, {
      zoneForIndex,
      roadTypesByPoint: roadTypes,
      localKnowledge: options.localKnowledgeResults?.[index] ?? null,
      settings: options.settings || {},
    });
    const limit = speedLimitContext.effectiveLimitKmh ?? complianceFallbackLimit(roadType, thresholds);
    const bucket = byType[roadType];
    bucket.totalPoints++;
    bucket.limitTotal += limit;
    bucket.confidenceTotal += Number(speedLimitContext.confidence) || 0;
    const bucketTier = canonicalSpeedTier(speedLimitContext.tier || 'UNKNOWN');
    bucket.tierCounts[bucketTier] = (bucket.tierCounts[bucketTier] || 0) + 1;
    if (speedLimitContext.actualLimitKmh != null) {
      bucket.actualLimitPoints++;
      if (speedLimitContext.limitSource === 'openstreetmap') bucket.osmMaxspeedPoints++;
      if (speedLimitContext.limitSource === 'osm_highway_default') bucket.osmDefaultPoints++;
    }
    bucket.maxSpeed = Math.max(bucket.maxSpeed, speed);
    if (speed > limit + speedOver) {
      const rawPenalty = Math.min(100, Math.max(0, (speed - (limit + speedOver)) * 2));
      const penaltyWeight = confidenceToPenaltyWeight(speedLimitContext.confidence);
      bucket.overLimitPoints++;
      bucket.penalizedPoints++;
      bucket.totalRawPenalty += rawPenalty;
      bucket.totalWeightedPenalty += rawPenalty * penaltyWeight;
      bucket.totalPostedWeight += penaltyWeight;
    }
  });

  const build = (bucket) => {
    if (!bucket.totalPoints) return null;
    const inferredLimit = Math.round(bucket.limitTotal / bucket.totalPoints);
    const rate = 1 - bucket.overLimitPoints / bucket.totalPoints;
    const maxExcessKmh = Math.max(0, bucket.maxSpeed - inferredLimit);
    const dominantTier = Object.entries(bucket.tierCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'UNKNOWN';
    const limitSource = {
      POSTED: 'posted',
      MAP_ESTIMATED: 'osm_highway_default',
      LEARNED_LOCAL: 'learned_local',
      REGION_DEFAULT: 'region_default_estimate',
      GPS_INFERRED: 'inferred',
      UNKNOWN: 'unknown',
    }[canonicalSpeedTier(dominantTier)] || 'unknown';
    const averageConfidence = bucket.confidenceTotal / bucket.totalPoints;
    const rawScore = bucket.penalizedPoints
      ? clamp(Math.round(100 - (bucket.totalRawPenalty / bucket.penalizedPoints)), 0, 100)
      : 100;
    const score = bucket.totalPostedWeight > 0
      ? clamp(Math.round(100 - (bucket.totalWeightedPenalty / bucket.totalPostedWeight)), 0, 100)
      : 100;
    const penaltyWeight = bucket.totalRawPenalty > 0
      ? bucket.totalWeightedPenalty / bucket.totalRawPenalty
      : confidenceToPenaltyWeight(averageConfidence);
    return {
      score,
      raw_score: rawScore,
      penalty_weight: round2(penaltyWeight),
      total_raw_penalty: round2(bucket.totalRawPenalty),
      total_weighted_penalty: round2(bucket.totalWeightedPenalty),
      total_posted_weight: round2(bucket.totalPostedWeight),
      confidence: round2(averageConfidence),
      rate: round2(rate),
      max_excess_kmh: round1(maxExcessKmh),
      inferred_limit_kmh: inferredLimit,
      limit_source: limitSource,
      dominant_tier: dominantTier,
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
    speed_penalty_totals: {
      totalRawPenalty: round2(weighted.reduce((sum, item) => sum + (Number(item.total_raw_penalty) || 0), 0)),
      totalWeightedPenalty: round2(weighted.reduce((sum, item) => sum + (Number(item.total_weighted_penalty) || 0), 0)),
      totalPostedWeight: round2(weighted.reduce((sum, item) => sum + (Number(item.total_posted_weight) || 0), 0)),
    },
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
    const segmentScores = calculateTripScores(segmentEvents, segmentStats, slice, thresholds, segmentStats.duration_seconds, segmentPhoneUse, {
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

function calculateSegmentStats(points = [], thresholds = DEFAULT_THRESHOLDS) {
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

function scoreFatigueSegment(points = [], thresholds = DEFAULT_THRESHOLDS) {
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
      const startHour = new Date(startMs).getHours();
      const circadianMultiplier = startHour >= 2 && startHour < 5 ? HEADING_DRIFT_CIRCADIAN_MULTIPLIER : 1;
      weightedScore += (1 + elapsedFraction) * circadianMultiplier;
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

function attachEventResult(events = [], phoneUse = emptyPhoneUseResult()) {
  const safeEvents = Array.isArray(events) ? events : [];
  const safePhoneUse = phoneUse && typeof phoneUse === 'object' && !Array.isArray(phoneUse)
    ? phoneUse
    : emptyPhoneUseResult();
  return { events: safeEvents, phoneUse: safePhoneUse };
}

function maskDetectedEventsForPrivacy(events = [], privacyZones = []) {
  return privacyZones?.length
    ? events.map((event) => maskEventCoordinatesForPrivacy(event, privacyZones))
    : events;
}

export function detectDrivingEvents(points, thresholds = DEFAULT_THRESHOLDS, endTime = null, privacyZones = [], options = {}) {
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
      localKnowledge: options.localKnowledgeResults?.[i] ?? null,
      settings: options.settings || {},
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

export function calculateFatigueScore(durationSeconds, routePoints = []) {
  const durationMinutes = (durationSeconds || 0) / 60;
  const durationScore = Math.min(5, durationMinutes / 30);
  const points = Array.isArray(routePoints) ? routePoints : [];

  let timeScore = 0;
  if (points.length > 0) {
    const startHour = new Date(points[0].timestamp).getHours();
    if (startHour >= 2 && startHour < 5) timeScore = 5;
    else if (startHour >= 5 && startHour < 7) timeScore = 3;
    else if (startHour >= 13 && startHour < 15) timeScore = 2;
    else if (startHour >= 22 || startHour < 2) timeScore = 3;
    // FIX: Raise the 10pm-2am fatigue bucket to the elevated late-night risk tier.
  }

  const movingSpeeds = points
    .map((point) => Number(point?.speed_kmh))
    .filter((speed) => Number.isFinite(speed) && speed >= 15);
  const meanSpeed = movingSpeeds.length
    ? movingSpeeds.reduce((sum, speed) => sum + speed, 0) / movingSpeeds.length
    : 0;
  const speedCv = movingSpeeds.length >= 5 && meanSpeed > 0
    ? speedStdDev(movingSpeeds) / meanSpeed
    : 0;
  const speedVarianceScore = speedCv >= 0.70 ? 2 : speedCv >= 0.45 ? 1 : 0;

  const riskOnTenPointScale = Math.min(10, durationScore + timeScore + speedVarianceScore);
  return Math.round(riskOnTenPointScale * 10);
}

function parseClockMinutes(value, fallbackHour) {
  if (typeof value === 'string') {
    const [hour, minute = '0'] = value.split(':');
    const h = Number(hour);
    const m = Number(minute);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
  }
  return fallbackHour * 60;
}

function isWithinClockWindow(minutes, startMinutes, endMinutes) {
  const dayMinutes = 24 * 60;
  const normalized = ((minutes % dayMinutes) + dayMinutes) % dayMinutes;
  const start = ((startMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  const end = ((endMinutes % dayMinutes) + dayMinutes) % dayMinutes;
  if (start === end) return false;
  return start < end
    ? normalized >= start && normalized < end
    : normalized >= start || normalized < end;
}

function localDateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayOfYear(date) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const current = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((current - start) / 86400000);
}

function sunEventMinutes(date, lat, lng, isSunrise) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 89.8) return null;

  const zenith = 90.833;
  const n = dayOfYear(date);
  const lngHour = lng / 15;
  const t = n + (((isSunrise ? 6 : 18) - lngHour) / 24);
  const meanAnomaly = (0.9856 * t) - 3.289;
  let trueLongitude = meanAnomaly
    + (1.916 * Math.sin(toRad(meanAnomaly)))
    + (0.020 * Math.sin(toRad(2 * meanAnomaly)))
    + 282.634;
  trueLongitude = ((trueLongitude % 360) + 360) % 360;

  let rightAscension = Math.atan(0.91764 * Math.tan(toRad(trueLongitude))) * 180 / Math.PI;
  rightAscension = ((rightAscension % 360) + 360) % 360;
  const longitudeQuadrant = Math.floor(trueLongitude / 90) * 90;
  const ascensionQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15;

  const sinDec = 0.39782 * Math.sin(toRad(trueLongitude));
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosHour = (Math.cos(toRad(zenith)) - (sinDec * Math.sin(toRad(lat)))) / (cosDec * Math.cos(toRad(lat)));
  if (cosHour > 1 || cosHour < -1) return null;

  const hourAngle = isSunrise
    ? 360 - (Math.acos(cosHour) * 180 / Math.PI)
    : Math.acos(cosHour) * 180 / Math.PI;
  const localMeanTime = (hourAngle / 15) + rightAscension - (0.06571 * t) - 6.622;
  const utcMinutes = ((localMeanTime - lngHour) * 60) % (24 * 60);
  return ((utcMinutes - date.getTimezoneOffset()) % (24 * 60) + (24 * 60)) % (24 * 60);
}

function createTripNightChecker(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const fallbackStart = parseClockMinutes(
    thresholds.NIGHT_START_TIME,
    thresholds.NIGHT_START_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_START_HOUR
  );
  const fallbackEnd = parseClockMinutes(
    thresholds.NIGHT_END_TIME,
    thresholds.NIGHT_END_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_END_HOUR
  );

  if (thresholds.NIGHT_DETECTION_MODE !== 'sunset') {
    return (point) => {
      if (!point?.timestamp) return false;
      const date = new Date(point.timestamp);
      if (Number.isNaN(date.getTime())) return false;
      return isWithinClockWindow(date.getHours() * 60 + date.getMinutes(), fallbackStart, fallbackEnd);
    };
  }

  const representativeCoordinatesByDate = new Map();
  for (const point of routePoints || []) {
    if (!point?.timestamp || !hasValidCoordinates(point)) continue;
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const key = localDateKey(date);
    if (!representativeCoordinatesByDate.has(key)) {
      representativeCoordinatesByDate.set(key, { lat: Number(point.lat), lng: Number(point.lng) });
    }
  }

  const sunWindowByDate = new Map();
  return (point) => {
    if (!point?.timestamp) return false;
    const date = new Date(point.timestamp);
    if (Number.isNaN(date.getTime())) return false;

    const minutes = date.getHours() * 60 + date.getMinutes();
    const key = localDateKey(date);
    if (!sunWindowByDate.has(key)) {
      const coords = representativeCoordinatesByDate.get(key) || { lat: Number(point.lat), lng: Number(point.lng) };
      const sunset = sunEventMinutes(date, coords.lat, coords.lng, false);
      const sunrise = sunEventMinutes(date, coords.lat, coords.lng, true);
      sunWindowByDate.set(key, sunset != null && sunrise != null
        ? {
          start: sunset + (thresholds.NIGHT_SUNSET_OFFSET_MINUTES ?? 0),
          end: sunrise + (thresholds.NIGHT_SUNRISE_OFFSET_MINUTES ?? 0),
        }
        : null);
    }

    const sunWindow = sunWindowByDate.get(key);
    return sunWindow
      ? isWithinClockWindow(minutes, sunWindow.start, sunWindow.end)
      : isWithinClockWindow(minutes, fallbackStart, fallbackEnd);
  };
}

export function isNightDrivingTime(point, thresholds = DEFAULT_THRESHOLDS) {
  if (!point?.timestamp) return false;

  const date = new Date(point.timestamp);
  if (Number.isNaN(date.getTime())) return false;

  const minutes = date.getHours() * 60 + date.getMinutes();
  if (thresholds.NIGHT_DETECTION_MODE === 'sunset') {
    const sunset = sunEventMinutes(date, Number(point.lat), Number(point.lng), false);
    const sunrise = sunEventMinutes(date, Number(point.lat), Number(point.lng), true);
    if (sunset != null && sunrise != null) {
      return isWithinClockWindow(
        minutes,
        sunset + (thresholds.NIGHT_SUNSET_OFFSET_MINUTES ?? 0),
        sunrise + (thresholds.NIGHT_SUNRISE_OFFSET_MINUTES ?? 0)
      );
    }
  }

  return isWithinClockWindow(
    minutes,
    parseClockMinutes(thresholds.NIGHT_START_TIME, thresholds.NIGHT_START_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_START_HOUR),
    parseClockMinutes(thresholds.NIGHT_END_TIME, thresholds.NIGHT_END_HOUR ?? DEFAULT_THRESHOLDS.NIGHT_END_HOUR)
  );
}

export function calculateNightPenalty(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  if (!routePoints || routePoints.length === 0) return 0;

  const isNightForTrip = createTripNightChecker(routePoints, thresholds);
  let nightPoints = 0;
  let deepNightPoints = 0;
  for (const point of routePoints) {
    const hour = new Date(point.timestamp).getHours();
    if (isNightForTrip(point)) nightPoints++;
    if (hour >= 2 && hour < 5) deepNightPoints++;
  }

  const n = routePoints.length;
  const normalNightPoints = nightPoints - deepNightPoints;
  // FIX: Deep-night points are a subset of night points, so separate them before weighting.
  return (normalNightPoints / n) * 8 + (deepNightPoints / n) * 12;
  // FIX: Give deep-night points an exclusive higher weight instead of double-counting them.
}

// ─── Trip Statistics ───────────────────────────────────────────────────────────
/**
 * @param {object} context
 * @returns {number[]}
 */
function permissionLossEventTimesMs(context = {}) {
  const timeline = Array.isArray(context?.native_tracking_timeline)
    ? context.native_tracking_timeline
    : Array.isArray(context?.timeline)
      ? context.timeline
      : [];
  return timeline
    .filter((event) => event?.type === 'location_permission_lost')
    .map((event) => timestampMs(event))
    .filter(Number.isFinite);
}

function gapContainsPermissionLoss(startPoint, endPoint, permissionLossTimes = []) {
  if (!permissionLossTimes.length) return false;
  const startMs = timestampMs(startPoint);
  const endMs = timestampMs(endPoint);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return permissionLossTimes.some((eventMs) => eventMs >= startMs && eventMs <= endMs);
}

function intersectionScoringPoints(points = [], context = {}) {
  const candidates = [
    context?.intersection_scoring_points,
    context?.raw_route_points,
    context?.rawPoints,
    context?.route_points_raw,
  ];
  return candidates.find((candidate) => Array.isArray(candidate) && candidate.length) || points || [];
}

function sanitizePrivateIntersectionStats(stats = {}, removeCoordinates = false) {
  if (!removeCoordinates || !Array.isArray(stats.intersection_events)) return stats;
  return {
    ...stats,
    intersection_events: stats.intersection_events.map(({ lat, lng, ...event }) => ({
      ...event,
      coordinates_private: true,
    })),
  };
}

export function calculateTripStats(points, startTime, endTime, thresholds = DEFAULT_THRESHOLDS, context = {}) {
  const routePoints = (points || []).filter(hasValidCoordinates);
  const intersectionPoints = intersectionScoringPoints(points, context);
  const intersectionUsesAlternatePoints = intersectionPoints !== points;
  const intersectionStats = sanitizePrivateIntersectionStats(
    analyzeIntersectionBehavior(intersectionPoints, thresholds),
    intersectionUsesAlternatePoints
  );
  const estimatedPrivateDistanceKm = calculateEstimatedPrivateDistanceKm(points || []);
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const wallClockDurationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);
  const permissionLossTimes = permissionLossEventTimesMs(context);

  if (!routePoints || routePoints.length < 2) {
    const roadStats = classifyRoadType(routePoints || []);
    return {
      distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
      estimated_private_distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
      avg_speed_kmh: 0,
      avg_running_speed_kmh: 0,
      max_speed_kmh: 0,
      idle_time_seconds: 0,
      traffic_idle_seconds: 0,
      // FIX: Return explicit traffic idle even for short/empty trips so stats stay shape-compatible.
      sustained_idle_seconds: 0,
      // FIX: Return explicit sustained idle for eco scoring fallback compatibility.
      gap_seconds: 0,
      // FIX: Expose noise-filtered gap time without mixing it into moving or idle totals.
      wall_clock_duration_seconds: Math.round(wallClockDurationSeconds),
      duration_seconds: Math.round(wallClockDurationSeconds),
      night_driving: false,
      fatigue_risk_score: calculateFatigueScore(wallClockDurationSeconds, routePoints || []),
      fatigue_risk_score_confidence: CONFIDENCE_LEVELS.UNAVAILABLE,
      ...roadStats,
      ...intersectionStats,
      fatigue_progression: 'unknown',
      segment_scores: [],
      speed_zones: [],
      climb_distance_km: null,
      descent_distance_km: null,
      hill_infraction_count: 0,
      hill_driving_score: null,
      hill_route: false,
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
      parking_approach_score: null,
      parking_approach_grade: 'insufficient_data',
      parking_stop_detected: false,
      parking_stop_duration_seconds: 0,
    };
  }

  let totalDistance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  let trafficIdleSeconds = 0;
  // FIX: Track short sub-5 km/h traffic stops separately from avoidable parked idle.
  let sustainedIdleSeconds = 0;
  // FIX: Track sustained sub-5 km/h idle for eco scoring instead of penalizing all idle.
  let gapSeconds = 0;
  // FIX: Track noise-filtered time excluded from moving and idle buckets.
  let permissionLossGapDetected = false;
  let idleRunStart = null;
  let idleRunDuration = 0;

  const flushIdleRun = () => {
    if (idleRunDuration <= 0) return;
    const parkedIdleSeconds = Math.max(300, thresholds.IDLE_EVENT_SECONDS ?? DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS);
    if (idleRunDuration >= parkedIdleSeconds) {
      sustainedIdleSeconds += idleRunDuration;
    } else {
      trafficIdleSeconds += idleRunDuration;
    }
    idleRunStart = null;
    idleRunDuration = 0;
  };
  // FIX: Classify each contiguous sub-5 km/h run once it ends or the trip ends.

  for (let i = 1; i < routePoints.length; i++) {
    const p = routePoints[i - 1];
    const c = routePoints[i];
    const segment = calculateSegmentMetrics(p, c, thresholds);
    if (segment.dt <= 0) {
      flushIdleRun();
      continue;
    }
    if (segment.dt > 60 && gapContainsPermissionLoss(p, c, permissionLossTimes)) {
      permissionLossGapDetected = true;
    }
    if (segment.dt > 120) {
      const privateBoundarySegment = isPrivacyBoundaryPoint(p) &&
        isPrivacyBoundaryPoint(c) &&
        samePrivacyZoneBoundary(p, c);
      if (!privateBoundarySegment) {
        gapSeconds += segment.dt;
        flushIdleRun();
        continue;
      }
    }
    if (segment.isNoise) {
      flushIdleRun();
      continue;
    }
    if (segment.impliedSpeedKmh > MAX_REASONABLE_GPS_SPEED_KMH) {
      flushIdleRun();
      continue;
    }

    totalDistance += segment.distanceKm;
    const currPointSpeed = reliablePointSpeed(routePoints, i, thresholds);
    const currRawSpeed = pointSpeedKmh(routePoints[i], thresholds);
    const spd = currPointSpeed == null
      ? (currRawSpeed == null ? segment.reliableSpeedKmh : segment.impliedSpeedKmh)
      : Math.max(currPointSpeed, segment.reliableSpeedKmh);
    if (spd > maxSpeed) maxSpeed = spd;
    if (spd >= thresholds.STATIONARY_SPEED_KMH) {
      movingSeconds += segment.dt;
      flushIdleRun();
    }

    if (spd < thresholds.IDLE_SPEED_KMH) {
      if (!idleRunStart) idleRunStart = p.timestamp;
      idleRunDuration += segment.dt;
    }
  }

  const terminalStoppedSeconds = calculateTerminalStoppedSeconds(routePoints, endTime, thresholds);
  if (terminalStoppedSeconds > 0) {
    if (!idleRunStart) idleRunStart = routePoints[routePoints.length - 1].timestamp;
    idleRunDuration += terminalStoppedSeconds;
  }

  flushIdleRun();

  totalDistance = Math.max(totalDistance, calculateRouteDistanceKm(points || [], thresholds));
  const idleTime = trafficIdleSeconds + sustainedIdleSeconds;
  // FIX: Keep legacy idle_time_seconds as the sum of traffic and sustained idle buckets.
  const effectiveMovingSeconds = movingSeconds;
  const durationSeconds = Math.max(0, wallClockDurationSeconds - gapSeconds);
  // Exclude background/noise-filtered tracking gaps from driving time and duration-based scoring.
  const dataGapDetected = permissionLossGapDetected && gapSeconds > 60;
  const isNightForTrip = createTripNightChecker(routePoints, thresholds);
  const nightDriving = routePoints.some(p => isNightForTrip(p));
  const avgSpeed = durationSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, durationSeconds)
    : 0;
  const avgRunningSpeed = effectiveMovingSeconds > 0 && totalDistance > 0
    ? calculateSpeedKmh(totalDistance, effectiveMovingSeconds)
    : 0;
  const roadStats = classifyRoadType(routePoints);
  const speedZones = inferSpeedZones(routePoints, thresholds);
  const fatigueProgression = durationSeconds > 1800
    ? analyzeFatigueProgression(routePoints, start.getTime(), end.getTime(), thresholds)
    : { fatigue_progression: 'unknown', segment_scores: [] };
  const hillStats = calculateHillDrivingScore(routePoints, thresholds);
  const headingDriftStats = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED === false
    ? {
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
    }
    : detectHeadingDriftBeta(routePoints, durationSeconds, thresholds);
  const parkingStats = analyzeParkingApproach(routePoints, thresholds, endTime);

  return {
    distance_km: Math.round(totalDistance * 1000) / 1000,
    estimated_private_distance_km: Math.round(estimatedPrivateDistanceKm * 1000) / 1000,
    avg_speed_kmh: Math.round(avgSpeed * 10) / 10,
    avg_running_speed_kmh: Math.round(avgRunningSpeed * 10) / 10,
    max_speed_kmh: Math.round(maxSpeed * 10) / 10,
    idle_time_seconds: Math.round(idleTime),
    traffic_idle_seconds: Math.round(trafficIdleSeconds),
    // FIX: Return sub-90-second traffic idle separately for reporting/debugging.
    sustained_idle_seconds: Math.round(sustainedIdleSeconds),
    // Tracking gaps longer than two minutes are excluded from effective drive time.
    gap_seconds: Math.round(gapSeconds),
    wall_clock_duration_seconds: Math.round(wallClockDurationSeconds),
    duration_seconds: Math.round(durationSeconds),
    ...(dataGapDetected ? { score_confidence_flag: 'data_gap_detected' } : {}),
    night_driving: nightDriving,
    fatigue_risk_score: calculateFatigueScore(durationSeconds, routePoints),
    fatigue_risk_score_confidence: componentConfidence(
      totalDistance,
      METRIC_REGISTRY.fatigue_risk_score.minDistanceKm,
      routePoints.length,
      METRIC_REGISTRY.fatigue_risk_score.minSamples
    ),
    ...roadStats,
    speed_zones: speedZones,
    ...intersectionStats,
    ...fatigueProgression,
    ...hillStats,
    ...headingDriftStats,
    ...parkingStats,
  };
}

// ─── Scoring Engine ────────────────────────────────────────────────────────────
/**
 * Calculate trip scores from events and statistics.
 *
 * Scoring methodology:
 * - Start with 100 points
 * - Deduct for each risky event (severity-weighted)
 * - Apply bonuses for clean driving
 * - Sub-scores: Safety, Smoothness, Eco
 * - Overall = weighted average of sub-scores
 *
 * Safety (40%):    based on harsh brakes, speeding, sharp turns
 * Smoothness (35%): based on rapid accel, harsh brakes, turn smoothness
 * Eco (25%):        based on speeding, rapid accel, idle time
 *
 * @param {Array} events - Detected driving events
 * @param {Object} stats - Trip statistics (distance, duration, etc.)
 * @returns {Object} { overall, safety, smoothness, eco }
 */
export function calculateEngineStressScore(events = [], stats = {}, routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const basePenalty = { low: 2, medium: 5, high: 10 };
  const speedMultiplier = (speedKmh) => (
    speedKmh >= 100 ? 3.0 : speedKmh >= 70 ? 2.0 : speedKmh >= 40 ? 1.3 : 1.0
  );
  let engineStressRaw = 0;
  let highSpeedAccelCount = 0;
  const obdEco = calculateObdEcoSignals(routePoints, thresholds);

  for (const event of events) {
    if (event.type !== EVENT_TYPES.RAPID_ACCELERATION) continue;
    const speed = Number(event.speed_kmh) || 0;
    engineStressRaw += (basePenalty[event.severity] || 0) * speedMultiplier(speed);
    if (speed >= 70) highSpeedAccelCount++;
  }
  engineStressRaw += (obdEco.obd_over_rev_count || 0) * 3;
  engineStressRaw += (obdEco.obd_high_throttle_count || 0) * 2;

  const distFactor = Math.max(1, stats.distance_km || 1);
  const score = Math.max(0, Math.round(100 - Math.min(engineStressRaw * (5 / distFactor), 100)));
  return {
    engine_stress_score: score,
    engine_stress_grade: score >= 90 ? 'low stress' : score >= 70 ? 'moderate' : score >= 50 ? 'high' : 'critical',
    high_speed_accel_count: highSpeedAccelCount,
  };
}

export function calculateTireWearUnits(events = []) {
  const severityBase = { low: 1, medium: 2.5, high: 5 };
  let units = 0;
  let missingSpeedEventCount = 0;
  const speedFactor = (event, referenceSpeed) => {
    const speed = Number(event.speed_kmh);
    if (event.speed_kmh == null || event.speed_kmh === '' || !Number.isFinite(speed) || speed < 0) {
      missingSpeedEventCount++;
      return 1;
    }
    return (speed / referenceSpeed) ** 2;
  };
  for (const event of events) {
    if (event.type === EVENT_TYPES.HARSH_BRAKE) {
      units += (severityBase[event.severity] || 0) * speedFactor(event, TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH);
    }
    if (event.type === EVENT_TYPES.SHARP_TURN) {
      units += (severityBase[event.severity] || 0) * speedFactor(event, TIRE_WEAR_DEFAULT_SPEED_TURN_KMH);
    }
  }
  return {
    trip_tire_wear_units: round1(units),
    trip_tire_wear_has_missing_speed_data: missingSpeedEventCount > 0,
    trip_tire_wear_missing_speed_event_count: missingSpeedEventCount,
  };
}

export function calculateAggressiveDrivingScore(events = [], stats = {}) {
  const aggressiveEventTypes = new Set([
    EVENT_TYPES.HARSH_BRAKE,
    EVENT_TYPES.RAPID_ACCELERATION,
    EVENT_TYPES.SHARP_TURN,
    EVENT_TYPES.SPEEDING,
  ]);
  const rawPenalty = events.reduce((sum, event) => (
    aggressiveEventTypes.has(event.type)
      ? sum + (EVENT_PENALTIES[event.type]?.[event.severity] || 0)
      : sum
  ), 0);
  const avgJerkMs3 = stats.avg_jerk_ms3 ?? 0;
  const jerkPenalty = Math.min(Math.max((avgJerkMs3 - 0.3) * 20, 0), 25);
  const combinedPenalty = rawPenalty + jerkPenalty;
  const distFactor = Math.max(1, stats.distance_km || 1);
  const normalizedPenalty = Math.min(combinedPenalty * (5 / distFactor), 100);
  const score = Math.max(0, Math.round(100 - normalizedPenalty));
  return {
    aggressive_driving_score: score,
    aggressive_grade: score >= 90 ? 'calm' : score >= 75 ? 'moderate' : score >= 55 ? 'assertive' : 'aggressive',
    aggression_penalty_raw: rawPenalty,
  };
}

export function calculateDefensiveDrivingScore(scores = {}) {
  const blend = scoringValue('DEFENSIVE_SCORE_BLEND_WEIGHTS');
  const stopStartSampleCount = Number(
    scores.stop_start_pattern_sample_count ?? scores.stop_start_pattern_count ?? 0
  );
  const urbanStopStartCount = Number(scores.stop_start_pattern_urban_count ?? 0);
  const highwayStopStartCount = Number(scores.stop_start_pattern_highway_count ?? 0);
  const hasContextualStopStartEvidence =
    urbanStopStartCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN ||
    highwayStopStartCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY;
  const hasLegacyStopStartEvidence =
    urbanStopStartCount === 0 &&
    highwayStopStartCount === 0 &&
    stopStartSampleCount >= STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT;
  const stopStartPatternScoreForBlend = hasContextualStopStartEvidence || hasLegacyStopStartEvidence
    ? scores.stop_start_pattern_score
    : null;
  const defensiveScore = weightedBlend([
    { score: (scores.total_stops_detected || 0) > 0 ? scores.smooth_braking_ratio : null, weight: blend.smoothBraking },
    { score: scores.intersection_score, weight: blend.intersection },
    { score: scores.svi_score, weight: blend.speedVariability },
    { score: stopStartPatternScoreForBlend, weight: blend.stopStart },
  ]);
  return {
    defensive_driving_score: defensiveScore,
    defensive_grade: defensiveScore == null ? 'unavailable' : defensiveScore >= 90 ? 'exemplary' : defensiveScore >= 75 ? 'defensive' : defensiveScore >= 55 ? 'average' : 'reactive',
  };
}

function stopStartScoreForContext(patternCount, distanceKm, minDistanceKm) {
  if (distanceKm < minDistanceKm) return null;
  const maxObservedPatternCycles = (distanceKm / STOP_START_NORMALISATION_WINDOW_KM) * STOP_START_MAX_CYCLES_PER_5_KM;
  return Math.round(100 - clamp((patternCount / Math.max(1, maxObservedPatternCycles)) * 100, 0, 100));
}

function highwayEvidenceDistanceKm(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  return stopStartEvidenceDistances(routePoints, thresholds).highwayDistanceKm;
}

function stopStartEvidenceDistances(routePoints = [], thresholds = DEFAULT_THRESHOLDS) {
  const points = routePoints || [];
  if (points.length < 2) {
    return {
      highwayDistanceKm: 0,
      urbanDistanceKm: 0,
      medianMovingSpeedKmh: 0,
    };
  }
  const roadTypes = classifyRoadTypesByPoint(points);
  let highwayDistanceKm = 0;
  let urbanDistanceKm = 0;
  for (let i = 1; i < points.length; i++) {
    const segment = calculateSegmentMetrics(points[i - 1], points[i], thresholds);
    if (segment.dt <= 0 || segment.isNoise) continue;
    const distanceKm = segment.distanceM / 1000;
    if (roadTypes[i] === 'highway' || roadTypes[i - 1] === 'highway') {
      highwayDistanceKm += distanceKm;
    } else {
      urbanDistanceKm += distanceKm;
    }
  }
  return {
    highwayDistanceKm,
    urbanDistanceKm,
    medianMovingSpeedKmh: medianMovingSpeedKmh(points),
  };
}

export function calculateTripScores(
  events,
  stats,
  routePoints = [],
  thresholds = DEFAULT_THRESHOLDS,
  durationSeconds = stats?.duration_seconds || 0,
  phoneUseOrOptions = {},
  maybeOptions = {}
) {
  const phoneUseFromEvents = events?.phoneUse || {};
  const options = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseOrOptions
    : maybeOptions;
  const privacyZones = Array.isArray(options?.privacyZones) ? options.privacyZones : [];
  const motionSamples = Array.isArray(options?.motionSamples) ? options.motionSamples : [];
  const orientationCalibration = options?.orientationCalibration || options?.phoneOrientation || null;
  const eventsListRaw = Array.isArray(events) ? events : events?.events || [];
  const eventsList = privacyZones.length
    ? eventsListRaw.map((event) => maskEventCoordinatesForPrivacy(event, privacyZones))
    : eventsListRaw;
  const serializableEventList = eventsList.filter((event) => event?.masked_for_privacy !== true);
  const advancedSafetyEnabled = thresholds.ADVANCED_SAFETY_DETECTION_ENABLED !== false;
  const diagnosticScoringOptions = { advancedSafetyEnabled };
  const scoringEvents = serializableEventList.filter((event) => !isDiagnosticOnlyScoringEvent(event, diagnosticScoringOptions));
  if (scoringEvents.some((event) => isDiagnosticOnlyScoringEvent(event, diagnosticScoringOptions))) {
    throw new Error('Diagnostic-only driving events must not be included in score penalties.');
  }
  const serializableEvents = serializableEventList
    .filter((event) => !(event?.type === EVENT_TYPES.PHONE_USE && (event.source === 'gps_proxy' || event.diagnostic_only === true)))
    .map((event) => ({ ...event }));
  const phoneUse = phoneUseOrOptions?.includeRoadTypeSegments != null
    ? phoneUseFromEvents
    : { ...phoneUseFromEvents, ...(phoneUseOrOptions || {}) };
  // Count events
  const counts = {
    [EVENT_TYPES.HARSH_BRAKE]: 0,
    [EVENT_TYPES.RAPID_ACCELERATION]: 0,
    [EVENT_TYPES.SHARP_TURN]: 0,
    [EVENT_TYPES.SPEEDING]: 0,
    [EVENT_TYPES.IDLE]: 0,
    [EVENT_TYPES.HEADING_DEVIATION]: 0,
    [EVENT_TYPES.HEADING_DEVIATION_LEGACY]: 0,
    [EVENT_TYPES.STOP_START_PATTERN]: 0,
    [EVENT_TYPES.TAILGATE_CYCLE]: 0,
    [EVENT_TYPES.ERRATIC_SPEED]: 0,
    [EVENT_TYPES.NEAR_MISS]: 0,
    [EVENT_TYPES.CLOSE_PROXIMITY]: 0,
    [EVENT_TYPES.AGGRESSIVE_OVERTAKE]: 0,
    [EVENT_TYPES.PHONE_USE]: 0,
  };
  let safetyPenalty = 0;
  let smoothnessPenalty = 0;
  let ecoPenalty = 0;
  let distractionPenalty = 0;

  for (const evt of serializableEventList) {
    if (counts[evt.type] !== undefined) counts[evt.type]++;
  }

  for (const evt of scoringEvents) {
    let p = EVENT_PENALTIES[evt.type]?.[evt.severity] ?? 0;
    if (
      [EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.SHARP_TURN].includes(evt.type) &&
      evt.speed_kmh != null
    ) {
      const speedFactor = 1 + Math.max(0, Math.min(1.5, (evt.speed_kmh - 30) / 60));
      p *= speedFactor;
    }
    if (evt.type === EVENT_TYPES.SPEEDING) {
      p *= confidenceToPenaltyWeight(confidenceForSource(evt.speed_limit_source || evt.limitSource || 'inferred'));
    }
    // Safety uses scored driving evidence only; GPS-only advisory patterns stay diagnostic.
    if ([
      EVENT_TYPES.HARSH_BRAKE,
      EVENT_TYPES.SPEEDING,
      EVENT_TYPES.SHARP_TURN,
      EVENT_TYPES.ERRATIC_SPEED,
      EVENT_TYPES.PHONE_USE,
    ].includes(evt.type)) safetyPenalty += p;
    // Smoothness: deducts from harsh_brake, rapid_acceleration, sharp_turn
    if ([EVENT_TYPES.HARSH_BRAKE, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.SHARP_TURN].includes(evt.type)) smoothnessPenalty += p;
    // Eco: deducts from speeding, rapid_acceleration, idle
    if ([EVENT_TYPES.SPEEDING, EVENT_TYPES.RAPID_ACCELERATION, EVENT_TYPES.IDLE].includes(evt.type)) ecoPenalty += p;
    if ([EVENT_TYPES.ERRATIC_SPEED, EVENT_TYPES.PHONE_USE].includes(evt.type)) distractionPenalty += p;
  }

  const speedCreep = advancedSafetyEnabled
    ? detectSpeedCreepWithThresholds(routePoints, thresholds)
    : {
      speed_creep_event_count: 0,
      max_speed_creep_kmh: 0,
      speed_creep_score: null,
      speed_creep_severity_counts: { low: 0, medium: 0, high: 0 },
    };
  const phoneUseResult = {
    ...emptyPhoneUseResult(),
    ...(advancedSafetyEnabled ? phoneUse : {}),
  };
  const confirmedPhoneScoreAvailable = (
    phoneUseResult.phone_use_score_available !== false &&
    Number.isFinite(Number(phoneUseResult.phone_use_score))
  );
  const diagnosticOvertakeCount = serializableEventList.filter((event) => event.type === EVENT_TYPES.AGGRESSIVE_OVERTAKE).length;
  const proxyEvents = phoneUseResult.phone_proxy_events || (
    confirmedPhoneScoreAvailable
      ? []
      : phoneUseResult.phone_use_events || []
  );
  const phoneProxy = {
    phone_proxy_count: phoneUseResult.phone_proxy_count ?? proxyEvents.length,
    phone_proxy_risk: phoneUseResult.phone_proxy_risk || 'none',
  };
  const speedCreepPenalties = scoringValue('SPEED_CREEP_ECO_PENALTY_POINTS');
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.low || 0) * speedCreepPenalties.low;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.medium || 0) * speedCreepPenalties.medium;
  ecoPenalty += (speedCreep.speed_creep_severity_counts?.high || 0) * speedCreepPenalties.high;
  safetyPenalty += calculateNightPenalty(routePoints, thresholds);
  const fatiguePenalty = clamp(
    (Number(stats.fatigue_risk_score) || 0) * FATIGUE_SAFETY_PENALTY_SCALE,
    0,
    FATIGUE_SAFETY_MAX_PENALTY
  );

  const distKm = Math.max(1, stats.distance_km || 1);
  const phoneUseScoreDeduction = confirmedPhoneScoreAvailable
    ? Math.max(0, Math.min(100, 100 - Number(phoneUseResult.phone_use_score)))
    : null;
  const phoneUseRiskDeduction = scoringValue('PHONE_USE_RISK_DEDUCTION_POINTS')[phoneUseResult.phone_use_risk] ?? 0;
  const phoneUsePctDeduction = Math.max(0, Math.min(70, (phoneUseResult.phone_use_pct_of_trip || 0) * 0.5));
  const phoneUseDeduction = confirmedPhoneScoreAvailable
    ? Math.max(phoneUseScoreDeduction, phoneUseRiskDeduction, phoneUsePctDeduction)
    : 0;
  const SCORE_FLOOR = 0;
  const MAX_DEDUCTION = 100;
  const normalize = (totalPenalty) => {
    const penaltyRate = totalPenalty / distKm;
    const deduction = Math.min(penaltyRate * PENALTY_SCALE_FACTOR, MAX_DEDUCTION);
    return Math.max(SCORE_FLOOR, Math.round(100 - deduction));
  };

  const baseSafety = Math.round(normalize(safetyPenalty));
  const baseSmoothness = Math.round(normalize(smoothnessPenalty));
  const baseEco = Math.round(normalize(ecoPenalty));
  const jerk = calculateJerkScore(routePoints, stats.distance_km || distKm);
  const ecoDriving = calculateEcoDrivingScore(routePoints, stats, thresholds);
  const svi = calculateSpeedVariabilityIndex(routePoints, thresholds);
  const fuelBand = calculateFuelBandScore(routePoints, thresholds);
  const merge = detectHighwayMergeBehavior(routePoints, thresholds);
  const smoothBraking = calculateSmoothBrakingRatio(routePoints, thresholds);
  const engineStress = calculateEngineStressScore(scoringEvents, stats, routePoints, thresholds);
  const tireWear = calculateTireWearUnits(scoringEvents);
  const headingDrift = advancedSafetyEnabled
    ? detectHeadingDriftBeta(routePoints, durationSeconds, thresholds)
    : {
      heading_drift_beta_window_count: 0,
      heading_drift_beta_weighted_contribution: 0,
      heading_drift_beta_score: null,
      heading_drift_beta_level: 'none',
      heading_drift_beta_confidence: 'insufficient_data',
    };
  const hill = calculateHillDrivingScore(routePoints, thresholds);
  const parking = analyzeParkingApproach(routePoints, thresholds, options.endTime ?? null);
  const closeProximityCount = counts[EVENT_TYPES.CLOSE_PROXIMITY];
  const closeProximityScore = closeProximityCount === 0
    ? null
    : Math.max(0, Math.round(100 * Math.pow(CLOSE_PROXIMITY_DECAY_BASE, closeProximityCount)));
  const aggressive = calculateAggressiveDrivingScore(scoringEvents, { ...stats, ...jerk });
  const tripDistanceKm = Number(stats.distance_km) || 0;
  const stopStartEvidence = stopStartEvidenceDistances(routePoints, thresholds);
  const highwayDistanceKm = stopStartEvidence.highwayDistanceKm;
  const urbanStopStartDistanceKm = stopStartEvidence.urbanDistanceKm;
  const urbanStopStartEligible = stopStartEvidence.medianMovingSpeedKmh > 0 && stopStartEvidence.medianMovingSpeedKmh < 50;
  const stopStartPatternCount = counts[EVENT_TYPES.STOP_START_PATTERN] + counts[EVENT_TYPES.TAILGATE_CYCLE];
  const highwayStopStartPatternCount = scoringEvents.filter((event) => (
    event?.type === EVENT_TYPES.TAILGATE_CYCLE ||
    (event?.type === EVENT_TYPES.STOP_START_PATTERN && event.stop_start_context !== 'urban')
  )).length;
  const urbanStopStartPatternCount = scoringEvents.filter((event) => (
    event?.type === EVENT_TYPES.STOP_START_PATTERN && event.stop_start_context === 'urban'
  )).length;
  const highwayStopStartPatternScore = stopStartScoreForContext(highwayStopStartPatternCount, highwayDistanceKm, STOP_START_MIN_HIGHWAY_DISTANCE_KM);
  const urbanStopStartPatternScore = urbanStopStartEligible
    ? stopStartScoreForContext(urbanStopStartPatternCount, urbanStopStartDistanceKm, STOP_START_MIN_URBAN_DISTANCE_KM)
    : null;
  const stopStartPatternScore = weightedBlend([
    { score: highwayStopStartPatternScore, weight: highwayDistanceKm },
    { score: urbanStopStartPatternScore, weight: urbanStopStartDistanceKm },
  ]);
  const distractionDeductionCap = thresholds.DISTRACTION_DEDUCTION_CAP ?? 70;
  const gpsDistractionDeduction = distractionPenalty * (3 / distKm);
  const distractionDeduction = confirmedPhoneScoreAvailable
    ? phoneUseDeduction
    : gpsDistractionDeduction;
  const distractionScore = Math.max(0, 100 - Math.min(distractionDeduction, distractionDeductionCap));
  const brakeOnset = calculateBrakeOnsetSmoothness(routePoints, scoringEvents, thresholds);
  const cornering = calculateCorneringConsistency(routePoints, thresholds);
  const brakingEfficiency = calculateBrakingEfficiency(routePoints, scoringEvents, thresholds);
  const compliance = calculateSpeedLimitCompliance(routePoints, stats, thresholds, {
    localKnowledgeResults: options.localKnowledgeResults,
    settings: options.settings,
  });
  const tripSpeedSummary = calculateTripSpeedSummary(routePoints, stats, thresholds, {
    localKnowledgeResults: options.localKnowledgeResults,
    settings: options.settings,
    penaltyTotals: compliance.speed_penalty_totals,
  });
  const laneChangeScoreEnabled = thresholds.LANE_CHANGE_SCORE_ENABLED !== false;
  const laneChangeResult = options?.laneChangeResult || (
    advancedSafetyEnabled
      ? detectLaneChanges(routePoints, motionSamples, orientationCalibration, thresholds)
      : {
        lane_changes: [],
        lane_change_count: 0,
        unsafe_lane_changes: 0,
        confidence: 'unavailable',
        detection_method: 'disabled',
      }
  );
  const laneChanging = calculateLaneChangingScore(laneChangeResult, tripDistanceKm, thresholds);
  const laneChangingScoreValue = laneChangeScoreEnabled ? laneChanging.lane_changing_score : null;
  const overtakeQuality = calculateOvertakeQualityScore(routePoints, serializableEventList, thresholds);
  const slippery = detectSlipperyConditionProxy(routePoints, scoringEvents, thresholds);
  const routeSampleCount = routePoints.length;
  const altitudeSampleCount = routePoints.filter((point) => (
    Number.isFinite(Number(point?.altitude ?? point?.altitude_m))
  )).length;
  const evidenceFor = (componentKey, sampleCount, value, distanceKm = tripDistanceKm) => (
    registeredComponentConfidence(componentKey, distanceKm, sampleCount, value)
  );

  const brakingEvidence = evidenceFor('braking_efficiency', brakingEfficiency.braking_sequence_count, brakingEfficiency.braking_efficiency_score);
  const brakeOnsetEvidence = evidenceFor('brake_onset_smoothness', brakeOnset.brake_onset_sequence_count, brakeOnset.brake_onset_smoothness_score);
  const corneringEvidence = evidenceFor('cornering_consistency', cornering.corner_sample_count, cornering.cornering_consistency_score);
  const brakingScoreForSafety = brakingEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : brakingEfficiency.braking_efficiency_score;
  const complianceScoreForSafety = compliance.overall_compliance_score;
  const laneChangingScoreForSafety = laneChangingScoreValue;
  const phoneUseScoreForSafety = thresholds.PHONE_USE_AFFECTS_SCORE === false || !confirmedPhoneScoreAvailable
    ? null
    : phoneUseResult.phone_use_score;
  const jerkScoreForSmoothness = jerk.jerk_score_confidence === 'high' ? jerk.jerk_score : null;
  const sviScoreForSmoothness = svi.svi_score;
  const brakeOnsetScoreForSmoothness = brakeOnsetEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : brakeOnset.brake_onset_smoothness_score;
  const corneringScoreForSmoothness = corneringEvidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : cornering.cornering_consistency_score;
  const safetyBlend = scoringValue('SAFETY_SCORE_BLEND_WEIGHTS');
  const laneChangingSafetyWeight = laneChangingScoreForSafety == null
    ? 0
    : safetyBlend.laneChanging * (laneChanging.lane_changing_confidence_multiplier ?? 1);
  const safetyWithoutOvertake = weightedBlend([
    { score: baseSafety, weight: safetyBlend.base },
    { score: stopStartPatternScore, weight: safetyBlend.stopStart },
    { score: brakingScoreForSafety, weight: safetyBlend.braking },
    { score: complianceScoreForSafety, weight: safetyBlend.compliance },
    { score: phoneUseScoreForSafety, weight: PHONE_USE_SAFETY_WEIGHT },
    { score: laneChangingScoreForSafety, weight: laneChangingSafetyWeight },
  ]) ?? baseSafety;
  let safety = safetyWithoutOvertake;
  safety = Math.min(100, safety + (slippery.safety_condition_bonus || 0));
  safety = Math.round(clamp(safety - fatiguePenalty, SCORE_FLOOR, 100));
  const smoothnessBlend = scoringValue('SMOOTHNESS_SCORE_BLEND_WEIGHTS');
  const smoothness = weightedBlend([
    { score: baseSmoothness, weight: smoothnessBlend.base },
    { score: jerkScoreForSmoothness, weight: smoothnessBlend.jerk },
    { score: sviScoreForSmoothness, weight: smoothnessBlend.speedVariability },
    { score: brakeOnsetScoreForSmoothness, weight: smoothnessBlend.brakeOnset },
    { score: corneringScoreForSmoothness, weight: smoothnessBlend.cornering },
  ]) ?? baseSmoothness;
  const ecoBlend = scoringValue('ECO_SCORE_BLEND_WEIGHTS');
  const eco = weightedBlend([
    { score: baseEco, weight: ecoBlend.base },
    { score: ecoDriving.eco_driving_score, weight: ecoBlend.ecoDriving },
    { score: fuelBand.fuel_band_score, weight: ecoBlend.fuelBand },
  ]) ?? baseEco;
  const intersectionScore = Number.isFinite(stats.intersection_score) ? stats.intersection_score : null;

  // Overall = weighted combination
  const overallBlend = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS');
  const overall = Math.min(100, weightedBlend([
    { score: safety, weight: overallBlend.safety },
    { score: smoothness, weight: overallBlend.smoothness },
    { score: eco, weight: overallBlend.eco },
    { score: intersectionScore, weight: overallBlend.intersection },
  ]) ?? Math.round((safety + smoothness + eco) / 3));
  const phoneUseRequiredForSafety = thresholds.PHONE_USE_AFFECTS_SCORE !== false;
  const hasGpsDistractionEvidence = routeSampleCount >= 2 || counts[EVENT_TYPES.ERRATIC_SPEED] > 0;
  const distractionValue = hasGpsDistractionEvidence || confirmedPhoneScoreAvailable ? Math.round(distractionScore) : null;
  const safetyEvidence = evidenceFor('safety', routeSampleCount, safety);
  const limitedSafetyEvidence = phoneUseScoreForSafety == null && phoneUseRequiredForSafety
    ? cappedEvidenceLevel(safetyEvidence, CONFIDENCE_LEVELS.DEVELOPING)
    : safetyEvidence;
  const overallEvidence = evidenceFor('overall', routeSampleCount, overall);
  const limitedOverallEvidence = intersectionScore == null || (phoneUseScoreForSafety == null && phoneUseRequiredForSafety)
    ? cappedEvidenceLevel(overallEvidence, CONFIDENCE_LEVELS.DEVELOPING)
    : overallEvidence;
  const componentEvidence = {
    overall: limitedOverallEvidence,
    safety: limitedSafetyEvidence,
    smoothness: evidenceFor('smoothness', routeSampleCount, smoothness),
    eco: evidenceFor('eco', routeSampleCount, eco),
    intersection: evidenceFor('intersection', stats.traffic_stop_count ?? 0, intersectionScore),
    distraction: evidenceFor('distraction', confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : counts[EVENT_TYPES.ERRATIC_SPEED], distractionValue),
    phone_use: evidenceFor('phone_use', phoneUseResult.phone_use_window_count ?? 0, confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null),
    stop_start_pattern: evidenceFor(
      'stop_start_pattern',
      stopStartPatternCount,
      stopStartPatternScore,
      highwayStopStartPatternScore != null ? highwayDistanceKm : urbanStopStartDistanceKm
    ),
    close_proximity: evidenceFor('close_proximity', closeProximityCount, closeProximityScore),
    smoothness_index: evidenceFor('smoothness_index', routeSampleCount, jerk.jerk_score),
    eco_driving: evidenceFor('eco_driving', routeSampleCount, ecoDriving.eco_driving_score),
    speed_variability: evidenceFor('speed_variability', svi.svi_moving_sample_count, svi.svi_score),
    fuel_band: evidenceFor('fuel_band', routeSampleCount, fuelBand.fuel_band_score),
    merge: evidenceFor('merge', merge.merge_event_count, merge.merge_score),
    smooth_braking: evidenceFor('smooth_braking', smoothBraking.total_stops_detected, smoothBraking.total_stops_detected > 0 ? smoothBraking.smooth_braking_score : null),
    engine_stress: evidenceFor('engine_stress', routeSampleCount, engineStress.engine_stress_score),
    speed_creep: evidenceFor('speed_creep', routeSampleCount, advancedSafetyEnabled ? speedCreep.speed_creep_score : null),
    heading_drift_beta: evidenceFor('heading_drift_beta', routeSampleCount, advancedSafetyEnabled ? headingDrift.heading_drift_beta_score : null),
    hill_driving: evidenceFor('hill_driving', altitudeSampleCount, hill.hill_driving_score),
    parking_approach: evidenceFor('parking_approach', routeSampleCount, routeSampleCount >= 3 ? parking.parking_approach_score : null),
    brake_onset_smoothness: brakeOnsetEvidence,
    cornering_consistency: corneringEvidence,
    braking_efficiency: brakingEvidence,
    speed_limit_compliance: evidenceFor('speed_limit_compliance', routeSampleCount, compliance.overall_compliance_score),
    lane_changing: evidenceFor('lane_changing', laneChanging.lane_change_count, laneChangingScoreValue, tripDistanceKm),
    overtake_quality: evidenceFor('overtake_quality', overtakeQuality.overtake_count, overtakeQuality.overtake_quality_score),
    aggressive_driving: evidenceFor('aggressive_driving', routeSampleCount, aggressive.aggressive_driving_score),
    fatigue_risk: evidenceFor('fatigue_risk', durationSeconds > 0 ? 1 : 0, stats.fatigue_risk_score),
  };
  const safetyConfidence = componentEvidence.safety;
  const smoothnessConfidence = componentEvidence.smoothness;
  const ecoConfidence = componentEvidence.eco;
  const distractionConfidence = componentEvidence.distraction;
  const overallConfidenceLevel = componentEvidence.overall;
  const scoreConfidence = confidenceNumericValue(overallConfidenceLevel);
  const scoreOrNull = (value, evidence) => (
    evidence === CONFIDENCE_LEVELS.UNAVAILABLE ? null : value
  );
  const overallScoreValue = scoreOrNull(overall, componentEvidence.overall);
  const safetyScoreValue = scoreOrNull(safety, componentEvidence.safety);
  const smoothnessScoreValue = scoreOrNull(smoothness, componentEvidence.smoothness);
  const ecoScoreValue = scoreOrNull(eco, componentEvidence.eco);

  const componentScores = {
    score_overall: overallScoreValue,
    score_confidence: scoreConfidence,
    score_confidence_label: overallConfidenceLevel,
    score_safety: safetyScoreValue,
    score_safety_confidence: safetyConfidence,
    score_smoothness: smoothnessScoreValue,
    score_smoothness_confidence: smoothnessConfidence,
    score_eco: ecoScoreValue,
    score_eco_confidence: ecoConfidence,
    harsh_brakes_count: counts[EVENT_TYPES.HARSH_BRAKE],
    rapid_accel_count: counts[EVENT_TYPES.RAPID_ACCELERATION],
    sharp_turns_count: counts[EVENT_TYPES.SHARP_TURN],
    speeding_events_count: counts[EVENT_TYPES.SPEEDING],
    heading_deviation_count: counts[EVENT_TYPES.HEADING_DEVIATION],
    heading_deviations_per_10km: round1((counts[EVENT_TYPES.HEADING_DEVIATION] / distKm) * 10),
    heading_deviation_legacy_count: counts[EVENT_TYPES.HEADING_DEVIATION_LEGACY],
    heading_deviation_legacy_per_10km: round1((counts[EVENT_TYPES.HEADING_DEVIATION_LEGACY] / distKm) * 10),
    heading_deviation_available: advancedSafetyEnabled || counts[EVENT_TYPES.HEADING_DEVIATION] > 0,
    heading_deviation_scoring_enabled: advancedSafetyEnabled,
    stop_start_pattern_count: stopStartPatternCount,
    stop_start_pattern_sample_count: stopStartPatternCount,
    stop_start_pattern_score: stopStartPatternScore,
    stop_start_pattern_highway_count: highwayStopStartPatternCount,
    stop_start_pattern_urban_count: urbanStopStartPatternCount,
    stop_start_pattern_highway_score: highwayStopStartPatternScore,
    stop_start_pattern_urban_score: urbanStopStartPatternScore,
    stop_start_pattern_highway_distance_km: round2(highwayDistanceKm),
    stop_start_pattern_urban_distance_km: round2(urbanStopStartDistanceKm),
    stop_start_pattern_median_speed_kmh: round1(stopStartEvidence.medianMovingSpeedKmh),
    stop_start_pattern_score_confidence: componentEvidence.stop_start_pattern,
    distraction_events_count: counts[EVENT_TYPES.ERRATIC_SPEED],
    distraction_score: distractionValue,
    distraction_score_confidence: distractionConfidence,
    close_proximity_count: closeProximityCount,
    close_proximity_score: closeProximityScore,
    close_proximity_score_confidence: componentEvidence.close_proximity,
    overtake_event_count: diagnosticOvertakeCount,
    overtake_score: null,
    overtake_score_confidence: 'beta_diagnostic_only',
    overtake_affects_score: false,
    intersection_score: intersectionScore,
    intersection_score_confidence: componentEvidence.intersection,
    ...jerk,
    jerk_score_confidence: componentEvidence.smoothness_index,
    ...ecoDriving,
    eco_driving_score_confidence: componentEvidence.eco_driving,
    ...svi,
    svi_score_confidence: componentEvidence.speed_variability,
    ...fuelBand,
    fuel_band_score_confidence: componentEvidence.fuel_band,
    ...merge,
    merge_score_confidence: componentEvidence.merge,
    ...smoothBraking,
    smooth_braking_score_confidence: componentEvidence.smooth_braking,
    ...engineStress,
    engine_stress_score_confidence: componentEvidence.engine_stress,
    ...tireWear,
    ...speedCreep,
    speed_creep_score_confidence: componentEvidence.speed_creep,
    ...phoneProxy,
    phone_use_events: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_events || []) : [],
    phone_use_window_count: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_window_count || 0) : 0,
    phone_use_total_seconds: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_total_seconds || 0) : 0,
    phone_use_risk: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_risk || 'none') : 'none',
    phone_use_score: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null,
    phone_use_score_available: confirmedPhoneScoreAvailable,
    phone_use_score_status: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_score_status || 'confirmed_signal') : 'usage_access_required',
    phone_use_score_confidence: confirmedPhoneScoreAvailable ? componentEvidence.phone_use : 'usage_access_required',
    phone_use_pct_of_trip: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_pct_of_trip || 0) : 0,
    phone_use_high_confidence_count: confirmedPhoneScoreAvailable ? (phoneUseResult.phone_use_high_confidence_count || 0) : 0,
    phone_proxy_events: proxyEvents,
    ...headingDrift,
    heading_drift_beta_confidence: componentEvidence.heading_drift_beta,
    heading_drift_beta_available: advancedSafetyEnabled,
    ...hill,
    hill_driving_score_confidence: componentEvidence.hill_driving,
    ...parking,
    parking_approach_score_confidence: componentEvidence.parking_approach,
    ...brakeOnset,
    brake_onset_smoothness_confidence: componentEvidence.brake_onset_smoothness,
    ...cornering,
    cornering_consistency_score_confidence: componentEvidence.cornering_consistency,
    ...brakingEfficiency,
    braking_efficiency_score_confidence: componentEvidence.braking_efficiency,
    ...compliance,
    overall_compliance_score_confidence: componentEvidence.speed_limit_compliance,
    ...laneChanging,
    lane_changing_score: laneChangingScoreValue,
    lane_changing_safety_weight: laneChangingSafetyWeight,
    lane_change_detection_confidence: laneChangeResult.confidence,
    lane_change_detection_method: laneChangeResult.detection_method,
    lane_change_events: laneChangeResult.lane_changes || [],
    ...overtakeQuality,
    overtake_quality_score_confidence: componentEvidence.overtake_quality,
    overtake_quality_beta: true,
    ...slippery,
    trip_speed_summary_v1: tripSpeedSummary,
    ...(options.includeRoadTypeSegments === false ? {} : calculateRoadTypeSegmentedScores(routePoints, scoringEvents, stats, thresholds)),
    ...aggressive,
    aggressive_driving_score_confidence: componentEvidence.aggressive_driving,
    driving_events: serializableEvents,
  };
  delete componentScores.speed_creep_severity_counts;

  const defensiveDriving = calculateDefensiveDrivingScore(componentScores);
  const scoredTrip = {
    ...componentScores,
    ...defensiveDriving,
    defensive_driving_score_confidence: evidenceFor('defensive_driving', routeSampleCount, defensiveDriving.defensive_driving_score),
  };
  const gpsSources = tripDistanceKm > 0 || routePoints.length > 0 || scoringEvents.length > 0 ? ['gps'] : [];
  const obdSpeedObserved = routePoints.some((point) => speedSourceForPoint(point, thresholds) === 'obd_bluetooth');
  const obdPowertrainObserved = routePoints.some((point) => (
    Number.isFinite(Number(point?.obd_rpm)) ||
    Number.isFinite(Number(point?.obd_throttle_pct)) ||
    Number.isFinite(Number(point?.obd_maf_gps))
  ));
  const speedLimitSources = compliance.overall_compliance_score == null
    ? []
    : [
      ...gpsSources,
      ...Object.entries(tripSpeedSummary.tierCoverage || {})
        .filter(([, coverage]) => Number(coverage) > 0)
        .map(([tierName]) => tierProvenance[tierName] || tierProvenance.UNKNOWN),
    ];
  const phoneSources = confirmedPhoneScoreAvailable
    ? [...new Set(phoneUseResult.data_sources?.length ? phoneUseResult.data_sources : ['android_usage_access'])]
    : [];
  const combinedSources = (...sources) => [...new Set(sources.flat().filter(Boolean))];
  const vehicleSpeedSources = combinedSources(gpsSources, obdSpeedObserved ? ['obd_bluetooth'] : []);
  const laneChangingSources = laneChanging.lane_changing_confidence === 'imu_calibrated'
    ? combinedSources(gpsSources, ['device_motion_imu'])
    : gpsSources;
  const powertrainSources = combinedSources(vehicleSpeedSources, obdPowertrainObserved ? ['obd_bluetooth'] : []);
  const inferredSpeedLimitScoring = speedLimitSources.includes(tierProvenance.GPS_INFERRED);
  const inferredSpeedLimitNote = inferredSpeedLimitScoring
    ? 'Speed-limit compliance used inferred road-type limits because no posted OpenStreetMap maxspeed was available; speeding penalties are half-weighted.'
    : undefined;
  const joinedNote = (...notes) => notes.filter(Boolean).join(' ') || undefined;
  const component_scores = {
    overall: createComponentScore(overallScoreValue, componentEvidence.overall, combinedSources(vehicleSpeedSources, phoneSources, speedLimitSources), {
      sampleCount: routeSampleCount,
      note: joinedNote(
        overallConfidenceLevel === CONFIDENCE_LEVELS.HIGH ? undefined : 'Some contributing signals are unavailable or still developing.',
        inferredSpeedLimitNote
      ),
    }),
    safety: createComponentScore(safetyScoreValue, componentEvidence.safety, combinedSources(vehicleSpeedSources, phoneSources, speedLimitSources), {
      sampleCount: routeSampleCount,
      note: joinedNote(
        phoneUseScoreForSafety == null && phoneUseRequiredForSafety ? 'Confirmed phone-use evidence is unavailable.' : undefined,
        inferredSpeedLimitNote
      ),
    }),
    smoothness: createComponentScore(smoothnessScoreValue, componentEvidence.smoothness, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    eco: createComponentScore(ecoScoreValue, componentEvidence.eco, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    intersection: createComponentScore(intersectionScore, componentEvidence.intersection, gpsSources, {
      sampleCount: stats.traffic_stop_count ?? 0,
      note: intersectionScore == null ? 'No qualifying traffic-stop evidence was recorded.' : undefined,
    }),
    distraction: createComponentScore(distractionValue, componentEvidence.distraction, combinedSources(gpsSources, phoneSources), {
      sampleCount: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : counts[EVENT_TYPES.ERRATIC_SPEED],
    }),
    phone_use: createComponentScore(
      confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_score : null,
      componentEvidence.phone_use,
      phoneSources,
      {
        sampleCount: confirmedPhoneScoreAvailable ? phoneUseResult.phone_use_window_count : 0,
        note: confirmedPhoneScoreAvailable ? undefined : 'Android Usage Access is required for a scored phone-use signal.',
      }
    ),
    stop_start_pattern: createComponentScore(stopStartPatternScore, componentEvidence.stop_start_pattern, gpsSources, {
      sampleCount: stopStartPatternCount,
      note: 'GPS-only pattern estimate; it does not measure following distance.',
    }),
    close_proximity: createComponentScore(closeProximityScore, componentEvidence.close_proximity, gpsSources, {
      sampleCount: closeProximityCount,
      note: 'GPS brake-turn manoeuvre alert; object proximity is not measured.',
    }),
    smoothness_index: createComponentScore(jerk.jerk_score, componentEvidence.smoothness_index, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    eco_driving: createComponentScore(ecoDriving.eco_driving_score, componentEvidence.eco_driving, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    speed_variability: createComponentScore(svi.svi_score, componentEvidence.speed_variability, vehicleSpeedSources, {
      sampleCount: svi.svi_moving_sample_count,
    }),
    fuel_band: createComponentScore(fuelBand.fuel_band_score, componentEvidence.fuel_band, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    merge: createComponentScore(merge.merge_score, componentEvidence.merge, gpsSources, {
      sampleCount: merge.merge_event_count,
    }),
    smooth_braking: createComponentScore(
      smoothBraking.total_stops_detected > 0 ? smoothBraking.smooth_braking_score : null,
      componentEvidence.smooth_braking,
      gpsSources,
      { sampleCount: smoothBraking.total_stops_detected }
    ),
    engine_stress: createComponentScore(engineStress.engine_stress_score, componentEvidence.engine_stress, powertrainSources, {
      sampleCount: routeSampleCount,
    }),
    speed_creep: createComponentScore(
      advancedSafetyEnabled ? speedCreep.speed_creep_score : null,
      componentEvidence.speed_creep,
      gpsSources,
      { sampleCount: routeSampleCount }
    ),
    heading_drift_beta: createComponentScore(
      advancedSafetyEnabled ? headingDrift.heading_drift_beta_score : null,
      componentEvidence.heading_drift_beta,
      gpsSources,
      {
        sampleCount: routeSampleCount,
        note: 'GPS heading-drift beta estimate; this is not a fatigue diagnosis.',
      }
    ),
    hill_driving: createComponentScore(hill.hill_driving_score, componentEvidence.hill_driving, combinedSources(gpsSources, ['gps_altitude']), {
      sampleCount: altitudeSampleCount,
      note: 'GPS altitude-derived estimate.',
    }),
    parking_approach: createComponentScore(routeSampleCount >= 3 ? parking.parking_approach_score : null, componentEvidence.parking_approach, gpsSources, {
      sampleCount: routeSampleCount,
    }),
    brake_onset_smoothness: createComponentScore(brakeOnset.brake_onset_smoothness_score, componentEvidence.brake_onset_smoothness, vehicleSpeedSources, {
      sampleCount: brakeOnset.brake_onset_sequence_count,
    }),
    cornering_consistency: createComponentScore(cornering.cornering_consistency_score, componentEvidence.cornering_consistency, vehicleSpeedSources, {
      sampleCount: cornering.corner_sample_count,
    }),
    braking_efficiency: createComponentScore(brakingEfficiency.braking_efficiency_score, componentEvidence.braking_efficiency, vehicleSpeedSources, {
      sampleCount: brakingEfficiency.braking_sequence_count,
    }),
    speed_limit_compliance: createComponentScore(compliance.overall_compliance_score, componentEvidence.speed_limit_compliance, speedLimitSources, {
      sampleCount: routeSampleCount,
      note: inferredSpeedLimitNote,
    }),
    lane_changing: createComponentScore(
      laneChangingScoreValue,
      componentEvidence.lane_changing,
      laneChangingSources,
      {
        sampleCount: laneChanging.lane_change_count,
        note: !laneChangeScoreEnabled
          ? 'Lane-changing scoring is disabled in Settings.'
          : laneChanging.lane_changing_score == null
            ? 'Requires at least 5 km and two detected lane-change manoeuvres.'
            : laneChanging.lane_changing_confidence === 'gps_only'
              ? 'GPS-only lane-change fallback; lower confidence than calibrated IMU detection.'
              : undefined,
      }
    ),
    overtake_quality: createComponentScore(overtakeQuality.overtake_quality_score, componentEvidence.overtake_quality, gpsSources, {
      sampleCount: overtakeQuality.overtake_count,
      note: 'Beta diagnostic only; excluded from Safety.',
    }),
    aggressive_driving: createComponentScore(aggressive.aggressive_driving_score, componentEvidence.aggressive_driving, vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    defensive_driving: createComponentScore(defensiveDriving.defensive_driving_score, evidenceFor('defensive_driving', routeSampleCount, defensiveDriving.defensive_driving_score), vehicleSpeedSources, {
      sampleCount: routeSampleCount,
    }),
    fatigue_risk: createComponentScore(stats.fatigue_risk_score, componentEvidence.fatigue_risk, gpsSources, {
      sampleCount: durationSeconds > 0 ? 1 : 0,
      note: 'Driving-time proxy only; not a diagnosis of fatigue.',
    }),
  };
  return {
    ...scoredTrip,
    component_scores,
    score_provenance: buildScoreProvenance(component_scores, thresholds),
  };
}

// ─── Score Color Utility ───────────────────────────────────────────────────────
export function getScoreColor(score) {
  if (score >= 85) return { color: 'text-green-500', fill: 'bg-green-500', stroke: '#22c55e', bg: 'bg-green-50 dark:bg-green-950/30', label: 'Excellent' };
  if (score >= 70) return { color: 'text-blue-500', fill: 'bg-blue-500', stroke: '#3b82f6', bg: 'bg-blue-50 dark:bg-blue-950/30', label: 'Good' };
  if (score >= 55) return { color: 'text-yellow-500', fill: 'bg-yellow-500', stroke: '#eab308', bg: 'bg-yellow-50 dark:bg-yellow-950/30', label: 'Fair' };
  if (score >= 40) return { color: 'text-orange-500', fill: 'bg-orange-500', stroke: '#f97316', bg: 'bg-orange-50 dark:bg-orange-950/30', label: 'Poor' };
  return { color: 'text-red-500', fill: 'bg-red-500', stroke: '#ef4444', bg: 'bg-red-50 dark:bg-red-950/30', label: 'Risky' };
}

export function getScoreGradient(score) {
  if (score >= 85) return 'from-green-400 to-emerald-500';
  if (score >= 70) return 'from-blue-400 to-blue-600';
  if (score >= 55) return 'from-yellow-400 to-orange-400';
  if (score >= 40) return 'from-orange-400 to-red-400';
  return 'from-red-500 to-red-700';
}

// ─── Format Utilities ──────────────────────────────────────────────────────────
export function formatDuration(seconds) {
  if (!seconds) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatDistance(km, units = 'metric') {
  if (units === 'imperial') {
    const miles = km * 0.621371;
    return `${miles.toFixed(1)} mi`;
  }
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatSpeed(kmh, units = 'metric') {
  if (units === 'imperial') return `${Math.round(kmh * 0.621371)} mph`;
  return `${Math.round(kmh)} km/h`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(dateStr) {
  if (!dateStr) return '';
  return `${formatDate(dateStr)} ${formatTime(dateStr)}`;
}

// ─── Report Calculations ───────────────────────────────────────────────────────
function distanceWeightedTripScore(trips = [], field = 'score_overall') {
  const scored = trips
    .map((trip) => ({
      score: Number(trip?.[field]),
      distance: Number(trip?.distance_km) || 0,
    }))
    .filter((item) => Number.isFinite(item.score));
  const totalKm = scored.reduce((sum, item) => sum + item.distance, 0);
  return totalKm > 0
    ? scored.reduce((sum, item) => sum + item.score * item.distance, 0) / totalKm
    : null;
}

/**
 * Generate a summary report for a set of trips.
 *
 * @param {Array} trips - Array of completed trips
 * @returns {Object} Report summary
 */
export function generateReportSummary(trips) {
  if (!trips || trips.length === 0) {
    return {
      total_trips: 0,
      total_distance_km: 0,
      total_duration_seconds: 0,
      avg_score: null,
      best_trip: null,
      worst_trip: null,
      total_harsh_brakes: 0,
      total_rapid_accels: 0,
      total_sharp_turns: 0,
      total_speeding_events: 0,
      total_heading_deviations: 0,
      total_stop_start_patterns: 0,
      total_distraction_events: 0,
      most_common_risk: null,
    };
  }

  const completed = trips.filter(t => t.status === 'completed');
  const totalDistance = completed.reduce((s, t) => s + (t.distance_km || 0), 0);
  const totalDuration = completed.reduce((s, t) => s + (t.duration_seconds || 0), 0);
  const scores = completed
    .map((trip) => Number(trip.score_overall))
    .filter((score) => Number.isFinite(score));
  const weightedScore = distanceWeightedTripScore(completed);
  const avgScore = weightedScore == null ? null : Math.round(weightedScore);

  const scoredTrips = completed.filter((trip) => Number.isFinite(Number(trip.score_overall)));
  const sorted = [...scoredTrips].sort((a, b) => Number(b.score_overall) - Number(a.score_overall));
  const bestTrip = sorted[0] || null;
  const worstTrip = sorted[sorted.length - 1] || null;

  const hb = completed.reduce((s, t) => s + (t.harsh_brakes_count || 0), 0);
  const ra = completed.reduce((s, t) => s + (t.rapid_accel_count || 0), 0);
  const st = completed.reduce((s, t) => s + (t.sharp_turns_count || 0), 0);
  const sp = completed.reduce((s, t) => s + (t.speeding_events_count || 0), 0);
  const hd = completed.reduce((s, t) => s + (t.heading_deviation_count ?? 0), 0);
  const ss = completed.reduce((s, t) => s + (t.stop_start_pattern_count ?? t.tailgate_cycle_count ?? 0), 0);
  const er = completed.reduce((s, t) => s + (t.distraction_events_count || 0), 0);

  const riskMap = {
    [EVENT_TYPES.HARSH_BRAKE]: hb,
    [EVENT_TYPES.RAPID_ACCELERATION]: ra,
    [EVENT_TYPES.SHARP_TURN]: st,
    [EVENT_TYPES.SPEEDING]: sp,
    [EVENT_TYPES.HEADING_DEVIATION]: hd,
    [EVENT_TYPES.STOP_START_PATTERN]: ss,
    [EVENT_TYPES.ERRATIC_SPEED]: er,
  };
  const mostCommonRisk = Object.entries(riskMap).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    total_trips: completed.length,
    total_distance_km: Math.round(totalDistance * 10) / 10,
    total_duration_seconds: totalDuration,
    avg_score: avgScore,
    best_trip: bestTrip,
    worst_trip: worstTrip,
    total_harsh_brakes: hb,
    total_rapid_accels: ra,
    total_sharp_turns: st,
    total_speeding_events: sp,
    total_heading_deviations: hd,
    total_stop_start_patterns: ss,
    total_distraction_events: er,
    most_common_risk: mostCommonRisk,
    score_trend: scores,
  };
}

// ─── GPS Location Service (Browser) ───────────────────────────────────────────
/**
 * Live GPS tracking service using the Web Geolocation API.
 * Returns an object with start/stop methods and a callback for new points.
 */
export function createLocationService() {
  let watchId = null;
  let onPoint = null;
  let onError = null;

  return {
    start(onPointCb, onErrorCb) {
      onPoint = onPointCb;
      onError = onErrorCb;

      if (!navigator.geolocation) {
        onError?.({ message: 'Geolocation not supported' });
        return;
      }

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          if (pos.coords.accuracy > DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M) return; // filter noisy points
          onPoint?.({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speed_kmh: pos.coords.speed != null ? pos.coords.speed * 3.6 : null,
            accuracy: pos.coords.accuracy,
            heading: pos.coords.heading,
            timestamp: new Date(pos.timestamp).toISOString(),
          });
        },
        (err) => onError?.({ message: err.message, code: err.code }),
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        }
      );
    },
    stop() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    isActive: () => watchId !== null,
  };
}

// ─── CSV Export ────────────────────────────────────────────────────────────────
const csvSpeedLimitSources = (trip = {}) => {
  const sources = new Set();
  (trip.route_points || []).forEach((point) => {
    if (point?.speed_limit_source) sources.add(point.speed_limit_source);
  });
  (trip.driving_events || []).forEach((event) => {
    if (event?.speed_limit_source) sources.add(event.speed_limit_source);
    if (event?.limit_source) sources.add(event.limit_source);
  });
  ['highway_compliance', 'urban_compliance', 'residential_compliance'].forEach((key) => {
    if (trip[key]?.limit_source) sources.add(trip[key].limit_source);
  });
  return [...sources].sort().join(';');
};

const csvSpeedLimitDefaultCountries = (trip = {}) => {
  const countries = new Set();
  (trip.route_points || []).forEach((point) => {
    if (point?.speed_limit_default_country) countries.add(point.speed_limit_default_country);
    if (point?.fallback_country) countries.add(point.fallback_country);
  });
  (trip.driving_events || []).forEach((event) => {
    if (event?.speed_limit_default_country) countries.add(event.speed_limit_default_country);
    if (event?.fallback_country) countries.add(event.fallback_country);
  });
  return [...countries].sort().join(';');
};

export function tripsToCSV(trips) {
  const headers = [
    'ID', 'Start Time', 'End Time', 'Duration (min)', 'Distance (km)',
    'Avg Speed (km/h)', 'Avg Moving Speed (km/h)', 'Max Speed (km/h)', 'Score', 'Safety', 'Smoothness',
    // FIX: Add exported moving-speed column immediately after the legacy overall average speed.
    'Eco Score Estimate', 'Smoothness Index', 'Eco Driving Estimate', 'Stop-Start Pattern Estimate', 'Attention-Pattern Estimate', 'Approach-Stop Estimate',
    'Aggressive Score', 'Aggressive Grade', 'Defensive Driving Estimate', 'Defensive Grade', 'SVI', 'Fuel Band',
    'Smooth Braking', 'Engine Stress', 'Tire Wear Units', 'Heading Drift Beta', 'Phone Proxy (Diagnostic)', 'Parking Score',
    'Highway Score', 'Urban Score', 'Residential Score', 'Dominant Road Type',
    'Brake Onset Smoothness Score', 'Avg Brake Onset Ramp (s)', 'Brake Onset Smoothness Grade',
    'Phone Use Windows', 'Phone Use Total Seconds', 'Phone Use Risk', 'Phone Use Score (Usage Access)', 'Phone Use Pct Trip',
    'Cornering Consistency Score', 'Mean Lateral G', 'Peak Lateral G',
    'Braking Efficiency Score', 'Braking Efficiency Grade', 'Braking Sequence Count',
    'Highway Compliance Score', 'Urban Compliance Score', 'Residential Compliance Score', 'Overall Compliance Score',
    'Speed Limit Sources', 'Speed Limit Default Countries',
    'Overtake Quality Score (Beta Diagnostic)', 'Overtake Pattern Count (Beta Diagnostic)', 'Unsafe Re-entry Count (Beta Diagnostic)',
    'Weather Context', 'Safety Condition Bonus',
    'Road Type', 'Harsh Brakes', 'Rapid Accels', 'Sharp Turns', 'Speeding Events',
    'Heading Deviation Events (Beta)', 'Heading Events (Legacy)', 'Stop-Start Patterns', 'Erratic Speed Events', 'Brake-Turn Manoeuvre Alerts', 'Overtake Patterns (Beta Diagnostic)', 'Night Driving',
    'Event Feedback Accurate', 'Event Feedback Wrong', 'Event Feedback JSON',
    'GPS Point Count', 'Route Points JSON', 'Driving Events JSON',
  ];
  const metricMetadata = headers.map((header, index) => {
    if (index === 0) return 'Metric Metadata';
    const metricKey = CSV_METRIC_COLUMNS[header];
    return metricKey ? formatMetricMetadata(metricKey) : '';
  });

  const scoreCsvValue = (header, value) => (
    isEstimatedScoreMetric(CSV_METRIC_COLUMNS[header])
      ? formatEstimatedScore(value, { empty: '' })
      : value ?? ''
  );

  const privacyExportSalt = createPrivacyExportSalt();
  const rows = trips.map((rawTrip) => {
    const t = /** @type {any} */ (maskTripForPrivacyExport(rawTrip, undefined, privacyExportSalt));
    const feedbackItems = Object.values(t.event_feedback || {});
    const accurateFeedback = feedbackItems.filter((item) => item?.verdict === 'accurate').length;
    const wrongFeedback = feedbackItems.filter((item) => item?.verdict === 'wrong').length;
    return [
    t.id,
    t.start_time,
    t.end_time,
    t.duration_seconds ? (t.duration_seconds / 60).toFixed(1) : '',
    t.distance_km ?? '',
    t.avg_speed_kmh ?? '',
    t.avg_running_speed_kmh ?? '',
    // FIX: Export avg_running_speed_kmh so CSV consumers can use driving speed excluding stops.
    t.max_speed_kmh ?? '',
    scoreCsvValue('Score', t.score_overall),
    scoreCsvValue('Safety', t.score_safety),
    scoreCsvValue('Smoothness', t.score_smoothness),
    scoreCsvValue('Eco Score Estimate', t.score_eco),
    t.jerk_score ?? '',
    scoreCsvValue('Eco Driving Estimate', t.eco_driving_score),
    scoreCsvValue('Stop-Start Pattern Estimate', t.stop_start_pattern_score),
    scoreCsvValue('Attention-Pattern Estimate', t.distraction_score),
    scoreCsvValue('Approach-Stop Estimate', t.intersection_score),
    scoreCsvValue('Aggressive Score', t.aggressive_driving_score),
    t.aggressive_grade ?? '',
    scoreCsvValue('Defensive Driving Estimate', t.defensive_driving_score),
    t.defensive_grade ?? '',
    t.speed_variability_index ?? '',
    scoreCsvValue('Fuel Band', t.fuel_band_score),
    t.smooth_braking_ratio ?? '',
    scoreCsvValue('Engine Stress', t.engine_stress_score),
    t.trip_tire_wear_units ?? '',
    t.heading_drift_beta_level ?? t.drowsy_risk_level ?? '',
    t.phone_proxy_risk ?? '',
    scoreCsvValue('Parking Score', t.parking_approach_score),
    scoreCsvValue('Highway Score', t.highway_score?.overall),
    scoreCsvValue('Urban Score', t.urban_score?.overall),
    scoreCsvValue('Residential Score', t.residential_score?.overall),
    t.dominant_road_type ?? '',
    scoreCsvValue('Brake Onset Smoothness Score', t.brake_onset_smoothness_score),
    t.avg_brake_onset_ramp_seconds ?? '',
    t.brake_onset_smoothness_grade ?? '',
    t.phone_use_window_count ?? 0,
    t.phone_use_total_seconds ?? 0,
    t.phone_use_risk ?? 'none',
    scoreCsvValue('Phone Use Score (Usage Access)', t.phone_use_score),
    t.phone_use_pct_of_trip ?? 0,
    scoreCsvValue('Cornering Consistency Score', t.cornering_consistency_score),
    t.mean_lateral_g ?? '',
    t.peak_lateral_g ?? '',
    scoreCsvValue('Braking Efficiency Score', t.braking_efficiency_score),
    t.braking_efficiency_grade ?? '',
    t.braking_sequence_count ?? '',
    scoreCsvValue('Highway Compliance Score', t.highway_compliance?.score),
    scoreCsvValue('Urban Compliance Score', t.urban_compliance?.score),
    scoreCsvValue('Residential Compliance Score', t.residential_compliance?.score),
    scoreCsvValue('Overall Compliance Score', t.overall_compliance_score),
    csvSpeedLimitSources(t),
    csvSpeedLimitDefaultCountries(t),
    scoreCsvValue('Overtake Quality Score (Beta Diagnostic)', t.overtake_quality_score),
    t.overtake_count ?? '',
    t.unsafe_reentry_count ?? '',
    t.slippery_proxy ?? '',
    t.safety_condition_bonus ?? '',
    t.road_type ?? '',
    t.harsh_brakes_count ?? '',
    t.rapid_accel_count ?? '',
    t.sharp_turns_count ?? '',
    t.speeding_events_count ?? '',
    t.heading_deviation_count ?? '',
    t.heading_deviation_legacy_count ?? '',
    t.stop_start_pattern_count ?? t.tailgate_cycle_count ?? '',
    t.distraction_events_count ?? '',
    t.close_proximity_count ?? '',
    t.overtake_event_count ?? '',
    t.night_driving ? 'Yes' : 'No',
    accurateFeedback,
    wrongFeedback,
    JSON.stringify(t.event_feedback || {}),
    t.route_points?.length || 0,
    JSON.stringify(t.route_points || []),
    JSON.stringify(t.driving_events || []),
    ];
  });

  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers, metricMetadata, ...rows].map(r => r.map(escape).join(',')).join('\n');
}

export async function downloadCSV(content, filename) {
  const safeFilename = filename.replace(/[\\/:*?"<>|]+/g, '-');

  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const result = await saveExportToDownloads({
        filename: safeFilename,
        data: content,
        mimeType: 'text/csv',
      });
      recordSystemEvent('csv_export_completed', {
        native: true,
        extension: 'csv',
        mime_type: 'text/csv',
        byte_count: String(content || '').length,
      }, { category: 'storage', title: 'CSV export completed' });
      return {
        native: true,
        uri: result.uri,
        filename: safeFilename,
      };
    }
  } catch (error) {
    logSystemFailure('csv_native_export', error, {
      extension: 'csv',
      mime_type: 'text/csv',
      byte_count: String(content || '').length,
    });
    console.warn('Native CSV export failed, falling back to browser download.', error);
  }

  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  recordSystemEvent('csv_export_completed', {
    native: false,
    extension: 'csv',
    mime_type: 'text/csv',
    byte_count: String(content || '').length,
  }, { category: 'storage', title: 'CSV export completed' });
  return {
    native: false,
    filename: safeFilename,
  };
}
