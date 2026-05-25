import { describe, expect, it } from 'vitest';
import {
  calculateAverageEngineStressScore,
  calculatePredictiveMaintenance,
  calculateTireWearUnits,
  MAINTENANCE_CALIBRATION_REGISTRY,
  WEAR_KM_PER_STRESS_UNIT,
} from '@/lib/tripInsights';

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
  it('exposes wear conversion calibration status for maintenance review', () => {
    expect(WEAR_KM_PER_STRESS_UNIT).toBe(8);
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit).toMatchObject({
      value: WEAR_KM_PER_STRESS_UNIT,
      unit: 'km_per_stress_unit',
      calibrationStatus: 'provisional',
    });
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit.calibrationBasis).toContain('Not calibrated');
  });

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

  it('preserves neutral tire wear units but exposes missing event-speed evidence', () => {
    const wear = calculateTireWearUnits([
      { type: 'harsh_brake', severity: 'medium' },
      { type: 'sharp_turn', severity: 'low', speed_kmh: 40 },
    ]);
    const result = calculatePredictiveMaintenance([trip(0, wear)], vehicle, {});

    expect(wear).toEqual({
      trip_tire_wear_units: 3.5,
      trip_tire_wear_has_missing_speed_data: true,
      trip_tire_wear_missing_speed_event_count: 1,
    });
    expect(result.has_missing_speed_data).toBe(true);
    expect(result.missing_speed_event_count).toBe(1);
  });

  it('detects missing tire-wear speed evidence from legacy stored events', () => {
    const result = calculatePredictiveMaintenance([trip(0, {
      driving_events: [{ type: 'harsh_brake', severity: 'low' }],
    })], vehicle, {});

    expect(result.has_missing_speed_data).toBe(true);
    expect(result.missing_speed_event_count).toBe(1);
  });

  it('keeps same-rate stress stable when trip count doubles', () => {
    const one = calculatePredictiveMaintenance([trip(0, { aggressive_driving_score: 60 })], vehicle, {});
    const two = calculatePredictiveMaintenance([trip(0, { aggressive_driving_score: 60 }), trip(1, { aggressive_driving_score: 60 })], vehicle, {});
    expect(Math.abs(one.stress_index - two.stress_index)).toBeLessThanOrEqual(0.05);
  });

  it('computes brake stress only from sufficiently established braking history', () => {
    const lowStress = calculatePredictiveMaintenance(Array.from({ length: 10 }, (_, index) => trip(index, {
      braking_efficiency_score: 90,
    })), vehicle, {});
    const mediumStress = calculatePredictiveMaintenance(Array.from({ length: 10 }, (_, index) => trip(index, {
      braking_efficiency_score: 50,
    })), vehicle, {});
    const belowGate = calculatePredictiveMaintenance(Array.from({ length: 3 }, (_, index) => trip(index, {
      braking_efficiency_score: 50,
    })), vehicle, {});
    const mixedEvidence = calculatePredictiveMaintenance([
      trip(0, { braking_efficiency_score: 50 }),
      trip(1, { braking_efficiency_score: null }),
      trip(2, { braking_efficiency_score: 70 }),
      trip(3, { braking_efficiency_score: null }),
      trip(4, { braking_efficiency_score: 90 }),
    ], vehicle, {});
    const sparseEvidence = calculatePredictiveMaintenance([
      trip(0, { braking_efficiency_score: 50 }),
      trip(1, { braking_efficiency_score: null }),
      trip(2, { braking_efficiency_score: null }),
      trip(3, { braking_efficiency_score: null }),
      trip(4, { braking_efficiency_score: 90 }),
    ], vehicle, {});

    expect(lowStress.brake_stress_index).toBeCloseTo(0.1);
    expect(mediumStress.brake_stress_index).toBeCloseTo(0.5);
    expect(belowGate.brake_stress_index).toBeNull();
    expect(mixedEvidence.brake_stress_index).toBeCloseTo(0.3);
    expect(sparseEvidence.brake_stress_index).toBeNull();
  });

  it('averages only trips with finite engine stress scores', () => {
    const result = calculateAverageEngineStressScore([
      trip(0, { engine_stress_score: 40 }),
      trip(1),
      trip(2, { engine_stress_score: 81 }),
      trip(3, { engine_stress_score: null }),
      trip(4, { engine_stress_score: Number.POSITIVE_INFINITY }),
      trip(5, { engine_stress_score: '100' }),
    ]);

    expect(result).toBe(60.5);
  });

  it('returns null when no trips have a finite engine stress score', () => {
    const result = calculateAverageEngineStressScore([
      trip(0),
      trip(1, { engine_stress_score: null }),
      trip(2, { engine_stress_score: Number.NaN }),
    ]);

    expect(result).toBeNull();
  });
});
