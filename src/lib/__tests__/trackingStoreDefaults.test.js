import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/lib/trackingStore';

describe('tracking store default settings', () => {
  it('keeps external context auto-fetch disabled by default', () => {
    expect(DEFAULT_SETTINGS.external_context_auto_fetch_enabled).toBe(false);
  });

  it('keeps the rapid acceleration minimum speed at 5 km/h', () => {
    expect(DEFAULT_SETTINGS.min_speed_rapid_accel_kmh).toBe(5);
  });
});
