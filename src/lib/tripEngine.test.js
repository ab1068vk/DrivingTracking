import { describe, expect, it } from 'vitest';
import {
  calculateRouteSummary,
  calculateTripStats,
  cleanRoutePoints,
  haversineDistance,
  shouldAcceptLocationPoint,
} from '@/lib/tripEngine';
import {
  shouldAutoStartTracking,
  shouldAutoStopTracking,
  ACTIVITY_TYPES,
} from '@/lib/activityRecognition';

const point = (lat, lng, seconds, speedKmh = 40, accuracy = 8) => ({
  lat,
  lng,
  speed_kmh: speedKmh,
  accuracy,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(),
});

describe('tripEngine', () => {
  it('calculates haversine distance for nearby route points', () => {
    const km = haversineDistance(43.6532, -79.3832, 43.6542, -79.3832);
    expect(km).toBeGreaterThan(0.1);
    expect(km).toBeLessThan(0.12);
  });

  it('rejects inaccurate, duplicate, and impossible GPS points', () => {
    const first = point(43.6532, -79.3832, 0);
    const duplicate = point(43.6532001, -79.3832001, 2);
    const badAccuracy = point(43.654, -79.384, 12, 40, 120);
    const impossibleJump = point(44.6532, -80.3832, 14, 40, 5);

    expect(shouldAcceptLocationPoint(first)).toBe(true);
    expect(shouldAcceptLocationPoint(duplicate, first)).toBe(false);
    expect(shouldAcceptLocationPoint(badAccuracy, first)).toBe(false);
    expect(shouldAcceptLocationPoint(impossibleJump, first)).toBe(false);
  });

  it('summarizes distance, duration, average speed, max speed, and idle time', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0),
      point(43.6542, -79.3832, 10, 40),
      point(43.6552, -79.3832, 70, 0),
    ];

    const stats = calculateTripStats(points, points[0].timestamp, points[2].timestamp);

    expect(stats.distance_km).toBeGreaterThan(0.2);
    expect(stats.duration_seconds).toBe(70);
    expect(stats.avg_speed_kmh).toBe(11.4);
    expect(stats.max_speed_kmh).toBe(40);
    expect(stats.idle_time_seconds).toBe(60);
  });

  it('cleans noisy route points before calculating route summaries', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0),
      point(43.6532001, -79.3832001, 2, 0),
      point(43.6542, -79.3832, 20, 35),
      point(43.6552, -79.3832, 40, 45),
    ];

    const summary = calculateRouteSummary(points, points[0].timestamp, points[3].timestamp);

    expect(cleanRoutePoints(points)).toHaveLength(3);
    expect(summary.stats.distance_km).toBeGreaterThan(0.2);
    expect(summary.scores.score_overall).toBeGreaterThan(0);
  });

  it('does not turn stationary GPS jitter into speed or distance', () => {
    const points = [
      point(43.6532, -79.3832, 0, 0, 12),
      point(43.653235, -79.383225, 12, 16, 18),
      point(43.65318, -79.38326, 30, 14, 20),
      point(43.65322, -79.38321, 50, 15, 18),
    ];

    const stats = calculateTripStats(points, points[0].timestamp, points[3].timestamp);

    expect(stats.distance_km).toBe(0);
    expect(stats.avg_speed_kmh).toBe(0);
    expect(stats.max_speed_kmh).toBe(0);
  });
});

describe('auto tracking decision logic', () => {
  it('starts only when activity and speed strongly suggest driving', () => {
    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 82 },
      currentSpeedKmh: 28,
      recentMovingSeconds: 30,
    })).toBe(true);

    expect(shouldAutoStartTracking({
      activity: { type: ACTIVITY_TYPES.WALKING, confidence: 95 },
      currentSpeedKmh: 6,
      recentMovingSeconds: 60,
    })).toBe(false);
  });

  it('stops only after still or non-vehicle signals persist', () => {
    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.STILL, confidence: 90 },
      currentSpeedKmh: 0,
      stillSeconds: 240,
    })).toBe(true);

    expect(shouldAutoStopTracking({
      activity: { type: ACTIVITY_TYPES.IN_VEHICLE, confidence: 70 },
      currentSpeedKmh: 8,
      stillSeconds: 30,
    })).toBe(false);
  });
});
