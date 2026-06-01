import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { authService, migrateLegacyAuthTokens } from '@/api/auth';
import { apiClient, getAuthToken } from '@/api/client';
import { importDriveSenseBackup, MAX_BACKUP_BYTES, parseDriveSenseBackup } from '@/lib/dataBackup';
import { scoreTripAnomaly } from '@/lib/driverAnomaly';
import { logError } from '@/lib/errorReporting';
import { localTripRepository } from '@/lib/localTripRepository';
import { getBestMapCenter } from '@/lib/mapDefaults';
import { mapMatchRoute } from '@/lib/mapMatching';
import { formatDataSourceLabel, METRIC_REGISTRY } from '@/lib/metricRegistry';
import { buildOpenSourceTripContextPatch } from '@/lib/openSourceTripContext';
import { mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { maskTripForPrivacy } from '@/lib/privacyZones';
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

const readNonTestSourceFiles = (dirUrl) => {
  const files = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const childUrl = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dirUrl);
    if (entry.isDirectory()) {
      files.push(...readNonTestSourceFiles(childUrl));
      continue;
    }
    if (!/\.(js|jsx)$/.test(entry.name)) continue;
    if (statSync(childUrl).isFile()) files.push(childUrl);
  }
  return files;
};

describe('release blocker regressions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRetryCircuits();
  });

  it('does not read auth tokens from localStorage', () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'local-token') });

    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem).not.toHaveBeenCalled();
  });

  it('removes auth tokens from all browser storage on logout', () => {
    vi.stubGlobal('localStorage', { removeItem: vi.fn() });

    authService.logout();

    expect(localStorage.removeItem).toHaveBeenCalledWith('token');
    expect(localStorage.removeItem).toHaveBeenCalledWith('access_token');
  });

  it('clears legacy localStorage auth tokens instead of migrating them into readable storage', () => {
    const legacyTokens = new Map([
      ['token', 'legacy-token'],
      ['access_token', 'legacy-access-token'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => legacyTokens.get(key) ?? null),
      removeItem: vi.fn((key) => legacyTokens.delete(key)),
    });

    migrateLegacyAuthTokens();

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('access_token')).toBeNull();
  });

  it('leaves no auth token readable from localStorage after migration', () => {
    const legacyTokens = new Map([['token', 'legacy-token']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => legacyTokens.get(key) ?? null),
      removeItem: vi.fn((key) => legacyTokens.delete(key)),
    });

    migrateLegacyAuthTokens();

    const xssReadableToken = localStorage.getItem('token') || localStorage.getItem('access_token');
    expect(xssReadableToken).toBeNull();
  });

  it('does not keep a legacy auth token when browser storage is writable', () => {
    const legacyTokens = new Map([['token', 'legacy-token']]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => legacyTokens.get(key) ?? null),
      removeItem: vi.fn((key) => legacyTokens.delete(key)),
    });

    migrateLegacyAuthTokens();

    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.removeItem).toHaveBeenCalledWith('token');
  });

  it('fails API calls clearly when no backend is configured', async () => {
    vi.stubGlobal('fetch', vi.fn());

    await expect(apiClient.get('/trips')).rejects.toThrow('No backend API configured');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contains no frontend bearer-token storage or authorization header logic', () => {
    const authSource = readFileSync(new URL('../../api/auth.js', import.meta.url), 'utf8');
    const clientSource = readFileSync(new URL('../../api/client.js', import.meta.url), 'utf8');

    expect(`${authSource}\n${clientSource}`).not.toMatch(/sessionStorage\.(getItem|setItem)/);
    expect(clientSource).toContain('credentials: "include"');
    expect(clientSource).not.toContain('Authorization');
    expect(clientSource).not.toContain('Bearer');
  });

  it('keeps diagnostics routes development-only without an environment escape hatch', () => {
    const appSource = readFileSync(new URL('../../App.jsx', import.meta.url), 'utf8');
    const layoutSource = readFileSync(new URL('../../components/Layout.jsx', import.meta.url), 'utf8');
    const diagnosticsSource = readFileSync(new URL('../../pages/Diagnostics.jsx', import.meta.url), 'utf8');
    const workflowSource = readFileSync(new URL('../../../.github/workflows/security-ci.yml', import.meta.url), 'utf8');

    expect(`${appSource}\n${layoutSource}`).not.toContain('VITE_SHOW_DEBUG_ROUTES');
    expect(appSource).toContain('const showDebugRoutes = import.meta.env.DEV;');
    expect(appSource).toContain('{showDebugRoutes && Diagnostics && <Route path="/diagnostics"');
    expect(layoutSource).toContain('const debugNavItems = import.meta.env.DEV');
    expect(diagnosticsSource).toContain('if (!import.meta.env.DEV)');
    expect(diagnosticsSource).toContain('return <PageNotFound />');
    expect(workflowSource).toContain('Verify debug routes are absent from production bundle');
  });

  it('clears parked-widget map caches when privacy zones change', () => {
    const privacyZoneStoreSource = readFileSync(
      new URL('../../../android/app/src/main/java/com/roadsage/app/PrivacyZoneStore.java', import.meta.url),
      'utf8'
    );
    const mapWorkerSource = readFileSync(
      new URL('../../../android/app/src/main/java/com/roadsage/app/MapTileFetchWorker.java', import.meta.url),
      'utf8'
    );
    const widgetSource = readFileSync(
      new URL('../../../android/app/src/main/java/com/roadsage/app/ParkedCarWidgetProvider.java', import.meta.url),
      'utf8'
    );

    expect(privacyZoneStoreSource).toContain('MapTileFetchWorker.clearWidgetMapCache(context);');
    expect(privacyZoneStoreSource).toContain('ParkedCarWidgetProvider.refreshAll(context);');
    expect(mapWorkerSource).toContain('private static final String MAP_CACHE_PREFIX = "widget_map_"');
    expect(mapWorkerSource).toContain('private static final String LEGACY_MAP_CACHE_PREFIX = "parked_map_widget_"');
    expect(mapWorkerSource).toContain('static void clearWidgetMapCache(Context context)');
    expect(mapWorkerSource).toContain('deleteCacheForWidgetAndLocation(context, widgetId, lat, lng);');
    expect(widgetSource).toContain('MapTileFetchWorker.deleteCacheForWidgetAndLocation(context, widgetId, lat, lng);');
  });

  it('stores route-risk history as coarse hashes instead of GPS coordinates', () => {
    const constantsSource = readFileSync(new URL('../routeRisk/constants.js', import.meta.url), 'utf8');
    const segmentKeySource = readFileSync(new URL('../routeRisk/segmentKey.js', import.meta.url), 'utf8');
    const aggregateSource = readFileSync(new URL('../routeRisk/aggregate.js', import.meta.url), 'utf8');
    const storageSource = readFileSync(new URL('../routeRisk/storage.js', import.meta.url), 'utf8');
    const tripCellsSource = readFileSync(new URL('../routeRisk/tripCells.js', import.meta.url), 'utf8');
    const repositorySource = readFileSync(new URL('../localTripRepository.js', import.meta.url), 'utf8');

    expect(constantsSource).toContain('ROUTE_RISK_GEOHASH_PRECISION = 5');
    expect(constantsSource).toContain('ROUTE_RISK_INDEX_SCHEMA_VERSION = 3');
    expect(segmentKeySource).toContain('geohashEncode');
    expect(segmentKeySource).toContain('not exact endpoint coordinates');
    expect(aggregateSource).toContain('sanitizeRouteRiskCellForStorage');
    expect(aggregateSource).toContain('lat,');
    expect(aggregateSource).toContain('lng,');
    expect(aggregateSource).toContain('segmentKeys,');
    expect(storageSource).toContain('sanitizeRouteRiskCellForStorage(value, key)');
    expect(tripCellsSource).not.toContain('cell.segmentKeys');
    expect(repositorySource).toContain('sanitizeTripRouteRiskCells');
    expect(repositorySource).toContain('route_risk_cells: trip.route_risk_cells');
  });

  it('keeps html2canvas out of direct PDF export capture paths without sanitizer coverage', () => {
    const exportPdfSource = readFileSync(new URL('../../engine/export/pdf.js', import.meta.url), 'utf8');
    const pdfExportSource = readFileSync(new URL('../pdfExport.js', import.meta.url), 'utf8');
    const sanitizerSource = readFileSync(new URL('../pdfSanitize.js', import.meta.url), 'utf8');

    expect(`${exportPdfSource}\n${pdfExportSource}`).not.toMatch(/import\s+html2canvas\s+from\s+['"]html2canvas['"]/);
    expect(`${exportPdfSource}\n${pdfExportSource}`).not.toContain('html2canvas(');
    expect(exportPdfSource).toContain('SECURITY-HOLD: html2canvas is pinned');
    expect(sanitizerSource).toContain('foreignObject');
    expect(sanitizerSource).toContain('cloneForCapture');
    expect(sanitizerSource).toContain('javascript:');
  });

  it('blocks raw HTML markdown plugins from trip-note rendering paths', () => {
    const eslintSource = readFileSync(new URL('../../../eslint.config.js', import.meta.url), 'utf8');
    const tripDetailSource = readFileSync(new URL('../../pages/TripDetail.jsx', import.meta.url), 'utf8');
    const sourceFiles = [
      tripDetailSource,
      readFileSync(new URL('../../components/TripCard.jsx', import.meta.url), 'utf8'),
      readFileSync(new URL('../../pages/Dashboard.jsx', import.meta.url), 'utf8'),
      readFileSync(new URL('../../pages/DrivingCoach.jsx', import.meta.url), 'utf8'),
    ].join('\n');

    expect(eslintSource).toContain('"no-restricted-imports"');
    expect(eslintSource).toContain('name: "rehype-raw"');
    expect(eslintSource).toContain('rehype-raw is banned');
    expect(sourceFiles).not.toContain('rehypeRaw');
    expect(sourceFiles).not.toContain('remarkHtml');
    expect(sourceFiles).not.toContain('dangerouslySetInnerHTML');
    expect(tripDetailSource).toContain('trip.notes is user-controlled');
    expect(tripDetailSource).toContain('Do not render it through raw HTML or rehype-raw');
    expect(tripDetailSource).toContain('<div>{trip.notes}</div>');
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

    expect(result).toBeNull();
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
    const events = JSON.parse(values.get('road_sage_tracking_diagnostics'));

    expect(diagnostic).toMatchObject({
      type: 'operation_error',
      context: 'post_trip_completed_notification',
      detail: 'notification failed',
      tripId: 'trip-1',
    });
    expect(events[0]).toMatchObject(diagnostic);
  });

  it('keeps logError extra objects free of raw location-bearing keys', () => {
    const forbiddenKeys = /\b(lat|lng|lon|latitude|longitude|coordinates|coords|route_points|routePoints|raw_route_points|address|geocode|reverse_geocode|reverseGeocode)\s*:/;
    const offenders = [];

    for (const fileUrl of readNonTestSourceFiles(new URL('../../', import.meta.url))) {
      const source = readFileSync(fileUrl, 'utf8');
      let searchFrom = 0;
      while (true) {
        const start = source.indexOf('logError(', searchFrom);
        if (start === -1) break;
        const end = source.indexOf(');', start);
        const call = source.slice(start, end === -1 ? start + 600 : end);
        if (/logError\s*\([\s\S]*?,[\s\S]*?,\s*\{/.test(call) && forbiddenKeys.test(call)) {
          offenders.push(`${fileUrl.pathname}: ${call.slice(0, 180)}`);
        }
        searchFrom = start + 'logError('.length;
      }
    }

    expect(offenders).toEqual([]);
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
    expect(tripDetailSource).toContain(
      '<TripScoreOverview trip={trip} completedTripCount={completedTripCountForBaseline} />',
    );
    expect(dashboardSource).toContain('context="dashboard_risk_panel"');
    expect(dashboardSource).toContain('<DashboardRiskPanel');
    expect(tripMapSource).toContain('context="trip_map"');
    expect(tripMapSource).toContain('function TripMapContent');
    expect(tripPlaybackSource).toContain('context="trip_playback"');
    expect(tripPlaybackSource).toContain('function TripPlaybackContent');
  });

  it('returns null map center when no trip, parked location, or known location exists', () => {
    expect(getBestMapCenter({ trip: null, lastParked: null, lastKnownLocation: null })).toBeNull();
  });

  it('prefers trip route midpoint over parked location', () => {
    const center = getBestMapCenter({
      trip: { route_points: [{ lat: 51.5, lng: -0.1 }, { lat: 52.0, lng: -0.5 }] },
      lastParked: { lat: 43.6, lng: -79.4 },
      lastKnownLocation: null,
    });

    expect(center[0]).toBeCloseTo(51.75, 1);
  });
});
