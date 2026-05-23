import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateDefaultSettings } from '@/lib/trackingStore';

describe('tracking store default settings', () => {
  it('keeps external context auto-fetch disabled by default', () => {
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(false);
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
    expect(legacySunset.settings_defaults_version).toBe(3);
    expect(legacyCustom.night_end_time).toBe('06:00');
  });
});
