import { describe, expect, it } from 'vitest';
import {
  SCOPE_STATE,
  allTimeCaption,
  allTimeHeading,
  atLeastTotal,
  combinedScope,
  meanScopeSublabel,
  scopeBadge,
  scopeStateOf,
} from '@/lib/scopeDisclosure';

/**
 * DPD-017 — the RAW SIGNAL to SCOPE mapping.
 *
 * The previous round's tests injected `SCOPE_STATE` constants directly, so the
 * function that decides WHICH state applies had no coverage at all. That is
 * precisely where the defect lived: a D1 refusal was allowed to describe figures
 * the activity reducer had supplied, producing
 *
 *     Totals unavailable / Your totals could not be read
 *     2892.6 km · 200 trips · 14.5 km average
 *
 * on a device holding 500 trips — a refusal sentence above numbers that had been
 * read, with their floors stripped.
 *
 * This file therefore starts from `dashboardData`-shaped inputs and asserts the
 * whole way through to the rendered sentence.
 */

/** Verbatim reproduction of the `activityScope` memo in `Dashboard.jsx`. */
const activityScopeFor = (dashboardData, isAllTimeActivity = true) => {
  const lifetimeAnswered = Number.isFinite(dashboardData.lifetimeTrips)
    && Number.isFinite(dashboardData.lifetimeDistanceKm);
  const lifetimeScope = scopeStateOf({
    answered: lifetimeAnswered,
    exact: lifetimeAnswered,
    unavailable: dashboardData.lifetimeUnavailable,
  });
  const windowScope = scopeStateOf({
    answered: dashboardData.activityStats != null,
    exact: dashboardData.activityExact === true,
    unavailable: dashboardData.activityUnavailable,
  });
  return isAllTimeActivity ? combinedScope(lifetimeScope, windowScope) : windowScope;
};

const STATS_200 = {
  trip_count: 200, distance_m: 2892600, driving_seconds: 255060,
  active_local_days: 67, longest_trip_distance_m: 167100,
};

/** Both queries still in flight. React Query gives `undefined` data. */
const pending = {
  lifetimeTrips: null, lifetimeDistanceKm: null, lifetimeUnavailable: null,
  activityStats: null, activityExact: false, activityUnavailable: null,
};

/** D1 not ready (`OWNER_NOT_READY`) while the reducer answered its 200-row cap. */
const refusedWithSubstitute = {
  lifetimeTrips: null, lifetimeDistanceKm: null,
  lifetimeUnavailable: { code: 'OWNER_NOT_READY' },
  activityStats: STATS_200, activityExact: false, activityUnavailable: null,
};

/** Both sources refused. Nothing was read. */
const refusedWithoutSubstitute = {
  lifetimeTrips: null, lifetimeDistanceKm: null,
  lifetimeUnavailable: { code: 'OWNER_NOT_READY' },
  activityStats: null, activityExact: false,
  activityUnavailable: { code: 'STORAGE' },
};

/** D1 converged; the reducer still capped at 200 and never follows its continuation. */
const lifetimeExactWindowCapped = {
  lifetimeTrips: 500, lifetimeDistanceKm: 10063.7, lifetimeUnavailable: null,
  activityStats: STATS_200, activityExact: false, activityUnavailable: null,
};

/** Everything answered and complete. */
const fullyVerified = {
  lifetimeTrips: 500, lifetimeDistanceKm: 10063.7, lifetimeUnavailable: null,
  activityStats: STATS_200, activityExact: true, activityUnavailable: null,
};

/** Answered and complete over a genuinely empty history. */
const verifiedEmpty = {
  lifetimeTrips: 0, lifetimeDistanceKm: 0, lifetimeUnavailable: null,
  activityStats: { trip_count: 0, distance_m: 0 }, activityExact: true, activityUnavailable: null,
};

describe('raw dashboard signals map to the right scope', () => {
  it('pending -> UNKNOWN', () => {
    expect(activityScopeFor(pending)).toBe(SCOPE_STATE.UNKNOWN);
  });

  it('refused WITH a valid substitute -> PARTIAL, not UNAVAILABLE', () => {
    // The defect, as a single assertion. The reducer answered; its numbers are
    // on screen; a refusal from the other source may not describe them.
    expect(activityScopeFor(refusedWithSubstitute)).toBe(SCOPE_STATE.PARTIAL);
    expect(activityScopeFor(refusedWithSubstitute)).not.toBe(SCOPE_STATE.UNAVAILABLE);
  });

  it('refused with NO substitute -> UNAVAILABLE', () => {
    expect(activityScopeFor(refusedWithoutSubstitute)).toBe(SCOPE_STATE.UNAVAILABLE);
  });

  it('exact lifetime beside a capped window -> PARTIAL', () => {
    // `useDashboardData` never follows `activityContinuation`, so driving time,
    // active days and longest trip stay bounded even after D1 converges. Three
    // of six metrics really are a window, so the card may not claim all time.
    expect(activityScopeFor(lifetimeExactWindowCapped)).toBe(SCOPE_STATE.PARTIAL);
  });

  it('everything answered and complete -> VERIFIED', () => {
    expect(activityScopeFor(fullyVerified)).toBe(SCOPE_STATE.VERIFIED);
  });

  it('verified over a genuinely empty history -> VERIFIED, from the signal not the count', () => {
    expect(activityScopeFor(verifiedEmpty)).toBe(SCOPE_STATE.VERIFIED);
    // The same zero count under pending signals must NOT reach VERIFIED.
    expect(activityScopeFor(pending)).toBe(SCOPE_STATE.UNKNOWN);
  });

  it('the seven-day face ignores a lifetime refusal entirely', () => {
    // Its figures come only from the reducer, so the lifetime aggregate has no
    // bearing on what it may claim.
    expect(activityScopeFor(refusedWithSubstitute, false)).toBe(SCOPE_STATE.PARTIAL);
    expect(activityScopeFor(pending, false)).toBe(SCOPE_STATE.UNKNOWN);
  });

  it('a mid-flight refetch does not collapse a good scope', () => {
    // React Query retains `data` while refetching, so the signals are unchanged
    // and the scope must not flicker to UNKNOWN under the user.
    expect(activityScopeFor({ ...fullyVerified })).toBe(SCOPE_STATE.VERIFIED);
    expect(activityScopeFor({ ...lifetimeExactWindowCapped })).toBe(SCOPE_STATE.PARTIAL);
  });
});

describe('the mapped scope produces truthful sentences end to end', () => {
  it('never says the totals could not be read above numbers that were read', () => {
    const scope = activityScopeFor(refusedWithSubstitute);
    expect(allTimeHeading(scope)).not.toBe('Totals unavailable');
    expect(allTimeCaption(scope)).not.toContain('could not be read');
    // ...and the floors survive, which is what the refusal branch stripped.
    expect(atLeastTotal('2892.6 km', scope)).toBe('at least 2892.6 km');
    expect(atLeastTotal('200', scope)).toBe('at least 200');
    // A mean over a partial population still discloses its denominator.
    expect(meanScopeSublabel('typical distance', scope)).toBe('over trips counted so far');
  });

  it('does say so when nothing was read', () => {
    const scope = activityScopeFor(refusedWithoutSubstitute);
    expect(allTimeHeading(scope)).toBe('Totals unavailable');
    expect(allTimeCaption(scope)).toContain('could not be read');
  });

  it('claims the complete history only when everything is complete', () => {
    expect(allTimeCaption(activityScopeFor(fullyVerified)))
      .toBe('Everything recorded on this device');
    for (const data of [pending, refusedWithSubstitute, refusedWithoutSubstitute,
      lifetimeExactWindowCapped]) {
      expect(allTimeCaption(activityScopeFor(data)))
        .not.toBe('Everything recorded on this device');
    }
  });
});

describe('the header badge and the card cannot disagree', () => {
  it('derives one sentence from the same state the card uses', () => {
    // The header previously had its own derivation and contradicted the card.
    expect(scopeBadge(activityScopeFor(pending)))
      .toBe('Lifetime totals are still being prepared');
    expect(scopeBadge(activityScopeFor(refusedWithSubstitute)))
      .toBe('Activity totals are at least this much so far');
    expect(scopeBadge(activityScopeFor(refusedWithoutSubstitute)))
      .toBe('Lifetime totals could not be read');
    expect(scopeBadge(activityScopeFor(lifetimeExactWindowCapped)))
      .toBe('Activity totals are at least this much so far');
    // Nothing to disclose once the population really is complete.
    expect(scopeBadge(activityScopeFor(fullyVerified))).toBeNull();
  });

  it('never announces a refusal while the card shows a floor, or the reverse', () => {
    for (const data of [pending, refusedWithSubstitute, refusedWithoutSubstitute,
      lifetimeExactWindowCapped, fullyVerified, verifiedEmpty]) {
      const scope = activityScopeFor(data);
      const badge = scopeBadge(scope);
      const saysUnreadable = badge === 'Lifetime totals could not be read';
      const cardSaysUnreadable = allTimeHeading(scope) === 'Totals unavailable';
      expect(saysUnreadable, `badge/card disagree for ${JSON.stringify(data)}`)
        .toBe(cardSaysUnreadable);
    }
  });
});

describe('combinedScope is not "most cautious"', () => {
  it('lets an answer outrank another population refusal', () => {
    expect(combinedScope(SCOPE_STATE.UNAVAILABLE, SCOPE_STATE.PARTIAL)).toBe(SCOPE_STATE.PARTIAL);
    expect(combinedScope(SCOPE_STATE.UNAVAILABLE, SCOPE_STATE.VERIFIED)).toBe(SCOPE_STATE.PARTIAL);
  });

  it('still refuses only when every source refused', () => {
    expect(combinedScope(SCOPE_STATE.UNAVAILABLE, SCOPE_STATE.UNAVAILABLE))
      .toBe(SCOPE_STATE.UNAVAILABLE);
    // A pending source may yet answer, so this is not a refusal.
    expect(combinedScope(SCOPE_STATE.UNAVAILABLE, SCOPE_STATE.UNKNOWN))
      .toBe(SCOPE_STATE.UNKNOWN);
  });

  it('claims complete only when every source is complete', () => {
    expect(combinedScope(SCOPE_STATE.VERIFIED, SCOPE_STATE.VERIFIED)).toBe(SCOPE_STATE.VERIFIED);
    expect(combinedScope(SCOPE_STATE.VERIFIED, SCOPE_STATE.PARTIAL)).toBe(SCOPE_STATE.PARTIAL);
    expect(combinedScope(SCOPE_STATE.VERIFIED, SCOPE_STATE.UNKNOWN)).toBe(SCOPE_STATE.PARTIAL);
  });

  it('claims nothing with nothing to go on', () => {
    expect(combinedScope()).toBe(SCOPE_STATE.UNKNOWN);
    expect(combinedScope([])).toBe(SCOPE_STATE.UNKNOWN);
    expect(combinedScope(SCOPE_STATE.UNKNOWN, SCOPE_STATE.UNKNOWN)).toBe(SCOPE_STATE.UNKNOWN);
  });
});
