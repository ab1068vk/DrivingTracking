import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isAndroid, isNativePlatform, openNativeSettings } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';
import { getObdBluetoothSupport } from '@/lib/obdBluetooth';
import ActivityRecognition from '@/lib/driveSenseNativePlugin';
import { logError } from '@/lib/errorReporting';
import { resolveStorageKey } from '@/lib/storageKeyMigration';
import { PERMISSION_STATES, normalizePermissionState } from '@/lib/permissionStateMachine';

const asState = (value) => {
  if (value === 'prompt' || value === 'prompt-with-rationale') return PERMISSION_STATES.NOT_REQUESTED;
  const normalized = normalizePermissionState(value);
  return normalized === PERMISSION_STATES.UNKNOWN ? PERMISSION_STATES.UNKNOWN : normalized;
};
const SETTINGS_STORAGE_KEY = resolveStorageKey('drivesense_settings');
const STATUS_CACHE_TTL_MS = 10_000;

let statusCache = null;
let statusCacheAt = 0;
let statusRefreshInFlight = null;
let statusCacheGeneration = 0;

export function invalidatePermissionCache() {
  statusCache = null;
  statusCacheAt = 0;
  statusRefreshInFlight = null;
  statusCacheGeneration += 1;
}

function savePermissionSettingsAsync(patch, context) {
  localSettings.setAsync({
    ...localSettings.get(),
    ...patch,
  }).catch((err) => logError(context, err));
}

async function safeNativeRead(key, fallback = null) {
  try {
    const { encryptedCapacitorStorage } = await import('@/lib/encryptedCapacitorStorage');
    const result = await encryptedCapacitorStorage.get({ key });
    return result?.value ?? fallback;
  } catch {
    return fallback;
  }
}

const unknownPermissionStatus = () => ({
  foregroundLocation: PERMISSION_STATES.UNKNOWN,
  backgroundLocation: PERMISSION_STATES.UNKNOWN,
  activityRecognition: PERMISSION_STATES.UNKNOWN,
  notifications: PERMISSION_STATES.UNKNOWN,
  phoneUsageAccess: PERMISSION_STATES.UNKNOWN,
  motionSensors: PERMISSION_STATES.UNKNOWN,
  bluetooth: PERMISSION_STATES.UNKNOWN,
});

async function getStoredSettingsFallback() {
  try {
    return await localSettings.hydrateFromNative();
  } catch {
    // Fall through to direct native/local reads.
  }

  if (isNativePlatform()) {
    const raw = await safeNativeRead(SETTINGS_STORAGE_KEY, null);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
  }

  try {
    return localSettings.get();
  } catch {
    return {};
  }
}

function storedPermissionState(settings, key) {
  const stored = settings?.[key];
  return normalizePermissionState(stored);
}

function storedSettingForStatus(status, storedValue) {
  const normalized = normalizePermissionState(status);
  if (normalized === PERMISSION_STATES.UNKNOWN) return storedValue === true;
  if (normalized === PERMISSION_STATES.GRANTED) return true;
  if (normalized === PERMISSION_STATES.DENIED || normalized === PERMISSION_STATES.NEEDS_SETTINGS) {
    return normalized;
  }
  return false;
}

function settingsPatchForStatus(status, storedSettings = {}) {
  return {
    location_permission_granted: storedSettingForStatus(status.foregroundLocation, storedSettings.location_permission_granted),
    notification_permission_granted: storedSettingForStatus(status.notifications, storedSettings.notification_permission_granted),
    activity_permission_granted: storedSettingForStatus(status.activityRecognition, storedSettings.activity_permission_granted),
    background_location_granted: storedSettingForStatus(status.backgroundLocation, storedSettings.background_location_granted),
    phone_usage_access_granted: storedSettingForStatus(status.phoneUsageAccess, storedSettings.phone_usage_access_granted),
  };
}

function patchChanged(patch, settings = {}) {
  return Object.entries(patch).some(([key, value]) => settings?.[key] !== value);
}

function parseStatusArgs(permissionTypeOrOptions, options = {}) {
  if (permissionTypeOrOptions && typeof permissionTypeOrOptions === 'object') {
    return {
      permissionType: null,
      force: permissionTypeOrOptions.force === true,
      persist: permissionTypeOrOptions.persist !== false,
    };
  }
  return {
    permissionType: permissionTypeOrOptions || null,
    force: options.force === true,
    persist: options.persist !== false,
  };
}

function maybePromoteDeniedToNeedsSettings(status, storedSettings, key) {
  if (status !== PERMISSION_STATES.DENIED) return status;
  return storedPermissionState(storedSettings, key) === PERMISSION_STATES.NEEDS_SETTINGS
    ? PERMISSION_STATES.NEEDS_SETTINGS
    : status;
}

export async function getPermissionStatus(permissionType = null, options = {}) {
  const { permissionType: requestedPermissionType, force, persist } = parseStatusArgs(permissionType, options);
  const now = Date.now();
  if (!force && statusCache && now - statusCacheAt < STATUS_CACHE_TTL_MS) {
    const cached = { ...statusCache };
    return requestedPermissionType ? { status: cached[requestedPermissionType] || PERMISSION_STATES.UNKNOWN } : cached;
  }

  if (!force && statusRefreshInFlight) {
    const pending = await statusRefreshInFlight;
    const snapshot = { ...pending };
    return requestedPermissionType ? { status: snapshot[requestedPermissionType] || PERMISSION_STATES.UNKNOWN } : snapshot;
  }

  const generation = statusCacheGeneration;
  statusRefreshInFlight = readPermissionStatus({ persist, generation })
    .finally(() => {
      statusRefreshInFlight = null;
    });

  const snapshot = await statusRefreshInFlight;
  return requestedPermissionType ? { status: snapshot[requestedPermissionType] || PERMISSION_STATES.UNKNOWN } : snapshot;
}

export async function refreshPermissionStatus(options = {}) {
  return getPermissionStatus(null, { ...options, force: true });
}

async function readPermissionStatus({ persist = true, generation = statusCacheGeneration } = {}) {
  const status = unknownPermissionStatus();

  try {
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
        status.notifications = asState(Notification.permission);
      }
    } catch (err) {
      logError('permission_status_notifications', err);
    }

    try {
      if (isAndroid()) {
        const activity = await ActivityRecognition.checkPermissions();
        status.activityRecognition = asState(activity.activityRecognition);
        status.backgroundLocation = asState(activity.backgroundLocation);
        if (activity.bluetoothConnect) {
          status.bluetooth = asState(activity.bluetoothConnect);
        }
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

    const storedSettings = await getStoredSettingsFallback();
    status.backgroundLocation = maybePromoteDeniedToNeedsSettings(
      status.backgroundLocation,
      storedSettings,
      'background_location_granted'
    );
    status.foregroundLocation = maybePromoteDeniedToNeedsSettings(
      status.foregroundLocation,
      storedSettings,
      'location_permission_granted'
    );
    status.notifications = maybePromoteDeniedToNeedsSettings(
      status.notifications,
      storedSettings,
      'notification_permission_granted'
    );
    status.activityRecognition = maybePromoteDeniedToNeedsSettings(
      status.activityRecognition,
      storedSettings,
      'activity_permission_granted'
    );

    if (status.backgroundLocation === PERMISSION_STATES.UNKNOWN) {
      status.backgroundLocation = storedPermissionState(storedSettings, 'background_location_granted');
    }
    if (status.foregroundLocation === PERMISSION_STATES.UNKNOWN) {
      status.foregroundLocation = storedPermissionState(storedSettings, 'location_permission_granted');
    }
    if (status.notifications === PERMISSION_STATES.UNKNOWN) {
      status.notifications = storedPermissionState(storedSettings, 'notification_permission_granted');
    }
    if (status.activityRecognition === PERMISSION_STATES.UNKNOWN) {
      status.activityRecognition = storedPermissionState(storedSettings, 'activity_permission_granted');
    }
    if (status.phoneUsageAccess === PERMISSION_STATES.UNKNOWN) {
      status.phoneUsageAccess = storedPermissionState(storedSettings, 'phone_usage_access_granted');
    }

    try {
      const { getMotionSensorSupport } = await import('@/lib/sensorFusionModel');
      const motionSupport = getMotionSensorSupport();
      status.motionSensors = motionSupport.status;
    } catch (err) {
      logError('permission_status_motion_sensors', err);
    }
    const bluetoothSupport = getObdBluetoothSupport();
    if (status.bluetooth === PERMISSION_STATES.UNKNOWN) {
      status.bluetooth = bluetoothSupport.supported ? PERMISSION_STATES.NOT_REQUESTED : PERMISSION_STATES.UNAVAILABLE;
    }

    if (persist) {
      try {
        const patch = settingsPatchForStatus(status, storedSettings);
        if (patchChanged(patch, storedSettings)) {
          localSettings.update(patch);
        }
      } catch (err) {
        logError('permission_status_settings_update', err);
      }
    }

    if (generation === statusCacheGeneration) {
      statusCache = { ...status };
      statusCacheAt = Date.now();
    }
    return status;
  } catch (err) {
    console.warn('[permissions] getPermissionStatus failed:', err);
    return status;
  }
}

async function currentPermissionState(permissionType) {
  try {
    if (permissionType === 'foregroundLocation') {
      if (isNativePlatform()) {
        const location = await Geolocation.checkPermissions();
        return asState(location.location);
      }
      if (navigator.permissions) {
        const location = await navigator.permissions.query({ name: 'geolocation' });
        return asState(location.state);
      }
      return PERMISSION_STATES.UNKNOWN;
    }

    if (permissionType === 'notifications') {
      if (isNativePlatform()) {
        const notifications = await LocalNotifications.checkPermissions();
        return asState(notifications.display);
      }
      if ('Notification' in window) return asState(Notification.permission);
      return PERMISSION_STATES.UNAVAILABLE;
    }

    if (permissionType === 'activityRecognition' && isAndroid()) {
      const activity = await ActivityRecognition.checkPermissions();
      return asState(activity.activityRecognition);
    }

    if (permissionType === 'backgroundLocation' && isAndroid()) {
      const activity = await ActivityRecognition.checkPermissions();
      return asState(activity.backgroundLocation);
    }

    if (permissionType === 'bluetooth' && isAndroid()) {
      const activity = await ActivityRecognition.checkPermissions();
      return asState(activity.bluetoothConnect);
    }
  } catch (err) {
    logError(`permission_current_state_${permissionType}`, err);
  }

  return PERMISSION_STATES.UNKNOWN;
}

export async function requestForegroundLocationPermission() {
  invalidatePermissionCache();
  if (await currentPermissionState('foregroundLocation') === PERMISSION_STATES.GRANTED) {
    savePermissionSettingsAsync({
      location_permission_granted: true,
      _location_denial_count: 0,
    }, 'foreground_location_denial_count_save');
    return true;
  }
  if (isNativePlatform()) {
    const settings = localSettings.get();
    const priorDenials = Number(settings._location_denial_count || 0);
    try {
      const result = await Geolocation.requestPermissions({ permissions: ['location'] });
      const granted = result.location === PERMISSION_STATES.GRANTED;
      if (granted) {
        savePermissionSettingsAsync({
          location_permission_granted: true,
          _location_denial_count: 0,
        }, 'foreground_location_denial_count_save');
        invalidatePermissionCache();
        return true;
      }

      const denialCount = priorDenials + 1;
      const state = isAndroid() && denialCount >= 2
        ? PERMISSION_STATES.NEEDS_SETTINGS
        : PERMISSION_STATES.DENIED;
      savePermissionSettingsAsync({
        location_permission_granted: state,
        _location_denial_count: denialCount,
      }, 'foreground_location_denial_count_save');
      invalidatePermissionCache();
      return false;
    } catch (err) {
      logError('foreground_location_permission_request', err);
      localSettings.update({ location_permission_granted: PERMISSION_STATES.UNKNOWN });
      invalidatePermissionCache();
      return false;
    }
  }

  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(false);
      return;
    }
    const settings = localSettings.get();
    const priorDenials = Number(settings._location_denial_count || 0);
    navigator.geolocation.getCurrentPosition(
      () => {
        savePermissionSettingsAsync({
          location_permission_granted: true,
          _location_denial_count: 0,
        }, 'foreground_location_denial_count_save');
        invalidatePermissionCache();
        resolve(true);
      },
      (err) => {
        if (err?.code === err?.PERMISSION_DENIED) {
          savePermissionSettingsAsync({
            location_permission_granted: PERMISSION_STATES.DENIED,
            _location_denial_count: priorDenials + 1,
          }, 'foreground_location_denial_count_save');
        } else {
          localSettings.update({ location_permission_granted: PERMISSION_STATES.UNKNOWN });
        }
        invalidatePermissionCache();
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

export async function requestNotificationPermission() {
  invalidatePermissionCache();
  if (await currentPermissionState('notifications') === PERMISSION_STATES.GRANTED) {
    savePermissionSettingsAsync({
      notification_permission_granted: true,
      _notification_denial_count: 0,
    }, 'notification_denial_count_save');
    return true;
  }
  if (isNativePlatform()) {
    const settings = localSettings.get();
    const priorDenials = Number(settings._notification_denial_count || 0);
    try {
      const result = await LocalNotifications.requestPermissions();
      const granted = result.display === PERMISSION_STATES.GRANTED;
      if (granted) {
        savePermissionSettingsAsync({
          notification_permission_granted: true,
          _notification_denial_count: 0,
        }, 'notification_denial_count_save');
        invalidatePermissionCache();
        return true;
      }
      const denialCount = priorDenials + 1;
      const state = isAndroid() && denialCount >= 2
        ? PERMISSION_STATES.NEEDS_SETTINGS
        : PERMISSION_STATES.DENIED;
      savePermissionSettingsAsync({
        notification_permission_granted: state,
        _notification_denial_count: denialCount,
      }, 'notification_denial_count_save');
      invalidatePermissionCache();
      return false;
    } catch (err) {
      logError('notification_permission_request', err);
      localSettings.update({ notification_permission_granted: PERMISSION_STATES.UNKNOWN });
      invalidatePermissionCache();
      return false;
    }
  }

  if (!('Notification' in window)) return false;
  const settings = localSettings.get();
  const priorDenials = Number(settings._notification_denial_count || 0);
  const result = await Notification.requestPermission();
  const granted = result === PERMISSION_STATES.GRANTED;
  if (granted) {
    savePermissionSettingsAsync({
      notification_permission_granted: true,
      _notification_denial_count: 0,
    }, 'notification_denial_count_save');
  } else {
    savePermissionSettingsAsync({
      notification_permission_granted: PERMISSION_STATES.DENIED,
      _notification_denial_count: priorDenials + 1,
    }, 'notification_denial_count_save');
  }
  invalidatePermissionCache();
  return granted;
}

export async function requestActivityRecognitionPermission() {
  if (!isAndroid()) return false;
  invalidatePermissionCache();
  if (await currentPermissionState('activityRecognition') === PERMISSION_STATES.GRANTED) {
    savePermissionSettingsAsync({
      activity_permission_granted: true,
      _activity_denial_count: 0,
    }, 'activity_recognition_denial_count_save');
    return true;
  }
  const settings = localSettings.get();
  const priorDenials = Number(settings._activity_denial_count || 0);
  try {
    const result = await ActivityRecognition.requestPermissions();
    const granted = result.activityRecognition === PERMISSION_STATES.GRANTED;
    if (granted) {
      savePermissionSettingsAsync({
        activity_permission_granted: true,
        _activity_denial_count: 0,
      }, 'activity_recognition_denial_count_save');
      invalidatePermissionCache();
      return true;
    }
    const denialCount = priorDenials + 1;
    const state = denialCount >= 2 ? PERMISSION_STATES.NEEDS_SETTINGS : PERMISSION_STATES.DENIED;
    savePermissionSettingsAsync({
      activity_permission_granted: state,
      _activity_denial_count: denialCount,
    }, 'activity_recognition_denial_count_save');
    invalidatePermissionCache();
    return granted;
  } catch (err) {
    logError('activity_recognition_permission_request', err);
    localSettings.update({ activity_permission_granted: PERMISSION_STATES.UNKNOWN });
    invalidatePermissionCache();
    return false;
  }
}

export async function requestBackgroundLocationPermission() {
  invalidatePermissionCache();
  if (await currentPermissionState('backgroundLocation') === PERMISSION_STATES.GRANTED) {
    localSettings.update({
      background_location_granted: true,
      _background_location_denial_count: 0,
    });
    return true;
  }
  const [foreground, notifications] = await Promise.all([
    getPermissionStatus('foregroundLocation', { force: true }),
    getPermissionStatus('notifications', { force: true }),
  ]);
  if (foreground?.status !== PERMISSION_STATES.GRANTED) return false;
  if (notifications?.status !== PERMISSION_STATES.GRANTED) return false;

  if (isAndroid()) {
    try {
      let status = await ActivityRecognition.checkPermissions();
      if (status.backgroundLocation === PERMISSION_STATES.GRANTED) {
        localSettings.update({
          background_location_granted: true,
          _background_location_denial_count: 0,
        });
        invalidatePermissionCache();
        return true;
      }

      const result = await ActivityRecognition.requestBackgroundLocation();
      const granted = result.backgroundLocation === PERMISSION_STATES.GRANTED;
      if (granted) {
        localSettings.update({
          background_location_granted: true,
          _background_location_denial_count: 0,
        });
        invalidatePermissionCache();
        return true;
      }

      const currentSettings = localSettings.get();
      const denialCount = Number(currentSettings._background_location_denial_count || 0) + 1;
      const partialGrant = result.foregroundLocation === PERMISSION_STATES.GRANTED &&
        result.backgroundLocation !== PERMISSION_STATES.GRANTED;
      const shouldEscalate = !partialGrant && denialCount >= 2;

      localSettings.update({
        background_location_granted: shouldEscalate ? PERMISSION_STATES.NEEDS_SETTINGS : PERMISSION_STATES.DENIED,
        _background_location_denial_count: denialCount,
      });

      if (shouldEscalate) await ActivityRecognition.openAppLocationSettings();
      invalidatePermissionCache();
      return {
        granted: false,
        reason: shouldEscalate ? 'needs_settings' : (partialGrant ? 'partial_grant' : 'denied'),
      };
    } catch (err) {
      logError('background_location_permission_request', err);
      try {
        await ActivityRecognition.openAppLocationSettings();
      } catch (settingsErr) {
        logError('background_location_settings_open', settingsErr);
      }
      localSettings.update({ background_location_granted: PERMISSION_STATES.NEEDS_SETTINGS });
      invalidatePermissionCache();
      return false;
    }
  }

  // NOTE: iOS "Always Allow" background location requires a separate native
  // CLLocationManager requestAlwaysAuthorization flow. This web/non-Android
  // path assumes that any native iOS layer has already obtained that grant.
  localSettings.update({ background_location_granted: true });
  invalidatePermissionCache();
  return true;
}

export async function requestBluetoothPermission() {
  invalidatePermissionCache();
  if (isAndroid()) {
    try {
      if (typeof ActivityRecognition.requestBluetoothPermission !== 'function') return false;
      const result = await ActivityRecognition.requestBluetoothPermission();
      invalidatePermissionCache();
      return result.bluetoothConnect === PERMISSION_STATES.GRANTED;
    } catch (err) {
      logError('bluetooth_permission_request', err);
      invalidatePermissionCache();
      return false;
    }
  }

  return getObdBluetoothSupport().supported;
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
