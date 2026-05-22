import { describe, expect, it, vi, afterEach } from 'vitest';
import { authService, migrateLegacyAuthTokens } from '@/api/auth';
import { apiClient, getAuthToken } from '@/api/client';
import { parseDriveSenseBackup } from '@/lib/dataBackup';
import { scoreTripAnomaly } from '@/lib/driverAnomaly';
import { mapMatchRoute } from '@/lib/mapMatching';
import { mergePhoneUseSignals } from '@/lib/phoneUsageAccess';
import { resetRetryCircuits, withRetry } from '@/lib/retry';
import { buildSensorFusionSummary } from '@/lib/sensorFusionModel';
import { sanitizeImportedSettings, validateSettingsPatch } from '@/lib/trackingStore';
import { detectDrivingEvents } from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';

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
    expect(() => parseDriveSenseBackup('not json')).toThrow('File is not valid JSON');
    expect(() => parseDriveSenseBackup('{}')).toThrow('valid Road Sage backup');
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
    expect(settings.threshold_harsh_brake_ms2).toBe(0.5);
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

  it('returns a stable object from driving-event detection', () => {
    const detection = detectDrivingEvents([]);

    expect(Array.isArray(detection.events)).toBe(true);
    expect(detection.phoneUse).toBeTruthy();
    expect(detection.events.some).toBeTypeOf('function');
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

  it('clamps economics scores and uses vehicle fuel type CO2 factors', () => {
    const gasoline = estimateTripEconomics({ distance_km: 100, eco_driving_score: 50 }, { fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 10 }, {});
    const diesel = estimateTripEconomics({ distance_km: 100, eco_driving_score: 50 }, { fuel_type: 'diesel', fuel_efficiency_l_per_100km: 10 }, {});
    const extreme = estimateTripEconomics({ distance_km: 100, eco_driving_score: 999 }, { fuel_efficiency_l_per_100km: 10 }, {});
    const ev = estimateTripEconomics({ distance_km: 100, eco_driving_score: 80 }, { fuel_type: 'electric' }, {});

    expect(diesel.co2_kg).toBeGreaterThan(gasoline.co2_kg);
    expect(extreme.actual_l_per_100km).toBe(8);
    expect(ev.co2_kg).toBe(0);
    expect(ev.co2_saved_kg).toBe(0);
  });

  it('retries transient external operations once', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('network hiccup'))
      .mockResolvedValueOnce('ok');

    await expect(withRetry('test-service', operation, { delayMs: 0 })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
