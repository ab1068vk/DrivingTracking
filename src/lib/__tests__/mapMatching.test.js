import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapMatchRoute } from '@/lib/mapMatching';

const point = (index) => ({
  lat: 43.65 + index * 0.001,
  lng: -79.38,
  accuracy: 8,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 10)).toISOString(),
});

describe('mapMatching', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps GPS coordinates as the canonical route and stores snapped coordinates separately', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        matchings: [{
          confidence: 0.9,
          geometry: {
            coordinates: [
              [-79.381, 43.651],
              [-79.382, 43.652],
              [-79.383, 43.653],
            ],
          },
        }],
      }),
    })));

    const route = [point(20), point(21), point(22)];
    const result = await mapMatchRoute(route, { osrm_map_matching_url: 'https://example.test' });

    expect(result.status).toBe('matched');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.snapped_coverage).toBe('number');
    expect(result.routePoints[0].lat).toBe(route[0].lat);
    expect(result.routePoints[0].lng).toBe(route[0].lng);
    expect(result.routePoints[0].matched_lat).toBeCloseTo(43.651, 3);
    expect(result.routePoints[0].matched_lng).toBeCloseTo(-79.381, 3);
    expect(result.routePoints[0].original_lat).toBe(route[0].lat);
    expect(result.routePoints[0].original_lng).toBe(route[0].lng);
  });
});
