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
  trip_start_notification: true,
  trip_end_notification: true,
  weekly_report_notification: true,
  safe_driving_reminder: false,
  threshold_harsh_brake_ms2: 4.5,
  threshold_rapid_accel_ms2: 3.5,
  threshold_sharp_turn_degs: 45,
  threshold_speeding_kmh: 130,
  threshold_idle_seconds: 60,
  threshold_long_drive_minutes: 120,
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

// ─── Active Trip Store (crash recovery) ───────────────────────────────────────
export const activeTripStore = {
  get() {
    try {
      const raw = sessionStorage.getItem(ACTIVE_TRIP_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(trip) {
    try {
      sessionStorage.setItem(ACTIVE_TRIP_KEY, JSON.stringify(trip));
    } catch {}
  },
  clear() {
    sessionStorage.removeItem(ACTIVE_TRIP_KEY);
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