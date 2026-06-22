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
    vi.restoreAllMocks();
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
    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });

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

  it('falls back to snapped coverage when OSRM confidence is non-finite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        matchings: [{
          confidence: Number.POSITIVE_INFINITY,
          geometry: {
            coordinates: [
              [-79.401, 43.701],
              [-79.402, 43.702],
              [-79.403, 43.703],
            ],
          },
        }],
      }),
    })));

    const route = [point(70), point(71), point(72)];
    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });

    expect(result.status).toBe('matched');
    expect(result.confidence).toBe(1);
    expect(Number.isFinite(result.confidence)).toBe(true);
  });

  it('does not send route points without OSRM data-sharing consent', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await mapMatchRoute([point(0), point(1), point(2)], {
      osrm_map_matching_url: 'https://example.test',
    });

    expect(result.status).toBe('needs_consent');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks OSRM when a route segment touches a high-sensitivity zone even without global consent', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const route = [
      { lat: 43.65, lng: -79.385, accuracy: 8 },
      { lat: 43.65, lng: -79.375, accuracy: 8 },
    ];

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: false,
      privacy_zones: [{
        id: 'high-zone',
        label: 'High sensitivity',
        lat: 43.65,
        lng: -79.38,
        radius_m: 100,
        sensitivity: 'high',
      }],
    });

    expect(result.status).toBe('blocked_high_sensitivity_zone');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables OSRM entirely when heightened privacy mode is active', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await mapMatchRoute([point(0), point(1), point(2)], {
      heightened_privacy_mode: true,
      map_matching_enabled: true,
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });

    expect(result.status).toBe('disabled_heightened_privacy');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the user-configured OSRM timeout when matching routes', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        matchings: [{
          confidence: 0.9,
          geometry: {
            coordinates: [
              [-79.38, 44.55],
              [-79.38, 44.551],
              [-79.38, 44.552],
            ],
          },
        }],
      }),
    })));

    const result = await mapMatchRoute([point(900), point(901), point(902)], {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
      osrm_timeout_ms: 7000,
    });

    expect(result.status).toBe('matched');
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7000);
  });

  it('blocks route matches that use the public OSRM demo endpoint', async () => {
    // Checklist: "Confirm Settings rejects or blocks public OSRM demo use for saved settings."
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        matchings: [{
          confidence: 0.8,
          geometry: {
            coordinates: [
              [-79.38, 43.65],
              [-79.38, 43.651],
              [-79.38, 43.652],
            ],
          },
        }],
      }),
    })));

    const result = await mapMatchRoute([point(0), point(1), point(2)], {
      osrm_map_matching_url: 'https://router.project-osrm.org',
      osrm_data_sharing_consented: true,
    });

    expect(result).toMatchObject({
      status: 'public_demo_blocked',
      isOsrmDemoUrl: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the privacy-zone endpoint guard on even if a legacy setting disables it', async () => {
    // Checklist: "Try a route endpoint inside a zone and confirm OSRM is blocked and logged as blocked."
    vi.stubGlobal('fetch', vi.fn());

    const result = await mapMatchRoute([point(0), point(3), point(4)], {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
      osrm_block_near_any_zone: false,
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 150 }],
    });

    expect(result.status).toBe('blocked_private_endpoint');
    expect(result.routePoints[0]).toMatchObject({
      lat: null,
      lng: null,
      privacy_gap: true,
      privacy_zone_id: 'home',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('splits raw OSRM input around privacy zones even if a legacy setting disables the guard', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = new URL(String(url)).pathname;
      const coords = decodeURIComponent(path.split('/').pop() || '')
        .split(';')
        .map((pair) => pair.split(',').map(Number));
      return {
        ok: true,
        json: async () => ({
          matchings: [{
            confidence: 0.9,
            geometry: { coordinates: coords },
          }],
        }),
      };
    }));

    const route = [
      { lat: 43.646, lng: -79.38, accuracy: 8 },
      { lat: 43.647, lng: -79.38, accuracy: 8 },
      { lat: 43.65, lng: -79.38, accuracy: 8 },
      { lat: 43.653, lng: -79.38, accuracy: 8 },
      { lat: 43.654, lng: -79.38, accuracy: 8 },
    ];

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
      osrm_block_near_any_zone: false,
      privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 80 }],
    });

    expect(result).toMatchObject({
      status: 'matched',
      segment_count: 2,
      privacy_gap_count: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const requestedCoords = fetch.mock.calls.flatMap(([url]) => (
      decodeURIComponent(new URL(String(url)).pathname)
        .split('/')
        .pop()
        .split(';')
        .map((pair) => pair.split(',').map(Number))
    ));
    expect(requestedCoords).not.toContainEqual([-79.38, 43.65]);
    expect(result.routePoints.find((item) => item.privacy_gap)).toMatchObject({
      lat: null,
      lng: null,
      privacy_zone_id: 'home',
    });
  });

  it('splits OSRM requests at privacy gaps instead of sending teleporting waypoints', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = new URL(String(url)).pathname;
      const coords = decodeURIComponent(path.split('/').pop() || '')
        .split(';')
        .map((pair) => pair.split(',').map(Number));
      return {
        ok: true,
        json: async () => ({
          matchings: [{
            confidence: 0.9,
            geometry: {
              coordinates: coords,
            },
          }],
        }),
      };
    }));

    const route = [
      point(100),
      point(101),
      point(102),
      { lat: null, lng: null, masked_for_privacy: true, privacy_zone_id: 'home' },
      point(400),
      point(401),
      point(402),
    ];

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const requestedCoords = fetch.mock.calls.map(([url]) => (
      decodeURIComponent(new URL(String(url)).pathname)
        .split('/')
        .pop()
        .split(';')
        .map((pair) => pair.split(',').map(Number))
    ));
    expect(requestedCoords[0]).toHaveLength(3);
    expect(requestedCoords[1]).toHaveLength(3);
    expect(requestedCoords[0][0]).toEqual([-79.38, 43.75]);
    expect(requestedCoords[0][2][1]).toBeCloseTo(43.752);
    expect(requestedCoords[0].some((coord) => coord[1] > 44)).toBe(false);
    expect(requestedCoords[1][0]).toEqual([-79.38, 44.05]);
    expect(requestedCoords[1][2][1]).toBeCloseTo(44.052);
    expect(result).toMatchObject({
      status: 'matched',
      segment_count: 2,
      privacy_gap_count: 1,
      snapped_coverage: 100,
    });
    expect(result.routePoints).toHaveLength(7);
    expect(result.routePoints[3]).toMatchObject({
      lat: null,
      lng: null,
      privacy_gap: true,
      masked_for_privacy: true,
      privacy_zone_id: 'home',
    });
    expect(result.routePoints[0].map_matched).toBe(true);
    expect(result.routePoints[4].map_matched).toBe(true);
  });

  it('treats privacy boundary coordinates as gaps before OSRM requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = new URL(String(url)).pathname;
      const coords = decodeURIComponent(path.split('/').pop() || '')
        .split(';')
        .map((pair) => pair.split(',').map(Number));
      return {
        ok: true,
        json: async () => ({
          matchings: [{
            confidence: 0.9,
            geometry: {
              coordinates: coords,
            },
          }],
        }),
      };
    }));

    const boundary = {
      lat: 43.653,
      lng: -79.38,
      masked_for_privacy: true,
      privacy_boundary: true,
      privacy_zone_id: 'home',
    };
    const route = [
      point(510),
      point(511),
      boundary,
      point(700),
      point(701),
    ];

    const result = await mapMatchRoute(route, {
      osrm_map_matching_url: 'https://example.test',
      osrm_data_sharing_consented: true,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const requestedCoords = fetch.mock.calls.flatMap(([url]) => (
      decodeURIComponent(new URL(String(url)).pathname)
        .split('/')
        .pop()
        .split(';')
        .map((pair) => pair.split(',').map(Number))
    ));
    expect(requestedCoords).not.toContainEqual([boundary.lng, boundary.lat]);
    expect(result.routePoints.find((item) => item.privacy_gap)).toMatchObject({
      lat: null,
      lng: null,
      privacy_gap: true,
      privacy_zone_id: 'home',
    });
  });
});
