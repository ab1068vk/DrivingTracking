import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import fixture from '@/lib/__fixtures__/androidTripStatsParityFixture.json';
import { calculateSegmentMetrics, calculateTripStats, DEFAULT_THRESHOLDS, reviewManualTripSave } from '@/lib/tripEngine';

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

  it('saves sparse manual GPS trips when coordinate displacement confirms movement', () => {
    const startTime = '2026-01-01T12:00:00.000Z';
    const endTime = '2026-01-01T12:10:00.000Z';
    const points = [
      { lat: 43.65, lng: -79.38, timestamp: startTime, speed_kmh: 0, accuracy: 8 },
      { lat: 43.85, lng: -79.38, timestamp: endTime, speed_kmh: 0, accuracy: 8 },
    ];

    const review = reviewManualTripSave({
      points,
      stats: { duration_seconds: 600, distance_km: 0, max_speed_kmh: 0 },
      startTime,
      endTime,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(review).toMatchObject({
      shouldSave: true,
      reason: 'manual_coordinate_displacement_confirmed',
      coordinatePointCount: 2,
      movingSpeedSampleCount: 0,
      maxSpeedKmh: 0,
    });
    expect(review.cumulativeCoordKm).toBeGreaterThan(20);
  });

  it('excludes short-interval GPS jumps from route distance and manual displacement fallback', () => {
    const startTime = '2026-01-01T12:00:00.000Z';
    const endTime = '2026-01-01T12:01:00.000Z';
    const points = [
      { lat: 43.65, lng: -79.38, timestamp: startTime, speed_kmh: 0, accuracy: 8 },
      { lat: 44.37, lng: -79.38, timestamp: endTime, speed_kmh: 0, accuracy: 8 },
    ];

    const stats = calculateTripStats(points, startTime, endTime, DEFAULT_THRESHOLDS);
    const review = reviewManualTripSave({
      points,
      stats: { duration_seconds: 60, distance_km: 0, max_speed_kmh: 0 },
      startTime,
      endTime,
      thresholds: DEFAULT_THRESHOLDS,
    });

    expect(stats.distance_km).toBe(0);
    expect(review).toMatchObject({
      shouldSave: false,
      reason: 'manual_no_movement_evidence',
      cumulativeCoordKm: 0,
    });
  });

  it('stores native completed trips as unscored until JavaScript rescoring runs', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');

    for (const key of ['score_overall', 'score_safety', 'score_smoothness', 'score_eco']) {
      expect(source).toContain(`trip.put("${key}", JSONObject.NULL);`);
    }
    expect(source).toContain('trip.put("needs_rescore", true);');
    expect(source).toContain('trip.put("score_status", "pending_javascript_scoring");');
    expect(source).not.toContain('trip.put("score_overall", 100');
  });

  it('supports confirmed native manual trips for background alerts', () => {
    const serviceSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');
    const pluginSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java', import.meta.url), 'utf8');
    const dashboardSource = readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8');

    expect(serviceSource).toContain('ACTION_START_MANUAL_TRIP');
    expect(serviceSource).toContain('nativeTripStartSource = "native_manual";');
    expect(serviceSource).toContain('candidateTrip = false;');
    expect(serviceSource).toContain('trip.put("start_source", completedStartSource);');
    expect(pluginSource).toContain('startNativeManualTrip');
    expect(pluginSource).toContain('hasNativeManualTripPermissions');
    expect(dashboardSource).toContain('startNativeManualTrip({ startTime })');
    expect(dashboardSource).toContain('const needsManualForegroundConfirmation = false;');
    expect(dashboardSource).toContain('manual_background_tracking_fallback_foreground');
  });

  it('keeps native speed voice independent from speed notification settings', () => {
    const serviceSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');

    expect(serviceSource).toContain('isSettingEnabled("speed_warning_enabled", true)');
    expect(serviceSource).toContain('shouldTriggerSpeedAlert(speedKmh, speedLimitKmh, speedMarginKmh)');
    expect(serviceSource).not.toContain('isSettingEnabled("notif_speeding_alert_enabled", true)');
  });

  it('records native location permission loss as a trip data quality flag', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');

    expect(source).toContain('catch (SecurityException exception)');
    expect(source).toContain('recordTimeline("location_permission_lost"');
    expect(source).toContain('flags.put("location_permission_loss");');
    expect(source).toContain('trip.put("data_quality_flags", flags);');
  });

  it('treats stale native activity state as missing for GPS-only parked fallback', () => {
    const source = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');

    expect(source).toContain('ACTIVITY_STATE_MAX_AGE_MS');
    expect(source).toContain('lastActivityUpdateMs');
    expect(source).toContain('recordTimeline("activity_recognition_stale"');
    expect(source).toContain('finishTrip("activity_recognition_stale", true);');
  });
});
