import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/trackingStore';

describe('tracking store default settings', () => {
  it('keeps external context auto-fetch disabled by default', () => {
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(false);
  });

  it('keeps the rapid acceleration minimum speed at 5 km/h', () => {
    expect(DEFAULT_SETTINGS.min_speed_rapid_accel_kmh).toBe(5);
  });

  it('defines configurable CO2 economics defaults', () => {
    expect(DEFAULT_SETTINGS.co2_baseline_kg_per_100km).toBe(12);
    expect(DEFAULT_SETTINGS.default_ev_kwh_per_100km).toBe(18);
    expect(DEFAULT_SETTINGS.grid_co2_kg_per_kwh).toBe(0.04);
    expect(DEFAULT_SETTINGS.tree_co2_kg_per_year).toBe(21);
  });
});
