import { describe, expect, it } from 'vitest';
import { calculatePredictiveMaintenance } from '@/lib/tripInsights';

const vehicle = {
  odometer_km: 10000,
  maintenance_items: [
    { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 9000 },
    { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 9000 },
    { id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 9000 },
  ],
};
const trip = (index, overrides = {}) => ({
  status: 'completed',
  distance_km: 10,
  aggressive_driving_score: 90,
  braking_efficiency_score: 90,
  trip_tire_wear_units: 1,
  ...overrides,
});

describe('predictive maintenance', () => {
  it('handles empty trips', () => {
    expect(calculatePredictiveMaintenance([], vehicle, {}).stress_index).toBe(0);
  });

  it('handles a single trip', () => {
    expect(calculatePredictiveMaintenance([trip(0)], vehicle, {}).oil_change.adjusted_interval_km).toBeGreaterThan(0);
  });

  it('shortens intervals for high-stress driving', () => {
    const calm = calculatePredictiveMaintenance([trip(0)], vehicle, {});
    const harsh = calculatePredictiveMaintenance([trip(0, {
      aggressive_driving_score: 20,
      braking_efficiency_score: 30,
      trip_tire_wear_units: 12,
    })], vehicle, {});
    expect(harsh.oil_change.adjusted_interval_km).toBeLessThan(calm.oil_change.adjusted_interval_km);
  });

  it('sets due status when adjusted interval is exceeded', () => {
    const result = calculatePredictiveMaintenance([trip(0, {
      aggressive_driving_score: 20,
      braking_efficiency_score: 30,
      trip_tire_wear_units: 12,
    })], { ...vehicle, odometer_km: 18000 }, {});
    expect(result.oil_change.status).toBe('due');
  });

  it('keeps same-rate stress stable when trip count doubles', () => {
    const one = calculatePredictiveMaintenance([trip(0, { aggressive_driving_score: 60 })], vehicle, {});
    const two = calculatePredictiveMaintenance([trip(0, { aggressive_driving_score: 60 }), trip(1, { aggressive_driving_score: 60 })], vehicle, {});
    expect(Math.abs(one.stress_index - two.stress_index)).toBeLessThanOrEqual(0.05);
  });
});
