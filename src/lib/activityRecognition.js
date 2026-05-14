import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { requestActivityRecognitionPermission } from '@/lib/permissions';

const ActivityRecognition = registerPlugin('DriveSenseActivityRecognition');

export const ACTIVITY_TYPES = {
  IN_VEHICLE: 'in_vehicle',
  ON_FOOT: 'on_foot',
  WALKING: 'walking',
  RUNNING: 'running',
  STILL: 'still',
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
  return vehicleConfidence >= 70 && currentSpeedKmh >= 12 && recentMovingSeconds >= 20;
}

export function shouldAutoStopTracking({ activity, currentSpeedKmh = 0, stillSeconds = 0 }) {
  const isStill = activity?.type === ACTIVITY_TYPES.STILL && (activity.confidence || 0) >= 70;
  const notVehicle = activity && activity.type !== ACTIVITY_TYPES.IN_VEHICLE && (activity.confidence || 0) >= 80;
  return currentSpeedKmh < 5 && stillSeconds >= 180 && (isStill || notVehicle);
}
