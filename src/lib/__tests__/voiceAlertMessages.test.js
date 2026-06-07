import { describe, expect, it } from 'vitest';

import {
  buildVoiceAlertMessage,
  getVoiceAlertMessageCatalog,
  getVoiceAlertMessageTitle,
  listVoiceAlertMessageKeys,
  normalizeVoiceAlertMessageKey,
} from '@/lib/voiceAlertMessages';

describe('voice alert message catalog', () => {
  it('normalizes aliases without requiring live alert wiring', () => {
    expect(normalizeVoiceAlertMessageKey('speed limit')).toBe('speeding');
    expect(normalizeVoiceAlertMessageKey('hard-brake')).toBe('harsh_brake');
    expect(normalizeVoiceAlertMessageKey('tracking issue')).toBe('tracking_blocked');
  });

  it('falls back to the general safety message for unknown keys', () => {
    expect(normalizeVoiceAlertMessageKey('new future alert')).toBe('general');
    expect(buildVoiceAlertMessage('new future alert')).toBe('Safety alert. Check Road Sage when it is safe to do so.');
    expect(getVoiceAlertMessageTitle('new future alert')).toBe('Safety alert');
  });

  it('builds speed messages with optional context', () => {
    expect(buildVoiceAlertMessage('speeding', { speedKmh: 78, speedLimitKmh: 60 })).toBe(
      'Speed warning. You are at 78 kilometers per hour in a 60 kilometers per hour zone. Ease off smoothly.'
    );

    expect(buildVoiceAlertMessage('speeding', { overLimitKmh: 12 })).toBe(
      'Speed warning. You are about 12 kilometers per hour over the limit. Ease off smoothly.'
    );
  });

  it('supports alternate wording without changing alert behavior', () => {
    expect(buildVoiceAlertMessage('phone_use', {}, { messageIndex: 1 })).toBe(
      'Phone distraction warning. Eyes on the road; deal with it when parked.'
    );
    expect(buildVoiceAlertMessage('rapid_accel', {}, { escalationLevel: 99 })).toBe(
      'Quick acceleration detected. Keep the launch smooth and steady.'
    );
    expect(buildVoiceAlertMessage('stop_start')).toBe(
      'Repeated stop-start pattern recorded. Add space ahead and keep inputs smooth.'
    );
    expect(buildVoiceAlertMessage('speeding', {
      speedKmh: 78,
      speedLimitKmh: 60,
      speedLimitSource: 'inferred',
    })).toBe(
      'Speed warning. You are at 78 kilometers per hour in an estimated 60 kilometers per hour zone. Ease off smoothly.'
    );
  });

  it('builds situational alerts for repeated-event areas and incidents', () => {
    expect(normalizeVoiceAlertMessageKey('hazard area')).toBe('repeated_event_area');
    expect(normalizeVoiceAlertMessageKey('possible crash')).toBe('possible_incident');
    expect(buildVoiceAlertMessage('repeated_event_area', { dominantType: 'harsh brake', distanceM: 87 })).toBe(
      'Repeated harsh brake area about 87 meters ahead. Slow your scan and keep extra space.'
    );
    expect(buildVoiceAlertMessage('possible_incident', { emergencyWorkflow: true })).toBe(
      'Possible incident signal recorded. Emergency check-in is active until you review the trip.'
    );
  });

  it('can explain a tracking-blocked reason as plain text only', () => {
    expect(buildVoiceAlertMessage('tracking_blocked', { reason: 'Location permission is off.' })).toBe(
      'Tracking did not start. Location permission is off.'
    );
  });

  it('exposes a frozen catalog of supported keys', () => {
    const keys = listVoiceAlertMessageKeys();
    const catalog = getVoiceAlertMessageCatalog();

    expect(keys).toEqual(expect.arrayContaining([
      'general',
      'speeding',
      'tracking_blocked',
      'close_proximity',
      'idle',
      'repeated_event_area',
      'possible_incident',
    ]));
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.speeding)).toBe(true);
    expect(Object.isFrozen(catalog.speeding.messages)).toBe(true);
  });
});
