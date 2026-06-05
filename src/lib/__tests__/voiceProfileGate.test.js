import { describe, expect, it } from 'vitest';

import { isAlertAllowedByProfile } from '@/lib/voiceProfileGate';

const baseSettings = {
  voice_alerts_enabled: true,
  voice_alerts_min_severity: 1,
};

function localTime(hour, minute = 0) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

describe('voice profile gate', () => {
  it('blocks alerts when voice is disabled but preserves legacy undefined fallback', () => {
    expect(isAlertAllowedByProfile('speeding', {
      ...baseSettings,
      voice_alerts_enabled: false,
    })).toBe(false);

    expect(isAlertAllowedByProfile('speeding', {
      ...baseSettings,
      voice_alerts_enabled: 'undefined',
    })).toBe(true);
  });

  it('filters alerts below the configured minimum severity', () => {
    expect(isAlertAllowedByProfile('idle', {
      ...baseSettings,
      voice_alerts_min_severity: 1,
    })).toBe(false);

    expect(isAlertAllowedByProfile('speeding', {
      ...baseSettings,
      voice_alerts_min_severity: 2,
    })).toBe(true);

    expect(isAlertAllowedByProfile('rapid_accel', {
      ...baseSettings,
      voice_alerts_min_severity: 2,
    })).toBe(false);
  });

  it('suppresses non-critical alerts during overnight quiet hours', () => {
    const quietSettings = {
      ...baseSettings,
      voice_quiet_hours_enabled: true,
      voice_quiet_hours_start: '22:00',
      voice_quiet_hours_end: '06:00',
    };

    expect(isAlertAllowedByProfile('speeding', quietSettings, localTime(23))).toBe(false);
    expect(isAlertAllowedByProfile('phone_use', quietSettings, localTime(23))).toBe(true);
    expect(isAlertAllowedByProfile('speeding', quietSettings, localTime(12))).toBe(true);
  });

  it('supports same-day quiet hours windows', () => {
    const quietSettings = {
      ...baseSettings,
      voice_quiet_hours_enabled: true,
      voice_quiet_hours_start: '09:00',
      voice_quiet_hours_end: '17:00',
    };

    expect(isAlertAllowedByProfile('harsh_brake', quietSettings, localTime(10))).toBe(false);
    expect(isAlertAllowedByProfile('harsh_brake', quietSettings, localTime(18))).toBe(true);
  });
});
