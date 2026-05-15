import { registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { calculateSegmentMetrics, normalizeLocationPoint, shouldAcceptLocationPoint } from '@/lib/tripEngine';
import { isNativePlatform } from '@/lib/nativePlatform';
import {
  requestBackgroundLocationPermission,
  requestForegroundLocationPermission,
} from '@/lib/permissions';

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');

const watchOptions = {
  enableHighAccuracy: true,
  timeout: 10000,
  maximumAge: 0,
  minimumUpdateInterval: 3000,
  interval: 5000,
};

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

export function createDrivingTrackingService({ background = false } = {}) {
  let watcherId = null;
  let webWatcherId = null;
  let previousPoint = null;

  const emitPoint = (rawPoint, onPoint) => {
    const point = normalizeLocationPoint(rawPoint);
    if (!shouldAcceptLocationPoint(point, previousPoint)) return;
    const segment = calculateSegmentMetrics(previousPoint, point);
    const normalizedPoint = previousPoint
      ? { ...point, speed_kmh: segment.reliableSpeedKmh }
      : { ...point, speed_kmh: point.speed_kmh != null && point.speed_kmh >= 5 ? point.speed_kmh : 0 };
    previousPoint = normalizedPoint;
    onPoint(normalizedPoint);
  };

  const emitInitialPoint = async (onPoint) => {
    if (!isNativePlatform()) return;
    try {
      const position = await Geolocation.getCurrentPosition(watchOptions);
      emitPoint(position, onPoint);
    } catch {
      // A watcher below can still recover when GPS gets a fix.
    }
  };

  return {
    async start(onPoint, onError) {
      try {
        const allowed = background
          ? await requestBackgroundLocationPermission()
          : await requestForegroundLocationPermission();

        if (!allowed) {
          onError?.({ message: 'Location permission is required to track a trip.' });
          return;
        }

        await emitInitialPoint(onPoint);

        if (background && isNativePlatform()) {
          watcherId = await BackgroundGeolocation.addWatcher(
            {
              backgroundTitle: 'DriveSense tracking active',
              backgroundMessage: 'DriveSense is recording your driving route. Tap Stop Tracking in the app when done.',
              requestPermissions: false,
              stale: false,
              distanceFilter: 10,
            },
            (location, error) => {
              if (error) {
                onError?.({ message: error.message || 'Background location failed', code: error.code });
                return;
              }
              emitPoint(location, onPoint);
            }
          );
          return;
        }

        if (isNativePlatform()) {
          watcherId = await Geolocation.watchPosition(watchOptions, (position, error) => {
            if (error) {
              onError?.({ message: error.message || 'Location failed', code: error.code });
              return;
            }
            emitPoint(position, onPoint);
          });
          return;
        }

        if (!navigator.geolocation) {
          onError?.({ message: 'Geolocation is not supported on this device.' });
          return;
        }

        webWatcherId = navigator.geolocation.watchPosition(
          (position) => emitPoint(position, onPoint),
          (error) => onError?.({ message: error.message, code: error.code }),
          watchOptions
        );
      } catch (error) {
        onError?.({ message: error.message || 'Could not start location tracking.' });
      }
    },

    async stop() {
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
    },

    isActive() {
      return watcherId !== null || webWatcherId !== null;
    },
  };
}
