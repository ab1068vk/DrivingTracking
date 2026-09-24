import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveDashboardActivity } from '@/lib/dashboardStats';
import { buildDriverProgression } from '@/lib/driverProgression';
import { SCOPE_STATE } from '@/lib/scopeDisclosure';
import PremiumTotalsCard from '@/components/PremiumTotalsCard';
import VehicleCompare from '@/components/VehicleCompare';

// DPD-034. Three A54 figures were wrong because an EXACT lifetime value was
// combined arithmetically with a BOUNDED window value: Dashboard 44.8 trips /
// active day (true 3.0), Achievements "2876 excluded" (true 640), and a Vehicles
// "Total Distance" chart summing a recent page (382.7 km for a 23,709-km car).
// Every fixture here is large enough that the bounded and lifetime values differ,
// so a regression to the old arithmetic fails.

describe('Dashboard trips per active day uses one population', () => {
  // The A54 shape: lifetime 3,000 exact from D1; reducer scanned part of history.
  const reducer = { trip_count: 201, distance_m: 4_262_000, driving_seconds: 255_060, active_local_days: 67, longest_trip_distance_m: 167_100 };

  it('divides the reducer\'s own trip count by its own active days', () => {
    const activity = deriveDashboardActivity({ stats: reducer, isAllTime: true, lifetimeTrips: 3000, lifetimeDistanceKm: 63591.0 });
    expect(activity.tripsPerActiveDay).toBeCloseTo(201 / 67, 10);
    expect(activity.tripsPerActiveDay).not.toBeCloseTo(3000 / 67, 1); // the old 44.8
    // Lifetime totals are still the exact D1 figures.
    expect(activity.tripCount).toBe(3000);
    expect(activity.distanceKm).toBe(63591.0);
    expect(activity.averageTripKm).toBeCloseTo(63591.0 / 3000, 10);
  });

  it('is unchanged for the 7-day window, where both operands already share a scope', () => {
    const activity = deriveDashboardActivity({ stats: { ...reducer, trip_count: 6, active_local_days: 3 }, isAllTime: false, lifetimeTrips: 3000 });
    expect(activity.tripCount).toBe(6);
    expect(activity.tripsPerActiveDay).toBe(2);
  });

  it('renders the one-population rate and discloses its partial scope', () => {
    const activity = deriveDashboardActivity({ stats: reducer, isAllTime: true, lifetimeTrips: 3000, lifetimeDistanceKm: 63591.0 });
    const html = renderToStaticMarkup(
      <PremiumTotalsCard trips={[]} units="metric" activity={activity} scope={SCOPE_STATE.PARTIAL} />,
    );
    expect(html).toContain('3.0 trips / active day · over days counted so far');
    expect(html).not.toContain('44.8 trips / active day');
  });
});

describe('Achievements excluded count needs matching scopes', () => {
  // A 60-row bounded window from a 3,000-trip history: 12 short, 3 brief, 45 eligible.
  const window = Array.from({ length: 60 }, (_, index) => ({
    id: `t${index}`,
    status: 'completed',
    start_time: new Date(Date.UTC(2026, 8, 18) - index * 3_600_000).toISOString(),
    distance_km: index < 12 ? 1.2 : 12.5,
    duration_seconds: index >= 12 && index < 15 ? 120 : 1500,
    score_overall: 80,
  }));

  it('does not call unread trips excluded when the lifetime scan is partial', () => {
    const { eligibility } = buildDriverProgression(window, {}, {
      lifetime: { eligibleTrips: 124, completedTrips: 3000, distanceKm: 2807, exact: false },
    });
    expect(eligibility.excludedTrips).toBeNull(); // the old code said 2876
    expect(eligibility.windowExcludedTrips).toBe(15);
    expect(eligibility.windowCompletedTrips).toBe(60);
  });

  it('subtracts only when both operands are exact over the same population', () => {
    const { eligibility } = buildDriverProgression(window, {}, {
      lifetime: { eligibleTrips: 2360, completedTrips: 3000, distanceKm: 60000, exact: true },
    });
    expect(eligibility.excludedTrips).toBe(640);
  });

  it('with no lifetime owner, both operands come from the same rows', () => {
    const { eligibility } = buildDriverProgression(window, {}, {});
    expect(eligibility.excludedTrips).toBe(15);
  });
});

describe('Vehicle Comparison distance is a lifetime total or says it is not', () => {
  const vehicles = [
    { id: 'v1', name: 'Daily Commuter', color: '#111111' },
    { id: 'v2', name: 'Family SUV', color: '#222222' },
    { id: 'v3', name: 'Weekend Car', color: '#333333' },
  ];
  // A bounded recent page of 120 trips: small per-vehicle sums.
  const recent = Array.from({ length: 120 }, (_, index) => ({
    id: `r${index}`, status: 'completed', vehicle_id: vehicles[index % 3].id, distance_km: 3.2, score_overall: 80,
  }));
  const lifetime = {
    available: true,
    byVehicleId: new Map([
      ['v1', { trips: 1200, distanceKm: 23709.4, score: 83 }],
      ['v2', { trips: 720, distanceKm: 16344.0, score: 71 }],
      ['v3', { trips: 300, distanceKm: 6489.2, score: 73 }],
    ]),
  };

  it('uses the exact lifetime aggregate under "Total Distance"', () => {
    const html = renderToStaticMarkup(<VehicleCompare vehicles={vehicles} trips={recent} units="metric" lifetime={lifetime} />);
    expect(html).toContain('Total Distance');
    expect(html).toContain('23709.4');
    expect(html).not.toContain('>128<'); // 40 recent trips x 3.2 km — the old bounded sum
  });

  it('labels the recent page when any vehicle lacks an exact lifetime figure', () => {
    const partial = { available: true, byVehicleId: new Map([['v1', lifetime.byVehicleId.get('v1')]]) };
    const html = renderToStaticMarkup(<VehicleCompare vehicles={vehicles} trips={recent} units="metric" lifetime={partial} />);
    expect(html).not.toContain('Total Distance');
    expect(html).toContain('Recent distance');
    expect(html).toContain('latest 120 trips');
  });

  it('labels the score views as recent-window', () => {
    const html = renderToStaticMarkup(<VehicleCompare vehicles={vehicles} trips={recent} units="metric" lifetime={lifetime} />);
    expect(html.match(/latest 120 trips/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
