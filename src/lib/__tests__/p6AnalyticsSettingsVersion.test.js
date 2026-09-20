import { describe, expect, it } from 'vitest';
import { __testables } from '@/lib/p6TripDerivedState';

const { analyticsSettingsProjection, ANALYTICS_VOLATILE_SETTINGS_KEYS } = __testables;

/**
 * Regression cover for the A54 blocker behind the Dashboard's missing lifetime
 * totals (DPD-008).
 *
 * `settingsVersion` is a hash of the settings object. `settings` mixes durable
 * preferences with observed runtime status, and `rasp_checked_at` is rewritten
 * on *every launch* — so the version changed every launch, which demoted
 * `D1_ANALYTICS:all` to REBUILD_REQUIRED every launch. That state clears only
 * when an explicit repair completes against a *matching* version, so the match
 * could never hold: analytics were permanently unavailable and every repair was
 * undone by the next launch.
 *
 * Measured on device across three cold launches, nothing touched by the user:
 *   90f0060606e0…  7dc595527b35…  88fb4825ad1a…
 *
 * These tests pin the projection that feeds the hash.
 */

/** A settings shape with both durable preferences and runtime status. */
const settingsAtLaunch = (checkedAt) => ({
  units: 'metric',
  experience_mode: 'coaching',
  tracking_mode: 'manual',
  data_retention_days: 0,
  legal_notice_acknowledged_at: '2026-09-19T00:00:00.000Z',
  osrm_data_sharing_consented_at: '2026-09-01T00:00:00.000Z',
  // Runtime status — changes with no user action.
  rasp_checked_at: checkedAt,
  rasp_secure: true,
  rasp_threats: ['DEBUGGABLE', 'ADB_ENABLED'],
  rasp_native: true,
  osrm_health_status: 'unreachable',
  osrm_last_health_checked_at: checkedAt,
  privacy_zones_native_sync_status: 'synced',
  privacy_zones_native_sync_zone_count: 3,
});

describe('analytics settings version ignores runtime status', () => {
  it('is unchanged when only the per-launch integrity timestamp moves', () => {
    const first = analyticsSettingsProjection(settingsAtLaunch('2026-09-20T00:29:50.299Z'));
    const second = analyticsSettingsProjection(settingsAtLaunch('2026-09-20T00:30:31.513Z'));

    // The exact device-observed failure: two launches, one timestamp apart.
    expect(second).toEqual(first);
  });

  it('drops every runtime-status field from the hashed projection', () => {
    const projected = analyticsSettingsProjection(settingsAtLaunch('2026-09-20T00:00:00.000Z'));
    for (const key of ANALYTICS_VOLATILE_SETTINGS_KEYS) {
      expect(projected, `${key} must not reach the analytics version`).not.toHaveProperty(key);
    }
  });

  it('keeps durable preferences, so a real settings change still invalidates', () => {
    const base = analyticsSettingsProjection(settingsAtLaunch('t'));
    const changed = analyticsSettingsProjection({
      ...settingsAtLaunch('t'),
      units: 'imperial',
    });

    expect(base.units).toBe('metric');
    expect(changed).not.toEqual(base);
  });

  it('keeps consent and acknowledgement timestamps — those are user decisions', () => {
    const base = analyticsSettingsProjection(settingsAtLaunch('t'));
    expect(base).toHaveProperty('legal_notice_acknowledged_at');
    expect(base).toHaveProperty('osrm_data_sharing_consented_at');

    const reconsented = analyticsSettingsProjection({
      ...settingsAtLaunch('t'),
      osrm_data_sharing_consented_at: '2026-09-19T12:00:00.000Z',
    });
    expect(reconsented).not.toEqual(base);
  });

  it('does not depend on property insertion order', () => {
    const forward = analyticsSettingsProjection({ alpha: 1, beta: 2, gamma: 3 });
    const reversed = analyticsSettingsProjection({ gamma: 3, beta: 2, alpha: 1 });

    // Object key order is observable through JSON.stringify, which is what the
    // version hashes — so equal content must serialize identically.
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('tolerates a missing or empty settings object', () => {
    expect(analyticsSettingsProjection(undefined)).toEqual({});
    expect(analyticsSettingsProjection(null)).toEqual({});
  });
});
