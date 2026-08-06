/**
 * Road Sage Tracking Store
 * Manages active trip state in memory with encrypted persistence for crash recovery.
 * This is a singleton store used by the tracking service.
 */
import { clamp as clampNumber } from '@/lib/mathUtils';
import { CURRENCY_SYMBOL_OPTIONS } from '@/lib/currency';
import {
  MOTION_SAMPLE_RETENTION_DAYS_DEFAULT,
  NIGHT_END_TIME,
  NIGHT_START_TIME,
} from '@/lib/appConstants';
import {
  CAPTURE_FIDELITY_VALUES,
  DEFAULT_CAPTURE_FIDELITY,
  normalizeCaptureFidelity,
} from '@/lib/captureFidelity';
import { logError } from '@/lib/errorReporting';
import { recordSystemEvent } from '@/lib/systemLog';
import { scoringValue } from '@/lib/scoringConstants';
import { ECO_DEFAULTS } from '@/lib/ecoDefaults';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { describeEndpointValidationError, normalizeHttpsEndpoint } from '@/lib/urlSecurity';
import {
  DEFAULT_CO2_BASELINE_KG_PER_100KM,
  DEFAULT_EV_KWH_PER_100KM,
  DEFAULT_GRID_CO2_KG_PER_KWH,
  DEFAULT_TREE_CO2_KG_PER_YEAR,
} from '@/lib/tripEconomyDefaults';
import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import {
  getHydratedPrivacyZones,
  isPointInPrivacyZone,
  redactRoutePointForPrivacyStorage,
  sanitizeTripForPrivacyStorage,
} from '@/lib/privacyZones';
import {
  isParkingPhotoExpired,
  recordParkingHistoryState,
} from '@/lib/parkingHistory';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { isNativePlatform } from '@/lib/nativePlatform';
import { recordParkingDiagnostic } from '@/lib/parkingDiagnostics';

// CHANGES (session):
// - Added Phase 2 speed estimate guidance defaults and validation ranges.
// - Added backup exclusion metadata for local-only storage keys.
// - Allowed numeric settings drafts to be blank while the user edits an input.

export const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
export const SETTINGS_KEY = 'drivesense_settings';
export const LAST_PARKED_KEY = 'drivesense_last_parked';
export const LAST_PARKING_STATE_KEY = 'drivesense_last_parking_state';
export const SETTINGS_CHANGED_EVENT = 'roadsage-settings-changed';
export const ACTIVE_TRIP_CHANGED_EVENT = 'roadsage-active-trip-changed';
export const PARKED_LOCATION_PRIVACY_GUARD_M = 50;
let lastNativeSettingsSync = '';
let settingsCache = null;
let settingsCacheSerialized = '';
let memorySettings = null;
let activeTripMemory = null;
let activeTripWriteQueue = Promise.resolve();
const CURRENT_SETTINGS_DEFAULTS_VERSION = 24;
const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_MODE_VALUES = Object.freeze(['system', 'light', 'dark']);
let activeThemeMode = 'system';
let systemThemeQueryList = null;
let systemThemeQueryListener = null;
let lastSystemBarsSignature = '';

export const EXPERIENCE_MODES = Object.freeze({
  COACHING: 'coaching',
  TRACKING: 'tracking',
});
export const DEFAULT_EXPERIENCE_MODE = EXPERIENCE_MODES.COACHING;
export const EXPERIENCE_MODE_VALUES = Object.freeze(Object.values(EXPERIENCE_MODES));
export const VOICE_ALERT_STYLES = Object.freeze({
  MODE_DEFAULT: 'mode_default',
  COACHING: 'coaching',
  TECHNICAL: 'technical',
});
export const DEFAULT_VOICE_ALERT_STYLE = VOICE_ALERT_STYLES.MODE_DEFAULT;
export const VOICE_ALERT_STYLE_VALUES = Object.freeze(Object.values(VOICE_ALERT_STYLES));

export const normalizeExperienceMode = (mode) => (
  EXPERIENCE_MODE_VALUES.includes(mode) ? mode : DEFAULT_EXPERIENCE_MODE
);

export const isTrackingExperienceMode = (settings = {}) => (
  normalizeExperienceMode(settings?.experience_mode) === EXPERIENCE_MODES.TRACKING
);

export const normalizeVoiceAlertStyle = (style) => (
  VOICE_ALERT_STYLE_VALUES.includes(style) ? style : DEFAULT_VOICE_ALERT_STYLE
);

const settingsStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const defaultOsrmEndpoint = () => {
  const value = String(import.meta.env.VITE_DEFAULT_OSRM_URL || '').trim();
  if (!value || isPublicOsrmDemoUrl(value)) return '';
  return normalizeHttpsEndpoint(value);
};

const defaultOsrmTimeoutMs = () => {
  const value = Number(import.meta.env.VITE_OSRM_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? clampNumber(value, 5000, 30000) : 12000;
};

const ecoMultiplierMissingOrZero = (value) => {
  if (value == null || value === '') return true;
  const number = Number(value);
  return !Number.isFinite(number) || number <= 0;
};

function repairEcoScoringSettings(settings, source, sourceValues = settings) {
  if (!settings || typeof settings !== 'object') return false;
  const cruiseInvalid = ecoMultiplierMissingOrZero(sourceValues?.eco_cruise_score_multiplier);
  const idleInvalid = ecoMultiplierMissingOrZero(sourceValues?.eco_idle_penalty_multiplier);
  if (!cruiseInvalid || !idleInvalid) return false;

  settings.eco_cruise_score_multiplier = ECO_DEFAULTS.CRUISE_SCORE_MULTIPLIER;
  settings.eco_idle_penalty_multiplier = ECO_DEFAULTS.IDLE_PENALTY_MULTIPLIER;
  if (settings.eco_idle_max_penalty == null || settings.eco_idle_max_penalty === '') {
    settings.eco_idle_max_penalty = ECO_DEFAULTS.IDLE_MAX_PENALTY;
  }

  logError('settings_eco_threshold_repair', new Error('Eco scoring settings restored to defaults during settings migration.'), {
    migration_note: 'Restored eco cruise and idle multipliers from ECO_DEFAULTS because both were zero or missing.',
    source,
  });
  return true;
}

const getParkedLocationPrivacyZones = async (settings = localSettings.get()) => {
  try {
    return getHydratedPrivacyZones(settings);
  } catch {}
  return [];
};

const isPrivateParkedLocation = async (location, settings = localSettings.get()) => {
  if (finiteNumber(location?.lat) == null || finiteNumber(location?.lng) == null) return false;
  const zones = await getParkedLocationPrivacyZones(settings);
  return Boolean(isPointInPrivacyZone(location, zones, PARKED_LOCATION_PRIVACY_GUARD_M));
};

const refreshNativeParkingWidget = async () => {
  if (typeof window === 'undefined') return;
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return;
    await ActivityRecognition.refreshWhereIParkedWidget();
  } catch (error) {
    logError('parking_widget_refresh', error);
  }
};

const parkingSyncTimeout = (promise, timeoutMs = 8_000) => Promise.race([
  promise,
  new Promise((_, reject) => {
    globalThis.setTimeout(() => reject(new Error('Android parking synchronization timed out.')), timeoutMs);
  }),
]);

const commitNativeParkingSnapshot = async (state, location = null) => {
  if (!isNativePlatform()) return { state, location };
  const committed = await parkingSyncTimeout(
    ActivityRecognition.commitNativeParkingSnapshot({ state, location }),
  );
  const committedState = committed?.state;
  if (
    !committedState ||
    parkingStateRevision(committedState) !== parkingStateRevision(state) ||
    committedState.status !== state.status
  ) {
    throw new Error('Android rejected the parking revision because a newer or safer record exists.');
  }
  return committed;
};

const restoreParkingSnapshot = async (records) => {
  await Promise.all([
    records?.parkedLocation
      ? setEncryptedJson(LAST_PARKED_KEY, records.parkedLocation)
      : removeEncryptedJson(LAST_PARKED_KEY),
    records?.state
      ? setEncryptedJson(LAST_PARKING_STATE_KEY, records.state)
      : removeEncryptedJson(LAST_PARKING_STATE_KEY),
  ]);
  if (!isNativePlatform()) return;
  await ActivityRecognition.clearNativeParkingState();
  if (records?.state) {
    await commitNativeParkingSnapshot(
      records.state,
      records.state.status === 'saved' ? records.parkedLocation : null,
    );
  }
};

const sameParkingTrip = (first, second) => {
  const firstId = first?.tripId ?? first?.location?.tripId;
  const secondId = second?.tripId ?? second?.location?.tripId;
  return firstId != null && secondId != null && String(firstId) === String(secondId);
};

const shouldPreserveHigherConfidenceParking = (existingState, incomingState) => {
  if (!existingState || !incomingState || !sameParkingTrip(existingState, incomingState)) return false;
  if (incomingState.verified === true) return false;
  const existingScore = Number(existingState.confidence_score) || 0;
  const incomingScore = Number(incomingState.confidence_score) || 0;
  return existingState.verified === true || existingScore > incomingScore;
};

const syncSettingsForNative = (settings, serialized = JSON.stringify(settings)) => {
  if (typeof window === 'undefined') return;
  if (serialized === lastNativeSettingsSync) return;
  lastNativeSettingsSync = serialized;
  import('@capacitor/core')
    .then(({ Capacitor }) => {
      if (!Capacitor.isNativePlatform()) return null;
      return import('@capacitor/preferences');
    })
    .then((module) => {
      if (!module?.Preferences) return;
      module.Preferences.set({ key: SETTINGS_KEY, value: serialized }).catch((error) => {
        logError('settings_native_sync_write', error, {
          requested_key_count: Object.keys(settings || {}).length,
        });
      });
    })
    .catch((error) => {
      logError('settings_native_sync_init', error, {
        requested_key_count: Object.keys(settings || {}).length,
      });
    });
};

const dispatchSettingsChanged = (settings, detail = {}) => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
    detail: {
      settings,
      ...detail,
    },
  }));
};

const dispatchActiveTripChanged = () => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(ACTIVE_TRIP_CHANGED_EVENT, {
    detail: { active: Boolean(activeTripMemory) },
  }));
};

// ─── Default Settings ──────────────────────────────────────────────────────────
// CHANGES (session):
// - Added Phase 2 speed estimate defaults for regional default selection and voice margin controls.
// - Added BACKUP_EXCLUDED_KEYS for local-only storage keys.
// - Allowed combined regional default settings such as CA-ON and US-TX.

export const BACKUP_EXCLUDED_KEYS = Object.freeze([
  'drivesense_parking_learning_v1',
  'drivesense_speed_sign_evidence_v1',
]);

const STATUTORY_REGION_SETTING_VALUES = Object.freeze([
  'global',
  'ca',
  'CA',
  'CA-ON',
  'CA-BC',
  'CA-AB',
  'CA-QC',
  'CA-MB',
  'CA-SK',
  'us',
  'US',
  'US-CA',
  'US-TX',
  'US-NY',
  'gb',
  'uk',
  'GB',
  'GB-ENG',
  'GB-WLS',
  'de',
  'DE',
  'au',
  'AU',
  'AU-NSW',
  'AU-VIC',
  'AU-QLD',
  'fr',
  'FR',
]);

export const DEFAULT_SETTINGS = {
  settings_defaults_version: CURRENT_SETTINGS_DEFAULTS_VERSION,
  experience_mode: DEFAULT_EXPERIENCE_MODE,
  tracking_mode: 'manual',
  units: 'metric',
  currencySymbol: '$',
  dark_mode: 'system',
  premium_visual_experience: false,
  notifications_enabled: true,
  notification_permission_granted: false,
  trip_start_notification: true,
  trip_end_notification: true,
  weekly_report_notification: true,
  achievement_notifications: true,
  // Personal detection-calibration progress is a separate system from the
  // Milestones page and gets its own toggle.
  calibration_notifications: true,
  safe_driving_reminder: false,
  background_tracking_enabled: false,
  auto_tracking_enabled: false,
  activity_permission_granted: false,
  data_retention_days: 365,
  raw_gps_retention_days: 30,
  threshold_harsh_brake_ms2: scoringValue('HARSH_BRAKE_MS2'),
  threshold_rapid_accel_ms2: scoringValue('RAPID_ACCEL_MS2'),
  threshold_stop_start_decel_ms2: scoringValue('STOP_START_DECEL_MS2'),
  // DriveSenseAutoTrackingService reads these three keys for its live stop-start
  // detector but nothing on the JS side ever wrote them, so native silently ran on
  // its own hardcoded fallbacks and user calibration never reached the device.
  threshold_stop_start_min_speed_kmh: scoringValue('STOP_START_MIN_SPEED_KMH'),
  threshold_stop_start_speed_drop_kmh: scoringValue('STOP_START_SPEED_DROP_KMH'),
  threshold_stop_start_urban_decel_ms2: scoringValue('STOP_START_URBAN_DECEL_MS2'),
  threshold_sharp_turn_g_low: scoringValue('SHARP_TURN_G_LOW'),
  threshold_sharp_turn_g_medium: scoringValue('SHARP_TURN_G_MEDIUM'),
  threshold_sharp_turn_g_high: scoringValue('SHARP_TURN_G_HIGH'),
  threshold_speeding_kmh: scoringValue('SPEEDING_FALLBACK_KMH'),
  threshold_speed_over_kmh: scoringValue('SPEED_OVER_KMH'),
  threshold_eco_cruise_min_kmh: scoringValue('ECO_CRUISE_MIN_KMH'),
  threshold_eco_cruise_max_kmh: scoringValue('ECO_CRUISE_MAX_KMH'),
  eco_cruise_score_multiplier: scoringValue('ECO_CRUISE_SCORE_MULTIPLIER'),
  eco_idle_penalty_multiplier: scoringValue('ECO_IDLE_PENALTY_MULTIPLIER'),
  eco_idle_max_penalty: scoringValue('ECO_IDLE_MAX_PENALTY'),
  eco_min_moving_kmh: scoringValue('ECO_MIN_MOVING_KMH'),
  threshold_idle_seconds: scoringValue('IDLE_EVENT_SECONDS'),
  threshold_long_drive_minutes: scoringValue('LONG_DRIVE_MINUTES'),
  night_detection_mode: 'sunset',
  night_start_time: NIGHT_START_TIME,
  night_end_time: NIGHT_END_TIME,
  night_sunset_offset_minutes: 0,
  night_sunrise_offset_minutes: 0,
  night_boundary_tolerance_minutes: 5,
  threshold_manoeuvre_alert_brake_ms2: scoringValue('MANOEUVRE_ALERT_BRAKE_MS2'),
  threshold_manoeuvre_alert_turn_degs: scoringValue('MANOEUVRE_ALERT_TURN_DEG_S'),
  threshold_heading_drift_std_degs: scoringValue('HEADING_DRIFT_STD_DEG'),
  threshold_phone_proxy_oscillations: scoringValue('PHONE_MICRO_STEER_COUNT'),
  phone_use_detection_enabled: true,
  lane_change_score_enabled: true,
  phone_usage_access_granted: false,
  phone_use_live_alert_enabled: true,
  phone_use_show_on_map: true,
  phone_use_affects_score: true,
  phone_use_sensitivity: 'medium',
  phone_micro_steer_count: scoringValue('PHONE_MICRO_STEER_COUNT'),
  phone_micro_steer_window_s: scoringValue('PHONE_MICRO_STEER_WINDOW_S'),
  phone_proxy_max_accuracy_m: scoringValue('PHONE_PROXY_MAX_ACCURACY_M'),
  phone_creep_rate_kmh_s: scoringValue('PHONE_CREEP_RATE_KMH_S'),
  phone_lane_drift_deg: scoringValue('PHONE_LANE_DRIFT_DEG'),
  phone_coupling_threshold: scoringValue('PHONE_COUPLING_THRESHOLD'),
  phone_confidence_threshold: scoringValue('PHONE_CONFIDENCE_THRESHOLD'),
  phone_min_window_s: scoringValue('PHONE_MIN_WINDOW_S'),
  threshold_speed_creep_kmh: scoringValue('SPEED_CREEP_THRESHOLD_KMH'),
  threshold_overtake_accel_ms2: scoringValue('OVERTAKE_ACCEL_THRESHOLD_MS2'),
  advanced_safety_detection_enabled: true,
  speed_warning_enabled: true,
  speed_limit_lookup_enabled: false,
  speed_estimates_enabled: true,
  speed_sign_scanner_enabled: false,
  speed_sign_mounted_mode_enabled: false,
  speak_posted_speed_warnings: true,
  speak_estimated_speed_checks: true,
  estimated_voice_margin_kmh: 12,
  inferred_voice_margin_kmh: 20,
  country_code: '',
  configurable_country_defaults: 'global',
  weather_context_enabled: false,
  external_context_auto_fetch_enabled: false,
  external_context_auto_fetch_consented_at: '',
  heightened_privacy_mode: true,
  request_obfuscation_enabled: true,
  decoy_traffic_mode: 'off',
  min_speed_rapid_accel_kmh: scoringValue('MIN_SPEED_RAPID_ACCEL_KMH'),
  min_speed_harsh_brake_kmh: scoringValue('MIN_SPEED_HARSH_BRAKE_KMH'),
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  weekly_goal_max_night_km: 20,
  weekly_goal_min_trips: 3,
  weekly_goal_min_distance_km: 25,
  ubi_optimal_annual_km: scoringValue('UBI_OPTIMAL_ANNUAL_KM'),
  ubi_mileage_score_spread_km: scoringValue('UBI_MILEAGE_SPREAD_KM'),
  onboarding_completed: false,
  location_permission_granted: false,
  background_location_granted: false,
  tracking_paused: false,
  live_coaching_enabled: true,
  trip_start_voice_alert_enabled: true,
  voice_alerts_enabled: true,
  voice_speed_alerts_enabled: true,
  voice_driving_event_alerts_enabled: true,
  voice_attention_incident_alerts_enabled: true,
  voice_coaching_reminder_alerts_enabled: true,
  voice_alert_style: DEFAULT_VOICE_ALERT_STYLE,
  // Motion-capture fidelity is deliberately separate from experience_mode: it
  // changes what lands on disk, so it needs its own consent and its own switch.
  capture_fidelity: DEFAULT_CAPTURE_FIDELITY,
  motion_sample_retention_days: MOTION_SAMPLE_RETENTION_DAYS_DEFAULT,
  // Protective governor, not an optimizer: it only acts at <=15% battery or
  // moderate-plus heat, where the alternative is a lost trip. 'off' is a full
  // runtime kill switch reachable without an app update.
  adaptive_capture_mode: 'guard',
  sensor_fusion_enabled: true,
  crash_detection_enabled: true,
  emergency_workflow_enabled: false,
  map_matching_enabled: false,
  osrm_map_matching_url: defaultOsrmEndpoint(),
  osrm_public_demo_consent_at: '',
  osrm_data_sharing_consented: false,
  osrm_data_sharing_consented_at: '',
  osrm_consent_invalidated_reason: '',
  osrm_consent_invalidated_at: '',
  osrm_consent_invalidated_zone_label: '',
  osrm_health_status: '',
  osrm_last_health_checked_at: '',
  osrm_last_reachable_at: '',
  osrm_last_health_error: '',
  osrm_timeout_ms: defaultOsrmTimeoutMs(),
  osrm_block_near_any_zone: true,
  last_map_center: null,
  predictive_route_risk_enabled: true,
  obd_bluetooth_enabled: false,
  notif_safety_alerts_enabled: true,
  notif_phone_use_alert_enabled: true,
  notif_heading_drift_alert_enabled: true,
  notif_speeding_alert_enabled: true,
  notif_post_trip_summary_enabled: true,
  notif_post_trip_score_change: true,
  notif_post_trip_phone_use: true,
  notif_post_trip_fuel_saving: true,
  notif_coaching_enabled: true,
  notif_streak_enabled: true,
  notif_weekly_pattern_enabled: true,
  notif_style_shift_enabled: true,
  notif_maintenance_enabled: true,
  notif_inactive_nudge_enabled: true,
  notif_inactive_nudge_days: 7,
  notif_quiet_hours_enabled: false,
  notif_quiet_start: '22:00',
  notif_quiet_end: '07:00',
  notif_min_score_for_post_trip: 0,
  danger_zone_alerts_enabled: true,
  calibration_profile_key: null,
  co2_baseline_kg_per_100km: DEFAULT_CO2_BASELINE_KG_PER_100KM,
  default_ev_kwh_per_100km: DEFAULT_EV_KWH_PER_100KM,
  grid_co2_kg_per_kwh: DEFAULT_GRID_CO2_KG_PER_KWH,
  tree_co2_kg_per_year: DEFAULT_TREE_CO2_KG_PER_YEAR,
  privacy_zones: [],
  show_privacy_circles: false,
  allow_screen_capture: false,
  app_lock_enabled: false,
  privacy_zone_storage_requires_secure_device: true,
  rasp_secure: true,
  rasp_threats: [],
  rasp_checked_at: '',
  rasp_native: false,
  privacy_log_retention_hours: 24,
  privacy_zones_native_sync_status: '',
  privacy_zones_native_sync_failed_at: '',
  privacy_zones_native_sync_zone_count: 0,
  calibration_sharing_enabled: false,
  legal_notice_ack_version: 0,
  legal_notice_acknowledged_at: '',
};

/**
 * @param {Record<string, any>} parsed
 * @returns {{settings: Record<string, any>, changed: boolean}}
 */
export function migrateDefaultSettings(parsed = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...parsed };
  const version = Number(parsed.settings_defaults_version) || 1;
  const legacyProxyKeys = [
    'threshold_tailgate_decel_ms2',
    'threshold_near_miss_brake_ms2',
    'threshold_near_miss_turn_degs',
    'threshold_drowsy_heading_std',
    'notif_drowsy_alert_enabled',
  ];

  if (version < 2) {
    if (parsed.threshold_harsh_brake_ms2 == null || parsed.threshold_harsh_brake_ms2 === 4.5) merged.threshold_harsh_brake_ms2 = 3.5;
    if (parsed.threshold_rapid_accel_ms2 == null || parsed.threshold_rapid_accel_ms2 === 3.5) merged.threshold_rapid_accel_ms2 = 3.0;
    if (parsed.threshold_speeding_kmh == null || parsed.threshold_speeding_kmh === 130) merged.threshold_speeding_kmh = 100;
    if (parsed.threshold_speed_over_kmh == null || parsed.threshold_speed_over_kmh === 10) merged.threshold_speed_over_kmh = 5;
    if (parsed.threshold_speed_creep_kmh == null || parsed.threshold_speed_creep_kmh === 10) merged.threshold_speed_creep_kmh = 5;
    if (parsed.threshold_sharp_turn_g_low == null || parsed.threshold_sharp_turn_g_low === 0.30) merged.threshold_sharp_turn_g_low = 0.35;
  }

  if (version < 3 && parsed.night_detection_mode !== 'custom') {
    if (parsed.night_start_time == null || parsed.night_start_time === '22:00') merged.night_start_time = NIGHT_START_TIME;
    if (parsed.night_end_time == null || parsed.night_end_time === '06:00') merged.night_end_time = NIGHT_END_TIME;
  }

  if (version < 5) {
    if (parsed.threshold_phone_proxy_oscillations == null || parsed.threshold_phone_proxy_oscillations === 3) merged.threshold_phone_proxy_oscillations = 6;
    if (parsed.phone_micro_steer_count == null || parsed.phone_micro_steer_count === 4) merged.phone_micro_steer_count = 6;
    if (Number(parsed.threshold_overtake_accel_ms2) < 3) merged.threshold_overtake_accel_ms2 = 3;
    merged.phone_micro_steer_window_s = 15;
    merged.phone_proxy_max_accuracy_m = 20;
  }

  if (version < 20 && parsed.night_boundary_tolerance_minutes == null) {
    merged.night_boundary_tolerance_minutes = 5;
  }

  // v24: phone_confidence_threshold became the single source of truth for the GPS
  // phone-use proxy. Until now the low/high sensitivity presets were applied at read
  // time in buildDrivingThresholds and silently discarded whatever the stored
  // threshold said. Carry the preset the user was effectively running into the
  // stored value so their detection sensitivity does not change on upgrade.
  if (version < 24) {
    const sensitivity = parsed.phone_use_sensitivity;
    if (sensitivity === 'low' || sensitivity === 'high') {
      merged.phone_confidence_threshold = scoringValue(
        sensitivity === 'low'
          ? 'PHONE_LOW_SENSITIVITY_CONFIDENCE_THRESHOLD'
          : 'PHONE_HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD'
      );
    }
  }

  if (parsed.threshold_stop_start_decel_ms2 == null && parsed.threshold_tailgate_decel_ms2 != null) {
    merged.threshold_stop_start_decel_ms2 = parsed.threshold_tailgate_decel_ms2;
  }
  if (parsed.threshold_manoeuvre_alert_brake_ms2 == null && parsed.threshold_near_miss_brake_ms2 != null) {
    merged.threshold_manoeuvre_alert_brake_ms2 = parsed.threshold_near_miss_brake_ms2;
  }
  if (parsed.threshold_manoeuvre_alert_turn_degs == null && parsed.threshold_near_miss_turn_degs != null) {
    merged.threshold_manoeuvre_alert_turn_degs = parsed.threshold_near_miss_turn_degs;
  }
  if (parsed.threshold_heading_drift_std_degs == null && parsed.threshold_drowsy_heading_std != null) {
    merged.threshold_heading_drift_std_degs = parsed.threshold_drowsy_heading_std;
  }
  if (parsed.notif_heading_drift_alert_enabled == null && parsed.notif_drowsy_alert_enabled != null) {
    merged.notif_heading_drift_alert_enabled = parsed.notif_drowsy_alert_enabled;
  }
  legacyProxyKeys.forEach((key) => delete merged[key]);
  const ecoSettingsRepaired = repairEcoScoringSettings(merged, 'default_settings_migration');
  const calibrationSharingChanged = merged.calibration_sharing_enabled !== false;
  merged.calibration_sharing_enabled = false;

  if (version < 9) {
    merged.external_context_auto_fetch_enabled = false;
    merged.external_context_auto_fetch_consented_at = '';
  }

  if (version < 11 && parsed.raw_gps_retention_days == null) {
    // Preserve existing installs until the user explicitly enables earlier route expiry.
    merged.raw_gps_retention_days = 0;
  }

  if (
    version < 12 &&
    // Only seed a value the user has never expressed a preference about. This
    // used to force `true` on every upgrade, so a driver who had deliberately
    // turned estimated speech off had it switched back on behind their back.
    parsed.speak_estimated_speed_checks == null &&
    parsed.voice_alerts_enabled !== false &&
    parsed.speed_warning_enabled !== false
  ) {
    merged.speak_estimated_speed_checks = true;
  }

  if (version < 14) {
    merged.heightened_privacy_mode = true;
    merged.weather_context_enabled = false;
    merged.speed_limit_lookup_enabled = false;
    merged.map_matching_enabled = false;
    merged.osrm_data_sharing_consented = false;
    merged.osrm_data_sharing_consented_at = '';
    merged.osrm_consent_invalidated_reason = 'maximum_privacy_default';
    merged.osrm_consent_invalidated_at = new Date().toISOString();
    if (Number(merged.raw_gps_retention_days) > 30 || parsed.raw_gps_retention_days == null) {
      merged.raw_gps_retention_days = 30;
    }
  }

  if (version < 16) {
  }

  const experienceModeChanged = !Object.prototype.hasOwnProperty.call(parsed, 'experience_mode') ||
    merged.experience_mode !== normalizeExperienceMode(merged.experience_mode);
  merged.experience_mode = normalizeExperienceMode(merged.experience_mode);
  const voiceAlertStyleChanged = !Object.prototype.hasOwnProperty.call(parsed, 'voice_alert_style') ||
    merged.voice_alert_style !== normalizeVoiceAlertStyle(merged.voice_alert_style);
  merged.voice_alert_style = normalizeVoiceAlertStyle(merged.voice_alert_style);
  // v23 introduced capture_fidelity. Existing installs land on standard, which is
  // bit-identical to how they already recorded, so an upgrade changes nothing until
  // the user opts in.
  const captureFidelityChanged = !Object.prototype.hasOwnProperty.call(parsed, 'capture_fidelity') ||
    merged.capture_fidelity !== normalizeCaptureFidelity(merged.capture_fidelity);
  merged.capture_fidelity = normalizeCaptureFidelity(merged.capture_fidelity);
  if (!Number.isFinite(Number(merged.motion_sample_retention_days))) {
    merged.motion_sample_retention_days = MOTION_SAMPLE_RETENTION_DAYS_DEFAULT;
  }
  if (merged.adaptive_capture_mode !== 'off' && merged.adaptive_capture_mode !== 'guard') {
    merged.adaptive_capture_mode = DEFAULT_SETTINGS.adaptive_capture_mode;
  }
  const themeModeChanged = !THEME_MODE_VALUES.includes(merged.dark_mode);
  if (themeModeChanged) merged.dark_mode = DEFAULT_SETTINGS.dark_mode;

  const osrmZoneGuardChanged = merged.osrm_block_near_any_zone !== true;
  merged.osrm_block_near_any_zone = true;
  merged.settings_defaults_version = CURRENT_SETTINGS_DEFAULTS_VERSION;
  return {
    settings: merged,
    changed: calibrationSharingChanged || ecoSettingsRepaired || experienceModeChanged || voiceAlertStyleChanged || captureFidelityChanged || themeModeChanged || osrmZoneGuardChanged || version < CURRENT_SETTINGS_DEFAULTS_VERSION || legacyProxyKeys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key)),
  };
}

/**
 * Allowed numeric range for every settable numeric setting.
 *
 * This is the single source of truth for three things that used to disagree:
 *   1. what a Settings slider offers (Settings.jsx reads its min/max from here),
 *   2. what validateSettingsPatch accepts on the normal save path,
 *   3. what sanitizeImportedSettings clamps a restored backup into.
 *
 * Previously the import table was far wider than the sliders — rapid acceleration
 * was 1.5-6 in the UI but 0.5-15 here — so validation enforced nothing the UI
 * cared about, and a restored backup could hold a threshold the UI cannot represent
 * or a user reach. Detection thresholds are now stated once, at the band the product
 * actually supports; the wider bounds are kept only for keys with no slider.
 */
const SETTING_NUMBER_RANGES = {
  data_retention_days: [0, 3650],
  raw_gps_retention_days: [0, 3650],
  motion_sample_retention_days: [0, 365],
  threshold_harsh_brake_ms2: [2, 8],
  threshold_rapid_accel_ms2: [1.5, 6],
  threshold_stop_start_decel_ms2: [1.5, 5],
  threshold_stop_start_min_speed_kmh: [10, 120],
  threshold_stop_start_speed_drop_kmh: [2, 60],
  threshold_stop_start_urban_decel_ms2: [0.5, 5],
  threshold_sharp_turn_g_low: [0.2, 0.6],
  threshold_sharp_turn_g_medium: [0.25, 0.8],
  threshold_sharp_turn_g_high: [0.35, 1.0],
  threshold_speeding_kmh: [80, 160],
  estimated_voice_margin_kmh: [0, 60],
  inferred_voice_margin_kmh: [0, 80],
  threshold_speed_over_kmh: [5, 30],
  threshold_eco_cruise_min_kmh: [0, 160],
  threshold_eco_cruise_max_kmh: [20, 200],
  eco_cruise_score_multiplier: [50, 200],
  eco_idle_penalty_multiplier: [0, 300],
  eco_idle_max_penalty: [0, 50],
  eco_min_moving_kmh: [0, 50],
  threshold_idle_seconds: [90, 300],
  threshold_long_drive_minutes: [5, 1440],
  night_sunset_offset_minutes: [-180, 180],
  night_sunrise_offset_minutes: [-180, 180],
  night_boundary_tolerance_minutes: [0, 30],
  threshold_manoeuvre_alert_brake_ms2: [2.5, 5],
  threshold_manoeuvre_alert_turn_degs: [15, 60],
  threshold_heading_drift_std_degs: [5, 15],
  threshold_phone_proxy_oscillations: [6, 8],
  phone_micro_steer_count: [6, 8],
  phone_micro_steer_window_s: [1, 120],
  phone_proxy_max_accuracy_m: [1, 100],
  phone_creep_rate_kmh_s: [0.5, 4],
  phone_lane_drift_deg: [3, 18],
  phone_coupling_threshold: [0.05, 0.4],
  // Must stay wide enough to hold both sensitivity presets
  // (PHONE_LOW/HIGH_SENSITIVITY_CONFIDENCE_THRESHOLD), which the preset buttons write.
  phone_confidence_threshold: [0.15, 0.8],
  phone_min_window_s: [2, 12],
  threshold_speed_creep_kmh: [5, 25],
  threshold_overtake_accel_ms2: [3, 5],
  min_speed_rapid_accel_kmh: [0, 40],
  min_speed_harsh_brake_kmh: [5, 60],
  weekly_goal_harsh_brakes: [0, 1000],
  weekly_goal_speeding_events: [0, 1000],
  weekly_goal_min_avg_score: [0, 100],
  weekly_goal_max_night_trips: [0, 1000],
  weekly_goal_max_night_km: [0, 10000],
  weekly_goal_min_trips: [1, 20],
  weekly_goal_min_distance_km: [1, 500],
  notif_inactive_nudge_days: [1, 365],
  notif_min_score_for_post_trip: [0, 100],
  osrm_timeout_ms: [5000, 30000],
  privacy_log_retention_hours: [0, 72],
  privacy_zones_native_sync_zone_count: [0, 20],
  co2_baseline_kg_per_100km: [0, 50],
  default_ev_kwh_per_100km: [5, 40],
  grid_co2_kg_per_kwh: [0, 2],
  tree_co2_kg_per_year: [1, 100],
};

const SETTINGS_ENUMS = {
  experience_mode: EXPERIENCE_MODE_VALUES,
  voice_alert_style: VOICE_ALERT_STYLE_VALUES,
  capture_fidelity: CAPTURE_FIDELITY_VALUES,
  adaptive_capture_mode: ['off', 'guard'],
  tracking_mode: ['manual', 'auto_detect', 'background_auto'],
  units: ['metric', 'imperial'],
  currencySymbol: CURRENCY_SYMBOL_OPTIONS.map((option) => option.value),
  dark_mode: THEME_MODE_VALUES,
  night_detection_mode: ['sunset', 'civil_twilight', 'custom'],
  phone_use_sensitivity: ['low', 'medium', 'high'],
  configurable_country_defaults: STATUTORY_REGION_SETTING_VALUES,
  decoy_traffic_mode: ['off', 'first_party'],
  privacy_zones_native_sync_status: ['', 'ok', 'failed'],
};

const IMPORT_ENUMS = {
  ...SETTINGS_ENUMS,
  tracking_mode: ['manual', 'auto_detect'],
};

const IMPORT_STRIPPED_KEYS = new Set([
  'speed_sign_scanner_enabled',
  'speed_sign_mounted_mode_enabled',
  'external_context_auto_fetch_enabled',
  'external_context_auto_fetch_consented_at',
  'osrm_map_matching_url',
  'osrm_public_demo_consent_at',
  'osrm_data_sharing_consented',
  'osrm_data_sharing_consented_at',
  'osrm_health_status',
  'osrm_last_health_checked_at',
  'osrm_last_reachable_at',
  'osrm_last_health_error',
  'osrm_consent_invalidated_reason',
  'osrm_consent_invalidated_at',
  'osrm_consent_invalidated_zone_label',
  'osrm_block_near_any_zone',
  'request_obfuscation_enabled',
  'heightened_privacy_mode',
  'decoy_traffic_mode',
  'privacy_zones_native_sync_status',
  'privacy_zones_native_sync_failed_at',
  'privacy_zones_native_sync_zone_count',
  'allow_screen_capture',
  'app_lock_enabled',
  'privacy_zone_storage_requires_secure_device',
  'rasp_secure',
  'rasp_threats',
  'rasp_checked_at',
  'rasp_native',
]);

const sanitizeImportedPrivacyZones = (zones) => (
  Array.isArray(zones)
    ? zones
      .filter((zone) => zone && typeof zone === 'object')
      .slice(0, 20)
      .map((zone, index) => {
        const radius = clampNumber(Number(zone.radius_m) || 150, 50, 1000);
        /** @type {{id:string,label:string,radius_m:number,exclude_from_osrm:boolean,masked_for_privacy?:boolean}} */
        const sanitized = {
          id: typeof zone.id === 'string' ? zone.id.slice(0, 80) : `privacy_zone_import_${index}`,
          label: typeof zone.label === 'string' && zone.label.trim()
            ? zone.label.trim().slice(0, 80)
            : 'Private place',
          radius_m: radius,
          exclude_from_osrm: true,
          masked_for_privacy: true,
        };
        return sanitized;
      })
    : []
);

const sanitizeMapCenter = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  return {
    lat,
    lng,
    ...(typeof value.tripId === 'string' ? { tripId: value.tripId.slice(0, 120) } : {}),
    ...(typeof value.source === 'string' ? { source: value.source.slice(0, 80) } : {}),
    ...(typeof value.updated_at === 'string' ? { updated_at: value.updated_at.slice(0, 80) } : {}),
  };
};

/**
 * @param {Record<string, any>} raw Settings imported from backup or user storage.
 */
export function sanitizeImportedSettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const normalizedRaw = { ...raw };
  if (normalizedRaw.threshold_stop_start_decel_ms2 == null) {
    normalizedRaw.threshold_stop_start_decel_ms2 = raw.threshold_tailgate_decel_ms2;
  }
  if (normalizedRaw.threshold_manoeuvre_alert_brake_ms2 == null) {
    normalizedRaw.threshold_manoeuvre_alert_brake_ms2 = raw.threshold_near_miss_brake_ms2;
  }
  if (normalizedRaw.threshold_manoeuvre_alert_turn_degs == null) {
    normalizedRaw.threshold_manoeuvre_alert_turn_degs = raw.threshold_near_miss_turn_degs;
  }
  if (normalizedRaw.threshold_heading_drift_std_degs == null) {
    normalizedRaw.threshold_heading_drift_std_degs = raw.threshold_drowsy_heading_std;
  }
  if (normalizedRaw.notif_heading_drift_alert_enabled == null) {
    normalizedRaw.notif_heading_drift_alert_enabled = raw.notif_drowsy_alert_enabled;
  }

  const sanitized = {};
  Object.entries(DEFAULT_SETTINGS).forEach(([key, defaultValue]) => {
    if (!Object.prototype.hasOwnProperty.call(normalizedRaw, key) || normalizedRaw[key] == null) return;
    if (IMPORT_STRIPPED_KEYS.has(key)) return;
    const value = normalizedRaw[key];

    if (key === 'privacy_zones') {
      sanitized.privacy_zones = sanitizeImportedPrivacyZones(value);
      return;
    }

    if (key === 'last_map_center') {
      const center = sanitizeMapCenter(value);
      if (center) sanitized.last_map_center = center;
      return;
    }

    if (key === 'calibration_sharing_enabled') {
      sanitized.calibration_sharing_enabled = false;
      return;
    }

    if (IMPORT_ENUMS[key]) {
      if (IMPORT_ENUMS[key].includes(value)) sanitized[key] = value;
      return;
    }

    if (defaultValue === null) {
      if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) sanitized[key] = value;
      return;
    }

    if (typeof defaultValue === 'boolean') {
      if (typeof value === 'boolean') sanitized[key] = value;
      return;
    }

    if (typeof defaultValue === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return;
      const [min, max] = SETTING_NUMBER_RANGES[key] || [-1_000_000, 1_000_000];
      sanitized[key] = clampNumber(number, min, max);
      return;
    }

    if (typeof defaultValue === 'string') {
      if (typeof value === 'string') sanitized[key] = value.slice(0, 500);
    }
  });
  repairEcoScoringSettings(sanitized, 'backup_settings_import', normalizedRaw);

  return sanitized;
}

/**
 * Inclusive [min, max] a numeric setting may hold, or null when unconstrained.
 * Settings sliders read their bounds from here so the control can never offer a
 * value that validateSettingsPatch will then reject.
 * @param {string} key
 * @returns {[number, number]|null}
 */
export function settingRange(key) {
  const range = SETTING_NUMBER_RANGES[key];
  return range ? [range[0], range[1]] : null;
}

export function validateSettingsPatch(patch = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: ['Settings update must be an object.'] };
  }

  Object.entries(patch).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
    if (key === 'last_map_center') {
      if (value !== null && !sanitizeMapCenter(value)) errors.push('last_map_center must contain valid lat and lng coordinates.');
      return;
    }
    if (key === 'osrm_map_matching_url') {
      const endpoint = String(value || '').trim();
      if (!endpoint) return;
      const endpointError = describeEndpointValidationError(endpoint);
      if (endpointError) errors.push(`osrm_map_matching_url ${endpointError}`);
      if (isPublicOsrmDemoUrl(endpoint)) errors.push('Use a private or trusted OSRM endpoint; the public OSRM demo cannot be saved as a route-snapping endpoint.');
      return;
    }
    if (key === 'osrm_block_near_any_zone' && value !== true) {
      errors.push('osrm_block_near_any_zone is always enabled because privacy-zone coordinates must never be eligible for OSRM.');
      return;
    }
    if (SETTINGS_ENUMS[key] && !SETTINGS_ENUMS[key].includes(value)) {
      errors.push(`${key} must be one of: ${SETTINGS_ENUMS[key].join(', ')}.`);
      return;
    }
    if (SETTING_NUMBER_RANGES[key]) {
      if (value === '') return;
      const number = Number(value);
      const [min, max] = SETTING_NUMBER_RANGES[key];
      if (!Number.isFinite(number) || number < min || number > max) {
        errors.push(`${key} must be between ${min} and ${max}.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

const parkedTimestampMs = (value) => {
  const parsed = Date.parse(String(value?.timestamp || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

export const parkingStateRevision = (value) => {
  const revision = Number(value?.state_revision);
  return Number.isSafeInteger(revision) && revision > 0
    ? revision
    : parkedTimestampMs(value);
};

const nextParkingStateRevision = (records, requestedRevision = null) => {
  const requested = Number(requestedRevision);
  if (Number.isSafeInteger(requested) && requested > 0) return requested;
  const newest = Math.max(
    parkingStateRevision(records?.state),
    parkingStateRevision(records?.parkedLocation),
  );
  return Math.max(Date.now(), newest + 1);
};

const parkingStatusForSource = (source) => (
  source === 'privacy_zone' ? 'private' : 'unavailable'
);

const legacyParkingState = (parkedLocation) => {
  if (!parkedLocation || typeof parkedLocation !== 'object') return null;
  if (parkedLocation.suppressed === true) {
    return {
      version: 2,
      status: parkingStatusForSource(parkedLocation.source),
      timestamp: parkedLocation.timestamp || null,
      source: parkedLocation.source || 'trip_end_unavailable',
      tripId: parkedLocation.tripId ?? null,
      state_revision: parkingStateRevision(parkedLocation),
    };
  }
  return {
    version: 2,
    status: 'saved',
    timestamp: parkedLocation.timestamp || null,
    source: parkedLocation.source || 'trip_end',
    tripId: parkedLocation.tripId ?? null,
    state_revision: parkingStateRevision(parkedLocation),
    confidence: parkedLocation.confidence || 'estimated',
    confidence_score: parkedLocation.confidence_score ?? null,
    evidence: Array.isArray(parkedLocation.evidence) ? parkedLocation.evidence : [],
    strategy: parkedLocation.strategy || 'last_trip_point',
    refinement_count: Number(parkedLocation.refinement_count) || 0,
  };
};

const latestParkingEvent = (state, parkedLocation) => {
  const legacyState = legacyParkingState(parkedLocation);
  if (!state) return legacyState;
  if (!legacyState) return state;
  const stateRevision = parkingStateRevision(state);
  const legacyRevision = parkingStateRevision(legacyState);
  if (stateRevision !== legacyRevision) return stateRevision > legacyRevision ? state : legacyState;
  return parkedTimestampMs(state) >= parkedTimestampMs(legacyState) ? state : legacyState;
};

const readParkingRecords = async () => {
  const [state, parkedLocation] = await Promise.all([
    getEncryptedJson(LAST_PARKING_STATE_KEY, null),
    getEncryptedJson(LAST_PARKED_KEY, null),
  ]);
  return {
    state: latestParkingEvent(state, parkedLocation),
    parkedLocation: parkedLocation?.suppressed === true ? null : parkedLocation,
  };
};

/**
 * Returns the newest parking outcome without exposing coordinates for a
 * privacy-protected stop. `location` is present only for a confirmed public
 * parking location.
 */
export async function getLastParkingState() {
  const records = await readParkingRecords();
  if (!records.state) return null;
  if (records.state.status !== 'saved') return records.state;
  let parkedLocation = records.parkedLocation;
  if (isParkingPhotoExpired(parkedLocation)) {
    if (isNativePlatform() && parkedLocation?.photo_file_id) {
      await ActivityRecognition.deleteParkingPhoto({ photoId: parkedLocation.photo_file_id }).catch(() => {});
    }
    parkedLocation = {
      ...parkedLocation,
      photo_data_url: null,
      photo_file_id: null,
      photo_expires_at: null,
      photo_retention_hours: null,
    };
    await setEncryptedJson(LAST_PARKED_KEY, parkedLocation);
  }
  if (!parkedLocation) {
    return {
      ...records.state,
      status: 'unavailable',
      source: 'parking_record_incomplete',
    };
  }
  if (await isPrivateParkedLocation(parkedLocation)) {
    await suppressLastParkedLocation({
      timestamp: records.state.timestamp || parkedLocation.timestamp,
      source: 'privacy_zone',
      tripId: records.state.tripId ?? parkedLocation.tripId,
    });
    await removeEncryptedJson(LAST_PARKED_KEY);
    return {
      version: 2,
      status: 'private',
      timestamp: records.state.timestamp || parkedLocation.timestamp,
      source: 'privacy_zone',
      tripId: records.state.tripId ?? parkedLocation.tripId ?? null,
    };
  }
  return {
    ...records.state,
    status: 'saved',
    location: parkedLocation,
  };
}

export async function getLastParkedLocation() {
  const state = await getLastParkingState();
  return state?.status === 'saved' ? state.location || null : null;
}

/** @param {{timestamp?: string | null, source?: string, tripId?: string | number | null, stateRevision?: number | null, vehicleId?: string | number | null, vehicleName?: string | null}} [options] */
export async function suppressLastParkedLocation(options = {}) {
  const {
    timestamp,
    source = 'trip_end_unavailable',
    tripId = null,
    stateRevision = null,
    vehicleId = null,
    vehicleName = null,
  } = options;
  const records = await readParkingRecords();
  const suppression = {
    version: 2,
    status: parkingStatusForSource(source),
    timestamp: timestamp || new Date().toISOString(),
    source,
    tripId,
    vehicle_id: vehicleId ?? null,
    vehicle_name: String(vehicleName || '').trim().slice(0, 80) || null,
    state_revision: nextParkingStateRevision(records, stateRevision),
  };
  if (parkedTimestampMs(records.state) > parkedTimestampMs(suppression)) {
    return records.state?.status === 'saved' ? records.parkedLocation : null;
  }
  if (
    source !== 'privacy_zone' &&
    shouldPreserveHigherConfidenceParking(records.state, suppression)
  ) {
    await recordParkingDiagnostic(
      'confidence_downgrade_blocked',
      'A lower-confidence suppression was prevented from replacing the current parking event.',
      { tripId, source },
    ).catch(() => {});
    return records.state?.status === 'saved' ? records.parkedLocation : null;
  }
  await setEncryptedJson(LAST_PARKING_STATE_KEY, suppression);
  try {
    await commitNativeParkingSnapshot(suppression, null);
  } catch (error) {
    if (records.state) await setEncryptedJson(LAST_PARKING_STATE_KEY, records.state);
    else await removeEncryptedJson(LAST_PARKING_STATE_KEY);
    await recordParkingDiagnostic('atomic_sync_rollback', error?.message, {
      operation: 'suppress',
      tripId,
      source,
    }).catch(() => {});
    throw error;
  }
  try {
    const historyRecord = await recordParkingHistoryState(suppression);
    if (
      !historyRecord ||
      historyRecord.status !== suppression.status ||
      parkingStateRevision(historyRecord) !== suppression.state_revision
    ) {
      throw new Error('The protected parking-history record did not confirm its revision.');
    }
  } catch (error) {
    logError('parking_history_suppression_save', error, {
      source: suppression.source,
      status: suppression.status,
    });
    try {
      await restoreParkingSnapshot(records);
    } catch (rollbackError) {
      await recordParkingDiagnostic(
        'parking_history_rollback_failed',
        rollbackError?.message || 'Protected parking rollback failed.',
        { source, tripId, requestedRevision: suppression.state_revision },
      ).catch(() => {});
      throw new Error('Protected parking history failed and Android rollback needs review. Reopen Parking before using the widget.');
    }
    await refreshNativeParkingWidget();
    throw new Error('Protected parking was not saved because its history record could not be verified. Your previous parking was restored.');
  }
  // Migrate the old one-key suppression format without deleting a retained
  // public location from the newer two-record model.
  const legacy = await getEncryptedJson(LAST_PARKED_KEY, null);
  if (legacy?.suppressed === true) {
    await removeEncryptedJson(LAST_PARKED_KEY);
  } else if (legacy?.photo_data_url) {
    await setEncryptedJson(LAST_PARKED_KEY, {
      ...legacy,
      photo_data_url: null,
      photo_expires_at: null,
      photo_retention_hours: null,
    });
  }
  await refreshNativeParkingWidget();
  await recordParkingDiagnostic('parking_suppressed', 'Parking state synchronized without coordinates.', {
    status: suppression.status,
    revision: suppression.state_revision,
    source,
  }).catch(() => {});
  return null;
}

export async function removeLastParkedPhoto() {
  const parkedLocation = await getEncryptedJson(LAST_PARKED_KEY, null);
  if (!parkedLocation?.photo_data_url && !parkedLocation?.photo_file_id) return false;
  if (isNativePlatform() && parkedLocation.photo_file_id) {
    await ActivityRecognition.deleteParkingPhoto({ photoId: parkedLocation.photo_file_id }).catch(() => {});
  }
  await setEncryptedJson(LAST_PARKED_KEY, {
    ...parkedLocation,
    photo_data_url: null,
    photo_file_id: null,
    photo_expires_at: null,
    photo_retention_hours: null,
  });
  await refreshNativeParkingWidget();
  return true;
}

export async function clearCurrentParkingState() {
  const [previousLocation, previousState] = await Promise.all([
    getEncryptedJson(LAST_PARKED_KEY, null),
    getEncryptedJson(LAST_PARKING_STATE_KEY, null),
  ]);
  await Promise.all([
    removeEncryptedJson(LAST_PARKED_KEY),
    removeEncryptedJson(LAST_PARKING_STATE_KEY),
  ]);
  try {
    await ActivityRecognition.clearNativeParkingState();
  } catch (error) {
    await Promise.all([
      previousLocation
        ? setEncryptedJson(LAST_PARKED_KEY, previousLocation)
        : removeEncryptedJson(LAST_PARKED_KEY),
      previousState
        ? setEncryptedJson(LAST_PARKING_STATE_KEY, previousState)
        : removeEncryptedJson(LAST_PARKING_STATE_KEY),
    ]);
    await recordParkingDiagnostic('parking_clear_rollback', 'Native clear failed; local parking state was restored.', {
      message: error?.message || String(error),
    }).catch(() => {});
    logError('parking_native_clear', error);
    throw error;
  }
  await refreshNativeParkingWidget();
}

export async function inspectParkingSyncStatus() {
  if (!isNativePlatform()) return { status: 'not_applicable' };
  const [snapshot, localState] = await Promise.all([
    ActivityRecognition.getNativeParkingSnapshot(),
    getLastParkingState(),
  ]);
  const nativeState = snapshot?.state || null;
  if (!nativeState && !localState) return { status: 'empty' };
  if (!nativeState) return { status: 'native_missing', localRevision: parkingStateRevision(localState) };
  if (!localState) return { status: 'app_missing', nativeRevision: parkingStateRevision(nativeState) };
  const nativeRevision = parkingStateRevision(nativeState);
  const localRevision = parkingStateRevision(localState);
  const matching = nativeRevision === localRevision &&
    nativeState.status === localState.status &&
    sameParkingTrip(nativeState, localState);
  return matching
    ? { status: 'synced', nativeRevision, localRevision }
    : {
      status: 'conflict',
      nativeRevision,
      localRevision,
      nativeStatus: nativeState.status,
      localStatus: localState.status,
    };
}

export async function reconcileNativeParkingState() {
  let snapshot;
  try {
    snapshot = await ActivityRecognition.getNativeParkingSnapshot();
  } catch {
    return getLastParkingState();
  }
  const nativeState = snapshot?.state;
  if (!nativeState?.status) {
    const localOnlyState = await getLastParkingState();
    if (localOnlyState?.status) {
      await commitNativeParkingSnapshot(
        localOnlyState,
        localOnlyState.status === 'saved' ? localOnlyState.location : null,
      );
      await recordParkingDiagnostic(
        'native_widget_record_repaired',
        'Android had no parking record, so the verified app record was restored to the widget.',
        { revision: parkingStateRevision(localOnlyState), status: localOnlyState.status },
      ).catch(() => {});
    }
    return localOnlyState;
  }

  const localState = await getLastParkingState();
  const nativeRevision = parkingStateRevision(nativeState);
  const localRevision = parkingStateRevision(localState);
  if (
    localState &&
    (localRevision > nativeRevision ||
      (localRevision === nativeRevision &&
        !(nativeState.status === 'private' && localState.status !== 'private') &&
        parkedTimestampMs(localState) >= parkedTimestampMs(nativeState)))
  ) {
    if (
      localRevision !== nativeRevision ||
      localState.status !== nativeState.status ||
      !sameParkingTrip(localState, nativeState)
    ) {
      await commitNativeParkingSnapshot(
        localState,
        localState.status === 'saved' ? localState.location : null,
      );
      await recordParkingDiagnostic(
        'parking_conflict_repaired',
        'The newer verified app record replaced a stale Android widget record.',
        {
          localRevision,
          nativeRevision,
          localStatus: localState.status,
          nativeStatus: nativeState.status,
        },
      ).catch(() => {});
    }
    return localState;
  }

  if (nativeState.status === 'saved' && snapshot.location) {
    await saveLastParkedLocation({
      ...snapshot.location,
      timestamp: nativeState.timestamp || snapshot.location.timestamp,
      tripId: nativeState.tripId ?? snapshot.location.tripId,
      source: nativeState.source || snapshot.location.source || 'native_parking_sync',
      stateRevision: nativeRevision,
    });
  } else {
    await suppressLastParkedLocation({
      timestamp: nativeState.timestamp,
      source: nativeState.status === 'private'
        ? 'privacy_zone'
        : nativeState.source || 'trip_end_unavailable',
      tripId: nativeState.tripId ?? null,
      stateRevision: nativeRevision,
      vehicleId: nativeState.vehicle_id ?? null,
      vehicleName: nativeState.vehicle_name ?? null,
    });
  }
  return getLastParkingState();
}

const shortenParkedAddress = (address) => {
  const trimmed = String(address || '').trim();
  if (!trimmed) return null;

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}, ${parts[1]}` : trimmed;
};

const summarizeSettingValue = (key, value) => {
  if (key === 'privacy_zones') return Array.isArray(value) ? `${value.length} zone(s)` : '0 zone(s)';
  if (key === 'last_map_center') return value ? '[map center saved]' : null;
  if (/url|endpoint/i.test(key)) {
    try {
      return value ? new URL(String(value)).origin : '';
    } catch {
      return value ? '[invalid url]' : '';
    }
  }

  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return Array.isArray(value) ? `${value.length} item(s)` : '[object]';
};

const summarizeSettingsPatch = (keys, before = {}, after = {}) => keys.reduce((acc, key) => {
  acc[key] = {
    from: summarizeSettingValue(key, before[key]),
    to: summarizeSettingValue(key, after[key]),
  };
  return acc;
}, {});

export async function saveLastParkedLocation({
  lat,
  lng,
  endpointLat = lat,
  endpointLng = lng,
  timestamp,
  tripId,
  address = null,
  source = 'trip_end',
  confidence = 'estimated',
  confidenceScore = null,
  confidence_score: storedConfidenceScore = null,
  evidence = [],
  accuracyM = null,
  accuracy_m: storedAccuracyM = null,
  strategy = 'last_trip_point',
  sampleCount = 1,
  sample_count: storedSampleCount = null,
  refinementCount = 0,
  refinement_count: storedRefinementCount = null,
  spreadM = null,
  spread_m: storedSpreadM = null,
  indoorEstimated,
  indoor_estimated: storedIndoorEstimated = false,
  garageEntrance,
  garage_entrance: storedGarageEntrance = null,
  note = null,
  photoDataUrl,
  photo_data_url: storedPhotoDataUrl = null,
  photoExpiresAt,
  photo_expires_at: storedPhotoExpiresAt = null,
  photoRetentionHours,
  photo_retention_hours: storedPhotoRetentionHours = null,
  photoFileId,
  photo_file_id: storedPhotoFileId = null,
  stateRevision = null,
  state_revision: storedStateRevision = null,
  vehicleId = null,
  vehicle_id: storedVehicleId = null,
  vehicleName = null,
  vehicle_name: storedVehicleName = null,
  garageHint = null,
  garage_hint: storedGarageHint = null,
  verified = false,
  correctionReason = null,
  correction_reason: storedCorrectionReason = null,
  correctedAt = null,
  corrected_at: storedCorrectedAt = null,
  recordHistory = true,
}) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  const parsedEndpointLat = Number(endpointLat);
  const parsedEndpointLng = Number(endpointLng);
  if (
    !Number.isFinite(parsedLat) ||
    !Number.isFinite(parsedLng) ||
    Math.abs(parsedLat) > 90 ||
    Math.abs(parsedLng) > 180
  ) return null;
  const normalizedTimestamp = timestamp || new Date().toISOString();
  const records = await readParkingRecords();
  if (parkedTimestampMs(records.state) > parkedTimestampMs({ timestamp: normalizedTimestamp })) {
    return records.state?.status === 'saved' ? records.parkedLocation : null;
  }
  if (
    await isPrivateParkedLocation({ lat: parsedEndpointLat, lng: parsedEndpointLng }) ||
    await isPrivateParkedLocation({ lat: parsedLat, lng: parsedLng })
  ) {
    const result = await suppressLastParkedLocation({
      timestamp: normalizedTimestamp,
      source: 'privacy_zone',
      tripId,
      stateRevision: stateRevision ?? storedStateRevision,
    });
    if (records.parkedLocation && await isPrivateParkedLocation(records.parkedLocation)) {
      await removeEncryptedJson(LAST_PARKED_KEY);
    }
    return result;
  }

  const requestedGarageEntrance = garageEntrance !== undefined
    ? garageEntrance
    : storedGarageEntrance;
  const normalizedGarageEntrance = requestedGarageEntrance &&
    Number.isFinite(Number(requestedGarageEntrance.lat)) &&
    Number.isFinite(Number(requestedGarageEntrance.lng))
    ? {
      lat: Number(requestedGarageEntrance.lat),
      lng: Number(requestedGarageEntrance.lng),
      accuracy_m: Number.isFinite(Number(requestedGarageEntrance.accuracy_m))
        ? Math.max(0, Math.round(Number(requestedGarageEntrance.accuracy_m)))
        : null,
    }
    : null;
  const safeGarageEntrance = normalizedGarageEntrance &&
    !await isPrivateParkedLocation(normalizedGarageEntrance)
    ? normalizedGarageEntrance
    : null;
  const requestedPhotoDataUrl = photoDataUrl !== undefined
    ? photoDataUrl
    : storedPhotoDataUrl;
  const requestedPhotoExpiresAt = photoExpiresAt !== undefined
    ? photoExpiresAt
    : storedPhotoExpiresAt;
  const requestedPhotoRetentionHours = photoRetentionHours !== undefined
    ? photoRetentionHours
    : storedPhotoRetentionHours;
  const requestedPhotoFileId = photoFileId !== undefined ? photoFileId : storedPhotoFileId;
  const safePhotoDataUrl = /^data:image\/(?:jpeg|png|webp);base64,/i
    .test(String(requestedPhotoDataUrl || '')) &&
    String(requestedPhotoDataUrl).length <= 1_600_000
    ? String(requestedPhotoDataUrl)
    : null;
  const parsedPhotoExpiresAt = Date.parse(String(requestedPhotoExpiresAt || ''));
  const parsedPhotoRetentionHours = Number(requestedPhotoRetentionHours);
  const resolvedStateRevision = nextParkingStateRevision(
    records,
    stateRevision ?? storedStateRevision,
  );

  const parkedLocation = {
    lat: parsedLat,
    lng: parsedLng,
    timestamp: normalizedTimestamp,
    tripId: tripId ?? null,
    state_revision: resolvedStateRevision,
    vehicle_id: vehicleId ?? storedVehicleId ?? null,
    vehicle_name: String(vehicleName ?? storedVehicleName ?? '').trim().slice(0, 80) || null,
    address: shortenParkedAddress(address),
    source,
    confidence: ['high', 'medium', 'estimated'].includes(confidence) ? confidence : 'estimated',
    confidence_score: Number.isFinite(Number(confidenceScore ?? storedConfidenceScore))
      ? Math.max(0, Math.min(100, Math.round(Number(confidenceScore ?? storedConfidenceScore))))
      : null,
    evidence: Array.from(new Set(
      (Array.isArray(evidence) ? evidence : [])
        .map((item) => String(item || '').trim().slice(0, 64))
        .filter(Boolean)
    )).slice(0, 16),
    accuracy_m: Number.isFinite(Number(accuracyM ?? storedAccuracyM))
      ? Math.max(0, Math.round(Number(accuracyM ?? storedAccuracyM)))
      : null,
    strategy,
    sample_count: Math.max(1, Math.round(Number(storedSampleCount ?? sampleCount) || 1)),
    refinement_count: Math.max(0, Math.round(Number(storedRefinementCount ?? refinementCount) || 0)),
    spread_m: Number.isFinite(Number(spreadM ?? storedSpreadM))
      ? Math.max(0, Math.round(Number(spreadM ?? storedSpreadM)))
      : null,
    indoor_estimated: indoorEstimated !== undefined
      ? indoorEstimated === true
      : storedIndoorEstimated === true,
    garage_entrance: safeGarageEntrance,
    garage_hint: String(garageHint ?? storedGarageHint ?? '').trim().slice(0, 160) || null,
    note: String(note || '').trim().slice(0, 160) || null,
    photo_data_url: safePhotoDataUrl,
    photo_file_id: /^[0-9a-fA-F-]{36}$/.test(String(requestedPhotoFileId || ''))
      ? String(requestedPhotoFileId)
      : null,
    photo_expires_at: safePhotoDataUrl && Number.isFinite(parsedPhotoExpiresAt)
      ? new Date(parsedPhotoExpiresAt).toISOString()
      : null,
    photo_retention_hours: safePhotoDataUrl && Number.isFinite(parsedPhotoRetentionHours)
      ? Math.max(0, Math.min(720, Math.round(parsedPhotoRetentionHours)))
      : null,
    verified: verified === true,
    correction_reason: String(correctionReason || storedCorrectionReason || '').trim().slice(0, 80) || null,
    corrected_at: correctedAt || storedCorrectedAt || null,
  };
  const parkingState = {
    version: 2,
    status: 'saved',
    timestamp: normalizedTimestamp,
    tripId: tripId ?? null,
    state_revision: resolvedStateRevision,
    source,
    confidence: parkedLocation.confidence,
    confidence_score: parkedLocation.confidence_score,
    evidence: parkedLocation.evidence,
    strategy: parkedLocation.strategy,
    refinement_count: parkedLocation.refinement_count,
    verified: parkedLocation.verified,
    correction_reason: parkedLocation.correction_reason,
    corrected_at: parkedLocation.corrected_at,
  };
  if (shouldPreserveHigherConfidenceParking(records.state, parkingState)) {
    await recordParkingDiagnostic(
      'confidence_downgrade_blocked',
      'A lower-confidence location was prevented from replacing the same parking event.',
      {
        tripId,
        existingScore: records.state?.confidence_score,
        incomingScore: parkingState.confidence_score,
        source,
      },
    ).catch(() => {});
    return records.parkedLocation;
  }
  await setEncryptedJson(LAST_PARKED_KEY, parkedLocation);
  await setEncryptedJson(LAST_PARKING_STATE_KEY, parkingState);
  try {
    await commitNativeParkingSnapshot(parkingState, parkedLocation);
  } catch (error) {
    if (records.parkedLocation) await setEncryptedJson(LAST_PARKED_KEY, records.parkedLocation);
    else await removeEncryptedJson(LAST_PARKED_KEY);
    if (records.state) await setEncryptedJson(LAST_PARKING_STATE_KEY, records.state);
    else await removeEncryptedJson(LAST_PARKING_STATE_KEY);
    await recordParkingDiagnostic('atomic_sync_rollback', error?.message, {
      operation: 'save',
      tripId,
      source,
      requestedRevision: parkingState.state_revision,
    }).catch(() => {});
    throw error;
  }
  if (recordHistory) {
    try {
      const historyRecord = await recordParkingHistoryState({
        ...parkingState,
        location: parkedLocation,
      });
      if (
        !historyRecord ||
        historyRecord.status !== 'saved' ||
        parkingStateRevision(historyRecord) !== resolvedStateRevision
      ) {
        throw new Error('The parking-history record did not confirm the saved revision.');
      }
    } catch (error) {
      logError('parking_history_location_save', error, {
        source,
        tripId: tripId ?? null,
      });
      try {
        await restoreParkingSnapshot(records);
      } catch (rollbackError) {
        await recordParkingDiagnostic(
          'parking_history_rollback_failed',
          rollbackError?.message || 'Parking rollback failed after a history write error.',
          { source, tripId: tripId ?? null, requestedRevision: resolvedStateRevision },
        ).catch(() => {});
        throw new Error(
          'Parking history could not be saved and Android rollback needs review. Reopen Parking before using directions.',
        );
      }
      await refreshNativeParkingWidget();
      throw new Error('Parking was not saved because its history record could not be verified. Your previous parking was restored.');
    }
  }
  await refreshNativeParkingWidget();
  await recordParkingDiagnostic('parking_saved', 'Parking page and Android widget committed the same revision.', {
    tripId,
    revision: parkingState.state_revision,
    confidenceScore: parkingState.confidence_score,
    source,
  }).catch(() => {});
  return parkedLocation;
}

// ─── Local Settings Store ──────────────────────────────────────────────────────
export const localSettings = {
  async hydrateFromNative() {
    try {
      const { Capacitor } = await import('@capacitor/core');
      if (!Capacitor.isNativePlatform()) return this.get();

      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key: SETTINGS_KEY });
      if (!value) return this.get();

      if (settingsCache && value === settingsCacheSerialized) return settingsCache;
      const parsed = JSON.parse(value);
      const { settings: merged, changed } = migrateDefaultSettings(parsed);
      const serialized = JSON.stringify(merged);
      const previousSerialized = localStorage.getItem(SETTINGS_KEY);
      localStorage.setItem(SETTINGS_KEY, serialized);
      if (changed) await Preferences.set({ key: SETTINGS_KEY, value: serialized });
      lastNativeSettingsSync = serialized;
      settingsCache = merged;
      settingsCacheSerialized = serialized;
      if (serialized !== previousSerialized) {
        dispatchSettingsChanged(merged, { source: 'native_hydrate' });
      }
      return merged;
    } catch {
      return this.get();
    }
  },
  get() {
    try {
      const storage = settingsStorage();
      const raw = storage?.getItem(SETTINGS_KEY);
      if (raw) {
        if (settingsCache && raw === settingsCacheSerialized) return settingsCache;
        const parsed = JSON.parse(raw);
        const { settings: merged, changed } = migrateDefaultSettings(parsed);
        const serialized = JSON.stringify(merged);
        if (changed || serialized !== raw) storage.setItem(SETTINGS_KEY, serialized);
        settingsCache = merged;
        settingsCacheSerialized = serialized;
        return merged;
      }
      if (!storage && memorySettings) {
        if (settingsCache === memorySettings) return settingsCache;
        const { settings: merged } = migrateDefaultSettings(memorySettings);
        const serialized = JSON.stringify(merged);
        memorySettings = merged;
        settingsCache = merged;
        settingsCacheSerialized = serialized;
        return merged;
      }
      const defaults = { ...DEFAULT_SETTINGS };
      const serialized = JSON.stringify(defaults);
      if (storage) storage.setItem(SETTINGS_KEY, serialized);
      else memorySettings = defaults;
      settingsCache = defaults;
      settingsCacheSerialized = serialized;
      return defaults;
    } catch {
      return settingsCache || { ...DEFAULT_SETTINGS };
    }
  },
  set(data) {
    try {
      const { settings: normalized } = migrateDefaultSettings(data);
      const serialized = JSON.stringify(normalized);
      const storage = settingsStorage();
      if (storage) storage.setItem(SETTINGS_KEY, serialized);
      else memorySettings = normalized;
      settingsCache = normalized;
      settingsCacheSerialized = serialized;
      syncSettingsForNative(normalized, serialized);
      dispatchSettingsChanged(normalized, { source: 'set' });
      return normalized;
    } catch (error) {
      logError('settings_local_persist', error, {
        requested_key_count: Object.keys(data || {}).length,
      });
      return this.get();
    }
  },
  update(patch) {
    const current = this.get();
    const updated = { ...current, ...patch };
    const requestedKeys = Object.keys(patch || {});
    const changedKeys = requestedKeys.filter((key) => current[key] !== updated[key]);
    const persisted = changedKeys.length ? this.set(updated) : current;
    const appliedKeys = changedKeys.filter((key) => persisted[key] === updated[key]);
    const failedKeys = changedKeys.filter((key) => persisted[key] !== updated[key]);
    const unchangedRequestedKeys = requestedKeys.filter((key) => current[key] === updated[key]);
    const result = failedKeys.length
      ? (appliedKeys.length ? 'partial' : 'not_applied')
      : changedKeys.length
        ? 'applied'
        : 'no_effect';

    if (changedKeys.length) {
      recordSystemEvent('settings_changed', {
        requested_keys: requestedKeys,
        changed_keys: changedKeys,
        applied_keys: appliedKeys,
        failed_keys: failedKeys,
        changes: summarizeSettingsPatch(changedKeys, current, persisted),
      }, {
        category: 'settings',
        title: 'Settings changed',
        severity: failedKeys.length ? 'warn' : 'info',
      });
    }

    if (result !== 'no_effect') {
      recordSystemEvent('settings_update_verified', {
        result,
        requested_keys: requestedKeys,
        changed_keys: changedKeys,
        applied_keys: appliedKeys,
        failed_keys: failedKeys,
        unchanged_requested_keys: unchangedRequestedKeys,
        persisted_matches_request: failedKeys.length === 0,
        changes: summarizeSettingsPatch(requestedKeys, current, persisted),
      }, {
        category: 'settings',
        title: 'Settings update verified',
        severity: failedKeys.length ? 'warn' : 'info',
      });
    }
    return persisted;
  },
};
export function clearSettingsMemoryForErasure() {
  memorySettings = null;
  settingsCache = null;
  settingsCacheSerialized = '';
  activeTripMemory = null;
  lastNativeSettingsSync = '';
}

const normalizeThemeMode = (mode) => (THEME_MODE_VALUES.includes(mode) ? mode : DEFAULT_SETTINGS.dark_mode);

const syncNativeSystemBars = (themeMode, resolvedTheme) => {
  if (typeof window === 'undefined') return;
  const signature = `${themeMode}:${resolvedTheme}`;
  if (signature === lastSystemBarsSignature) return;
  lastSystemBarsSignature = signature;

  import('@capacitor/core')
    .then(({ Capacitor }) => {
      if (!Capacitor.isNativePlatform()) return null;
      const plugin = Capacitor.Plugins?.SystemBars || globalThis.Capacitor?.Plugins?.SystemBars;
      if (typeof plugin?.setStyle !== 'function') return null;
      return plugin.setStyle({ themeMode, resolvedTheme });
    })
    .catch((error) => {
      logError('system_bars_theme_sync', error, {
        theme_mode: themeMode,
        resolved_theme: resolvedTheme,
      });
    });
};

const getSystemThemeQueryList = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!systemThemeQueryList) systemThemeQueryList = window.matchMedia(SYSTEM_THEME_QUERY);
  return systemThemeQueryList;
};

const renderThemeMode = (mode) => {
  if (typeof document === 'undefined') return;
  const normalized = normalizeThemeMode(mode);
  const shouldUseDark = normalized === 'dark' ||
    (normalized === 'system' && getSystemThemeQueryList()?.matches === true);
  const resolvedTheme = shouldUseDark ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', shouldUseDark);
  document.documentElement.dataset.themeMode = normalized;
  document.documentElement.dataset.resolvedTheme = resolvedTheme;
  document.documentElement.style.colorScheme = shouldUseDark ? 'dark' : 'light';
  syncNativeSystemBars(normalized, resolvedTheme);
};

const detachSystemThemeListener = () => {
  if (!systemThemeQueryList || !systemThemeQueryListener) return;
  if (typeof systemThemeQueryList.removeEventListener === 'function') {
    systemThemeQueryList.removeEventListener('change', systemThemeQueryListener);
  } else if (typeof systemThemeQueryList.removeListener === 'function') {
    systemThemeQueryList.removeListener(systemThemeQueryListener);
  }
  systemThemeQueryListener = null;
};

const syncSystemThemeListener = () => {
  if (activeThemeMode !== 'system') {
    detachSystemThemeListener();
    return;
  }
  const queryList = getSystemThemeQueryList();
  if (!queryList || systemThemeQueryListener) return;
  systemThemeQueryListener = () => {
    if (activeThemeMode === 'system') renderThemeMode('system');
  };
  if (typeof queryList.addEventListener === 'function') {
    queryList.addEventListener('change', systemThemeQueryListener);
  } else if (typeof queryList.addListener === 'function') {
    queryList.addListener(systemThemeQueryListener);
  }
};

export function applyThemeMode(mode = localSettings.get().dark_mode || 'system') {
  activeThemeMode = normalizeThemeMode(mode);
  syncSystemThemeListener();
  renderThemeMode(activeThemeMode);
}

// ─── Active Trip Store (crash recovery) ───────────────────────────────────────
export const activeTripStore = {
  async hydrate() {
    const recovered = await getEncryptedJson(ACTIVE_TRIP_KEY, null);
    activeTripMemory = recovered ? sanitizeTripForPrivacyStorage(recovered) : null;
    if (recovered && JSON.stringify(recovered) !== JSON.stringify(activeTripMemory)) {
      await setEncryptedJson(ACTIVE_TRIP_KEY, activeTripMemory);
    }
    dispatchActiveTripChanged();
    return activeTripMemory;
  },
  get() {
    return activeTripMemory;
  },
  set(trip) {
    activeTripMemory = sanitizeTripForPrivacyStorage(trip);
    const tripSnapshot = activeTripMemory;
    dispatchActiveTripChanged();
    activeTripWriteQueue = activeTripWriteQueue
      .then(() => setEncryptedJson(ACTIVE_TRIP_KEY, tripSnapshot))
      .catch((error) => {
        logError('active_trip_persist', error, {
          trip_state: tripSnapshot?.trip_state || null,
          start_source: tripSnapshot?.start_source || null,
          route_point_count: Array.isArray(tripSnapshot?.route_points) ? tripSnapshot.route_points.length : 0,
        });
      });
  },
  clear() {
    activeTripMemory = null;
    dispatchActiveTripChanged();
    activeTripWriteQueue = activeTripWriteQueue
      .then(() => removeEncryptedJson(ACTIVE_TRIP_KEY))
      .catch((error) => {
        logError('active_trip_clear_persist', error);
      });
  },
  flush() {
    return activeTripWriteQueue;
  },
  addPoint(point) {
    const trip = this.get();
    if (!trip) return;
    trip.route_points = trip.route_points || [];
    trip.route_points.push(redactRoutePointForPrivacyStorage(point));
    this.set(trip);
  },
};

// ─── Permission Checker ────────────────────────────────────────────────────────
export async function checkLocationPermission() {
  if (!navigator.permissions) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    return result.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unknown';
  }
}

export async function requestLocationPermission() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { timeout: 10000 }
    );
  });
}
