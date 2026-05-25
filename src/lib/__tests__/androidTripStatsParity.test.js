import { describe, expect, it } from 'vitest';
import fixture from '@/lib/__fixtures__/androidTripStatsParityFixture.json';
import { calculateSegmentMetrics, calculateTripStats, DEFAULT_THRESHOLDS } from '@/lib/tripEngine';

function jsParityResult() {
  const stats = calculateTripStats(
    fixture.points,
    fixture.startTime,
    fixture.endTime,
    DEFAULT_THRESHOLDS
  );
  const [noiseFloorCase] = fixture.noiseFloorCases;
  const noiseFloorM = Math.max(
    DEFAULT_THRESHOLDS.MIN_POINT_DISTANCE_M,
    Math.min(
      fixture.thresholds.NOISE_FLOOR_MAX_METERS,
      Math.max(noiseFloorCase.previousAccuracy, noiseFloorCase.currentAccuracy) *
        fixture.thresholds.NOISE_FLOOR_ACCURACY_MULTIPLIER
    )
  );

  return {
    distanceKm: stats.distance_km,
    durationSeconds: stats.duration_seconds,
    avgSpeedKmh: stats.avg_speed_kmh,
    nightDriving: stats.night_driving,
    noiseFloorM,
  };
}

describe('Android auto-tracking stats parity', () => {
  it('keeps JS thresholds aligned with the native auto-tracking fixture contract', () => {
    expect(DEFAULT_THRESHOLDS.MIN_POINT_DISTANCE_M).toBe(fixture.thresholds.MIN_POINT_DISTANCE_M);
    expect(DEFAULT_THRESHOLDS.STATIONARY_SPEED_KMH).toBe(fixture.thresholds.STATIONARY_SPEED_KMH);
    expect(DEFAULT_THRESHOLDS.MIN_TRUSTED_SPEED_KMH).toBe(fixture.thresholds.MIN_TRUSTED_SPEED_KMH);
  });

  it('matches the shared golden stats fixture used by Android unit tests', () => {
    const stats = calculateTripStats(
      fixture.points,
      fixture.startTime,
      fixture.endTime,
      DEFAULT_THRESHOLDS
    );

    expect(stats).toMatchObject(fixture.expectedStats);
  });

  it('computes the JS parity result used by Android instrumentation tests', () => {
    expect(jsParityResult()).toEqual(fixture.expectedParityResult);
  });

  it('keeps the noise-floor formula conservative for mixed GPS accuracy pairs', () => {
    const [noiseFloorCase] = fixture.noiseFloorCases;
    const segment = calculateSegmentMetrics(
      {
        lat: 43.65,
        lng: -79.38,
        timestamp: '2026-01-01T12:00:00.000Z',
        speed_kmh: 20,
        accuracy: noiseFloorCase.previousAccuracy,
      },
      {
        lat: 43.650108,
        lng: -79.38,
        timestamp: '2026-01-01T12:00:10.000Z',
        speed_kmh: 20,
        accuracy: noiseFloorCase.currentAccuracy,
      },
      DEFAULT_THRESHOLDS
    );

    expect(noiseFloorCase.expectedNoiseFloorM).toBe(18);
    expect(segment.distanceM).toBeLessThan(noiseFloorCase.expectedNoiseFloorM);
    expect(segment.isNoise).toBe(true);
  });
});
