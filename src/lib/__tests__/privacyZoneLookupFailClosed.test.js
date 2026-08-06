import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendPrivacyEvent: vi.fn(async () => ({})),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  pinnedFetch: vi.fn(),
  store: new Map(),
  zoneStoreError: null,
}));

vi.mock('@/lib/hashChainLog', () => ({
  appendPrivacyEvent: mocks.appendPrivacyEvent,
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
  recordSystemEvent: mocks.recordSystemEvent,
  logError: mocks.logSystemFailure,
}));

vi.mock('@/lib/pinnedFetch', () => ({
  pinnedFetch: mocks.pinnedFetch,
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => {
    if (key === 'drivesense_privacy_zones_config_v1' && mocks.zoneStoreError) {
      throw mocks.zoneStoreError;
    }
    return mocks.store.has(key) ? structuredClone(mocks.store.get(key)) : fallback;
  }),
  setEncryptedJson: vi.fn(async (key, value) => {
    mocks.store.set(key, structuredClone(value));
  }),
  removeEncryptedJson: vi.fn(async (key) => {
    mocks.store.delete(key);
  }),
  encryptSensitiveValue: vi.fn(async (value) => value),
}));

import { fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { loadOsmSpeedLimitWays } from '@/lib/speedLimitSource';
import { mapMatchRoute } from '@/lib/mapMatching';
import { loadTransmissionLog } from '@/lib/transmissionLog';
import { localSettings } from '@/lib/trackingStore';

// The redacted mirror that lives in plain settings: labels and radii only, no
// geometry. On its own it can never answer "is this point private?".
const REDACTED_ZONES = [{
  id: 'home',
  label: 'Home',
  type: 'circle',
  radius_m: 180,
  sensitivity: 'standard',
  exclude_from_osrm: true,
  masked_for_privacy: true,
}];

const ROUTE_POINTS = [
  { lat: 43.65, lng: -79.38, speed_kmh: 30, timestamp: '2026-05-22T10:00:00.000Z' },
  { lat: 43.66, lng: -79.39, speed_kmh: 42, timestamp: '2026-05-22T10:05:00.000Z' },
  { lat: 43.67, lng: -79.40, speed_kmh: 38, timestamp: '2026-05-22T10:10:00.000Z' },
];

describe('outbound lookups when privacy zones cannot be read', () => {
  beforeEach(() => {
    // Stored settings drive the obfuscator and the heightened-privacy gate, and
    // they default to heightened-on. Seed them explicitly so these tests exercise
    // the privacy-zone path rather than the heightened-privacy short circuit.
    const settingsValues = new Map([['drivesense_settings', JSON.stringify({
      heightened_privacy_mode: false,
      request_obfuscation_enabled: false,
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => settingsValues.get(key) ?? null),
      setItem: vi.fn((key, value) => settingsValues.set(key, String(value))),
      removeItem: vi.fn((key) => settingsValues.delete(key)),
    });
    mocks.store = new Map();
    mocks.zoneStoreError = new Error('Secure privacy-zone store is unavailable.');
    mocks.pinnedFetch.mockReset();
    mocks.pinnedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    mocks.logSystemFailure.mockClear();
    mocks.recordSystemEvent.mockClear();
    localSettings.set({
      ...localSettings.get(),
      heightened_privacy_mode: false,
      request_obfuscation_enabled: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the Open-Meteo weather lookup instead of sending a raw route midpoint', async () => {
    const result = await fetchWeatherContextForTrip(
      ROUTE_POINTS,
      '2026-05-22T10:00:00.000Z',
      '2026-05-22T10:10:00.000Z',
      { privacy_zones: REDACTED_ZONES, weather_context_enabled: true }
    );

    expect(result).toMatchObject({ source: 'unavailable', status: 'privacy_zones_unavailable' });
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    expect(await loadTransmissionLog()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'open-meteo',
        coordinateDisclosure: 'blocked',
        bytesOut: 0,
      }),
    ]));
  });

  it('skips the Overpass speed-limit query instead of sending the full route bbox', async () => {
    const result = await loadOsmSpeedLimitWays(ROUTE_POINTS, {
      privacy_zones: REDACTED_ZONES,
      speed_limit_lookup_enabled: true,
    });

    expect(result).toMatchObject({
      ways: [],
      status: 'empty_route',
      skipped_reason: 'privacy_zones_unavailable',
    });
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    expect(await loadTransmissionLog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'overpass', coordinateDisclosure: 'blocked', bytesOut: 0 }),
    ]));
  });

  it('skips OSRM route snapping instead of sending raw coordinate pairs', async () => {
    const result = await mapMatchRoute(ROUTE_POINTS, {
      privacy_zones: REDACTED_ZONES,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example.test',
      osrm_data_sharing_consented: true,
    });

    expect(result).toMatchObject({ status: 'privacy_zones_unavailable', provider: 'osrm' });
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
    expect(await loadTransmissionLog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'osrm', coordinateDisclosure: 'blocked', bytesOut: 0 }),
    ]));
  });

  it('still runs normally once the zone store is readable again', async () => {
    mocks.zoneStoreError = null;

    const result = await loadOsmSpeedLimitWays(ROUTE_POINTS, {
      privacy_zones: REDACTED_ZONES,
      speed_limit_lookup_enabled: true,
      request_obfuscation_enabled: false,
    });

    expect(result.skipped_reason).not.toBe('privacy_zones_unavailable');
    expect(mocks.pinnedFetch).toHaveBeenCalled();
  });
});
