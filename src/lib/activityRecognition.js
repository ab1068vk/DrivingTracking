import { isAndroid } from '@/lib/nativePlatform';
import { requestActivityRecognitionPermission } from '@/lib/permissions';
import { haversineDistance } from '@/lib/tripEngine';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

const UNKNOWN_GPS_STABLE_M = 8;
const PARKED_GPS_DRIFT_M = 20;
const VERY_STABLE_PARKED_DRIFT_M = 5;
export const ACTIVITY_STATE_MAX_AGE_MS = 30_000;
export const ACTIVITY_POLL_INTERVAL_MS = 5000;
export const AUTO_START_IN_VEHICLE_CONFIDENCE = 65;
export const AUTO_START_SPEED_KMH = 5;
export const AUTO_START_IN_VEHICLE_SECONDS = 2;
export const AUTO_START_GPS_FALLBACK_SECONDS = 2;
export const WALKING_SPEED_CUTOFF_KMH = 10;
const SETTINGS_KEY = 'drivesense_settings';

export const ACTIVITY_TYPES = {
  IN_VEHICLE: 'in_vehicle',
  ON_FOOT: 'on_foot',
  WALKING: 'walking',
  RUNNING: 'running',
  STILL: 'still',
  ON_BICYCLE: 'on_bicycle',
  CYCLING: 'cycling',
  UNKNOWN: 'unknown',
};

const nativePrivacyZoneSyncBlocked = () => {
  try {
    if (typeof localStorage === 'undefined') return false;
    const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return settings?.privacy_zones_native_sync_status === 'failed';
  } catch {
    return false;
  }
};

export async function startActivityRecognition(onActivity, onError) {
  if (!isAndroid()) return null;

  const granted = await requestActivityRecognitionPermission();
  if (!granted) {
    onError?.({ message: 'Physical activity permission was denied.' });
    return null;
  }

  try {
    const listener = await ActivityRecognition.addListener('activityChanged', onActivity);
    await ActivityRecognition.start({ intervalMs: ACTIVITY_POLL_INTERVAL_MS });
    recordSystemEvent('android_activity_recognition_started', {
      interval_ms: ACTIVITY_POLL_INTERVAL_MS,
    }, { category: 'background', source: 'android', title: 'Activity recognition started' });
    return async () => {
      try {
        await ActivityRecognition.stop();
        await listener.remove();
        recordSystemEvent('android_activity_recognition_stopped', {}, {
          category: 'background',
          source: 'android',
          title: 'Activity recognition stopped',
        });
      } catch (error) {
        logSystemFailure('android_activity_recognition_stop', error, { source: 'android' });
        throw error;
      }
    };
  } catch (error) {
    logSystemFailure('android_activity_recognition_start', error, {
      interval_ms: ACTIVITY_POLL_INTERVAL_MS,
    });
    onError?.({ message: error.message || 'Activity recognition is unavailable on this device.' });
    return null;
  }
}

export async function startNativeAutoTracking() {
  if (!isAndroid()) return false;
  if (nativePrivacyZoneSyncBlocked()) {
    recordSystemEvent('android_native_auto_tracking_blocked_privacy_sync', {
      reason: 'privacy_zones_native_sync_failed',
    }, {
      category: 'privacy',
      source: 'android',
      severity: 'warn',
      title: 'Native auto tracking blocked',
      message: 'Re-save privacy zones before enabling Android background auto tracking.',
    });
    throw new Error('Android privacy-zone sync is not verified. Re-save privacy zones before enabling background auto tracking.');
  }
  try {
    const result = await ActivityRecognition.startNativeAutoTracking();
    const enabled = result?.enabled === true;
    recordSystemEvent('android_native_auto_tracking_started', { enabled }, {
      category: 'background',
      source: 'android',
      severity: enabled ? 'info' : 'warn',
      title: 'Native auto tracking start requested',
    });
    return enabled;
  } catch (error) {
    logSystemFailure('android_native_auto_tracking_start', error);
    throw error;
  }
}

export async function stopNativeAutoTracking() {
  if (!isAndroid()) return false;
  try {
    const result = await ActivityRecognition.stopNativeAutoTracking();
    const stopped = result?.enabled === false;
    recordSystemEvent('android_native_auto_tracking_stopped', { stopped }, {
      category: 'background',
      source: 'android',
      severity: stopped ? 'info' : 'warn',
      title: 'Native auto tracking stop requested',
    });
    return stopped;
  } catch (error) {
    logSystemFailure('android_native_auto_tracking_stop', error);
    throw error;
  }
}

export async function getNativeAutoTrackingStatus() {
  if (!isAndroid()) return { enabled: false, completedTripsCount: 0 };
  try {
    return await ActivityRecognition.nativeAutoTrackingStatus();
  } catch (error) {
    logSystemFailure('android_native_auto_tracking_status', error);
    throw error;
  }
}

export async function getNativeDiagnostics() {
  if (!isAndroid()) return { enabled: false, events: [] };
  try {
    const result = await ActivityRecognition.getNativeDiagnostics();
    return {
      enabled: result?.enabled === true,
      events: Array.isArray(result?.events) ? result.events : [],
    };
  } catch (error) {
    logSystemFailure('android_native_diagnostics_load', error);
    throw error;
  }
}

export async function clearNativeDiagnostics() {
  if (!isAndroid()) return;
  try {
    await ActivityRecognition.clearNativeDiagnostics();
    recordSystemEvent('android_native_diagnostics_cleared', {}, {
      category: 'diagnostics',
      source: 'android',
      title: 'Native diagnostics cleared',
    });
  } catch (error) {
    logSystemFailure('android_native_diagnostics_clear', error);
    throw error;
  }
}

export async function openAndroidLocationSettings() {
  if (!isAndroid()) return false;
  try {
    await ActivityRecognition.openAppLocationSettings();
    recordSystemEvent('android_location_settings_opened', {}, { category: 'permission', source: 'android' });
    return true;
  } catch (error) {
    logSystemFailure('android_location_settings_open', error);
    throw error;
  }
}

export async function openAndroidBatteryOptimizationSettings() {
  if (!isAndroid()) return false;
  try {
    await ActivityRecognition.openBatteryOptimizationSettings();
    recordSystemEvent('android_battery_settings_opened', {}, { category: 'permission', source: 'android' });
    return true;
  } catch (error) {
    logSystemFailure('android_battery_settings_open', error);
    throw error;
  }
}

export async function getAndroidBatteryOptimizationStatus() {
  if (!isAndroid()) return { batteryOptimizationIgnored: true };
  try {
    return await ActivityRecognition.batteryOptimizationStatus();
  } catch (error) {
    logSystemFailure('android_battery_status', error);
    throw error;
  }
}

export async function getAndroidUsageAccessStatus() {
  if (!isAndroid()) return { usageAccessGranted: false };
  try {
    return await ActivityRecognition.usageAccessStatus();
  } catch (error) {
    logSystemFailure('android_usage_access_status', error);
    throw error;
  }
}

export async function openAndroidUsageAccessSettings() {
  if (!isAndroid()) return false;
  try {
    await ActivityRecognition.openUsageAccessSettings();
    recordSystemEvent('android_usage_access_settings_opened', {}, { category: 'permission', source: 'android' });
    return true;
  } catch (error) {
    logSystemFailure('android_usage_access_settings_open', error);
    throw error;
  }
}

export async function getAndroidPhoneUsageSummary(startMs, endMs) {
  if (!isAndroid()) {
    return {
      usage_access_granted: false,
      events: [],
      event_count: 0,
      total_seconds: 0,
    };
  }
  try {
    const result = await ActivityRecognition.getPhoneUsageSummary({ startMs, endMs });
    recordSystemEvent('android_phone_usage_summary_loaded', {
      event_count: Number(result?.event_count) || (Array.isArray(result?.events) ? result.events.length : 0),
      total_seconds: Math.round(Number(result?.total_seconds) || 0),
      usage_access_granted: result?.usage_access_granted === true,
      window_seconds: Math.max(0, Math.round((Number(endMs) - Number(startMs)) / 1000)),
    }, { category: 'background', source: 'android', title: 'Phone usage summary loaded' });
    return result;
  } catch (error) {
    logSystemFailure('android_phone_usage_summary', error, {
      window_seconds: Math.max(0, Math.round((Number(endMs) - Number(startMs)) / 1000)),
    });
    throw error;
  }
}

export async function getNativeCompletedTrips() {
  if (!isAndroid()) return [];
  try {
    const result = await ActivityRecognition.getNativeCompletedTrips();
    const trips = Array.isArray(result?.trips) ? result.trips : [];
    recordSystemEvent('android_native_completed_trips_loaded', {
      trip_count: trips.length,
    }, { category: 'background', source: 'android', title: 'Native completed trips loaded' });
    return trips;
  } catch (error) {
    logSystemFailure('android_native_completed_trips_load', error);
    throw error;
  }
}

export async function clearNativeCompletedTrips() {
  if (!isAndroid()) return;
  try {
    await ActivityRecognition.clearNativeCompletedTrips();
    recordSystemEvent('android_native_completed_trips_cleared', {}, {
      category: 'background',
      source: 'android',
      title: 'Native completed trips cleared',
    });
  } catch (error) {
    logSystemFailure('android_native_completed_trips_clear', error);
    throw error;
  }
}

export function shouldAutoStartTracking({ activity, currentSpeedKmh = 0, recentMovingSeconds = 0 }) {
  const activityType = activity?.type;
  const vehicleConfidence = activityType === ACTIVITY_TYPES.IN_VEHICLE ? activity.confidence || 0 : 0;
  const speed = Number(currentSpeedKmh) || 0;
  const movingSeconds = Number(recentMovingSeconds) || 0;
  if (
    vehicleConfidence >= AUTO_START_IN_VEHICLE_CONFIDENCE &&
    speed >= AUTO_START_SPEED_KMH &&
    movingSeconds >= AUTO_START_IN_VEHICLE_SECONDS
  ) return true;
  const activityMissingOrUncertain = !activity ||
    activityType === ACTIVITY_TYPES.UNKNOWN ||
    (activityType === ACTIVITY_TYPES.IN_VEHICLE && vehicleConfidence < AUTO_START_IN_VEHICLE_CONFIDENCE);
  return activityMissingOrUncertain && speed >= AUTO_START_SPEED_KMH && movingSeconds >= AUTO_START_GPS_FALLBACK_SECONDS;
}

export function computeGpsPositionDrift(stoppedLat, stoppedLng, recentPoints = []) {
  const anchorLat = Number(stoppedLat);
  const anchorLng = Number(stoppedLng);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLng) || !Array.isArray(recentPoints)) {
    return 0;
  }

  return recentPoints.reduce((maxDrift, point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return maxDrift;
    return Math.max(maxDrift, haversineDistance(anchorLat, anchorLng, lat, lng) * 1000);
  }, 0);
}

export function shouldAutoStopTracking({
  activity,
  currentSpeedKmh = 0,
  stillSeconds = 0,
  gpsPositionDriftM = Number.POSITIVE_INFINITY,
  lastMovingSpeedKmh = 0,
  nowMs = Date.now(),
  returnReason = false,
}) {
  const speed = Number(currentSpeedKmh) || 0;
  const lastMovingSpeed = Number(lastMovingSpeedKmh) || 0;
  const secondsStopped = Number(stillSeconds) || 0;
  const driftM = Number.isFinite(Number(gpsPositionDriftM)) ? Number(gpsPositionDriftM) : Number.POSITIVE_INFINITY;
  const activityTimestamp = activity?.timestamp || activity?.updatedAt || activity?.time;
  const activityTimestampMs = activityTimestamp ? new Date(activityTimestamp).getTime() : NaN;
  const activityStale = Boolean(activity) && Number.isFinite(activityTimestampMs) && (Number(nowMs) - activityTimestampMs) > ACTIVITY_STATE_MAX_AGE_MS;
  const effectiveActivity = activityStale ? null : activity;
  const confidence = effectiveActivity?.confidence || 0;
  const type = effectiveActivity?.type;
  const finish = (shouldStop, reason = null) => (
    returnReason ? { shouldStop, reason, activityStale } : shouldStop
  );

  const onFoot = [
    ACTIVITY_TYPES.WALKING,
    ACTIVITY_TYPES.RUNNING,
    ACTIVITY_TYPES.ON_BICYCLE,
    ACTIVITY_TYPES.CYCLING,
  ].includes(type) && confidence >= 75;
  if (onFoot && speed <= WALKING_SPEED_CUTOFF_KMH && secondsStopped >= 10) return finish(true, 'on_foot');

  const isStill = type === ACTIVITY_TYPES.STILL && confidence >= 70;
  if (isStill && speed < 5 && driftM < 8 && secondsStopped >= 90) return finish(true, 'still_stable_gps');
  // FIX: Match the JS STILL+stable auto-stop timer to the native 90-second threshold.
  if (isStill && speed < 5 && driftM >= 8 && secondsStopped >= 150) return finish(true, 'still_timeout');

  const inVehicle = type === ACTIVITY_TYPES.IN_VEHICLE;
  if (inVehicle && speed < 2 && secondsStopped >= 90 && driftM < VERY_STABLE_PARKED_DRIFT_M) return finish(true, 'in_vehicle_very_stable_gps');
  if (inVehicle && speed < 2 && secondsStopped >= 300 && driftM < PARKED_GPS_DRIFT_M) return finish(true, 'in_vehicle_gps_fallback');
  if (inVehicle && speed < 5 && secondsStopped >= 120) {
    if (driftM < 5) return finish(true, 'in_vehicle_very_stable_gps');
    // FIX: Preserve the fast in-vehicle parked path for very stable GPS drift.
    if (secondsStopped >= 300 && driftM < 20) return finish(true, 'in_vehicle_gps_fallback');
    // FIX: Add the in_vehicle_extended_stop fallback for realistic urban parked GPS drift.
    if (secondsStopped >= 300 && speed < 2 && driftM < PARKED_GPS_DRIFT_M) return finish(true, 'in_vehicle_extended_stop');
    if (secondsStopped >= 420 && speed < 2 && lastMovingSpeed < 5) return finish(true, 'prolonged_zero_speed');
    // FIX: Add the prolonged_zero_speed safety net so trips cannot run forever on GPS drift alone.
  }

  const activityUnknown = !effectiveActivity || type === ACTIVITY_TYPES.UNKNOWN;
  if (activityUnknown && speed < 5 && secondsStopped >= 180) {
    if (driftM < UNKNOWN_GPS_STABLE_M) return finish(true, activityStale ? 'activity_recognition_stale' : 'unknown_activity_stable_gps');
    if (activityStale && speed < 2 && secondsStopped >= 300 && driftM < PARKED_GPS_DRIFT_M) return finish(true, 'activity_recognition_stale');
    return finish(false);
  }

  return finish(false);
}
