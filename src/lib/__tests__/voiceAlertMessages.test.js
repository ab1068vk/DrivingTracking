import { describe, expect, it, test } from 'vitest';

import {
  buildSpeedingMessage,
  buildVoiceAlertMessage,
  getVoiceAlertMessageCatalog,
  getVoiceAlertMessageTitle,
  listVoiceAlertMessageKeys,
  normalizeVoiceAlertMessageKey,
  TIER_EVENT_LABELS,
} from '@/lib/voiceAlertMessages';

// CHANGES (session):
// - Added Category E buildSpeedingMessage tier phrase tests.
// - Updated regional default voice tests to avoid legal certainty wording.
// - Updated generic speed catalog tests so only posted sources use warning wording.
// - Guarded estimate tiers against speed-warning wording.
// - Guarded non-POSTED voice wording against legal/official/posted certainty terms.
// - Added REGION_DEFAULT event label wording coverage.
// - Added REGION_DEFAULT voice and posted-style wording guard tests.

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
      'Speed check. You are at 78 kilometers per hour in an estimated 60 kilometers per hour zone. Check posted signs.'
    );

    expect(buildVoiceAlertMessage('speeding', { overLimitKmh: 12 })).toBe(
      'Speed check. You are about 12 kilometers per hour over the estimated zone. Check posted signs.'
    );

    expect(buildVoiceAlertMessage('speeding', {
      speedKmh: 78,
      speedLimitKmh: 60,
      speedLimitSource: 'openstreetmap',
    })).toBe(
      'Speed warning. You are at 78 kilometers per hour in a posted 60 kilometers per hour zone. Ease off smoothly.'
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
      'Speed check. You are at 78 kilometers per hour in an estimated 60 kilometers per hour zone. Check posted signs.'
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

describe('buildSpeedingMessage tier phrases', () => {
  const cases = [
    ['POSTED', 60, 78, 'in a posted 60'],
    ['MAP_ESTIMATED', 60, 78, 'estimated 60'],
    ['LEARNED_LOCAL', 60, 78, 'usually around 60'],
    ['REGION_DEFAULT', 50, 72, 'this area is estimated around 50'],
    ['GPS_INFERRED', 60, 82, 'road speed is uncertain'],
  ];

  test.each(cases)('%s tier message contains expected phrase', (tier, limitKmh, speedKmh, phrase) => {
    const msg = buildSpeedingMessage({ speedKmh, speedLimitKmh: limitKmh, tier });
    expect(msg.toLowerCase()).toContain(phrase.toLowerCase());
    if (tier !== 'POSTED') {
      expect(msg).toContain('Speed check');
      expect(msg).not.toContain('Speed warning');
    }
  });

  it('UNKNOWN tier returns null (no speed-limit voice)', () => {
    const msg = buildSpeedingMessage({ speedKmh: 90, speedLimitKmh: null, tier: 'UNKNOWN' });
    expect(msg).toBeNull();
  });

  it('REGION_DEFAULT fallback message uses speed-check wording', () => {
    expect(buildSpeedingMessage({ speedKmh: 72, speedLimitKmh: null, tier: 'REGION_DEFAULT' })).toBe(
      'Speed check. Ease off and check posted signs.'
    );
  });

  it('REGION_DEFAULT voice never claims speeding, legal, official, statutory, or posted-zone certainty', () => {
    const msg = buildSpeedingMessage({ speedKmh: 72, speedLimitKmh: 50, tier: 'REGION_DEFAULT' });
    for (const pattern of [/speeding/i, /legal/i, /official/i, /statutory/i, /posted zone/i]) {
      expect(msg).not.toMatch(pattern);
    }
  });

  it('non-POSTED tiers do not use forbidden certainty wording', () => {
    const forbidden = [/you are speeding/i, /legal limit/i, /official limit/i, /statutory limit/i, /posted zone/i];
    for (const tier of ['MAP_ESTIMATED', 'LEARNED_LOCAL', 'REGION_DEFAULT', 'GPS_INFERRED']) {
      const msg = buildSpeedingMessage({ speedKmh: 78, speedLimitKmh: 60, tier });
      for (const pattern of forbidden) {
        expect(msg).not.toMatch(pattern);
      }
    }
  });

  it('non-POSTED event labels do not use forbidden certainty wording', () => {
    const forbidden = [/you are speeding/i, /legal limit/i, /official limit/i, /statutory limit/i, /posted zone/i];
    for (const tier of ['MAP_ESTIMATED', 'LEARNED_LOCAL', 'REGION_DEFAULT', 'GPS_INFERRED']) {
      for (const pattern of forbidden) {
        expect(TIER_EVENT_LABELS[tier]).not.toMatch(pattern);
      }
    }
  });

  it('REGION_DEFAULT event label says regional default estimate with no posted sign confirmed', () => {
    expect(TIER_EVENT_LABELS.REGION_DEFAULT).toBe('Regional default estimate — no posted sign confirmed');
    expect(TIER_EVENT_LABELS.REGION_DEFAULT.toLowerCase()).toContain('regional default estimate');
  });

  it('only user_confirmed_posted_sign can use POSTED-style wording in legacy source messages', () => {
    const confirmed = buildSpeedingMessage({
      speedKmh: 78,
      speedLimitKmh: 60,
      speedLimitSource: 'user_confirmed_posted_sign',
    });
    const estimate = buildSpeedingMessage({
      speedKmh: 78,
      speedLimitKmh: 60,
      speedLimitSource: 'user_entered_estimate',
    });
    expect(confirmed).toContain('Speed warning');
    expect(confirmed).toContain('posted 60 kilometers per hour zone');
    expect(estimate).toContain('Speed check');
    expect(estimate).not.toContain('Speed warning');
    expect(estimate).not.toContain('posted 60 kilometers per hour zone');
  });
});
