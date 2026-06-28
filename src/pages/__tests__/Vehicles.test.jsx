import { describe, expect, it } from 'vitest';
import {
  buildFleetIntelligence,
  calculateAverageVehicleScore,
  getTripsForVehicle,
  getTripsNeedingVehicleReview,
  getUnassignedCompletedTrips,
  getVehicleFormWarnings,
  MAX_FUEL_PRICE_PER_UNIT,
  validateVehicleForm,
} from '@/pages/Vehicles';

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
  it('allows higher international-market fuel prices up to the currency-neutral cap', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_price_per_liter: 75 })).toEqual([]);
  });

  it('rejects fuel prices above the raised cap', () => {
    expect(validateVehicleForm({ ...validVehicleForm, fuel_price_per_liter: MAX_FUEL_PRICE_PER_UNIT + 0.01 }))
      .toContain(`Fuel price must be between 0 and ${MAX_FUEL_PRICE_PER_UNIT}.`);
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

  it('attributes unassigned completed trips to the default vehicle for vehicle insights', () => {
    const defaultVehicle = { id: 'default-car', is_default: true };
    const otherVehicle = { id: 'other-car', is_default: false };
    const trips = [
      { id: 'assigned', status: 'completed', vehicle_id: 'other-car', distance_km: 10 },
      { id: 'unassigned', status: 'completed', vehicle_id: null, distance_km: 8 },
      { id: 'draft', status: 'active', vehicle_id: null, distance_km: 4 },
    ];

    expect(getTripsForVehicle(defaultVehicle, trips).map((trip) => trip.id)).toEqual(['unassigned']);
    expect(getTripsForVehicle(otherVehicle, trips).map((trip) => trip.id)).toEqual(['assigned']);
    expect(getUnassignedCompletedTrips(trips).map((trip) => trip.id)).toEqual(['unassigned']);
  });

  it('flags default vehicle guesses for confirmation without treating them as unassigned', () => {
    const trips = [
      { id: 'guessed', status: 'completed', vehicle_id: 'car-1', vehicle_assignment_status: 'needs_confirmation' },
      { id: 'confirmed', status: 'completed', vehicle_id: 'car-1', vehicle_assignment_status: 'confirmed' },
      { id: 'missing', status: 'completed', vehicle_id: null },
    ];

    expect(getUnassignedCompletedTrips(trips).map((trip) => trip.id)).toEqual(['missing']);
    expect(getTripsNeedingVehicleReview(trips).map((trip) => trip.id)).toEqual(['guessed', 'missing']);
  });

  it('summarizes assignment, service, and distance signals for the fleet dashboard', () => {
    const vehicles = [{ id: 'car-1', name: 'Commuter', is_default: true, odometer_km: 0 }];
    const trips = [
      { id: 'trip-1', status: 'completed', vehicle_id: null, distance_km: 42, start_time: new Date().toISOString() },
      { id: 'trip-2', status: 'completed', vehicle_id: 'car-1', distance_km: 8, start_time: new Date().toISOString() },
    ];

    const summary = buildFleetIntelligence(vehicles, trips, {});

    expect(summary.vehicleCount).toBe(1);
    expect(summary.completedTripCount).toBe(2);
    expect(summary.unassignedTripCount).toBe(1);
    expect(summary.assignmentReviewCount).toBe(1);
    expect(summary.totalKm).toBe(50);
    expect(summary.busiestVehicle.vehicle.name).toBe('Commuter');
  });
});
