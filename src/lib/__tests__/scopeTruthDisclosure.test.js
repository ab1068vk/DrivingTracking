import { describe, expect, it } from 'vitest';
import {
  SCOPE_STATE,
  allTimeCaption,
  allTimeHeading,
  allTimeMetricScope,
  atLeastTotal,
  isPartialScope,
  meanScopeSublabel,
  scopeStateOf,
  vehicleScopeNote,
} from '@/lib/scopeDisclosure';

/**
 * DPD-017 / DPD-018 — the vocabulary, in both states.
 *
 * The 500-trip audit found no arithmetic error anywhere in the app. What it
 * found was the Dashboard calling a most-recent-200 window "All-time totals"
 * and "Everything recorded on this device" against a true 500 trips and
 * 10,063.7 km — a 5x understatement stated as the complete record of the
 * driver's own history. So these tests pin BOTH directions: an incomplete
 * population must never claim lifetime truth, and a verified one must not be
 * left hedging forever once it really is complete.
 */
describe('scope disclosure vocabulary', () => {
  it('separates verified, partial and unavailable', () => {
    expect(scopeStateOf({ exact: true })).toBe(SCOPE_STATE.VERIFIED);
    expect(scopeStateOf({ exact: false })).toBe(SCOPE_STATE.PARTIAL);
    // A refusal wins over exactness: a number nobody could obtain is neither a
    // complete number nor a partial one.
    expect(scopeStateOf({ exact: true, unavailable: { code: 'STORAGE' } })).toBe(SCOPE_STATE.UNAVAILABLE);
    expect(isPartialScope(SCOPE_STATE.PARTIAL)).toBe(true);
    expect(isPartialScope(SCOPE_STATE.VERIFIED)).toBe(false);
    expect(isPartialScope(SCOPE_STATE.UNAVAILABLE)).toBe(false);
  });

  it('states an additive total as a floor while partial and as fact when verified', () => {
    expect(atLeastTotal('2,892.6 km', SCOPE_STATE.PARTIAL)).toBe('at least 2,892.6 km');
    expect(atLeastTotal('10,063.7 km', SCOPE_STATE.VERIFIED)).toBe('10,063.7 km');
    expect(atLeastTotal('10,063.7 km', SCOPE_STATE.UNAVAILABLE)).toBe('10,063.7 km');
  });

  it('never calls a mean a floor, because more rows can move it either way', () => {
    expect(meanScopeSublabel('typical distance', SCOPE_STATE.PARTIAL)).toBe('over trips counted so far');
    expect(meanScopeSublabel('typical distance', SCOPE_STATE.VERIFIED)).toBe('typical distance');
  });

  it('refuses the all-time claim while the population is bounded', () => {
    expect(allTimeHeading(SCOPE_STATE.PARTIAL)).toBe('Totals so far');
    expect(allTimeCaption(SCOPE_STATE.PARTIAL)).toBe('Still counting everything recorded on this device');
    expect(allTimeMetricScope(SCOPE_STATE.PARTIAL)).toBe('counted so far');

    // ...and restores it verbatim once the ledger has actually converged.
    expect(allTimeHeading(SCOPE_STATE.VERIFIED)).toBe('All-time totals');
    expect(allTimeCaption(SCOPE_STATE.VERIFIED)).toBe('Everything recorded on this device');
    expect(allTimeMetricScope(SCOPE_STATE.VERIFIED)).toBe('all time');
  });

  it('says nothing extra on a verified vehicle page and qualifies a partial one', () => {
    expect(vehicleScopeNote(SCOPE_STATE.VERIFIED)).toBeNull();
    expect(vehicleScopeNote(SCOPE_STATE.PARTIAL)).toContain('read so far');
    expect(vehicleScopeNote(SCOPE_STATE.UNAVAILABLE)).toContain('could not be read');
  });

  it('does not claim a total could not be read when it merely is not finished', () => {
    expect(allTimeCaption(SCOPE_STATE.UNAVAILABLE)).not.toBe(allTimeCaption(SCOPE_STATE.PARTIAL));
    expect(allTimeHeading(SCOPE_STATE.UNAVAILABLE)).toBe('Totals unavailable');
  });
});
