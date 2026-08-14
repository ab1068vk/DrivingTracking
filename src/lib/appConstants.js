// Explicit extension so Node-run build scripts can import this module directly
// (generate-native-detection-constants.mjs reads the speed-alert constants from
// here). Vite resolves it identically either way.
import { scoringValue } from './scoringConstants.js';

export const APP_LOCK_SETTING_EVENT = 'roadsage-app-lock-setting-changed';

export const NIGHT_START_HOUR = scoringValue('NIGHT_START_HOUR');
export const NIGHT_END_HOUR = scoringValue('NIGHT_END_HOUR');
// Rush-hour windows are half-open on the clock: [START:00, END:00). An hour value of
// END_HOUR is therefore outside the window (rush ends *at* 09:00 / 19:00, so 09:xx and
// 19:xx are not rush). Both predicates must apply this rule identically.
export const MORNING_RUSH_START_HOUR = 7;
export const MORNING_RUSH_END_HOUR = 9;
export const EVENING_RUSH_START_HOUR = 16;
export const EVENING_RUSH_END_HOUR = 19;
export const NIGHT_START_TIME = `${String(NIGHT_START_HOUR).padStart(2, '0')}:00`;
export const NIGHT_END_TIME = `${String(NIGHT_END_HOUR).padStart(2, '0')}:00`;

// Provisional: no labeled fleet/crash/insurer dataset has calibrated this yet.
// Replace after the fleet labeling study records fitted value and provenance.
export const PENALTY_SCALE_FACTOR = scoringValue('PENALTY_SCALE_FACTOR');

/**
 * Source: Williamson & Feyer, Occupational and Environmental Medicine (2000):
 * 17-19 hours awake can produce performance impairment equivalent or worse
 * than 0.05% BAC. Conservative mapping: max fatigue proxy (100) to about
 * 0.05% BAC-equivalent impairment and 15 flat Safety deduction points.
 */
export const FATIGUE_SAFETY_PENALTY_SCALE = scoringValue('FATIGUE_SAFETY_PENALTY_SCALE');
export const FATIGUE_SAFETY_MAX_PENALTY = scoringValue('FATIGUE_SAFETY_MAX_PENALTY');

/**
 * Speed-alert gating, mirrored by DriveSenseAutoTrackingService.java so the
 * webview and the background native service agree on when an alert may fire.
 * They previously disagreed in both directions: native required a sustained
 * 5 s over the limit and a 0.55 confidence floor, the webview required neither.
 *
 * SPEED_ALERT_RELEASE_KMH is the hysteresis band. The "over the limit" state
 * only clears once speed drops below (limit + margin - release), so hovering on
 * the threshold cannot re-trigger the alert on every GPS fix.
 */
export const SPEED_ALERT_SUSTAINED_MS = 5000;
export const SPEED_ALERT_MIN_CONFIDENCE = 0.55;
export const SPEED_ALERT_RELEASE_KMH = 3;

/**
 * How long learned road-speed evidence is kept before a cleanup pass drops it.
 *
 * Shared by the Settings cleanup action and the one on Saved Road Speeds, which
 * previously hardcoded 180 on its own. Historical versions of a rule the driver
 * edited are preserved regardless — this window only governs learned evidence
 * and expired temporary rules.
 */
export const SPEED_KNOWLEDGE_RETENTION_DAYS_DEFAULT = 180;

export const MAX_VISIBLE_DANGER_ZONES = 6;
export const MAX_ROUTE_RISK_SEGMENTS_SHOWN = 3;

/**
 * Repeated event areas — what makes an area "repeated".
 *
 * These replace a fixed lat/lng grid that decided membership by which side of a
 * rounding boundary an event fell on. Three events twelve metres apart could
 * land in two different cells and never reach the threshold, so real clusters
 * were invisible while the driver was told there was no evidence.
 *
 * DANGER_ZONE_CLUSTER_RADIUS_M is a true distance, applied between events rather
 * than against a grid, so no boundary can split a cluster. 60 m covers the
 * spread of repeated braking at one physical feature — GPS scatter plus the
 * variation in where a driver actually starts braking — without swallowing the
 * next junction.
 *
 * DANGER_ZONE_MIN_TRIPS is the constant that makes the name honest. The old
 * engine counted raw events, so a single drive with three harsh brakes at one
 * junction produced a "repeated" area. Repetition is now counted in distinct
 * drives, matching how routeRiskIndex already counts passes.
 *
 * The speeding thresholds are rates, not counts, because speeding is a property
 * of a road stretch rather than a point: one continuous over-limit run emits a
 * single event placed at whatever fix happened to be fastest, so the same road
 * driven twice puts its events nowhere near each other. Stretches are derived
 * from route-risk segments, where exposure is already known.
 */
export const DANGER_ZONE_CLUSTER_RADIUS_M = 60;
export const DANGER_ZONE_MIN_TRIPS = 2;
export const SPEEDING_STRETCH_MIN_PASSES = 4;
export const SPEEDING_STRETCH_MIN_RATE = 0.5;
export const SPEEDING_STRETCH_MIN_TRIPS = 2;

/**
 * Predictive hazard horizon.
 *
 * The live repeated-event-area warning used to be direction-blind: every zone
 * within a fixed 300 m radius of the vehicle was treated as being "ahead", so
 * zones behind the car, on the parallel carriageway, and on crossing roads all
 * spoke. The fixed radius was also the wrong unit — 300 m buys 36 s of warning
 * at 30 km/h and 10 s at 110 km/h, so it was most generous exactly where it
 * mattered least.
 *
 * These constants describe a forward corridor projected from heading and speed,
 * and a warning measured in seconds-to-arrival. The subset the background
 * service also needs is emitted into DetectionConstants.java by
 * scripts/generate-native-detection-constants.mjs, so a foreground drive and a
 * background auto-tracked drive cannot warn on different geometry.
 *
 * They live here rather than in scoringConstants.js deliberately: that file is
 * content-hashed into SCORING_VERSION, and adding a live-alert tunable to it
 * would mark every stored trip score stale and trigger a mass re-score.
 */

/** Seconds-to-arrival at which a hazard becomes alertable. Default for `hazard_horizon_seconds`. */
export const HAZARD_HORIZON_ALERT_SECONDS = 12;
/** Below this the driver is already committed; speaking now startles rather than warns. */
export const HAZARD_HORIZON_MIN_SECONDS = 3;
export const HAZARD_HORIZON_MIN_SECONDS_SETTING = 6;
export const HAZARD_HORIZON_MAX_SECONDS = 20;

/**
 * The corridor is projected past the alert band so a hazard is *seen*
 * approaching before it becomes alertable. That lead is what lets the gate
 * require a sustained approach instead of alerting on first sight.
 */
export const HAZARD_PROJECTION_SLACK = 1.5;
export const HAZARD_PROJECTION_MIN_M = 120;
export const HAZARD_PROJECTION_MAX_M = 900;
export const HAZARD_PROJECTION_STEP_M = 20;

export const HAZARD_FORWARD_CONE_DEG = 50;
/**
 * Half-width grows with distance because heading error is angular. The cap sits
 * just under the corridor graph's own 75 m parallel-road threshold, so the
 * corridor can never swallow a road that layer considers distinct.
 */
export const HAZARD_CORRIDOR_BASE_HALF_WIDTH_M = 25;
export const HAZARD_CORRIDOR_WIDTH_PER_100M = 12;
export const HAZARD_CORRIDOR_MAX_HALF_WIDTH_M = 70;
export const HAZARD_BEHIND_TOLERANCE_M = 15;

/** Above STATIONARY_SPEED_KMH (5) and below MIN_TRUSTED_SPEED_KMH (18): car parks and queues are out, urban driving is not. */
export const HAZARD_MIN_SPEED_KMH = 15;
/** Tighter than the trip filter's MAX_GPS_ACCURACY_M (50): a 50 m fix cannot support a claim about which road you are on. */
export const HAZARD_MAX_ACCURACY_M = 35;
export const HAZARD_HEADING_MIN_TRUST_SPEED_KMH = 8;
/** Derived heading needs a real baseline. One GPS step at 20 km/h is ~5.5 m, which is inside the noise. */
export const HAZARD_HEADING_BASELINE_M = 25;
export const HAZARD_HEADING_MAX_AGE_MS = 15000;
export const HAZARD_MIN_HEADING_CONFIDENCE = 0.5;
export const HAZARD_MAX_TURN_RATE_DEG_S = 25;

/**
 * Being inside the warning window at all is most of what matters, so imminence
 * is scored from this floor rather than from zero. Without it a hazard near the
 * far edge scores near-nothing and a mild hazard slightly closer outranks a
 * critical one — and only the top-ranked hazard is ever offered to the gate.
 */
export const HAZARD_TIME_URGENCY_FLOOR = 0.4;
/**
 * A repeated-event area is a place several detectors fired at. A late-braking
 * pattern is advice about a habit, held below it deliberately so a
 * well-evidenced mild habit cannot outrank a place the driver would recognise.
 */
export const HAZARD_LATE_BRAKING_SEVERITY_WEIGHT = 0.6;

export const HAZARD_ALERT_SUSTAINED_FIXES = 2;
export const HAZARD_ALERT_RELEASE_SECONDS = 4;
/** Half the old 60 s, affordable because one-shot-per-hazard now does the heavy lifting. */
export const HAZARD_ALERT_GLOBAL_COOLDOWN_MS = 30000;
export const HAZARD_ALERT_MAX_PER_DRIVE = 12;
/** A hazard on your path closes at your own speed. This tolerance is what separates it from one on a diverging road. */
export const HAZARD_APPROACH_TOLERANCE = 0.45;
export const HAZARD_PREEMPT_URGENCY_DELTA = 0.35;
export const HAZARD_PREEMPT_MIN_INTERVAL_MS = 10000;
export const HAZARD_OVERLAY_QUIET_MS = 6000;

/** "You usually" is a claim about a habit: it needs at least 5 observations and at least 2 occurrences. */
export const HAZARD_CURVE_MIN_PASSES = 5;
export const HAZARD_CURVE_MIN_EVENT_RATE = 0.4;
export const HAZARD_CURVE_MIN_CONFIDENCE = 0.5;
export const HAZARD_CURVE_SPEED_MARGIN_KMH = 5;

/**
 * Motion-capture budgets, mirrored by CaptureFidelityProfile.java so the Android
 * service and the JS storage estimate agree on what a fidelity choice costs.
 *
 * The IMU already runs at SENSOR_DELAY_GAME (~50 Hz) for every trip in both
 * experience modes and ~80% of it is discarded before storage, so high fidelity
 * mostly stops throwing data away — the cost is storage, not battery.
 */
export const CAPTURE_FIDELITY_STANDARD_SAMPLE_BUDGET = 5000;
export const CAPTURE_FIDELITY_HIGH_SAMPLE_BUDGET = 15000;
/** Shorter than raw_gps_retention_days (30) so high-fidelity motion ages out first. */
export const MOTION_SAMPLE_RETENTION_DAYS_DEFAULT = 14;

export const SAVED_FILTERS_KEY = 'road_sage_trip_filter_presets';
export const DISMISSED_TAG_SUGGESTIONS_KEY = 'drivesense_dismissed_tag_suggestions';
export const FIRST_LAUNCH_PERMISSION_PROMPTED_KEY = 'drivesense_first_launch_permission_prompted';

export function isNightRiskHour(hour) {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

export function isMorningRushHour(hour) {
  return hour >= MORNING_RUSH_START_HOUR && hour < MORNING_RUSH_END_HOUR;
}

export function isEveningRushHour(hour) {
  return hour >= EVENING_RUSH_START_HOUR && hour < EVENING_RUSH_END_HOUR;
}
