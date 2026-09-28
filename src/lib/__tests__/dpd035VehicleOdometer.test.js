import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ values: new Map() }));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => (store.values.has(key) ? structuredClone(store.values.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { store.values.set(key, structuredClone(value)); }),
}));

import { localVehicleRepository } from '@/lib/localVehicleRepository';
import { buildMaintenanceReminders } from '@/lib/mediumInsights';
import { CARBON_ANALYTICS_VEHICLE_FIELDS, getVehicleOdometerKm as tripInsightsOdometer } from '@/lib/tripInsights';
import {
  ODOMETER_BASIS,
  applyOdometerReading,
  creditedElsewhereFor,
  getVehicleOdometerKm,
  legacyOdometerKm,
} from '@/lib/vehicleOdometer';
import { syncVehicleOdometers } from '@/lib/vehicleOdometerSync';

/**
 * DPD-035 — the auto-odometer must add every new drive exactly once, however
 * long the history is.
 *
 * It used to be topped up from the Vehicles page's latest-100-trip window
 * (`window sum − previous window sum`), so beyond 100 trips each new drive only
 * added (new trip − trip leaving the window). On a 5,000-trip model, 300 km of
 * driving moved the odometer 33 km.
 *
 * The page is simulated faithfully: Q1 returns the newest 100 completed trips by
 * start time plus a continuation, and every write goes through the real vehicle
 * repository, so the normaliser that persists the new fields is exercised too.
 */

const WINDOW = 100;
const HOUR = 3600e3;
const T0 = Date.UTC(2025, 0, 1);

let trips = [];
let clock = 0;
const trip = (vehicleId, km, { startMs = null, status = 'completed' } = {}) => {
  clock += 1;
  const start = startMs ?? (T0 + clock * HOUR);
  return { id: `t${clock}`, vehicle_id: vehicleId, distance_km: km, status, start_time: new Date(start).toISOString() };
};
const newestFirst = () => [...trips]
  .filter((t) => t.status === 'completed')
  .sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time));
const q1 = (offset) => {
  const rows = newestFirst();
  const page = rows.slice(offset, offset + WINDOW);
  return { rows: page, continuation: offset + WINDOW < rows.length ? String(offset + WINDOW) : null };
};
const window100 = () => q1(0).rows;

/** One Vehicles-page visit: sync from the first page, then return the displayed odometers. */
const visit = async ({ now = new Date(T0 + (clock + 1) * HOUR) } = {}) => {
  const vehicles = await localVehicleRepository.list();
  const first = q1(0);
  const result = await syncVehicleOdometers({
    vehicles,
    windowRows: first.rows,
    continuation: first.continuation,
    fetchPage: async (cursor) => q1(Number(cursor)),
    writeVehicle: (id, patch) => localVehicleRepository.update(id, patch),
    now,
  });
  const after = await localVehicleRepository.list();
  const shown = Object.fromEntries(after.map((v) => [v.id, getVehicleOdometerKm(v, window100(), {
    creditedElsewhere: creditedElsewhereFor(v, after),
  })]));
  return { shown, result, vehicles: after };
};

const legacyVehicle = (id, odometerKm, extra = {}) => ({
  id, name: id, odometer_km: odometerKm, odometer_trip_distance_anchor_km: 0, fuel_efficiency_l_per_100km: 8.5, ...extra,
});

/** History of `count` trips for the given vehicles (round-robin), then a legacy sync as #8 did it. */
const seedLegacy = async (vehicles, count, km = 10) => {
  for (let i = 0; i < count; i += 1) trips.push(trip(vehicles[i % vehicles.length].id, typeof km === 'function' ? km(i) : km));
  // The pre-DPD-035 sync: anchor = window sum, odometer frozen at base + (window − 0).
  const seeded = vehicles.map((v) => {
    const windowKm = window100().filter((t) => t.vehicle_id === v.id).reduce((s, t) => s + t.distance_km, 0);
    return { ...v, odometer_km: Math.round(v.odometer_km + windowKm), odometer_trip_distance_anchor_km: windowKm };
  });
  await localVehicleRepository.upsertMany(seeded);
};

const drive = (vehicleId, km, n = 1) => { for (let i = 0; i < n; i += 1) trips.push(trip(vehicleId, km)); };

beforeEach(() => {
  store.values.clear();
  trips = [];
  clock = 0;
});

describe('DPD-035: new driving is added in full at any history length', () => {
  const progression = async (historyCount, drives) => {
    await seedLegacy([legacyVehicle('A', 50_000)], historyCount);
    const before = (await visit()).shown.A; // migration visit
    drives.forEach(([km, n]) => drive('A', km, n));
    const after = (await visit()).shown.A;
    return after - before;
  };

  it('A — under 100 trips (control)', async () => { expect(await progression(20, [[20, 5]])).toBe(100); });
  it('B — exactly 100 trips', async () => { expect(await progression(100, [[20, 5]])).toBe(100); });
  it('C — more than 100 trips: the full new distance, not the window\'s net change', async () => {
    expect(await progression(150, [[20, 5]])).toBe(100);
    trips = []; clock = 0; store.values.clear();
    expect(await progression(150, [[8, 5]])).toBe(40);
  });
  it('D — 5,000-trip history, 20 drives of 15 km → +300 km (was +33)', async () => {
    await seedLegacy([legacyVehicle('A', 50_000)], 5000, (i) => 3 + ((i * 37) % 38));
    const before = (await visit()).shown.A;
    drive('A', 15, 20);
    expect((await visit()).shown.A - before).toBe(300);
  });
  it('a sync after each drive gives the same total as one sync after all of them', async () => {
    await seedLegacy([legacyVehicle('A', 50_000)], 300);
    const before = (await visit()).shown.A;
    for (let i = 0; i < 12; i += 1) { drive('A', 7); await visit(); }
    expect((await visit()).shown.A - before).toBe(84);
  });
});

describe('DPD-035: vehicles are independent', () => {
  it('E — each vehicle advances only by its own new driving', async () => {
    await seedLegacy([legacyVehicle('A', 10_000), legacyVehicle('B', 20_000)], 150);
    const base = (await visit()).shown;
    drive('A', 12, 10);
    let shown = (await visit()).shown;
    expect(shown.A - base.A).toBe(120);
    expect(shown.B - base.B).toBe(0);
    drive('B', 12, 10);
    shown = (await visit()).shown;
    expect(shown.A - base.A).toBe(120);
    expect(shown.B - base.B).toBe(120);
  });
});

describe('DPD-035: migration never moves a displayed odometer', () => {
  it.each([2, 99, 100, 101, 1000])('F — %i-trip vehicle: displayed before upgrade = displayed after', async (count) => {
    await seedLegacy([legacyVehicle('A', 41_018), legacyVehicle('B', 98_000)], count * 2);
    const legacy = await localVehicleRepository.list();
    const beforeShown = Object.fromEntries(legacy.map((v) => [v.id, legacyOdometerKm(v, window100())]));
    const { shown, vehicles } = await visit();
    expect(shown).toEqual(beforeShown);
    vehicles.forEach((v) => expect(v.odometer_basis).toBe(ODOMETER_BASIS));
  });

  it('F — a legacy vehicle with un-synced window driving keeps exactly what #8 showed', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 40);
    drive('A', 25, 2); // shown by the legacy formula but never written by #8
    const [legacy] = await localVehicleRepository.list();
    const expected = legacyOdometerKm(legacy, window100());
    expect((await visit()).shown.A).toBe(expected);
  });

  it('G — after migration one new trip advances exactly once', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 120);
    const before = (await visit()).shown.A;
    drive('A', 33);
    expect((await visit()).shown.A).toBe(before + 33);
    expect((await visit()).shown.A).toBe(before + 33);
  });
});

describe('DPD-035: idempotence and relaunch', () => {
  it('H/I — repeated syncs and a "relaunch" (fresh snapshot, same rows) write nothing and never drift', async () => {
    await seedLegacy([legacyVehicle('A', 1000), legacyVehicle('B', 2000)], 250);
    await visit();
    drive('A', 10, 3);
    const first = await visit();
    for (let i = 0; i < 5; i += 1) {
      const again = await visit();
      expect(again.shown).toEqual(first.shown);
      expect(again.result.written).toBe(0);
    }
  });

  it('the displayed value between syncs already includes pending driving, and the sync does not add it twice', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 150);
    const before = (await visit()).shown.A;
    drive('A', 40);
    const [v] = await localVehicleRepository.list();
    expect(getVehicleOdometerKm(v, window100())).toBe(before + 40); // pre-sync display
    expect((await visit()).shown.A).toBe(before + 40);
  });
});

describe('DPD-035: history that is not new driving never moves the odometer', () => {
  it('J — importing 1,000 older trips after migration changes nothing', async () => {
    await seedLegacy([legacyVehicle('A', 60_000)], 200);
    const before = (await visit()).shown.A;
    for (let i = 0; i < 1000; i += 1) trips.push(trip('A', 20, { startMs: T0 - (i + 1) * HOUR }));
    expect((await visit()).shown.A).toBe(before);
  });

  it('J — a restored vehicle record keeps its progress fields through the normaliser', async () => {
    await seedLegacy([legacyVehicle('A', 60_000)], 200);
    await visit();
    drive('A', 12, 2);
    await visit();
    const [saved] = await localVehicleRepository.list();
    store.values.clear();
    await localVehicleRepository.upsertMany([saved]);
    const [restored] = await localVehicleRepository.list();
    expect(restored).toMatchObject({
      odometer_basis: ODOMETER_BASIS,
      odometer_km: saved.odometer_km,
      odometer_credited_km_since_reading: saved.odometer_credited_km_since_reading,
      odometer_synced_through: saved.odometer_synced_through,
    });
    expect(restored.odometer_credited_trips).toEqual(saved.odometer_credited_trips);
    expect(getVehicleOdometerKm(restored, window100())).toBe(getVehicleOdometerKm(saved, window100()));
  });

  it('deleting a credited trip does not roll the odometer back', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 150);
    await visit();
    drive('A', 50);
    const credited = (await visit()).shown.A;
    trips = trips.filter((t) => t.id !== trips.at(-1).id);
    expect((await visit()).shown.A).toBe(credited);
  });

  it('a reassigned trip moves its credit instead of counting twice', async () => {
    await seedLegacy([legacyVehicle('A', 1000), legacyVehicle('B', 5000)], 150);
    const base = (await visit()).shown;
    drive('A', 30);
    await visit();
    trips.at(-1).vehicle_id = 'B';
    const shown = (await visit()).shown;
    expect(shown.A).toBe(base.A);
    expect(shown.B).toBe(base.B + 30);
    expect(shown.A + shown.B).toBe(base.A + base.B + 30);
  });

  it('more than one page of new trips since the last visit is still credited in full (bounded paging)', async () => {
    await seedLegacy([legacyVehicle('A', 1000), legacyVehicle('B', 1000)], 400);
    const base = (await visit()).shown;
    drive('A', 5, 180);
    drive('B', 4, 70);
    const { shown, result } = await visit();
    expect(shown.A - base.A).toBe(900);
    expect(shown.B - base.B).toBe(280);
    expect(result.pagesRead).toBeGreaterThan(0);
    expect(result.pagesRead).toBeLessThanOrEqual(3);
    expect(result.capped).toBe(false);
  });
});

describe('DPD-035: edits', () => {
  it('K — a rename leaves every odometer field untouched', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 150);
    await visit();
    drive('A', 10);
    const before = (await visit()).shown.A;
    const [v] = await localVehicleRepository.list();
    const form = { ...v, odometer_km: before, name: 'Renamed' };
    await localVehicleRepository.update('A', applyOdometerReading(form, before));
    const [after] = await localVehicleRepository.list();
    expect(after.name).toBe('Renamed');
    expect(getVehicleOdometerKm(after, window100())).toBe(before);
    expect(after.odometer_synced_through).toBe(v.odometer_synced_through);
  });

  it('K — a typed odometer is a new reading that already includes past driving', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 150);
    await visit();
    const [v] = await localVehicleRepository.list();
    // The owner types the reading before the next drive starts (a trip that
    // started at or before the reading is already in it).
    const now = new Date(T0 + (clock + 0.5) * HOUR);
    await localVehicleRepository.update('A', applyOdometerReading({ ...v, odometer_km: 70_000 }, 1500, now));
    expect((await visit({ now })).shown.A).toBe(70_000);
    drive('A', 15);
    expect((await visit()).shown.A).toBe(70_015);
  });

  it('L — a fuel-efficiency edit does not touch the odometer, and no odometer field feeds D1', async () => {
    await seedLegacy([legacyVehicle('A', 1000)], 150);
    await visit();
    const before = (await visit()).shown.A;
    const [v] = await localVehicleRepository.list();
    await localVehicleRepository.update('A', applyOdometerReading({ ...v, odometer_km: before, fuel_efficiency_l_per_100km: 9 }, before));
    expect((await visit()).shown.A).toBe(before);
    ['odometer_km', 'odometer_basis', 'odometer_credited_km_since_reading', 'odometer_synced_through',
      'odometer_credited_trips', 'odometer_trip_distance_anchor_km', 'auto_odometer_last_sync_at']
      .forEach((field) => expect(CARBON_ANALYTICS_VEHICLE_FIELDS).not.toContain(field));
  });

  it('a new vehicle starts from its typed reading and credits only later driving', async () => {
    const now = new Date(T0 + HOUR);
    await localVehicleRepository.create(applyOdometerReading({ id: 'N', name: 'New', odometer_km: 12_345 }, null, now));
    trips.push(trip('N', 20, { startMs: T0 - HOUR })); // before the reading
    drive('N', 30);
    expect((await visit()).shown.N).toBe(12_375);
  });
});

describe('DPD-035: maintenance reads the same odometer', () => {
  it('M — reminders and the display agree, and new driving makes an interval due', async () => {
    const maintenance = {
      maintenance_items: [{ id: 'oil', label: 'Oil change', interval_km: 1000, last_service_km: 50_400,
        source_type: 'owner_entered_manufacturer', source_title: 'Owner manual', confirmed_by_user: true }],
    };
    await seedLegacy([legacyVehicle('A', 50_000, maintenance)], 300);
    await visit();
    drive('A', 150, 5);
    const { shown, vehicles } = await visit();
    const [v] = vehicles;
    const oil = buildMaintenanceReminders(v, window100()).find((item) => item.id === 'oil');
    expect(shown.A).toBe(getVehicleOdometerKm(v, window100()));
    expect(tripInsightsOdometer(v, window100())).toBe(shown.A);
    expect(oil.remaining_km).toBe(50_400 + 1000 - shown.A);
    expect(oil.status).toBe('due');
  });
});
