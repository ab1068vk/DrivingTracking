import { describe, expect, it } from 'vitest';
import { calculateAverageVehicleScore, getVehicleFormWarnings, validateVehicleForm } from '@/pages/Vehicles';

const validVehicleForm = {
  name: 'Commuter',
  year: '2024',
  odometer_km: 1000,
  fuel_type: 'gasoline',
  fuel_efficiency_l_per_100km: 8.5,
  ev_efficiency_kwh_per_100km: 18,
  fuel_price_per_liter: 1.65,
  maintenance_reserve_per_km: 0.08,
};

describe('vehicle form validation', () => {
  it('allows higher international-market fuel prices up to 20 per litre', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_price_per_liter: 15 })).toEqual([]);
  });

  it('rejects fuel prices above the raised cap', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_price_per_liter: 20.01 })).toContain('Fuel price must be between 0 and 20.');
  });

  it('rejects physically implausible ICE efficiency below 3 L/100km', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_efficiency_l_per_100km: 0.5 }))
      .toContain('Fuel efficiency must be between 3 and 40 L/100km.');
    expect(validateVehicleForm({ ...validVehicleForm, fuel_efficiency_l_per_100km: 3 })).toEqual([]);
  });

  it('warns without blocking unusual ICE efficiency values', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_efficiency_l_per_100km: 28 })).toEqual([]);
    expect(getVehicleFormWarnings({ ...validVehicleForm, fuel_efficiency_l_per_100km: 28 }))
      .toContain('Fuel efficiency above 25 L/100km is unusual. Confirm this value before saving.');
  });
});

describe('vehicle score summaries', () => {
  it('returns null for a vehicle with no completed trips', () => {
    expect(calculateAverageVehicleScore([])).toBeNull();
  });
});
