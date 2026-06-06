import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isAndroid, isNativePlatform, openNativeSettings } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import { getObdBluetoothSupport } from '@/lib/obdBluetooth';
import { getMotionSensorSupport } from '@/lib/sensorFusionModel';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

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
  } catch (error) {
    logSystemFailure('permission_status_location', error, { permission: 'foregroundLocation' });
  }

  try {
    if (isNativePlatform()) {
      const notifications = await LocalNotifications.checkPermissions();
      status.notifications = asState(notifications.display);
    } else if ('Notification' in window) {
      status.notifications = Notification.permission;
    }
  } catch (error) {
    logSystemFailure('permission_status_notifications', error, { permission: 'notifications' });
  }

  try {
    if (isAndroid()) {
      const activity = await ActivityRecognition.checkPermissions();
      status.activityRecognition = asState(activity.activityRecognition);
      status.backgroundLocation = asState(activity.backgroundLocation);
      try {
        const usage = await ActivityRecognition.usageAccessStatus();
        status.phoneUsageAccess = usage.usageAccessGranted ? 'granted' : 'not_requested';
      } catch (error) {
        logSystemFailure('permission_status_phone_usage_access', error, { permission: 'phoneUsageAccess' });
      }
    }
  } catch (error) {
    logSystemFailure('permission_status_activity_background', error, { permission: 'activityRecognition' });
  }

  if (status.backgroundLocation === 'unknown') {
    status.backgroundLocation = localSettings.get().background_location_granted ? 'granted' : 'not_requested';
  }

  const motionSupport = getMotionSensorSupport();
  status.motionSensors = motionSupport.status;
  const bluetoothSupport = getObdBluetoothSupport();
  status.bluetooth = bluetoothSupport.supported ? 'not_requested' : 'unavailable';

  localSettings.update({
    location_permission_granted: status.foregroundLocation === 'granted',
    notification_permission_granted: status.notifications === 'granted',
    activity_permission_granted: status.activityRecognition === 'granted',
    background_location_granted: status.backgroundLocation === 'granted',
    phone_usage_access_granted: status.phoneUsageAccess === 'granted',
  });

  recordSystemEvent('permission_status_checked', {
    foregroundLocation: status.foregroundLocation,
    backgroundLocation: status.backgroundLocation,
    activityRecognition: status.activityRecognition,
    notifications: status.notifications,
    phoneUsageAccess: status.phoneUsageAccess,
    motionSensors: status.motionSensors,
    bluetooth: status.bluetooth,
  }, {
    category: 'permission',
    title: 'Permission status checked',
  });

  return status;
}

export async function requestForegroundLocationPermission() {
  if (isNativePlatform()) {
    try {
      const result = await Geolocation.requestPermissions({ permissions: ['location'] });
      const granted = result.location === 'granted';
      localSettings.update({ location_permission_granted: granted });
      recordSystemEvent('permission_request_foreground_location', { result: result.location, granted }, { category: 'permission' });
      return granted;
    } catch (error) {
      logSystemFailure('permission_request_foreground_location', error, { permission: 'foregroundLocation' });
      return false;
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      recordSystemEvent('permission_request_foreground_location', { granted: false, reason: 'geolocation_unavailable' }, { category: 'permission', severity: 'warn' });
      resolve(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => {
        recordSystemEvent('permission_request_foreground_location', { granted: true }, { category: 'permission' });
        resolve(true);
      },
      (error) => {
        logSystemFailure('permission_request_foreground_location', error, { permission: 'foregroundLocation' });
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

export async function requestNotificationPermission() {
  if (isNativePlatform()) {
    try {
      const result = await LocalNotifications.requestPermissions();
      const granted = result.display === 'granted';
      localSettings.update({ notification_permission_granted: granted });
      recordSystemEvent('permission_request_notifications', { result: result.display, granted }, { category: 'permission' });
      return granted;
    } catch (error) {
      logSystemFailure('permission_request_notifications', error, { permission: 'notifications' });
      return false;
    }
  }

  if (!('Notification' in window)) {
    recordSystemEvent('permission_request_notifications', { granted: false, reason: 'notification_api_unavailable' }, { category: 'permission', severity: 'warn' });
    return false;
  }
  const result = await Notification.requestPermission();
  const granted = result === 'granted';
  recordSystemEvent('permission_request_notifications', { result, granted }, { category: 'permission' });
  return granted;
}

export async function requestActivityRecognitionPermission() {
  if (!isAndroid()) return false;
  try {
    const result = await ActivityRecognition.requestPermissions();
    const granted = result.activityRecognition === 'granted';
    localSettings.update({ activity_permission_granted: granted });
    recordSystemEvent('permission_request_activity_recognition', { result: result.activityRecognition, granted }, { category: 'permission' });
    return granted;
  } catch (error) {
    logSystemFailure('permission_request_activity_recognition', error, { permission: 'activityRecognition' });
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
        recordSystemEvent('permission_request_background_location', { result: status.backgroundLocation, granted: true }, { category: 'permission' });
        return true;
      }

      const result = await ActivityRecognition.requestBackgroundLocation();
      const granted = result.backgroundLocation === 'granted';
      localSettings.update({ background_location_granted: granted });
      recordSystemEvent('permission_request_background_location', { result: result.backgroundLocation, granted }, { category: 'permission' });
      if (!granted) {
        await ActivityRecognition.openAppLocationSettings();
      }
      return granted;
    } catch (error) {
      try {
        await ActivityRecognition.openAppLocationSettings();
      } catch (settingsError) {
        logSystemFailure('permission_open_background_location_settings', settingsError, { permission: 'backgroundLocation' });
      }
      logSystemFailure('permission_request_background_location', error, { permission: 'backgroundLocation' });
      return false;
    }
  }

  localSettings.update({ background_location_granted: true });
  recordSystemEvent('permission_request_background_location', { granted: true, platform: 'web' }, { category: 'permission' });
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
