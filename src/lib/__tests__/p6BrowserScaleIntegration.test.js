import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import { p6DerivedFootprintEnvelope } from '@/lib/p6DerivedStorage';
import { finalizeP6BrowserExplicitTripBuild, stepP6BrowserTripDerivedUpdate } from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeDatabaseBytes } from './helpers/p6DurableObserver';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

const DERIVED_STORES = Object.values(P6_TRIP_DERIVED_STORES);
const POINTS_PER_TRIP = 600;
const TEMPLATE_TRIPS = 4;

// A 600-point 1 Hz drive that changes speed and heading, so its points spread
// across real spatial cells instead of collapsing into one.
const drive = (seed) => {
  let lat = 43.6 + seed * 0.01;
  let lng = -79.4 - seed * 0.01;
  let heading = (seed * 37) % 360;
  const points = [];
  for (let index = 0; index < POINTS_PER_TRIP; index += 1) {
    const speed = 34 + 46 * Math.abs(Math.sin((index + seed) / 55));
    heading = (heading + Math.sin((index + seed) / 23) * 4 + 360) % 360;
    const metres = speed / 3.6;
    lat += (metres * Math.cos((heading * Math.PI) / 180)) / 111_320;
    lng += (metres * Math.sin((heading * Math.PI) / 180)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    points.push({
      lat, lng, timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
      speed_kmh: Number(speed.toFixed(2)), heading: Number(heading.toFixed(2)), accuracy: 6,
      speed_limit_kmh: 60, speed_limit_source: 'osm', utc_offset_minutes: -240,
      timezone_id: 'America/Toronto',
    });
  }
  return points;
};

describe('P6-V22 browser durable scale', () => {
  let indexedDb;
  let rows;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 32 * 1024 ** 3, usage: 0 }) },
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

  const queue = async (id, seed) => {
    const trip = {
      id, status: 'completed', source_revision: '1',
      start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
      distance_km: 9, score_overall: 88, duration_seconds: POINTS_PER_TRIP, route_points: drive(seed),
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

  const drain = async (limit = 100_000) => {
    let turns = 0;
    let widestItems = 0;
    let widestBytes = 0;
    for (; turns < limit; turns += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      widestItems = Math.max(widestItems, Number(result.itemsWorked) || 0);
      widestBytes = Math.max(widestBytes, Number(result.bytesWorked) || 0);
      if (result.state === 'IDLE' && result.hasMore === false) break;
      if (result.state === P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED) break;
    }
    return { turns, widestItems, widestBytes };
  };

  it('measures durable IndexedDB footprint against E(N,P,S) across the frozen tier matrix', async () => {
    // Tier zero: no canonical source, therefore no derived footprint at all.
    await openP6TripDerivedDatabase().then((db) => db.close());
    expect(observeDatabaseBytes(indexedDb, DB_NAME, DERIVED_STORES).bytes)
      .toBeLessThanOrEqual(p6DerivedFootprintEnvelope({ trips: 0, publicPoints: 0, speedRecords: 0 }));

    for (let index = 0; index < TEMPLATE_TRIPS; index += 1) await queue(`tpl-${index}`, index);
    await drain();
    const finalized = await finalizeP6BrowserExplicitTripBuild(false);
    expect(finalized).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    // Independent structural checks before any replication: production really
    // did publish per-trip geometry, spatial postings and shared road spills.
    const template = observeDatabaseBytes(indexedDb, DB_NAME, DERIVED_STORES);
    expect(template.stores[P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS].count).toBeGreaterThan(TEMPLATE_TRIPS);
    expect(template.stores[P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS].count).toBeGreaterThan(TEMPLATE_TRIPS);
    expect(template.stores[P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS].count).toBeGreaterThan(TEMPLATE_TRIPS);
    expect(template.bytes).toBeLessThanOrEqual(p6DerivedFootprintEnvelope({
      trips: TEMPLATE_TRIPS, publicPoints: TEMPLATE_TRIPS * POINTS_PER_TRIP,
    }));

    // Every durable row production wrote for a template trip, captured once and
    // replayed under fresh identities. This is the browser counterpart of the
    // native scale fixture: the rows are the real published records at the real
    // published sizes, not an invented shape.
    const captured = DERIVED_STORES.map((store) => {
      const state = indexedDb.getStoreState(DB_NAME, store);
      const perTrip = new Map();
      state?.records.forEach((record, key) => {
        const owner = String(record?.tripId ?? record?.subject ?? '');
        if (!owner.startsWith('tpl-')) return;
        if (!perTrip.has(owner)) perTrip.set(owner, []);
        perTrip.get(owner).push({ key, record });
      });
      return { store, perTrip };
    });
    expect(captured.some(({ perTrip }) => perTrip.size === TEMPLATE_TRIPS)).toBe(true);

    const replicate = (target) => {
      let existing = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.WORK).records.size;
      while (existing < target) {
        const source = `tpl-${existing % TEMPLATE_TRIPS}`;
        const id = `scale-${existing}`;
        for (const { store, perTrip } of captured) {
          const state = indexedDb.getStoreState(DB_NAME, store);
          for (const { key, record } of perTrip.get(source) || []) {
            const nextKey = String(key).split(source).join(id);
            const next = { ...record, tripId: id };
            if (record.subject !== undefined) next.subject = id;
            if (record.key !== undefined) next.key = nextKey;
            state.records.set(nextKey, next);
          }
        }
        existing += 1;
      }
    };

    let previousBytes = template.bytes;
    for (const trips of [100, 500, 1000, 3000, 5000, 10_000]) {
      replicate(trips);
      const observed = observeDatabaseBytes(indexedDb, DB_NAME, DERIVED_STORES);
      const publicPoints = trips * POINTS_PER_TRIP;
      const envelope = p6DerivedFootprintEnvelope({ trips, publicPoints, speedRecords: 0 });
      expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.WORK).records.size).toBe(trips);
      expect(
        observed.bytes,
        `N=${trips} P=${publicPoints} measured=${observed.bytes} envelope=${envelope}`,
      ).toBeLessThanOrEqual(envelope);
      expect(observed.bytes).toBeGreaterThan(previousBytes);
      previousBytes = observed.bytes;
    }
    // The main tier carries the frozen fixture cardinality: 5,000 trips is
    // 3,000,000 permitted public points, and 10,000 extends it.
    expect(5000 * POINTS_PER_TRIP).toBe(3_000_000);
  }, 600_000);
});
