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
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  P6_DERIVED_STORAGE_RESERVE_BYTES, P6_LARGEST_DERIVED_STAGE_BYTES, p6DerivedFootprintEnvelope,
} from '@/lib/p6DerivedStorage';
import { stepP6BrowserTripDerivedUpdate } from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeDatabaseBytes } from './helpers/p6DurableObserver';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

const trace = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00021,
  lng: -79.4 - seed * 0.01 - index * 0.00017,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 48, heading: 45, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

describe('P6-V22 browser constrained volume and bounded turns', () => {
  let indexedDb;
  let rows;
  let estimate;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    estimate = { quota: 32 * 1024 ** 3, usage: 0 };
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ ...estimate }) },
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

  const queue = async (id, seed, points) => {
    const trip = {
      id, status: 'completed', source_revision: '1',
      start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
      distance_km: 9, score_overall: 88, duration_seconds: points, route_points: trace(seed, points),
    };
    rows.set(id, trip);
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(trip);
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id, desiredRevision: '1', sourceHash: `hash-${id}`, desiredSeq: seed + 1,
      disposition: 'UPSERT', dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY', cursor: null, updatedAt: 1,
    });
    await done(tx); db.close();
  };

  it('blocks derived output under the reserve while canonical trip and manual speed writes are admitted', async () => {
    await queue('pressure-trip', 0, 256);
    // One unconstrained turn first, so the blocked turn is a state transition
    // rather than a store that was never reachable.
    expect((await stepP6BrowserTripDerivedUpdate({ explicit: true })).state).not
      .toBe(P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED);

    // Constrained volume: one byte less headroom than the derived reserve needs.
    estimate = { quota: P6_DERIVED_STORAGE_RESERVE_BYTES, usage: 1 };

    let blocked = null;
    for (let turn = 0; turn < 12 && !blocked; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED) blocked = result;
    }
    expect(blocked).toMatchObject({ state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, hasMore: false });
    const manifests = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.MANIFESTS);
    // D1 is the first derived owner the turn reaches, so it is the domain that
    // records the typed refusal; no derived analytics row survives it.
    expect(manifests.records.get(`${P6_DOMAIN_KEYS.ANALYTICS}:pressure-trip`)).toMatchObject({
      state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, complete: false,
    });
    expect([...manifests.records.values()].some((row) => row.state === P6_READINESS_STATES.VERIFIED
      && row.subject === 'pressure-trip')).toBe(false);

    // Canonical capture keeps its own admission under the same pressure.
    const canonical = await localTripRepository.create({
      id: 'canonical-under-pressure', status: 'completed', distance_km: 4,
      start_time: '2026-09-01T10:00:00.000Z', end_time: '2026-09-01T10:20:00.000Z', route_points: trace(9, 12),
    });
    expect(canonical.id).toBe('canonical-under-pressure');
    expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.has('canonical-under-pressure')).toBe(true);
    // The trip queued before the pressure is still on disk, unchanged.
    expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.get('pressure-trip').route_points)
      .toHaveLength(256);

    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'pressure-initial', publicationVersion: 1,
      });
    await repository.speedKnowledgeStore.setForGeohashes({
      cells: {}, excludedSections: [], roadMemory: { candidates: [] },
      corrections: [{ id: 'manual-under-pressure', geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
    }, ['dpz8']);
    const visible = await repository.speedKnowledgeStore.getForGeohashes(['dpz8']);
    expect(visible.corrections).toEqual([expect.objectContaining({ id: 'manual-under-pressure' })]);

    // Automatically learned evidence under the same pressure is refused, so the
    // reserve is genuinely refusing derived bytes rather than being inert.
    await expect(repository.speedKnowledgeStore.setForGeohashes({
      cells: {}, excludedSections: [],
      corrections: [{ id: 'manual-under-pressure', geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
      roadMemory: { candidates: [{ id: 'automatic-under-pressure', geohash: 'dpz801', limitKmh: 50 }] },
    }, ['dpz8'])).rejects.toMatchObject({ code: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED });
    expect((await repository.speedKnowledgeStore.getForGeohashes(['dpz8'])).corrections)
      .toEqual([expect.objectContaining({ id: 'manual-under-pressure' })]);
  }, 120_000);

  it('keeps 25,000 saved speed records inside the envelope speed term', async () => {
    const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz';
    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'scale-initial', publicationVersion: 1,
      });
    const speedStores = Object.values(repository.P6_SPEED_STORES);
    const before = observeDatabaseBytes(indexedDb, repository.SPEED_KNOWLEDGE_DB_NAME, speedStores).bytes;

    const buckets = 50;
    const perBucket = 500;
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const bucketId = `dp${alphabet[bucket % 32]}${alphabet[Math.floor(bucket / 32) % 32]}`;
      const candidates = Array.from({ length: perBucket }, (_, index) => ({
        id: `${bucketId}-candidate-${index}`,
        geohash: `${bucketId}${alphabet[index % 32]}${alphabet[Math.floor(index / 32) % 32]}`,
        limitKmh: 40 + (index % 6) * 10, confidence: 0.72, sampleCount: 24,
        observedAtMs: 1_756_000_000_000 + index * 1000, source: 'road_memory',
      }));
      await repository.speedKnowledgeStore.setForGeohashes({
        cells: {}, corrections: [], excludedSections: [], roadMemory: { candidates },
      }, [bucketId]);
    }

    const speedRecords = buckets * perBucket;
    expect(speedRecords).toBe(25_000);
    const observation = observeDatabaseBytes(indexedDb, repository.SPEED_KNOWLEDGE_DB_NAME, speedStores);
    const after = observation.bytes;
    expect(observation.stores[repository.P6_SPEED_STORES.MANIFESTS].count).toBe(buckets);
    expect(observation.stores[repository.P6_SPEED_STORES.EDITOR_INDEX].count).toBeGreaterThanOrEqual(speedRecords);
    // The saved records themselves stay inside the frozen 512-byte term; the
    // editor index adds the searchable-identity rows on top, and the measured
    // total still fits E(0, 0, S).
    const payloadBytes = observation.stores[repository.P6_SPEED_STORES.PARTITIONS].bytes;
    expect(payloadBytes, `S=${speedRecords} payload=${payloadBytes}`).toBeLessThanOrEqual(512 * speedRecords);
    expect(after - before, `S=${speedRecords} measured=${after - before}`)
      .toBeLessThanOrEqual(p6DerivedFootprintEnvelope({ trips: 0, publicPoints: 0, speedRecords }));
  }, 300_000);

  it('spends more retained history on more bounded turns, not on larger turns', async () => {
    const measure = async (from, to, points) => {
      for (let index = from; index < to; index += 1) await queue(`turns-${index}`, 0, points);
      let turns = 0;
      let widestItems = 0;
      let widestBytes = 0;
      for (; turns < 20_000; turns += 1) {
        const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
        widestItems = Math.max(widestItems, Number(result.itemsWorked) || 0);
        widestBytes = Math.max(widestBytes, Number(result.bytesWorked) || 0);
        if (result.state === 'IDLE' && result.hasMore === false) break;
      }
      return { turns, widestItems, widestBytes };
    };

    const small = await measure(0, 2, 256);
    const large = await measure(2, 10, 256);
    expect(small.turns).toBeGreaterThan(0);
    expect(large.turns).toBeGreaterThan(small.turns);
    // The bound is per turn: four times the retained history must not make any
    // single lifecycle turn wider.
    expect(large.widestItems).toBe(small.widestItems);
    expect(large.widestBytes).toBe(small.widestBytes);
    expect(large.widestItems).toBeLessThanOrEqual(256 + 2);
    expect(large.widestBytes).toBeLessThanOrEqual(P6_LARGEST_DERIVED_STAGE_BYTES);

    const observed = observeDatabaseBytes(indexedDb, DB_NAME, Object.values(P6_TRIP_DERIVED_STORES));
    expect(observed.bytes).toBeLessThanOrEqual(p6DerivedFootprintEnvelope({
      trips: 10, publicPoints: 10 * 256, speedRecords: 0,
    }));
  }, 120_000);
});
