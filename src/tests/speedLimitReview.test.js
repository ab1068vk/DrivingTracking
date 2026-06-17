import { describe, expect, it } from 'vitest';

import {
  buildTripSpeedLimitReviewCells,
  speedLimitReviewNeededForTrip,
} from '@/lib/speedLimitReview';

const point = (patch = {}) => ({
  lat: 43.65,
  lng: -79.38,
  speed_kmh: 42,
  timestamp: '2026-01-01T12:00:00Z',
  ...patch,
});

describe('speed-limit parked review', () => {
  it('does not require review for posted OSM maxspeed cells', () => {
    const trip = {
      route_points: [
        point({ speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' }),
      ],
    };

    expect(speedLimitReviewNeededForTrip(trip)).toBe(false);
    expect(buildTripSpeedLimitReviewCells(trip)).toHaveLength(0);
  });

  it('queues estimated trip cells for parked review', () => {
    const trip = {
      route_points: [
        point({ speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' }),
        point({ lat: 43.6501, speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' }),
      ],
    };

    const cells = buildTripSpeedLimitReviewCells(trip);
    expect(speedLimitReviewNeededForTrip(trip)).toBe(true);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      lat: 43.65,
      lng: -79.38,
      coordinateSource: 'driven_route_sample',
      limitKmh: 50,
      tripReview: true,
      source: 'region_default_estimate',
      limits: [50],
      sources: ['region_default_estimate'],
    });
  });

  it('can return every reviewable cell for a full trip review', () => {
    const trip = {
      route_points: Array.from({ length: 12 }, (_, index) => point({
        lat: 43.65 + index * 0.01,
        lng: -79.38,
        speed_limit_kmh: 50,
        speed_limit_source: 'region_default_estimate',
      })),
    };

    expect(buildTripSpeedLimitReviewCells(trip)).toHaveLength(8);
    expect(buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity })).toHaveLength(12);
  });

  it('queues native background trips even when route points have no speed-limit fields', () => {
    const trip = {
      start_source: 'native_auto',
      speed_limit_review_required: true,
      route_points: [
        point(),
        point({ lat: 43.6501 }),
      ],
    };

    const cells = buildTripSpeedLimitReviewCells(trip);
    expect(cells).toHaveLength(1);
    expect(cells[0].source).toBe('missing_posted_review');
    expect(cells[0].reviewReason).toContain('Background tracking cannot confirm posted signs');
  });

  it('recognizes summary records flagged for speed-limit review', () => {
    expect(speedLimitReviewNeededForTrip({
      id: 'summary-native',
      speed_limit_review_required: true,
    })).toBe(true);
  });
});
