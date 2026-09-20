import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DPD-011 end-to-end — D4 road learning must actually work on the platform the
 * product ships on.
 *
 * `p6DomainReleaseMatrix` Case D already proves the post-E4 release path under a
 * **web** platform mock. That mock is exactly what hid DPD-011: on Android with
 * P3.5 native authority unreleased, the browser owns saved speeds, yet E4 was
 * refused and D4 stayed at `CONVERSION_REQUIRED` for the life of the install.
 *
 * This is the same journey with the platform reporting Android and the native
 * release gate off — the shipping configuration. It asserts the observable
 * outcome: road **windows** get written and D4 reaches VERIFIED, i.e. real local
 * learning happened, not merely that a boolean flipped.
 */

const state = vi.hoisted(() => ({ storage: new Map(), trips: new Map() }));

// The shipping configuration: Android runtime, native authority unreleased.
vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => true, isNativePlatform: () => true,
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({ value: state.storage.has(`pref:${key}`) ? JSON.stringify(state.storage.get(`pref:${key}`)) : null })),
    set: vi.fn(async ({ key, value }) => state.storage.set(`pref:${key}`, JSON.parse(value))),
    remove: vi.fn(async ({ key }) => state.storage.delete(`pref:${key}`)),
  },
}));
// Reporting a native platform routes the payload crypto at the real
// SecureBridge plugin, which does not exist under vitest. These stand-ins keep
// the test about authority routing rather than about the crypto transport.
vi.mock('@/lib/securePayloadCrypto', () => ({
  encryptSensitiveValue: vi.fn(async (value, context) => ({
    encrypted: true, key_version: 1, context, payload: structuredClone(value),
  })),
  decryptSensitiveValue: vi.fn(async (value) => structuredClone(value.payload)),
  getEncryptedJson: vi.fn(async (key, fallback = null) => (
    state.storage.has(`enc:${key}`) ? structuredClone(state.storage.get(`enc:${key}`)) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => { state.storage.set(`enc:${key}`, structuredClone(value)); }),
  removeEncryptedJson: vi.fn(async (key) => { state.storage.delete(`enc:${key}`); }),
  isEncryptedPayload: (value) => value?.encrypted === true,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: async (key, fallback = null) => (
    state.storage.has(key) ? structuredClone(state.storage.get(key)) : fallback
  ),
  setJson: async (key, value) => { state.storage.set(key, structuredClone(value)); },
  removeJson: async (key) => { state.storage.delete(key); },
}));

import {
  P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import {
  finalizeP6BrowserExplicitTripBuild, readP6TripDomainReadiness, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { stepP6RoadMemoryUpdate } from '@/lib/p6RoadMemoryState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

/** A straight run of closely spaced points, so windows have something to reduce. */
const tripFixture = (id) => ({
  id, status: 'completed', source_revision: '1',
  start_time: '2026-09-01T10:00:00.000Z', end_time: '2026-09-01T10:30:00.000Z',
  distance_km: 9, score_overall: 88, duration_seconds: 1800,
  route_points: Array.from({ length: 256 }, (_, index) => ({
    lat: 43.6 + index * 0.00021, lng: -79.4 - index * 0.00017,
    timestamp: 1_756_000_000_000 + index * 1000, speed_kmh: 48, accuracy: 6,
  })),
});

const seedTrip = async (trip) => {
  state.trips.set(trip.id, trip);
  const db = await openP6TripDerivedDatabase();
  const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
  tx.objectStore(P6_TRIP_SOURCE_STORE).put(trip);
  tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
    tripId: trip.id, desiredRevision: '1', sourceHash: `hash-${trip.id}`, desiredSeq: 1,
    disposition: 'UPSERT', dirtyDomains: Object.values(P6_DOMAIN_KEYS),
    state: 'DIRTY', cursor: null, updatedAt: 1,
  });
  await done(tx);
  db.close();
};

const drainTripDerived = async () => {
  for (let turn = 0; turn < 600; turn += 1) {
    const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
    if (result.state === 'IDLE' && result.hasMore === false) return;
  }
  throw new Error('P6 trip derived drain did not converge');
};

/** Write a v1 predecessor where a native platform's E4 will look for it. */
const seedLegacyModel = (repository, model) => {
  state.storage.set(`pref:${repository.SPEED_KNOWLEDGE_STORAGE_KEY}`, {
    encrypted: true, key_version: 1, ciphertext: 'legacy-ciphertext', payload: model,
  });
};

const countRows = async (store) => {
  const db = await openP6TripDerivedDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(store, 'readonly').objectStore(store).getAll();
      request.onsuccess = () => resolve((request.result || []).length);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
};

describe('DPD-011 — D4 road learning on Android under shipping browser authority', () => {
  let indexedDb;

  beforeEach(async () => {
    indexedDb = new FakeIndexedDb();
    state.storage.clear();
    state.trips.clear();
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'false');
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_name, _options, operation) => operation() },
    });
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = state.trips.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
    await seedTrip(tripFixture('trip-a'));
    await drainTripDerived();
    expect(await finalizeP6BrowserExplicitTripBuild(false))
      .toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  }, 180_000);

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('runs E4 and then produces real road windows, reaching a VERIFIED D4', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');

    // Shipping Android: the browser owns saved speeds.
    expect(repository.isNativeSpeedAuthoritySelected()).toBe(false);

    // On a native platform E4 selects its predecessor from Capacitor
    // Preferences, which is exactly the Android-specific branch that proves E4
    // was designed to run here.
    seedLegacyModel(repository, {
      schemaVersion: 1, knowledgeRevision: 4, cells: {},
      corrections: [{ id: 'pre-e4', geohash: 'dpz89g', limitKmh: 50, source: 'manual' }],
      excludedSections: [], roadMemory: { candidates: [] },
    });

    // Before E4, D4 correctly asks for conversion — the frozen pre-E4 contract.
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    expect((await stepP6RoadMemoryUpdate()).state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
    expect(await countRows(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS)).toBe(0);

    // E4 is permitted on Android now that the browser is the authority. This is
    // the call that threw E4_BROWSER_ONLY before the fix.
    expect(await repository.beginP6BrowserSpeedMigration())
      .toMatchObject({ state: 'CONVERSION_IN_PROGRESS' });
    for (let turn = 0; turn < 64; turn += 1) {
      if ((await repository.stepP6BrowserSpeedMigration()).done) break;
    }
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(true);

    // Now road learning must actually run rather than ask for conversion again.
    let converged = false;
    for (let turn = 0; turn < 20_000; turn += 1) {
      const step = await stepP6RoadMemoryUpdate();
      expect(step.state).not.toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
      if (step.hasMore === false) { converged = true; break; }
    }
    expect(converged).toBe(true);

    // The observable product of learning: windows on disk and a released head.
    expect(await countRows(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS)).toBeGreaterThan(0);
    expect((await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, 'trip-a')).state)
      .toBe(P6_READINESS_STATES.VERIFIED);
  }, 180_000);

  it('leaves D1/D2/D3 released and untouched by the D4 conversion', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    seedLegacyModel(repository, {
      schemaVersion: 1, knowledgeRevision: 4, cells: {}, corrections: [],
      excludedSections: [], roadMemory: { candidates: [] },
    });
    await repository.beginP6BrowserSpeedMigration();
    for (let turn = 0; turn < 64; turn += 1) {
      if ((await repository.stepP6BrowserSpeedMigration()).done) break;
    }
    for (const domain of [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY]) {
      expect((await readP6TripDomainReadiness(domain, 'all')).state)
        .toBe(P6_READINESS_STATES.VERIFIED);
    }
  }, 180_000);
});
