import { afterEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  tripUpsertMany: vi.fn(async (trips = []) => trips),
  vehicleUpsertMany: vi.fn(async (vehicles = []) => vehicles),
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    upsertMany: serviceMocks.tripUpsertMany,
  },
}));

vi.mock('@/api/vehicles', () => ({
  vehicleService: {
    upsertMany: serviceMocks.vehicleUpsertMany,
  },
}));

import { importDriveSenseBackup } from '@/lib/dataBackup';
import { DEFAULT_SETTINGS, localSettings, sanitizeImportedSettings } from '@/lib/trackingStore';

function makeMemoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => store.get(key) ?? null),
    setItem: vi.fn((key, value) => store.set(key, String(value))),
    removeItem: vi.fn((key) => store.delete(key)),
    clear: vi.fn(() => store.clear()),
  };
}

function backupFile(settings) {
  return {
    size: 1024,
    text: vi.fn(async () => JSON.stringify({
      app: 'Road Sage',
      version: 5,
      vehicles: [],
      trips: [],
      settings,
    })),
  };
}

describe('backup settings import security', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('drops unknown keys before merging imported settings', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());

    await importDriveSenseBackup(backupFile({
      ['__proto__']: { polluted: true },
      injected_key: 'nope',
      phone_use_detection_enabled: false,
    }));

    const settings = localSettings.get();
    expect(settings.injected_key).toBeUndefined();
    expect(settings.phone_use_detection_enabled).toBe(false);
    expect({}.polluted).toBeUndefined();
  });

  it('strips constructor and __proto__ from imported settings', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"units":"metric"}');
    const result = sanitizeImportedSettings(hostile);

    expect(result.units).toBe('metric');
    expect(result.constructor).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    expect({}.polluted).toBeUndefined();
  });

  it('strips imported OSRM endpoints so backups cannot redirect route data', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());

    await importDriveSenseBackup(backupFile({
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://evil.example.com',
      osrm_public_demo_consent_at: '2026-05-26T12:00:00.000Z',
      osrm_data_sharing_consented: true,
      osrm_last_reachable_at: '2026-05-26T12:00:00.000Z',
      osrm_verified_endpoint: 'https://evil.example.com',
      osrm_verified_domain: 'evil.example.com',
    }));

    expect(localSettings.get().osrm_map_matching_url).toBe('');
    expect(localSettings.get().osrm_public_demo_consent_at).toBe('');
    expect(localSettings.get().osrm_data_sharing_consented).toBe(false);
    expect(localSettings.get().osrm_last_reachable_at).toBe('');
    expect(localSettings.get().osrm_verified_endpoint).toBe('');
    expect(localSettings.get().osrm_verified_domain).toBe('');
  });

  it('clamps imported harsh-braking thresholds to the safe range', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());

    await importDriveSenseBackup(backupFile({
      threshold_harsh_brake_ms2: 9999,
    }));

    expect(localSettings.get().threshold_harsh_brake_ms2).toBe(8);
    expect(sanitizeImportedSettings({ threshold_harsh_brake_ms2: 0 }).threshold_harsh_brake_ms2).toBe(2);
  });

  it('does not import background auto-tracking without in-app consent', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());

    await importDriveSenseBackup(backupFile({
      tracking_mode: 'background_auto',
    }));

    expect(localSettings.get().tracking_mode).toBe('manual');
  });

  it('backup import cannot disable local-only mode on this device', async () => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    localSettings.set({
      ...DEFAULT_SETTINGS,
      external_requests_local_only: true,
      map_tiles_enabled: false,
      backend_sync_enabled: false,
      road_data_fetch_always_allow: false,
    });

    await importDriveSenseBackup(backupFile({
      external_requests_local_only: false,
      map_tiles_enabled: true,
      backend_sync_enabled: true,
      road_data_fetch_always_allow: true,
    }));

    expect(localSettings.get()).toMatchObject({
      external_requests_local_only: true,
      map_tiles_enabled: false,
      backend_sync_enabled: false,
      road_data_fetch_always_allow: false,
    });
  });
});
