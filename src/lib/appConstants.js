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

export const MAX_VISIBLE_DANGER_ZONES = 6;
export const MAX_ROUTE_RISK_SEGMENTS_SHOWN = 3;

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
