import { describe, expect, it } from 'vitest';
import { buildVehicleAssignmentSuggestions, suggestVehicleForTrip } from '@/lib/vehicleSuggestions';

const vehicles = [
  { id: 'commuter', name: 'Commuter', is_default: true },
  { id: 'weekender', name: 'Weekender', is_default: false },
];

describe('vehicle assignment suggestions', () => {
  it('prioritizes exact route history over the default vehicle fallback', () => {
    const trips = [
      {
        id: 'known-route',
        status: 'completed',
        vehicle_id: 'weekender',
        route_key: 'home|lake',
        distance_km: 120,
        start_time: '2026-06-20T14:00:00.000Z',
      },
      {
        id: 'default-trip',
        status: 'completed',
        vehicle_id: 'commuter',
        route_key: 'home|office',
        distance_km: 18,
        start_time: '2026-06-19T12:00:00.000Z',
      },
    ];
    const target = {
      id: 'target',
      status: 'completed',
      route_key: 'home|lake',
      distance_km: 118,
      start_time: '2026-06-27T14:30:00.000Z',
    };

    const suggestion = suggestVehicleForTrip(target, vehicles, trips);

    expect(suggestion.vehicle.id).toBe('weekender');
    expect(suggestion.confidence).toBeGreaterThanOrEqual(50);
    expect(suggestion.reasons.map((reason) => reason.label)).toContain('Route match');
  });

  it('uses the default vehicle as a low-information fallback', () => {
    const suggestion = suggestVehicleForTrip(
      { id: 'target', status: 'completed', distance_km: 9, start_time: '2026-06-27T08:00:00.000Z' },
      vehicles,
      []
    );

    expect(suggestion.vehicle.id).toBe('commuter');
    expect(suggestion.confidenceLabel).toBe('low');
    expect(suggestion.reasons.map((reason) => reason.label)).toContain('Default vehicle');
  });

  it('builds a lookup map for assignment-center rows', () => {
    const unassigned = [
      { id: 'a', status: 'completed', route_key: 'x|y', distance_km: 11, start_time: '2026-06-27T08:00:00.000Z' },
      { id: 'b', status: 'completed', route_key: 'm|n', distance_km: 30, start_time: '2026-06-27T20:00:00.000Z' },
    ];

    const lookup = buildVehicleAssignmentSuggestions(unassigned, vehicles, []);

    expect(lookup.get('a').vehicle.id).toBe('commuter');
    expect(lookup.get('b').vehicle.id).toBe('commuter');
  });
});
