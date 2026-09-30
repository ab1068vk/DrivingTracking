import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { DB_NAME, localTripRepository } from '@/lib/localTripRepository';
import { localVehicleRepository } from '@/lib/localVehicleRepository';
import { stepP6BrowserTripDerivedUpdate } from '@/lib/p6TripDerivedState';

describe('DPD-047 completed-trip read convergence', () => {
  let db;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:00:00.000Z'));
    db = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', db);
    vi.stubGlobal('IDBKeyRange', db.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    const values = new Map([['drivesense_settings', JSON.stringify({
      settings_defaults_version: 11, data_retention_days: 0,
      raw_gps_retention_days: 0, privacy_zones: [],
    })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const trip = (id, extra = {}) => ({
    id, status: 'completed', start_source: 'native_auto', imported_from_native: true,
    start_time: '2026-09-29T15:00:00.000Z', end_time: '2026-09-29T15:01:00.000Z',
    distance_km: 1, route_points: Array.from({ length: 60 }, (_, index) => ({
      lat: 43.65 + index * 0.0001, lng: -79.38,
      speed_kmh: 40,
      timestamp: new Date(Date.parse('2026-09-29T15:00:00.000Z') + index * 1000).toISOString(),
    })), ...extra,
  });
  const row = (store, id) => db.getStoreState(DB_NAME, store).records.get(id);

  it('settles a native completed trip whose unavailable CO2 savings is explicitly null', async () => {
    await localTripRepository.create(trip('native-no-vehicle'));
    const first = await localTripRepository.getFullById('native-no-vehicle');
    expect(first.co2_saved_kg).toBeNull();
    expect(first.needs_rescore).toBe(false);
    const sourceRevision = row('trips', 'native-no-vehicle').source_revision;
    const workSequence = row('p6_trip_work', 'native-no-vehicle').desiredSeq;
    for (let turn = 0; turn < 3; turn += 1) {
      await localTripRepository.getFullById('native-no-vehicle');
      expect(row('trips', 'native-no-vehicle').source_revision).toBe(sourceRevision);
      expect(row('p6_trip_work', 'native-no-vehicle').desiredSeq).toBe(workSequence);
    }
    // The ~23 h observation gap in §46 was a pause, not a score-aging TTL.
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    await localTripRepository.getFullById('native-no-vehicle');
    expect(row('trips', 'native-no-vehicle').source_revision).toBe(sourceRevision);
    expect(row('p6_trip_work', 'native-no-vehicle').desiredSeq).toBe(workSequence);
  });

  it('keeps an imported trip with a vehicle and numeric CO2 savings stable', async () => {
    vi.spyOn(localVehicleRepository, 'getByIds').mockResolvedValue([{
      id: 'rsveh_primary', fuel_type: 'gasoline', fuel_efficiency_l_per_100km: 8,
    }]);
    await localTripRepository.create(trip('imported-with-vehicle', {
      start_source: 'auto', imported_from_native: false, vehicle_id: 'rsveh_primary',
      co2_saved_kg: 0,
    }));
    const first = await localTripRepository.getFullById('imported-with-vehicle');
    expect(typeof first.co2_saved_kg).toBe('number');
    const revision = row('trips', 'imported-with-vehicle').source_revision;
    await localTripRepository.getFullById('imported-with-vehicle');
    expect(row('trips', 'imported-with-vehicle').source_revision).toBe(revision);
  });

  it('lets repeated P6 coordinator turns reach a fixed point without re-dirtying the source', async () => {
    await localTripRepository.create(trip('native-p6'));
    await localTripRepository.getFullById('native-p6');
    const revision = row('trips', 'native-p6').source_revision;
    let complete = false;
    const states = [];
    for (let turn = 0; turn < 30; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      states.push([result.state, row('p6_trip_work', 'native-p6').state]);
      if (row('p6_trip_work', 'native-p6').state === 'COMPLETE') { complete = true; break; }
    }
    expect(complete, JSON.stringify(states)).toBe(true);
    expect(row('trips', 'native-p6').source_revision).toBe(revision);
    for (let turn = 0; turn < 3; turn += 1) {
      await stepP6BrowserTripDerivedUpdate({ explicit: true });
      expect(row('p6_trip_work', 'native-p6').state).toBe('COMPLETE');
      expect(row('trips', 'native-p6').source_revision).toBe(revision);
    }
  });

  it('persists a real requested rescore and keeps canonical edits invalidating derived state', async () => {
    await localTripRepository.create(trip('native-edit'));
    await localTripRepository.getFullById('native-edit');
    const settled = row('trips', 'native-edit').source_revision;
    await localTripRepository.update('native-edit', { needs_rescore: true });
    const requested = row('trips', 'native-edit').source_revision;
    expect(requested).not.toBe(settled);
    const rescored = await localTripRepository.getFullById('native-edit');
    expect(rescored.needs_rescore).toBe(false);
    const scored = row('trips', 'native-edit').source_revision;
    expect(scored).not.toBe(requested);
    expect(row('p6_trip_work', 'native-edit')).toMatchObject({
      desiredRevision: scored, state: 'DIRTY',
      dirtyDomains: ['D1_ANALYTICS', 'D2_GEOMETRY', 'D3_SPATIAL_SELECTION', 'D4_ROAD_LEARNING_SPEED_LOOKUP'],
    });
    await localTripRepository.update('native-edit', { nickname: 'edited by driver' });
    expect(row('trips', 'native-edit').source_revision).not.toBe(scored);
    expect(row('p6_trip_work', 'native-edit').state).toBe('DIRTY');
  });
});
