import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestState = vi.hoisted(() => ({
  enqueueLocationRequest: vi.fn((_tag, fn) => fn()),
}));

vi.mock('@/lib/requestObfuscator', () => ({
  enqueueLocationRequest: requestState.enqueueLocationRequest,
}));

import { resetRetryCircuits } from '@/lib/retry';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits, loadOsmSpeedLimitWays } from '@/lib/speedLimitSource';
import { fetchWeatherContextForTrip } from '@/lib/weatherContext';

const route = [
  { lat: 43.6500, lng: -79.3800, accuracy: 8, speed_kmh: 45, timestamp: '2026-05-23T14:00:00.000Z' },
  { lat: 43.6504, lng: -79.3801, accuracy: 12, speed_kmh: 47, timestamp: '2026-05-23T14:05:00.000Z' },
  { lat: 43.6508, lng: -79.3802, accuracy: 9, speed_kmh: 44, timestamp: '2026-05-23T14:10:00.000Z' },
];

function stubStorage() {
  const values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
}

describe('external service contracts', () => {
  beforeEach(() => {
    stubStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T16:00:00.000Z'));
    requestState.enqueueLocationRequest.mockReset();
    requestState.enqueueLocationRequest.mockImplementation((_tag, fn) => fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetRetryCircuits();
  });

  it('calls Overpass with the expected speed-limit query envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => ({
      ok: true,
      json: async () => ({
        elements: [{
          id: 101,
          tags: { highway: 'residential', maxspeed: '40 mph', name: 'King Street' },
          geometry: [
            { lat: 43.6499, lon: -79.3801 },
            { lat: 43.6510, lon: -79.3803 },
          ],
        }],
      }),
    })));

    const result = await annotateRouteSpeedLimits(route, {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://overpass.example/api/interpreter');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(String(options.body)).toContain('%5Bout%3Ajson%5D');
    expect(String(options.body)).toContain('highway');
    expect(result.status).toBe('fetched');
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.routePoints[0]).toMatchObject({
      speed_limit_kmh: 64,
      speed_limit_source: 'openstreetmap',
      speed_limit_road_name: 'King Street',
    });
  });

  it('normalizes numeric-string route coordinates before checking OSM speed limits', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        elements: [{
          id: 111,
          tags: { highway: 'residential', maxspeed: '50', name: 'String Coordinate Street' },
          geometry: [
            { lat: 43.6499, lon: -79.3801 },
            { lat: 43.6510, lon: -79.3803 },
          ],
        }],
      }),
    })));
    const stringRoute = route.map((point) => ({
      ...point,
      lat: String(point.lat),
      lng: String(point.lng),
      accuracy: String(point.accuracy),
      speed_kmh: String(point.speed_kmh),
    }));

    const result = await annotateRouteSpeedLimits(stringRoute, {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('fetched');
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.routePoints[0]).toMatchObject({
      lat: '43.65',
      lng: '-79.38',
      speed_limit_kmh: 50,
      speed_limit_source: 'openstreetmap',
      speed_limit_road_name: 'String Coordinate Street',
    });
  });

  it('marks country-aware OSM highway defaults when maxspeed is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        elements: [{
          id: 202,
          tags: { highway: 'residential', name: 'Default Street' },
          geometry: [
            { lat: 43.6499, lon: -79.3801 },
            { lat: 43.6510, lon: -79.3803 },
          ],
        }],
      }),
    })));

    const result = await annotateRouteSpeedLimits(route, {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      configurable_country_defaults: 'gb',
    });

    expect(result.routePoints[0]).toMatchObject({
      speed_limit_kmh: 48,
      speed_limit_source: 'osm_highway_default',
      speed_limit_default_country: 'gb',
      fallback_country: 'gb',
    });
    expect(result.fallback_country).toBe('gb');
  });

  it('accepts the Android background queue Overpass response envelope', async () => {
    vi.stubGlobal('fetch', vi.fn());
    requestState.enqueueLocationRequest.mockResolvedValueOnce({
      elements: [{
        id: 303,
        tags: { highway: 'residential', maxspeed: '35 mph', name: 'Queued Street' },
        geometry: [
          { lat: 43.6499, lon: -79.3801 },
          { lat: 43.6510, lon: -79.3803 },
        ],
      }],
    });

    const result = await annotateRouteSpeedLimits(route, {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'fetched',
      coverage: expect.any(Number),
    });
    expect(result.routePoints[0]).toMatchObject({
      speed_limit_kmh: 56,
      speed_limit_source: 'openstreetmap',
      speed_limit_road_name: 'Queued Street',
    });
  });

  it('blocks Overpass bounding boxes that would overlap a privacy zone guard', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const boundaryPoint = { lat: 43, lng: -79.00123, privacy_boundary: true };
    const publicPoint = { lat: 43.005, lng: -79 };
    const result = await loadOsmSpeedLimitWays([boundaryPoint, publicPoint], {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 100 }],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ways: [],
      status: 'empty_route',
      source: 'openstreetmap_overpass',
      skipped_reason: 'privacy_bounds_overlap',
    });
  });

  it('allows Overpass bounding boxes that stay outside privacy zone guards', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ elements: [] }),
    })));

    const boundaryPoint = { lat: 43, lng: -79.00123, privacy_boundary: true };
    const publicPoint = { lat: 43.02, lng: -79 };
    await loadOsmSpeedLimitWays([boundaryPoint, publicPoint], {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 100 }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = fetch.mock.calls[0];
    const query = new URLSearchParams(String(options.body)).get('data');
    const [, rawBbox] = query.match(/\]\(([^)]+)\);/) || [];
    const [south, west, north, east] = rawBbox.split(',').map(Number);
    expect(south).toBeGreaterThan(43.01);
    expect(west).toBeCloseTo(-79.006, 6);
    expect(north).toBeCloseTo(43.026, 6);
    expect(east).toBeCloseTo(-78.994, 6);
  });

  it('skips Overpass when every route point is inside a privacy-zone guard', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await loadOsmSpeedLimitWays([
      { lat: 43, lng: -79, masked_for_privacy: true },
      { lat: 43, lng: -79.00123, privacy_boundary: true },
    ], {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 100 }],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ways: [],
      status: 'empty_route',
      source: 'openstreetmap_overpass',
      skipped_reason: 'all_points_private',
    });
  });

  it('returns an unchanged annotation result when masked route points have no safe bbox', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const maskedRoute = [
      { lat: null, lng: null, masked_for_privacy: true, privacy_zone_id: 'home' },
      { lat: null, lng: null, masked_for_privacy: true, privacy_zone_id: 'home' },
    ];

    const result = await annotateRouteSpeedLimits(maskedRoute, {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 100 }],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      routePoints: maskedRoute,
      coverage: 0,
      status: 'empty_route',
      skipped_reason: 'all_points_private',
    });
  });

  it('calls Open-Meteo forecast with midpoint, day, timezone, and hourly fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        utc_offset_seconds: -14400,
        hourly: {
          time: ['2026-05-23T10:00'],
          temperature_2m: [2],
          precipitation: [1.2],
          rain: [1.2],
          snowfall: [0],
          weather_code: [61],
          visibility: [9000],
        },
      }),
    })));

    const result = await fetchWeatherContextForTrip(route, route[0].timestamp, route.at(-1).timestamp, {});

    expect(fetch).toHaveBeenCalledTimes(1);
    const [rawUrl] = fetch.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe('https://api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('43.6504');
    expect(url.searchParams.get('longitude')).toBe('-79.3801');
    expect(url.searchParams.get('start_date')).toBe('2026-05-23');
    expect(url.searchParams.get('end_date')).toBe('2026-05-23');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('hourly')).toContain('weather_code');
    expect(result).toMatchObject({
      provider: 'open-meteo',
      source: 'open_meteo',
      status: 'fetched',
      condition: 'rain',
      sample_count: 1,
    });
  });

  it('uses a privacy-safe route point for Open-Meteo instead of a private midpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        utc_offset_seconds: -14400,
        hourly: {
          time: ['2026-05-23T10:00'],
          temperature_2m: [5],
          precipitation: [0],
          rain: [0],
          snowfall: [0],
          weather_code: [1],
          visibility: [10000],
        },
      }),
    })));

    const result = await fetchWeatherContextForTrip([
      { lat: 43, lng: -79, timestamp: '2026-05-23T14:00:00.000Z' },
      { lat: 43.0005, lng: -79, timestamp: '2026-05-23T14:05:00.000Z' },
      { lat: 43.01, lng: -79, timestamp: '2026-05-23T14:10:00.000Z' },
    ], '2026-05-23T14:00:00.000Z', '2026-05-23T14:10:00.000Z', {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 200 }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [rawUrl] = fetch.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.searchParams.get('latitude')).toBe('43.0100');
    expect(url.searchParams.get('longitude')).toBe('-79.0000');
    expect(result.status).toBe('fetched');
  });

  it('skips Open-Meteo when every weather candidate is inside a privacy zone buffer', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await fetchWeatherContextForTrip([
      { lat: 43, lng: -79, timestamp: '2026-05-23T14:00:00.000Z' },
      { lat: 43.0005, lng: -79, timestamp: '2026-05-23T14:05:00.000Z' },
    ], '2026-05-23T14:00:00.000Z', '2026-05-23T14:05:00.000Z', {
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 200 }],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: 'open-meteo',
      source: 'unavailable',
      status: 'skipped_privacy',
      riskLevel: null,
      riskScore: null,
      weather_context: null,
      weather_skipped_reason: 'all_points_within_privacy_zones',
    });
  });

  it('calls OSRM match with ordered lon-lat coordinates and per-point radiuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
        matchings: [{
          confidence: 0.87,
          geometry: {
            coordinates: [
              [-79.3800, 43.6500],
              [-79.3801, 43.6504],
              [-79.3802, 43.6508],
            ],
          },
        }],
      }),
    })));

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [rawUrl] = fetch.mock.calls[0];
    const url = new URL(String(rawUrl));
    expect(url.origin).toBe('https://osrm.example');
    expect(url.pathname).toBe('/match/v1/driving/-79.38,43.65;-79.3801,43.6504;-79.3802,43.6508');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('radiuses')).toBe('10;12;10');
    expect(result).toMatchObject({
      provider: 'osrm',
      status: 'matched',
      confidence: 0.87,
      snapped_coverage: 100,
    });
  });
});
