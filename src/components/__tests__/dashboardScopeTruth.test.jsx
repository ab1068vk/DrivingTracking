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

describe('Dashboard totals disclose the population they actually folded', () => {
  it('will not call a bounded window "all time"', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activityExact={false} />,
    );

    expect(html).toContain('Totals so far');
    expect(html).toContain('Still counting everything recorded on this device');
    expect(html).not.toContain('All-time totals');
    expect(html).not.toContain('Everything recorded on this device');

    // Additive totals are floors and say so.
    expect(html).toContain('at least 51.3 km');
    expect(html).toContain('at least 3');
    expect(html).toContain('counted so far');
    // A mean is not a floor. It must never be prefixed "at least"; its
    // denominator is disclosed instead.
    expect(html).toContain('over trips counted so far');
    expect(html).not.toContain('at least 17.1 km');
  });

  it('states plain lifetime totals once the ledger has converged', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activityExact />,
    );

    expect(html).toContain('All-time totals');
    expect(html).toContain('Everything recorded on this device');
    expect(html).toContain('51.3 km');
    expect(html).not.toContain('at least');
    expect(html).not.toContain('counted so far');
    expect(html).not.toContain('Still counting');
  });

  it('reports a refusal as a refusal, not as an unfinished tally', () => {
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={trips} units="metric" activityExact activityUnavailable={{ code: 'STORAGE' }} />,
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
