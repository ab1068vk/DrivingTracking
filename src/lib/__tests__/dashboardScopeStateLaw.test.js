import { describe, expect, it } from 'vitest';
import {
  SCOPE_STATE,
  allTimeCaption,
  allTimeHeading,
  allTimeMetricScope,
  atLeastTotal,
  isCompleteScope,
  meanScopeSublabel,
  scopeStateOf,
  vehicleScopeNote,
  weakestScope,
} from '@/lib/scopeDisclosure';

/**
 * DPD-017 — the four-state law, and the specific way the first correction of it
 * was wrong.
 *
 * That correction inferred completeness from `tripCount === 0`, reasoning that
 * the most recent N of a non-empty history is never empty. The reasoning holds
 * only for a source that has ANSWERED. A pending query, a refused query and a
 * genuinely empty history all arrive as `0`, and `dashboardActivity` folds every
 * absent field through `Number(undefined) || 0`. So a 500-trip device rendered
 * "All-time totals / Everything recorded on this device" over 0 trips on every
 * cold launch.
 *
 * These tests pin the law itself rather than any particular sentence: a count
 * can never establish completeness, and only an authoritative answered+exact
 * signal unlocks a complete claim.
 */

const UNKNOWN = scopeStateOf({ answered: false, exact: false });
const UNKNOWN_DESPITE_EXACT = scopeStateOf({ answered: false, exact: true });
const PARTIAL = scopeStateOf({ answered: true, exact: false });
const VERIFIED = scopeStateOf({ answered: true, exact: true });
const UNAVAILABLE = scopeStateOf({ answered: true, exact: true, unavailable: { code: 'STORAGE' } });

describe('the four scope states are distinguished', () => {
  it('separates not-answered from answered-and-incomplete', () => {
    expect(UNKNOWN).toBe(SCOPE_STATE.UNKNOWN);
    expect(PARTIAL).toBe(SCOPE_STATE.PARTIAL);
    expect(VERIFIED).toBe(SCOPE_STATE.VERIFIED);
    expect(UNAVAILABLE).toBe(SCOPE_STATE.UNAVAILABLE);
  });

  it('will not let an exact flag override an unanswered source', () => {
    // An `exact` computed over a source that has not replied describes nothing.
    // This is the assertion that fails if absence is ever folded into "exact".
    expect(UNKNOWN_DESPITE_EXACT).toBe(SCOPE_STATE.UNKNOWN);
    expect(isCompleteScope(UNKNOWN_DESPITE_EXACT)).toBe(false);
  });

  it('treats a refusal as its own state, above everything else', () => {
    expect(scopeStateOf({ answered: false, unavailable: { code: 'X' } })).toBe(SCOPE_STATE.UNAVAILABLE);
  });

  it('defaults to answered so existing two-state callers are unchanged', () => {
    // Vehicles passes no `answered`; its source cannot be pending in the sense
    // this distinction is about, and its reviewed behaviour must not shift.
    expect(scopeStateOf({ exact: true })).toBe(SCOPE_STATE.VERIFIED);
    expect(scopeStateOf({ exact: false })).toBe(SCOPE_STATE.PARTIAL);
  });
});

describe('only VERIFIED unlocks a complete claim', () => {
  it('is the single gate', () => {
    expect(isCompleteScope(VERIFIED)).toBe(true);
    for (const state of [UNKNOWN, PARTIAL, UNAVAILABLE]) {
      expect(isCompleteScope(state), state).toBe(false);
    }
  });

  it('never says "Everything recorded on this device" outside VERIFIED', () => {
    expect(allTimeCaption(VERIFIED)).toBe('Everything recorded on this device');
    for (const state of [UNKNOWN, PARTIAL, UNAVAILABLE]) {
      expect(allTimeCaption(state), state).not.toBe('Everything recorded on this device');
      expect(allTimeHeading(state), state).not.toBe('All-time totals');
      expect(allTimeMetricScope(state), state).not.toBe('all time');
    }
    expect(allTimeHeading(VERIFIED)).toBe('All-time totals');
    expect(allTimeMetricScope(VERIFIED)).toBe('all time');
  });

  it('states an unanswered source as preparing, not as counting and not as complete', () => {
    expect(allTimeHeading(UNKNOWN)).toBe('Preparing totals');
    expect(allTimeCaption(UNKNOWN)).toBe('Your lifetime totals are still being prepared');
    // Distinct from PARTIAL: "still counting" claims a count is under way over
    // a population we have actually seen some of.
    expect(allTimeHeading(UNKNOWN)).not.toBe(allTimeHeading(PARTIAL));
    expect(allTimeCaption(UNKNOWN)).not.toBe(allTimeCaption(PARTIAL));
  });

  it('floors every additive total that is not verified, because a floor is never false', () => {
    expect(atLeastTotal('10063.7 km', VERIFIED)).toBe('10063.7 km');
    expect(atLeastTotal('2892.6 km', PARTIAL)).toBe('at least 2892.6 km');
    expect(atLeastTotal('0 km', UNKNOWN)).toBe('at least 0 km');
    // A refusal has no floor to state: nothing was counted at all.
    expect(atLeastTotal('0 km', UNAVAILABLE)).toBe('0 km');
  });

  it('never floors a mean, and discloses its denominator instead', () => {
    expect(meanScopeSublabel('typical distance', VERIFIED)).toBe('typical distance');
    expect(meanScopeSublabel('typical distance', PARTIAL)).toBe('over trips counted so far');
    expect(meanScopeSublabel('typical distance', UNKNOWN)).toBe('not counted yet');
  });
});

describe('zero is never evidence of completeness', () => {
  it('is the regression for the first correction of DPD-017', () => {
    // The exact shape `dashboardActivity` produces while its queries are
    // pending: every field collapsed to 0, no refusal, not exact.
    const pending = scopeStateOf({
      answered: false,
      exact: false,
      unavailable: null,
    });
    expect(pending).toBe(SCOPE_STATE.UNKNOWN);
    expect(allTimeCaption(pending)).not.toBe('Everything recorded on this device');
    expect(allTimeHeading(pending)).not.toBe('All-time totals');
  });

  it('still lets a genuinely verified empty history state zero as the whole truth', () => {
    // The fourth state. Reached from an authoritative answered+exact signal,
    // never from the count, so the count being 0 is incidental here.
    const verifiedEmpty = scopeStateOf({ answered: true, exact: true });
    expect(verifiedEmpty).toBe(SCOPE_STATE.VERIFIED);
    expect(allTimeHeading(verifiedEmpty)).toBe('All-time totals');
    expect(allTimeCaption(verifiedEmpty)).toBe('Everything recorded on this device');
    expect(atLeastTotal('0 km', verifiedEmpty)).toBe('0 km');
    expect(atLeastTotal('0', verifiedEmpty)).toBe('0');
  });
});

describe('several populations under one heading take the most cautious scope', () => {
  it('ranks refusal below unknown below partial below verified', () => {
    expect(weakestScope(VERIFIED, VERIFIED)).toBe(SCOPE_STATE.VERIFIED);
    expect(weakestScope(VERIFIED, PARTIAL)).toBe(SCOPE_STATE.PARTIAL);
    expect(weakestScope(VERIFIED, UNKNOWN)).toBe(SCOPE_STATE.UNKNOWN);
    expect(weakestScope(PARTIAL, UNKNOWN)).toBe(SCOPE_STATE.UNKNOWN);
    expect(weakestScope(VERIFIED, UNAVAILABLE)).toBe(SCOPE_STATE.UNAVAILABLE);
    expect(weakestScope(UNKNOWN, UNAVAILABLE)).toBe(SCOPE_STATE.UNAVAILABLE);
  });

  it('refuses to claim anything with nothing to go on', () => {
    expect(weakestScope()).toBe(SCOPE_STATE.UNKNOWN);
    expect(weakestScope([])).toBe(SCOPE_STATE.UNKNOWN);
  });

  it('is why an exact lifetime count beside a bounded window cannot read as complete', () => {
    // The real 500-trip shape: D1 answers exactly, the activity reducer is
    // capped and does not follow its continuation.
    const lifetime = scopeStateOf({ answered: true, exact: true });
    const window = scopeStateOf({ answered: true, exact: false });
    expect(weakestScope(lifetime, window)).toBe(SCOPE_STATE.PARTIAL);
    expect(allTimeCaption(weakestScope(lifetime, window)))
      .not.toBe('Everything recorded on this device');
  });
});

describe('the vehicle note follows the same gate', () => {
  it('is silent only when verified', () => {
    expect(vehicleScopeNote(VERIFIED)).toBeNull();
    expect(vehicleScopeNote(PARTIAL)).toContain('read so far');
    expect(vehicleScopeNote(UNKNOWN)).toContain('read so far');
    expect(vehicleScopeNote(UNAVAILABLE)).toContain('could not be read');
  });
});
