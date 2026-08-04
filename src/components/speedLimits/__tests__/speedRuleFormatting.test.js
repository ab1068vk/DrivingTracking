import { describe, expect, it } from 'vitest';
import {
  coordinateLabel,
  directionLabel,
  expiryLabel,
  formatCoordinate,
  formatDate,
  formatSourceList,
  mapSectionReasonText,
  speedSectionAttentionLabel,
  speedStatusToast,
  timeString,
  tripLabel,
  undoActionText,
  validFromLabel,
} from '../speedRuleFormatting';

describe('timeString', () => {
  it('renders minutes-from-midnight as a padded clock time', () => {
    expect(timeString(0)).toBe('00:00');
    expect(timeString(450)).toBe('07:30');
    expect(timeString(1439)).toBe('23:59');
  });

  it('clamps out-of-range values instead of producing a bogus clock', () => {
    expect(timeString(-30)).toBe('00:00');
    expect(timeString(5000)).toBe('23:59');
  });

  it('uses the caller-supplied fallback for unusable input', () => {
    expect(timeString(undefined)).toBe('07:00');
    expect(timeString('later', '17:00')).toBe('17:00');
  });
});

describe('value formatting', () => {
  it('never renders a raw invalid date', () => {
    expect(formatDate(null)).toBe('Unknown time');
    expect(formatDate('')).toBe('Unknown time');
    expect(formatDate('not a date')).toBe('Unknown time');
    expect(formatDate(0)).toBe('Unknown time');
    expect(formatDate('2026-06-01T12:00:00.000Z')).not.toBe('Unknown time');
  });

  it('renders coordinates at a fixed precision and never as NaN', () => {
    expect(formatCoordinate(51.5)).toBe('51.50000');
    expect(formatCoordinate('-0.123456789')).toBe('-0.12346');
    expect(formatCoordinate(undefined)).toBe('0.00000');
  });

  it('labels coordinate provenance and direction', () => {
    expect(coordinateLabel('geohash_cell_center_legacy')).toBe('Approx cell center');
    expect(coordinateLabel('anything_else')).toBe('Driven route point');
    expect(directionLabel('forward')).toBe('Drawn direction only');
    expect(directionLabel('reverse')).toBe('Opposite direction only');
    expect(directionLabel(undefined)).toBe('Both directions');
  });

  it('labels validity boundaries', () => {
    expect(expiryLabel(null)).toBe('No expiry');
    expect(expiryLabel('2026-06-01T12:00:00.000Z')).toMatch(/^Expires /);
    expect(validFromLabel(null)).toBe('All recorded history');
    expect(validFromLabel('2026-06-01T12:00:00.000Z')).toMatch(/^Effective /);
  });

  it('dedupes and drops empty sources', () => {
    expect(formatSourceList([])).toBe('Unknown source');
    expect(formatSourceList([null, undefined])).toBe('Unknown source');
    const single = formatSourceList(['user_entered_estimate']);
    expect(formatSourceList(['user_entered_estimate', 'user_entered_estimate'])).toBe(single);
    expect(formatSourceList(['user_entered_estimate', 'user_confirmed_posted_sign'])).toContain(', ');
  });

  it('names a trip by title, falling back to its start date', () => {
    expect(tripLabel({ name: 'School run' })).toBe('School run');
    expect(tripLabel({ title: 'School run' })).toBe('School run');
    expect(tripLabel({ label: 'School run' })).toBe('School run');
    expect(tripLabel({ start_time: '2026-06-01T12:00:00.000Z' })).not.toMatch(/^Trip /);
  });

  it('names an untimed trip by id rather than as 1970', () => {
    // Regression guard: a `|| 0` fallback here builds a valid epoch date, which
    // makes this branch unreachable and renders the trip as 1970-01-01.
    expect(tripLabel({ id: 'abcdefghijkl' })).toBe('Trip abcdefgh');
    expect(tripLabel({ start_time: null, id: 'abcdefghijkl' })).toBe('Trip abcdefgh');
    expect(tripLabel({ start_time: 'not a date', id: 'abcdefghijkl' })).toBe('Trip abcdefgh');
    expect(tripLabel({})).toBe('Trip ');
  });

  it('still prefers a real timestamp over the id', () => {
    expect(tripLabel({ created_at: '2026-06-01T12:00:00.000Z', id: 'abcdefghijkl' }))
      .not.toMatch(/^Trip /);
    // A genuine epoch-0 timestamp is a timestamp, not a missing one.
    expect(tripLabel({ start_time: '1970-01-01T00:00:00.000Z', id: 'abcdefghijkl' }))
      .not.toMatch(/^Trip /);
  });

  it('names the action an undo would reverse', () => {
    expect(undoActionText('save_correction')).toBe('add');
    expect(undoActionText('remove_correction')).toBe('delete');
    expect(undoActionText('resolve_conflict')).toBe('conflict decision');
    expect(undoActionText('something_new')).toBe('change');
  });
});

describe('speedSectionAttentionLabel', () => {
  const healthy = () => ({
    saved: true,
    limitKmh: 50,
    source: 'user_confirmed_posted_sign',
    sectionPoints: [{ lat: 51.5, lng: -0.12 }, { lat: 51.51, lng: -0.12 }],
    updatedAt: new Date().toISOString(),
    confidence: 0.95,
  });

  it('falls through to the generic label when nothing needs attention', () => {
    expect(speedSectionAttentionLabel(healthy())).toBe('Review saved rule');
  });

  it('names the single most urgent problem', () => {
    expect(speedSectionAttentionLabel({ ...healthy(), sectionPoints: [] }))
      .toBe('Needs traced road line');
    expect(speedSectionAttentionLabel({ ...healthy(), confidence: 0 }))
      .toBe('Low-confidence speed evidence');
    expect(speedSectionAttentionLabel({ ...healthy(), expiresAt: '2020-01-01T00:00:00.000Z' }))
      .toBe('Expired temporary rule');
  });

  it('ranks expiry above every other problem', () => {
    // A rule that is already gone is not worth reporting as merely low-quality.
    expect(speedSectionAttentionLabel({
      ...healthy(),
      sectionPoints: [],
      confidence: 0,
      expiresAt: '2020-01-01T00:00:00.000Z',
    })).toBe('Expired temporary rule');
  });
});

describe('speedStatusToast', () => {
  it('surfaces problems as destructive', () => {
    for (const message of [
      'Could not save that rule.',
      'Cannot snap this section.',
      'Enter a valid speed limit.',
      'Tap at least two points.',
      'Speed-rule backup is too large to import.',
      'Rescoring failed for 3 trips.',
    ]) {
      expect(speedStatusToast(message)).toMatchObject({ variant: 'destructive' });
    }
  });

  it('surfaces confirmations without the destructive variant', () => {
    for (const message of ['Saved road speed.', 'Deleted 2 rules.', 'Change undone.']) {
      const toast = speedStatusToast(message);
      expect(toast).toMatchObject({ title: 'Saved road speed updated' });
      expect(toast.variant).toBeUndefined();
    }
    expect(speedStatusToast('Prepared a merged section.'))
      .toMatchObject({ title: 'Saved road speed ready' });
    expect(speedStatusToast('Matching trip scores are updating.'))
      .toMatchObject({ title: 'Saved road speed saved' });
  });

  it('stays silent for empty or unclassified status text', () => {
    expect(speedStatusToast('')).toBeNull();
    expect(speedStatusToast('   ')).toBeNull();
    expect(speedStatusToast(null)).toBeNull();
    expect(speedStatusToast('Some status nobody classified')).toBeNull();
  });

  it('accepts either a string or an object carrying a message', () => {
    expect(speedStatusToast({ message: 'Deleted 2 rules.' }))
      .toMatchObject({ title: 'Saved road speed updated' });
  });
});

describe('mapSectionReasonText', () => {
  it('explains a saved rule as taking precedence over trip evidence', () => {
    expect(mapSectionReasonText({ saved: true, source: 'user_confirmed_posted_sign' }))
      .toMatch(/used before trip-derived map evidence/);
  });

  it('explains a section being drawn right now', () => {
    expect(mapSectionReasonText({}, true)).toMatch(/^New traced road section/);
  });

  it('distinguishes an observed-only section from one with no limit at all', () => {
    expect(mapSectionReasonText({ observedLimitKmh: 50, sampleCount: 4 }))
      .toMatch(/^Observed-only trip section from 4 route samples/);
    expect(mapSectionReasonText({ sampleCount: 1 })).toMatch(/^Unset trip section from 1 route sample;/);
    expect(mapSectionReasonText({})).toMatch(/recorded route evidence/);
  });

  it('says plainly whether a Road Memory estimate can affect scoring', () => {
    expect(mapSectionReasonText({
      roadMemoryCandidate: true,
      effectiveLimitKmh: 50,
      canAffectScoreAndAlerts: true,
      tripCount: 6,
      confidence: 0.82,
    })).toMatch(/This estimate can affect scoring and alerts\./);
    expect(mapSectionReasonText({
      roadMemoryCandidate: true,
      effectiveLimitKmh: 50,
      tripCount: 2,
      confidence: 0.4,
    })).toMatch(/does not affect scoring or alerts yet/);
  });
});
