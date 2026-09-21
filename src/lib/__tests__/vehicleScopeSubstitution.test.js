import { describe, expect, it } from 'vitest';
import { buildPremiumFleetIntelligenceViewModel } from '@/components/PremiumFleetIntelligenceCard';
import { SCOPE_STATE, atLeastTotal, vehicleScopeNote } from '@/lib/scopeDisclosure';
// The page's OWN decision, not a transcription of it: a local copy would keep
// passing after `Vehicles.jsx` changed, which is how the first version of this
// file managed to be green against the defective tree.
import { fleetScopeFor } from '@/pages/Vehicles';

/**
 * DPD-018 — the Vehicles scope, which is a SUBSTITUTION and not a blend.
 *
 * `buildFleetIntelligence` uses the D1 fleet aggregate when it answers and
 * otherwise falls back to the bounded recent window, so only one of the two is
 * ever on screen.
 *
 * Feeding the D1 refusal straight into `scopeStateOf` made the page label the
 * *substitute's* real figures `UNAVAILABLE`, so `atLeastTotal` stripped their
 * floors and "Per-vehicle totals could not be read" printed directly above
 * numbers that had been read — on the 500-trip device, where D1 is unconverged
 * and `queryP6AnalyticsAggregate` refuses with `OWNER_NOT_READY`. The premium
 * card meanwhile computed its own scope without the refusal and rendered
 * "at least 382.5 km" for the same data the standard page rendered bare.
 *
 * `combinedScope` is deliberately NOT used here: combining would hedge exact D1
 * totals because the window beside them is bounded, when the window is not
 * being shown.
 */



describe('the Vehicles scope follows whichever population supplied the figures', () => {
  it('D1 refused but the recent window answered -> PARTIAL, not UNAVAILABLE', () => {
    // The defect, as one assertion. This is the 500-trip device's own state.
    const scope = fleetScopeFor({ lifetimeExact: false, recentUnavailable: null });

    expect(scope).toBe(SCOPE_STATE.PARTIAL);
    expect(scope).not.toBe(SCOPE_STATE.UNAVAILABLE);
    // The floors survive, which is what a bare UNAVAILABLE stripped.
    expect(atLeastTotal('382.5 km', scope)).toBe('at least 382.5 km');
    expect(atLeastTotal('41', scope)).toBe('at least 41');
    // ...and the note does not claim the figures could not be read.
    expect(vehicleScopeNote(scope)).not.toContain('could not be read');
    expect(vehicleScopeNote(scope)).toContain('read so far');
  });

  it('D1 answered -> VERIFIED, and exact totals are not hedged', () => {
    const scope = fleetScopeFor({ lifetimeExact: true });

    expect(scope).toBe(SCOPE_STATE.VERIFIED);
    expect(atLeastTotal('3876.5 km', scope)).toBe('3876.5 km');
    expect(vehicleScopeNote(scope)).toBeNull();
  });

  it('D1 answered while the recent page refused -> still VERIFIED', () => {
    // The refusal belongs to a population that is not on screen. The recent
    // page keeps its own banner; it does not get to describe D1's totals.
    const scope = fleetScopeFor({ lifetimeExact: true, recentUnavailable: { code: 'STORAGE' } });
    expect(scope).toBe(SCOPE_STATE.VERIFIED);
  });

  it('neither population answered -> UNAVAILABLE, which is then truthful', () => {
    const scope = fleetScopeFor({ lifetimeExact: false, recentUnavailable: { code: 'STORAGE' } });

    expect(scope).toBe(SCOPE_STATE.UNAVAILABLE);
    expect(vehicleScopeNote(scope)).toContain('could not be read');
  });
});

describe('both Vehicles variants describe one population the same way', () => {
  const intelligence = (lifetimeExact) => ({
    lifetimeExact,
    assignmentReviewCount: 0,
    serviceDueCount: 0,
    busiestVehicle: { vehicle: { name: 'Daily Commuter' }, distanceKm: 382.5, trips: 41, score: 84 },
    bestScoreVehicle: { vehicle: { name: 'Daily Commuter' }, score: 84 },
  });

  it('the premium card uses the scope the page decided, not one of its own', () => {
    const scope = fleetScopeFor({ lifetimeExact: false });
    const model = buildPremiumFleetIntelligenceViewModel(intelligence(false), {
      units: 'metric', scope,
    });
    // Same wording the standard page produces for the same data.
    expect(model.busiestDetail).toBe('at least 382.5 km across 41 trips');
  });

  it('agrees with the standard page in the verified state too', () => {
    const scope = fleetScopeFor({ lifetimeExact: true });
    const model = buildPremiumFleetIntelligenceViewModel(intelligence(true), {
      units: 'metric', scope,
    });
    expect(model.busiestDetail).toBe('382.5 km across 41 trips');
    expect(atLeastTotal('382.5 km across 41 trips', scope)).toBe(model.busiestDetail);
  });

  it('falls back to its own derivation only when no scope is supplied', () => {
    const model = buildPremiumFleetIntelligenceViewModel(intelligence(true), { units: 'metric' });
    expect(model.busiestDetail).toBe('382.5 km across 41 trips');
  });
});
