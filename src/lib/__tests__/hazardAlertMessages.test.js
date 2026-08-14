/**
 * The warning this replaces said "N metres ahead" without anything having
 * checked that the hazard was ahead. The rule these tests enforce is that a
 * number in a hazard sentence is a number the evidence actually contains — and
 * that the late-braking copy never upgrades "you brake hard here" into a claim
 * about a corner, which is the one thing the evidence cannot support.
 */
import { describe, expect, it } from 'vitest';
import {
  buildHazardDisplayMessage,
  buildLateBrakingMessage,
  buildLateBrakingTechnicalMessage,
  describeHazardLead,
} from '@/lib/hazard/hazardAlertMessages';
import {
  buildVoiceAlertMessage,
  normalizeVoiceAlertMessageKey,
} from '@/lib/voiceAlertMessages';
import { voiceAlertGroupSettingForKey } from '@/lib/voiceAlerts';

const advisory = {
  passes: 6,
  brakingPasses: 3,
  typicalEntryKmh: 58,
  overTypicalKmh: 11,
  dominantType: 'harsh_brake',
};

/** Every integer the copy contains, so it can be checked against the evidence. */
const numbersIn = (text) => (text.match(/\d+/g) || []).map(Number);

describe('describeHazardLead', () => {
  it('prefers an arrival time and falls back to distance', () => {
    expect(describeHazardLead({ etaSeconds: 9.4 })).toBe('about 9 seconds ahead');
    expect(describeHazardLead({ distanceM: 180 })).toBe('about 180 meters ahead');
    expect(describeHazardLead({ etaSeconds: 9.4, distanceM: 180 })).toBe('about 9 seconds ahead');
    expect(describeHazardLead({})).toBeNull();
    // Number(null) is 0; a zero lead is not a measurement.
    expect(describeHazardLead({ etaSeconds: null, distanceM: null })).toBeNull();
  });
});

describe('late-braking copy', () => {
  it('quotes only counts the evidence contains', () => {
    const plain = buildLateBrakingMessage(advisory);
    const technical = buildLateBrakingTechnicalMessage(advisory);
    const allowed = new Set([advisory.passes, advisory.brakingPasses, advisory.typicalEntryKmh]);
    for (const value of [...numbersIn(plain), ...numbersIn(technical)]) {
      expect(allowed.has(value)).toBe(true);
    }
    expect(plain).toContain('3 of your last 6 passes');
    expect(technical).toContain('3 of 6 passes');
  });

  it('never claims a corner', () => {
    for (const text of [buildLateBrakingMessage(advisory), buildLateBrakingTechnicalMessage(advisory)]) {
      expect(text.toLowerCase()).not.toMatch(/curve|corner|bend/);
    }
  });

  it('describes sharp turns as turns rather than as braking', () => {
    const turning = { ...advisory, dominantType: 'sharp_turn' };
    expect(buildLateBrakingMessage(turning)).toContain('turned sharply');
    expect(buildLateBrakingTechnicalMessage(turning)).toContain('sharp turns');
  });

  it('drops the counts rather than inventing them when evidence is missing', () => {
    const text = buildLateBrakingMessage({ dominantType: 'harsh_brake' });
    expect(numbersIn(text)).toEqual([]);
    expect(text).toContain('braked hard here before');
  });
});

describe('buildHazardDisplayMessage', () => {
  it('describes a repeated-event area in seconds', () => {
    const message = buildHazardDisplayMessage({
      kind: 'repeated_event_area',
      etaSeconds: 9.2,
      evidence: { dominantType: 'harsh_brake', eventCount: 6 },
    });
    expect(message.title).toBe('Repeated event area ahead');
    expect(message.body).toBe('harsh brake repeated-event area about 9 seconds ahead');
  });

  it('describes a braking habit with its counts', () => {
    const message = buildHazardDisplayMessage({
      kind: 'late_braking_pattern', etaSeconds: 8, evidence: advisory,
    });
    expect(message.body).toContain('3 of your last 6 passes');
    expect(message.body).toContain('about 8 seconds ahead');
  });

  it('returns nothing for a hazard with no kind', () => {
    expect(buildHazardDisplayMessage(null)).toBeNull();
    expect(buildHazardDisplayMessage({})).toBeNull();
  });
});

describe('voice catalog wiring', () => {
  it('resolves the new key and the words people reach for instead', () => {
    for (const alias of ['late_braking_pattern', 'curve_entry', 'curve_entry_advisory', 'brake_point', 'late_braking']) {
      expect(normalizeVoiceAlertMessageKey(alias)).toBe('late_braking_pattern');
    }
  });

  it('speaks in both styles', () => {
    for (const style of ['coaching', 'technical']) {
      const spoken = buildVoiceAlertMessage('late_braking_pattern', advisory, { style });
      expect(typeof spoken).toBe('string');
      expect(spoken.length).toBeGreaterThan(0);
      expect(spoken.toLowerCase()).not.toMatch(/curve|corner|bend/);
    }
  });

  it('keeps the existing repeated-event-area distance wording working', () => {
    const spoken = buildVoiceAlertMessage('repeated_event_area', {
      dominantType: 'harsh brake', distanceM: 180,
    }, { style: 'coaching' });
    expect(spoken).toContain('180 meters ahead');
  });

  it('prefers seconds for a repeated-event area when the horizon supplies one', () => {
    const spoken = buildVoiceAlertMessage('repeated_event_area', {
      dominantType: 'harsh brake', distanceM: 180, etaSeconds: 10,
    }, { style: 'coaching' });
    expect(spoken).toContain('10 seconds ahead');
    expect(spoken).not.toContain('180 meters');
  });

  it('is governed by the driving-event voice group, not a new toggle', () => {
    expect(voiceAlertGroupSettingForKey('late_braking_pattern')).toBe('voice_driving_event_alerts_enabled');
    expect(voiceAlertGroupSettingForKey('curve_entry')).toBe('voice_driving_event_alerts_enabled');
  });
});
