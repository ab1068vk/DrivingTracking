import { describe, expect, it } from 'vitest';
import { readDashboardSource } from '@/lib/__tests__/helpers/pageSourceBundle';
import { readFileSync } from 'node:fs';
import fixture from '@/lib/__fixtures__/androidTripStatsParityFixture.json';
import { calculateSegmentMetrics, calculateTripStats, DEFAULT_THRESHOLDS, reviewManualTripSave } from '@/lib/tripEngine';
import { scoringValue } from '@/lib/scoringConstants';
import { STANDARD_GRAVITY_MS2 } from '@/lib/mathUtils';
import * as appConstants from '@/lib/appConstants';

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

    for (const key of ['score_overall', 'score_safety', 'score_smoothness']) {
      expect(source).toContain(`trip.put("${key}", JSONObject.NULL);`);
    }
    expect(source).toContain('trip.put("needs_rescore", true);');
    expect(source).toContain('trip.put("score_status", "pending_javascript_scoring");');
    expect(source).not.toContain('trip.put("score_overall", 100');
  });

  it('keeps every generated native detection constant equal to its JavaScript source', () => {
    const source = readFileSync(
      new URL('../../../android/app/src/main/java/com/drivesense/app/DetectionConstants.java', import.meta.url),
      'utf8'
    );
    // Each field is emitted as `/** JS_CONSTANT_NAME */` followed by its declaration, so the
    // Java file carries the mapping and this test does not have to repeat it.
    const fields = [...source.matchAll(
      /\/\*\* ([\w.\s*]+) \*\/\s*\n\s*static final (\w+) (\w+) = (-?[\d.]+)[dfL]?;/g
    )];

    expect(fields.length).toBeGreaterThan(30);

    const overrides = {
      // Emitted in milliseconds; the JS constant is in seconds.
      'MIN_TRIP_DURATION_SECONDS * 1000': () => scoringValue('MIN_TRIP_DURATION_SECONDS') * 1000,
      'mathUtils.js STANDARD_GRAVITY_MS2': () => STANDARD_GRAVITY_MS2,
    };

    // Alert policy (speed-alert gating, the hazard horizon) lives in
    // appConstants rather than scoringConstants: it is not scoring policy, so
    // retuning it must not move SCORING_VERSION and invalidate historical trips.
    // Resolved from the module namespace so adding one does not mean adding a
    // line here as well — which is what this table used to require.
    const resolve = (jsSource) => {
      if (overrides[jsSource]) return overrides[jsSource]();
      const fromAppConstants = jsSource.match(/^appConstants\.(\w+)$/);
      if (fromAppConstants) return appConstants[fromAppConstants[1]];
      return scoringValue(jsSource);
    };

    for (const [, jsSource, , javaName, javaValue] of fields) {
      const expected = resolve(jsSource);
      expect(Number.isFinite(expected), `${jsSource} is not a scoring constant`).toBe(true);
      expect(Number(javaValue), `${javaName} drifted from ${jsSource}`).toBe(expected);
    }
  });

  it('keeps the native GPS accuracy gate aligned with JavaScript scoring', () => {
    const source = readFileSync(
      new URL('../../../android/app/src/main/java/com/drivesense/app/DetectionConstants.java', import.meta.url),
      'utf8'
    );
    const nativeAccuracy = source.match(/MAX_ACCURACY_M\s*=\s*(\d+(?:\.\d+)?)f/)?.[1];

    expect(Number(nativeAccuracy)).toBe(DEFAULT_THRESHOLDS.MAX_GPS_ACCURACY_M);
  });

  it('leaves no hand-copied detection literal behind in the tracking service', () => {
    const source = readFileSync(
      new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url),
      'utf8'
    );

    // One shared minimum speed used to gate braking, acceleration and cornering alerts,
    // which is why the live detector announced events the scored trip never recorded.
    expect(source).not.toContain('LIVE_EVENT_MIN_SPEED_KMH');
    expect(source).toContain('DetectionConstants.MIN_SPEED_HARSH_BRAKE_KMH');
    expect(source).toContain('DetectionConstants.MIN_SPEED_RAPID_ACCEL_KMH');
    expect(source).toContain('DetectionConstants.CORNERING_MIN_SPEED_KMH');
    // Stop-start must pick urban vs highway thresholds the way the scorer does.
    expect(source).toContain('DetectionConstants.STOP_START_URBAN_SPEED_SPLIT_KMH');
    expect(source).toContain('DetectionConstants.STOP_START_URBAN_MIN_SPEED_KMH');
    // Phone-proxy tuning must follow the settings sliders, not frozen static finals.
    expect(source).toMatch(/getSettingDouble\(\s*"phone_proxy_max_accuracy_m"/);
    expect(source).toMatch(/getSettingDouble\(\s*"phone_micro_steer_window_s"/);
    expect(source).toMatch(/getSettingDouble\(\s*\n?\s*"phone_micro_steer_count"/);
  });

  it('keeps active-trip crash recovery encrypted, throttled, and bounded', () => {
    const serviceSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');
    const checkpointSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActiveTripCheckpointStore.java', import.meta.url), 'utf8');

    expect(serviceSource).toContain('ACTIVE_CHECKPOINT_INTERVAL_MS = 60_000L');
    expect(serviceSource).toContain('ACTIVE_CHECKPOINT_RESUME_WINDOW_MS = 10 * 60_000L');
    expect(serviceSource).toContain('finishTrip("checkpoint_recovery_finalize", true)');
    expect(serviceSource).toContain('checkpoint.put("candidate", candidateTrip)');
    expect(serviceSource).toContain('checkpoint.optBoolean("candidate", false)');
    expect(serviceSource).toContain('pendingCompletedTrip = trip');
    expect(serviceSource).toContain('if (!retryPendingCompletedTripSave(false)) return');
    expect(serviceSource).toContain('COMPLETED_TRIP_SAVE_RETRY_MS = 60_000L');
    expect(serviceSource).toContain('checkpoint.put("motion_samples_omitted", true)');
    expect(serviceSource).toContain('DriveSenseActiveTripCheckpointStore.clear(this);');
    expect(checkpointSource).toContain('MAX_ROUTE_POINTS = 1500');
    expect(checkpointSource).toContain('MAX_ENCRYPTED_BYTES = 512 * 1024');
    expect(checkpointSource).toContain('MAX_AGE_MS = 7L * 24L * 60L * 60_000L');
    expect(checkpointSource).toContain('MAX_CANDIDATE_AGE_MS = 24L * 60L * 60_000L');
    expect(checkpointSource).toContain('new AtomicFile(');
    expect(checkpointSource).toContain('DriveSensePayloadCrypto');
  });

  it('uses a bounded per-trip journal and verified per-ID handoff acknowledgements', () => {
    const journalSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseCompletedTripJournal.java', import.meta.url), 'utf8');
    const repositorySource = readFileSync(new URL('../localTripRepository.js', import.meta.url), 'utf8');

    expect(journalSource).toContain('MAX_ENCRYPTED_CHUNK_BYTES = 512 * 1024');
    expect(journalSource).toContain('MAX_TOTAL_JOURNAL_BYTES = 32L * 1024L * 1024L');
    expect(journalSource).toContain('new AtomicFile(file)');
    expect(journalSource).toContain('chunks failed pre-commit verification');
    expect(journalSource).toContain('restoreManifest(manifestFile, previousManifest)');
    expect(repositorySource).toContain('verifyTripsPersistedForNativeAcknowledge(importedTrips)');
    expect(repositorySource).toContain('acknowledgeNativeCompletedTrips(acknowledgedTripIds)');
    expect(repositorySource).not.toContain('clearNativeCompletedTrips().catch');
  });

  it('re-arms opted-in background tracking after reboot or an app update', () => {
    const receiverSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseBootReceiver.java', import.meta.url), 'utf8');
    const manifestSource = readFileSync(new URL('../../../android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');

    expect(receiverSource).toContain('DriveSenseNativeTripStore.isServiceEnabled(context)');
    expect(receiverSource).toContain('DriveSenseAutoTrackingService.start(context)');
    expect(receiverSource).toContain('service_restart_skipped');
    expect(manifestSource).toContain('android.intent.action.BOOT_COMPLETED');
    expect(manifestSource).toContain('android.intent.action.MY_PACKAGE_REPLACED');
  });

  it('keeps the user opt-in armed across an unexpected service teardown', () => {
    const serviceSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');
    const onDestroy = serviceSource.slice(
      serviceSource.indexOf('public void onDestroy()'),
      serviceSource.indexOf('@Nullable', serviceSource.indexOf('public void onDestroy()'))
    );

    expect(onDestroy).toContain('finishTrip("service_destroyed", false)');
    expect(onDestroy).not.toContain('setServiceEnabled(this, false)');
    expect(serviceSource).toContain('return START_STICKY;');
    expect(serviceSource).toContain('finishTrip("service_stopped_by_user", false)');
  });

  it('supports confirmed native manual trips for background alerts', () => {
    const serviceSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', import.meta.url), 'utf8');
    const pluginSource = readFileSync(new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java', import.meta.url), 'utf8');
    const dashboardSource = readDashboardSource();

    expect(serviceSource).toContain('ACTION_START_MANUAL_TRIP');
    expect(serviceSource).toContain('nativeTripStartSource = "native_manual";');
    expect(serviceSource).toContain('candidateTrip = false;');
    expect(serviceSource).toContain('trip.put("start_source", completedStartSource);');
    expect(pluginSource).toContain('startNativeManualTrip');
    expect(pluginSource).toContain('hasNativeManualTripPermissions');
    expect(dashboardSource).toContain('startNativeManualTrip({ startTime, tripId: nativeManualTripId })');
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
