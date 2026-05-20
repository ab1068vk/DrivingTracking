import { describe, expect, it } from 'vitest';
import { haversineDistance } from '@/lib/tripEngine';
import { maskEventsForPrivacy, maskRoutePointsForPrivacy, privacyBoundaryPoint, privacyZonesForRoute } from '@/lib/privacyZones';

const zone = { id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 100 };
const point = (lat, lng, seconds = 0, speedKmh = 30) => ({
  lat,
  lng,
  speed_kmh: speedKmh,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

describe('privacyZones', () => {
  it('interpolates the route crossing at the circle boundary', () => {
    const inside = point(43.65, -79.38, 0, 10);
    const outside = point(43.6522, -79.38, 20, 40);

    const boundary = privacyBoundaryPoint(inside, outside, zone);

    expect(boundary.lat).toBeGreaterThan(inside.lat);
    expect(boundary.lat).toBeLessThan(outside.lat);
    expect(boundary.privacy_boundary).toBe(true);
    expect(haversineDistance(boundary.lat, boundary.lng, zone.lat, zone.lng) * 1000).toBeCloseTo(100, 0);
    expect(new Date(boundary.timestamp).getTime()).toBeGreaterThan(new Date(inside.timestamp).getTime());
    expect(new Date(boundary.timestamp).getTime()).toBeLessThan(new Date(outside.timestamp).getTime());
  });

  it('clips start and end privacy zones without exposing interior points', () => {
    const route = [
      point(43.65, -79.38, 0),
      point(43.6522, -79.38, 20),
      point(43.6532, -79.38, 40),
      point(43.65, -79.38, 60),
    ];

    const masked = maskRoutePointsForPrivacy(route, { privacy_zones: [zone] });

    expect(masked).toHaveLength(4);
    expect(masked[0].privacy_boundary).toBe(true);
    expect(masked[1]).toBe(route[1]);
    expect(masked[2]).toBe(route[2]);
    expect(masked[3].privacy_boundary).toBe(true);
    expect(masked.some((item) => item.lat === null || item.lng === null)).toBe(false);
    expect(masked.some((item) => item.lat === zone.lat && item.lng === zone.lng)).toBe(false);
  });

  it('omits events inside privacy zones but keeps public events', () => {
    const events = [
      { type: 'speeding', lat: 43.65, lng: -79.38 },
      { type: 'sharp_turn', lat: 43.6532, lng: -79.38 },
    ];

    const masked = maskEventsForPrivacy(events, { privacy_zones: [zone] });

    expect(masked).toEqual([events[1]]);
  });

  it('returns only privacy zones touched by a route', () => {
    const work = { id: 'work', label: 'Work', lat: 43.72, lng: -79.42, radius_m: 100 };
    const route = [
      point(43.65, -79.38, 0),
      point(43.6522, -79.38, 20),
    ];

    expect(privacyZonesForRoute(route, { privacy_zones: [zone, work] })).toEqual([zone]);
  });

  it('returns privacy zones referenced by already-masked route metadata', () => {
    const route = [
      { lat: null, lng: null, privacy_zone_id: zone.id, masked_for_privacy: true },
      point(43.6522, -79.38, 20),
    ];

    expect(privacyZonesForRoute(route, { privacy_zones: [zone] })).toEqual([zone]);
  });
});
