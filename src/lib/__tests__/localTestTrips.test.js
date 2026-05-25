import { describe, expect, it } from 'vitest';
import { buildLocalFeatureTestTrips, LOCAL_TEST_TRIP_PREFIX } from '@/lib/localTestTrips';

describe('local feature test trips', () => {
  it('builds stable, removable completed trip fixtures with route evidence', () => {
    const trips = buildLocalFeatureTestTrips(new Date(2026, 4, 24, 12));

    expect(trips).toHaveLength(12);
    expect(new Set(trips.map((trip) => trip.id)).size).toBe(12);
    expect(trips.every((trip) => trip.id.startsWith(LOCAL_TEST_TRIP_PREFIX))).toBe(true);
    expect(trips.every((trip) => trip.status === 'completed' && trip.test_fixture === true)).toBe(true);
    expect(trips.every((trip) => trip.route_points.length >= 30 && trip.needs_rescore === true)).toBe(true);
  });
});
