/**
 * DriveSense Tracking Store
 * Manages active trip state in memory and persists to sessionStorage for crash recovery.
 * This is a singleton store used by the tracking service.
 */

const ACTIVE_TRIP_KEY = 'drivesense_active_trip';
const SETTINGS_KEY = 'drivesense_settings';

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
  threshold_speed_creep_kmh: 10,
  threshold_overtake_accel_ms2: 3.0,
  advanced_safety_detection_enabled: true,
  speed_warning_enabled: true,
  min_speed_rapid_accel_kmh: 15,
  min_speed_harsh_brake_kmh: 25,
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  onboarding_completed: true, // true by default for web; native Android handles its own onboarding
  location_permission_granted: false,
  background_location_granted: false,
  tracking_paused: false,
};

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
