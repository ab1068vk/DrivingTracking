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
export const PARKING_REFINEMENT_DURATION_MS = 30_000;
export const PARKING_REFINEMENT_INTERVAL_MS = 5_000;
export const PARKING_REFINEMENT_MAX_FIXES = 6;
const PARKING_REFINEMENT_MAX_ACCURACY_M = 75;
const PARKING_REFINEMENT_MAX_DRIFT_M = 35;
const PARKING_REFINEMENT_MOVING_SPEED_KMH = 8;

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

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parkingCoordinateIsUsable = (point) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  const accuracy = Number(point?.accuracy);
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) <= 90 && Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0) &&
    (!Number.isFinite(accuracy) || accuracy <= PARKING_REFINEMENT_MAX_ACCURACY_M);
};

const distanceBetweenParkingPointsM = (first, second) => {
  if (!parkingCoordinateIsUsable(first) || !parkingCoordinateIsUsable(second)) return Number.POSITIVE_INFINITY;
  const lat1 = Number(first.lat) * Math.PI / 180;
  const lat2 = Number(second.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (Number(second.lng) - Number(first.lng)) * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
};

/**
 * Collects a bounded set of high-accuracy fixes after a trip ends. The fixes
 * are kept separate from the trip route so walking away from the car cannot
 * extend or alter the saved drive.
 */
export async function collectParkingRefinementFixes({
  anchorPoint = null,
  durationMs = PARKING_REFINEMENT_DURATION_MS,
  intervalMs = PARKING_REFINEMENT_INTERVAL_MS,
  maxFixes = PARKING_REFINEMENT_MAX_FIXES,
  getPosition = null,
  wait = waitFor,
  now = () => Date.now(),
} = {}) {
  const startedAtMs = now();
  const deadlineMs = startedAtMs + Math.max(0, Number(durationMs) || 0);
  const fixes = [];
  let anchor = parkingCoordinateIsUsable(anchorPoint) ? anchorPoint : null;
  const readPosition = getPosition || (async () => {
    const position = isNativePlatform()
      ? await Geolocation.getCurrentPosition(watchOptions)
      : await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, watchOptions);
        });
    return normalizeLocationPoint(position);
  });

  if (!getPosition) {
    const granted = await requestForegroundLocationPermission();
    if (!granted) return { status: 'permission_denied', fixes, durationMs: 0 };
  }

  while (fixes.length < Math.max(1, Number(maxFixes) || 1) && now() <= deadlineMs) {
    try {
      const rawPoint = await readPosition();
      const point = rawPoint?.coords ? normalizeLocationPoint(rawPoint) : rawPoint;
      if (parkingCoordinateIsUsable(point)) {
        const speedKmh = Math.max(0, Number(point.speed_kmh) || 0);
        if (speedKmh > PARKING_REFINEMENT_MOVING_SPEED_KMH) {
          return {
            status: 'cancelled_movement',
            fixes: [],
            durationMs: Math.max(0, now() - startedAtMs),
          };
        }
        anchor ||= point;
        if (distanceBetweenParkingPointsM(anchor, point) > PARKING_REFINEMENT_MAX_DRIFT_M) {
          return {
            status: 'cancelled_drift',
            fixes: [],
            durationMs: Math.max(0, now() - startedAtMs),
          };
        }
        fixes.push({
          ...point,
          speed_kmh: speedKmh,
          parking_refinement: true,
        });
      }
    } catch (error) {
      logSystemFailure('parking_refinement_fix', error, {
        accepted_fix_count: fixes.length,
      });
    }

    if (fixes.length >= Math.max(1, Number(maxFixes) || 1) || now() >= deadlineMs) break;
    await wait(Math.min(Math.max(0, Number(intervalMs) || 0), Math.max(0, deadlineMs - now())));
  }

  return {
    status: fixes.length >= 3 ? 'completed' : fixes.length ? 'partial' : 'unavailable',
    fixes,
    durationMs: Math.max(0, now() - startedAtMs),
  };
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
