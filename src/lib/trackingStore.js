/**
 * Road Sage Tracking Store
 * Manages active trip state in memory and persists to sessionStorage for crash recovery.
 * This is a singleton store used by the tracking service.
 */
import { getJson, setJson } from '@/lib/mobileStorage';
import { clamp as clampNumber } from '@/lib/mathUtils';
import {
  DEFAULT_CO2_BASELINE_KG_PER_100KM,
  DEFAULT_EV_KWH_PER_100KM,
  DEFAULT_GRID_CO2_KG_PER_KWH,
  DEFAULT_TREE_CO2_KG_PER_YEAR,
} from '@/lib/tripInsights';

const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
const SETTINGS_KEY = 'drivesense_settings';
const LAST_PARKED_KEY = 'drivesense_last_parked';
let lastNativeSettingsSync = '';

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
  settings_defaults_version: 2,
  tracking_mode: 'manual',
  units: 'metric',
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
  threshold_harsh_brake_ms2: 3.5,
  threshold_rapid_accel_ms2: 3.0,
  threshold_tailgate_decel_ms2: 2.5,
  threshold_sharp_turn_g_low: 0.35,
  threshold_sharp_turn_g_medium: 0.45,
  threshold_sharp_turn_g_high: 0.60,
  threshold_speeding_kmh: 100,
  threshold_speed_over_kmh: 5,
  threshold_idle_seconds: 90,
  threshold_long_drive_minutes: 120,
  night_detection_mode: 'sunset',
  night_start_time: '22:00',
  night_end_time: '06:00',
  night_sunset_offset_minutes: 0,
  night_sunrise_offset_minutes: 0,
  threshold_near_miss_brake_ms2: 3.5,
  threshold_near_miss_turn_degs: 30,
  threshold_drowsy_heading_std: 8,
  threshold_phone_proxy_oscillations: 3,
  phone_use_detection_enabled: true,
  phone_use_live_alert_enabled: true,
  phone_use_show_on_map: true,
  phone_use_affects_score: true,
  phone_use_sensitivity: 'medium',
  phone_micro_steer_count: 4,
  phone_creep_rate_kmh_s: 1.5,
  phone_lane_drift_deg: 8,
  phone_coupling_threshold: 0.15,
  phone_confidence_threshold: 0.40,
  phone_min_window_s: 4,
  threshold_speed_creep_kmh: 5,
  threshold_overtake_accel_ms2: 3.0,
  advanced_safety_detection_enabled: true,
  speed_warning_enabled: true,
  speed_limit_lookup_enabled: true,
  weather_context_enabled: true,
  external_context_auto_fetch_enabled: false,
  min_speed_rapid_accel_kmh: 5,
  min_speed_harsh_brake_kmh: 25,
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  weekly_goal_max_night_km: 20,
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
  osrm_map_matching_url: '',
  predictive_route_risk_enabled: true,
  obd_bluetooth_enabled: false,
  notif_safety_alerts_enabled: true,
  notif_phone_use_alert_enabled: true,
  notif_drowsy_alert_enabled: true,
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
};

const IMPORT_NUMBER_RANGES = {
  data_retention_days: [1, 3650],
  threshold_harsh_brake_ms2: [2, 8],
  threshold_rapid_accel_ms2: [0.5, 15],
  threshold_tailgate_decel_ms2: [0.5, 15],
  threshold_sharp_turn_g_low: [0.05, 2],
  threshold_sharp_turn_g_medium: [0.05, 2],
  threshold_sharp_turn_g_high: [0.05, 2],
  threshold_speeding_kmh: [10, 250],
  threshold_speed_over_kmh: [0, 80],
  threshold_idle_seconds: [10, 3600],
  threshold_long_drive_minutes: [5, 1440],
  night_sunset_offset_minutes: [-180, 180],
  night_sunrise_offset_minutes: [-180, 180],
  threshold_near_miss_brake_ms2: [0.5, 15],
  threshold_near_miss_turn_degs: [1, 180],
  threshold_drowsy_heading_std: [1, 90],
  threshold_phone_proxy_oscillations: [1, 20],
  phone_micro_steer_count: [1, 20],
  phone_creep_rate_kmh_s: [0.1, 10],
  phone_lane_drift_deg: [1, 90],
  phone_coupling_threshold: [0, 1],
  phone_confidence_threshold: [0, 1],
  phone_min_window_s: [1, 120],
  threshold_speed_creep_kmh: [1, 80],
  threshold_overtake_accel_ms2: [0.5, 15],
  min_speed_rapid_accel_kmh: [0, 100],
  min_speed_harsh_brake_kmh: [0, 150],
  weekly_goal_harsh_brakes: [0, 1000],
  weekly_goal_speeding_events: [0, 1000],
  weekly_goal_min_avg_score: [0, 100],
  weekly_goal_max_night_trips: [0, 1000],
  weekly_goal_max_night_km: [0, 10000],
  notif_inactive_nudge_days: [1, 365],
  notif_min_score_for_post_trip: [0, 100],
  co2_baseline_kg_per_100km: [0, 50],
  default_ev_kwh_per_100km: [5, 40],
  grid_co2_kg_per_kwh: [0, 2],
  tree_co2_kg_per_year: [1, 100],
};

const SETTINGS_ENUMS = {
  tracking_mode: ['manual', 'auto_detect', 'background_auto'],
  units: ['metric', 'imperial'],
  dark_mode: ['system', 'light', 'dark'],
  night_detection_mode: ['sunset', 'custom'],
  phone_use_sensitivity: ['low', 'medium', 'high'],
};

const IMPORT_ENUMS = {
  ...SETTINGS_ENUMS,
  tracking_mode: ['manual', 'auto_detect'],
};

const IMPORT_STRIPPED_KEYS = new Set([
  'osrm_map_matching_url',
]);

const sanitizeImportedPrivacyZones = (zones) => (
  Array.isArray(zones)
    ? zones
      .filter((zone) => zone && typeof zone === 'object')
      .slice(0, 20)
      .map((zone, index) => {
        const radius = clampNumber(Number(zone.radius_m) || 150, 50, 1000);
        /** @type {{id:string,label:string,radius_m:number,masked_for_privacy?:boolean,lat?:number,lng?:number}} */
        const sanitized = {
          id: typeof zone.id === 'string' ? zone.id.slice(0, 80) : `privacy_zone_import_${index}`,
          label: typeof zone.label === 'string' && zone.label.trim()
            ? zone.label.trim().slice(0, 80)
            : 'Private place',
          radius_m: radius,
          ...(zone.masked_for_privacy === true ? { masked_for_privacy: true } : {}),
        };
        const lat = Number(zone.lat);
        const lng = Number(zone.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
          sanitized.lat = lat;
          sanitized.lng = lng;
        }
        return sanitized;
      })
    : []
);

export function sanitizeImportedSettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const sanitized = {};
  Object.entries(DEFAULT_SETTINGS).forEach(([key, defaultValue]) => {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) return;
    if (IMPORT_STRIPPED_KEYS.has(key)) return;
    const value = raw[key];

    if (key === 'privacy_zones') {
      sanitized.privacy_zones = sanitizeImportedPrivacyZones(value);
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

  return sanitized;
}

export function validateSettingsPatch(patch = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: ['Settings update must be an object.'] };
  }

  Object.entries(patch).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;
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
  return getJson(LAST_PARKED_KEY, null);
}

export async function saveLastParkedLocation({ lat, lng, timestamp, tripId, address = null, source = 'trip_end' }) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;

  const parkedLocation = {
    lat: parsedLat,
    lng: parsedLng,
    timestamp: timestamp || new Date().toISOString(),
    tripId: tripId ?? null,
    address,
    source,
  };
  await setJson(LAST_PARKED_KEY, parkedLocation);
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
      const merged = { ...DEFAULT_SETTINGS, ...parsed };
      const serialized = JSON.stringify(merged);
      localStorage.setItem(SETTINGS_KEY, serialized);
      lastNativeSettingsSync = serialized;
      return merged;
    } catch {
      return this.get();
    }
  },
  get() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const merged = { ...DEFAULT_SETTINGS, ...parsed };
        if ((parsed.settings_defaults_version || 1) < 2) {
          if (parsed.threshold_harsh_brake_ms2 == null || parsed.threshold_harsh_brake_ms2 === 4.5) merged.threshold_harsh_brake_ms2 = 3.5;
          if (parsed.threshold_rapid_accel_ms2 == null || parsed.threshold_rapid_accel_ms2 === 3.5) merged.threshold_rapid_accel_ms2 = 3.0;
          if (parsed.threshold_speeding_kmh == null || parsed.threshold_speeding_kmh === 130) merged.threshold_speeding_kmh = 100;
          if (parsed.threshold_speed_over_kmh == null || parsed.threshold_speed_over_kmh === 10) merged.threshold_speed_over_kmh = 5;
          if (parsed.threshold_speed_creep_kmh == null || parsed.threshold_speed_creep_kmh === 10) merged.threshold_speed_creep_kmh = 5;
          if (parsed.threshold_sharp_turn_g_low == null || parsed.threshold_sharp_turn_g_low === 0.30) merged.threshold_sharp_turn_g_low = 0.35;
          merged.settings_defaults_version = 2;
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
          syncSettingsForNative(merged);
        }
        syncSettingsForNative(merged);
        return merged;
      }
      // New user: save defaults immediately so we can detect returning users
      const defaults = { ...DEFAULT_SETTINGS };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(defaults));
      syncSettingsForNative(defaults);
      return defaults;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  set(data) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
      syncSettingsForNative(data);
    } catch {}
  },
  update(patch) {
    const current = this.get();
    const updated = { ...current, ...patch };
    this.set(updated);
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
  get() {
    try {
      const raw = localStorage.getItem(ACTIVE_TRIP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(trip) {
    try {
      localStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify(trip));
    } catch {}
  },
  clear() {
    localStorage.removeItem(ACTIVE_TRIP_KEY);
  },
  addPoint(point) {
    const trip = this.get();
    if (!trip) return;
    trip.route_points = trip.route_points || [];
    trip.route_points.push(point);
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
