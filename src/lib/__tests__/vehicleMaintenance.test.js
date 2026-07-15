// @ts-check
import { describe, expect, it } from 'vitest';
import {
  buildDrivingLoadAdvisory,
  buildVehicleMaintenancePlan,
  getVehicleConfigurationConfidence,
  normalizeMaintenanceItems,
  recordVehicleService,
} from '@/lib/vehicleMaintenance';

const verifiedItem = (overrides = {}) => ({
  id: 'service_item',
  label: 'Verified service item',
  interval_km: 10000,
  interval_months: 12,
  last_service_km: 0,
  last_service_date: '2025-01-01',
  source_type: 'owner_entered_manufacturer',
  source_title: 'Exact owner manual',
  confirmed_by_user: true,
  enabled: true,
  ...overrides,
});

describe('vehicle maintenance engine', () => {
  it('retires migrated generic defaults instead of presenting them as due', () => {
    const plan = buildVehicleMaintenancePlan({
      powertrain: 'gasoline',
      maintenance_items: [
        { id: 'oil', label: 'Oil change', interval_km: 8000, last_service_km: 0 },
        { id: 'tires', label: 'Tire rotation', interval_km: 10000, last_service_km: 0 },
      ],
    }, { odometerKm: 50000 });

    expect(plan.configured).toBe(false);
    expect(plan.items.every((item) => item.status === 'needs_source')).toBe(true);
    expect(plan.items.every((item) => item.enabled === false)).toBe(true);
  });

  it('does not invent oil service for a battery-electric vehicle', () => {
    const plan = buildVehicleMaintenancePlan({
      year: 2026,
      make: 'Tesla',
      model: 'Model 3',
      market: 'CA',
      powertrain: 'electric',
    }, { odometerKm: 12000 });

    expect(plan.items.some((item) => /oil/i.test(item.label))).toBe(false);
    expect(plan.items.every((item) => item.status === 'needs_confirmation')).toBe(true);
    expect(plan.configured).toBe(false);
  });

  it('uses whichever verified limit becomes due first', () => {
    const vehicle = {
      powertrain: 'gasoline',
      maintenance_items: [verifiedItem()],
    };
    const timeDue = buildVehicleMaintenancePlan(vehicle, {
      odometerKm: 5000,
      now: new Date('2026-02-01T12:00:00Z'),
    });
    const distanceDue = buildVehicleMaintenancePlan(vehicle, {
      odometerKm: 11000,
      now: new Date('2025-02-01T12:00:00Z'),
    });

    expect(timeDue.items[0]).toMatchObject({ status: 'due', remaining_km: 5000 });
    expect(distanceDue.items[0]).toMatchObject({ status: 'due', remaining_km: -1000 });
  });

  it('requires a baseline before calendar reminders can claim current status', () => {
    const plan = buildVehicleMaintenancePlan({
      powertrain: 'gasoline',
      maintenance_items: [verifiedItem({
        interval_km: 0,
        interval_months: 12,
        last_service_date: '',
      })],
    });

    expect(plan.configured).toBe(false);
    expect(plan.items[0].status).toBe('needs_baseline');
  });

  it('records service history and resets both distance and calendar baselines', () => {
    const vehicle = {
      powertrain: 'gasoline',
      maintenance_items: [verifiedItem()],
      service_history: [],
    };
    const patch = recordVehicleService(vehicle, 'service_item', {
      odometerKm: 12345,
      servicedAt: new Date('2026-07-14T12:00:00Z'),
      notes: 'Dealer service',
    });

    expect(patch.maintenance_items[0]).toMatchObject({
      last_service_km: 12345,
      last_service_date: '2026-07-14',
    });
    expect(patch.service_history[0]).toMatchObject({
      label: 'Verified service item',
      serviced_at: '2026-07-14',
      odometer_km: 12345,
      notes: 'Dealer service',
    });
  });

  it('keeps driving-load evidence diagnostic-only', () => {
    const advisory = buildDrivingLoadAdvisory([{
      status: 'completed',
      distance_km: 20,
      aggressive_driving_score: 40,
      harsh_brakes_count: 2,
      rapid_accel_count: 1,
    }]);

    expect(advisory.source_label).toContain('GPS');
    expect(advisory.disclaimer).toContain('never changes a manufacturer due date');
    expect(advisory).not.toHaveProperty('adjusted_interval_km');
    expect(advisory).not.toHaveProperty('remaining_life_km');
  });

  it('reports profile gaps that can change exact manufacturer applicability', () => {
    const confidence = getVehicleConfigurationConfidence({
      make: 'Toyota',
      model: 'RAV4',
      year: 2025,
      powertrain: 'hybrid',
    });

    expect(confidence.missing).toEqual(expect.arrayContaining(['market', 'trim', 'engine', 'drivetrain']));
    expect(confidence.level).not.toBe('exact-profile');
    expect(normalizeMaintenanceItems({ powertrain: 'electric' })).toEqual([]);
  });
});
