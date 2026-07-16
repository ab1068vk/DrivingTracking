import { describe, expect, it } from 'vitest';
import { buildLiveTrackingSnapshot, formatLiveDuration } from '@/lib/liveTrackingTelemetry';

describe('live tracking telemetry', () => {
  const nowMs = Date.parse('2026-07-14T21:05:00.000Z');

  it('builds a trustworthy native snapshot without external context', () => {
    const snapshot = buildLiveTrackingSnapshot({
      id: 'native-live',
      native_recording: true,
      state: 'recording',
      start_time: '2026-07-14T21:00:00.000Z',
      updated_at: '2026-07-14T21:04:59.000Z',
      last_location_at: '2026-07-14T21:04:58.000Z',
      gps_fix_ready: true,
      gps_accuracy_m: 7,
      speed_kmh: 48,
      speed_limit_kmh: 50,
      speed_limit_source: 'user_confirmed_posted_sign',
      distance_km: 3.25,
      avg_speed_kmh: 39,
      max_speed_kmh: 71,
      stopped_seconds: 22,
      route_point_count: 90,
      route_preview: [
        { lat: 43.65, lng: -79.38, speed_kmh: 30, timestamp: '2026-07-14T21:04:54.000Z' },
        { lat: 43.651, lng: -79.379, speed_kmh: 48, timestamp: '2026-07-14T21:04:58.000Z' },
      ],
      live_events: [{ type: 'harsh_brake', title: 'Braking threshold exceeded', timestamp: '2026-07-14T21:04:50.000Z' }],
      live_event_counts: { harsh_brake: 1 },
    }, nowMs);

    expect(snapshot).toMatchObject({
      currentSpeedKmh: 48,
      speedLimitKmh: 50,
      speedDeltaKmh: -2,
      distanceKm: 3.25,
      durationSeconds: 300,
      routePointCount: 90,
      eventCounts: { harsh_brake: 1 },
      gps: { key: 'strong', fixReady: true, accuracyM: 7 },
    });
    expect(snapshot.latestEvent.title).toBe('Braking threshold exceeded');
  });

  it('does not present a stale zero as a trustworthy stationary speed', () => {
    const snapshot = buildLiveTrackingSnapshot({
      start_time: '2026-07-14T21:00:00.000Z',
      speed_kmh: 0,
      gps_fix_ready: true,
      last_location_at: '2026-07-14T21:04:20.000Z',
      updated_at: '2026-07-14T21:04:20.000Z',
    }, nowMs);

    expect(snapshot.currentSpeedKmh).toBeNull();
    expect(snapshot.gps.key).toBe('stale');
  });

  it('keeps privacy gaps out of distance and route continuity', () => {
    const snapshot = buildLiveTrackingSnapshot({
      start_time: '2026-07-14T21:00:00.000Z',
      route_preview: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-07-14T21:00:00.000Z' },
        { lat: null, lng: null, masked_for_privacy: true, timestamp: '2026-07-14T21:00:05.000Z' },
        { lat: 43.66, lng: -79.37, timestamp: '2026-07-14T21:00:10.000Z' },
      ],
    }, nowMs);

    expect(snapshot.distanceKm).toBe(0);
    expect(snapshot.routeMaskedCount).toBe(1);
  });

  it('formats a live clock without treating zero as unavailable', () => {
    expect(formatLiveDuration(0)).toBe('0:00');
    expect(formatLiveDuration(65)).toBe('1:05');
    expect(formatLiveDuration(3661)).toBe('1:01:01');
  });
});

