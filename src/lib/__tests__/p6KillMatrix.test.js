import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, readP6AchievementStats, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = 288 } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: 12, score_overall: 91, duration_seconds: 900,
  route_points: route(seed, points),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V10 browser half: kill each durable stage write in turn and prove the same
 * three laws every time - no visible partial publication, convergence on retry,
 * and no row left behind bound to a revision that is not the current one.
 */
describe('P6-V10 browser stage-write kill matrix', () => {
  let indexedDb;

  beforeEach(() => {
    // The payload key stays durable for the whole file, as it is on a device:
    // clearing it between tests would encrypt with a key the next read cannot find.
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);

  const drain = async (limit = 900) => {
    for (let turn = 0; turn < limit; turn += 1) {
      let result;
      try {
        result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      } catch (error) {
        // A killed write surfaces as a thrown turn. The coordinator retries.
        return { killed: String(error?.message || error) };
      }
      if (result.state === 'IDLE' && result.hasMore === false) return { killed: null };
    }
    return { killed: 'TURN_LIMIT' };
  };

  const assertConsistent = async (tripId) => {
    const revision = String(store(P6_TRIP_SOURCE_STORE).records.get(tripId).source_revision);
    const chunks = rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, tripId);
    const versions = new Set(chunks.map((row) => row.contentVersion));
    expect(versions.size).toBe(1);
    expect([...versions][0]).toContain(revision);
    // No orphan bound to a superseded revision, in any derived store.
    for (const name of [P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
      P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS]) {
      for (const row of rowsFor(name, tripId)) expect(String(row.sourceRevision)).toBe(revision);
    }
    // Every published chunk is committed, and the preview exists exactly once.
    expect(chunks.filter((row) => row.ordinal === -1)).toHaveLength(1);
    // The work marker is finished and the durable cursor released.
    expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get(tripId)).toMatchObject({
      state: 'COMPLETE', cursor: null,
    });
  };

  const KILL_POINTS = [
    { store: P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, operation: 'put', label: 'geometry chunk write' },
    { store: P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, operation: 'put', label: 'spatial posting write' },
    { store: P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, operation: 'put', label: 'shared road spill write' },
    { store: P6_TRIP_DERIVED_STORES.WORK, operation: 'put', label: 'durable cursor write' },
    { store: P6_TRIP_DERIVED_STORES.MANIFESTS, operation: 'put', label: 'head swap' },
    { store: P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, operation: 'put', label: 'analytics contribution write' },
    { store: P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, operation: 'put', label: 'analytics bucket write' },
    { store: P6_TRIP_DERIVED_STORES.RECENT_ORDER, operation: 'put', label: 'recent order write' },
    { store: P6_TRIP_DERIVED_STORES.CONTROL, operation: 'put', label: 'preview accumulator write' },
  ];

  for (const point of KILL_POINTS) {
    for (const skip of [0, 2]) {
      it(`survives a kill at the ${point.label}${skip ? ` after ${skip} writes` : ''}`, async () => {
        await localTripRepository.create(trip('killed', { points: 288 }));

        indexedDb.failNextRequest({
          storeName: point.store,
          operation: point.operation,
          error: new Error(`kill:${point.store}`),
          skip,
        });
        await drain(40);

        // Whatever the kill did, retrying converges and publishes exactly one
        // current version with nothing left over.
        expect(await drain()).toMatchObject({ killed: null });
        expect(await finalizeP6BrowserExplicitTripBuild(false)).toMatchObject({
          state: P6_READINESS_STATES.VERIFIED, complete: true,
        });
        await assertConsistent('killed');

        const stats = await readP6AchievementStats({ now: Date.parse('2026-09-05T00:00:00Z') });
        expect(stats.completedCount).toBe(1);
        expect(stats.totalKm).toBeCloseTo(12, 9);
      }, 120_000);
    }
  }

  it('keeps a second subject correct when the first is killed mid-publication', async () => {
    await localTripRepository.create(trip('killed-first', { seed: 0, points: 288 }));
    await localTripRepository.create(trip('healthy-second', { seed: 3, points: 160 }));

    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      operation: 'put',
      error: new Error('kill:first-subject'),
      skip: 1,
    });
    await drain(30);
    expect(await drain()).toMatchObject({ killed: null });
    expect(await finalizeP6BrowserExplicitTripBuild(false)).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });

    await assertConsistent('killed-first');
    await assertConsistent('healthy-second');
    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-05T00:00:00Z') });
    expect(stats.completedCount).toBe(2);
    expect(stats.totalKm).toBeCloseTo(24, 9);
  }, 120_000);
});
