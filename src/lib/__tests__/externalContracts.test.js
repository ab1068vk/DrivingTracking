import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRetryCircuits } from '@/lib/retry';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits } from '@/lib/speedLimitSource';
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

  it('calls Open-Meteo forecast with midpoint, day, timezone, and hourly fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: true,
      json: async () => ({
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
      status: 'fetched',
      condition: 'rain',
      sample_count: 1,
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

    const result = await mapMatchRoute(route, { osrm_map_matching_url: 'https://osrm.example' });

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
