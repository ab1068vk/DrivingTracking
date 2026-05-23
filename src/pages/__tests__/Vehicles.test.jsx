import { describe, expect, it } from 'vitest';
import { validateVehicleForm } from '@/pages/Vehicles';

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
});
