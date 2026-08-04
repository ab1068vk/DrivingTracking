import { describe, expect, it } from 'vitest';
import { COMMUTE_MATCH_RADIUS_M, routeKeyForTrip } from '@/lib/commuteMatching';

const point = (lat, lng, extra = {}) => ({ lat, lng, ...extra });

// Roughly one cell-width apart at this latitude, used to build a trip whose
// start and end land in different cells.
const METERS_PER_DEG_LAT = 111320;
const degLatFor = (meters) => meters / METERS_PER_DEG_LAT;

describe('routeKeyForTrip', () => {
  it('reuses a stored route_key without touching route geometry', () => {
    expect(routeKeyForTrip({ route_key: 'stored|key', route_points: [] })).toBe('stored|key');
  });

  it('derives a start|end cell key from public points', () => {
    const key = routeKeyForTrip({
      route_points: [
        point(43.6532, -79.3832),
        point(43.6600, -79.3900),
        point(43.7000, -79.4200),
      ],
    });

    expect(key).toMatch(/^-?\d+,-?\d+\|-?\d+,-?\d+$/);
  });

  it('gives the same key to two trips that start and end in the same cells', () => {
    const a = routeKeyForTrip({ route_points: [point(43.6532, -79.3832), point(43.7000, -79.4200)] });
    const b = routeKeyForTrip({
      // Nudged well under the match radius, so both ends stay in the same cells.
      route_points: [point(43.65325, -79.38325), point(43.70005, -79.42005)],
    });

    expect(a).toBe(b);
  });

  it('gives different keys once the endpoints move far beyond the match radius', () => {
    const near = routeKeyForTrip({ route_points: [point(43.6532, -79.3832), point(43.7000, -79.4200)] });
    const far = routeKeyForTrip({
      route_points: [
        point(43.6532 + degLatFor(COMMUTE_MATCH_RADIUS_M * 10), -79.3832),
        point(43.7000, -79.4200),
      ],
    });

    expect(far).not.toBe(near);
  });

  it('ignores privacy-masked points when choosing the endpoints', () => {
    const maskedStart = routeKeyForTrip({
      route_points: [
        point(1.0, 1.0, { masked_for_privacy: true }),
        point(43.6532, -79.3832),
        point(43.7000, -79.4200),
      ],
    });
    const publicOnly = routeKeyForTrip({
      route_points: [point(43.6532, -79.3832), point(43.7000, -79.4200)],
    });

    expect(maskedStart).toBe(publicOnly);
  });

  it('ignores every privacy marker variant', () => {
    for (const marker of [
      { masked_for_privacy: true },
      { privacy_gap: true },
      { privacy_boundary: true },
      { privacy_live_redacted: true },
      { privacy_zone_id: 'home' },
    ]) {
      const key = routeKeyForTrip({
        route_points: [
          point(1.0, 1.0, marker),
          point(43.6532, -79.3832),
          point(43.7000, -79.4200),
          point(2.0, 2.0, marker),
        ],
      });
      expect(key, `marker ${JSON.stringify(marker)} leaked into the key`)
        .toBe(routeKeyForTrip({ route_points: [point(43.6532, -79.3832), point(43.7000, -79.4200)] }));
    }
  });

  it('returns null when fewer than two usable public points remain', () => {
    expect(routeKeyForTrip({ route_points: [] })).toBeNull();
    expect(routeKeyForTrip({ route_points: [point(43.6532, -79.3832)] })).toBeNull();
    expect(routeKeyForTrip({
      route_points: [point(43.6532, -79.3832), point(43.7, -79.4, { privacy_gap: true })],
    })).toBeNull();
    expect(routeKeyForTrip({})).toBeNull();
    expect(routeKeyForTrip()).toBeNull();
  });

  it('skips points with unusable coordinates', () => {
    const key = routeKeyForTrip({
      route_points: [
        point(null, null),
        point(Number.NaN, 5),
        point(43.6532, -79.3832),
        point(43.7000, -79.4200),
        point(undefined, undefined),
      ],
    });

    expect(key).toBe(routeKeyForTrip({ route_points: [point(43.6532, -79.3832), point(43.7000, -79.4200)] }));
  });

  it('keeps longitude cells stable near the poles instead of dividing by ~zero', () => {
    // cos(lat) collapses at high latitude; the module floors it at 0.2 so the
    // key stays finite rather than becoming "Infinity" or "NaN".
    const key = routeKeyForTrip({ route_points: [point(89.9, 10), point(89.9, 20)] });

    expect(key).not.toBeNull();
    expect(key).not.toMatch(/NaN|Infinity/);
  });
});
