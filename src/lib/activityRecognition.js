import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { requestActivityRecognitionPermission } from '@/lib/permissions';
import { haversineDistance } from '@/lib/tripEngine';

const ActivityRecognition = registerPlugin('DriveSenseActivityRecognition');
const UNKNOWN_GPS_STABLE_M = 8;
const PARKED_GPS_DRIFT_M = 20;
const VERY_STABLE_PARKED_DRIFT_M = 5;
export const ACTIVITY_POLL_INTERVAL_MS = 5000;
export const AUTO_START_IN_VEHICLE_CONFIDENCE = 65;
export const AUTO_START_SPEED_KMH = 5;
export const AUTO_START_IN_VEHICLE_SECONDS = 1;
export const AUTO_START_GPS_FALLBACK_SECONDS = 2;

export const ACTIVITY_TYPES = {
  IN_VEHICLE: 'in_vehicle',
  ON_FOOT: 'on_foot',
  WALKING: 'walking',
  RUNNING: 'running',
  STILL: 'still',
  ON_BICYCLE: 'cycling',
  CYCLING: 'cycling',
  UNKNOWN: 'unknown',
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
    return async () => {
      await ActivityRecognition.stop();
      await listener.remove();
    };
  } catch (error) {
    onError?.({ message: error.message || 'Activity recognition is unavailable on this device.' });
    return null;
  }
}

export async function startNativeAutoTracking() {
  if (!isAndroid()) return false;
  const result = await ActivityRecognition.startNativeAutoTracking();
  return result?.enabled === true;
}

export async function stopNativeAutoTracking() {
  if (!isAndroid()) return false;
  const result = await ActivityRecognition.stopNativeAutoTracking();
  return result?.enabled === false;
}

export async function getNativeAutoTrackingStatus() {
  if (!isAndroid()) return { enabled: false, completedTripsCount: 0 };
  return ActivityRecognition.nativeAutoTrackingStatus();
}

export async function getNativeDiagnostics() {
  if (!isAndroid()) return { enabled: false, events: [] };
  const result = await ActivityRecognition.getNativeDiagnostics();
  return {
    enabled: result?.enabled === true,
    events: Array.isArray(result?.events) ? result.events : [],
  };
}

export async function clearNativeDiagnostics() {
  if (!isAndroid()) return;
  await ActivityRecognition.clearNativeDiagnostics();
}

export async function openAndroidLocationSettings() {
  if (!isAndroid()) return false;
  await ActivityRecognition.openAppLocationSettings();
  return true;
}

export async function openAndroidBatteryOptimizationSettings() {
  if (!isAndroid()) return false;
  await ActivityRecognition.openBatteryOptimizationSettings();
  return true;
}

export async function getAndroidBatteryOptimizationStatus() {
  if (!isAndroid()) return { batteryOptimizationIgnored: true };
  return ActivityRecognition.batteryOptimizationStatus();
}

export async function getAndroidUsageAccessStatus() {
  if (!isAndroid()) return { usageAccessGranted: false };
  return ActivityRecognition.usageAccessStatus();
}

export async function openAndroidUsageAccessSettings() {
  if (!isAndroid()) return false;
  await ActivityRecognition.openUsageAccessSettings();
  return true;
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
  return ActivityRecognition.getPhoneUsageSummary({ startMs, endMs });
}

export async function getNativeCompletedTrips() {
  if (!isAndroid()) return [];
  const result = await ActivityRecognition.getNativeCompletedTrips();
  return Array.isArray(result?.trips) ? result.trips : [];
}

export async function clearNativeCompletedTrips() {
  if (!isAndroid()) return;
  await ActivityRecognition.clearNativeCompletedTrips();
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
}) {
  const speed = Number(currentSpeedKmh) || 0;
  const lastMovingSpeed = Number(lastMovingSpeedKmh) || 0;
  const secondsStopped = Number(stillSeconds) || 0;
  const driftM = Number.isFinite(Number(gpsPositionDriftM)) ? Number(gpsPositionDriftM) : Number.POSITIVE_INFINITY;
  const confidence = activity?.confidence || 0;
  const type = activity?.type;

  const onFoot = [
    ACTIVITY_TYPES.WALKING,
    ACTIVITY_TYPES.RUNNING,
    ACTIVITY_TYPES.ON_BICYCLE,
  ].includes(type) && confidence >= 75;
  if (onFoot && speed < 15 && secondsStopped >= 10) return true;

  const isStill = type === ACTIVITY_TYPES.STILL && confidence >= 70;
  if (isStill && speed < 5 && driftM < 8 && secondsStopped >= 90) return true;
  // FIX: Match the JS STILL+stable auto-stop timer to the native 90-second threshold.
  if (isStill && speed < 5 && driftM >= 8 && secondsStopped >= 150) return true;

  const inVehicle = type === ACTIVITY_TYPES.IN_VEHICLE;
  if (inVehicle && speed < 2 && secondsStopped >= 90 && driftM < VERY_STABLE_PARKED_DRIFT_M) return true;
  if (inVehicle && speed < 2 && secondsStopped >= 300 && driftM < PARKED_GPS_DRIFT_M) return true;
  if (inVehicle && speed < 5 && secondsStopped >= 120) {
    if (driftM < 5) return true;
    // FIX: Preserve the fast in-vehicle parked path for very stable GPS drift.
    if (secondsStopped >= 300 && driftM < 20) return true;
    // FIX: Add the in_vehicle_extended_stop fallback for realistic urban parked GPS drift.
    if (secondsStopped >= 300 && speed < 2 && driftM < PARKED_GPS_DRIFT_M) return true;
    if (secondsStopped >= 420 && speed < 2 && lastMovingSpeed < 5) return true;
    // FIX: Add the prolonged_zero_speed safety net so trips cannot run forever on GPS drift alone.
  }

  const activityUnknown = !activity || type === ACTIVITY_TYPES.UNKNOWN;
  if (activityUnknown && speed < 5 && secondsStopped >= 180) {
    return driftM < UNKNOWN_GPS_STABLE_M;
  }

  return false;
}
