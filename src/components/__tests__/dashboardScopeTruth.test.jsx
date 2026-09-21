import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumTotalsCard from '@/components/PremiumTotalsCard';
import { buildPremiumFleetIntelligenceViewModel } from '@/components/PremiumFleetIntelligenceCard';
import { SCOPE_STATE } from '@/lib/scopeDisclosure';

/**
 * DPD-017 / DPD-018 at the surfaces the audit caught, in both states.
 *
 * Observed on the A54 at 500 trips, same device, same moment:
 *
 *   History  → 500 matching trips · 10054.4 km
 *   Dashboard → 200 trips · 2892.6 km, under "All-time totals" and
 *               "Everything recorded on this device"
 *
 * The 200-trip figures were exactly right for the window the D1 bounded
 * fallback serves. The headings were not. Both halves are pinned here: the
 * bounded state must not claim lifetime truth, and the verified state must get
 * the plain wording back.
 */

const tripAt = (id, km, isoDay) => ({
  id,
  status: 'completed',
  start_time: `${isoDay}T09:00:00.000Z`,
  end_time: `${isoDay}T09:30:00.000Z`,
  distance_km: km,
  duration_seconds: 1800,
  score_overall: 88,
});

const trips = [
  tripAt('t1', 12.5, '2026-09-14'),
  tripAt('t2', 31.25, '2026-09-16'),
  tripAt('t3', 7.5, '2026-09-18'),
];

/** The shape `Dashboard.jsx` builds and both variants render. */
const activity = (overrides = {}) => ({
  periodDays: null,
  tripCount: 500,
  distanceKm: 10063.7,
  drivingSeconds: 842160,
  activeDays: 167,
  averageTripKm: 20.13,
  longestTripKm: 167.12,
  tripsPerActiveDay: 3,
  ...overrides,
});

describe('Dashboard totals disclose the population they actually folded', () => {
  it('will not call a bounded window "all time"', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activity={activity()} scope={SCOPE_STATE.PARTIAL} />,
    );

    expect(html).toContain('Totals so far');
    expect(html).toContain('Still counting everything recorded on this device');
    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');

    // Additive totals are floors and say so.
    expect(html).toContain('at least 10063.7 km');
    expect(html).toContain('at least 500');
    expect(html).toContain('at least 167');
    expect(html).toContain('counted so far');
    // A mean is not a floor. It must never be prefixed "at least"; its
    // denominator is disclosed instead.
    expect(html).toContain('over trips counted so far');
    expect(html).not.toContain('at least 20.1 km');
  });

  it('states plain lifetime totals once the ledger has converged', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activity={activity()} scope={SCOPE_STATE.VERIFIED} />,
    );

    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    // The lifetime population, not the bounded row window beside it.
    expect(html).toContain('10063.7 km');
    expect(html).toContain('>500<');
    expect(html).not.toContain('at least');
    expect(html).not.toContain('counted so far');
    expect(html).not.toContain('Still counting');
  });

  it('will not claim lifetime truth while it is folding its own bounded rows', () => {
    // Regression for the review finding: the exactness signal describes the
    // 200-row activity reducer, while this card used to fold the Dashboard's
    // 60-row window. A driver with 120 completed trips therefore saw
    // "All-time totals" over 60 trips. With no scope supplied the card is
    // folding its own rows and answers PARTIAL, whatever the ledger says.
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" />,
    );

    expect(html).toContain('Totals so far');
    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');
    expect(html).toContain('at least 51.3 km');
  });

  it('renders the same population the standard variant does', () => {
    // The two Dashboard variants used to fold different populations, so the
    // same device showed two different lifetime distances depending on an
    // appearance setting.
    const shared = activity();
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activity={shared} scope={SCOPE_STATE.VERIFIED} />,
    );
    expect(html).toContain('10063.7 km');
    // ...and emphatically not the 51.3 km its own `trips` prop folds to.
    expect(html).not.toContain('51.3 km');
  });

  it('reports a refusal as a refusal, not as an unfinished tally', () => {
    // Rendered with an EMPTY activity object: `UNAVAILABLE` now means nothing
    // was read at all, so the card carries no figures for the sentence to
    // contradict. The previous version of this test passed a fully populated
    // 500-trip object and asserted nothing about the numbers, which is how the
    // "could not be read above real numbers" defect slipped through.
    const html = renderToStaticMarkup(
      <PremiumTotalsCard
        trips={[]}
        units="metric"
        activity={{ tripCount: 0, distanceKm: 0, drivingSeconds: 0, activeDays: 0, averageTripKm: 0, longestTripKm: 0 }}
        scope={SCOPE_STATE.UNAVAILABLE}
      />,
    );
    expect(html).toContain('Totals unavailable');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('Still counting');
  });

  it('keeps real figures and their floors when one source refused and another answered', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard
        trips={trips}
        units="metric"
        activity={activity({ tripCount: 200, distanceKm: 2892.6, averageTripKm: 14.463 })}
        scope={SCOPE_STATE.PARTIAL}
      />,
    );
    expect(html).not.toContain('could not be read');
    expect(html).toContain('at least 2892.6 km');
    expect(html).toContain('at least 200');
    expect(html).toContain('over trips counted so far');
  });
});

describe('Fleet intelligence discloses whether per-vehicle totals are complete', () => {
  const intelligence = (lifetimeExact) => ({
    lifetimeExact,
    assignmentReviewCount: 0,
    serviceDueCount: 0,
    busiestVehicle: { vehicle: { name: 'Daily Commuter' }, distanceKm: 382.7, trips: 41, score: 84 },
    bestScoreVehicle: { vehicle: { name: 'Daily Commuter' }, score: 84 },
  });

  it('states a partial per-vehicle total as a floor', () => {
    const model = buildPremiumFleetIntelligenceViewModel(intelligence(false), { units: 'metric' });
    // The audit's exact reading: "Daily Commuter 382.7 km across 41 trips",
    // against a true 200 trips / 3,876.5 km for that vehicle.
    expect(model.busiestDetail).toBe('at least 382.7 km across 41 trips');
  });

  it('states a verified per-vehicle total as fact', () => {
    const model = buildPremiumFleetIntelligenceViewModel(intelligence(true), { units: 'metric' });
    expect(model.busiestDetail).toBe('382.7 km across 41 trips');
  });
});

describe('DPD-017 four-state law, on both Dashboard variants', () => {
  /**
   * The exact object `Dashboard.jsx` hands both variants while its queries are
   * pending. `dashboardActivity` is a `useMemo` that always returns an object,
   * and every absent field folds through `Number(undefined) || 0`, so a device
   * holding 500 trips presents this shape on every cold launch.
   */
  const pendingActivity = {
    periodDays: null,
    tripCount: 0,
    distanceKm: 0,
    drivingSeconds: 0,
    activeDays: 0,
    longestTripKm: 0,
    averageTripKm: 0,
    tripsPerActiveDay: 0,
  };

  const render = (scope, data = pendingActivity) => renderToStaticMarkup(
    <PremiumTotalsCard trips={[]} units="metric" activity={data} scope={scope} />,
  );

  it('UNKNOWN: does not call an unanswered source a complete history', () => {
    const html = render(SCOPE_STATE.UNKNOWN);

    // The defect this exception exists to correct: 0 trips presented as the
    // complete record of a driver holding 500.
    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');
    expect(html).toContain('Preparing totals');
    expect(html).toContain('Your lifetime totals are still being prepared');
    // Nor does it claim to be counting a population it has not seen.
    expect(html).not.toContain('Still counting');
  });

  it('UNKNOWN: shows no bare zero that could read as a measurement', () => {
    const html = render(SCOPE_STATE.UNKNOWN);
    // Every additive figure is a floor, which is never false.
    expect(html).toContain('at least 0');
    expect(html).toContain('not counted yet');
  });

  it('PARTIAL: hedges explicitly', () => {
    const html = render(SCOPE_STATE.PARTIAL, {
      ...pendingActivity, tripCount: 200, distanceKm: 2892.6,
    });
    expect(html).toContain('Totals so far');
    expect(html).toContain('Still counting everything recorded on this device');
    expect(html).toContain('at least 2892.6 km');
    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');
  });

  it('VERIFIED non-empty: states the complete lifetime truth plainly', () => {
    const html = render(SCOPE_STATE.VERIFIED, {
      ...pendingActivity, tripCount: 500, distanceKm: 10063.7, averageTripKm: 20.13,
    });
    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    expect(html).toContain('10063.7 km');
    expect(html).not.toContain('at least');
    expect(html).not.toContain('Preparing totals');
  });

  it('VERIFIED empty: states zero as the whole truth, reached from the signal not the count', () => {
    const html = render(SCOPE_STATE.VERIFIED, pendingActivity);
    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    expect(html).not.toContain('at least');
    // The distinguishing point: the SAME zero-valued object renders as a
    // complete truth here and as "preparing" under UNKNOWN. Only the
    // authoritative signal differs.
    expect(render(SCOPE_STATE.UNKNOWN, pendingActivity)).not.toContain('All-time totals');
  });

  it('the count alone can never move the card between those two states', () => {
    // Same scope, different counts: wording is decided by the signal.
    const zero = render(SCOPE_STATE.UNKNOWN, pendingActivity);
    const many = render(SCOPE_STATE.UNKNOWN, { ...pendingActivity, tripCount: 500 });
    expect(zero).toContain('Preparing totals');
    expect(many).toContain('Preparing totals');
  });
});
