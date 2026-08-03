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
import { buildWeatherOnlyTripContextPatch } from '@/lib/openSourceTripContext';
import {
  fetchWeatherContextForTrip,
  resolveCachedWeatherContextForTrip,
} from '@/lib/weatherContext';
import { loadTransmissionLog } from '@/lib/transmissionLog';

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
    // Checklist: "Trigger Open-Meteo and Overpass lookups and confirm retained records are protected or unverified accurately."
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'overpass',
      coordinateDisclosure: 'bounding_box',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:overpass',
      privacyVerificationEvidence: expect.arrayContaining([
        'privacy gateway verified overpass payload precision <= 6 decimals',
        'request body contains only the computed bounding box',
        'query does not request individual node coordinates',
      ]),
      sentCoords: 'Bounding box',
      status: 'safe',
    });
    expect(entry.bytesOut).toBe(String(url).length + String(options.body).length);
    expect(entry.privacyVerificationWarnings).toEqual([]);
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

  it('ignores unsafe custom Overpass endpoints and falls back to HTTPS providers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ elements: [] }),
    })));

    await annotateRouteSpeedLimits(route, {
      overpass_speed_limit_url: 'http://overpass.example/api/interpreter',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url] = fetch.mock.calls[0];
    expect(url).toBe('https://overpass-api.de/api/interpreter');
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'overpass',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:overpass',
      privacyVerificationEvidence: ['computed road-data bounding boxes overlapped a privacy-zone guard'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('fetches only safe public Overpass chunks when a trip also has privacy-adjacent points', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        elements: [{
          id: 202,
          tags: { highway: 'residential', maxspeed: '50', name: 'Public Road' },
          geometry: [
            { lat: 43.019, lon: -79.0002 },
            { lat: 43.021, lon: -79.0002 },
          ],
        }],
      }),
    })));

    const boundaryPoint = { lat: 43, lng: -79.00123, privacy_boundary: true };
    const privacyAdjacentPoint = { lat: 43.005, lng: -79 };
    const safePublicPoint = { lat: 43.02, lng: -79 };
    const result = await loadOsmSpeedLimitWays([boundaryPoint, privacyAdjacentPoint, safePublicPoint], {
      overpass_speed_limit_url: 'https://overpass.example/api/interpreter',
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43, lng: -79, radius_m: 100 }],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'partial_fetched',
      source: 'openstreetmap_overpass',
    });
    expect(result.ways).toHaveLength(1);

    const [, options] = fetch.mock.calls[0];
    const query = new URLSearchParams(String(options.body)).get('data');
    const [, rawBbox] = query.match(/\]\(([^)]+)\);/) || [];
    const [south, west, north, east] = rawBbox.split(',').map(Number);
    expect(south).toBeGreaterThan(43.01);
    expect(north).toBeLessThan(43.03);
    expect(west).toBeGreaterThan(-79.01);
    expect(east).toBeLessThan(-78.99);
    expect(query).not.toContain('Home');
    expect(query).not.toContain('43,-79');
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'overpass',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:overpass',
      privacyVerificationEvidence: ['privacy filtering left no public road-data points'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
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
    // Checklist: "Trigger Open-Meteo and Overpass lookups and confirm retained records are protected or unverified accurately."
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

    const result = await fetchWeatherContextForTrip(route, route[0].timestamp, route.at(-1).timestamp, {
      privacy_zones: [],
    });

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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
      privacyVerificationEvidence: [
        'privacy gateway verified open-meteo payload precision <= 4 decimals',
        'no privacy zones were configured for this weather lookup',
        'coordinate is rounded to 4 decimals',
      ],
      sentCoords: '43.6504, -79.3801',
      bytesOut: url.toString().length,
      status: 'safe',
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
    expect(result).toMatchObject({
      provider: 'open-meteo',
      source: 'open_meteo',
      status: 'fetched',
      condition: 'rain',
      sample_count: 1,
    });
  });

  it('reuses fresh on-device weather without another network disclosure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        utc_offset_seconds: -14400,
        hourly: {
          time: ['2026-05-23T10:00'],
          temperature_2m: [12],
          precipitation: [0.3],
          precipitation_probability: [75],
          rain: [0.3],
          snowfall: [0],
          weather_code: [61],
          visibility: [7000],
          wind_speed_10m: [22],
          wind_gusts_10m: [40],
          freezing_level_height: [1800],
        },
      }),
    })));

    await fetchWeatherContextForTrip(route, route[0].timestamp, route.at(-1).timestamp, {
      privacy_zones: [],
    });
    fetch.mockClear();

    const cached = await resolveCachedWeatherContextForTrip(
      route,
      route[0].timestamp,
      route.at(-1).timestamp,
      { privacy_zones: [] }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(cached).toMatchObject({
      source: 'open_meteo',
      status: 'cache_hit_local',
      network_used: false,
      precipitation_probability_pct: 75,
    });
  });

  it('keeps weather-only refresh isolated from OSM and OSRM', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        utc_offset_seconds: -14400,
        hourly: {
          time: ['2026-05-23T10:00'],
          temperature_2m: [12],
          precipitation: [0],
          precipitation_probability: [0],
          rain: [0],
          snowfall: [0],
          weather_code: [1],
          visibility: [10000],
          wind_speed_10m: [10],
          wind_gusts_10m: [15],
          freezing_level_height: [2500],
        },
      }),
    })));

    const patch = await buildWeatherOnlyTripContextPatch({
      id: 'weather-only-trip',
      start_time: route[0].timestamp,
      end_time: route.at(-1).timestamp,
      route_points: route,
      driving_events: [],
    }, {
      heightened_privacy_mode: false,
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
      privacy_zones: [],
    }, {
      immediateRequests: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const requestedOrigins = fetch.mock.calls.map(([url]) => new URL(String(url)).origin);
    expect(requestedOrigins).toEqual(['https://api.open-meteo.com']);
    expect(patch.weather_context).toMatchObject({
      source: 'open_meteo',
      status: 'fetched',
    });
    expect(patch.speed_limit_context).toBeUndefined();
    expect(patch.map_matching_context).toBeUndefined();
  });

  it('ends a manual weather lookup with a useful timeout instead of hanging forever', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const lookup = buildWeatherOnlyTripContextPatch({
      id: 'weather-timeout-trip',
      start_time: route[0].timestamp,
      end_time: route.at(-1).timestamp,
      route_points: route,
      driving_events: [],
    }, {
      heightened_privacy_mode: false,
      weather_context_enabled: true,
      privacy_zones: [],
    }, {
      immediateRequests: true,
    });
    const timeoutExpectation = expect(lookup).rejects.toThrow(
      'Weather lookup timed out. Check your connection and try again.'
    );

    await vi.advanceTimersByTimeAsync(20001);

    await timeoutExpectation;
  });

  it('blocks weather-only refresh completely in heightened privacy mode', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const patch = await buildWeatherOnlyTripContextPatch({
      id: 'private-weather-trip',
      start_time: route[0].timestamp,
      end_time: route.at(-1).timestamp,
      route_points: route,
      driving_events: [],
    }, {
      heightened_privacy_mode: true,
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
    }, {
      immediateRequests: true,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(patch.weather_context).toMatchObject({
      source: 'unavailable',
      status: 'disabled_heightened_privacy',
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'rounded',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
      privacyVerificationEvidence: [
        'privacy gateway verified open-meteo payload precision <= 4 decimals',
        'selected point is outside privacy-zone weather buffer',
        'coordinate is rounded to 4 decimals',
      ],
      sentCoords: '43.0100, -79.0000',
      zonesSuppressed: ['Home'],
      bytesOut: url.toString().length,
      status: 'safe',
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'open-meteo',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:open-meteo',
      privacyVerificationEvidence: ['all weather candidates were inside privacy-zone buffers'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
      zonesSuppressed: ['Home'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('blocks a point when four-decimal rounding would move it into the privacy guard', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const point = {
      lat: 43.00094,
      lng: -79,
      timestamp: '2026-05-23T14:00:00.000Z',
    };

    const result = await fetchWeatherContextForTrip(
      [point],
      point.timestamp,
      point.timestamp,
      {
        heightened_privacy_mode: false,
        privacy_zones: [{
          id: 'rounding-edge',
          label: 'Rounding edge',
          lat: 43,
          lng: -79,
          radius_m: 3,
        }],
      }
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'skipped_privacy',
      weather_skipped_reason: 'all_points_within_privacy_zones',
    });
  });

  it('calls OSRM match with ordered lon-lat coordinates and per-point radiuses', async () => {
    // Checklist: "Configure OSRM endpoint and consent, then confirm raw sharing is labeled raw with consent."
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
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'osrm',
      coordinateDisclosure: 'raw',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:osrm',
      privacyVerificationEvidence: [
        'privacy gateway found coordinate data and logged raw disclosure',
        'route was split at privacy/null gaps before sampling',
        'OSRM raw-coordinate sharing consent was checked before this request',
        'privacy-zone endpoint guard ran before this request',
      ],
      sentCoords: '3 sampled coordinates',
      bytesOut: url.toString().length,
      status: 'warning',
    });
    expect(entry.privacyVerificationWarnings).toEqual([
      'Raw coordinates left the app; consent or guards do not make this a protected send.',
    ]);
    expect(result).toMatchObject({
      provider: 'osrm',
      status: 'matched',
      confidence: 0.87,
      snapped_coverage: 100,
    });
  });

  it('logs OSRM endpoint privacy blocks with the guard evidence that caused the block', async () => {
    // Checklist: "Try a route endpoint inside a zone and confirm OSRM is blocked and logged as blocked."
    vi.stubGlobal('fetch', vi.fn());

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 120 }],
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked_private_endpoint');
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'osrm',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:osrm',
      privacyVerificationEvidence: ['route endpoint was inside the privacy-zone guard buffer'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
      zonesSuppressed: ['Home'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });

  it('logs OSRM blocks when privacy gaps leave no matchable public segment', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await mapMatchRoute([
      { lat: 43.7, lng: -79.4, accuracy: 8 },
      { lat: null, lng: null, masked_for_privacy: true, privacy_gap: true, privacy_zone_label: 'Home' },
      { lat: 43.8, lng: -79.5, accuracy: 8 },
    ], {
      osrm_map_matching_url: 'https://osrm.example',
      osrm_data_sharing_consented: true,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe('not_enough_points');
    const [entry] = await loadTransmissionLog();
    expect(entry).toMatchObject({
      service: 'osrm',
      coordinateDisclosure: 'blocked',
      privacyTransformVerified: true,
      privacyTransformSource: 'privacyGatedFetch:osrm',
      privacyVerificationEvidence: ['privacy filtering left no matchable public route segment'],
      sentCoords: null,
      bytesOut: 0,
      status: 'blocked',
      zonesSuppressed: ['Home'],
    });
    expect(entry.privacyVerificationWarnings).toEqual([]);
  });
});
