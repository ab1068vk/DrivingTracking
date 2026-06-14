import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    addWatcher: vi.fn(),
    removeWatcher: vi.fn(),
  }),
}));

vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    getCurrentPosition: vi.fn(),
    watchPosition: vi.fn(),
    clearWatch: vi.fn(),
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => false,
}));

vi.mock('@/lib/permissions', () => ({
  requestBackgroundLocationPermission: vi.fn(async () => true),
  requestForegroundLocationPermission: vi.fn(async () => true),
}));

const samplePosition = {
  coords: {
    latitude: 43.6532,
    longitude: -79.3832,
    speed: 0,
    accuracy: 8,
  },
  timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
};

describe('trackingService web geolocation watcher', () => {
  let originalNavigator;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  it('stops the web watcher and emits a typed error when geolocation permission is revoked', async () => {
    const { createDrivingTrackingService } = await import('@/lib/trackingService');
    const clearWatch = vi.fn();
    let watchError;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        geolocation: {
          getCurrentPosition: vi.fn((success) => success(samplePosition)),
          watchPosition: vi.fn((_success, error) => {
            watchError = error;
            return 42;
          }),
          clearWatch,
        },
      },
      configurable: true,
    });
    const onPoint = vi.fn();
    const onError = vi.fn();
    const service = createDrivingTrackingService();

    await service.start(onPoint, onError);
    await watchError({ code: 1, message: 'User denied Geolocation' });

    expect(clearWatch).toHaveBeenCalledWith(42);
    expect(service.isActive()).toBe(false);
    expect(onError).toHaveBeenCalledWith({
      type: 'permission_denied',
      message: 'Location permission was denied.',
      code: 1,
    });
  });

  it('derives live speed from movement when the device reports zero speed', async () => {
    const { createDrivingTrackingService } = await import('@/lib/trackingService');
    let watchSuccess;
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        geolocation: {
          getCurrentPosition: vi.fn((success) => success(samplePosition)),
          watchPosition: vi.fn((success) => {
            watchSuccess = success;
            return 43;
          }),
          clearWatch: vi.fn(),
        },
      },
      configurable: true,
    });
    const onPoint = vi.fn();
    const service = createDrivingTrackingService();

    await service.start(onPoint, vi.fn());
    watchSuccess({
      coords: {
        latitude: 43.6542,
        longitude: -79.3832,
        speed: 0,
        accuracy: 8,
      },
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 10),
    });

    expect(onPoint).toHaveBeenCalledTimes(2);
    expect(onPoint.mock.calls.at(-1)[0].speed_kmh).toBeGreaterThan(35);
  });
});
