import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pinnedFetch: vi.fn(),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
  appendPrivacyEvent: vi.fn(async () => ({})),
  store: new Map(),
}));

vi.mock('@/lib/pinnedFetch', () => ({ pinnedFetch: mocks.pinnedFetch }));

vi.mock('@/lib/hashChainLog', () => ({ appendPrivacyEvent: mocks.appendPrivacyEvent }));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logSystemFailure,
  recordSystemEvent: mocks.recordSystemEvent,
  logError: mocks.logSystemFailure,
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  getEncryptedJson: vi.fn(async (key, fallback) => (
    mocks.store.has(key) ? structuredClone(mocks.store.get(key)) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => {
    mocks.store.set(key, structuredClone(value));
  }),
  removeEncryptedJson: vi.fn(async (key) => {
    mocks.store.delete(key);
  }),
  encryptSensitiveValue: vi.fn(async (value) => value),
}));

import { loadOsmSpeedLimitWays } from '@/lib/speedLimitSource';
import { mapMatchRoute } from '@/lib/mapMatching';
import { localSettings } from '@/lib/trackingStore';

const ZONE = Object.freeze({
  id: 'home',
  label: 'Home',
  type: 'circle',
  lat: 43.65,
  lng: -79.38,
  radius_m: 100,
});

const METER_DEG = 1 / 111320;
const at = (offsetM) => ({
  lat: 43.65 + offsetM * METER_DEG,
  lng: -79.38,
  speed_kmh: 40,
  accuracy: 8,
  timestamp: new Date(Date.UTC(2026, 4, 22, 10, 0, Math.round(Math.abs(offsetM) / 10))).toISOString(),
});

// 160 m north of the center sits 60 m outside the 100 m radius: public ground,
// but inside the 100 m OSRM buffer, so it still pins the zone.
const JUST_OUTSIDE_M = 160;
const ROUTE = [at(-1200), at(-600), at(JUST_OUTSIDE_M), at(1200), at(1800)];

const BASE_SETTINGS = Object.freeze({
  privacy_zones: [ZONE],
  request_obfuscation_enabled: false,
  heightened_privacy_mode: false,
});

const overpassBoxes = () => mocks.pinnedFetch.mock.calls.map(([, init]) => {
  const body = decodeURIComponent(String(init?.body ?? '').replace(/\+/g, ' '));
  const [, south, west, north, east] = body.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/) || [];
  return { south, west, north, east };
});

describe('road-data geometry keeps its distance from privacy zones', () => {
  beforeEach(() => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    mocks.store = new Map();
    mocks.pinnedFetch.mockReset();
    localSettings.set({
      ...localSettings.get(),
      heightened_privacy_mode: false,
      request_obfuscation_enabled: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops interior OSRM points that sit inside the zone buffer, not just the endpoints', async () => {
    mocks.pinnedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matchings: [] }),
    });

    const result = await mapMatchRoute(ROUTE, {
      ...BASE_SETTINGS,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example.test',
      osrm_data_sharing_consented: true,
    });

    const buffered = ROUTE[2];
    const sent = mocks.pinnedFetch.mock.calls.map(([request]) => String(request?.url ?? request)).join(' ');
    expect(sent).not.toContain(buffered.lat.toFixed(5));
    expect(result.routePoints.some((point) => point?.privacy_gap === true && point?.lat === null)).toBe(true);
    expect(result.routePoints.some((point) => point?.lat === buffered.lat)).toBe(false);
  });

  it('sends Overpass boxes snapped to the shared grid rather than to the route', async () => {
    mocks.pinnedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ elements: [] }),
    });

    await loadOsmSpeedLimitWays(ROUTE, { ...BASE_SETTINGS, speed_limit_lookup_enabled: true });

    const boxes = overpassBoxes();
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      for (const edge of Object.values(box)) {
        // 3 decimals is the declared limit in privacyGatedFetch; landing on a
        // multiple of the grid is what makes the box independent of the route.
        expect(edge).toMatch(/^-?\d+\.\d{3}$/);
        expect(Math.abs((Number(edge) / 0.005) - Math.round(Number(edge) / 0.005))).toBeLessThan(1e-6);
      }
      const containsZone = Number(box.south) <= ZONE.lat && ZONE.lat <= Number(box.north) &&
        Number(box.west) <= ZONE.lng && ZONE.lng <= Number(box.east);
      expect(containsZone).toBe(false);
    }
  });

  it('emits the same grid box for two routes that differ only below the grid', async () => {
    mocks.pinnedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ elements: [] }),
    });

    const settings = { request_obfuscation_enabled: false, speed_limit_lookup_enabled: true, privacy_zones: [] };
    await loadOsmSpeedLimitWays([at(-1200), at(-600)], settings);
    const first = overpassBoxes();
    mocks.pinnedFetch.mockClear();
    // Drop the cached response so the second route has to build its own box.
    mocks.store = new Map();
    await loadOsmSpeedLimitWays([at(-1190), at(-610)], settings);

    expect(overpassBoxes()).toEqual(first);
  });
});
