/**
 * Road Sage Tracking Store
 * Manages active trip state in memory with encrypted persistence for crash recovery.
 * This is a singleton store used by the tracking service.
 */
import { clamp as clampNumber } from '@/lib/mathUtils';
import { CURRENCY_SYMBOL_OPTIONS } from '@/lib/currency';
import { NIGHT_END_TIME, NIGHT_START_TIME } from '@/lib/appConstants';
import { logError } from '@/lib/errorReporting';
import { recordSystemEvent } from '@/lib/systemLog';
import { scoringValue } from '@/lib/scoringConstants';
import { ECO_DEFAULTS } from '@/lib/ecoDefaults';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
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

const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
const SETTINGS_KEY = 'drivesense_settings';
const LAST_PARKED_KEY = 'drivesense_last_parked';
export const PARKED_LOCATION_PRIVACY_GUARD_M = 50;
let lastNativeSettingsSync = '';
let memorySettings = null;
let activeTripMemory = null;
let activeTripWriteQueue = Promise.resolve();
const CURRENT_SETTINGS_DEFAULTS_VERSION = 10;

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
  try {
    return new URL(value).toString().replace(/\/$/, '');
  } catch {
    return '';
  }
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

const syncSettingsForNative = (settings) => {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(settings);
  if (serialized === lastNativeSettingsSync) return;
  lastNativeSettingsSync = serialized;
  import('@capacitor/core')
    .then(({ Capacitor }) => {
      if (!Capacitor.isNativePlatform()) return null;
      return import('@capacitor/preferences');
    })
    .then((module) => {
      if (!module?.Preferences) return;
      module.Preferences.set({ key: SETTINGS_KEY, value: serialized }).catch(() => {});
    })
    .catch(() => {});
};

// ─── Default Settings ──────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
  settings_defaults_version: CURRENT_SETTINGS_DEFAULTS_VERSION,
  tracking_mode: 'manual',
  units: 'metric',
  currencySymbol: '$',
  dark_mode: 'system',
  notifications_enabled: true,
  notification_permission_granted: false,
  trip_start_notification: true,
  trip_end_notification: true,
  weekly_report_notification: true,
  achievement_notifications: true,
  safe_driving_reminder: false,
  background_tracking_enabled: false,
  auto_tracking_enabled: false,
  activity_permission_granted: false,
  data_retention_days: 365,
  threshold_harsh_brake_ms2: scoringValue('HARSH_BRAKE_MS2'),
  threshold_rapid_accel_ms2: scoringValue('RAPID_ACCEL_MS2'),
  threshold_stop_start_decel_ms2: scoringValue('STOP_START_DECEL_MS2'),
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
  speed_limit_lookup_enabled: true,
  country_code: '',
  configurable_country_defaults: 'global',
  weather_context_enabled: true,
  external_context_auto_fetch_enabled: false,
  external_context_auto_fetch_consented_at: '',
  min_speed_rapid_accel_kmh: scoringValue('MIN_SPEED_RAPID_ACCEL_KMH'),
  min_speed_harsh_brake_kmh: scoringValue('MIN_SPEED_HARSH_BRAKE_KMH'),
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  weekly_goal_max_night_km: 20,
  ubi_optimal_annual_km: scoringValue('UBI_OPTIMAL_ANNUAL_KM'),
  ubi_mileage_score_spread_km: scoringValue('UBI_MILEAGE_SPREAD_KM'),
  onboarding_completed: false,
  location_permission_granted: false,
  background_location_granted: false,
  tracking_paused: false,
  live_coaching_enabled: true,
  voice_alerts_enabled: true,
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

  merged.settings_defaults_version = CURRENT_SETTINGS_DEFAULTS_VERSION;
  return {
    settings: merged,
    changed: calibrationSharingChanged || ecoSettingsRepaired || version < CURRENT_SETTINGS_DEFAULTS_VERSION || legacyProxyKeys.some((key) => Object.prototype.hasOwnProperty.call(parsed, key)),
  };
}

const IMPORT_NUMBER_RANGES = {
  data_retention_days: [1, 3650],
  threshold_harsh_brake_ms2: [2, 8],
  threshold_rapid_accel_ms2: [0.5, 15],
  threshold_stop_start_decel_ms2: [0.5, 15],
  threshold_sharp_turn_g_low: [0.05, 2],
  threshold_sharp_turn_g_medium: [0.05, 2],
  threshold_sharp_turn_g_high: [0.05, 2],
  threshold_speeding_kmh: [10, 250],
  threshold_speed_over_kmh: [0, 80],
  threshold_eco_cruise_min_kmh: [0, 160],
  threshold_eco_cruise_max_kmh: [20, 200],
  eco_cruise_score_multiplier: [50, 200],
  eco_idle_penalty_multiplier: [0, 300],
  eco_idle_max_penalty: [0, 50],
  eco_min_moving_kmh: [0, 50],
  threshold_idle_seconds: [10, 3600],
  threshold_long_drive_minutes: [5, 1440],
  night_sunset_offset_minutes: [-180, 180],
  night_sunrise_offset_minutes: [-180, 180],
  threshold_manoeuvre_alert_brake_ms2: [0.5, 15],
  threshold_manoeuvre_alert_turn_degs: [1, 180],
  threshold_heading_drift_std_degs: [1, 90],
  threshold_phone_proxy_oscillations: [1, 20],
  phone_micro_steer_count: [1, 20],
  phone_micro_steer_window_s: [1, 120],
  phone_proxy_max_accuracy_m: [1, 100],
  phone_creep_rate_kmh_s: [0.1, 10],
  phone_lane_drift_deg: [1, 90],
  phone_coupling_threshold: [0, 1],
  phone_confidence_threshold: [0, 1],
  phone_min_window_s: [1, 120],
  threshold_speed_creep_kmh: [1, 80],
  threshold_overtake_accel_ms2: [3, 5],
  min_speed_rapid_accel_kmh: [0, 100],
  min_speed_harsh_brake_kmh: [0, 150],
  weekly_goal_harsh_brakes: [0, 1000],
  weekly_goal_speeding_events: [0, 1000],
  weekly_goal_min_avg_score: [0, 100],
  weekly_goal_max_night_trips: [0, 1000],
  weekly_goal_max_night_km: [0, 10000],
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
  tracking_mode: ['manual', 'auto_detect', 'background_auto'],
  units: ['metric', 'imperial'],
  currencySymbol: CURRENCY_SYMBOL_OPTIONS.map((option) => option.value),
  dark_mode: ['system', 'light', 'dark'],
  night_detection_mode: ['sunset', 'custom'],
  phone_use_sensitivity: ['low', 'medium', 'high'],
  configurable_country_defaults: ['global', 'ca', 'us', 'gb', 'uk', 'de', 'au', 'fr'],
  privacy_zones_native_sync_status: ['', 'ok', 'failed'],
};

const IMPORT_ENUMS = {
  ...SETTINGS_ENUMS,
  tracking_mode: ['manual', 'auto_detect'],
};

const IMPORT_STRIPPED_KEYS = new Set([
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
          exclude_from_osrm: zone.exclude_from_osrm !== false,
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
      const [min, max] = IMPORT_NUMBER_RANGES[key] || [-1_000_000, 1_000_000];
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
      try {
        new URL(endpoint);
      } catch {
        errors.push('osrm_map_matching_url must be a valid URL.');
        return;
      }
      if (isPublicOsrmDemoUrl(endpoint)) errors.push('Use a private or trusted OSRM endpoint; the public OSRM demo cannot be saved as a route-snapping endpoint.');
      return;
    }
    if (SETTINGS_ENUMS[key] && !SETTINGS_ENUMS[key].includes(value)) {
      errors.push(`${key} must be one of: ${SETTINGS_ENUMS[key].join(', ')}.`);
      return;
    }
    if (IMPORT_NUMBER_RANGES[key]) {
      const number = Number(value);
      const [min, max] = IMPORT_NUMBER_RANGES[key];
      if (!Number.isFinite(number) || number < min || number > max) {
        errors.push(`${key} must be between ${min} and ${max}.`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

export async function getLastParkedLocation() {
  const parkedLocation = await getEncryptedJson(LAST_PARKED_KEY, null);
  if (parkedLocation && await isPrivateParkedLocation(parkedLocation)) {
    await removeEncryptedJson(LAST_PARKED_KEY);
    return null;
  }
  return parkedLocation;
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

export async function saveLastParkedLocation({ lat, lng, timestamp, tripId, address = null, source = 'trip_end' }) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  if (await isPrivateParkedLocation({ lat: parsedLat, lng: parsedLng })) {
    await removeEncryptedJson(LAST_PARKED_KEY);
    return null;
  }

  const parkedLocation = {
    lat: parsedLat,
    lng: parsedLng,
    timestamp: timestamp || new Date().toISOString(),
    tripId: tripId ?? null,
    address: shortenParkedAddress(address),
    source,
  };
  await setEncryptedJson(LAST_PARKED_KEY, parkedLocation);
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

      const parsed = JSON.parse(value);
      const { settings: merged, changed } = migrateDefaultSettings(parsed);
      const serialized = JSON.stringify(merged);
      localStorage.setItem(SETTINGS_KEY, serialized);
      if (changed) await Preferences.set({ key: SETTINGS_KEY, value: serialized });
      lastNativeSettingsSync = serialized;
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
        const parsed = JSON.parse(raw);
        const { settings: merged, changed } = migrateDefaultSettings(parsed);
        if (changed) {
          storage.setItem(SETTINGS_KEY, JSON.stringify(merged));
          syncSettingsForNative(merged);
        }
        syncSettingsForNative(merged);
        return merged;
      }
      if (!storage && memorySettings) {
        const { settings: merged } = migrateDefaultSettings(memorySettings);
        memorySettings = merged;
        return merged;
      }
      // New user: save defaults immediately so we can detect returning users
      const defaults = { ...DEFAULT_SETTINGS };
      if (storage) storage.setItem(SETTINGS_KEY, JSON.stringify(defaults));
      else memorySettings = defaults;
      syncSettingsForNative(defaults);
      return defaults;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  set(data) {
    try {
      const storage = settingsStorage();
      if (storage) storage.setItem(SETTINGS_KEY, JSON.stringify(data));
      else memorySettings = data;
      syncSettingsForNative(data);
    } catch {}
  },
  update(patch) {
    const current = this.get();
    const updated = { ...current, ...patch };
    this.set(updated);
    const requestedKeys = Object.keys(patch || {});
    const changedKeys = requestedKeys.filter((key) => current[key] !== updated[key]);
    const persisted = this.get();
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
        changes: summarizeSettingsPatch(changedKeys, current, updated),
      }, {
        category: 'settings',
        title: 'Settings changed',
        severity: failedKeys.length ? 'warn' : 'info',
      });
    }

    recordSystemEvent('settings_update_verified', {
      result,
      requested_keys: requestedKeys,
      changed_keys: changedKeys,
      applied_keys: appliedKeys,
      failed_keys: failedKeys,
      unchanged_requested_keys: unchangedRequestedKeys,
      persisted_matches_request: failedKeys.length === 0,
      changes: summarizeSettingsPatch(requestedKeys, current, updated),
    }, {
      category: 'settings',
      title: result === 'no_effect' ? 'Settings update had no effect' : 'Settings update verified',
      severity: result === 'applied' ? 'info' : 'warn',
    });
    return updated;
  },
};

export function applyThemeMode(mode = localSettings.get().dark_mode || 'system') {
  if (typeof document === 'undefined') return;

  if (mode === 'dark') {
    document.documentElement.classList.add('dark');
    return;
  }

  if (mode === 'light') {
    document.documentElement.classList.remove('dark');
    return;
  }

  const prefersDark = typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', !!prefersDark);
}

// ─── Active Trip Store (crash recovery) ───────────────────────────────────────
export const activeTripStore = {
  async hydrate() {
    const recovered = await getEncryptedJson(ACTIVE_TRIP_KEY, null);
    activeTripMemory = recovered ? sanitizeTripForPrivacyStorage(recovered) : null;
    if (recovered && JSON.stringify(recovered) !== JSON.stringify(activeTripMemory)) {
      await setEncryptedJson(ACTIVE_TRIP_KEY, activeTripMemory);
    }
    return activeTripMemory;
  },
  get() {
    return activeTripMemory;
  },
  set(trip) {
    activeTripMemory = sanitizeTripForPrivacyStorage(trip);
    activeTripWriteQueue = activeTripWriteQueue
      .then(() => setEncryptedJson(ACTIVE_TRIP_KEY, activeTripMemory))
      .catch(() => {});
  },
  clear() {
    activeTripMemory = null;
    activeTripWriteQueue = activeTripWriteQueue
      .then(() => removeEncryptedJson(ACTIVE_TRIP_KEY))
      .catch(() => {});
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
