import { registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import {
  calculateSegmentMetrics,
  getLocationPointRejectionReason,
  normalizeLocationPoint,
  shouldAcceptLocationPoint,
} from '@/lib/tripEngine';
import { isNativePlatform } from '@/lib/nativePlatform';
import {
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
} from '@/lib/permissions';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const watchOptions = {
  enableHighAccuracy: true,
  timeout: 7000,
  maximumAge: 0,
  minimumUpdateInterval: 1000,
  interval: 2000,
};

const GEOLOCATION_PERMISSION_DENIED = 1;
const ROUTE_GAP_SECONDS = 120;

function isPermissionDeniedError(error) {
  const browserPermissionDenied = typeof GeolocationPositionError !== 'undefined'
    ? GeolocationPositionError.PERMISSION_DENIED
    : GEOLOCATION_PERMISSION_DENIED;
  return Number(error?.code) === browserPermissionDenied;
}

export async function getCurrentLocation() {
  const granted = await requestForegroundLocationPermission();
  if (!granted) throw new Error('Location permission denied.');

  if (isNativePlatform()) {
    const position = await Geolocation.getCurrentPosition(watchOptions);
    return normalizeLocationPoint(position);
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(normalizeLocationPoint(position)),
      (error) => reject(error),
      watchOptions
    );
  });
}

export function createDrivingTrackingService({ background = false, privateMode = false } = {}) {
  let watcherId = null;
  let webWatcherId = null;
  let previousPoint = null;
  let lastRejectedDiagnosticMs = 0;
  let initialPointLogged = false;

  const emitPoint = (rawPoint, onPoint) => {
    const point = normalizeLocationPoint(rawPoint);
    if (!shouldAcceptLocationPoint(point, previousPoint)) {
      const reason = getLocationPointRejectionReason(point, previousPoint);
      const now = Date.now();
      if (!lastRejectedDiagnosticMs || now - lastRejectedDiagnosticMs >= 10_000) {
        lastRejectedDiagnosticMs = now;
        recordSystemEvent('location_point_rejected', {
          reason,
          accuracy_m: point?.accuracy,
          speed_kmh: point?.speed_kmh,
          has_coordinates: point?.lat != null && point?.lng != null,
        }, {
          category: 'tracking',
          source: 'trackingService',
          severity: 'warn',
          title: `GPS point rejected: ${reason}`,
        });
      }

      if (!initialPointLogged) {
        initialPointLogged = true;
        recordSystemEvent('tracking_initial_location', {
          accepted: false,
          rejection_reason: reason,
          accuracy_m: point?.accuracy,
          speed_kmh: point?.speed_kmh,
        }, {
          category: 'tracking',
          source: 'trackingService',
          title: 'Initial GPS location rejected',
        });
      }
      return;
    }

    const segment = calculateSegmentMetrics(previousPoint, point);
    const normalizedPoint = previousPoint
      ? {
          ...point,
          speed_kmh: segment.reliableSpeedKmh,
          ...(segment.dt > ROUTE_GAP_SECONDS ? { tracking_gap: true } : {}),
        }
      : { ...point, speed_kmh: point.speed_kmh != null && point.speed_kmh >= 5 ? point.speed_kmh : 0 };

    if (!initialPointLogged) {
      initialPointLogged = true;
      recordSystemEvent('tracking_initial_location', {
        accepted: true,
        accuracy_m: point?.accuracy,
        speed_kmh: normalizedPoint.speed_kmh,
        lat: point?.lat,
        lng: point?.lng,
      }, {
        category: 'tracking',
        source: 'trackingService',
        title: 'Initial GPS location accepted',
      });
    }

    previousPoint = normalizedPoint;
    onPoint(normalizedPoint);
  };

  const emitInitialPoint = async (onPoint) => {
    try {
      const position = isNativePlatform()
        ? await Geolocation.getCurrentPosition(watchOptions)
        : await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, watchOptions);
        });
      emitPoint(position, onPoint);
    } catch (error) {
      logSystemFailure('tracking_initial_location', error, {
        background_tracking: background === true,
        native_platform: isNativePlatform(),
      });
      // A watcher below can still recover when GPS gets a fix.
    }
  };

  const stopTracking = async () => {
    if (background && watcherId) {
      await BackgroundGeolocation.removeWatcher({ id: watcherId });
    } else if (isNativePlatform() && watcherId) {
      await Geolocation.clearWatch({ id: watcherId });
    } else if (webWatcherId !== null) {
      navigator.geolocation.clearWatch(webWatcherId);
    }

    watcherId = null;
    webWatcherId = null;
    previousPoint = null;
    lastRejectedDiagnosticMs = 0;
    initialPointLogged = false;
    recordSystemEvent('tracking_service_stopped', {
      background_tracking: background === true,
      native_platform: isNativePlatform(),
    }, { category: 'background', title: 'Tracking service stopped' });
  };

  const emitPermissionDenied = async (onError) => {
    await stopTracking();
    onError?.({
      type: 'permission_denied',
      message: 'Location permission was denied.',
      code: GEOLOCATION_PERMISSION_DENIED,
    });
  };

  return {
    async start(onPoint, onError) {
      try {
        const allowed = background
          ? await requestBackgroundLocationPermission()
          : await requestForegroundLocationPermission();

        if (!allowed) {
          recordSystemEvent('tracking_service_start_blocked', {
            background_tracking: background === true,
            reason: 'permission_denied',
          }, { category: 'permission', severity: 'warn', title: 'Tracking service start blocked' });
          onError?.({
            type: 'permission_denied',
            message: 'Location permission is required to track a trip.',
            code: GEOLOCATION_PERMISSION_DENIED,
          });
          return { started: false, reason: 'permission_denied' };
        }

        await emitInitialPoint(onPoint);

        if (background && isNativePlatform()) {
          watcherId = await BackgroundGeolocation.addWatcher(
            {
              backgroundTitle: privateMode ? 'Road Sage private trip active' : 'Road Sage tracking active',
              backgroundMessage: privateMode
                ? 'Road Sage is calculating a trip summary. Route coordinates are not saved.'
                : 'Road Sage is recording your driving route. Tap Stop Tracking in the app when done.',
              requestPermissions: false,
              stale: false,
              distanceFilter: 5,
            },
            (location, error) => {
              if (error) {
                logSystemFailure('background_location_watcher', error, {
                  code: error.code,
                });
                onError?.({ message: error.message || 'Background location failed', code: error.code });
                return;
              }
              emitPoint(location, onPoint);
            }
          );
          recordSystemEvent('tracking_service_started', {
            background_tracking: true,
            native_platform: true,
            watcher_type: 'background_geolocation',
            mode: 'background',
          }, { category: 'tracking', source: 'android', title: 'Tracking service started (background geolocation)' });
          return { started: true, mode: 'background', watcher_type: 'background_geolocation' };
        }

        if (isNativePlatform()) {
          watcherId = await Geolocation.watchPosition(watchOptions, (position, error) => {
            if (error) {
              logSystemFailure('native_location_watcher', error, {
                code: error.code,
              });
              onError?.({ message: error.message || 'Location failed', code: error.code });
              return;
            }
            emitPoint(position, onPoint);
          });
          recordSystemEvent('tracking_service_started', {
            background_tracking: false,
            native_platform: true,
            watcher_type: 'capacitor_geolocation',
            mode: 'foreground',
          }, { category: 'tracking', source: 'native', title: 'Tracking service started (foreground Capacitor)' });
          return { started: true, mode: 'foreground', watcher_type: 'capacitor_geolocation' };
        }

        if (!navigator.geolocation) {
          recordSystemEvent('tracking_service_start_blocked', {
            background_tracking: false,
            reason: 'geolocation_unavailable',
          }, { category: 'permission', severity: 'warn', title: 'Tracking service start blocked' });
          onError?.({ message: 'Geolocation is not supported on this device.' });
          return { started: false, reason: 'geolocation_unavailable' };
        }

        webWatcherId = navigator.geolocation.watchPosition(
          (position) => emitPoint(position, onPoint),
          async (error) => {
            if (isPermissionDeniedError(error)) {
              await emitPermissionDenied(onError);
              return;
            }
            logSystemFailure('web_location_watcher', error, {
              code: error.code,
            });
            onError?.({ message: error.message, code: error.code });
          },
          watchOptions
        );
        recordSystemEvent('tracking_service_started', {
          background_tracking: false,
          native_platform: false,
          watcher_type: 'web_geolocation',
          mode: 'foreground',
        }, { category: 'tracking', source: 'web', title: 'Tracking service started (web geolocation)' });
        return { started: true, mode: 'foreground', watcher_type: 'web_geolocation' };
      } catch (error) {
        logSystemFailure('tracking_service_start', error, {
          background_tracking: background === true,
          native_platform: isNativePlatform(),
        });
        onError?.({ message: error.message || 'Could not start location tracking.' });
        return { started: false, reason: 'start_failed', error };
      }
    },

    async stop() {
      await stopTracking();
    },

    isActive() {
      return watcherId !== null || webWatcherId !== null;
    },
  };
}
