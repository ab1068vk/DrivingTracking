import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P6-N07 / P6-M14 — independent per-domain release.
 *
 * D1-D4 are released on their own evidence. This file drives one real browser
 * owner through the frozen release cases: a domain may serve while its
 * neighbours are unavailable, browser D4 stays exactly `CONVERSION_REQUIRED`
 * until E4 completes, and a later demotion costs only the demoted domain its
 * readiness. It also proves the D2 retirement boundary at the owner: a
 * VERIFIED domain that cannot serve a bounded page revokes its own head rather
 * than reporting a result it cannot produce.
 */

const state = vi.hoisted(() => ({ storage: new Map(), trips: new Map() }));

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
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
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import {
  createP6AffectedTripSelectionRequest, finalizeP6BrowserExplicitTripBuild, queryP6GeometryPreviewPage,
  readP6AchievementStats, readP6TripDomainReadiness, setP6TripDomainReadiness,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { stepP6RoadMemoryUpdate } from '@/lib/p6RoadMemoryState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

const tripFixture = (id) => ({
  id, status: 'completed', source_revision: '1',
  start_time: '2026-09-01T10:00:00.000Z', end_time: '2026-09-01T10:30:00.000Z',
  distance_km: 9, score_overall: 88, duration_seconds: 1800,
  route_points: Array.from({ length: 96 }, (_, index) => ({
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
  for (let turn = 0; turn < 400; turn += 1) {
    const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
    if (result.state === 'IDLE' && result.hasMore === false) return;
  }
  throw new Error('P6 trip derived drain did not converge');
};

const readiness = async () => ({
  d1: (await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all')).state,
  d2: (await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all')).state,
  d3: (await readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, 'all')).state,
  d4: (await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, 'trip-a')).state,
});

const revoke = (domain) => setP6TripDomainReadiness({
  domain, subject: 'all', state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
});

const restore = (domain) => setP6TripDomainReadiness({
  domain, subject: 'all', sourceBinding: 'browser',
  state: P6_READINESS_STATES.VERIFIED, complete: true,
});

const cellDescriptor = { kind: 'cell', geohash: 'dpz89g', lat: 43.6, lng: -79.4 };

describe('P6-N07/P6-M14 independent D1-D4 release matrix', () => {
  let indexedDb;

  beforeEach(async () => {
    indexedDb = new FakeIndexedDb();
    state.storage.clear();
    state.trips.clear();
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

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('Case A: D1 serves alone while D2 and D3 are unavailable and D4 needs conversion', async () => {
    await revoke(P6_DOMAIN_KEYS.GEOMETRY);
    await revoke(P6_DOMAIN_KEYS.SPATIAL_SELECTION);
    expect((await stepP6RoadMemoryUpdate()).state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);

    // D1 answers from its own head, with no reference to its neighbours.
    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-02T00:00:00Z') });
    expect(stats).toMatchObject({ source: 'p6_revision_exact', completedCount: 1 });

    // D2 and D3 name their own unavailability and each allows exactly the
    // frozen compatibility disposition, not a borrowed D1 readiness.
    const geometry = await queryP6GeometryPreviewPage({ maxTrips: 8 });
    expect(geometry).toMatchObject({ available: false, compatibilityAllowed: true });
    const selection = await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_a',
    });
    expect(selection).toMatchObject({ accepted: false });
    expect(selection.reason).toBeUndefined();
    expect(await readiness()).toMatchObject({
      d1: P6_READINESS_STATES.VERIFIED,
      d2: P6_READINESS_STATES.REBUILD_REQUIRED,
      d3: P6_READINESS_STATES.REBUILD_REQUIRED,
      d4: P6_READINESS_STATES.CONVERSION_REQUIRED,
    });
  }, 60_000);

  it('Case B: D1 and D2 serve their own APIs while D3 is unavailable', async () => {
    await revoke(P6_DOMAIN_KEYS.SPATIAL_SELECTION);

    expect(await readP6AchievementStats({ now: Date.parse('2026-09-02T00:00:00Z') }))
      .toMatchObject({ source: 'p6_revision_exact', completedCount: 1 });
    const geometry = await queryP6GeometryPreviewPage({ maxTrips: 8 });
    expect(geometry).toMatchObject({ available: true, compatibilityAllowed: false });
    expect(geometry.items.map((item) => item.id)).toEqual(['trip-a']);

    const selection = await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_b',
    });
    expect(selection.accepted).toBe(false);
  }, 60_000);

  it('Case C: D1, D2 and D3 are released while browser D4 stays exactly CONVERSION_REQUIRED', async () => {
    expect(await readP6AchievementStats({ now: Date.parse('2026-09-02T00:00:00Z') }))
      .toMatchObject({ source: 'p6_revision_exact', completedCount: 1 });
    expect(await queryP6GeometryPreviewPage({ maxTrips: 8 })).toMatchObject({ available: true });
    expect(await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_c',
    })).toMatchObject({ accepted: true });

    // No E4 has run. D4 is the one domain that is not released, and it says so
    // in exactly the frozen vocabulary rather than by failing.
    const road = await stepP6RoadMemoryUpdate();
    expect(road.state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
    expect((await readiness()).d4).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
  }, 60_000);

  it('Case D: after E4 all four domains are ready and D4 leaves v1 behind', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    // A v1 predecessor model, exactly where the browser writes one.
    state.storage.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, {
      schemaVersion: 1, knowledgeRevision: 4, cells: {},
      corrections: [{ id: 'pre-e4', geohash: 'dpz89g', limitKmh: 50, source: 'manual' }],
      excludedSections: [], roadMemory: { candidates: [] },
    });

    // Before E4 the v1 whole model is the legal authority.
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    expect((await repository.speedKnowledgeStore.get()).corrections[0].id).toBe('pre-e4');
    expect((await stepP6RoadMemoryUpdate()).state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);

    expect(await repository.beginP6BrowserSpeedMigration())
      .toMatchObject({ state: 'CONVERSION_IN_PROGRESS' });
    // During E4 v1 still holds authority under the durable fence.
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    for (let turn = 0; turn < 64; turn += 1) {
      const step = await repository.stepP6BrowserSpeedMigration();
      if (step.done) break;
    }
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(true);

    // After the atomic switch the retired whole-model read is typed-refused,
    // and the out-of-band cutover marker means an installation that can no
    // longer open IndexedDB refuses too rather than serving v1 again.
    await expect(repository.speedKnowledgeStore.get())
      .rejects.toMatchObject({ code: repository.P6_SPEED_SCOPED_READ_REQUIRED });
    expect(state.storage.get(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY))
      .toMatchObject({ version: 2 });
    vi.stubGlobal('indexedDB', undefined);
    await expect(repository.readP6BrowserSpeedAuthority())
      .rejects.toMatchObject({ code: repository.P6_SPEED_AUTHORITY_UNREADABLE });
    vi.stubGlobal('indexedDB', indexedDb);

    let roadConverged = false;
    for (let turn = 0; turn < 20_000; turn += 1) {
      const step = await stepP6RoadMemoryUpdate();
      // Post-cutover J2 never asks for conversion again.
      expect(step.state).not.toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
      if (step.hasMore === false) { roadConverged = true; break; }
    }
    expect(roadConverged).toBe(true);
    expect(await finalizeP6BrowserExplicitTripBuild(true))
      .toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    // All four domains are ready, each on its own head, and each still serves
    // through its own new routine path.
    expect(await readiness()).toMatchObject({
      d1: P6_READINESS_STATES.VERIFIED,
      d2: P6_READINESS_STATES.VERIFIED,
      d3: P6_READINESS_STATES.VERIFIED,
      d4: P6_READINESS_STATES.VERIFIED,
    });
    expect((await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, 'all')).state)
      .toBe(P6_READINESS_STATES.VERIFIED);
    expect(await readP6AchievementStats({ now: Date.parse('2026-09-02T00:00:00Z') }))
      .toMatchObject({ source: 'p6_revision_exact' });
    expect(await queryP6GeometryPreviewPage({ maxTrips: 8 })).toMatchObject({ available: true });
    expect(await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_d',
    })).toMatchObject({ accepted: true });
  }, 180_000);

  it('Case E: a demoted domain loses only its own readiness', async () => {
    // A generation/corruption demotion of D2 alone.
    await revoke(P6_DOMAIN_KEYS.GEOMETRY);

    expect(await readiness()).toMatchObject({
      d1: P6_READINESS_STATES.VERIFIED,
      d2: P6_READINESS_STATES.REBUILD_REQUIRED,
      d3: P6_READINESS_STATES.VERIFIED,
    });
    expect(await readP6AchievementStats({ now: Date.parse('2026-09-02T00:00:00Z') }))
      .toMatchObject({ source: 'p6_revision_exact', completedCount: 1 });
    expect(await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_e',
    })).toMatchObject({ accepted: true });

    await restore(P6_DOMAIN_KEYS.GEOMETRY);
    await revoke(P6_DOMAIN_KEYS.SPATIAL_SELECTION);
    expect(await queryP6GeometryPreviewPage({ maxTrips: 8 })).toMatchObject({ available: true });
    expect(await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_case_e_2',
    })).toMatchObject({ accepted: false });
  }, 60_000);

  it('D2 retirement: a VERIFIED domain that cannot serve revokes its head instead of falling back', async () => {
    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.MANIFESTS,
      operation: 'openCursor',
      error: new Error('D2_PAGE_READ_FAILED'),
    });

    const page = await queryP6GeometryPreviewPage({ maxTrips: 8 });
    // The refusal is named, so the caller may not treat the retired whole
    // geometry index as the routine steady state.
    expect(page).toMatchObject({
      available: false, compatibilityAllowed: false, reason: 'DERIVED_GEOMETRY_UNREADABLE',
      state: P6_READINESS_STATES.REBUILD_REQUIRED,
    });
    expect((await readiness()).d2).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);

    // Only D2 lost readiness, and the demoted domain now takes the legal
    // compatibility disposition rather than claiming coverage it cannot serve.
    expect((await readiness()).d3).toBe(P6_READINESS_STATES.VERIFIED);
    expect(await queryP6GeometryPreviewPage({ maxTrips: 8 }))
      .toMatchObject({ available: false, compatibilityAllowed: true });
  }, 60_000);

  it('D3 retirement: a VERIFIED domain that cannot record a request revokes its head', async () => {
    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.CONTROL,
      operation: 'put',
      error: new Error('D3_REQUEST_WRITE_FAILED'),
    });

    const refused = await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_d3_retirement',
    });
    expect(refused).toMatchObject({
      accepted: false, reason: 'SPATIAL_SELECTION_UNAVAILABLE',
      state: P6_READINESS_STATES.REBUILD_REQUIRED,
    });
    expect((await readiness()).d3).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
    expect((await readiness()).d1).toBe(P6_READINESS_STATES.VERIFIED);

    // The demoted domain's next refusal is unnamed: it no longer claims
    // coverage, so the bounded compatibility scan is legal again.
    const next = await createP6AffectedTripSelectionRequest({
      descriptors: [cellDescriptor], reason: 'matrix_d3_retirement_2',
    });
    expect(next.accepted).toBe(false);
    expect(next.reason).toBeUndefined();
  }, 60_000);

  it('commits a multi-page D3 descriptor set atomically when page three fails', async () => {
    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.CONTROL,
      operation: 'put',
      skip: 2,
      error: new Error('D3_PAGE_THREE_WRITE_FAILED'),
    });
    const refused = await createP6AffectedTripSelectionRequest({
      descriptors: [{
        kind: 'correction', id: 'wide-correction',
        sectionPoints: [{ lat: 0, lng: -170 }, { lat: 0, lng: 0 }],
      }],
      reason: 'atomic_multi_page',
    });
    expect(refused).toMatchObject({
      accepted: false, reason: 'SPATIAL_SELECTION_UNAVAILABLE',
      state: P6_READINESS_STATES.REBUILD_REQUIRED,
    });
    const control = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.CONTROL);
    expect([...control.records.keys()].filter((key) => String(key).startsWith('selection:'))).toEqual([]);
  }, 120_000);
});
