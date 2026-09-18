import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
// Durable storage across the simulated process death: the payload key lives
// here, so a module reset must not take it with it.
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback),
  setJson: async (key, value) => { storage.set(key, structuredClone(value)); },
  removeJson: async (key) => { storage.delete(key); },
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = 96 } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: 8, score_overall: 88, duration_seconds: 900,
  route_points: route(seed, points),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V09: one shared extraction pass feeds D2, D3 and D4; work added behind the
 * cursor still converges; and a restart resumes rather than replaying history.
 */
describe('P6-V09 browser shared extraction and cursor progress', () => {
  const indexedDb = new FakeIndexedDb();

  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDb.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('P6_TEST_DATABASE_DELETE_BLOCKED'));
    });
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);

  const drain = async (limit = 800) => {
    let turns = 0;
    for (; turns < limit; turns += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return { turns, final: await finalizeP6BrowserExplicitTripBuild(false) };
  };

  it('feeds D2, D3 and D4 from one extraction of each source page', async () => {
    await localTripRepository.create(trip('shared', { points: 256 }));
    expect((await drain()).final).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });

    // 256 points at 128 per page is two published pages, plus the bounded
    // preview chunk. Every domain sees the same pages: one geometry chunk, one
    // shared road spill and at least one posting per page.
    const chunks = rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'shared');
    const spills = rowsFor(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, 'shared');
    const postings = rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'shared');
    const pageOrdinals = spills.map((row) => row.ordinal).sort((left, right) => left - right);
    expect(pageOrdinals).toEqual([0, 1]);
    expect(chunks.filter((row) => row.ordinal >= 0).map((row) => row.ordinal).sort()).toEqual([0, 1]);
    expect(chunks.some((row) => row.ordinal === -1)).toBe(true);
    expect(spills.reduce((sum, row) => sum + Number(row.pointCount || 0), 0)).toBe(256);
    expect(new Set(postings.map((row) => row.blockOrdinal))).toEqual(new Set([0, 1]));
    // The shared spill starts where the previous page ended: the pass is one
    // sweep of the source, not a re-read per domain.
    expect(spills.map((row) => row.pointStartOrdinal).sort((left, right) => left - right))
      .toEqual([0, 128]);
  }, 120_000);

  it('converges work queued behind the cursor during a drain', async () => {
    for (let index = 0; index < 4; index += 1) {
      await localTripRepository.create(trip(`ahead-${index}`, { seed: index, points: 64 }));
    }
    // Partially drain, then add a subject whose marker sorts behind the cursor
    // the drain is already past.
    for (let turn = 0; turn < 6; turn += 1) await stepP6BrowserTripDerivedUpdate({ explicit: true });
    await localTripRepository.create(trip('behind-cursor', { seed: 9, points: 64 }));

    const { final } = await drain();
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    for (const id of ['ahead-0', 'ahead-1', 'ahead-2', 'ahead-3', 'behind-cursor']) {
      expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get(id).state).toBe('COMPLETE');
      expect(rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, id).length).toBeGreaterThan(0);
    }
  }, 120_000);

  it('resumes a partial build from its durable cursor instead of replaying history', async () => {
    await localTripRepository.create(trip('resume-me', { points: 512 }));
    let turns = 0;
    for (; turns < 4; turns += 1) await stepP6BrowserTripDerivedUpdate({ explicit: true });
    const midway = store(P6_TRIP_DERIVED_STORES.WORK).records.get('resume-me');
    expect(midway.state).not.toBe('COMPLETE');
    const publishedBefore = rowsFor(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, 'resume-me').length;
    expect(publishedBefore).toBeGreaterThan(0);

    // Process death: module state is discarded, only the durable cursor remains.
    vi.resetModules();
    const derived = await import('@/lib/p6TripDerivedState');
    let resumed = 0;
    for (; resumed < 800; resumed += 1) {
      const result = await derived.stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    expect(await derived.finalizeP6BrowserExplicitTripBuild(false)).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });

    // Exactly four published source pages for 512 points: the resume continued
    // the sweep rather than restarting it, so no page was published twice.
    const spills = rowsFor(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, 'resume-me');
    expect(spills.map((row) => row.ordinal).sort((left, right) => left - right)).toEqual([0, 1, 2, 3]);
    expect(spills.reduce((sum, row) => sum + Number(row.pointCount || 0), 0)).toBe(512);
    expect(new Set(spills.map((row) => row.pointStartOrdinal))).toEqual(new Set([0, 128, 256, 384]));
  }, 120_000);
});
