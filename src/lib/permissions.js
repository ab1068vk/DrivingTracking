import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isAndroid, isNativePlatform, openNativeSettings } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import { getObdBluetoothSupport } from '@/lib/obdBluetooth';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { logError } from '@/lib/errorReporting';

const asState = (value) => value || 'unknown';

export async function getPermissionStatus() {
  const status = {
    foregroundLocation: 'unknown',
    backgroundLocation: 'unknown',
    activityRecognition: 'unknown',
    notifications: 'unknown',
    phoneUsageAccess: 'unknown',
    motionSensors: 'unknown',
    bluetooth: 'unknown',
  };

  try {
    if (isNativePlatform()) {
      const location = await Geolocation.checkPermissions();
      status.foregroundLocation = asState(location.location);
    } else if (navigator.permissions) {
      const location = await navigator.permissions.query({ name: 'geolocation' });
      status.foregroundLocation = asState(location.state);
    }
  } catch (err) {
    logError('permission_status_location', err);
  }

  try {
    if (isNativePlatform()) {
      const notifications = await LocalNotifications.checkPermissions();
      status.notifications = asState(notifications.display);
    } else if ('Notification' in window) {
      status.notifications = Notification.permission;
    }
  } catch (err) {
    logError('permission_status_notifications', err);
  }

  try {
    if (isAndroid()) {
      const activity = await ActivityRecognition.checkPermissions();
      status.activityRecognition = asState(activity.activityRecognition);
      status.backgroundLocation = asState(activity.backgroundLocation);
      try {
        const usage = await ActivityRecognition.usageAccessStatus();
        status.phoneUsageAccess = usage.usageAccessGranted ? 'granted' : 'not_requested';
      } catch (err) {
        logError('permission_status_usage_access', err);
      }
    }
  } catch (err) {
    logError('permission_status_activity_recognition', err);
  }

  if (status.backgroundLocation === 'unknown') {
    status.backgroundLocation = localSettings.get().background_location_granted ? 'granted' : 'not_requested';
  }

  try {
    const { getMotionSensorSupport } = await import('@/lib/sensorFusionModel');
    const motionSupport = getMotionSensorSupport();
    status.motionSensors = motionSupport.status;
  } catch (err) {
    logError('permission_status_motion_sensors', err);
  }
  const bluetoothSupport = getObdBluetoothSupport();
  status.bluetooth = bluetoothSupport.supported ? 'not_requested' : 'unavailable';

  localSettings.update({
    location_permission_granted: status.foregroundLocation === 'granted',
    notification_permission_granted: status.notifications === 'granted',
    activity_permission_granted: status.activityRecognition === 'granted',
    background_location_granted: status.backgroundLocation === 'granted',
    phone_usage_access_granted: status.phoneUsageAccess === 'granted',
  });

  return status;
}

export async function requestForegroundLocationPermission() {
  if (isNativePlatform()) {
    const result = await Geolocation.requestPermissions({ permissions: ['location'] });
    localSettings.update({ location_permission_granted: result.location === 'granted' });
    return result.location === 'granted';
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

export async function requestNotificationPermission() {
  if (isNativePlatform()) {
    const result = await LocalNotifications.requestPermissions();
    localSettings.update({ notification_permission_granted: result.display === 'granted' });
    return result.display === 'granted';
  }

  if (!('Notification' in window)) return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export async function requestActivityRecognitionPermission() {
  if (!isAndroid()) return false;
  try {
    const result = await ActivityRecognition.requestPermissions();
    const granted = result.activityRecognition === 'granted';
    localSettings.update({ activity_permission_granted: granted });
    return granted;
  } catch (err) {
    logError('activity_recognition_permission_request', err);
    return false;
  }
}

export async function requestBackgroundLocationPermission() {
  const foregroundGranted = await requestForegroundLocationPermission();
  if (!foregroundGranted) return false;

  const notificationsGranted = await requestNotificationPermission();
  if (!notificationsGranted) return false;

  if (isAndroid()) {
    try {
      let status = await ActivityRecognition.checkPermissions();
      if (status.backgroundLocation === 'granted') {
        localSettings.update({ background_location_granted: true });
        return true;
      }

      const result = await ActivityRecognition.requestBackgroundLocation();
      const granted = result.backgroundLocation === 'granted';
      localSettings.update({ background_location_granted: granted });
      if (!granted) {
        await ActivityRecognition.openAppLocationSettings();
      }
      return granted;
    } catch (err) {
      logError('background_location_permission_request', err);
      try {
        await ActivityRecognition.openAppLocationSettings();
      } catch (settingsErr) {
        logError('background_location_settings_open', settingsErr);
      }
      return false;
    }
  }

  localSettings.update({ background_location_granted: true });
  return true;
}

export function getPermissionExplanation(kind) {
  const copy = {
    foregroundLocation: 'Road Sage needs precise location while you start a trip so it can record your route, speed, distance, driving events, parking location, route comparison, road type breakdowns, and repeated driving-event locations.',
    backgroundLocation: 'Background location is only used after you start tracking or enable background auto-tracking. Android requires a persistent notification while this is active.',
    activityRecognition: 'Physical activity helps Road Sage tell driving apart from walking, cycling, and still time before auto-tracking starts.',
    notifications: 'Notifications are used for the persistent tracking notice, long-trip reminders, completed-trip summaries, weekly summaries, achievements, and maintenance reminders.',
    phoneUsageAccess: 'Optional Android Usage Access lets Road Sage detect foreground app use during a trip. Without it, phone-use scoring is unavailable and GPS proxy counts stay diagnostic only.',
    motionSensors: 'Motion and gyroscope access lets Road Sage confirm harsh braking, sharp turns, phone movement, and possible incidents with on-device sensor samples. Android usually has no separate prompt; some platforms ask when tracking starts.',
    bluetooth: 'OBD-II Bluetooth is optional and only used when you connect a compatible adapter. Android may ask for Nearby Devices/Bluetooth access before pairing.',
  };
  return copy[kind] || '';
}

export { openNativeSettings };
