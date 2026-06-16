import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const systemLog = vi.hoisted(() => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

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

vi.mock('@/lib/systemLog', () => systemLog);

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
    vi.clearAllMocks();
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

    const status = await service.start(onPoint, onError);
    await watchError({ code: 1, message: 'User denied Geolocation' });

    expect(status).toEqual({ started: true, mode: 'foreground', watcher_type: 'web_geolocation' });
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

    const status = await service.start(onPoint, vi.fn());
    watchSuccess({
      coords: {
        latitude: 43.6542,
        longitude: -79.3832,
        speed: 0,
        accuracy: 8,
      },
      timestamp: Date.UTC(2026, 0, 1, 12, 0, 10),
    });

    expect(status).toEqual({ started: true, mode: 'foreground', watcher_type: 'web_geolocation' });
    expect(onPoint).toHaveBeenCalledTimes(2);
    expect(onPoint.mock.calls.at(-1)[0].speed_kmh).toBeGreaterThan(35);
  });

  it('logs the initial accepted GPS point and watcher type', async () => {
    const { createDrivingTrackingService } = await import('@/lib/trackingService');
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        geolocation: {
          getCurrentPosition: vi.fn((success) => success(samplePosition)),
          watchPosition: vi.fn(() => 44),
          clearWatch: vi.fn(),
        },
      },
      configurable: true,
    });

    const service = createDrivingTrackingService();
    const status = await service.start(vi.fn(), vi.fn());

    expect(status).toEqual({ started: true, mode: 'foreground', watcher_type: 'web_geolocation' });
    expect(systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'tracking_initial_location',
      expect.objectContaining({
        accepted: true,
        accuracy_m: 8,
        speed_kmh: 0,
        lat: 43.6532,
        lng: -79.3832,
      }),
      expect.objectContaining({
        category: 'tracking',
        source: 'trackingService',
        title: 'Initial GPS location accepted',
      })
    );
    expect(systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'tracking_service_started',
      expect.objectContaining({
        background_tracking: false,
        native_platform: false,
        watcher_type: 'web_geolocation',
        mode: 'foreground',
      }),
      expect.objectContaining({ category: 'tracking', source: 'web' })
    );
  });

  it('logs initial GPS rejection and rate-limits repeated rejected point diagnostics', async () => {
    const { createDrivingTrackingService } = await import('@/lib/trackingService');
    let watchSuccess;
    const poorAccuracyPosition = {
      ...samplePosition,
      coords: {
        ...samplePosition.coords,
        accuracy: 200,
      },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        geolocation: {
          getCurrentPosition: vi.fn((success) => success(poorAccuracyPosition)),
          watchPosition: vi.fn((success) => {
            watchSuccess = success;
            return 45;
          }),
          clearWatch: vi.fn(),
        },
      },
      configurable: true,
    });
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(20_000)
      .mockReturnValueOnce(25_000)
      .mockReturnValueOnce(31_000);

    const service = createDrivingTrackingService();
    const onPoint = vi.fn();
    const status = await service.start(onPoint, vi.fn());
    watchSuccess(poorAccuracyPosition);
    watchSuccess(poorAccuracyPosition);

    expect(status).toEqual({ started: true, mode: 'foreground', watcher_type: 'web_geolocation' });
    expect(onPoint).not.toHaveBeenCalled();
    expect(systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'tracking_initial_location',
      expect.objectContaining({
        accepted: false,
        rejection_reason: 'accuracy_too_poor_200m',
        accuracy_m: 200,
      }),
      expect.objectContaining({
        category: 'tracking',
        source: 'trackingService',
        title: 'Initial GPS location rejected',
      })
    );
    expect(systemLog.recordSystemEvent).toHaveBeenCalledWith(
      'location_point_rejected',
      expect.objectContaining({
        reason: 'accuracy_too_poor_200m',
        accuracy_m: 200,
        has_coordinates: true,
      }),
      expect.objectContaining({
        category: 'tracking',
        severity: 'warn',
        source: 'trackingService',
        title: 'GPS point rejected: accuracy_too_poor_200m',
      })
    );
    expect(systemLog.logSystemFailure).not.toHaveBeenCalledWith(
      'location_point_rejected',
      expect.anything(),
      expect.anything()
    );
  });
});
