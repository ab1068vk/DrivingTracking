import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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

  it('stores native completed trips as unscored until JavaScript rescoring runs', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java', import.meta.url), 'utf8');

    for (const key of ['score_overall', 'score_safety', 'score_smoothness', 'score_eco']) {
      expect(source).toContain(`trip.put("${key}", JSONObject.NULL);`);
    }
    expect(source).toContain('trip.put("needs_rescore", true);');
    expect(source).toContain('trip.put("score_status", "pending_javascript_scoring");');
    expect(source).not.toContain('trip.put("score_overall", 100');
  });

  it('records native location permission loss as a trip data quality flag', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java', import.meta.url), 'utf8');

    expect(source).toContain('catch (SecurityException exception)');
    expect(source).toContain('recordTimeline("location_permission_lost"');
    expect(source).toContain('flags.put("location_permission_loss");');
    expect(source).toContain('trip.put("data_quality_flags", flags);');
  });

  it('treats stale native activity state as missing for GPS-only parked fallback', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/roadsage/app/RoadSageAutoTrackingService.java', import.meta.url), 'utf8');

    expect(source).toContain('ACTIVITY_STATE_MAX_AGE_MS');
    expect(source).toContain('lastActivityUpdateMs');
    expect(source).toContain('recordTimeline("activity_recognition_stale"');
    expect(source).toContain('finishTrip("activity_recognition_stale", true);');
  });
});
