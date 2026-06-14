import { describe, expect, it } from 'vitest';
import {
  PRIVATE_TRIP_MODE,
  buildPrivateTripRecord,
  createPrivateTripRuntime,
  processPrivateTripPoint,
} from '@/lib/privateTripMode';

describe('private trip mode', () => {
  it('accumulates summary statistics without returning coordinates', () => {
    const runtime = createPrivateTripRuntime();
    processPrivateTripPoint(runtime, {
      lat: 43.6532,
      lng: -79.3832,
      speed_kmh: 20,
      timestamp: '2026-06-13T12:00:00.000Z',
    }, '2026-06-13T12:00:00.000Z');
    const summary = processPrivateTripPoint(runtime, {
      lat: 43.6542,
      lng: -79.3832,
      speed_kmh: 30,
      timestamp: '2026-06-13T12:01:00.000Z',
    }, '2026-06-13T12:00:00.000Z');

    expect(summary.distance_m).toBeGreaterThan(100);
    expect(summary.duration_seconds).toBe(60);
    expect(summary.gps_points_stored).toBe(0);
    expect(JSON.stringify(summary)).not.toContain('43.65');
    expect(JSON.stringify(summary)).not.toContain('-79.38');
  });

  it('builds a scoreless completed trip with no route data', () => {
    const record = buildPrivateTripRecord({
      start_time: '2026-06-13T12:00:00.000Z',
      privacy_mode: PRIVATE_TRIP_MODE,
      private_trip_summary: {
        distance_m: 2500,
        avg_running_speed_kmh: 42,
        max_speed_kmh: 70,
        gps_points_processed: 100,
      },
    }, '2026-06-13T12:10:00.000Z');

    expect(record).toMatchObject({
      privacy_mode: PRIVATE_TRIP_MODE,
      distance_km: 2.5,
      duration_seconds: 600,
      route_points: [],
      route_points_raw_count: 0,
      score_status: 'unavailable_private_trip',
      needs_rescore: false,
    });
    expect(record.private_trip_summary.gps_points_stored).toBe(0);
  });
});
