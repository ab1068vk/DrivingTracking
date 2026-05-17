/**
 * Road Sage Tracking Store
 * Manages active trip state in memory and persists to sessionStorage for crash recovery.
 * This is a singleton store used by the tracking service.
 */
import { getJson, setJson } from '@/lib/mobileStorage';

const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
const SETTINGS_KEY = 'drivesense_settings';
const LAST_PARKED_KEY = 'drivesense_last_parked';

// ─── Default Settings ──────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
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
  threshold_harsh_brake_ms2: 4.5,
  threshold_rapid_accel_ms2: 3.5,
  threshold_tailgate_decel_ms2: 2.5,
  threshold_sharp_turn_g_low: 0.30,
  threshold_sharp_turn_g_medium: 0.45,
  threshold_sharp_turn_g_high: 0.60,
  threshold_speeding_kmh: 130,
  threshold_speed_over_kmh: 10,
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
  threshold_speed_creep_kmh: 10,
  threshold_overtake_accel_ms2: 3.0,
  advanced_safety_detection_enabled: true,
  speed_warning_enabled: true,
  speed_limit_lookup_enabled: true,
  weather_context_enabled: true,
  min_speed_rapid_accel_kmh: 5,
  min_speed_harsh_brake_kmh: 25,
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  weekly_goal_max_night_km: 20,
  onboarding_completed: true, // true by default for web; native Android handles its own onboarding
  location_permission_granted: false,
  background_location_granted: false,
  tracking_paused: false,
  live_coaching_enabled: true,
  voice_alerts_enabled: true,
  sensor_fusion_enabled: true,
  crash_detection_enabled: true,
  emergency_workflow_enabled: false,
  map_matching_enabled: true,
  osrm_map_matching_url: 'https://router.project-osrm.org',
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
  privacy_zones: [],
};

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
  get() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
      // New user: save defaults immediately so we can detect returning users
      const defaults = { ...DEFAULT_SETTINGS };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(defaults));
      return defaults;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },
  set(data) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
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
