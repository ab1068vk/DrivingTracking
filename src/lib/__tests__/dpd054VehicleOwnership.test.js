import { describe, expect, it } from 'vitest';
import { ODOMETER_BASIS, planOdometerSync } from '@/lib/vehicleOdometer';

const at = '2026-10-03T20:00:00.000Z';
const vehicles = (defaultId = 'A') => [
  { id: 'A', is_default: defaultId === 'A', odometer_basis: ODOMETER_BASIS,
    odometer_credited_km_since_reading: 5, odometer_credited_trips: [{ id: 'old-native', km: 5 }],
    odometer_synced_through: at },
  { id: 'B', is_default: defaultId === 'B', odometer_basis: ODOMETER_BASIS,
    odometer_credited_km_since_reading: 0, odometer_credited_trips: [],
    odometer_synced_through: at },
];
const trip = (id, vehicleId = null, start = '2026-10-03T19:00:00.000Z') => ({
  id, vehicle_id: vehicleId, status: 'completed', distance_km: 5, start_time: start,
});

describe('DPD-054 durable odometer ownership', () => {
  it('does not move an already credited unassigned native trip when only the default changes', () => {
    const rows = [trip('old-native')];
    const plan = planOdometerSync(vehicles('B'), { windowRows: rows, rows, now: new Date(at) });
    expect(plan).toEqual([]);
  });

  it('does not credit a new unassigned completed trip to a mutable default', () => {
    const rows = [trip('unassigned', null, '2026-10-03T21:00:00.000Z')];
    const plan = planOdometerSync(vehicles('B'), { windowRows: rows, rows, now: new Date('2026-10-03T22:00:00.000Z') });
    expect(plan.find(({ id }) => id === 'B')?.patch.odometer_credited_trips || []).toEqual([]);
  });

  it('still transfers a credit after an explicit trip vehicle reassignment', () => {
    const rows = [trip('old-native', 'B')];
    const plan = planOdometerSync(vehicles('A'), { windowRows: rows, rows, now: new Date(at) });
    expect(plan.find(({ id }) => id === 'A')?.patch.odometer_credited_km_since_reading).toBe(0);
    expect(plan.find(({ id }) => id === 'B')?.patch.odometer_credited_km_since_reading).toBe(5);
  });

  it('preserves twenty historical native credits while a new explicit second-vehicle trip credits once', () => {
    const historical = Array.from({ length: 20 }, (_, n) => ({
      id: `native-${n}`, km: n === 19 ? 20.945 : 12,
    }));
    const fleet = vehicles('B');
    fleet[0].odometer_credited_trips = historical;
    fleet[0].odometer_credited_km_since_reading = 248.945;
    const rows = [
      trip('gd09', 'B', '2026-10-03T21:00:00.000Z'),
      ...historical.map(({ id, km }) => ({ ...trip(id), distance_km: km })),
    ];
    rows[0].distance_km = 4.195;
    const plan = planOdometerSync(fleet, { windowRows: rows, rows, now: new Date('2026-10-03T22:00:00.000Z') });
    // Its timestamp may advance with the sync turn, but its credit ledger stays.
    expect(plan.find(({ id }) => id === 'A')?.patch).toMatchObject({
      odometer_credited_km_since_reading: 248.945,
      odometer_credited_trips: historical,
    });
    expect(plan.find(({ id }) => id === 'B')?.patch).toMatchObject({
      odometer_credited_km_since_reading: 4.195,
      odometer_credited_trips: [{ id: 'gd09', km: 4.195 }],
    });
  });
});
