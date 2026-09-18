import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));

import {
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  localTripRepository,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  finalizeP6BrowserExplicitTripBuild,
  queryP6GeometryByIds,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { queryTripGeometryPage } from '@/lib/tripQueryFacade';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { P7_COMPLETENESS, P7_UNAVAILABLE_CODES, p7EnvelopeViolations } from '@/lib/tripQueryContracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 2 — Q8 step B, the read-only D2 by-ID batch.
 *
 * The D2 manifests and chunks are produced by the **real** P6 browser update
 * path, so these assert against geometry the owner actually derived. Authority
 * crossings are counted at the IndexedDB boundary, outside the facade.
 */

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});

const DAY = 86400000;
const BASE = Date.UTC(2026, 2, 3);

/** A short route the D2 builder can derive a preview from. */
const route = (seed) => Array.from({ length: 12 }, (_, index) => ({
  lat: 43.6 + (seed + index) * 0.001,
  lng: -79.4 + (seed + index) * 0.001,
  timestamp: new Date(BASE + seed * DAY + index * 1000).toISOString(),
}));

describe('P7 Q8 step B — D2 by-ID batch', () => {
  let indexedDb;
  let observer;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip) => {
    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 800; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  const seed = async (count) => {
    const ids = [];
    for (let index = 0; index < count; index += 1) {
      const id = `geo-${index}`;
      const startTime = new Date(BASE + index * DAY).toISOString();
      await queue({
        id,
        status: 'completed',
        start_time: startTime,
        end_time: new Date(BASE + index * DAY + 600000).toISOString(),
        distance_km: 8 + index,
        duration_seconds: 600,
        route_points: route(index),
      });
      ids.push(id);
    }
    await drain();
    return ids;
  };

  it('hydrates exactly the requested id page, in the order it was given', async () => {
    const ids = await seed(4);
    // Deliberately not the manifest key order — chronology is the selection
    // step's property and the batch must not re-sort it away.
    const requested = [ids[3], ids[0], ids[2]];

    const batch = await queryP6GeometryByIds(requested);

    expect(batch.unavailable).toBeUndefined();
    expect(batch.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(batch.data.map((entry) => entry.id)).toEqual(requested);
    expect(batch.data.every((entry) => entry.coverage === 'covered')).toBe(true);
    expect(batch.p6Readiness.domain).toBe(P6_DOMAIN_KEYS.GEOMETRY);
    expect(p7EnvelopeViolations('Q8', batch)).toEqual([]);
  });

  it('uses a constant number of authority crossings, whatever the page size', async () => {
    const ids = await seed(8);

    observer.reset();
    await queryP6GeometryByIds(ids.slice(0, 2));
    const smallPage = observer.counts.transactions;

    observer.reset();
    await queryP6GeometryByIds(ids);
    const fullPage = observer.counts.transactions;

    // Three transactions, whatever k is: the readiness read, one for every
    // manifest, one for every preview chunk. The law is that the count does not
    // move with the page size — never k detail calls, and never N x Q2.
    expect(fullPage).toBe(smallPage);
    expect(smallPage).toBe(3);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);
  });

  it('reports a trip the owner has no preview for as unknown, never as zero', async () => {
    const ids = await seed(2);

    const batch = await queryP6GeometryByIds([...ids, 'never-derived']);

    const missing = batch.data.find((entry) => entry.id === 'never-derived');
    expect(missing.coverage).toBe('unknown');
    // "The owner has nothing for this id" and "this trip has no geometry" are
    // different facts, and an empty route would assert the wrong one.
    expect(missing.route_points).toBeNull();
    expect(missing.geometry_indexed).toBe(false);
  });

  it('keeps the frozen D2 preview bounds and never widens them for a caller', async () => {
    const ids = await seed(2);

    const batch = await queryP6GeometryByIds(ids, { maxPoints: 5000 });

    for (const entry of batch.data) {
      expect(entry.route_points.length).toBeLessThanOrEqual(160);
      expect(entry.preview_point_cap).toBeLessThanOrEqual(160);
      expect(entry.preview_chunk_cap).toBe(2);
    }
  });

  it('surfaces a D2 refusal as the real readiness state, never as generic PARTIAL', async () => {
    // Nothing derived: the geometry domain has never reached VERIFIED.
    const batch = await queryP6GeometryByIds(['geo-0', 'geo-1']);

    expect(batch.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.OWNER_NOT_READY);
    expect(batch.data).toBeNull();
    expect(batch.completeness).not.toBe(P7_COMPLETENESS.PARTIAL);
    expect(batch.continuation).toBeNull();
    expect(batch.p6Readiness.complete).toBe(false);
    // An unnamed refusal is a domain that never claimed coverage, so the legacy
    // compatibility route stays legal here.
    expect(batch.compatibilityAllowed).toBe(true);
    expect(p7EnvelopeViolations('Q8', batch)).toEqual([]);
  });

  it('answers an empty id page without touching the owner', async () => {
    await seed(2);

    observer.reset();
    const batch = await queryP6GeometryByIds([]);

    expect(batch.data).toEqual([]);
    expect(batch.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(observer.counts.transactions).toBe(1); // the readiness read only
  });
});

describe('P7 Q8 — the bounded composition (Q1 selection + D2 hydration)', () => {
  let indexedDb;
  let observer;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    observer = observeIndexedDb(indexedDb);
    vi.stubGlobal('indexedDB', observer.factory);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 11,
        data_retention_days: 3650,
        raw_gps_retention_days: 3650,
        privacy_zones: [],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /**
   * Create a trip on **both** owners, as production does: the canonical store
   * Q1 selects from, and the P6 work/source queue D2 derives from.
   */
  const create = async (index, overrides = {}) => {
    const startTime = new Date(BASE + index * DAY).toISOString();
    const trip = {
      id: `comp-${index}`,
      status: 'completed',
      start_time: startTime,
      end_time: new Date(BASE + index * DAY + 600000).toISOString(),
      distance_km: 8 + index,
      duration_seconds: 600,
      route_points: route(index),
      ...overrides,
    };
    const saved = await localTripRepository.create(trip);

    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
    return saved;
  };

  /** Drive the real P6 browser derived update until D2 is VERIFIED. */
  const drainDerived = async () => {
    for (let turn = 0; turn < 400; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  it('selects chronologically through Q1 and reports PARTIAL while a further page exists', async () => {
    for (let index = 0; index < 5; index += 1) await create(index);
    await drainDerived();

    const page = await queryTripGeometryPage({ limit: 2, status: 'completed' });

    // Newest first: Q1 owns chronology, not the D2 manifest key order.
    expect(page.data.map((row) => row.id)).toEqual(['comp-4', 'comp-3']);
    // Truthful viewport semantics: never "complete coverage" while more remains.
    expect(page.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    expect(page.continuation).not.toBeNull();

    const rest = await queryTripGeometryPage({ limit: 10, status: 'completed', cursor: page.continuation });
    expect(rest.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(rest.continuation).toBeNull();
    expect(rest.data.map((row) => row.id)).toEqual(['comp-2', 'comp-1', 'comp-0']);
  });

  it('preserves the privacy and expiry eligibility the legacy map read applies', async () => {
    await create(0);
    await create(1, { privacy_mode: 'summary_only' });
    await create(2, { route_data_expired_at: new Date(BASE).toISOString() });
    await drainDerived();

    const page = await queryTripGeometryPage({ limit: 50, status: 'completed' });

    // A summary-only trip and an expired route contribute no geometry, exactly
    // as `listForSpeedMap` filters today.
    expect(page.data.map((row) => row.id)).toEqual(['comp-0']);
  });

  it('never presents an unhydrated trip as having an empty route', async () => {
    await create(0);

    // D2 has derived nothing, so the owner is not ready and the composition
    // must surface that state rather than a page of empty routes.
    const page = await queryTripGeometryPage({ limit: 10, status: 'completed' });

    expect(page.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.OWNER_NOT_READY);
    expect(page.data).toBeNull();
    expect(page.completeness).not.toBe(P7_COMPLETENESS.PARTIAL);
  });
});
