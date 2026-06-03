import { useCallback, useEffect, useState } from 'react';
import { getAndroidBatteryOptimizationStatus } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { getPermissionStatus } from '@/lib/permissions';
import { useOptionalPermissions } from '@/lib/permissions/PermissionContext';

const POLL_INTERVAL_MS = 60_000;

const ISSUE_COPY = {
  foregroundLocation: {
    id: 'foregroundLocation',
    label: 'Location permission',
    fixHint: 'Settings > Apps > Road Sage > Permissions > Location > Allow while using the app.',
  },
  backgroundLocation: {
    id: 'backgroundLocation',
    label: 'Background location',
    fixHint: 'Settings > Apps > Road Sage > Permissions > Location > Allow all the time.',
  },
  activityRecognition: {
    id: 'activityRecognition',
    label: 'Physical Activity permission',
    fixHint: 'Settings > Apps > Road Sage > Permissions > Physical activity > Allow.',
  },
  notifications: {
    id: 'notifications',
    label: 'Notification permission',
    fixHint: 'Settings > Apps > Road Sage > Notifications > Allow notifications.',
  },
  batteryOptimization: {
    id: 'batteryOptimization',
    label: 'Battery optimization is restricting Road Sage',
    fixHint: 'Settings > Apps > Road Sage > Battery > Unrestricted.',
  },
  permissionCheck: {
    id: 'permissionCheck',
    label: 'Permission status could not be verified',
    fixHint: 'Open Android app settings for Road Sage, confirm location and physical activity permissions, then re-check.',
  },
};

function isGranted(value) {
  return value === 'granted';
}

function makeIssue(key, status) {
  return {
    ...ISSUE_COPY[key],
    status: status || 'unknown',
  };
}

function requiredPermissionKeys(trackingMode) {
  if (trackingMode === 'manual' || trackingMode === 'paused') return [];

  const keys = ['foregroundLocation'];
  if (isAndroid()) {
    keys.push('activityRecognition');
  }
  if (trackingMode === 'background_auto') {
    keys.push('backgroundLocation', 'notifications');
  }
  return keys;
}

export function buildPermissionMonitorIssues({
  trackingMode,
  permissionStatus,
  batteryStatus,
  permissionCheckFailed = false,
  batteryCheckFailed = false,
}) {
  if (trackingMode === 'manual' || trackingMode === 'paused') return [];

  const issues = [];
  if (permissionCheckFailed) {
    issues.push(makeIssue('permissionCheck', 'unknown'));
  }

  for (const key of requiredPermissionKeys(trackingMode)) {
    if (!isGranted(permissionStatus?.[key])) {
      issues.push(makeIssue(key, permissionStatus?.[key]));
    }
  }

  if (isAndroid() && trackingMode === 'background_auto') {
    if (batteryStatus?.batteryOptimizationIgnored !== true) {
      issues.push(makeIssue(
        'batteryOptimization',
        batteryCheckFailed ? 'unknown' : 'restricted'
      ));
    }
  }

  return issues;
}

export function usePermissionMonitor(trackingMode) {
  const permissionContext = useOptionalPermissions();
  const refreshPermissionStatus = permissionContext?.refresh;
  const [issues, setIssues] = useState([]);
  const [isChecking, setIsChecking] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);

  const check = useCallback(async () => {
    if (trackingMode === 'manual' || trackingMode === 'paused') {
      setIssues([]);
      setLastCheckedAt(new Date().toISOString());
      return [];
    }

    setIsChecking(true);

    try {
      let permissionStatus = null;
      let batteryStatus = null;
      let permissionCheckFailed = false;
      let batteryCheckFailed = false;

      try {
        permissionStatus = refreshPermissionStatus
          ? await refreshPermissionStatus()
          : await getPermissionStatus();
      } catch {
        permissionCheckFailed = true;
      }

      if (isAndroid() && trackingMode === 'background_auto') {
        try {
          batteryStatus = await getAndroidBatteryOptimizationStatus();
        } catch {
          batteryCheckFailed = true;
        }
      }

      const found = buildPermissionMonitorIssues({
        trackingMode,
        permissionStatus,
        batteryStatus,
        permissionCheckFailed,
        batteryCheckFailed,
      });

      setIssues(found);
      setLastCheckedAt(new Date().toISOString());
      return found;
    } catch (err) {
      console.warn('[usePermissionMonitor] check failed:', err);
      return [];
    } finally {
      setIsChecking(false);
    }
  }, [refreshPermissionStatus, trackingMode]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) await check();
    };

    run();
    const id = window.setInterval(run, POLL_INTERVAL_MS);
    const onFocus = () => run();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') run();
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [check]);

  return { issues, recheck: check, isChecking, lastCheckedAt };
}
