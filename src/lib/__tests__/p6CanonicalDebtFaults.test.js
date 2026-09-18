import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
// Durable storage across the simulated process death: the payload key lives
// here, so discarding module state must not discard it too.
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
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

// A fully scored completed trip: the repository re-scores and re-persists a
// trip whose scored fields are still absent, so a fixture that left them null
// would be rewritten by its own reader on every turn.
const trip = (id, index = 0) => ({
  id,
  status: 'completed',
  start_time: new Date(1_756_000_000_000 + index * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + index * 86_400_000 + 900_000).toISOString(),
  distance_km: 7 + index,
  score_overall: 88,
  duration_seconds: 900,
  route_points: [
    { lat: 43.6 + index * 0.001, lng: -79.4, timestamp: 1_756_000_000_000 + index * 1000, speed_kmh: 44 },
    { lat: 43.6 + index * 0.001 + 0.0004, lng: -79.4004, timestamp: 1_756_000_000_001, speed_kmh: 46 },
  ],
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V03: the canonical owner is the only producer of derived debt, and the
 * debt is bound to the revision that was actually committed. Nothing here calls
 * a notifier: the tests assert that the durable record alone is enough.
 */
describe('P6-V03 canonical owner debt under fault', () => {
  let indexedDb;

  beforeEach(() => {
    // The payload key stays durable for the whole file, as it is on a device:
    // clearing it between tests would encrypt with a key the next read cannot find.
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_name, _options, operation) => operation() },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const work = () => indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.WORK);
  const source = () => indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE);

  it('refuses to commit a canonical trip whose derived debt marker fails', async () => {
    // Materialize the production schema before arming the failure, so the
    // failure lands on the debt write rather than on an upgrade.
    await localTripRepository.create(trip('debt-ok', 0));
    expect(work().records.get('debt-ok')).toBeDefined();

    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.WORK,
      operation: 'put',
      error: new Error('p6 debt marker unavailable'),
    });
    await expect(localTripRepository.create(trip('debt-fails', 1))).rejects.toBeTruthy();

    // The canonical row and its debt share one transaction, so a failed marker
    // cannot leave a committed trip that no domain will ever rebuild.
    expect(source().records.has('debt-fails')).toBe(false);
    expect(work().records.has('debt-fails')).toBe(false);
    expect(source().records.has('debt-ok')).toBe(true);
  });

  it('binds each debt marker to the revision and hash actually committed', async () => {
    const created = await localTripRepository.create(trip('bound', 0));
    const first = { ...work().records.get('bound') };
    expect(first.desiredRevision).toBe(String(source().records.get('bound').source_revision));
    expect(first.disposition).toBe('UPSERT');
    expect(first.state).toBe('DIRTY');
    expect(first.dirtyDomains).toEqual(expect.arrayContaining(Object.values(P6_DOMAIN_KEYS)));

    await localTripRepository.update(created.id, { distance_km: 19 });
    const second = work().records.get('bound');
    expect(second.desiredRevision).toBe(String(source().records.get('bound').source_revision));
    expect(second.desiredRevision).not.toBe(first.desiredRevision);
    expect(second.sourceHash).not.toBe(first.sourceHash);
    expect(second.desiredSeq).toBeGreaterThanOrEqual(first.desiredSeq);
    // Exactly one debt row per subject: a second revision replaces the first
    // rather than queueing a second unit of work for the same trip.
    expect([...work().records.keys()].filter((key) => key === 'bound')).toHaveLength(1);

    const manifests = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.MANIFESTS);
    for (const domain of Object.values(P6_DOMAIN_KEYS)) {
      expect(manifests.records.get(`${domain}:all`)).toMatchObject({
        state: 'DIRTY', complete: false, reason: 'SOURCE_REVISION_CHANGED',
      });
    }
  });

  it('records a tombstone marker when the canonical row is deleted', async () => {
    await localTripRepository.create(trip('tombstoned', 0));
    await localTripRepository.delete('tombstoned');
    expect(work().records.get('tombstoned')).toMatchObject({
      disposition: 'TOMBSTONE', state: 'DIRTY',
    });
    const manifests = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.MANIFESTS);
    expect(manifests.records.get(`${P6_DOMAIN_KEYS.ANALYTICS}:tombstoned`)).toMatchObject({
      state: 'DIRTY', complete: false, reason: 'SOURCE_TOMBSTONED',
    });
  });

  it('converges from the durable marker alone after process death, with no notification', async () => {
    // Write through a freshly imported module chain so the payload key this
    // database holds is the one the chain persisted into it, not one cached
    // from an earlier test's database.
    vi.resetModules();
    const owner = (await import('@/lib/localTripRepository')).localTripRepository;
    await owner.create(trip('no-notifier-a', 0));
    await owner.create(trip('no-notifier-b', 1));
    expect(work().records.size).toBe(2);

    // Process death: every module-level cursor, cache and in-flight notifier is
    // discarded. Only the durable marker survives.
    vi.resetModules();
    const derived = await import('@/lib/p6TripDerivedState');
    let converged = null;
    for (let turn = 0; turn < 400; turn += 1) {
      const result = await derived.stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) { converged = result; break; }
    }
    expect(converged).toBeTruthy();
    expect(await derived.finalizeP6BrowserExplicitTripBuild(false)).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });
    for (const id of ['no-notifier-a', 'no-notifier-b']) {
      expect(work().records.get(id).state).toBe('COMPLETE');
      expect(source().records.has(id)).toBe(true);
    }
  }, 60_000);
});
