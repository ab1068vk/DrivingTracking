import { describe, expect, it } from 'vitest';
import {
  buildHistoricalPrivacyExposure,
  buildTripPrivacyPreview,
} from '@/lib/privacyTripRemediation';

const zone = {
  id: 'home',
  label: 'Home',
  lat: 43.65,
  lng: -79.38,
  radius_m: 150,
};

const point = (lat, lng, extra = {}) => ({
  lat,
  lng,
  timestamp: '2026-07-13T12:00:00.000Z',
  ...extra,
});

describe('privacy trip remediation preview', () => {
  it('builds a coordinate-free before/after preview of raw, protected, and retained records', () => {
    const preview = buildTripPrivacyPreview({
      id: 'trip-1',
      start_time: '2026-07-13T12:00:00.000Z',
      start_address: 'Private home address',
      route_points: [
        point(43.65, -79.38),
        point(null, null, { masked_for_privacy: true, privacy_zone_id: 'home' }),
        point(43.72, -79.42),
      ],
      driving_events: [
        point(43.6502, -79.38, { type: 'hard_brake' }),
        point(43.72, -79.42, { type: 'sharp_turn' }),
      ],
    }, [zone]);

    expect(preview).toMatchObject({
      id: 'trip-1',
      affected: true,
      exposureCount: 2,
      before: {
        exposedPoints: 1,
        exposedEvents: 1,
        protectedPoints: 1,
        retainedPoints: 1,
        startStatus: 'exposed',
      },
      after: {
        exposedPoints: 0,
        exposedEvents: 0,
        newlyProtectedPoints: 1,
        newlyProtectedEvents: 1,
        protectedPoints: 2,
        startStatus: 'protected',
      },
    });
    expect(preview.before.segments).toEqual(['exposed', 'protected', 'retained']);
    expect(preview.after.segments).toEqual(['protected', 'protected', 'retained']);
    expect(preview).not.toHaveProperty('route_points');
    expect(JSON.stringify(preview)).not.toContain('43.65');
    expect(JSON.stringify(preview)).not.toContain('Private home address');
  });

  it('summarizes all historical exposure and prioritizes affected trips', () => {
    const result = buildHistoricalPrivacyExposure([{
      id: 'safe-newer',
      start_time: '2026-07-13T14:00:00.000Z',
      route_points: [point(43.72, -79.42)],
      driving_events: [],
    }, {
      id: 'exposed-older',
      start_time: '2026-07-12T14:00:00.000Z',
      route_points: [point(43.65, -79.38)],
      driving_events: [point(43.65, -79.38)],
    }], [zone]);

    expect(result.summary).toMatchObject({
      scannedTripCount: 2,
      affectedTripCount: 1,
      exposedPointCount: 1,
      exposedEventCount: 1,
    });
    expect(result.previews.map((preview) => preview.id)).toEqual(['exposed-older', 'safe-newer']);
  });

  it('bounds long visual previews without changing exposure totals', () => {
    const routePoints = Array.from({ length: 500 }, (_, index) => (
      index === 250 ? point(43.65, -79.38) : point(43.72, -79.42)
    ));
    const preview = buildTripPrivacyPreview({
      id: 'long-trip',
      route_points: routePoints,
      driving_events: [],
    }, [zone]);

    expect(preview.before.exposedPoints).toBe(1);
    expect(preview.before.segments.length).toBeLessThanOrEqual(64);
    expect(preview.before.segments).toContain('exposed');
  });
});
