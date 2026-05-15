import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { requestActivityRecognitionPermission } from '@/lib/permissions';
import { haversineDistance } from '@/lib/tripEngine';

const ActivityRecognition = registerPlugin('DriveSenseActivityRecognition');

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
    await ActivityRecognition.start({ intervalMs: 15000 });
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
  const vehicleConfidence = activity?.type === ACTIVITY_TYPES.IN_VEHICLE ? activity.confidence || 0 : 0;
  return vehicleConfidence >= 70 && currentSpeedKmh >= 5 && recentMovingSeconds >= 10;
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
  lastMovingSpeedKmh: _lastMovingSpeedKmh = 0,
}) {
  const speed = Number(currentSpeedKmh) || 0;
  const secondsStopped = Number(stillSeconds) || 0;
  const driftM = Number.isFinite(Number(gpsPositionDriftM)) ? Number(gpsPositionDriftM) : Number.POSITIVE_INFINITY;
  const confidence = activity?.confidence || 0;
  const type = activity?.type;

  const onFoot = [
    ACTIVITY_TYPES.WALKING,
    ACTIVITY_TYPES.RUNNING,
    ACTIVITY_TYPES.ON_BICYCLE,
  ].includes(type) && confidence >= 75;
  if (onFoot && speed < 5 && secondsStopped >= 15) return true;

  const isStill = type === ACTIVITY_TYPES.STILL && confidence >= 70;
  if (isStill && speed < 5 && driftM < 8 && secondsStopped >= 45) return true;
  if (isStill && speed < 5 && driftM >= 8 && secondsStopped >= 150) return true;

  const inVehicle = type === ACTIVITY_TYPES.IN_VEHICLE;
  if (inVehicle && speed < 5 && secondsStopped >= 240) {
    return driftM < 5;
  }

  if (!activity && speed < 5 && secondsStopped >= 180) {
    return driftM < 6;
  }

  return false;
}
