import { SCORING_VERSION } from './scoringVersion.generated.js';

export const CALIBRATION_STATUSES = Object.freeze({
  PROVISIONAL: 'provisional',
  CALIBRATED: 'calibrated',
  CITED: 'cited',
});

export const SCORE_OUTPUT_CALIBRATION_STATUSES = Object.freeze({
  APPROXIMATE: 'approximate',
  CALIBRATED: 'calibrated',
});

export { SCORING_VERSION };

const scoreMetrics = ['score_overall', 'score_safety', 'score_smoothness', 'score_eco'];
const routeRiskMetrics = ['route_risk_score', 'pre_trip_readiness_score'];
const ubiMetrics = ['ubi_score'];

/**
 * @calibration PROVISIONAL
 * @currentValue 0
 * @affects score_safety, score_overall
 * @mathRole Sets the share of lane_changing_score admitted into the Safety blend when the lane-changing feature is enabled.
 * @calibrationRequirement Dashcam-reviewed lane-change labels with maneuver timing, road curvature, braking context, and manual-review agreement outcomes.
 * @calibrationMethod Threshold search and cross-validation across labeled lane-change detections, false positives, and Safety score deltas.
 * @externalReference none
 * @promotionBlocker true
 */
export const LANE_CHANGING_SAFETY_WEIGHT = 0;
const PHONE_USE_SAFETY_BLEND_WEIGHT = 0.05;

export const PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS = Object.freeze({
  process_id: 'penalty-scale-factor-outcome-calibration-v1',
  owner: 'scoring',
  objective: 'Fit the 0-100 trip-score deduction applied to severity-weighted penalty points per km.',
  current_runtime_policy: 'Keep PENALTY_SCALE_FACTOR provisional and all downstream score outputs approximate until this process is completed with a labeled driving dataset.',
  dataset_requirements: Object.freeze({
    minimum_eligible_labeled_trips: 2000,
    accepted_label_sources: Object.freeze([
      'licensed fleet or insurer telematics dataset with known risk/outcome labels',
      'internal opted-in calibration labels, used only as a beta proxy until externally validated',
    ]),
    required_trip_fields: Object.freeze([
      'scoring_model_version',
      'distance_km',
      'duration_seconds',
      'quality_flags',
      'penalty_rate_per_km or event counts needed to derive it',
      'target_score or mapped outcome/risk label',
    ]),
    excluded_records: Object.freeze([
      'passenger trips',
      'short trips below trip-quality gates',
      'low-GPS-quality trips',
      'privacy-masked trips where summary features are materially incomplete',
      'test/debug trips',
      'incomplete or crash-recovered app sessions',
    ]),
  }),
  fitting_method: Object.freeze({
    command: 'npm run calibration:fit -- <labels.json> --target=2000',
    implementation: 'scripts/fit-calibration-labels.mjs -> src/lib/calibrationFitting.js',
    train_validation_split: 'Deterministic 80/20 split after eligibility filtering.',
    model: 'Least-squares fit of target score = clamp(100 - penalty_rate_per_km * PENALTY_SCALE_FACTOR, 0, 100).',
    companion_outputs: Object.freeze([
      'FATIGUE_SAFETY_PENALTY_SCALE candidate',
      'route-risk weight candidate',
      'city/highway penalty modifiers',
      'validation MAE/RMSE',
    ]),
  }),
  promotion_criteria: Object.freeze({
    calibration_status_to_commit: 'calibrated',
    minimum_eligible_labeled_trips: 2000,
    required_validation_fields: Object.freeze(['validation_mae', 'validation_rmse', 'dataset_id', 'calibration_date']),
    human_review: 'Review dataset provenance, subgroup errors, feature drift, and validation error before changing calibration_status from provisional to calibrated.',
    commit_requirements: Object.freeze([
      'replace PENALTY_SCALE_FACTOR value with the fitted candidate',
      'record dataset_id, eligible_labeled_trip_count, validation_mae, validation_rmse, and calibration_date',
      'change SCORING_CONSTANTS.PENALTY_SCALE_FACTOR.calibration_status to calibrated',
      'regenerate the content-derived SCORING_VERSION so older approximate scores can be distinguished from calibrated rescored trips',
      'keep score displays approximate for any legacy/unrescored trips whose score_provenance is still approximate',
    ]),
  }),
});

const pendingCalibrationMetadata = Object.freeze({
  scoring_model_version: null,
  dataset_id: null,
  eligible_labeled_trip_count: 0,
  validation_mae: null,
  validation_rmse: null,
  calibration_date: null,
  minimum_labeled_trips: 2000,
  warning: 'Calibration pending: not enough labeled trips yet.',
  calibration_status: 'heuristic_beta',
  calibration_process_id: PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS.process_id,
});

/**
 * @typedef {'provisional'|'calibrated'|'cited'} CalibrationStatus
 * @typedef {{
 *   label: string,
 *   domain: string,
 *   calibration_status?: CalibrationStatus,
 *   calibration_note: string,
 *   affected_metrics?: string[],
 *   setting_key?: string|null,
 *   calibration_metadata?: object|null,
 * }} ScoringConstantMetadata
 */

/**
 * @param {unknown} value
 * @param {ScoringConstantMetadata} metadata
 */
const constant = (value, {
  label,
  domain,
  calibration_status = CALIBRATION_STATUSES.PROVISIONAL,
  calibration_note,
  affected_metrics = [],
  setting_key = null,
  calibration_metadata = null,
}) => Object.freeze({
  value,
  label,
  domain,
  calibration_status,
  calibration_note,
  affected_metrics: Object.freeze(affected_metrics),
  setting_key,
  ...(calibration_metadata ? { calibration_metadata: Object.freeze(calibration_metadata) } : {}),
});

const defaultHourlyRiskProfileValues = Object.freeze([
  60, 60, 60, 60, 60, 20, 20, 35, 35, 35, 20, 20,
  20, 20, 20, 20, 40, 40, 40, 20, 20, 20, 60, 60,
]);

export const DEFAULT_HOURLY_RISK_PROFILE = constant(defaultHourlyRiskProfileValues, {
  label: 'Default hourly risk profile',
  domain: 'historical_context',
  calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
  calibration_note: 'Global default fallback used only when a personal hourly baseline is unavailable. The profile is not geographically, seasonally, or outcome calibrated.',
  affected_metrics: routeRiskMetrics,
  calibration_metadata: Object.freeze({
    ...pendingCalibrationMetadata,
    profile_version: 'default-hourly-risk-profile-v1',
    replacement_policy: 'Change this constant through SCORING_VERSION-gated scoring releases until build-time or backend-provided regional profiles are available.',
  }),
});

/**
 * Single source of truth for domain-significant scoring, evidence, and risk
 * model inputs. "Cited" means an external rationale is documented; it does
 * not claim outcome validation unless the status is changed to "calibrated".
 */
export const SCORING_CONSTANTS = Object.freeze({
  DEFAULT_HOURLY_RISK_PROFILE,
  NIGHT_START_HOUR: constant(22, { label: 'Fallback night start hour', domain: 'trip_score', calibration_note: 'Fallback clock window when solar context is unavailable.', affected_metrics: scoreMetrics }),
  NIGHT_END_HOUR: constant(5, { label: 'Fallback night end hour', domain: 'trip_score', calibration_note: 'Fallback clock window when solar context is unavailable.', affected_metrics: scoreMetrics }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 40
   * @affects score_overall, score_safety, score_smoothness, score_eco
   * @mathRole Multiplies severity-weighted penalty points per km before subtracting from the 100-point base score.
   * @calibrationRequirement At least 2000 eligible labeled trips with distance, penalty-rate features, quality flags, and target outcome or risk labels.
   * @calibrationMethod Regression fit with deterministic train/validation split and confidence intervals from fitCalibrationDataset.
   * @externalReference none
   * @promotionBlocker true
   */
  PENALTY_SCALE_FACTOR: constant(40, {
    label: 'Trip penalty scale factor',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
    calibration_note: 'Uncalibrated - scores are self-consistent estimates, not validated against crash, claim, or insurer data. Follow PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS before treating downstream scores as calibrated.',
    affected_metrics: scoreMetrics,
    calibration_metadata: Object.freeze({
      ...pendingCalibrationMetadata,
      calibration_process: PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS,
    }),
  }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 0.15
   * @affects score_safety, score_overall
   * @mathRole Converts the normalized fatigue proxy into raw Safety deduction points before the fatigue cap is applied.
   * @calibrationRequirement Labeled trips with fatigue exposure features, post-trip fatigue labels, time-on-task context, and safety outcome or expert risk labels.
   * @calibrationMethod Regression against labeled Safety risk with cross-validation and subgroup error checks by drive duration and time of day.
   * @externalReference Williamson & Feyer, Occupational and Environmental Medicine, 2000
   * @literatureAnchor Williamson & Feyer (Occup Environ Med 2000;57:649-655): 18-hour wakefulness → impairment equivalent to BAC 0.05%. Current deduction rate maps maximum fatigue to ~15 Safety points assuming a proportional linear relationship (not validated by the original study). Recalibration against fatigue self-reports may update this anchor.
   * @promotionBlocker true
   */
  FATIGUE_SAFETY_PENALTY_SCALE: constant(0.15, {
    label: 'Fatigue to Safety penalty scale',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.CITED,
    calibration_note: 'Williamson & Feyer (Occup Environ Med, 2000) found 17-19 hours awake can match or exceed 0.05% BAC-equivalent impairment; max fatigue proxy maps conservatively to 15 Safety score deduction points.',
    affected_metrics: ['score_safety', 'score_overall'],
    calibration_metadata: pendingCalibrationMetadata,
  }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 15
   * @affects score_safety, score_overall
   * @mathRole Caps the fatigue-derived Safety deduction so the fatigue proxy cannot subtract more than 15 points.
   * @calibrationRequirement Labeled trips spanning low to extreme fatigue proxy values with Safety outcome labels and enough high-fatigue examples to estimate saturation.
   * @calibrationMethod Threshold search over cap candidates with cross-validation and calibration-curve inspection.
   * @externalReference Williamson & Feyer, Occupational and Environmental Medicine, 2000
   * @literatureAnchor Williamson & Feyer (Occup Environ Med 2000;57:649-655): 18-hour wakefulness → impairment equivalent to BAC 0.05%. Current deduction rate maps maximum fatigue to ~15 Safety points assuming a proportional linear relationship (not validated by the original study). Recalibration against fatigue self-reports may update this anchor.
   * @promotionBlocker true
   */
  FATIGUE_SAFETY_MAX_PENALTY: constant(15, {
    label: 'Fatigue Safety deduction cap',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.CITED,
    calibration_note: 'Caps the fatigue proxy as a flat Safety score deduction after event-rate normalization, preventing trip distance from diluting or amplifying the fatigue effect.',
    affected_metrics: ['score_safety', 'score_overall'],
    calibration_metadata: pendingCalibrationMetadata,
  }),
  ECO_SPEED_STABILITY_CV_MULTIPLIER: constant(150, { label: 'Eco speed stability multiplier', domain: 'trip_score', calibration_note: 'Converts moving-speed variation to a diagnostic eco score.', affected_metrics: ['score_eco', 'score_overall'] }),
  FUEL_BAND_FULL_SCORE_MULTIPLIER: constant(1.1, { label: 'Fuel band score multiplier', domain: 'trip_score', calibration_note: 'Rewards sustained efficient cruising.', affected_metrics: ['score_eco', 'score_overall'] }),
  STOP_START_MIN_HIGHWAY_DISTANCE_KM: constant(5, { label: 'Stop-start highway evidence distance', domain: 'trip_score', calibration_note: 'Minimum route evidence before the GPS-only pattern score is exposed.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MIN_URBAN_DISTANCE_KM: constant(2, { label: 'Stop-start urban evidence distance', domain: 'trip_score', calibration_note: 'Minimum city-speed route evidence before the urban GPS-only pattern score is exposed.', affected_metrics: ['score_safety', 'score_overall', 'defensive_driving_score'] }),
  STOP_START_NORMALISATION_WINDOW_KM: constant(5, { label: 'Stop-start normalization window', domain: 'trip_score', calibration_note: 'Distance normalization for repeated speed-change patterns.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MAX_CYCLES_PER_WINDOW: constant(5, { label: 'Stop-start cycle saturation', domain: 'trip_score', calibration_note: 'Maximum cycles within one normalization window.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT: constant(3, { label: 'Stop-start defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum events before the GPS-only score participates in a blend.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY: constant(3, { label: 'Stop-start highway defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum highway events before the highway GPS-only score participates in a defensive blend.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN: constant(1, { label: 'Stop-start urban defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum city-speed events before the urban GPS-only score participates in a defensive blend.', affected_metrics: ['defensive_driving_score'] }),
  PHONE_USE_SAFETY_WEIGHT: constant(PHONE_USE_SAFETY_BLEND_WEIGHT, { label: 'Phone-use Safety blend weight', domain: 'trip_score', calibration_note: 'Provisional share of confirmed phone-use evidence in Safety.', affected_metrics: ['score_safety', 'score_overall'] }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 0.60
   * @affects close_proximity_score
   * @mathRole Applies exponential decay to the brake-turn alert score for each detected GPS maneuver proxy event.
   * @calibrationRequirement Labeled brake-turn or proximity-risk events with object-distance evidence, route context, and false-positive review outcomes.
   * @calibrationMethod Regression or threshold search over decay candidates with cross-validation against labeled proximity-risk severity.
   * @externalReference none
   * @promotionBlocker true
   */
  CLOSE_PROXIMITY_DECAY_BASE: constant(0.60, { label: 'Brake-turn alert score decay', domain: 'trip_score', calibration_note: 'GPS maneuver diagnostic only; object proximity is not measured.', affected_metrics: ['close_proximity_score'] }),
  TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH: constant(50, { label: 'Tire wear harsh-brake reference speed', domain: 'maintenance', calibration_note: 'Diagnostic wear reference speed.', affected_metrics: ['trip_tire_wear_units'] }),
  TIRE_WEAR_DEFAULT_SPEED_TURN_KMH: constant(40, { label: 'Tire wear turn reference speed', domain: 'maintenance', calibration_note: 'Diagnostic wear reference speed.', affected_metrics: ['trip_tire_wear_units'] }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 1
   * @affects heading_drift_beta_score
   * @mathRole Retains the retired 02:00-05:00 circadian multiplier as a neutral factor so heading drift is not amplified by clock time.
   * @calibrationRequirement Labeled highway attention-drift windows with time-of-day, sleep/fatigue context, GPS quality, and expert-reviewed attention-risk labels.
   * @calibrationMethod Threshold search and cross-validation over time-window multipliers after validating heading drift as an attention proxy.
   * @externalReference none
   * @promotionBlocker true
   */
  HEADING_DRIFT_CIRCADIAN_MULTIPLIER: constant(1, { label: 'Retired heading-drift circadian multiplier', domain: 'trip_score', calibration_note: 'No circadian multiplier is applied. Heading drift is a GPS attention signal only, not a fatigue measurement.', affected_metrics: ['heading_drift_beta_score'] }),
  EVENT_PENALTY_POINTS: constant(Object.freeze({
    harsh_brake: { low: 3, medium: 6, high: 12 },
    rapid_acceleration: { low: 2, medium: 5, high: 10 },
    sharp_turn: { low: 2, medium: 5, high: 10 },
    speeding: { low: 5, medium: 10, high: 20 },
    idle: { low: 1, medium: 3, high: 5 },
    heading_deviation: { low: 0, medium: 0, high: 0 },
    stop_start_pattern: { low: 3, medium: 8, high: 15 },
    tailgate_cycle: { low: 3, medium: 8, high: 15 },
    erratic_speed: { low: 2, medium: 5, high: 10 },
    near_miss: { low: 4, medium: 8, high: 14 },
    close_proximity: { low: 4, medium: 8, high: 14 },
    aggressive_overtake: { low: 12, medium: 25, high: 45 },
    phone_use: { low: 5, medium: 12, high: 20 },
  }), { label: 'Driving event penalty points', domain: 'trip_score', calibration_note: 'Event deductions are product heuristics pending outcome calibration.', affected_metrics: scoreMetrics }),
  OVERALL_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ safety: 0.35, smoothness: 0.30, eco: 0.20, intersection: 0.15 }), { label: 'Overall score blend weights', domain: 'trip_score', calibration_note: 'Composite score weighting policy.', affected_metrics: ['score_overall'] }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 0
   * @affects score_safety, score_overall
   * @mathRole Mirrors the exported lane-changing blend weight inside the registry used to assemble Safety score weights.
   * @calibrationRequirement Dashcam-reviewed lane-change labels with maneuver timing, road curvature, braking context, and manual-review agreement outcomes.
   * @calibrationMethod Threshold search and cross-validation across labeled lane-change detections, false positives, and Safety score deltas.
   * @externalReference none
   * @promotionBlocker true
   */
  LANE_CHANGING_SAFETY_WEIGHT: constant(LANE_CHANGING_SAFETY_WEIGHT, { label: 'Lane-changing Safety blend weight', domain: 'trip_score', calibration_note: 'Diagnostic-only until 200 dashcam-reviewed labeled trips reach at least 85% manual-review agreement and curved-road false positives stay below 10%.', affected_metrics: ['score_safety', 'score_overall'] }),
  SAFETY_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ base: 0.65, stopStart: 0.05, braking: 0.15, compliance: 0.10, phoneUse: PHONE_USE_SAFETY_BLEND_WEIGHT, laneChanging: LANE_CHANGING_SAFETY_WEIGHT }), { label: 'Safety score blend weights', domain: 'trip_score', calibration_note: 'Composite Safety weighting policy; phone-use share is mirrored by PHONE_USE_SAFETY_WEIGHT for legacy UI calculations.', affected_metrics: ['score_safety', 'score_overall'] }),
  SMOOTHNESS_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ base: 0.45, jerk: 0.25, speedVariability: 0.10, brakeOnset: 0.10, cornering: 0.10 }), { label: 'Smoothness score blend weights', domain: 'trip_score', calibration_note: 'Composite Smoothness weighting policy.', affected_metrics: ['score_smoothness', 'score_overall'] }),
  ECO_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ base: 0.40, ecoDriving: 0.40, fuelBand: 0.20 }), { label: 'Eco score blend weights', domain: 'trip_score', calibration_note: 'Composite Eco weighting policy.', affected_metrics: ['score_eco', 'score_overall'] }),
  DEFENSIVE_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ smoothBraking: 0.30, intersection: 0.20, speedVariability: 0.20, stopStart: 0.30 }), { label: 'Defensive-driving blend weights', domain: 'trip_score', calibration_note: 'GPS behavior estimate weighting policy.', affected_metrics: ['defensive_driving_score'] }),
  SPEED_CREEP_ECO_PENALTY_POINTS: constant(Object.freeze({ low: 2, medium: 5, high: 10 }), { label: 'Speed-creep Eco deductions', domain: 'trip_score', calibration_note: 'GPS-derived Eco deductions applied through the normalized base Eco penalty; the exposed speed-creep diagnostic score is rate-normalized per 10 km.', affected_metrics: ['score_eco', 'score_overall'] }),
  PHONE_USE_RISK_DEDUCTION_POINTS: constant(Object.freeze({ none: 0, low: 10, medium: 35, high: 55 }), { label: 'Phone-use risk deductions', domain: 'trip_score', calibration_note: 'Confirmed signal score deductions.', affected_metrics: ['score_safety', 'score_overall'] }),
  WEATHER_SCORE_PENALTY_CAP: constant(12, { label: 'Weather score deduction cap', domain: 'weather_score', calibration_note: 'Weather-context adjustment ceiling.', affected_metrics: ['score_safety', 'score_overall'] }),
  WEATHER_EVENT_PENALTY_SCALE: constant(6, { label: 'Weather event deduction scale', domain: 'weather_score', calibration_note: 'Weather-context adjustment multiplier.', affected_metrics: ['score_safety', 'score_overall'] }),

  HARSH_BRAKE_MS2: constant(3.5, { label: 'Harsh braking threshold', domain: 'trip_threshold', calibration_note: 'Common telematics-style threshold; personalization remains approximate.', affected_metrics: scoreMetrics, setting_key: 'threshold_harsh_brake_ms2' }),
  RAPID_ACCEL_MS2: constant(3.0, { label: 'Rapid acceleration threshold', domain: 'trip_threshold', calibration_note: 'GPS acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_rapid_accel_ms2' }),
  SHARP_TURN_G_LOW: constant(0.35, { label: 'Sharp turn low threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_low' }),
  SHARP_TURN_G_MEDIUM: constant(0.45, { label: 'Sharp turn medium threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_medium' }),
  SHARP_TURN_G_HIGH: constant(0.60, { label: 'Sharp turn high threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_high' }),
  SPEEDING_FALLBACK_KMH: constant(100, { label: 'Fallback speeding threshold', domain: 'trip_threshold', calibration_note: 'Used where posted/open map speed-limit context is unavailable.', affected_metrics: scoreMetrics, setting_key: 'threshold_speeding_kmh' }),
  SPEED_OVER_KMH: constant(5, { label: 'Speed-over-limit allowance', domain: 'trip_threshold', calibration_note: 'Tolerance applied above available or inferred limits.', affected_metrics: scoreMetrics, setting_key: 'threshold_speed_over_kmh' }),
  ECO_CRUISE_MIN_KMH: constant(55, { label: 'Eco cruise minimum', domain: 'trip_threshold', calibration_note: 'Efficient-cruise band assumption.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'threshold_eco_cruise_min_kmh' }),
  ECO_CRUISE_MAX_KMH: constant(110, { label: 'Eco cruise maximum', domain: 'trip_threshold', calibration_note: 'Efficient-cruise band assumption.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'threshold_eco_cruise_max_kmh' }),
  ECO_CRUISE_SCORE_MULTIPLIER: constant(130, { label: 'Eco cruise score multiplier', domain: 'trip_threshold', calibration_note: 'Full credit near 77 percent cruising samples.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'eco_cruise_score_multiplier' }),
  ECO_IDLE_PENALTY_MULTIPLIER: constant(150, { label: 'Eco idle penalty multiplier', domain: 'trip_threshold', calibration_note: 'Avoidable-idle score curve.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'eco_idle_penalty_multiplier' }),
  ECO_IDLE_MAX_PENALTY: constant(25, { label: 'Eco idle penalty cap', domain: 'trip_threshold', calibration_note: 'Maximum score deduction from avoidable idle.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'eco_idle_max_penalty' }),
  ECO_MIN_MOVING_KMH: constant(15, { label: 'Eco moving speed floor', domain: 'trip_threshold', calibration_note: 'Suppresses crawl and GPS jitter samples.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'eco_min_moving_kmh' }),
  IDLE_SPEED_KMH: constant(5, { label: 'Idle speed floor', domain: 'trip_threshold', calibration_note: 'Speed below which a GPS sample is considered idle.', affected_metrics: ['score_eco', 'score_overall'] }),
  IDLE_EVENT_SECONDS: constant(90, { label: 'Idle event duration', domain: 'trip_threshold', calibration_note: 'Minimum sustained idle duration.', affected_metrics: ['score_eco', 'score_overall'], setting_key: 'threshold_idle_seconds' }),
  LONG_DRIVE_MINUTES: constant(120, { label: 'Long-drive duration', domain: 'trip_threshold', calibration_note: 'Trip fatigue proxy boundary.', affected_metrics: ['fatigue_risk_score'], setting_key: 'threshold_long_drive_minutes' }),
  MIN_TRIP_DISTANCE_KM: constant(0.1, { label: 'Minimum trip distance', domain: 'trip_threshold', calibration_note: 'Noise filter for stored trips.', affected_metrics: [] }),
  MIN_TRIP_DURATION_SECONDS: constant(30, { label: 'Minimum trip duration', domain: 'trip_threshold', calibration_note: 'Noise filter for stored trips.', affected_metrics: [] }),
  MAX_GPS_ACCURACY_M: constant(50, { label: 'Maximum GPS error radius', domain: 'trip_threshold', calibration_note: 'GPS quality filter.', affected_metrics: scoreMetrics }),
  MIN_POINT_DISTANCE_M: constant(8, { label: 'Minimum GPS point movement', domain: 'trip_threshold', calibration_note: 'GPS drift suppression.', affected_metrics: scoreMetrics }),
  MIN_TRUSTED_SPEED_KMH: constant(18, { label: 'Minimum trusted GPS speed', domain: 'trip_threshold', calibration_note: 'Suppresses low-speed sensor noise.', affected_metrics: scoreMetrics }),
  STATIONARY_SPEED_KMH: constant(5, { label: 'Stationary speed threshold', domain: 'trip_threshold', calibration_note: 'GPS crawl suppression.', affected_metrics: scoreMetrics }),
  TRAFFIC_STOP_SPEED_KMH: constant(10, { label: 'Traffic-stop speed threshold', domain: 'trip_threshold', calibration_note: 'Intersection behavior proxy.', affected_metrics: ['intersection_score', 'score_overall'] }),
  TRAFFIC_STOP_MIN_SECONDS: constant(4, { label: 'Traffic-stop minimum duration', domain: 'trip_threshold', calibration_note: 'Intersection behavior proxy.', affected_metrics: ['intersection_score', 'score_overall'] }),
  TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS: constant(10, { label: 'Traffic-stop maximum sample gap', domain: 'trip_threshold', calibration_note: 'Intersection behavior proxy.', affected_metrics: ['intersection_score', 'score_overall'] }),
  INTERSECTION_MIN_DISTANCE_KM: constant(0.5, { label: 'Intersection evidence distance', domain: 'trip_threshold', calibration_note: 'Minimum evidence distance for intersection scoring.', affected_metrics: ['intersection_score', 'score_overall'] }),
  MAX_SPEED_SPIKE_DELTA_KMH: constant(45, { label: 'Speed spike absolute filter', domain: 'trip_threshold', calibration_note: 'Filters improbable GPS jumps.', affected_metrics: scoreMetrics }),
  MAX_SPEED_SPIKE_RATIO: constant(1.8, { label: 'Speed spike ratio filter', domain: 'trip_threshold', calibration_note: 'Filters improbable GPS jumps.', affected_metrics: scoreMetrics }),
  MAX_ALTITUDE_ACCURACY_M: constant(40, { label: 'Altitude accuracy filter', domain: 'trip_threshold', calibration_note: 'Hill-score GPS altitude quality gate.', affected_metrics: ['hill_driving_score'] }),
  MIN_HILL_SEGMENT_DISTANCE_M: constant(5, { label: 'Hill minimum segment distance', domain: 'trip_threshold', calibration_note: 'Altitude-derived hill scoring proxy.', affected_metrics: ['hill_driving_score'] }),
  HILL_GRADE_THRESHOLD_PCT: constant(5, { label: 'Hill grade threshold', domain: 'trip_threshold', calibration_note: 'Altitude-derived hill scoring proxy.', affected_metrics: ['hill_driving_score'] }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 2.5
   * @affects hill_driving_score
   * @mathRole Defines the acceleration threshold above which a hill-driving segment is counted as an infraction.
   * @calibrationRequirement Labeled hill-driving segments with altitude quality, road grade, acceleration traces, vehicle context, and expert smoothness/risk labels.
   * @calibrationMethod Threshold search with cross-validation by grade bucket, speed bucket, and altitude accuracy.
   * @externalReference none
   * @promotionBlocker true
   */
  HILL_ACCEL_THRESHOLD_MS2: constant(2.5, { label: 'Hill acceleration threshold', domain: 'trip_threshold', calibration_note: 'Altitude-derived hill scoring proxy.', affected_metrics: ['hill_driving_score'] }),
  HILL_INFRACTION_PENALTY_POINTS: constant(10, { label: 'Legacy hill infraction deduction', domain: 'trip_threshold', calibration_note: 'Legacy absolute-count hill scoring deduction retained for provenance comparison only.', affected_metrics: ['hill_driving_score'] }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 8
   * @affects hill_driving_score, score_safety
   * @mathRole Converts each inferred hill infraction per hill-driving km into score deduction points.
   * @calibrationRequirement Labeled hill-driving trips with inferred infraction counts, hill-route distance, grade, altitude quality, and expert hill-control labels.
   * @calibrationMethod Regression over per-km infraction rates with cross-validation and residual checks by terrain grade.
   * @externalReference none
   * @promotionBlocker true
   */
  HILL_INFRACTION_PENALTY_POINTS_PER_KM: constant(8, {
    label: 'Hill driving penalty per infraction per km',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
    calibration_note: 'Provisional rate; replaces HILL_INFRACTION_PENALTY_POINTS after per-km normalization redesign.',
    affected_metrics: ['hill_driving_score', 'score_safety'],
  }),
  MIN_SPEED_RAPID_ACCEL_KMH: constant(5, { label: 'Rapid acceleration minimum speed', domain: 'trip_threshold', calibration_note: 'GPS event quality gate.', affected_metrics: scoreMetrics, setting_key: 'min_speed_rapid_accel_kmh' }),
  MIN_SPEED_HARSH_BRAKE_KMH: constant(25, { label: 'Harsh brake minimum speed', domain: 'trip_threshold', calibration_note: 'GPS event quality gate.', affected_metrics: scoreMetrics, setting_key: 'min_speed_harsh_brake_kmh' }),
  STOP_START_DECEL_MS2: constant(2.5, { label: 'Stop-start deceleration threshold', domain: 'trip_threshold', calibration_note: 'GPS-only speed pattern detector.', affected_metrics: ['defensive_driving_score'], setting_key: 'threshold_stop_start_decel_ms2' }),
  STOP_START_MIN_SPEED_KMH: constant(40, { label: 'Stop-start minimum speed', domain: 'trip_threshold', calibration_note: 'GPS-only speed pattern detector.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_CRUISE_SECONDS: constant(4, { label: 'Stop-start cruise period', domain: 'trip_threshold', calibration_note: 'GPS-only speed pattern detector.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_SPEED_DROP_KMH: constant(10, { label: 'Stop-start speed drop', domain: 'trip_threshold', calibration_note: 'GPS-only speed pattern detector.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_URBAN_DECEL_MS2: constant(1.4, { label: 'Urban stop-start deceleration threshold', domain: 'trip_threshold', calibration_note: 'Lower GPS-only speed pattern threshold for city-speed trips.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_URBAN_MIN_SPEED_KMH: constant(25, { label: 'Urban stop-start minimum speed', domain: 'trip_threshold', calibration_note: 'City-speed GPS-only pattern detector minimum.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_URBAN_CRUISE_SECONDS: constant(2, { label: 'Urban stop-start cruise period', domain: 'trip_threshold', calibration_note: 'Shorter city-speed cruise period before a stop-start pattern can be detected.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_URBAN_SPEED_DROP_KMH: constant(6, { label: 'Urban stop-start speed drop', domain: 'trip_threshold', calibration_note: 'Smaller city-speed drop needed for a GPS-only stop-start pattern.', affected_metrics: ['defensive_driving_score'] }),
  HEADING_DEVIATION_MIN_SPEED_KMH: constant(50, { label: 'Heading event minimum speed', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH: constant(80, { label: 'Heading event highway speed', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MIN_TURN_RATE_DEG_S: constant(3, { label: 'Heading event minimum turn rate', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MAX_TURN_RATE_DEG_S: constant(20, { label: 'Heading event maximum turn rate', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MIN_WINDOW_SECONDS: constant(6, { label: 'Heading event minimum window', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_STRAIGHT_STD_MAX_DEG: constant(4, { label: 'Heading straight-road deviation cap', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS: constant(200, { label: 'Heading event context suppression distance', domain: 'trip_threshold', calibration_note: 'GPS heading-event diagnostic detector.', affected_metrics: ['score_smoothness'] }),
  CORNERING_MIN_SPEED_KMH: constant(25, { label: 'Cornering minimum speed', domain: 'trip_threshold', calibration_note: 'GPS cornering estimate quality gate.', affected_metrics: ['cornering_consistency_score', 'score_smoothness'] }),
  MERGE_ENTRY_SPEED_KMH: constant(65, { label: 'Merge entry speed', domain: 'trip_threshold', calibration_note: 'GPS merge estimate.', affected_metrics: ['merge_score'] }),
  MERGE_EXIT_SPEED_KMH: constant(85, { label: 'Merge exit speed', domain: 'trip_threshold', calibration_note: 'GPS merge estimate.', affected_metrics: ['merge_score'] }),
  PARKING_LOOKBACK_SECONDS: constant(90, { label: 'Parking approach lookback', domain: 'trip_threshold', calibration_note: 'GPS parking-approach estimate.', affected_metrics: ['parking_approach_score'] }),
  MAX_TERMINAL_IDLE_SECONDS: constant(1800, { label: 'Terminal idle maximum', domain: 'trip_threshold', calibration_note: 'Trip-ending idle cap.', affected_metrics: ['score_eco'] }),
  MANOEUVRE_ALERT_BRAKE_MS2: constant(4.0, { label: 'Brake-turn alert braking threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; not object proximity.', affected_metrics: ['close_proximity_score'], setting_key: 'threshold_manoeuvre_alert_brake_ms2' }),
  MANOEUVRE_ALERT_TURN_DEG_S: constant(25, { label: 'Brake-turn alert heading threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; not object proximity.', affected_metrics: ['close_proximity_score'], setting_key: 'threshold_manoeuvre_alert_turn_degs' }),
  HEADING_DRIFT_STD_DEG: constant(8, { label: 'GPS attention signal threshold', domain: 'trip_threshold', calibration_note: 'GPS attention signal only - not a fatigue measurement.', affected_metrics: ['heading_drift_beta_score'], setting_key: 'threshold_heading_drift_std_degs' }),
  PHONE_MICRO_STEER_COUNT: constant(6, { label: 'Phone proxy oscillation count', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'threshold_phone_proxy_oscillations' }),
  PHONE_MICRO_STEER_WINDOW_S: constant(15, { label: 'Phone proxy window', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_micro_steer_window_s' }),
  PHONE_PROXY_MAX_ACCURACY_M: constant(20, { label: 'Phone proxy GPS accuracy gate', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_proxy_max_accuracy_m' }),
  PHONE_CREEP_RATE_KMH_S: constant(1.5, { label: 'Phone proxy speed-creep rate', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_creep_rate_kmh_s' }),
  PHONE_LANE_DRIFT_DEG: constant(8, { label: 'Phone proxy drift threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_lane_drift_deg' }),
  PHONE_COUPLING_THRESHOLD: constant(0.15, { label: 'Phone proxy coupling threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_coupling_threshold' }),
  PHONE_CONFIDENCE_THRESHOLD: constant(0.40, { label: 'Phone proxy confidence threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; confirmed scoring requires Usage Access.', affected_metrics: [], setting_key: 'phone_confidence_threshold' }),
  PHONE_LOW_SENSITIVITY_CONFIDENCE_THRESHOLD: constant(0.60, { label: 'Phone proxy low-sensitivity confidence', domain: 'trip_threshold', calibration_note: 'GPS diagnostic sensitivity preset only.', affected_metrics: [] }),
  PHONE_HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD: constant(0.25, { label: 'Phone proxy high-sensitivity confidence', domain: 'trip_threshold', calibration_note: 'GPS diagnostic sensitivity preset only.', affected_metrics: [] }),
  PHONE_MIN_WINDOW_S: constant(4, { label: 'Phone proxy minimum window', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; confirmed scoring requires Usage Access.', affected_metrics: [], setting_key: 'phone_min_window_s' }),
  SPEED_CREEP_THRESHOLD_KMH: constant(5, { label: 'Speed-creep threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic behavior trigger.', affected_metrics: ['score_eco'], setting_key: 'threshold_speed_creep_kmh' }),
  LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M: constant(12, { label: 'Lane-change curved-road suppression', domain: 'trip_threshold', calibration_note: 'Suppresses lane-change detections while route curvature remains above this deg/100m threshold.', affected_metrics: ['lane_changing_score'] }),
  LANE_CHANGE_CURVE_SUPPRESSION_SECONDS: constant(6, { label: 'Lane-change curve suppression window', domain: 'trip_threshold', calibration_note: 'Minimum continuous curved-road duration before lane-change detections are suppressed.', affected_metrics: ['lane_changing_score'] }),
  LANE_CHANGE_REGIONAL_YAW_DEG_S: constant(2.4, { label: 'Lane-change regional-road yaw threshold', domain: 'trip_threshold', calibration_note: 'Diagnostic IMU yaw threshold for lane-change detection below highway speed.', affected_metrics: ['lane_changing_score'] }),
  LANE_CHANGE_HIGHWAY_YAW_DEG_S: constant(1.8, { label: 'Lane-change highway yaw threshold', domain: 'trip_threshold', calibration_note: 'Diagnostic IMU yaw threshold for lane-change detection above 100 km/h.', affected_metrics: ['lane_changing_score'] }),
  LANE_CHANGE_HIGHWAY_SPEED_KMH: constant(100, { label: 'Lane-change highway speed split', domain: 'trip_threshold', calibration_note: 'Speed split for applying highway vs regional-road IMU yaw thresholds.', affected_metrics: ['lane_changing_score'] }),
  OVERTAKE_ACCEL_THRESHOLD_MS2: constant(3.0, { label: 'Overtake development acceleration threshold', domain: 'trip_threshold', calibration_note: 'Development diagnostic only; hidden from user-facing Trip Detail and excluded from scores.', affected_metrics: [], setting_key: 'threshold_overtake_accel_ms2' }),
  OVERTAKE_MIN_BASELINE_SPEED_KMH: constant(80, { label: 'Overtake development baseline speed', domain: 'trip_threshold', calibration_note: 'Development diagnostic only; hidden from user-facing Trip Detail and excluded from scores.', affected_metrics: [] }),
  OVERTAKE_MIN_STRAIGHT_DISTANCE_KM: constant(1, { label: 'Overtake development straight distance', domain: 'trip_threshold', calibration_note: 'Development diagnostic only; hidden from user-facing Trip Detail and excluded from scores.', affected_metrics: [] }),
  OVERTAKE_STRAIGHT_STD_MAX_DEG: constant(4, { label: 'Overtake development straight heading deviation', domain: 'trip_threshold', calibration_note: 'Development diagnostic only; hidden from user-facing Trip Detail and excluded from scores.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_HARSH_BRAKE_MS2: constant(4.5, { label: 'Calibration fallback harsh brake threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_RAPID_ACCEL_MS2: constant(3.5, { label: 'Calibration fallback rapid acceleration threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_SHARP_TURN_G_LOW: constant(0.3, { label: 'Calibration fallback low turn threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),

  PHONE_HIGH_DURATION_SECONDS: constant(90, { label: 'High phone-use duration', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_HIGH_SPEED_KMH: constant(100, { label: 'High phone-use speed', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_MEDIUM_DURATION_SECONDS: constant(20, { label: 'Medium phone-use duration', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_MEDIUM_SPEED_KMH: constant(50, { label: 'Medium phone-use speed', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_HIGH: constant(20, { label: 'High phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_MEDIUM: constant(10, { label: 'Medium phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_LOW: constant(4, { label: 'Low phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),

  DAILY_FATIGUE_ONSET_MINUTES: constant(90, { label: 'Daily fatigue onset', domain: 'fatigue', calibration_note: 'Time-on-task study supplies context, but score remains approximate.', affected_metrics: ['fatigue_risk_score', 'score_safety', 'score_overall'] }),
  DAILY_RECOVERY_BREAK_MINUTES: constant(30, { label: 'Daily fatigue recovery break', domain: 'fatigue', calibration_note: 'Break study supplies context, but recovery model remains approximate.', affected_metrics: ['fatigue_risk_score'] }),
  DAILY_FULL_RECOVERY_BREAK_MINUTES: constant(180, { label: 'Daily full-recovery cap', domain: 'fatigue', calibration_note: 'Product interpolation cap, not a recovery guarantee.', affected_metrics: ['fatigue_risk_score'] }),
  DAILY_FATIGUE_SCORE_AT_ONSET: constant(5, { label: 'Daily fatigue onset score', domain: 'fatigue', calibration_note: 'Heuristic score step.', affected_metrics: ['fatigue_risk_score'] }),

  /**
   * @calibration PROVISIONAL
   * @currentValue 20
   * @affects route_risk_score, pre_trip_readiness_score
   * @mathRole Weights verified historical driving-event density when converting route segment context into risk points.
   * @calibrationRequirement Route segments with historical event summaries, exposure distance, weather/time context, and collision, claim, or reviewed route-risk labels.
   * @calibrationMethod Regression over segment-level route-risk features with cross-validation and calibration curves by route class.
   * @externalReference none
   * @promotionBlocker true
   */
  ROUTE_RISK_EVENT_WEIGHT: constant(20, { label: 'Route event risk weight', domain: 'route_risk', calibration_note: 'Segment risk heuristic; not incident calibrated.', affected_metrics: routeRiskMetrics, calibration_metadata: pendingCalibrationMetadata }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 40
   * @affects route_risk_score, pre_trip_readiness_score
   * @mathRole Weights historical harsh-event density more heavily than ordinary verified events in route-risk scoring.
   * @calibrationRequirement Route segments with harsh-event summaries, exposure distance, weather/time context, and collision, claim, or reviewed route-risk labels.
   * @calibrationMethod Regression over segment-level route-risk features with cross-validation and calibration curves by route class.
   * @externalReference none
   * @promotionBlocker true
   */
  ROUTE_RISK_HARSH_WEIGHT: constant(40, { label: 'Route harsh-event risk weight', domain: 'route_risk', calibration_note: 'Segment risk heuristic; not incident calibrated.', affected_metrics: routeRiskMetrics, calibration_metadata: pendingCalibrationMetadata }),
  ROUTE_RISK_SPEED_START_KMH: constant(100, { label: 'Route speed-risk start', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  ROUTE_RISK_SPEED_FULL_KMH: constant(160, { label: 'Route speed-risk saturation speed', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  ROUTE_RISK_SPEED_MAX_POINTS: constant(15, { label: 'Route speed-risk maximum points', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 5
   * @affects route_risk_score, pre_trip_readiness_score
   * @mathRole Saturates the normalized historical event-density contribution once a route reaches five verified events per km.
   * @calibrationRequirement Route exposure datasets with verified event density, distance normalization, repeated-route coverage, and route-risk or incident labels.
   * @calibrationMethod Threshold search with cross-validation over density saturation candidates and route-class subgroup checks.
   * @externalReference none
   * @promotionBlocker true
   */
  PREDICTIVE_EVENT_DENSITY_MAX_PER_KM: constant(5, { label: 'Historical context event-density saturation', domain: 'historical_context', calibration_note: 'Not calibrated to collision or casualty outcomes.', affected_metrics: routeRiskMetrics }),
  /**
   * @calibration PROVISIONAL
   * @currentValue 5
   * @affects route_risk_score, pre_trip_readiness_score
   * @mathRole Saturates repeated-event area risk once five nearby danger zones are found around the candidate route.
   * @calibrationRequirement Route exposure datasets with spatially indexed repeated-event areas, matched route segments, and incident or reviewed route-risk labels.
   * @calibrationMethod Threshold search with spatial cross-validation and sensitivity checks for GPS cell snapping radius.
   * @externalReference none
   * @promotionBlocker true
   */
  PREDICTIVE_DANGER_ZONE_SATURATION_COUNT: constant(5, { label: 'Historical context repeated-area saturation', domain: 'historical_context', calibration_note: 'Not calibrated to collision or casualty outcomes.', affected_metrics: routeRiskMetrics }),
  PREDICTIVE_ROUTE_RISK_POLICY: constant(Object.freeze({
    RECENT_TRIP_WINDOW: 20,
    MIN_EVENT_DENSITY_TRIP_KM: 0.5,
    UNVERIFIED_BRAKE_TURN_EVENT_WEIGHT: 1,
    EVENT_DENSITY_WEIGHT: 0.25,
    MAX_DANGER_ZONE_RISK: 30,
    DANGER_ZONE_DECAY_COUNT: 3,
    WEATHER_WEIGHT: 0.15,
    BASELINE_SCORE_WEIGHT: 0.35,
    DANGER_ZONE_WEIGHT: 0.15,
    TIME_WEIGHT: 0.10,
    LATE_NIGHT_TIME_RISK: 100,
    EVENING_RUSH_TIME_RISK: 55,
    PERSONAL_TIME_RISK_SCALE: 1,
    FALLBACK_TIME_RISK_SCALE: 1,
    MIN_PERSONAL_CONFIDENCE: 0.3,
    MIN_TEXT_CONFIDENCE: 0.5,
    MIN_HOURLY_RISK_HOURS: 6,
    MIN_PERSONAL_WINDOW_TRIP_COUNT: 3,
    WINDOW_LOOKAHEAD_HOURS: 12,
    RISK_EQUIVALENT_MARGIN: 5,
    PROXIMITY_METERS: 2000,
  }), { label: 'Historical context-risk policy', domain: 'historical_context', calibration_note: 'Context weighting and display gates are not outcome-calibrated route prediction.', affected_metrics: routeRiskMetrics }),
  PRE_TRIP_READINESS_POLICY: constant(Object.freeze({
    MIN_TRIPS_FOR_BUCKET: 3,
    MIN_TRIPS_FOR_DAY: 2,
    MIN_TRIPS_FOR_CALIBRATION: 5,
    FULL_CALIBRATION_TRIPS: 30,
    FALLBACK_NIGHT_RISK: 60,
    FALLBACK_MORNING_RUSH_RISK: 35,
    FALLBACK_EVENING_RUSH_RISK: 40,
    FALLBACK_DEFAULT_RISK: 20,
    HIGH_RISK_FLOOR: 65,
    MODERATE_RISK_FLOOR: 40,
    GATE_ADJUSTMENT_MAX: 5,
    TREND_WINDOW: 20,
    RECENT_TRIP_DAYS: 90,
  }), { label: 'Pre-trip readiness policy', domain: 'pre_trip_risk', calibration_note: 'Readiness thresholds are product heuristics.', affected_metrics: ['pre_trip_readiness_score'] }),
  PRE_TRIP_RISK_WEIGHTS: constant(Object.freeze({
    timeOfDay: 0.14, dayOfWeek: 0.10, recentTrend: 0.18, dailyFatigue: 0.20, lastTripOutcome: 0.12,
    weather: 0.08, dangerZones: 0.06, routeForecast: 0.08, recentRest: 0.04,
  }), { label: 'Pre-trip risk signal weights', domain: 'pre_trip_risk', calibration_note: 'Readiness blend is not outcome-calibrated.', affected_metrics: ['pre_trip_readiness_score'] }),
  PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO: constant(0.5, { label: 'Pre-trip signal redistribution ratio', domain: 'pre_trip_risk', calibration_note: 'Insufficient-evidence fallback weighting.', affected_metrics: ['pre_trip_readiness_score'] }),
  PRE_TRIP_REDISTRIBUTION_TARGETS: constant(Object.freeze({ recentTrend: 0.6, dailyFatigue: 0.4 }), { label: 'Pre-trip redistribution targets', domain: 'pre_trip_risk', calibration_note: 'Insufficient-evidence fallback weighting.', affected_metrics: ['pre_trip_readiness_score'] }),
  PRE_TRIP_SIGNAL_GATES: constant(Object.freeze({
    moderateTimeOfDay: 60, highTimeOfDay: 80, moderateRouteForecast: 40, highRouteForecast: 65,
    moderateDailyFatigue: 70, highDailyFatigue: 90, moderateRecentRest: 80, moderateWeather: 60, moderateDangerZones: 70,
  }), { label: 'Pre-trip signal display gates', domain: 'pre_trip_risk', calibration_note: 'Readiness alert gates are product heuristics.', affected_metrics: ['pre_trip_readiness_score'] }),

  UBI_NIGHT_MULTIPLIER: constant(150, { label: 'UBI night-driving multiplier', domain: 'ubi', calibration_note: 'Personal feedback approximation; not insurer validated.', affected_metrics: ubiMetrics }),
  UBI_BRAKING_PENALTY_PER_100KM: constant(8, { label: 'UBI braking deduction', domain: 'ubi', calibration_note: 'Personal feedback approximation; not insurer validated.', affected_metrics: ubiMetrics }),
  UBI_ACCEL_PENALTY_PER_100KM: constant(8, { label: 'UBI acceleration deduction', domain: 'ubi', calibration_note: 'Personal feedback approximation; not insurer validated.', affected_metrics: ubiMetrics }),
  UBI_CORNERING_PENALTY_PER_100KM: constant(6, { label: 'UBI cornering deduction', domain: 'ubi', calibration_note: 'Personal feedback approximation; not insurer validated.', affected_metrics: ubiMetrics }),
  UBI_SPEED_PENALTY_PER_100KM: constant(10, { label: 'UBI speeding deduction', domain: 'ubi', calibration_note: 'Personal feedback approximation; not insurer validated.', affected_metrics: ubiMetrics }),
  UBI_MIN_REPORT_DISTANCE_KM: constant(50, { label: 'UBI report minimum distance', domain: 'ubi', calibration_note: 'Minimum display evidence threshold.', affected_metrics: ubiMetrics }),
  UBI_OPTIMAL_ANNUAL_KM: constant(10000, { label: 'UBI annual mileage optimum', domain: 'ubi', calibration_note: 'User-adjustable mileage assumption.', affected_metrics: ubiMetrics, setting_key: 'ubi_optimal_annual_km' }),
  UBI_MILEAGE_SPREAD_KM: constant(8000, { label: 'UBI mileage score spread', domain: 'ubi', calibration_note: 'User-adjustable mileage assumption.', affected_metrics: ubiMetrics, setting_key: 'ubi_mileage_score_spread_km' }),
  UBI_CATEGORY_WEIGHTS: constant(Object.freeze({ mileage: 0.15, timeOfDay: 0.20, hardBraking: 0.30, acceleration: 0.20, cornering: 0.05, speedCompliance: 0.10 }), { label: 'UBI category weights', domain: 'ubi', calibration_note: 'Personal report weighting, not insurer validated.', affected_metrics: ubiMetrics }),
});

export function scoringValue(key) {
  return SCORING_CONSTANTS[key]?.value;
}

const thresholdKeys = [
  'HARSH_BRAKE_MS2', 'RAPID_ACCEL_MS2', 'SHARP_TURN_G_LOW', 'SHARP_TURN_G_MEDIUM', 'SHARP_TURN_G_HIGH',
  'SPEEDING_FALLBACK_KMH', 'SPEED_OVER_KMH', 'ECO_CRUISE_MIN_KMH', 'ECO_CRUISE_MAX_KMH',
  'ECO_CRUISE_SCORE_MULTIPLIER', 'ECO_IDLE_PENALTY_MULTIPLIER', 'ECO_IDLE_MAX_PENALTY', 'ECO_MIN_MOVING_KMH',
  'IDLE_SPEED_KMH', 'IDLE_EVENT_SECONDS', 'LONG_DRIVE_MINUTES', 'MIN_TRIP_DISTANCE_KM', 'MIN_TRIP_DURATION_SECONDS',
  'MAX_GPS_ACCURACY_M', 'MIN_POINT_DISTANCE_M', 'MIN_TRUSTED_SPEED_KMH', 'STATIONARY_SPEED_KMH',
  'TRAFFIC_STOP_SPEED_KMH', 'TRAFFIC_STOP_MIN_SECONDS', 'TRAFFIC_STOP_MAX_SAMPLE_GAP_SECONDS', 'INTERSECTION_MIN_DISTANCE_KM',
  'MAX_SPEED_SPIKE_DELTA_KMH', 'MAX_SPEED_SPIKE_RATIO', 'MAX_ALTITUDE_ACCURACY_M', 'MIN_HILL_SEGMENT_DISTANCE_M',
  'HILL_GRADE_THRESHOLD_PCT', 'HILL_ACCEL_THRESHOLD_MS2', 'HILL_INFRACTION_PENALTY_POINTS', 'HILL_INFRACTION_PENALTY_POINTS_PER_KM',
  'MIN_SPEED_RAPID_ACCEL_KMH', 'MIN_SPEED_HARSH_BRAKE_KMH', 'STOP_START_DECEL_MS2', 'STOP_START_MIN_SPEED_KMH',
  'STOP_START_CRUISE_SECONDS', 'STOP_START_SPEED_DROP_KMH', 'STOP_START_URBAN_DECEL_MS2',
  'STOP_START_URBAN_MIN_SPEED_KMH', 'STOP_START_URBAN_CRUISE_SECONDS', 'STOP_START_URBAN_SPEED_DROP_KMH', 'HEADING_DEVIATION_MIN_SPEED_KMH',
  'HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH', 'HEADING_DEVIATION_MIN_TURN_RATE_DEG_S', 'HEADING_DEVIATION_MAX_TURN_RATE_DEG_S',
  'HEADING_DEVIATION_MIN_WINDOW_SECONDS', 'HEADING_DEVIATION_STRAIGHT_STD_MAX_DEG', 'HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS',
  'CORNERING_MIN_SPEED_KMH', 'MERGE_ENTRY_SPEED_KMH', 'MERGE_EXIT_SPEED_KMH', 'PARKING_LOOKBACK_SECONDS',
  'MAX_TERMINAL_IDLE_SECONDS', 'MANOEUVRE_ALERT_BRAKE_MS2', 'MANOEUVRE_ALERT_TURN_DEG_S',
  'HEADING_DRIFT_STD_DEG', 'PHONE_MICRO_STEER_COUNT', 'PHONE_MICRO_STEER_WINDOW_S', 'PHONE_PROXY_MAX_ACCURACY_M',
  'PHONE_CREEP_RATE_KMH_S', 'PHONE_LANE_DRIFT_DEG', 'PHONE_COUPLING_THRESHOLD', 'PHONE_CONFIDENCE_THRESHOLD', 'PHONE_MIN_WINDOW_S',
  'LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M', 'LANE_CHANGE_CURVE_SUPPRESSION_SECONDS', 'LANE_CHANGE_REGIONAL_YAW_DEG_S',
  'LANE_CHANGE_HIGHWAY_YAW_DEG_S', 'LANE_CHANGE_HIGHWAY_SPEED_KMH',
];

export const TRIP_THRESHOLD_DEFAULTS = Object.freeze({
  ...Object.fromEntries(thresholdKeys.map((key) => [key, scoringValue(key)])),
  threshold_phone_proxy_oscillations: scoringValue('PHONE_MICRO_STEER_COUNT'),
  threshold_speed_creep_kmh: scoringValue('SPEED_CREEP_THRESHOLD_KMH'),
  threshold_overtake_accel_ms2: scoringValue('OVERTAKE_ACCEL_THRESHOLD_MS2'),
  OVERTAKE_MIN_BASELINE_SPEED_KMH: scoringValue('OVERTAKE_MIN_BASELINE_SPEED_KMH'),
  OVERTAKE_MIN_STRAIGHT_DISTANCE_KM: scoringValue('OVERTAKE_MIN_STRAIGHT_DISTANCE_KM'),
  OVERTAKE_STRAIGHT_HEADING_STD_MAX_DEG: scoringValue('OVERTAKE_STRAIGHT_STD_MAX_DEG'),
});

export function getProvisionalScoringConstants(constants = SCORING_CONSTANTS) {
  return Object.entries(constants || {})
    .filter(([, entry]) => entry?.calibration_status === CALIBRATION_STATUSES.PROVISIONAL)
    .map(([key, entry]) => ({ key, ...entry }));
}

export function calibrationEntryForSetting(settingKey) {
  const aliases = {
    phone_micro_steer_count: 'PHONE_MICRO_STEER_COUNT',
  };
  const match = aliases[settingKey]
    ? [aliases[settingKey], SCORING_CONSTANTS[aliases[settingKey]]]
    : Object.entries(SCORING_CONSTANTS).find(([, entry]) => entry.setting_key === settingKey);
  return match ? { key: match[0], ...match[1] } : null;
}

export function hasProvisionalCalibration(metricKeys = [], constants = SCORING_CONSTANTS) {
  const metrics = new Set(Array.isArray(metricKeys) ? metricKeys : [metricKeys]);
  if (metrics.size === 0) return getProvisionalScoringConstants(constants).length > 0;
  return getProvisionalScoringConstants(constants).some((entry) => (
    Array.isArray(entry.affected_metrics) && entry.affected_metrics.some((metric) => metrics.has(metric))
  ));
}

export function calibrationStatusForMetrics(metricKeys = [], constants = SCORING_CONSTANTS) {
  return hasProvisionalCalibration(metricKeys, constants)
    ? SCORE_OUTPUT_CALIBRATION_STATUSES.APPROXIMATE
    : SCORE_OUTPUT_CALIBRATION_STATUSES.CALIBRATED;
}
