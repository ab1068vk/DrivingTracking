import { afterEach, describe, expect, it } from 'vitest';
import {
  chooseHydrationCandidateAfterLocalMutations,
  chooseSettingsHydrationCandidate,
  DEFAULT_SETTINGS,
  localSettings,
  migrateDefaultSettings,
  reconcileSettingsHydrationSnapshot,
  sanitizeImportedSettings,
  validateSettingsPatch,
} from '@/lib/trackingStore';
import { enforceLocalOnlyPatch } from '@/lib/privacyControls';
import { resolveStorageKey } from '@/lib/storageKeyMigration';

describe('tracking store default settings', () => {
  afterEach(() => {
    localSettings.set(DEFAULT_SETTINGS);
  });

  it('keeps external road and weather requests opt-in by default', () => {
    expect(DEFAULT_SETTINGS.external_requests_local_only).toBe(false);
    expect(DEFAULT_SETTINGS.map_tiles_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.reverse_geocoding_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.backend_sync_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.speed_limit_lookup_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.weather_context_enabled).toBe(false);
  });

  it('keeps OSRM route snapping off until an endpoint and consent are saved', () => {
    expect(DEFAULT_SETTINGS.map_matching_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.osrm_map_matching_url).not.toBe('https://router.project-osrm.org');
    expect(DEFAULT_SETTINGS.osrm_data_sharing_consented).toBe(false);
    expect(DEFAULT_SETTINGS.osrm_health_status).toBe('');
    expect(DEFAULT_SETTINGS.osrm_verified_endpoint).toBe('');
    expect(DEFAULT_SETTINGS.osrm_verified_domain).toBe('');
    expect(DEFAULT_SETTINGS.osrm_timeout_ms).toBe(12000);
    expect(sanitizeImportedSettings({
      osrm_map_matching_url: 'https://evil.example.com',
      osrm_data_sharing_consented: true,
      osrm_last_reachable_at: '2026-05-30T12:00:00.000Z',
      osrm_verified_endpoint: 'https://evil.example.com',
      osrm_verified_domain: 'evil.example.com',
      osrm_timeout_ms: 45000,
    }).osrm_map_matching_url).toBeUndefined();
    expect(sanitizeImportedSettings({ osrm_timeout_ms: 45000 }).osrm_timeout_ms).toBe(30000);
    expect(validateSettingsPatch({ osrm_timeout_ms: 5000 })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ osrm_timeout_ms: 4999 })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'http://osrm.example' })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'https://192.168.1.10' })).toMatchObject({ valid: false });
  });

  it('keeps calibration sharing opt-in by default', () => {
    expect(DEFAULT_SETTINGS.calibration_sharing_enabled).toBe(false);
    expect(sanitizeImportedSettings({ calibration_sharing_enabled: true })).toMatchObject({
      calibration_sharing_enabled: true,
    });
  });

  it('defaults biometric session auto-lock to five minutes', () => {
    expect(DEFAULT_SETTINGS.biometric_lock_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.lock_timeout_minutes).toBe(5);
    expect(sanitizeImportedSettings({ biometric_lock_enabled: true })).toMatchObject({
      biometric_lock_enabled: true,
    });
    expect(sanitizeImportedSettings({ lock_timeout_minutes: 15 })).toMatchObject({
      lock_timeout_minutes: 15,
    });
    expect(validateSettingsPatch({ biometric_lock_enabled: true })).toMatchObject({ valid: true });
    expect(sanitizeImportedSettings({ lock_timeout_minutes: 60 })).toMatchObject({
      lock_timeout_minutes: 30,
    });
    expect(validateSettingsPatch({ lock_timeout_minutes: 0 })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ lock_timeout_minutes: 31 })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ lock_timeout_minutes: '' })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ lock_timeout_minutes: null })).toMatchObject({ valid: false });
    expect(sanitizeImportedSettings({ lock_timeout_minutes: '' }).lock_timeout_minutes).toBeUndefined();
  });

  it('keeps pending local settings ahead of stale native hydration', () => {
    const pending = {
      ...DEFAULT_SETTINGS,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
      biometric_lock_enabled: false,
    };
    const staleNative = {
      ...DEFAULT_SETTINGS,
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      biometric_lock_enabled: true,
    };

    const reconciled = reconcileSettingsHydrationSnapshot(staleNative, JSON.stringify(pending));

    expect(reconciled.shouldPersistPending).toBe(true);
    expect(reconciled.settings).toMatchObject({
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      biometric_lock_enabled: false,
    });
  });

  it('does not overwrite corrupted primary settings JSON with defaults during get', () => {
    const settingsKey = resolveStorageKey('drivesense_settings');
    const values = new Map([[settingsKey, '{not-json']]);
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };

    try {
      const recovered = localSettings.get();

      expect(recovered).toMatchObject({
        tracking_mode: DEFAULT_SETTINGS.tracking_mode,
        data_retention_months: DEFAULT_SETTINGS.data_retention_months,
      });
      expect(values.has(settingsKey)).toBe(false);
    } finally {
      if (previousLocalStorage === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previousLocalStorage;
      }
    }
  });

  it('chooses the newest durable settings snapshot over stale native defaults on relaunch', () => {
    const staleNative = {
      ...DEFAULT_SETTINGS,
      onboarding_completed: false,
      dark_mode: 'system',
      _settings_revision: 1,
      _settings_updated_at: '2026-01-01T00:00:00.000Z',
    };
    const savedDuringPreviousSession = {
      ...DEFAULT_SETTINGS,
      onboarding_completed: true,
      dark_mode: 'dark',
      map_tiles_enabled: true,
      _settings_revision: 4,
      _settings_updated_at: '2026-01-01T00:05:00.000Z',
    };

    const chosen = chooseSettingsHydrationCandidate([
      {
        source: 'native_plugin',
        settings: staleNative,
        revision: staleNative._settings_revision,
        updatedAtMs: Date.parse(staleNative._settings_updated_at),
        onboardingCompleted: 0,
        deltaCount: 0,
      },
      {
        source: 'browser_mirror',
        settings: savedDuringPreviousSession,
        revision: savedDuringPreviousSession._settings_revision,
        updatedAtMs: Date.parse(savedDuringPreviousSession._settings_updated_at),
        onboardingCompleted: 1,
        deltaCount: 3,
      },
    ]);

    expect(chosen.source).toBe('browser_mirror');
    expect(chosen.settings).toMatchObject({
      onboarding_completed: true,
      dark_mode: 'dark',
      map_tiles_enabled: true,
    });
  });

  it('chooses hydration candidates deterministically when timestamps are malformed', () => {
    const chosen = chooseSettingsHydrationCandidate([
      {
        source: 'native_plugin',
        revision: 3,
        updatedAtMs: NaN,
        onboardingCompleted: 0,
        deltaCount: 1,
      },
      {
        source: 'browser_mirror',
        revision: 3,
        updatedAtMs: 'not-a-date',
        onboardingCompleted: 1,
        deltaCount: 0,
      },
    ]);

    expect(chosen.source).toBe('browser_mirror');
  });

  it('keeps local settings saved during native hydration from being overwritten', () => {
    const staleNative = {
      ...DEFAULT_SETTINGS,
      dark_mode: 'system',
      map_tiles_enabled: false,
      _settings_revision: 9,
      _settings_updated_at: '2026-01-01T00:00:00.000Z',
    };
    const savedDuringHydration = {
      ...DEFAULT_SETTINGS,
      dark_mode: 'dark',
      map_tiles_enabled: true,
      _settings_revision: 1,
      _settings_updated_at: '2026-01-01T00:01:00.000Z',
    };

    const chosen = chooseHydrationCandidateAfterLocalMutations(
      {
        source: 'native_plugin',
        settings: staleNative,
        revision: staleNative._settings_revision,
        updatedAtMs: Date.parse(staleNative._settings_updated_at),
        onboardingCompleted: 0,
        deltaCount: 0,
      },
      0,
      1,
      [
        {
          source: 'runtime_memory',
          settings: savedDuringHydration,
          revision: savedDuringHydration._settings_revision,
          updatedAtMs: Date.parse(savedDuringHydration._settings_updated_at),
          onboardingCompleted: 0,
          deltaCount: 2,
        },
      ]
    );

    expect(chosen.source).toBe('runtime_memory');
    expect(chosen.settings).toMatchObject({
      dark_mode: 'dark',
      map_tiles_enabled: true,
    });
  });

  it('strips settings revision metadata from imported backups', () => {
    const sanitized = sanitizeImportedSettings({
      _settings_revision: 999,
      _settings_updated_at: '2099-01-01T00:00:00.000Z',
      dark_mode: 'dark',
    });

    expect(sanitized).toMatchObject({
      dark_mode: 'dark',
    });
    expect(sanitized._settings_revision).toBeUndefined();
    expect(sanitized._settings_updated_at).toBeUndefined();
  });

  it('stores the last map center as an opt-in contextual fallback', () => {
    expect(DEFAULT_SETTINGS.last_map_center).toBeNull();

    expect(sanitizeImportedSettings({
      last_map_center: {
        lat: '43.6532',
        lng: '-79.3832',
        tripId: 'trip-1',
        source: 'trip_playback',
        updated_at: '2026-05-30T12:00:00.000Z',
      },
    }).last_map_center).toMatchObject({
      lat: 43.6532,
      lng: -79.3832,
      tripId: 'trip-1',
      source: 'trip_playback',
    });

    expect(sanitizeImportedSettings({
      last_map_center: { lat: 91, lng: -181 },
    }).last_map_center).toBeUndefined();
    expect(sanitizeImportedSettings({
      last_map_center: { lat: 0, lng: 0 },
    }).last_map_center).toBeUndefined();
  });

  it('keeps inferred speed-limit country defaults configurable', () => {
    expect(DEFAULT_SETTINGS.country_code).toBe('');
    expect(DEFAULT_SETTINGS.configurable_country_defaults).toBe('global');
    expect(sanitizeImportedSettings({ configurable_country_defaults: 'gb' })).toMatchObject({
      configurable_country_defaults: 'gb',
    });
    expect(sanitizeImportedSettings({ country_code: 'GB' })).toMatchObject({
      country_code: 'GB',
    });
    expect(sanitizeImportedSettings({ configurable_country_defaults: 'mars' }).configurable_country_defaults).toBeUndefined();
  });

  it('keeps the rapid acceleration minimum speed at 5 km/h', () => {
    expect(DEFAULT_SETTINGS.min_speed_rapid_accel_kmh).toBe(5);
  });

  it('defines and validates voice profile defaults', () => {
    expect(DEFAULT_SETTINGS.voice_alert_rate).toBe(1.0);
    expect(DEFAULT_SETTINGS.voice_alert_volume).toBe(0.9);
    expect(DEFAULT_SETTINGS.voice_alerts_min_severity).toBe(1);
    expect(DEFAULT_SETTINGS.voice_earcon_enabled).toBe(true);
    expect(DEFAULT_SETTINGS.voice_quiet_hours_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.voice_quiet_hours_start).toBe('22:00');
    expect(DEFAULT_SETTINGS.voice_quiet_hours_end).toBe('06:00');

    expect(sanitizeImportedSettings({
      voice_alert_rate: 1.2,
      voice_alert_volume: 0.2,
      voice_alerts_min_severity: 4,
      voice_earcon_enabled: false,
      voice_quiet_hours_start: '23:30',
    })).toMatchObject({
      voice_alert_rate: 1.2,
      voice_alert_volume: 0.3,
      voice_alerts_min_severity: 3,
      voice_earcon_enabled: false,
      voice_quiet_hours_start: '23:30',
    });
    expect(validateSettingsPatch({ voice_alert_rate: 1.2 })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ voice_alert_rate: 1.3 })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ voice_alerts_min_severity: 4 })).toMatchObject({ valid: false });
  });

  it('defines configurable CO2 economics defaults', () => {
    expect(DEFAULT_SETTINGS.currencySymbol).toBe('$');
    expect(DEFAULT_SETTINGS.co2_baseline_kg_per_100km).toBe(12);
    expect(DEFAULT_SETTINGS.default_ev_kwh_per_100km).toBe(18);
    expect(DEFAULT_SETTINGS.grid_co2_kg_per_kwh).toBe(0.04);
    expect(DEFAULT_SETTINGS.tree_co2_kg_per_year).toBe(21);
  });

  it('defines configurable eco scoring defaults', () => {
    expect(DEFAULT_SETTINGS.threshold_eco_cruise_min_kmh).toBe(55);
    expect(DEFAULT_SETTINGS.threshold_eco_cruise_max_kmh).toBe(110);
    expect(DEFAULT_SETTINGS.eco_cruise_score_multiplier).toBe(130);
    expect(DEFAULT_SETTINGS.eco_idle_penalty_multiplier).toBe(150);
    expect(DEFAULT_SETTINGS.eco_idle_max_penalty).toBe(25);
    expect(DEFAULT_SETTINGS.eco_min_moving_kmh).toBe(15);
  });

  it('uses the shared fixed-hour night fallback by default', () => {
    expect(DEFAULT_SETTINGS.night_start_time).toBe('22:00');
    expect(DEFAULT_SETTINGS.night_end_time).toBe('05:00');
  });

  it('migrates legacy sunset defaults without overwriting custom night windows', () => {
    const legacySunset = migrateDefaultSettings({
      settings_defaults_version: 2,
      night_detection_mode: 'sunset',
      night_start_time: '22:00',
      night_end_time: '06:00',
    }).settings;
    const legacyCustom = migrateDefaultSettings({
      settings_defaults_version: 2,
      night_detection_mode: 'custom',
      night_start_time: '22:00',
      night_end_time: '06:00',
    }).settings;

    expect(legacySunset.night_end_time).toBe('05:00');
    expect(legacySunset.settings_defaults_version).toBe(12);
    expect(legacyCustom.night_end_time).toBe('06:00');
  });

  it('defaults local trip retention to 24 months and migrates legacy day values', () => {
    expect(DEFAULT_SETTINGS.data_retention_months).toBe(24);
    expect(DEFAULT_SETTINGS.data_retention_days).toBeUndefined();

    const migrated = migrateDefaultSettings({
      settings_defaults_version: 7,
      data_retention_days: 365,
    });

    expect(migrated.settings.data_retention_months).toBe(12);
    expect(migrated.settings.data_retention_days).toBeUndefined();
    expect(migrated.changed).toBe(true);
    expect(sanitizeImportedSettings({ data_retention_days: 730 }).data_retention_months).toBe(24);
    expect(sanitizeImportedSettings({ data_retention_months: 36 }).data_retention_months).toBe(36);
    expect(validateSettingsPatch({ data_retention_months: 0 })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ data_retention_months: -1 })).toMatchObject({ valid: false });
  });

  it('migrates older defaulted external context settings back to opt-in', () => {
    const migrated = migrateDefaultSettings({
      settings_defaults_version: 10,
      external_context_auto_fetch_enabled: true,
      speed_limit_lookup_enabled: true,
      weather_context_enabled: true,
      map_tiles_enabled: true,
      reverse_geocoding_enabled: true,
      backend_sync_enabled: true,
    });

    expect(migrated.settings).toMatchObject({
      external_context_auto_fetch_enabled: false,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      map_tiles_enabled: false,
      reverse_geocoding_enabled: false,
      backend_sync_enabled: false,
      settings_defaults_version: 12,
    });
    expect(migrated.changed).toBe(true);
  });

  it('local-only mode disables every nonessential external request toggle', () => {
    const migrated = migrateDefaultSettings({
      settings_defaults_version: 12,
      external_requests_local_only: true,
      map_tiles_enabled: true,
      speed_limit_lookup_enabled: true,
      weather_context_enabled: true,
      external_context_auto_fetch_enabled: true,
      map_matching_enabled: true,
      osrm_data_sharing_consented: true,
      calibration_sharing_enabled: true,
      backend_sync_enabled: true,
      reverse_geocoding_enabled: true,
    }).settings;

    expect(migrated).toMatchObject({
      external_requests_local_only: true,
      map_tiles_enabled: false,
      speed_limit_lookup_enabled: false,
      weather_context_enabled: false,
      external_context_auto_fetch_enabled: false,
      map_matching_enabled: false,
      osrm_data_sharing_consented: false,
      calibration_sharing_enabled: false,
      backend_sync_enabled: false,
      reverse_geocoding_enabled: false,
      road_data_fetch_always_allow: false,
    });
  });

  it('enforceLocalOnlyPatch clears road-data always-allow', () => {
    expect(enforceLocalOnlyPatch({
      external_requests_local_only: true,
      road_data_fetch_always_allow: true,
    }).road_data_fetch_always_allow).toBe(false);
  });

  it('backup import sanitization cannot disable active local-only mode', () => {
    const result = sanitizeImportedSettings({
      external_requests_local_only: false,
      map_tiles_enabled: true,
      backend_sync_enabled: true,
      road_data_fetch_always_allow: true,
    }, {
      ...DEFAULT_SETTINGS,
      external_requests_local_only: true,
    });

    expect(result).toMatchObject({
      external_requests_local_only: true,
      map_tiles_enabled: false,
      backend_sync_enabled: false,
      road_data_fetch_always_allow: false,
    });
  });

  it('backup import can enable local-only mode from the imported snapshot', () => {
    const result = sanitizeImportedSettings({
      external_requests_local_only: true,
      map_tiles_enabled: true,
      backend_sync_enabled: true,
      road_data_fetch_always_allow: true,
    }, DEFAULT_SETTINGS);

    expect(result).toMatchObject({
      external_requests_local_only: true,
      map_tiles_enabled: false,
      backend_sync_enabled: false,
      road_data_fetch_always_allow: false,
    });
  });

  it('strips imported settings_defaults_version from backups', () => {
    const sanitized = sanitizeImportedSettings({
      ...DEFAULT_SETTINGS,
      settings_defaults_version: 999,
      units: 'imperial',
    });

    expect(sanitized.settings_defaults_version).toBeUndefined();
    expect(sanitized.units).toBe('imperial');
    expect(migrateDefaultSettings(sanitized).settings.settings_defaults_version).toBe(DEFAULT_SETTINGS.settings_defaults_version);
  });

  it('local-only mode is enforced when persisted settings already have it active', () => {
    localSettings.set({
      ...DEFAULT_SETTINGS,
      external_requests_local_only: true,
      map_tiles_enabled: false,
      speed_limit_lookup_enabled: false,
    });

    localSettings.set({
      ...localSettings.get(),
      map_tiles_enabled: true,
      speed_limit_lookup_enabled: true,
    });

    expect(localSettings.get()).toMatchObject({
      external_requests_local_only: true,
      map_tiles_enabled: false,
      speed_limit_lookup_enabled: false,
    });
  });

  it('allows local-only mode to be explicitly disabled', () => {
    localSettings.set({
      ...DEFAULT_SETTINGS,
      external_requests_local_only: true,
      map_tiles_enabled: false,
    });

    localSettings.set({
      ...localSettings.get(),
      external_requests_local_only: false,
      map_tiles_enabled: true,
    });

    expect(localSettings.get()).toMatchObject({
      external_requests_local_only: false,
      map_tiles_enabled: true,
    });
  });

  it('migrates nullish inputs and strips dangerous unknown keys', () => {
    expect(migrateDefaultSettings(null).settings).toMatchObject(DEFAULT_SETTINGS);
    expect(migrateDefaultSettings(undefined).settings).toMatchObject(DEFAULT_SETTINGS);
    expect(migrateDefaultSettings([]).settings).toMatchObject(DEFAULT_SETTINGS);

    const migrated = migrateDefaultSettings(JSON.parse('{"constructor":{"prototype":{"polluted":true}},"__proto__":{"polluted":true},"units":"imperial"}')).settings;
    expect(migrated.units).toBe('imperial');
    expect(Object.prototype.polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(migrated, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated, '__proto__')).toBe(false);
  });

  it('migrates unsupported proxy setting names to neutral metric names', () => {
    const migrated = migrateDefaultSettings({
      settings_defaults_version: 3,
      threshold_tailgate_decel_ms2: 3,
      threshold_near_miss_brake_ms2: 4.5,
      threshold_near_miss_turn_degs: 35,
      threshold_drowsy_heading_std: 10,
      notif_drowsy_alert_enabled: false,
    }).settings;

    expect(migrated.threshold_stop_start_decel_ms2).toBe(3);
    expect(migrated.threshold_manoeuvre_alert_brake_ms2).toBe(4.5);
    expect(migrated.threshold_manoeuvre_alert_turn_degs).toBe(35);
    expect(migrated.threshold_heading_drift_std_degs).toBe(10);
    expect(migrated.notif_heading_drift_alert_enabled).toBe(false);
    expect(migrated.threshold_tailgate_decel_ms2).toBeUndefined();
    expect(migrated.threshold_near_miss_brake_ms2).toBeUndefined();
    expect(migrated.threshold_drowsy_heading_std).toBeUndefined();
  });

  it('preserves renamed metric thresholds from older imported backups', () => {
    const sanitized = sanitizeImportedSettings({
      threshold_tailgate_decel_ms2: 3,
      threshold_near_miss_brake_ms2: 4.5,
      threshold_near_miss_turn_degs: 35,
      threshold_drowsy_heading_std: 10,
      notif_drowsy_alert_enabled: false,
    });

    expect(sanitized).toMatchObject({
      threshold_stop_start_decel_ms2: 3,
      threshold_manoeuvre_alert_brake_ms2: 4.5,
      threshold_manoeuvre_alert_turn_degs: 35,
      threshold_heading_drift_std_degs: 10,
      notif_heading_drift_alert_enabled: false,
    });
  });

  it('raises GPS phone proxy defaults for diagnostic-only collection', () => {
    const migrated = migrateDefaultSettings({
      settings_defaults_version: 4,
      threshold_phone_proxy_oscillations: 3,
      phone_micro_steer_count: 4,
      threshold_overtake_accel_ms2: 2,
    }).settings;

    expect(DEFAULT_SETTINGS.phone_micro_steer_count).toBe(6);
    expect(DEFAULT_SETTINGS.phone_micro_steer_window_s).toBe(15);
    expect(migrated.phone_micro_steer_count).toBe(6);
    expect(migrated.phone_proxy_max_accuracy_m).toBe(20);
    expect(migrated.threshold_overtake_accel_ms2).toBe(3);
    expect(sanitizeImportedSettings({ threshold_overtake_accel_ms2: 2 }).threshold_overtake_accel_ms2).toBe(3);
  });
});
