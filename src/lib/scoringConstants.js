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

/**
 * Revision marker for the scoring *calculation code*, as opposed to the constants below.
 *
 * `scripts/generate-scoring-version.mjs` derives SCORING_VERSION by hashing the exports of
 * this module only. That means a change to a formula in `tripEngine.js` — a penalty moved
 * from a per-km pool to a flat deduction, a corrected denominator, a removed double-count —
 * shifts every existing user's stored scores while SCORING_VERSION stays put, so no trip is
 * flagged as scored by a different model and nothing offers to re-score.
 *
 * This constant closes that gap: it is part of the hashed payload, so incrementing it
 * regenerates SCORING_VERSION and the existing rescore-mismatch machinery
 * (`localTripRepository` / Settings score-migration summary) picks the change up.
 *
 * Increment it in the same commit as any change to how a score is computed, and record the
 * change below. Do not increment it for refactors that provably cannot move a score.
 *
 * Revision history:
 *   1 - baseline; all scoring code prior to the calculation audit.
 *   2 - audit fixes: night-driving penalty applied as a flat post-normalize deduction
 *       instead of being diluted by trip distance; confirmed phone use no longer both
 *       penalized as an event and blended as an independent component; speed-limit
 *       compliance divided by total posted-limit points instead of over-limit points only.
 *   3 - detection audit:
 *       - computeSmoothedAccelerations paired a single-step speed delta with a two-step
 *         time span, reporting exactly half the true rate for any sustained event. A 5 m/s2
 *         stop measured as 2.5 and never reached the 3.5 trigger. Now a proper centered
 *         difference, so harsh braking and rapid acceleration fire at their stated
 *         thresholds. This raises event counts on existing trips.
 *       - Event severity is classified against the user's configured trigger threshold
 *         (EVENT_SEVERITY_BAND_MULTIPLIERS) instead of hardcoded literals, so a changed
 *         threshold now moves the severity mix and not just the event count.
 *       - Stop-start and close-proximity severity require both dimensions to escalate.
 *       - Stop-start speeds run through the same GPS noise filter as every other detector.
 *       - Speed-limit confidence has one source (SPEED_LIMIT_SOURCE_PROFILES); the second,
 *         disagreeing table rated OSM at certainty and osm_highway_default at 0.70.
 *       - IMU refinement can downgrade a GPS event the motion stream contradicts.
 *   4 - speed audit: speed-limit compliance is weighted by elapsed time instead of GPS
 *       point count, in every bucket total and in the blend across road types. A point
 *       is not a unit of anything a driver experiences — sampling is densest in
 *       stop-start traffic and sparsest at speed, so a minute in town outvoted a minute
 *       on a motorway purely by producing more fixes, and a dense burst of fixes while
 *       briefly over the limit was charged as if it had lasted proportionally longer.
 *       Gaps are clamped to MAX_SAMPLE_GAP_SECONDS so a tunnel cannot let one fix stand
 *       for the whole outage. This moves overall_compliance_score on existing trips in
 *       both directions, and changes the units of speed_penalty_totals.
 */
export const SCORING_ALGORITHM_REVISION = 4;

const scoreMetrics = ['score_overall', 'score_safety', 'score_smoothness'];
const routeRiskMetrics = ['route_risk_score', 'pre_trip_readiness_score'];
const ubiMetrics = ['ubi_score'];
export const LANE_CHANGING_SAFETY_WEIGHT = 0.05;

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
  PENALTY_SCALE_FACTOR: constant(5, {
    label: 'Trip penalty scale factor',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
    // Was 40, which saturated the score for ordinary trips. A single
    // high-severity harsh brake carries 12 points scaled by up to 1.92 for
    // speed, so ~23; at a scale of 40 that is a 263-point deduction against a
    // 100-point cap on a 3.5 km trip. Every trip under ~9 km with one such
    // event pinned baseSafety to 0, so one harsh brake and ten scored the same
    // and marking a false detection "Wrong" could not move the score. The
    // distance floor cannot fix this: it would have to exceed 9 km, which
    // would flatten short-trip scoring instead. 5 keeps a single event to a
    // ~33-point deduction on a 3.5 km trip while a genuinely bad trip still
    // reaches the floor. Still provisional and still uncalibrated.
    calibration_note: 'Uncalibrated - scores are self-consistent estimates, not validated against crash, claim, or insurer data. Follow PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS before treating downstream scores as calibrated.',
    affected_metrics: scoreMetrics,
    calibration_metadata: Object.freeze({
      ...pendingCalibrationMetadata,
      calibration_process: PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS,
    }),
  }),
  FATIGUE_SAFETY_PENALTY_SCALE: constant(0.15, {
    label: 'Fatigue to Safety penalty scale',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.CITED,
    calibration_note: 'Williamson & Feyer (Occup Environ Med, 2000) found 17-19 hours awake can match or exceed 0.05% BAC-equivalent impairment; max fatigue proxy maps conservatively to 15 Safety score deduction points.',
    affected_metrics: ['score_safety', 'score_overall'],
    calibration_metadata: pendingCalibrationMetadata,
  }),
  FATIGUE_SAFETY_MAX_PENALTY: constant(15, {
    label: 'Fatigue Safety deduction cap',
    domain: 'trip_score',
    calibration_status: CALIBRATION_STATUSES.CITED,
    calibration_note: 'Caps the fatigue proxy as a flat Safety score deduction after event-rate normalization, preventing trip distance from diluting or amplifying the fatigue effect.',
    affected_metrics: ['score_safety', 'score_overall'],
    calibration_metadata: pendingCalibrationMetadata,
  }),
  ECO_SPEED_STABILITY_CV_MULTIPLIER: constant(150, { label: 'Efficiency speed-stability multiplier', domain: 'trip_efficiency', calibration_note: 'Converts moving-speed variation to an internal efficiency-pattern estimate.', affected_metrics: ['eco_driving_score'] }),
  FUEL_BAND_FULL_SCORE_MULTIPLIER: constant(1.1, { label: 'Efficient-cruising multiplier', domain: 'trip_efficiency', calibration_note: 'Estimates sustained efficient cruising.', affected_metrics: ['fuel_band_score'] }),
  STOP_START_MIN_HIGHWAY_DISTANCE_KM: constant(5, { label: 'Stop-start highway evidence distance', domain: 'trip_score', calibration_note: 'Minimum route evidence before the GPS-only pattern score is exposed.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MIN_URBAN_DISTANCE_KM: constant(2, { label: 'Stop-start urban evidence distance', domain: 'trip_score', calibration_note: 'Minimum city-speed route evidence before the urban GPS-only pattern score is exposed.', affected_metrics: ['score_safety', 'score_overall', 'defensive_driving_score'] }),
  STOP_START_NORMALISATION_WINDOW_KM: constant(5, { label: 'Stop-start normalization window', domain: 'trip_score', calibration_note: 'Distance normalization for repeated speed-change patterns.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MAX_CYCLES_PER_WINDOW: constant(5, { label: 'Stop-start cycle saturation', domain: 'trip_score', calibration_note: 'Maximum cycles within one normalization window.', affected_metrics: ['score_safety', 'score_overall'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT: constant(3, { label: 'Stop-start defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum events before the GPS-only score participates in a blend.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_HIGHWAY: constant(3, { label: 'Stop-start highway defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum highway events before the highway GPS-only score participates in a defensive blend.', affected_metrics: ['defensive_driving_score'] }),
  STOP_START_MIN_DEFENSIVE_SAMPLE_COUNT_URBAN: constant(1, { label: 'Stop-start urban defensive sample minimum', domain: 'trip_score', calibration_note: 'Minimum city-speed events before the urban GPS-only score participates in a defensive blend.', affected_metrics: ['defensive_driving_score'] }),
  PHONE_USE_SAFETY_WEIGHT: constant(0.20, { label: 'Phone-use Safety blend weight', domain: 'trip_score', calibration_note: 'Confirmed Usage Access phone-use evidence is weighted as a major Safety signal; GPS proxy evidence remains diagnostic only.', affected_metrics: ['score_safety', 'score_overall'] }),
  CLOSE_PROXIMITY_DECAY_BASE: constant(0.60, { label: 'Brake-turn alert score decay', domain: 'trip_score', calibration_note: 'GPS maneuver diagnostic only; object proximity is not measured.', affected_metrics: ['close_proximity_score'] }),
  TIRE_WEAR_DEFAULT_SPEED_HARSH_KMH: constant(50, { label: 'Tire wear harsh-brake reference speed', domain: 'maintenance', calibration_note: 'Diagnostic wear reference speed.', affected_metrics: ['trip_tire_wear_units'] }),
  TIRE_WEAR_DEFAULT_SPEED_TURN_KMH: constant(40, { label: 'Tire wear turn reference speed', domain: 'maintenance', calibration_note: 'Diagnostic wear reference speed.', affected_metrics: ['trip_tire_wear_units'] }),
  HEADING_DRIFT_CIRCADIAN_MULTIPLIER: constant(2.5, { label: 'Late-night heading-drift multiplier', domain: 'trip_score', calibration_note: 'Circadian weighting informed by drowsy-driving context, not outcome-calibrated.', affected_metrics: ['heading_drift_beta_score'] }),
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
    phone_use: { low: 15, medium: 35, high: 65 },
  }), { label: 'Driving event penalty points', domain: 'trip_score', calibration_note: 'Event deductions are product heuristics pending outcome calibration.', affected_metrics: scoreMetrics }),
  // Only the event types listed here are actually routed into a penalty bucket by
  // tripEngine.calculateTripScores. Every other key in EVENT_PENALTY_POINTS above is inert:
  // its penalty is computed and then discarded, so tuning it changes no score even though
  // EVENT_PENALTY_POINTS declares `affected_metrics: scoreMetrics`. Keep this list in sync
  // with the bucket routing in calculateTripScores, and consult it before "recalibrating"
  // an event penalty — an inert entry needs wiring first, which is a scoring change.
  SCORE_AFFECTING_EVENT_TYPES: constant(Object.freeze([
    'harsh_brake',
    'rapid_acceleration',
    'sharp_turn',
    'speeding',
    'erratic_speed',
    'phone_use',
  ]), { label: 'Score-affecting event types', domain: 'trip_score', calibration_note: 'Structural, not calibrated: records which event penalties reach a scoring bucket.', affected_metrics: scoreMetrics }),
  // Severity bands are expressed as MULTIPLES of whatever trigger threshold is in
  // force for the event, so a user who moves a detection slider also moves the
  // low/medium/high boundaries with it. Before this was introduced the bands were
  // absolute literals, which meant a harsh-brake threshold raised to 7 m/s2 made
  // every detected event "high" and one lowered to 2 m/s2 made every event "low".
  //
  // The multipliers below are chosen so that, at the DEFAULT thresholds, the
  // resulting boundaries land within a few percent of the previous literals:
  //   harsh_brake        3.5 -> 4.90 / 6.13   (was 5 / 6)
  //   rapid_acceleration 3.0 -> 4.05 / 5.10   (was 4 / 5)
  //   idle                90 -> 180 / 297     (was 180 / 300)
  // sharp_turn is deliberately absent: it already classifies against its own
  // SHARP_TURN_G_MEDIUM / _HIGH settings and is the model this generalizes.
  EVENT_SEVERITY_BAND_MULTIPLIERS: constant(Object.freeze({
    harsh_brake: Object.freeze({ medium: 1.40, high: 1.75 }),
    rapid_acceleration: Object.freeze({ medium: 1.35, high: 1.70 }),
    idle: Object.freeze({ medium: 2.00, high: 3.30 }),
    stop_start_pattern: Object.freeze({ medium: 1.20, high: 1.60 }),
    close_proximity: Object.freeze({ medium: 1.15, high: 1.40 }),
  }), { label: 'Event severity band multipliers', domain: 'trip_score', calibration_note: 'Provisional severity boundaries expressed relative to each event\'s configured trigger threshold so user calibration moves severity with detection.', affected_metrics: scoreMetrics }),
  SPEEDING_SEVERITY_MEDIUM_OVER_KMH: constant(20, { label: 'Speeding medium severity margin', domain: 'trip_score', calibration_note: 'Provisional km/h above the applicable posted or inferred limit before a speeding event is medium severity.', affected_metrics: scoreMetrics }),
  SPEEDING_SEVERITY_HIGH_OVER_KMH: constant(30, { label: 'Speeding high severity margin', domain: 'trip_score', calibration_note: 'Provisional km/h above the applicable posted or inferred limit before a speeding event is high severity.', affected_metrics: scoreMetrics }),
  // Applied to SPEEDING_FALLBACK_KMH when no limit is known for the segment. At the
  // default 100 km/h fallback these reproduce the previous absolute 140 / 160 literals.
  SPEEDING_SEVERITY_NO_LIMIT_MEDIUM_MULTIPLIER: constant(1.4, { label: 'Speeding medium severity multiplier without a limit', domain: 'trip_score', calibration_note: 'Provisional multiple of the fallback speeding threshold used when no posted or inferred limit is available.', affected_metrics: scoreMetrics }),
  SPEEDING_SEVERITY_NO_LIMIT_HIGH_MULTIPLIER: constant(1.6, { label: 'Speeding high severity multiplier without a limit', domain: 'trip_score', calibration_note: 'Provisional multiple of the fallback speeding threshold used when no posted or inferred limit is available.', affected_metrics: scoreMetrics }),
  GPS_DISTRACTION_PENALTY_SCALE: constant(3, { label: 'GPS distraction penalty scale', domain: 'trip_score', calibration_note: 'Provisional per-km scale applied to GPS-proxy distraction penalty points when no confirmed phone-use signal exists.', affected_metrics: ['distraction_score', 'score_safety', 'score_overall'] }),
  PHONE_USE_WINDOW_PENALTY_POINTS: constant(Object.freeze({ low: 3, medium: 8, high: 20 }), { label: 'Confirmed phone-use window deductions', domain: 'trip_score', calibration_note: 'Provisional per-window deductions building phone_use_score; disagrees with EVENT_PENALTY_POINTS.phone_use and PHONE_USE_RISK_DEDUCTION_POINTS, which is unresolved calibration debt.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_USE_HIGH_SPEED_PENALTY_POINTS: constant(15, { label: 'High-speed phone-use surcharge', domain: 'trip_score', calibration_note: 'Provisional flat surcharge when any confirmed phone-use window occurs at or above 100 km/h.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  OVERALL_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ safety: 0.55, smoothness: 0.30, intersection: 0.15 }), { label: 'Overall score blend weights', domain: 'trip_score', calibration_note: 'Composite driving score weighting policy.', affected_metrics: ['score_overall'] }),
  LANE_CHANGING_SAFETY_WEIGHT: constant(LANE_CHANGING_SAFETY_WEIGHT, { label: 'Lane-changing Safety blend weight', domain: 'trip_score', calibration_note: 'Provisional Safety blend share for lane-changing rate and simultaneous-braking evidence. GPS-only confidence applies a 0.7 weight multiplier.', affected_metrics: ['score_safety', 'score_overall'] }),
  // KNOWN CALIBRATION DEBT (audit finding, deliberately not fixed in code):
  //   1. Speeding is counted twice in this blend. SPEEDING events feed `base` via the event
  //      penalty in tripEngine.calculateTripScores, and `compliance` re-measures the same
  //      over-limit driving from raw points, so the two are combined as if independent.
  //   2. `compliance` (and the night-driving ratio) are weighted by GPS point count rather
  //      than time or distance, so variable sampling density skews the result.
  // Both need replacement weights derived from real driving data: changing them here would
  // shift every existing user's historical scores with nothing to validate the new values
  // against. Resolve during a calibration pass, then bump SCORING_VERSION deliberately.
  // NOTE: keep this as a comment — `calibration_note` is part of the hashed payload, so
  // recording it there would bump SCORING_VERSION and force a rescore on its own.
  // KNOWN OVERLAP, deliberately left in place: speeding reaches Safety twice.
  // A SPEEDING event charges a penalty against `base` (0.52), and the same
  // speeding also lowers overall_compliance_score, which enters at `compliance`
  // (0.10). One behaviour, two deductions.
  //
  // It is not rebalanced because every weight here is provisional pending the
  // fleet labeling study, so replacing 0.52/0.10 with other uncalibrated numbers
  // would not make the score more accurate — it would only invalidate every
  // historical trip (these weights feed SCORING_VERSION). Resolve it when there
  // is calibration data to resolve it *against*, and rescore deliberately.
  //
  // The confidence weighting on both paths is already consistent: as of the
  // speed-evidence work, the event penalty and the compliance calculation both
  // derive their weight from the resolved evidence confidence rather than from
  // a static source profile, so at least the overlap is no longer double-counted
  // at two different strengths.
  SAFETY_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ base: 0.52, stopStart: 0.05, braking: 0.15, compliance: 0.10, laneChanging: LANE_CHANGING_SAFETY_WEIGHT }), { label: 'Safety score blend weights', domain: 'trip_score', calibration_note: 'Composite Safety weighting policy; phone-use share is recorded separately.', affected_metrics: ['score_safety', 'score_overall'] }),
  SMOOTHNESS_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ base: 0.45, jerk: 0.25, speedVariability: 0.10, brakeOnset: 0.10, cornering: 0.10 }), { label: 'Smoothness score blend weights', domain: 'trip_score', calibration_note: 'Composite Smoothness weighting policy.', affected_metrics: ['score_smoothness', 'score_overall'] }),
  DEFENSIVE_SCORE_BLEND_WEIGHTS: constant(Object.freeze({ smoothBraking: 0.30, intersection: 0.20, speedVariability: 0.20, stopStart: 0.30 }), { label: 'Defensive-driving blend weights', domain: 'trip_score', calibration_note: 'GPS behavior estimate weighting policy.', affected_metrics: ['defensive_driving_score'] }),
  PHONE_USE_RISK_DEDUCTION_POINTS: constant(Object.freeze({ none: 0, low: 10, medium: 35, high: 55 }), { label: 'Phone-use risk deductions', domain: 'trip_score', calibration_note: 'Confirmed signal score deductions.', affected_metrics: ['score_safety', 'score_overall'] }),
  // Short-trip protection: the per-km score normalizer never divides by less than this, so
  // a single event on a 300 m trip is not amplified into an extreme penalty rate. Displayed
  // event rates deliberately use true distance instead (see mathUtils.eventRatePerDistance),
  // which means the two disagree below this distance — trips in that range are flagged with
  // `event_rate_below_scoring_floor` so a surface can say so rather than showing a displayed
  // rate and a scored rate that differ by up to an order of magnitude with no explanation.
  SCORE_DISTANCE_NORMALIZATION_FLOOR_KM: constant(1, { label: 'Score distance normalization floor', domain: 'trip_score', calibration_note: 'Provisional short-trip guard on the per-km penalty denominator.', affected_metrics: scoreMetrics }),
  // The night exposure value returned by tripEngine.calculateNightPenalty is already
  // normalized by point count (a 0-12 blend of the 8-point night and 12-point deep-night
  // weights), so it is a flat Safety deduction, not a per-km penalty. This cap is the
  // function's own ceiling restated as a registered constant, not a new tuning knob.
  NIGHT_SAFETY_MAX_PENALTY: constant(12, { label: 'Night-driving Safety deduction cap', domain: 'trip_score', calibration_note: 'Provisional flat Safety deduction ceiling for night exposure, applied after per-km normalization so trip distance neither dilutes nor amplifies it.', affected_metrics: ['score_safety', 'score_overall'] }),
  WEATHER_SCORE_PENALTY_CAP: constant(12, { label: 'Weather score deduction cap', domain: 'weather_score', calibration_note: 'Weather-context adjustment ceiling.', affected_metrics: ['score_safety', 'score_overall'] }),
  WEATHER_EVENT_PENALTY_SCALE: constant(6, { label: 'Weather event deduction scale', domain: 'weather_score', calibration_note: 'Weather-context adjustment multiplier.', affected_metrics: ['score_safety', 'score_overall'] }),

  HARSH_BRAKE_MS2: constant(3.5, { label: 'Harsh braking threshold', domain: 'trip_threshold', calibration_note: 'Common telematics-style threshold; personalization remains approximate.', affected_metrics: scoreMetrics, setting_key: 'threshold_harsh_brake_ms2' }),
  RAPID_ACCEL_MS2: constant(3.0, { label: 'Rapid acceleration threshold', domain: 'trip_threshold', calibration_note: 'GPS acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_rapid_accel_ms2' }),
  SHARP_TURN_G_LOW: constant(0.35, { label: 'Sharp turn low threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_low' }),
  SHARP_TURN_G_MEDIUM: constant(0.45, { label: 'Sharp turn medium threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_medium' }),
  SHARP_TURN_G_HIGH: constant(0.60, { label: 'Sharp turn high threshold', domain: 'trip_threshold', calibration_note: 'GPS-derived lateral acceleration trigger.', affected_metrics: scoreMetrics, setting_key: 'threshold_sharp_turn_g_high' }),
  // Companion gate to the SHARP_TURN_G_* thresholds: a corner must both pull enough
  // lateral g AND actually change direction by this much, which keeps GPS heading
  // jitter on a straight road from registering as a turn. It is a detector shape
  // constant rather than a sensitivity knob, so it is deliberately not user-settable
  // — but it must be registered, because while it was an inline literal it silently
  // capped the configurable g thresholds: lowering SHARP_TURN_G_LOW below the level
  // reachable at a 30-degree heading change had no observable effect.
  SHARP_TURN_MIN_HEADING_CHANGE_DEG: constant(30, { label: 'Sharp turn minimum heading change', domain: 'trip_threshold', calibration_note: 'Provisional direction-change gate applied alongside the lateral-g thresholds.', affected_metrics: scoreMetrics }),
  SPEEDING_FALLBACK_KMH: constant(100, { label: 'Fallback speeding threshold', domain: 'trip_threshold', calibration_note: 'Used where posted/open map speed-limit context is unavailable.', affected_metrics: scoreMetrics, setting_key: 'threshold_speeding_kmh' }),
  SPEED_OVER_KMH: constant(5, { label: 'Speed-over-limit allowance', domain: 'trip_threshold', calibration_note: 'Tolerance applied above available or inferred limits.', affected_metrics: scoreMetrics, setting_key: 'threshold_speed_over_kmh' }),
  ECO_CRUISE_MIN_KMH: constant(55, { label: 'Efficient-cruise minimum', domain: 'trip_efficiency', calibration_note: 'Efficient-cruise band assumption.', affected_metrics: ['eco_driving_score', 'fuel_band_score'], setting_key: 'threshold_eco_cruise_min_kmh' }),
  ECO_CRUISE_MAX_KMH: constant(110, { label: 'Efficient-cruise maximum', domain: 'trip_efficiency', calibration_note: 'Efficient-cruise band assumption.', affected_metrics: ['eco_driving_score', 'fuel_band_score'], setting_key: 'threshold_eco_cruise_max_kmh' }),
  ECO_CRUISE_SCORE_MULTIPLIER: constant(130, { label: 'Efficient-cruise multiplier', domain: 'trip_efficiency', calibration_note: 'Full credit near 77 percent cruising samples.', affected_metrics: ['eco_driving_score'], setting_key: 'eco_cruise_score_multiplier' }),
  ECO_IDLE_PENALTY_MULTIPLIER: constant(150, { label: 'Avoidable-idle multiplier', domain: 'trip_efficiency', calibration_note: 'Avoidable-idle efficiency curve.', affected_metrics: ['eco_driving_score'], setting_key: 'eco_idle_penalty_multiplier' }),
  ECO_IDLE_MAX_PENALTY: constant(25, { label: 'Avoidable-idle adjustment cap', domain: 'trip_efficiency', calibration_note: 'Maximum adjustment from avoidable idle.', affected_metrics: ['eco_driving_score'], setting_key: 'eco_idle_max_penalty' }),
  ECO_MIN_MOVING_KMH: constant(15, { label: 'Efficiency moving-speed floor', domain: 'trip_efficiency', calibration_note: 'Suppresses crawl and GPS jitter samples.', affected_metrics: ['eco_driving_score'], setting_key: 'eco_min_moving_kmh' }),
  IDLE_SPEED_KMH: constant(5, { label: 'Idle speed floor', domain: 'trip_threshold', calibration_note: 'Speed below which a GPS sample is considered idle.', affected_metrics: ['idle_time_seconds'] }),
  IDLE_EVENT_SECONDS: constant(90, { label: 'Idle event duration', domain: 'trip_threshold', calibration_note: 'Minimum sustained idle duration.', affected_metrics: ['idle_time_seconds'], setting_key: 'threshold_idle_seconds' }),
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
  HILL_ACCEL_THRESHOLD_MS2: constant(2.5, { label: 'Hill acceleration threshold', domain: 'trip_threshold', calibration_note: 'Altitude-derived hill scoring proxy.', affected_metrics: ['hill_driving_score'] }),
  HILL_INFRACTION_PENALTY_POINTS: constant(10, { label: 'Legacy hill infraction deduction', domain: 'trip_threshold', calibration_note: 'Legacy absolute-count hill scoring deduction retained for provenance comparison only.', affected_metrics: ['hill_driving_score'] }),
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
  HEADING_DEVIATION_MIN_SPEED_KMH: constant(50, { label: 'Heading event minimum speed', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_HIGHWAY_MIN_SPEED_KMH: constant(80, { label: 'Heading event highway speed', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MIN_TURN_RATE_DEG_S: constant(3, { label: 'Heading event minimum turn rate', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MAX_TURN_RATE_DEG_S: constant(20, { label: 'Heading event maximum turn rate', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_MIN_WINDOW_SECONDS: constant(6, { label: 'Heading event minimum window', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_STRAIGHT_STD_MAX_DEG: constant(4, { label: 'Heading straight-road deviation cap', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  HEADING_DEVIATION_SUPPRESS_CONTEXT_METERS: constant(200, { label: 'Heading event context suppression distance', domain: 'trip_threshold', calibration_note: 'GPS heading-event beta detector.', affected_metrics: ['score_smoothness'] }),
  CORNERING_MIN_SPEED_KMH: constant(25, { label: 'Cornering minimum speed', domain: 'trip_threshold', calibration_note: 'GPS cornering estimate quality gate.', affected_metrics: ['cornering_consistency_score', 'score_smoothness'] }),
  MERGE_ENTRY_SPEED_KMH: constant(65, { label: 'Merge entry speed', domain: 'trip_threshold', calibration_note: 'GPS merge estimate.', affected_metrics: ['merge_score'] }),
  MERGE_EXIT_SPEED_KMH: constant(85, { label: 'Merge exit speed', domain: 'trip_threshold', calibration_note: 'GPS merge estimate.', affected_metrics: ['merge_score'] }),
  PARKING_LOOKBACK_SECONDS: constant(90, { label: 'Parking approach lookback', domain: 'trip_threshold', calibration_note: 'GPS parking-approach estimate.', affected_metrics: ['parking_approach_score'] }),
  MAX_TERMINAL_IDLE_SECONDS: constant(1800, { label: 'Terminal idle maximum', domain: 'trip_threshold', calibration_note: 'Trip-ending idle cap.', affected_metrics: ['idle_time_seconds'] }),
  MAX_REASONABLE_GPS_SPEED_KMH: constant(220, { label: 'Maximum plausible GPS speed', domain: 'trip_threshold', calibration_note: 'Rejects impossible GPS speed readings before they reach any detector.', affected_metrics: scoreMetrics }),
  // IMU refinement. GPS triggers every event; the motion stream only confirms or refutes
  // it. A phone being picked up produces accelerations indistinguishable from braking, and
  // calibratePhoneOrientation recovers the axis but neither its sign nor a full rotation
  // matrix, so the IMU is never allowed to create an event on its own.
  IMU_REFINEMENT_WINDOW_SECONDS: constant(1.5, { label: 'IMU refinement window', domain: 'trip_threshold', calibration_note: 'Half-width of the motion-sample window compared against a GPS-derived event.', affected_metrics: scoreMetrics }),
  IMU_REFINEMENT_MIN_SAMPLES: constant(5, { label: 'IMU refinement minimum samples', domain: 'trip_threshold', calibration_note: 'Fewer samples than this in the window cannot support confirming or refuting.', affected_metrics: scoreMetrics }),
  IMU_CONFIRM_RATIO: constant(0.6, { label: 'IMU confirmation ratio', domain: 'trip_threshold', calibration_note: 'Provisional: IMU peak of at least this fraction of the GPS magnitude counts as agreement.', affected_metrics: scoreMetrics }),
  IMU_REFUTE_RATIO: constant(0.3, { label: 'IMU refutation ratio', domain: 'trip_threshold', calibration_note: 'Provisional: IMU peak at or below this fraction of the GPS magnitude contradicts it, the signature of a GPS speed cliff in an urban canyon or tunnel exit.', affected_metrics: scoreMetrics }),
  // IMU jerk. Differentiating a raw ~50 Hz accelerometer measures road vibration and phone
  // rattle, not driving, so the signal is low-pass filtered and differentiated over a step
  // long enough to be a vehicle motion rather than a suspension response.
  IMU_JERK_SMOOTHING_WINDOW_MS: constant(200, { label: 'IMU jerk smoothing window', domain: 'trip_threshold', calibration_note: 'Moving-average width applied before differentiating longitudinal acceleration.', affected_metrics: ['jerk_score', 'score_smoothness'] }),
  IMU_JERK_STEP_MS: constant(200, { label: 'IMU jerk differentiation step', domain: 'trip_threshold', calibration_note: 'Interval between smoothed acceleration samples used to derive jerk.', affected_metrics: ['jerk_score', 'score_smoothness'] }),
  IMU_JERK_MAX_GAP_MS: constant(300, { label: 'IMU jerk maximum sample gap', domain: 'trip_threshold', calibration_note: 'A longer gap breaks the derivative rather than averaging across a sensor dropout.', affected_metrics: ['jerk_score', 'score_smoothness'] }),
  IMU_JERK_MIN_SAMPLES: constant(200, { label: 'IMU jerk minimum samples', domain: 'trip_threshold', calibration_note: 'Below this the IMU jerk estimate is not preferred over the GPS-derived one.', affected_metrics: ['jerk_score', 'score_smoothness'] }),
  // A gap longer than this is a GPS outage, not a driving sample: distance, idle time and
  // live telemetry all stop accumulating across it rather than interpolating through it.
  MAX_SAMPLE_GAP_SECONDS: constant(120, { label: 'Maximum trip sample gap', domain: 'trip_threshold', calibration_note: 'Boundary between a sampling gap and a genuine recording outage.', affected_metrics: scoreMetrics }),
  // Median moving speed at or above this classifies a trip as highway for stop-start
  // detection; below it the urban threshold set applies.
  STOP_START_URBAN_MEDIAN_SPEED_KMH: constant(50, { label: 'Stop-start urban/highway split', domain: 'trip_threshold', calibration_note: 'Trip-level road-type proxy for stop-start threshold selection.', affected_metrics: ['defensive_driving_score'] }),
  MANOEUVRE_ALERT_BRAKE_MS2: constant(4.0, { label: 'Brake-turn alert braking threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; not object proximity.', affected_metrics: ['close_proximity_score'], setting_key: 'threshold_manoeuvre_alert_brake_ms2' }),
  MANOEUVRE_ALERT_TURN_DEG_S: constant(25, { label: 'Brake-turn alert heading threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; not object proximity.', affected_metrics: ['close_proximity_score'], setting_key: 'threshold_manoeuvre_alert_turn_degs' }),
  HEADING_DRIFT_STD_DEG: constant(8, { label: 'Heading-drift threshold', domain: 'trip_threshold', calibration_note: 'GPS attention-pattern beta diagnostic only.', affected_metrics: ['heading_drift_beta_score'], setting_key: 'threshold_heading_drift_std_degs' }),
  PHONE_MICRO_STEER_COUNT: constant(6, { label: 'Phone proxy oscillation count', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'threshold_phone_proxy_oscillations' }),
  PHONE_MICRO_STEER_WINDOW_S: constant(15, { label: 'Phone proxy window', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_micro_steer_window_s' }),
  // A heading correction only counts as a micro-steer if it sits inside this band: below
  // the minimum it is GPS heading noise, above the maximum it is a deliberate turn.
  PHONE_MICRO_STEER_MIN_DEG: constant(3, { label: 'Phone proxy micro-steer minimum', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [] }),
  PHONE_MICRO_STEER_MAX_DEG: constant(18, { label: 'Phone proxy micro-steer maximum', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [] }),
  PHONE_DETECT_MIN_SPEED_KMH: constant(30, { label: 'Phone proxy minimum speed', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; below this speed steering corrections are not separable from manoeuvring.', affected_metrics: [] }),
  PHONE_PROXY_MAX_ACCURACY_M: constant(20, { label: 'Phone proxy GPS accuracy gate', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_proxy_max_accuracy_m' }),
  PHONE_CREEP_RATE_KMH_S: constant(1.5, { label: 'Phone proxy speed-creep rate', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_creep_rate_kmh_s' }),
  PHONE_LANE_DRIFT_DEG: constant(8, { label: 'Phone proxy drift threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_lane_drift_deg' }),
  PHONE_COUPLING_THRESHOLD: constant(0.15, { label: 'Phone proxy coupling threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; excluded from phone-use score.', affected_metrics: [], setting_key: 'phone_coupling_threshold' }),
  PHONE_CONFIDENCE_THRESHOLD: constant(0.40, { label: 'Phone proxy confidence threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; confirmed scoring requires Usage Access.', affected_metrics: [], setting_key: 'phone_confidence_threshold' }),
  PHONE_LOW_SENSITIVITY_CONFIDENCE_THRESHOLD: constant(0.60, { label: 'Phone proxy low-sensitivity confidence', domain: 'trip_threshold', calibration_note: 'GPS diagnostic sensitivity preset only.', affected_metrics: [] }),
  PHONE_HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD: constant(0.25, { label: 'Phone proxy high-sensitivity confidence', domain: 'trip_threshold', calibration_note: 'GPS diagnostic sensitivity preset only.', affected_metrics: [] }),
  PHONE_MIN_WINDOW_S: constant(4, { label: 'Phone proxy minimum window', domain: 'trip_threshold', calibration_note: 'GPS diagnostic only; confirmed scoring requires Usage Access.', affected_metrics: [], setting_key: 'phone_min_window_s' }),
  SPEED_CREEP_THRESHOLD_KMH: constant(5, { label: 'Speed-creep threshold', domain: 'trip_threshold', calibration_note: 'GPS diagnostic behavior trigger.', affected_metrics: ['speed_creep_score'], setting_key: 'threshold_speed_creep_kmh' }),
  OVERTAKE_ACCEL_THRESHOLD_MS2: constant(3.0, { label: 'Overtake beta acceleration threshold', domain: 'trip_threshold', calibration_note: 'Beta diagnostic only; excluded from composite scores.', affected_metrics: [], setting_key: 'threshold_overtake_accel_ms2' }),
  OVERTAKE_MIN_BASELINE_SPEED_KMH: constant(80, { label: 'Overtake beta baseline speed', domain: 'trip_threshold', calibration_note: 'Beta diagnostic only; excluded from composite scores.', affected_metrics: [] }),
  OVERTAKE_MIN_STRAIGHT_DISTANCE_KM: constant(1, { label: 'Overtake beta straight distance', domain: 'trip_threshold', calibration_note: 'Beta diagnostic only; excluded from composite scores.', affected_metrics: [] }),
  OVERTAKE_STRAIGHT_STD_MAX_DEG: constant(4, { label: 'Overtake beta straight heading deviation', domain: 'trip_threshold', calibration_note: 'Beta diagnostic only; excluded from composite scores.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_HARSH_BRAKE_MS2: constant(4.5, { label: 'Calibration fallback harsh brake threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_RAPID_ACCEL_MS2: constant(3.5, { label: 'Calibration fallback rapid acceleration threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),
  CALIBRATION_FALLBACK_SHARP_TURN_G_LOW: constant(0.3, { label: 'Calibration fallback low turn threshold', domain: 'threshold_calibration', calibration_note: 'Fallback only when a calibration profile has no current threshold.', affected_metrics: [] }),

  PHONE_HIGH_DURATION_SECONDS: constant(90, { label: 'High phone-use duration', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_HIGH_SPEED_KMH: constant(100, { label: 'High phone-use speed', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_MEDIUM_DURATION_SECONDS: constant(20, { label: 'Medium phone-use duration', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_MEDIUM_SPEED_KMH: constant(50, { label: 'Medium phone-use speed', domain: 'phone_use', calibration_note: 'Confirmed Usage Access severity heuristic.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_HIGH: constant(65, { label: 'High phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction; severe phone use is treated as a major avoidable attention risk.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_MEDIUM: constant(35, { label: 'Medium phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction; medium phone use should visibly affect Safety.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),
  PHONE_PENALTY_LOW: constant(15, { label: 'Low phone-use deduction', domain: 'phone_use', calibration_note: 'Confirmed Usage Access score deduction; short phone use remains a meaningful attention risk.', affected_metrics: ['phone_use_score', 'score_safety', 'score_overall'] }),

  DAILY_FATIGUE_ONSET_MINUTES: constant(90, { label: 'Daily fatigue onset', domain: 'fatigue', calibration_note: 'Time-on-task study supplies context, but score remains approximate.', affected_metrics: ['fatigue_risk_score', 'score_safety', 'score_overall'] }),
  DAILY_RECOVERY_BREAK_MINUTES: constant(30, { label: 'Daily fatigue recovery break', domain: 'fatigue', calibration_note: 'Break study supplies context, but recovery model remains approximate.', affected_metrics: ['fatigue_risk_score'] }),
  DAILY_FULL_RECOVERY_BREAK_MINUTES: constant(180, { label: 'Daily full-recovery cap', domain: 'fatigue', calibration_note: 'Product interpolation cap, not a recovery assurance.', affected_metrics: ['fatigue_risk_score'] }),
  DAILY_FATIGUE_SCORE_AT_ONSET: constant(5, { label: 'Daily fatigue onset score', domain: 'fatigue', calibration_note: 'Heuristic score step.', affected_metrics: ['fatigue_risk_score'] }),

  ROUTE_RISK_EVENT_WEIGHT: constant(20, { label: 'Route event risk weight', domain: 'route_risk', calibration_note: 'Segment risk heuristic; not incident calibrated.', affected_metrics: routeRiskMetrics, calibration_metadata: pendingCalibrationMetadata }),
  ROUTE_RISK_HARSH_WEIGHT: constant(40, { label: 'Route harsh-event risk weight', domain: 'route_risk', calibration_note: 'Segment risk heuristic; not incident calibrated.', affected_metrics: routeRiskMetrics, calibration_metadata: pendingCalibrationMetadata }),
  ROUTE_RISK_SPEED_START_KMH: constant(100, { label: 'Route speed-risk start', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  ROUTE_RISK_SPEED_FULL_KMH: constant(160, { label: 'Route speed-risk saturation speed', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  ROUTE_RISK_SPEED_MAX_POINTS: constant(15, { label: 'Route speed-risk maximum points', domain: 'route_risk', calibration_note: 'Segment risk heuristic.', affected_metrics: routeRiskMetrics }),
  PREDICTIVE_EVENT_DENSITY_MAX_PER_KM: constant(5, { label: 'Historical context event-density saturation', domain: 'historical_context', calibration_note: 'Not calibrated to collision or casualty outcomes.', affected_metrics: routeRiskMetrics }),
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

// TRIP_THRESHOLD_DEFAULTS used to live here. It was a second, parallel copy of
// tripEngine.DEFAULT_THRESHOLDS built from the same constants but consumed by nothing,
// and the two had already drifted apart: it exported the key as
// HEADING_DEVIATION_STRAIGHT_STD_MAX_DEG while the detector reads
// HEADING_DEVIATION_STRAIGHT_HEADING_STD_MAX_DEG. tripEngine.DEFAULT_THRESHOLDS is the
// single default set; resolve user overrides on top of it with buildDrivingThresholds.

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
  if (metrics.size === 0) return false;
  return getProvisionalScoringConstants(constants).some((entry) => (
    Array.isArray(entry.affected_metrics) && entry.affected_metrics.some((metric) => metrics.has(metric))
  ));
}

export function calibrationStatusForMetrics(metricKeys = [], constants = SCORING_CONSTANTS) {
  return hasProvisionalCalibration(metricKeys, constants)
    ? SCORE_OUTPUT_CALIBRATION_STATUSES.APPROXIMATE
    : SCORE_OUTPUT_CALIBRATION_STATUSES.CALIBRATED;
}
