import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  migrateDefaultSettings,
  reconcileSettingsHydrationSnapshot,
  sanitizeImportedSettings,
  validateSettingsPatch,
} from '@/lib/trackingStore';

describe('tracking store default settings', () => {
  it('keeps external context auto-fetch enabled by default', () => {
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(true);
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
    expect(legacySunset.settings_defaults_version).toBe(10);
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
