import { describe, expect, it } from 'vitest';
import { buildDashboardActivityStats } from '@/lib/dashboardStats';

const makeTrip = (start, distanceKm, durationSeconds) => ({
  status: 'completed',
  start_time: start,
  end_time: new Date(new Date(start).getTime() + durationSeconds * 1000).toISOString(),
  distance_km: distanceKm,
  duration_seconds: durationSeconds,
});

describe('buildDashboardActivityStats', () => {
  it('summarizes recent mobility without old or incomplete trips', () => {
    const now = new Date('2026-07-15T18:00:00');
    const stats = buildDashboardActivityStats([
      makeTrip('2026-07-15T08:00:00', 12, 1200),
      makeTrip('2026-07-14T09:00:00', 8, 900),
      makeTrip('2026-07-14T17:00:00', 10, 1100),
      makeTrip('2026-07-01T09:00:00', 100, 7200),
      { ...makeTrip('2026-07-15T12:00:00', 50, 3600), status: 'active' },
    ], { now });

    expect(stats).toMatchObject({
      tripCount: 3,
      distanceKm: 30,
      drivingSeconds: 3200,
      activeDays: 2,
      averageTripKm: 10,
      longestTripKm: 12,
      tripsPerActiveDay: 1.5,
    });
  });

  it('includes the full recorded history when all-time totals are requested', () => {
    const stats = buildDashboardActivityStats([
      makeTrip('2026-07-15T08:00:00', 12, 1200),
      makeTrip('2025-01-10T09:00:00', 100, 7200),
    ], {
      now: new Date('2026-07-15T18:00:00'),
      periodDays: null,
    });

    expect(stats.tripCount).toBe(2);
    expect(stats.distanceKm).toBe(112);
    expect(stats.activeDays).toBe(2);
  });

  it('falls back to timestamps when stored duration is unavailable', () => {
    const stats = buildDashboardActivityStats([{
      status: 'completed',
      start_time: '2026-07-15T08:00:00Z',
      end_time: '2026-07-15T08:25:00Z',
      distance_km: 5,
    }], { now: new Date('2026-07-15T18:00:00Z') });

    expect(stats.drivingSeconds).toBe(1500);
  });
});
