import { describe, expect, it } from 'vitest';
import {
  calculateAverageEngineStressScore,
  calculatePredictiveMaintenance,
  calculateTireWearUnits,
  MAINTENANCE_CALIBRATION_REGISTRY,
  WEAR_KM_PER_STRESS_UNIT,
} from '@/lib/tripInsights';

const sourcedItem = (item) => ({
  ...item,
  source_type: 'owner_entered_manufacturer',
  source_title: 'Exact owner manual',
  confirmed_by_user: true,
  enabled: true,
});

const vehicle = {
  powertrain: 'gasoline',
  odometer_km: 10000,
  maintenance_items: [
    sourcedItem({ id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 9000 }),
    sourcedItem({ id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 9000 }),
    sourcedItem({ id: 'inspection', label: 'Inspection', interval_km: 20000, last_service_km: 9000 }),
  ],
};

const trip = (overrides = {}) => ({
  status: 'completed',
  distance_km: 10,
  aggressive_driving_score: 90,
  braking_efficiency_score: 90,
  trip_tire_wear_units: 1,
  ...overrides,
});

describe('source-aware maintenance compatibility', () => {
  it('retires the uncalibrated event-to-wear conversion', () => {
    expect(WEAR_KM_PER_STRESS_UNIT).toBeNull();
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit).toMatchObject({
      value: null,
      calibrationStatus: 'retired',
    });
    expect(MAINTENANCE_CALIBRATION_REGISTRY.wearKmPerStressUnit.calibrationBasis)
      .toContain('No defensible conversion');
  });

  it('keeps driving-load evidence separate from service scheduling', () => {
    const result = calculatePredictiveMaintenance([], vehicle, {});
    expect(result).toMatchObject({
      diagnostic_only: true,
      schedule_adjustment_applied: false,
      stress_index: null,
    });
    expect(result.oil_change.adjusted_interval_km).toBe(8000);
  });

  it('never shortens a manufacturer interval because of driving events', () => {
    const calm = calculatePredictiveMaintenance([trip()], vehicle, {});
    const harsh = calculatePredictiveMaintenance([trip({
      aggressive_driving_score: 20,
      braking_efficiency_score: 30,
      trip_tire_wear_units: 12,
    })], vehicle, {});

    expect(harsh.oil_change.adjusted_interval_km).toBe(calm.oil_change.adjusted_interval_km);
    expect(harsh.oil_change.urgency_delta).toBe(0);
    expect(harsh.oil_change.schedule_adjustment_applied).toBe(false);
  });

  it('reports due only from a confirmed source-backed schedule', () => {
    const result = calculatePredictiveMaintenance(
      [trip()],
      { ...vehicle, odometer_km: 18000 },
      {}
    );

    expect(result.oil_change.status).toBe('due');
    expect(result.oil_change.source_type).toBe('owner_entered_manufacturer');
  });

  it('does not invent missing oil schedules for an EV', () => {
    const result = calculatePredictiveMaintenance([], {
      powertrain: 'electric',
      maintenance_items: [],
    }, {});

    expect(result.oil_change).toMatchObject({
      adjusted_interval_km: null,
      status: 'not_configured',
    });
  });

  it('preserves event evidence quality flags without converting them to tire life', () => {
    const wear = calculateTireWearUnits([
      { type: 'harsh_brake', severity: 'medium' },
      { type: 'sharp_turn', severity: 'low', speed_kmh: 40 },
    ]);
    const result = calculatePredictiveMaintenance([trip(wear)], vehicle, {});

    expect(wear.trip_tire_wear_missing_speed_event_count).toBe(1);
    expect(result.has_missing_speed_data).toBe(true);
    expect(result.missing_speed_event_count).toBe(1);
  });

  it('averages only finite legacy acceleration-load scores', () => {
    expect(calculateAverageEngineStressScore([
      trip({ engine_stress_score: 40 }),
      trip(),
      trip({ engine_stress_score: 81 }),
      trip({ engine_stress_score: null }),
      trip({ engine_stress_score: Number.POSITIVE_INFINITY }),
      trip({ engine_stress_score: '100' }),
    ])).toBe(60.5);
  });

  it('returns null when no finite legacy acceleration-load scores exist', () => {
    expect(calculateAverageEngineStressScore([
      trip(),
      trip({ engine_stress_score: null }),
      trip({ engine_stress_score: Number.NaN }),
    ])).toBeNull();
  });
});
