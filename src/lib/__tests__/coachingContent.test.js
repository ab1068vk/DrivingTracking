import { describe, expect, it } from 'vitest';
import {
  COACHING_CONTENT,
  COACHING_CONTENT_IDS,
  coachingContentFor,
  coachingCopyFor,
  coachingEventDetailFor,
} from '@/lib/coachingContent';
import { COACH_FOCUS_CATALOG } from '@/lib/coachPrograms';

const STRING_FIELDS = [
  'label',
  'shortLabel',
  'eventLabel',
  'cue',
  'liveCue',
  'why',
  'drillTitle',
  'target',
  'riskCoaching',
  'scoreTip',
];

const LIST_FIELDS = ['drill', 'drillSteps'];

describe('coaching content catalog', () => {
  it('covers every focus id used by the coach program engine', () => {
    expect(COACHING_CONTENT_IDS.sort()).toEqual(Object.keys(COACH_FOCUS_CATALOG).sort());
  });

  it.each(COACHING_CONTENT_IDS)('gives %s every required copy field', (focusId) => {
    const content = COACHING_CONTENT[focusId];

    STRING_FIELDS.forEach((field) => {
      expect(typeof content[field], `${focusId}.${field}`).toBe('string');
      expect(content[field].trim().length, `${focusId}.${field}`).toBeGreaterThan(0);
    });

    LIST_FIELDS.forEach((field) => {
      expect(Array.isArray(content[field]), `${focusId}.${field}`).toBe(true);
      expect(content[field].length, `${focusId}.${field}`).toBeGreaterThanOrEqual(2);
      content[field].forEach((step) => {
        expect(typeof step).toBe('string');
        expect(step.trim().length).toBeGreaterThan(0);
      });
    });
  });

  it('keeps the program catalog composed from this copy rather than restating it', () => {
    COACHING_CONTENT_IDS.forEach((focusId) => {
      const focus = COACH_FOCUS_CATALOG[focusId];
      expect(focus.label).toBe(COACHING_CONTENT[focusId].label);
      expect(focus.cue).toBe(COACHING_CONTENT[focusId].cue);
      expect(focus.liveCue).toBe(COACHING_CONTENT[focusId].liveCue);
      expect(focus.drill).toEqual(COACHING_CONTENT[focusId].drill);
    });
  });

  it('falls back to consistency copy for an unknown focus id', () => {
    expect(coachingContentFor('not_a_focus')).toBe(COACHING_CONTENT.consistency);
    expect(coachingContentFor(undefined)).toBe(COACHING_CONTENT.consistency);
  });

  it('exposes only copy fields to the program catalog helper', () => {
    expect(Object.keys(coachingCopyFor('harsh_brakes')).sort())
      .toEqual(['cue', 'drill', 'label', 'liveCue', 'shortLabel']);
  });

  it('shapes event-review detail with the caller-supplied focus area', () => {
    const detail = coachingEventDetailFor('speeding', 'speed');

    expect(detail.label).toBe(COACHING_CONTENT.speeding.eventLabel);
    expect(detail.focus).toBe('speed');
    expect(detail.why).toBe(COACHING_CONTENT.speeding.why);
    expect(detail.drillSteps).toEqual(COACHING_CONTENT.speeding.drillSteps);
  });

  it('keeps every focus label distinct so surfaces stay unambiguous', () => {
    const labels = COACHING_CONTENT_IDS.map((focusId) => COACHING_CONTENT[focusId].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
