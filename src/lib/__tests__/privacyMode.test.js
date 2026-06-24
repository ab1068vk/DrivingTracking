import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEIGHTENED_PRIVACY_MODE_EFFECTS,
  effectivePrivacySettings,
  effectivePrivacyZones,
  isHeightenedPrivacyMode,
  isStoredHeightenedPrivacyMode,
} from '@/lib/privacyMode';

describe('privacyMode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('turns one heightened privacy setting into the session-wide privacy posture', () => {
    const settings = effectivePrivacySettings({
      heightened_privacy_mode: true,
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
      request_obfuscation_enabled: false,
      map_matching_enabled: true,
    });

    expect(isHeightenedPrivacyMode(settings)).toBe(true);
    expect(settings).toMatchObject({
      weather_context_enabled: false,
      speed_limit_lookup_enabled: false,
      request_obfuscation_enabled: true,
      map_matching_enabled: false,
    });
    expect(effectivePrivacyZones([
      { id: 'home', sensitivity: 'standard' },
      { id: 'work' },
    ], settings)).toEqual([
      { id: 'home', sensitivity: 'high' },
      { id: 'work', sensitivity: 'high' },
    ]);
    expect(HEIGHTENED_PRIVACY_MODE_EFFECTS).toHaveLength(5);
  });

  it('leaves normal settings and zones untouched when heightened mode is off', () => {
    const settings = { heightened_privacy_mode: false, request_obfuscation_enabled: false };
    const zones = [{ id: 'home', sensitivity: 'standard' }];

    expect(effectivePrivacySettings(settings)).toBe(settings);
    expect(effectivePrivacyZones(zones, settings)).toBe(zones);
  });

  it('reads the persisted heightened mode switch without loading the settings store', () => {
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) || null),
      setItem: vi.fn((key, value) => values.set(key, String(value))),
    });

    localStorage.setItem('drivesense_settings', JSON.stringify({ heightened_privacy_mode: true }));
    expect(isStoredHeightenedPrivacyMode()).toBe(true);
    localStorage.setItem('drivesense_settings', JSON.stringify({ heightened_privacy_mode: false }));
    expect(isStoredHeightenedPrivacyMode()).toBe(false);
  });
});
