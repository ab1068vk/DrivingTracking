import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { authService, migrateLegacyAuthTokens } from '@/api/auth';
import { apiClient, getAuthToken } from '@/api/client';
import { importDriveSenseBackup, MAX_BACKUP_BYTES, parseDriveSenseBackup } from '@/lib/dataBackup';
import { scoreTripAnomaly } from '@/lib/driverAnomaly';
import { logError } from '@/lib/errorReporting';
import { localTripRepository } from '@/lib/localTripRepository';
import { mapMatchRoute } from '@/lib/mapMatching';
import { formatDataSourceLabel, METRIC_REGISTRY } from '@/lib/metricRegistry';
import { buildOpenSourceTripContextPatch } from '@/lib/openSourceTripContext';
import { mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { maskTripForPrivacy } from '@/lib/privacyZones';
import { resetRetryCircuits, withRetry } from '@/lib/retry';
import { exportSystemLogsCsv, exportSystemLogsJson, getSystemLogs, pruneExpiredSystemLogs, sanitizeLogDetail, SYSTEM_LOG_EVENT, SYSTEM_LOG_RETENTION_MS } from '@/lib/systemLog';
import { buildSensorFusionSummary } from '@/lib/sensorFusionModel';
import { sanitizeImportedSettings, validateSettingsPatch } from '@/lib/trackingStore';
import {
  calculateRouteSummary,
  calculateTripScores,
  DEFAULT_THRESHOLDS,
  detectDrivingEvents,
  PHONE_USE_SAFETY_WEIGHT,
} from '@/lib/tripEngine';
import { calculateAchievementBadges, calculateCarbonImpact, estimateTripEconomics } from '@/lib/tripInsights';

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

const expectNullGuardedTripScores = (value) => {
  for (const key of ['score_overall', 'score_safety', 'score_smoothness', 'score_eco']) {
    expect(value[key] == null || Number.isFinite(value[key])).toBe(true);
  }
  expect(value.component_scores?.overall).toMatchObject({
    value: value.score_overall ?? null,
    evidence: expect.any(String),
  });
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

  it('keeps trip scoring call sites null-guarded with the stable detection object', async () => {
    const summary = calculateRouteSummary(
      routePoints,
      routePoints[0].timestamp,
      routePoints[routePoints.length - 1].timestamp
    );
    expectNullGuardedTripScores(summary.scores);

    const [rescoredTrip] = await localTripRepository.upsertMany([completedTrip()]);
    expectNullGuardedTripScores(rescoredTrip);

    const patch = await buildOpenSourceTripContextPatch(completedTrip(), {
      map_matching_enabled: false,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
    });
    expectNullGuardedTripScores(patch);
  });

  it('does not report close-proximity evidence when a privacy zone removes the entire trip', () => {
    const masked = maskTripForPrivacy(completedTrip({
      driving_events: [{
        type: 'close_proximity',
        severity: 'medium',
        lat: routePoints[1].lat,
        lng: routePoints[1].lng,
      }],
    }), {
      privacy_zones: [{ id: 'home', label: 'Home', lat: routePoints[0].lat, lng: routePoints[0].lng, radius_m: 1000 }],
    });
    const scores = calculateTripScores(
      masked.driving_events,
      { distance_km: 0, duration_seconds: 0, fatigue_risk_score: 0 },
      masked.route_points,
      DEFAULT_THRESHOLDS,
      0
    );

    expect(masked.route_points).toEqual([]);
    expect(masked.driving_events).toEqual([]);
    expect(scores.close_proximity_count).toBe(0);
    expect(scores.close_proximity_score).toBeNull();
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

  it('documents IMU as the sensor source for possible incident detection', () => {
    expect(METRIC_REGISTRY.possible_crash_count.dataSources).toEqual(expect.arrayContaining([
      'device_motion_imu',
      'android_activity_recognition',
    ]));
    expect(METRIC_REGISTRY.possible_crash_count.permission_required).toBe('motion_sensors');
  });

  it('formats score provenance source labels for display', () => {
    expect(formatDataSourceLabel('gps')).toBe('GPS route samples');
    expect(formatDataSourceLabel('osm_speed_limit')).toBe('OpenStreetMap speed limits');
    expect(formatDataSourceLabel('gps_inferred_speed_limit')).toBe('GPS-inferred speed limit');
  });

  it('does not score GPS-only phone proxy evidence', () => {
    const result = mergePhoneUseSignals({ phone_use_score: 60 }, {}, 120);

    expect(result.phone_use_score).toBeNull();
    expect(result.phone_use_score_status).toBe('usage_access_required');
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
        phone_use_score_available: true,
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
    expect(extreme.actual_l_per_100km).toBe(9.2);
    expect(ev.co2_kg).toBeGreaterThan(0);
    expect(ev.fuel_co2_kg).toBe(0);
    expect(ev.grid_co2_kg).toBeGreaterThan(0);
    expect(ev.co2_saved_kg).toBeNull();
    expect(extreme.economy_adjustment_multiplier).toBe(0.92);
  });

  it('uses no eco adjustment when eco driving score is unavailable', () => {
    const estimate = estimateTripEconomics(
      { distance_km: 100, eco_driving_score: null },
      { fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 10 },
      {},
    );

    expect(estimate.actual_l_per_100km).toBe(10);
    expect(estimate.economy_adjustment_multiplier).toBe(1);
  });

  it('withholds fuel and CO2 savings until a vehicle baseline exists', () => {
    const unassigned = estimateTripEconomics({ distance_km: 100, eco_driving_score: 80 }, null, {});
    const assigned = estimateTripEconomics(
      { distance_km: 100, eco_driving_score: 80 },
      { fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 10 },
      {},
    );

    expect(unassigned.fuel_saved_available).toBe(false);
    expect(unassigned.fuel_saved_liters).toBeNull();
    expect(unassigned.co2_saved_available).toBe(false);
    expect(unassigned.co2_saved_kg).toBeNull();
    expect(assigned.fuel_saved_available).toBe(true);
    expect(assigned.fuel_saved_liters).toBeGreaterThan(0);
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

  it('computes carbon impact for legacy trips saved before co2_saved_kg existed', () => {
    const carbon = estimateTripEconomics(
      { distance_km: 100, eco_driving_score: 80 },
      { fuel_type: 'electric' },
      { co2_baseline_kg_per_100km: 18, grid_co2_kg_per_kwh: 0.05 },
    );
    const vehicle = { id: 'ev-1', fuel_type: 'electric', ev_efficiency_kwh_per_100km: 20 };
    const impact = calculateCarbonImpact([
      { status: 'completed', distance_km: 100, eco_driving_score: 80, vehicle_id: 'ev-1' },
    ], { co2_baseline_kg_per_100km: 18, grid_co2_kg_per_kwh: 0.05 }, [vehicle]);

    expect(impact.total_co2_saved_kg).toBeCloseTo(carbon.co2_saved_kg, 1);
  });

  it('uses the same vehicle-aware carbon source for impact and achievement badges', () => {
    const vehicle = { id: 'ev-1', fuel_type: 'electric', ev_efficiency_kwh_per_100km: 20 };
    const settings = { co2_baseline_kg_per_100km: 30, grid_co2_kg_per_kwh: 0.04 };
    const trips = [
      { status: 'completed', distance_km: 100, eco_driving_score: 80, vehicle_id: 'ev-1' },
      { status: 'completed', distance_km: 100, eco_driving_score: 80 },
    ];
    const impact = calculateCarbonImpact(trips, settings, [vehicle]);
    const badges = calculateAchievementBadges(trips, settings, [vehicle]);
    const treePlanter = badges.find((badge) => badge.id === 'tree_planter');

    expect(impact.eligible_trip_count).toBe(1);
    expect(treePlanter.current).toBe(Math.min(21, Math.round(impact.total_co2_saved_kg)));
    expect(treePlanter.earned).toBe(impact.total_co2_saved_kg >= 21);
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

  it('keeps system logs exportable, redacted, and limited to the three-day retention window', () => {
    const now = new Date('2026-06-06T12:00:00.000Z').getTime();
    const kept = {
      timestamp: new Date(now - SYSTEM_LOG_RETENTION_MS + 1000).toISOString(),
      severity: 'error',
      category: 'failure',
      source: 'web',
      operation: 'trip_playback',
      title: 'Operation failed: trip_playback',
      message: 'Cannot read properties of undefined',
      page: '/trips/1',
      details: sanitizeLogDetail({
        lat: 43.65,
        lng: -79.38,
        address: '123 Private St',
        email: 'driver@example.com',
        phone: '416-555-0123',
        callback: 'https://example.test/callback?token=abc123456789&email=driver@example.com&mode=ok',
        native_platform: true,
        reason: 'Cannot read properties of undefined',
      }),
    };
    const expired = { ...kept, timestamp: new Date(now - SYSTEM_LOG_RETENTION_MS - 1000).toISOString() };
    const pruned = pruneExpiredSystemLogs([expired, kept], now);
    const json = exportSystemLogsJson(pruned);
    const csv = exportSystemLogsCsv(pruned);

    expect(pruned).toEqual([kept]);
    expect(json).toContain('"retention_days": 3');
    expect(json).toContain('Operation failed: trip_playback');
    expect(json).toContain('[redacted]');
    expect(json).not.toContain('43.65');
    expect(json).not.toContain('123 Private St');
    expect(json).not.toContain('driver@example.com');
    expect(json).not.toContain('416-555-0123');
    expect(json).not.toContain('abc123456789');
    expect(json).toContain('native_platform');
    expect(csv).toContain('Operation failed: trip_playback');
  });

  it('does not dispatch system-log update events when reading and pruning logs', () => {
    const values = new Map();
    const now = Date.now();
    const expired = {
      id: 'expired-log',
      timestamp: new Date(now - SYSTEM_LOG_RETENTION_MS - 1000).toISOString(),
      severity: 'info',
      category: 'app',
      source: 'web',
      operation: 'expired',
      title: 'Expired',
      message: '',
      page: '/system-logs',
      details: {},
    };
    const kept = {
      ...expired,
      id: 'kept-log',
      timestamp: new Date(now).toISOString(),
      operation: 'kept',
      title: 'Kept',
    };
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    });
    vi.stubGlobal('window', { dispatchEvent });
    values.set('drivesense_system_logs_v1', JSON.stringify([expired, kept]));

    const logs = getSystemLogs();
    const storedLogs = JSON.parse(values.get('drivesense_system_logs_v1'));

    expect(logs).toEqual([kept]);
    expect(storedLogs).toEqual([kept]);
    expect(storedLogs.some((event) => event.id === 'expired-log')).toBe(false);
    expect(dispatchEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: SYSTEM_LOG_EVENT }));
  });

  it('captures browser resource load failures in the system logger', () => {
    const source = readFileSync(new URL('../systemLog.js', import.meta.url), 'utf8');

    expect(source).toContain('resource_load_failed');
    expect(source).toContain("window.addEventListener('error', logResourceLoadFailure, true)");
    expect(source).toContain('content_security_policy_violation');
    expect(source).toContain('browser_long_task');
    expect(source).toContain("document.addEventListener('invalid', logControlEvent, true)");
    expect(source).toContain("document.addEventListener('paste', logClipboardEvent, true)");
    expect(source).toContain("window.addEventListener('scroll', logScrollEvent, { passive: true })");
  });

  it('captures runtime failures and navigation without leaking query values', () => {
    const errorReportingSource = readFileSync(new URL('../errorReporting.js', import.meta.url), 'utf8');
    const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    const systemLogSource = readFileSync(new URL('../systemLog.js', import.meta.url), 'utf8');

    expect(errorReportingSource).toContain("window.addEventListener('error'");
    expect(errorReportingSource).toContain("window.addEventListener('unhandledrejection'");
    expect(appSource).toContain('search_param_keys');
    expect(appSource).not.toContain('search: location.search');
    expect(systemLogSource).toContain('EMAIL_PATTERN');
    expect(systemLogSource).toContain('PHONE_PATTERN');
    expect(systemLogSource).toContain('TOKEN_PAIR_PATTERN');
  });

  it('verifies settings updates after writes so placeholder controls are visible', () => {
    const source = readFileSync(new URL('../trackingStore.js', import.meta.url), 'utf8');

    expect(source).toContain('settings_update_verified');
    expect(source).toContain('persisted_matches_request');
    expect(source).toContain('unchanged_requested_keys');
    expect(source).toContain('failed_keys');
    expect(source).toContain('no_effect');
    const settingsPageSource = readFileSync(new URL('../../pages/Settings.jsx', import.meta.url), 'utf8');
    const backupSource = readFileSync(new URL('../dataBackup.js', import.meta.url), 'utf8');
    expect(settingsPageSource).not.toContain('localSettings.set(next)');
    expect(backupSource).not.toContain('localSettings.set({ ...localSettings.get(), ...sanitizedSettings })');
  });

  it('logs background operations from native services, notifications, storage, imports, and exports', () => {
    const activitySource = readFileSync(new URL('../activityRecognition.js', import.meta.url), 'utf8');
    const trackingServiceSource = readFileSync(new URL('../trackingService.js', import.meta.url), 'utf8');
    const notificationSource = readFileSync(new URL('../notificationService.js', import.meta.url), 'utf8');
    const storageSource = readFileSync(new URL('../mobileStorage.js', import.meta.url), 'utf8');
    const backupSource = readFileSync(new URL('../dataBackup.js', import.meta.url), 'utf8');
    const nativeDownloadsSource = readFileSync(new URL('../nativeDownloads.js', import.meta.url), 'utf8');
    const pdfExportSource = readFileSync(new URL('../pdfExport.js', import.meta.url), 'utf8');
    const tripEngineSource = readFileSync(new URL('../tripEngine.js', import.meta.url), 'utf8');
    const systemLogsPageSource = readFileSync(new URL('../../pages/SystemLogs.jsx', import.meta.url), 'utf8');
    const settingsPageSource = readFileSync(new URL('../../pages/Settings.jsx', import.meta.url), 'utf8');

    expect(activitySource).toContain('android_native_auto_tracking_started');
    expect(activitySource).toContain('android_phone_usage_summary_loaded');
    expect(trackingServiceSource).toContain('tracking_service_started');
    expect(trackingServiceSource).toContain('background_location_watcher');
    expect(notificationSource).toContain('notification_scheduled');
    expect(notificationSource).toContain('notification_batch_scheduled');
    expect(storageSource).toContain('storage_set_json');
    expect(backupSource).toContain('backup_import_completed');
    expect(backupSource).toContain('backup_export_completed');
    expect(backupSource).toContain('backup_export_encryption_started');
    expect(backupSource).toContain('backup_plaintext_export_selected');
    expect(backupSource).toContain('backup_import_format_detected');
    expect(backupSource).toContain('backup_import_password_required');
    expect(backupSource).toContain('backup_import_wrong_password');
    expect(backupSource).toContain('backup_import_decrypted');
    expect(settingsPageSource).toContain('backup_export_dialog_opened');
    expect(settingsPageSource).toContain('backup_export_user_notified');
    expect(settingsPageSource).toContain('backup_import_unlock_dialog_opened');
    expect(settingsPageSource).toContain('backup_import_wrong_password_notice_shown');
    expect(settingsPageSource).toContain('BACKUP_IMPORT_ACCEPT');
    expect(settingsPageSource).toContain('application/octet-stream');
    expect(settingsPageSource).toContain('*/*');
    expect(settingsPageSource).toContain('backupPasswordRequirements');
    expect(settingsPageSource).toContain('One capital letter');
    expect(settingsPageSource).toContain('One special character');
    expect(settingsPageSource).toContain('Show backup password');
    expect(nativeDownloadsSource).toContain('native_export_saved');
    expect(tripEngineSource).toContain('csv_export_completed');
    expect(pdfExportSource).toContain('pdf_export_completed');
    expect(systemLogsPageSource).toContain('system_logs_exported');
    expect(systemLogsPageSource).toContain('saveExportToDownloads');
    expect(systemLogsPageSource).toContain('All operations');
    expect(systemLogsPageSource).toContain('Last 24 hours');
    expect(systemLogsPageSource).toContain('Next deletion');
    expect(systemLogsPageSource).toContain('Backup events');
    expect(systemLogsPageSource).toContain("{ id: 'backups', label: 'Backups' }");
    expect(systemLogsPageSource).toContain('Decision logs appear here and in exports');
    expect(systemLogsPageSource).toContain('LOG_PAGE_SIZE');
    expect(systemLogsPageSource).toContain('visibleLogs');
    expect(systemLogsPageSource).toContain("storage: 'Storage'");
    expect(systemLogsPageSource).toContain("notification: 'Notifications'");
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

  it('does not hard-code London as the Trip Playback default map center', () => {
    const tripPlaybackSource = readFileSync(new URL('../../components/TripPlayback.jsx', import.meta.url), 'utf8');
    const legacyLondonLat = ['51', '505'].join('.');
    const legacyLondonLng = ['-0', '09'].join('.');

    expect(tripPlaybackSource).not.toContain(legacyLondonLat);
    expect(tripPlaybackSource).not.toContain(legacyLondonLng);
    expect(tripPlaybackSource).toContain('resolveFallbackMapCenter');
    expect(tripPlaybackSource).toContain('last_map_center');
    expect(tripPlaybackSource).toContain('VITE_DEFAULT_MAP_LAT');
    expect(tripPlaybackSource).toContain('VITE_DEFAULT_MAP_LNG');
  });
});
