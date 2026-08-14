/**
 * The hazard warning's lead time is user-configurable, which means it arrives
 * from three places that do not trust each other: the slider, a restored backup,
 * and an imported settings blob. Each has to end up clamped to the same range,
 * and a settings file written before this feature existed has to keep working.
 */
import { describe, expect, it } from 'vitest';
import {
  HAZARD_HORIZON_ALERT_SECONDS,
  HAZARD_HORIZON_MAX_SECONDS,
  HAZARD_HORIZON_MIN_SECONDS_SETTING,
} from '@/lib/appConstants';
import { sanitizeImportedSettings, settingRange, validateSettingsPatch } from '@/lib/trackingStore';
import { resolveHorizonSeconds } from '@/lib/hazard/hazardHorizon';
import { searchSettingsSections } from '@/lib/settingsSearch';
import { SETTINGS_SECTIONS } from '@/components/settings/settingsSectionManifest';

describe('hazard_horizon_seconds', () => {
  it('is clamped to the same range everywhere it can be set', () => {
    expect(settingRange('hazard_horizon_seconds')).toEqual([
      HAZARD_HORIZON_MIN_SECONDS_SETTING,
      HAZARD_HORIZON_MAX_SECONDS,
    ]);
  });

  it('refuses an out-of-range value from the settings UI', () => {
    expect(validateSettingsPatch({ hazard_horizon_seconds: 100000 }).valid).toBe(false);
    expect(validateSettingsPatch({ hazard_horizon_seconds: 1 }).valid).toBe(false);
    expect(validateSettingsPatch({ hazard_horizon_seconds: 12 }).valid).toBe(true);
  });

  it('clamps rather than refuses on the import path, where the whole file must still load', () => {
    expect(sanitizeImportedSettings({ hazard_horizon_seconds: 100000 }).hazard_horizon_seconds)
      .toBe(HAZARD_HORIZON_MAX_SECONDS);
    expect(sanitizeImportedSettings({ hazard_horizon_seconds: -5 }).hazard_horizon_seconds)
      .toBe(HAZARD_HORIZON_MIN_SECONDS_SETTING);
    // Not a number at all: the default stands rather than a coerced zero.
    expect(sanitizeImportedSettings({ hazard_horizon_seconds: 'soon' }).hazard_horizon_seconds)
      .toBeUndefined();
  });

  it('falls back to the default for settings written before this feature existed', () => {
    expect(resolveHorizonSeconds({})).toBe(HAZARD_HORIZON_ALERT_SECONDS);
    expect(resolveHorizonSeconds({ hazard_horizon_seconds: undefined })).toBe(HAZARD_HORIZON_ALERT_SECONDS);
  });

  it('is reachable from settings search', () => {
    for (const term of ['hazard', 'horizon', 'lead time']) {
      const hits = searchSettingsSections(SETTINGS_SECTIONS, term);
      expect(hits.some((hit) => hit.sectionId === 'settings-notifications')).toBe(true);
    }
  });
});
