import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async () => null), setJson: vi.fn(async () => {}), removeJson: vi.fn(async () => {}),
}));

import {
  P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  P6_DOMAIN_KEYS, P6_READINESS_STATES, normalizeP6Readiness, p6CompositeReadiness,
} from '@/lib/p6Contracts';
import {
  finalizeP6BrowserExplicitTripBuild, readP6TripDomainReadiness, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { stepP6RoadMemoryUpdate } from '@/lib/p6RoadMemoryState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

const P6_MODULES = [
  'src/lib/p6Contracts.js', 'src/lib/p6DerivedStorage.js', 'src/lib/p6ExplicitOperations.js',
  'src/lib/p6PointBlockCodec.js', 'src/lib/p6RoadEvidence.js', 'src/lib/p6RoadMemoryState.js',
  'src/lib/p6TripDerivedState.js',
];

const productionFiles = (directory = 'src', found = []) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__' || entry === '__fixtures__') continue;
      productionFiles(path, found);
    } else if (/\.(js|jsx)$/.test(entry)) found.push(path);
  }
  return found;
};

describe('P6-V25 per-domain independence and legacy routine retirement', () => {
  let indexedDb;
  let rows;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_name, _options, operation) => operation() },
    });
    rows = new Map();
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('leaves D1, D2 and D3 eligible while D4 reports CONVERSION_REQUIRED without E4', async () => {
    const trip = {
      id: 'no-e4-trip', status: 'completed', source_revision: '1',
      start_time: '2026-09-01T10:00:00.000Z', distance_km: 6, score_overall: 91, duration_seconds: 64,
      route_points: Array.from({ length: 64 }, (_, index) => ({
        lat: 43.6 + index * 0.00021, lng: -79.4 - index * 0.00017,
        timestamp: 1_756_000_000_000 + index * 1000, speed_kmh: 46, accuracy: 6,
      })),
    };
    rows.set(trip.id, trip);
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(trip);
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: trip.id, desiredRevision: '1', sourceHash: 'hash-no-e4', desiredSeq: 1,
      disposition: 'UPSERT', dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY', cursor: null, updatedAt: 1,
    });
    await done(tx); db.close();

    for (let turn = 0; turn < 200; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    expect(await finalizeP6BrowserExplicitTripBuild(false))
      .toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    // No E4 has run, so browser saved speed is still v1 and only D4 converts.
    const road = await stepP6RoadMemoryUpdate();
    expect(road.state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);

    const analytics = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
    const geometry = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, trip.id);
    const spatial = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, trip.id);
    const roadReadiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, trip.id);
    expect(analytics.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(geometry.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(spatial.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(roadReadiness.state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
    expect(roadReadiness.complete).toBe(false);

    // Each domain is released on its own evidence: the three eligible domains
    // compose complete while the composite including D4 does not.
    const states = [analytics, geometry, spatial, roadReadiness];
    expect(p6CompositeReadiness(states, [
      P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION,
    ]).complete).toBe(true);
    const composite = p6CompositeReadiness(states, Object.values(P6_DOMAIN_KEYS));
    expect(composite.complete).toBe(false);
    expect(composite.state).toBe(P6_READINESS_STATES.CONVERSION_REQUIRED);
  }, 120_000);

  it('never lets an unknown or global readiness value stand in for a domain', () => {
    expect(normalizeP6Readiness({ domain: P6_DOMAIN_KEYS.ANALYTICS, state: 'READY' }).state)
      .toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
    expect(normalizeP6Readiness({ domain: P6_DOMAIN_KEYS.ANALYTICS, state: 'VERIFIED' }).complete).toBe(false);
    // An absent domain is missing evidence, never an inherited pass.
    expect(p6CompositeReadiness([], Object.values(P6_DOMAIN_KEYS)).state)
      .toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
    const contracts = readFileSync('src/lib/p6Contracts.js', 'utf8');
    expect(/p6Ready|P6_READY|isP6Ready/.test(contracts)).toBe(false);
  });

  it('asserts each named legacy routine is retired rather than left to source reading', () => {
    // The whole-model road learner has no production caller.
    const callers = productionFiles().filter((path) => (
      path !== join('src', 'lib', 'localSpeedKnowledge.js')
      && /\blearnRoadMemoryFromTrips\b/.test(readFileSync(path, 'utf8'))
    ));
    expect(callers).toEqual([]);

    // The monolithic geometry rebuild yields to the paged D2 reader.
    const geometryIndex = readFileSync('src/lib/speedGeometryIndex.js', 'utf8');
    expect(geometryIndex).toMatch(/queryP6GeometryPreviewPage/);
    expect(geometryIndex).toMatch(/p6\.version === 2\) return p6/);

    // A VERIFIED D2 that cannot serve refuses in a named way; only an
    // unnamed refusal may reach the retired whole-geometry index.
    expect(geometryIndex).toMatch(/p6\?\.compatibilityAllowed !== true/);

    // The same boundary for D3: a named refusal is a demotion, and the caller
    // takes the typed disposition rather than the retired history scan.
    const rescore = readFileSync('src/lib/localSpeedScoreRefresh.js', 'utf8');
    expect(rescore).toMatch(/recordP6AffectedTripRescoreDebt/);
    expect(rescore).toMatch(/return refusedSpatialSelection\(request, operation\)/);

    // Post-E4 the browser cannot quietly return to the v1 whole model, even
    // when the store holding the v2 authority row cannot be opened.
    const speed = readFileSync('src/lib/speedKnowledgeRepository.js', 'utf8');
    expect(speed).toMatch(/P6_SPEED_V2_CUTOVER_MARKER_KEY/);
    expect(speed).toMatch(/P6_SPEED_AUTHORITY_UNREADABLE/);

    // The road-memory coordinator delegates instead of replaying the payload.
    const coordinator = readFileSync('src/lib/roadMemoryCoordinator.js', 'utf8');
    expect(coordinator).toMatch(/delegated: 'p6RoadMemoryUpdates'/);

    // No routine OFFSET pagination exists in any P6 module, and the single
    // ordinal cursor over an already-loaded payload is explicit-only.
    for (const path of P6_MODULES) {
      const source = readFileSync(path, 'utf8');
      expect(/\bOFFSET\b/.test(source), path).toBe(false);
    }
    const derived = readFileSync('src/lib/p6TripDerivedState.js', 'utf8');
    expect(derived).toMatch(/if \(!explicit\) return \{ points: \[\], done: false, cursor, compatibilityRequired: true/);
  });
});
