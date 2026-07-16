import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPERIENCE_MODE,
  DEFAULT_SETTINGS,
  DEFAULT_VOICE_ALERT_STYLE,
  EXPERIENCE_MODES,
  SETTINGS_CHANGED_EVENT,
  VOICE_ALERT_STYLES,
  isTrackingExperienceMode,
  localSettings,
  migrateDefaultSettings,
  sanitizeImportedSettings,
  validateSettingsPatch,
} from '@/lib/trackingStore';

// CHANGES (session):
// - Added validation coverage for blank numeric setting drafts during input editing.

describe('tracking store default settings', () => {
  it('defaults to coaching experience mode and normalizes invalid saved values', () => {
    expect(DEFAULT_EXPERIENCE_MODE).toBe(EXPERIENCE_MODES.COACHING);
    expect(DEFAULT_SETTINGS.experience_mode).toBe(EXPERIENCE_MODES.COACHING);
    expect(isTrackingExperienceMode(DEFAULT_SETTINGS)).toBe(false);
    expect(isTrackingExperienceMode({ experience_mode: EXPERIENCE_MODES.TRACKING })).toBe(true);

    expect(migrateDefaultSettings({
      settings_defaults_version: 16,
    })).toMatchObject({
      changed: true,
      settings: {
        settings_defaults_version: 18,
        experience_mode: EXPERIENCE_MODES.COACHING,
      },
    });
    expect(migrateDefaultSettings({
      settings_defaults_version: 17,
      experience_mode: 'flight_deck',
    })).toMatchObject({
      changed: true,
      settings: {
        settings_defaults_version: 18,
        experience_mode: EXPERIENCE_MODES.COACHING,
      },
    });
    expect(migrateDefaultSettings({
      settings_defaults_version: 18,
      experience_mode: EXPERIENCE_MODES.TRACKING,
      voice_alert_style: VOICE_ALERT_STYLES.MODE_DEFAULT,
    })).toMatchObject({
      changed: false,
      settings: {
        experience_mode: EXPERIENCE_MODES.TRACKING,
      },
    });
    expect(sanitizeImportedSettings({ experience_mode: EXPERIENCE_MODES.TRACKING })).toMatchObject({
      experience_mode: EXPERIENCE_MODES.TRACKING,
    });
    expect(sanitizeImportedSettings({ experience_mode: 'invalid' })).not.toHaveProperty('experience_mode');
    expect(validateSettingsPatch({ experience_mode: EXPERIENCE_MODES.TRACKING })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ experience_mode: 'invalid' })).toMatchObject({ valid: false });

    const previousMode = localSettings.get().experience_mode;
    try {
      localSettings.update({ experience_mode: EXPERIENCE_MODES.TRACKING });
      expect(localSettings.get().experience_mode).toBe(EXPERIENCE_MODES.TRACKING);
    } finally {
      localSettings.update({ experience_mode: previousMode });
    }
  });

  it('defaults voice alert style to mode default and validates overrides', () => {
    expect(DEFAULT_VOICE_ALERT_STYLE).toBe(VOICE_ALERT_STYLES.MODE_DEFAULT);
    expect(DEFAULT_SETTINGS.voice_alert_style).toBe(VOICE_ALERT_STYLES.MODE_DEFAULT);
    expect(migrateDefaultSettings({
      settings_defaults_version: 17,
    })).toMatchObject({
      changed: true,
      settings: {
        settings_defaults_version: 18,
        voice_alert_style: VOICE_ALERT_STYLES.MODE_DEFAULT,
      },
    });
    expect(migrateDefaultSettings({
      settings_defaults_version: 18,
      voice_alert_style: 'robot',
    })).toMatchObject({
      changed: true,
      settings: {
        voice_alert_style: VOICE_ALERT_STYLES.MODE_DEFAULT,
      },
    });
    expect(sanitizeImportedSettings({ voice_alert_style: VOICE_ALERT_STYLES.TECHNICAL })).toMatchObject({
      voice_alert_style: VOICE_ALERT_STYLES.TECHNICAL,
    });
    expect(sanitizeImportedSettings({ voice_alert_style: 'invalid' })).not.toHaveProperty('voice_alert_style');
    expect(validateSettingsPatch({ voice_alert_style: VOICE_ALERT_STYLES.COACHING })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ voice_alert_style: 'invalid' })).toMatchObject({ valid: false });
  });

  it('keeps external context auto-fetch off until the user approves it', () => {
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_consented_at).toBe('');

    const migrated = migrateDefaultSettings({
      settings_defaults_version: 8,
      external_context_auto_fetch_enabled: true,
      external_context_auto_fetch_consented_at: '2026-06-01T12:00:00.000Z',
    }).settings;
    expect(migrated.external_context_auto_fetch_enabled).toBe(false);
    expect(migrated.external_context_auto_fetch_consented_at).toBe('');
    expect(sanitizeImportedSettings({
      external_context_auto_fetch_enabled: true,
      external_context_auto_fetch_consented_at: '2026-06-01T12:00:00.000Z',
    })).not.toHaveProperty('external_context_auto_fetch_enabled');
  });

  it('defaults heightened privacy mode on and does not import it from backups', () => {
    expect(DEFAULT_SETTINGS.heightened_privacy_mode).toBe(true);
    expect(migrateDefaultSettings({
      settings_defaults_version: 13,
    }).settings).toMatchObject({
      settings_defaults_version: 18,
      heightened_privacy_mode: true,
      weather_context_enabled: false,
      speed_limit_lookup_enabled: false,
      map_matching_enabled: false,
      osrm_data_sharing_consented: false,
    });
    expect(sanitizeImportedSettings({
      heightened_privacy_mode: true,
    })).not.toHaveProperty('heightened_privacy_mode');
    expect(validateSettingsPatch({ heightened_privacy_mode: true })).toEqual({ valid: true, errors: [] });
  });

  it('keeps OSRM route snapping off until an endpoint and consent are saved', () => {
    // Checklist: "Confirm Settings rejects or blocks public OSRM demo use for saved settings."
    expect(DEFAULT_SETTINGS.map_matching_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.osrm_map_matching_url).not.toBe('https://router.project-osrm.org');
    expect(DEFAULT_SETTINGS.osrm_data_sharing_consented).toBe(false);
    expect(DEFAULT_SETTINGS.osrm_health_status).toBe('');
    expect(DEFAULT_SETTINGS.osrm_timeout_ms).toBe(12000);
    expect(DEFAULT_SETTINGS.osrm_block_near_any_zone).toBe(true);
    expect(migrateDefaultSettings({
      settings_defaults_version: 12,
      osrm_block_near_any_zone: false,
    }).settings.osrm_block_near_any_zone).toBe(true);
    expect(sanitizeImportedSettings({
      osrm_map_matching_url: 'https://evil.example.com',
      osrm_data_sharing_consented: true,
      osrm_last_reachable_at: '2026-05-30T12:00:00.000Z',
      osrm_block_near_any_zone: false,
      osrm_timeout_ms: 45000,
    }).osrm_map_matching_url).toBeUndefined();
    expect(sanitizeImportedSettings({ osrm_block_near_any_zone: false })).not.toHaveProperty('osrm_block_near_any_zone');
    expect(sanitizeImportedSettings({ osrm_timeout_ms: 45000 }).osrm_timeout_ms).toBe(30000);
    expect(validateSettingsPatch({ osrm_timeout_ms: 5000 })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ osrm_timeout_ms: 4999 })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_block_near_any_zone: false })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'https://osrm.example' })).toMatchObject({ valid: true });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'http://localhost:5000' })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'http://osrm.example' })).toMatchObject({ valid: false });
    expect(validateSettingsPatch({ osrm_map_matching_url: 'file:///tmp/osrm' })).toMatchObject({ valid: false });
  });

  it('does not import native privacy sync state from backups', () => {
    expect(DEFAULT_SETTINGS.privacy_zones_native_sync_status).toBe('');
    expect(sanitizeImportedSettings({
      privacy_zones_native_sync_status: 'failed',
      privacy_zones_native_sync_failed_at: '2026-06-08T12:00:00.000Z',
      privacy_zones_native_sync_zone_count: 2,
    })).not.toHaveProperty('privacy_zones_native_sync_status');
  });

  it('blocks screen capture by default and does not restore an insecure backup preference', () => {
    expect(DEFAULT_SETTINGS.allow_screen_capture).toBe(false);
    expect(DEFAULT_SETTINGS.app_lock_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.privacy_zone_storage_requires_secure_device).toBe(true);
    expect(sanitizeImportedSettings({
      allow_screen_capture: true,
      app_lock_enabled: true,
      privacy_zone_storage_requires_secure_device: false,
    })).not.toHaveProperty('allow_screen_capture');
    expect(sanitizeImportedSettings({
      app_lock_enabled: true,
    })).not.toHaveProperty('app_lock_enabled');
    expect(sanitizeImportedSettings({
      privacy_zone_storage_requires_secure_device: false,
    })).not.toHaveProperty('privacy_zone_storage_requires_secure_device');
  });

  it('does not import device integrity status from backups', () => {
    expect(DEFAULT_SETTINGS.rasp_secure).toBe(true);
    expect(DEFAULT_SETTINGS.rasp_threats).toEqual([]);
    expect(DEFAULT_SETTINGS.rasp_checked_at).toBe('');
    expect(sanitizeImportedSettings({
      rasp_secure: false,
      rasp_threats: ['SU_BINARY'],
      rasp_checked_at: '2026-06-11T12:00:00.000Z',
      rasp_native: true,
    })).not.toHaveProperty('rasp_secure');
  });

  it('keeps calibration survey data local only', () => {
    expect(DEFAULT_SETTINGS.calibration_sharing_enabled).toBe(false);
    expect(DEFAULT_SETTINGS.legal_notice_ack_version).toBe(0);
    expect(DEFAULT_SETTINGS.legal_notice_acknowledged_at).toBe('');
    expect(sanitizeImportedSettings({ calibration_sharing_enabled: true })).toMatchObject({
      calibration_sharing_enabled: false,
    });
    expect(migrateDefaultSettings({ calibration_sharing_enabled: true }).settings.calibration_sharing_enabled).toBe(false);
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
  });

  it('keeps inferred speed-limit country defaults configurable', () => {
    expect(DEFAULT_SETTINGS.country_code).toBe('');
    expect(DEFAULT_SETTINGS.configurable_country_defaults).toBe('global');
    expect(DEFAULT_SETTINGS.speak_estimated_speed_checks).toBe(true);
    expect(sanitizeImportedSettings({ configurable_country_defaults: 'gb' })).toMatchObject({
      configurable_country_defaults: 'gb',
    });
    expect(sanitizeImportedSettings({ country_code: 'GB' })).toMatchObject({
      country_code: 'GB',
    });
    expect(sanitizeImportedSettings({ configurable_country_defaults: 'mars' }).configurable_country_defaults).toBeUndefined();
  });

  it('enables spoken estimated speed checks for older installs with speed voice enabled', () => {
    expect(migrateDefaultSettings({
      settings_defaults_version: 11,
      voice_alerts_enabled: true,
      speed_warning_enabled: true,
      speak_estimated_speed_checks: false,
    }).settings.speak_estimated_speed_checks).toBe(true);
    expect(migrateDefaultSettings({
      settings_defaults_version: 11,
      voice_alerts_enabled: false,
      speed_warning_enabled: true,
      speak_estimated_speed_checks: false,
    }).settings.speak_estimated_speed_checks).toBe(false);
  });

  it('allows blank numeric drafts while editing text number inputs', () => {
    expect(validateSettingsPatch({ estimated_voice_margin_kmh: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ inferred_voice_margin_kmh: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ co2_baseline_kg_per_100km: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ default_ev_kwh_per_100km: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ grid_co2_kg_per_kwh: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ tree_co2_kg_per_year: '' })).toEqual({ valid: true, errors: [] });
    expect(validateSettingsPatch({ estimated_voice_margin_kmh: 61 }).valid).toBe(false);
    expect(validateSettingsPatch({ inferred_voice_margin_kmh: 81 }).valid).toBe(false);
    expect(validateSettingsPatch({ default_ev_kwh_per_100km: 4 }).valid).toBe(false);
  });

  it('notifies same-tab UI subscribers when settings change', () => {
    const previousWindow = globalThis.window;
    const previousCustomEvent = globalThis.CustomEvent;
    const eventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: eventTarget,
    });
    if (typeof globalThis.CustomEvent === 'undefined') {
      Object.defineProperty(globalThis, 'CustomEvent', {
        configurable: true,
        value: class TestCustomEvent extends Event {
          constructor(type, params = {}) {
            super(type, params);
            this.detail = params.detail;
          }
        },
      });
    }
    const previousUnits = localSettings.get().units;
    const seen = [];
    const listener = (event) => seen.push(event.detail?.settings?.units);
    window.addEventListener(SETTINGS_CHANGED_EVENT, listener);

    try {
      localSettings.update({ units: previousUnits === 'metric' ? 'imperial' : 'metric' });
      expect(seen.at(-1)).toBe(localSettings.get().units);
    } finally {
      localSettings.update({ units: previousUnits });
      window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
      if (previousWindow === undefined) {
        delete globalThis.window;
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previousWindow,
        });
      }
      if (previousCustomEvent === undefined) {
        delete globalThis.CustomEvent;
      } else {
        Object.defineProperty(globalThis, 'CustomEvent', {
          configurable: true,
          value: previousCustomEvent,
        });
      }
    }
  });

  it('keeps the rapid acceleration minimum speed at 5 km/h', () => {
    expect(DEFAULT_SETTINGS.min_speed_rapid_accel_kmh).toBe(5);
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
    expect(DEFAULT_SETTINGS.raw_gps_retention_days).toBe(30);
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
    expect(legacySunset.settings_defaults_version).toBe(18);
    expect(legacySunset.raw_gps_retention_days).toBe(30);
    expect(legacyCustom.night_end_time).toBe('06:00');
    expect(legacyCustom.raw_gps_retention_days).toBe(30);
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
