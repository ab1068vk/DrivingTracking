import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { authService, migrateLegacyAuthTokens } from '@/api/auth';
import { apiClient, getAuthToken } from '@/api/client';
import { importDriveSenseBackup, MAX_BACKUP_BYTES, parseDriveSenseBackup } from '@/lib/dataBackup';
import { scoreTripAnomaly } from '@/lib/driverAnomaly';
import { logError } from '@/lib/errorReporting';
import { localTripRepository } from '@/lib/localTripRepository';
import { mapMatchRoute } from '@/lib/mapMatching';
import { buildOpenSourceTripContextPatch } from '@/lib/openSourceTripContext';
import { mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { resetRetryCircuits, withRetry } from '@/lib/retry';
import { buildSensorFusionSummary } from '@/lib/sensorFusionModel';
import { sanitizeImportedSettings, validateSettingsPatch } from '@/lib/trackingStore';
import {
  calculateRouteSummary,
  calculateTripScores,
  DEFAULT_THRESHOLDS,
  detectDrivingEvents,
  PHONE_USE_SAFETY_WEIGHT,
} from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';

const routePoints = [
  { lat: 43.6500, lng: -79.3800, speed_kmh: 20, accuracy: 8, timestamp: '2026-01-01T12:00:00.000Z' },
  { lat: 43.6504, lng: -79.3800, speed_kmh: 30, accuracy: 8, timestamp: '2026-01-01T12:00:20.000Z' },
  { lat: 43.6509, lng: -79.3802, speed_kmh: 35, accuracy: 8, timestamp: '2026-01-01T12:00:40.000Z' },
  { lat: 43.6514, lng: -79.3804, speed_kmh: 30, accuracy: 8, timestamp: '2026-01-01T12:01:00.000Z' },
];

const completedTrip = (patch = {}) => ({
  id: `shape_${Math.random().toString(36).slice(2)}`,
  status: 'completed',
  start_time: routePoints[0].timestamp,
  end_time: routePoints[routePoints.length - 1].timestamp,
  route_points: routePoints,
  needs_rescore: true,
  schema_version: 0,
  ...patch,
});

const expectFiniteTripScores = (value) => {
  for (const key of ['score_overall', 'score_safety', 'score_smoothness', 'score_eco']) {
    expect(Number.isFinite(value[key])).toBe(true);
  }
};

describe('release blocker regressions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRetryCircuits();
  });

  it('does not read auth tokens from localStorage', () => {
    vi.stubGlobal('sessionStorage', { getItem: vi.fn(() => null) });
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'local-token') });

    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem).not.toHaveBeenCalled();
  });

  it('removes auth tokens from all browser storage on logout', () => {
    vi.stubGlobal('sessionStorage', { removeItem: vi.fn() });
    vi.stubGlobal('localStorage', { removeItem: vi.fn() });

    authService.logout();

    expect(sessionStorage.removeItem).toHaveBeenCalledWith('token');
    expect(sessionStorage.removeItem).toHaveBeenCalledWith('access_token');
    expect(localStorage.removeItem).toHaveBeenCalledWith('token');
    expect(localStorage.removeItem).toHaveBeenCalledWith('access_token');
  });

  it('migrates legacy localStorage auth tokens into sessionStorage and deletes them', () => {
    const legacyTokens = new Map([
      ['token', 'legacy-token'],
      ['access_token', 'legacy-access-token'],
    ]);
    const sessionTokens = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => legacyTokens.get(key) ?? null),
      removeItem: vi.fn((key) => legacyTokens.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key) => sessionTokens.get(key) ?? null),
      setItem: vi.fn((key, value) => sessionTokens.set(key, value)),
    });

    migrateLegacyAuthTokens();

    expect(sessionStorage.setItem).toHaveBeenCalledWith('token', 'legacy-token');
    expect(sessionStorage.setItem).toHaveBeenCalledWith('access_token', 'legacy-access-token');
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('leaves no auth token readable from localStorage after migration', () => {
    const legacyTokens = new Map([['token', 'legacy-token']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => legacyTokens.get(key) ?? null),
      removeItem: vi.fn((key) => legacyTokens.delete(key)),
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });

    migrateLegacyAuthTokens();

    const xssReadableToken = localStorage.getItem('token') || localStorage.getItem('access_token');
    expect(xssReadableToken).toBeNull();
  });

  it('fails API calls clearly when no backend is configured', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(apiClient.get('/trips')).rejects.toThrow('No backend API configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports malformed backup JSON with a clear parse error', () => {
    expect(() => parseDriveSenseBackup('not json')).toThrow(Error);
    expect(() => parseDriveSenseBackup('not json')).not.toThrow(SyntaxError);
    expect(() => parseDriveSenseBackup('not json')).toThrow('Backup file is not valid JSON');
  });

  it('reports non-backup JSON with a clear validation error', () => {
    expect(() => parseDriveSenseBackup('{}')).toThrow('valid Road Sage backup');
  });

  it('rejects oversized backup files before reading them', async () => {
    const file = {
      size: MAX_BACKUP_BYTES + 1,
      text: vi.fn(),
    };

    await expect(importDriveSenseBackup(file)).rejects.toThrow('50 MB or smaller');
    expect(file.text).not.toHaveBeenCalled();
  });

  it('drops unknown imported settings and clamps dangerous thresholds', () => {
    const settings = sanitizeImportedSettings({
      threshold_harsh_brake_ms2: 0,
      tracking_mode: 'injected_value',
      phone_use_detection_enabled: false,
      injected_key: 'nope',
      privacy_zones: [{ id: 'home', label: 'Home', radius_m: 5000, masked_for_privacy: true }],
    });

    expect(settings.threshold_harsh_brake_ms2).toBeGreaterThan(0);
    expect(settings.threshold_harsh_brake_ms2).toBe(2);
    expect(settings.tracking_mode).toBeUndefined();
    expect(settings.phone_use_detection_enabled).toBe(false);
    expect(settings.injected_key).toBeUndefined();
    expect(settings.privacy_zones[0]).toMatchObject({
      id: 'home',
      radius_m: 1000,
      masked_for_privacy: true,
    });
    expect(settings.privacy_zones[0].lat).toBeUndefined();
  });

  it('validates settings patches before saving unsafe thresholds', () => {
    expect(validateSettingsPatch({ threshold_harsh_brake_ms2: 0 })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ threshold_harsh_brake_ms2: 3.5, night_detection_mode: 'custom' })).toMatchObject({ valid: true });
  });

  it('returns only the stable driving-event detection object shape', () => {
    const detection = detectDrivingEvents([]);
    const invalidInputDetection = detectDrivingEvents('not route points');

    expect(Object.keys(detection).sort()).toEqual(['events', 'phoneUse']);
    expect(Array.isArray(detection.events)).toBe(true);
    expect(detection.phoneUse).toBeTruthy();
    expect(typeof detection.phoneUse).toBe('object');
    expect(detection.events.some).toBeTypeOf('function');
    expect(Object.keys(invalidInputDetection).sort()).toEqual(['events', 'phoneUse']);
    expect(invalidInputDetection.events).toEqual([]);
    expect(typeof invalidInputDetection.phoneUse).toBe('object');
  });

  it('does not use brittle detection return-shape probes at trip scoring call sites', () => {
    const sources = [
      readFileSync(new URL('../localTripRepository.js', import.meta.url), 'utf8'),
      readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8'),
      readFileSync(new URL('../openSourceTripContext.js', import.meta.url), 'utf8'),
    ].join('\n');

    expect(sources).not.toContain('Reflect.get(detection');
    expect(sources).not.toContain('?? detection');
    expect(sources).not.toMatch(/const\s+\w*Detection?\s*=\s*detectDrivingEvents/);
  });

  it('keeps trip scoring call sites finite with the stable detection object', async () => {
    const summary = calculateRouteSummary(
      routePoints,
      routePoints[0].timestamp,
      routePoints[routePoints.length - 1].timestamp
    );
    expectFiniteTripScores(summary.scores);

    const [rescoredTrip] = await localTripRepository.upsertMany([completedTrip()]);
    expectFiniteTripScores(rescoredTrip);

    const patch = await buildOpenSourceTripContextPatch(completedTrip(), {
      map_matching_enabled: false,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
    });
    expectFiniteTripScores(patch);
  });

  it('keeps anomaly scores finite when model stddev is zero', () => {
    const result = scoreTripAnomaly(
      { status: 'completed', score_overall: 90, distance_km: 10, harsh_brakes_count: 0 },
      { trip_count: 8, features: { harsh_per_10km: { mean: 0, std: 0 } } }
    );

    expect(result.anomaly_score).toBe(0);
    expect(Number.isFinite(result.anomaly_score)).toBe(true);
  });

  it('does not call OSRM when map matching has no configured endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const route = [
      { lat: 43.65, lng: -79.38 },
      { lat: 43.651, lng: -79.38 },
      { lat: 43.652, lng: -79.38 },
    ];

    const result = await mapMatchRoute(route, { map_matching_enabled: true, osrm_map_matching_url: '' });

    expect(result.status).toBe('needs_endpoint');
    expect(result.routePoints).toBe(route);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns finite sensor fusion peaks for empty samples', () => {
    const result = buildSensorFusionSummary([], []);

    expect(result.peak_linear_ms2).toBe(0);
    expect(result.peak_rotation_deg_s).toBe(0);
    expect(Number.isFinite(result.phone_movement_score)).toBe(true);
  });

  it('adds phone-use data source provenance when only GPS proxy data is available', () => {
    const result = mergePhoneUseSignals({ phone_use_score: 60 }, {}, 120);

    expect(result.phone_use_score).toBe(60);
    expect(result.data_sources).toEqual(['gps_proxy']);
  });

  it('keeps Trip Detail phone-use Safety impact text aligned with the scorer weight', () => {
    const scores = calculateTripScores(
      [],
      { distance_km: 5, fatigue_risk_score: 0, intersection_score: 100 },
      [],
      DEFAULT_THRESHOLDS,
      600,
      {
        phone_use_risk: 'high',
        phone_use_score: 40,
        phone_use_total_seconds: 180,
        phone_use_pct_of_trip: 30,
      },
      { includeRoadTypeSegments: false }
    );
    const expectedImpact = Math.max(1, Math.round((100 - scores.phone_use_score) * PHONE_USE_SAFETY_WEIGHT));
    const tripDetailSource = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');

    expect(expectedImpact).toBe(3);
    expect(tripDetailSource).toContain('PHONE_USE_SAFETY_WEIGHT');
    expect(tripDetailSource).toContain('phoneUseSafetyImpactPoints');
    expect(tripDetailSource).toContain(`Phone use reduced your Safety score by about {phoneUseSafetyImpactPoints}`);
    expect(tripDetailSource).not.toContain('* 0.05');
  });

  it('clamps economics scores and uses vehicle fuel type CO2 factors', () => {
    const gasoline = estimateTripEconomics({ distance_km: 100, eco_driving_score: 50 }, { fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 10 }, {});
    const diesel = estimateTripEconomics({ distance_km: 100, eco_driving_score: 50 }, { fuel_type: 'diesel', fuel_efficiency_l_per_100km: 10 }, {});
    const extreme = estimateTripEconomics({ distance_km: 100, eco_driving_score: 999 }, { fuel_efficiency_l_per_100km: 10 }, {});
    const ev = estimateTripEconomics({ distance_km: 100, eco_driving_score: 80 }, { fuel_type: 'electric' }, { co2_baseline_kg_per_100km: 12 });

    expect(gasoline.co2_kg).toBe(23.1);
    expect(diesel.co2_kg).toBe(26.8);
    expect(diesel.co2_kg / gasoline.co2_kg).toBeCloseTo(2.68 / 2.31, 2);
    expect(extreme.actual_l_per_100km).toBe(8);
    expect(ev.co2_kg).toBeGreaterThan(0);
    expect(ev.fuel_co2_kg).toBe(0);
    expect(ev.grid_co2_kg).toBeGreaterThan(0);
    expect(ev.co2_saved_kg).toBeGreaterThan(0);
  });

  it('changes CO2 savings when the average vehicle baseline changes', () => {
    const trip = { distance_km: 100, eco_driving_score: 50 };
    const vehicle = { fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 3 };

    const euBaseline = estimateTripEconomics(trip, vehicle, { co2_baseline_kg_per_100km: 12 });
    const northAmericaBaseline = estimateTripEconomics(trip, vehicle, { co2_baseline_kg_per_100km: 18 });

    expect(northAmericaBaseline.co2_saved_kg).toBeGreaterThan(euBaseline.co2_saved_kg);
    expect(northAmericaBaseline.co2_saved_kg - euBaseline.co2_saved_kg).toBe(6);
  });

  it('uses grid intensity for electric vehicle CO2 savings', () => {
    const ev = estimateTripEconomics(
      { distance_km: 100, eco_driving_score: 50 },
      { fuel_type: 'electric', ev_efficiency_kwh_per_100km: 20 },
      { co2_baseline_kg_per_100km: 18, grid_co2_kg_per_kwh: 0.05 },
    );

    expect(ev.co2_kg).toBe(1);
    expect(ev.grid_co2_kg).toBe(1);
    expect(ev.co2_saved_kg).toBe(17);
    expect(ev.grid_co2_kg_per_kwh).toBe(0.05);
  });

  it('retries transient external operations once', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry('test-service', operation, { delayMs: 0 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('writes diagnostic events for handled critical operation failures', () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const diagnostic = logError('post_trip_completed_notification', new Error('notification failed'), { tripId: 'trip-1' });
    const events = JSON.parse(values.get('drivesense_tracking_diagnostics'));

    expect(diagnostic).toMatchObject({
      type: 'operation_error',
      context: 'post_trip_completed_notification',
      detail: 'notification failed',
      tripId: 'trip-1',
    });
    expect(events[0]).toMatchObject(diagnostic);
  });

  it('keeps critical post-trip, odometer, and coach persistence failures diagnostically logged', () => {
    const dashboardSource = readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8');
    const vehiclesSource = readFileSync(new URL('../../pages/Vehicles.jsx', import.meta.url), 'utf8');
    const coachSource = readFileSync(new URL('../../pages/DrivingCoach.jsx', import.meta.url), 'utf8');

    [
      'post_trip_completed_notification',
      'post_trip_phone_use_pattern_notification',
      'post_trip_style_shift_notification',
      'post_trip_achievement_notification_sync',
      'post_trip_daily_fatigue_warning',
    ].forEach((context) => {
      expect(dashboardSource).toContain(`logError('${context}'`);
    });
    expect(dashboardSource).not.toContain('dispatchTripCompletedNotification(completedTrip, completedTrips, settings).catch(() => {})');
    expect(vehiclesSource).toContain("logError('vehicle_odometer_sync'");
    expect(vehiclesSource).toContain('Odometer sync delayed');
    expect(vehiclesSource).not.toContain('syncOdometers().catch(() => {})');
    expect(coachSource).toContain("logError('driver_signature_save'");
    expect(coachSource).not.toContain('setJson(DRIVER_SIGNATURE_KEY, driverSignature).catch(() => {})');
  });

  it('wraps heavy trip and dashboard sections in recoverable error boundaries', () => {
    const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    const tripDetailSource = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');
    const dashboardSource = readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8');
    const tripMapSource = readFileSync(new URL('../../components/TripMap.jsx', import.meta.url), 'utf8');
    const tripPlaybackSource = readFileSync(new URL('../../components/TripPlayback.jsx', import.meta.url), 'utf8');

    expect(appSource).toContain('context="trip_detail_page"');
    expect(tripDetailSource).toContain('context="trip_detail_score_overview"');
    expect(tripDetailSource).toContain('<TripScoreOverview trip={trip} />');
    expect(dashboardSource).toContain('context="dashboard_risk_panel"');
    expect(dashboardSource).toContain('<DashboardRiskPanel');
    expect(tripMapSource).toContain('context="trip_map"');
    expect(tripMapSource).toContain('function TripMapContent');
    expect(tripPlaybackSource).toContain('context="trip_playback"');
    expect(tripPlaybackSource).toContain('function TripPlaybackContent');
  });
});
