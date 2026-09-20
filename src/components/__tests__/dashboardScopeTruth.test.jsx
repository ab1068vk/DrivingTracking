import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PremiumTotalsCard from '@/components/PremiumTotalsCard';
import { buildPremiumFleetIntelligenceViewModel } from '@/components/PremiumFleetIntelligenceCard';

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
      <PremiumTotalsCard trips={trips} units="metric" activity={activity()} activityExact={false} />,
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
      <PremiumTotalsCard trips={trips} units="metric" activity={activity()} activityExact />,
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
    // 60-row window. A driver with 120 completed trips therefore got
    // `activityExact === true` and saw "All-time totals" over 60 trips. With no
    // shared activity object the card is folding its own rows and may not make
    // that claim however converged the ledger is.
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activityExact />,
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
      <PremiumTotalsCard trips={trips} units="metric" activity={shared} activityExact />,
    );
    expect(html).toContain('10063.7 km');
    // ...and emphatically not the 51.3 km its own `trips` prop folds to.
    expect(html).not.toContain('51.3 km');
  });

  it('reports a refusal as a refusal, not as an unfinished tally', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard
        trips={trips}
        units="metric"
        activity={activity()}
        activityExact
        activityUnavailable={{ code: 'STORAGE' }}
      />,
    );
    expect(html).toContain('Totals unavailable');
    expect(html).toContain('could not be read');
    expect(html).not.toContain('Still counting');
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
