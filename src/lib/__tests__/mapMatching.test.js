import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mapMatchRoute } from '@/lib/mapMatching';

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async () => ({})),
  setJson: vi.fn(async () => undefined),
}));

const point = (index) => ({
  lat: 43.65 + index * 0.001,
  lng: -79.38,
  accuracy: 12,
  speed_kmh: 35,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 10)).toISOString(),
});

describe('mapMatching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses OSRM geometry, tracepoint quality, and step names when matching routes', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        tracepoints: [
          { location: [-79.38, 43.65] },
          { location: [-79.38, 43.651] },
          { location: [-79.38, 43.652] },
        ],
        matchings: [{
          confidence: 0.87,
          geometry: {
            coordinates: [
              [-79.38, 43.65],
              [-79.38, 43.651],
              [-79.38, 43.652],
            ],
          },
          legs: [{
            steps: [{
              name: 'King Street',
              ref: 'A1',
              distance: 220,
              duration: 18,
              geometry: {
                coordinates: [
                  [-79.38, 43.65],
                  [-79.38, 43.652],
                ],
              },
            }],
          }],
        }],
      }),
    }));

    const result = await mapMatchRoute([point(0), point(1), point(2)]);

    expect(result.status).toBe('matched');
    expect(result.snapped_coverage).toBe(100);
    expect(result.route_geometry).toHaveLength(3);
    expect(result.routePoints[1].map_matched).toBe(true);
    expect(result.routePoints[1].map_match_quality).toBe('high');
    expect(result.routePoints[1].matched_road_name).toBe('King Street');
  });
});
