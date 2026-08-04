import { describe, expect, it } from 'vitest';
import {
  boundaryFromDraft,
  dateInputValue,
  draftForCorrection,
  invalidCustomDayRule,
  invalidValidityWindow,
  mapDraftForSection,
  normalizeMapDraftForCompare,
  normalizedDraftDays,
  qualifierDraftError,
  qualifierDraftPatch,
  qualifierStatusForDraft,
  qualifierStatusLabel,
  timeRuleFromDraft,
  timeRuleLabel,
  timeRuleModeForRow,
} from '../speedRuleDrafts';

describe('qualifier status', () => {
  it('falls back to unconditional for unknown or missing values', () => {
    expect(qualifierStatusForDraft({ qualifierStatus: 'conditional_school' })).toBe('conditional_school');
    expect(qualifierStatusForDraft({ qualifierStatus: 'not_a_qualifier' })).toBe('regulatory_text_no_qualifiers');
    expect(qualifierStatusForDraft({})).toBe('regulatory_text_no_qualifiers');
    expect(qualifierStatusLabel('nope')).toBe('Standard / unconditional');
  });

  it('gives a conditional rule a default schedule so it cannot stay "always"', () => {
    // School zones default to weekdays; other conditionals to daily.
    expect(qualifierDraftPatch('conditional_school', { timeRuleMode: 'always' }))
      .toEqual({ qualifierStatus: 'conditional_school', timeRuleMode: 'weekdays' });
    expect(qualifierDraftPatch('conditional_night', { timeRuleMode: 'always' }))
      .toEqual({ qualifierStatus: 'conditional_night', timeRuleMode: 'daily' });
  });

  it('leaves an existing schedule and the two schedule-free qualifiers alone', () => {
    expect(qualifierDraftPatch('conditional_night', { timeRuleMode: 'weekends' }))
      .toEqual({ qualifierStatus: 'conditional_night' });
    expect(qualifierDraftPatch('conditional_temporary_work_zone', { timeRuleMode: 'always' }))
      .toEqual({ qualifierStatus: 'conditional_temporary_work_zone' });
    expect(qualifierDraftPatch('regulatory_text_no_qualifiers', { timeRuleMode: 'always' }))
      .toEqual({ qualifierStatus: 'regulatory_text_no_qualifiers' });
  });

  it('blocks saving a conditional rule that carries no schedule or expiry', () => {
    expect(qualifierDraftError({ qualifierStatus: 'conditional_temporary_work_zone' }))
      .toMatch(/Active until date/);
    expect(qualifierDraftError({
      qualifierStatus: 'conditional_temporary_work_zone',
      expiresAtDate: '2026-09-01',
    })).toBe('');
    expect(qualifierDraftError({ qualifierStatus: 'conditional_school', timeRuleMode: 'always' }))
      .toMatch(/active days and times/);
    expect(qualifierDraftError({ qualifierStatus: 'conditional_school', timeRuleMode: 'weekdays' })).toBe('');
    expect(qualifierDraftError({})).toBe('');
  });
});

describe('recurring time rules', () => {
  it('classifies a stored day set back into its editor mode', () => {
    expect(timeRuleModeForRow({})).toBe('always');
    expect(timeRuleModeForRow({ timeRule: { enabled: false, days: [1, 2] } })).toBe('always');
    expect(timeRuleModeForRow({ timeRule: { enabled: true, days: [5, 3, 1, 2, 4] } })).toBe('weekdays');
    expect(timeRuleModeForRow({ timeRule: { enabled: true, days: [6, 0] } })).toBe('weekends');
    expect(timeRuleModeForRow({ timeRule: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6] } })).toBe('daily');
    expect(timeRuleModeForRow({ timeRule: { enabled: true, days: [2, 4] } })).toBe('custom');
  });

  it('round-trips every mode through the draft and back', () => {
    for (const mode of ['weekdays', 'weekends', 'daily']) {
      const rule = timeRuleFromDraft({ timeRuleMode: mode });
      expect(timeRuleModeForRow({ timeRule: { ...rule, days: rule.days } })).toBe(mode);
    }
    expect(timeRuleFromDraft({ timeRuleMode: 'always' })).toEqual({ enabled: false });
  });

  it('normalizes custom days and rejects an empty custom set', () => {
    expect(normalizedDraftDays({ customDays: [3, 1, 3, '2', 9, -1, 1.5] })).toEqual([1, 2, 3]);
    expect(normalizedDraftDays({})).toEqual([]);
    expect(invalidCustomDayRule({ timeRuleMode: 'custom', customDays: [] })).toBe(true);
    expect(invalidCustomDayRule({ timeRuleMode: 'custom', customDays: [1] })).toBe(false);
    expect(invalidCustomDayRule({ timeRuleMode: 'always', customDays: [] })).toBe(false);
  });

  it('describes a rule in driver-facing words', () => {
    expect(timeRuleLabel(null)).toBe('Always active');
    expect(timeRuleLabel({ enabled: true, days: [1, 2, 3, 4, 5], startMinutes: 450, endMinutes: 1020 }))
      .toBe('Weekdays 07:30-17:00');
    expect(timeRuleLabel({ enabled: true, days: [0, 6], startMinutes: 0, endMinutes: 1439 }))
      .toBe('Weekends 00:00-23:59');
    expect(timeRuleLabel({ enabled: true, days: [2, 4], startMinutes: 600, endMinutes: 660 }))
      .toBe('Tue, Thu 10:00-11:00');
  });
});

describe('validity windows', () => {
  it('reads a date input from either the stored date or the timestamp', () => {
    expect(dateInputValue('2026-03-04T10:00:00.000Z', '2026-03-05')).toBe('2026-03-05');
    expect(dateInputValue(null, '')).toBe('');
    expect(dateInputValue('not-a-date', '')).toBe('');
  });

  it('keeps the original timestamp when the user did not touch the date', () => {
    // This is what stops an untouched "Active until" from silently losing its
    // time-of-day precision on every save.
    const draft = {
      expiresAtDate: '2026-09-01',
      originalExpiresAt: '2026-09-01T18:30:00.000Z',
      originalExpiresAtDate: '2026-09-01',
    };
    expect(boundaryFromDraft(draft, 'expiresAt')).toBe('2026-09-01T18:30:00.000Z');
    expect(boundaryFromDraft({ ...draft, expiresAtDate: '2026-09-02' }, 'expiresAt'))
      .not.toBe('2026-09-01T18:30:00.000Z');
    expect(boundaryFromDraft({}, 'expiresAt')).toBeNull();
  });

  it('rejects a window that ends before it starts', () => {
    expect(invalidValidityWindow({ validFromDate: '2026-05-02', expiresAtDate: '2026-05-01' })).toBe(true);
    expect(invalidValidityWindow({ validFromDate: '2026-05-01', expiresAtDate: '2026-05-02' })).toBe(false);
    expect(invalidValidityWindow({ expiresAtDate: '2026-05-02' })).toBe(false);
  });
});

describe('draft construction and dirty-checking', () => {
  const section = {
    saved: true,
    limitKmh: 48.6,
    source: 'user_confirmed_posted_sign',
    roadName: 'Elm St',
    timeRule: { enabled: true, days: [1, 2, 3, 4, 5], startMinutes: 480, endMinutes: 960 },
  };

  it('seeds a map draft from a saved section', () => {
    const draft = mapDraftForSection(section);
    expect(draft.limitKmh).toBe('49');
    expect(draft.source).toBe('user_confirmed_posted_sign');
    expect(draft.timeRuleMode).toBe('weekdays');
    expect(draft.startTime).toBe('08:00');
    expect(draft.endTime).toBe('16:00');
    expect(draft.directionMode).toBe('both');
  });

  it('prefers the observed limit for an unsaved section', () => {
    expect(mapDraftForSection({ saved: false, observedLimitKmh: 62 }).limitKmh).toBe('62');
    expect(mapDraftForSection({ saved: false }).limitKmh).toBe('');
    expect(mapDraftForSection({ saved: false, observedSources: ['user_confirmed_posted_sign'] }).source)
      .toBe('user_confirmed_posted_sign');
    expect(mapDraftForSection({ saved: false, observedSources: [] }).source).toBe('user_entered_estimate');
  });

  it('copies rather than aliases the stored day array', () => {
    const draft = draftForCorrection(section);
    draft.customDays.push(6);
    expect(section.timeRule.days).toEqual([1, 2, 3, 4, 5]);
  });

  it('compares only the fields a save would persist', () => {
    const base = mapDraftForSection(section);
    expect(normalizeMapDraftForCompare({ ...base, originalExpiresAt: 'changed' }))
      .toBe(normalizeMapDraftForCompare(base));
    expect(normalizeMapDraftForCompare({ ...base, customDays: [5, 4, 3, 2, 1] }))
      .toBe(normalizeMapDraftForCompare(base));
    expect(normalizeMapDraftForCompare({ ...base, limitKmh: '50' }))
      .not.toBe(normalizeMapDraftForCompare(base));
  });
});
