import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, readP6AchievementStats, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';
import { observeDatabaseBytes } from './helpers/p6DurableObserver';

const DERIVED_STORES = Object.values(P6_TRIP_DERIVED_STORES);

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

// A fully scored completed trip. The repository re-scores and re-persists a
// trip whose scored fields are still absent, so a fixture that left them null
// would be rewritten by its own reader and never converge.
const trip = (id, { seed = 0, points = 96, score = 88, distance = 8 } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: distance, score_overall: score, duration_seconds: 900,
  route_points: route(seed, points),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V04: replacement, supersede, score-only change, manual edit and split.
 * Every write here goes through the canonical owner, so the debt, the revision
 * binding and the replacement are the production ones.
 */
describe('P6-V04 browser replacement matrix', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_name, _options, operation) => operation() },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);

  const drain = async () => {
    for (let turn = 0; turn < 600; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  const contentVersions = (tripId) => new Set(
    rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, tripId).map((row) => row.contentVersion),
  );

  it('replaces in place on a score-only edit and never accumulates a superseded version', async () => {
    const created = await localTripRepository.create(trip('replace-me', { score: 80 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const firstRevision = store(P6_TRIP_SOURCE_STORE).records.get('replace-me').source_revision;
    const firstVersions = contentVersions('replace-me');
    const firstBytes = observeDatabaseBytes(indexedDb, DB_NAME, DERIVED_STORES).bytes;
    expect(firstVersions.size).toBe(1);

    // Score-only: the route is byte-identical, only the derived-from-score
    // fields move.
    await localTripRepository.update(created.id, { score_overall: 96 });
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const secondRevision = store(P6_TRIP_SOURCE_STORE).records.get('replace-me').source_revision;
    expect(secondRevision).not.toBe(firstRevision);

    // Exactly one current contribution, bound to the revision that was committed.
    const contributions = rowsFor(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'replace-me');
    expect(contributions).toHaveLength(1);
    expect(String(contributions[0].sourceRevision)).toBe(String(secondRevision));

    // Exactly one current derived content version: the superseded one is gone,
    // not left behind for reclamation to find later.
    const secondVersions = contentVersions('replace-me');
    expect(secondVersions.size).toBe(1);
    for (const version of firstVersions) expect(secondVersions.has(version)).toBe(false);
    for (const name of [P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS]) {
      const revisions = new Set(rowsFor(name, 'replace-me').map((row) => String(row.sourceRevision)));
      expect([...revisions]).toEqual([String(secondRevision)]);
    }

    // No relearning loop: replacement is replacement, so a second identical-geometry
    // revision cannot grow the durable footprint materially.
    const secondBytes = observeDatabaseBytes(indexedDb, DB_NAME, DERIVED_STORES).bytes;
    expect(secondBytes).toBeLessThan(firstBytes * 1.2);

    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-01T12:00:00Z') });
    expect(stats.completedCount).toBe(1);
    expect(stats.excellentScoreTrips).toBe(1);
    expect(stats.highScoreTrips).toBe(1);
  }, 120_000);

  it('relearns geometry when a manual edit really changes the route', async () => {
    const created = await localTripRepository.create(trip('manual-edit', { points: 64 }));
    await drain();
    const before = {
      versions: contentVersions('manual-edit'),
      postings: rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'manual-edit').length,
    };

    await localTripRepository.update(created.id, { route_points: route(5, 192) });
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const after = contentVersions('manual-edit');
    expect(after.size).toBe(1);
    for (const version of before.versions) expect(after.has(version)).toBe(false);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'manual-edit').length)
      .toBeGreaterThan(before.postings);
  }, 120_000);

  it('splits one trip into two current subjects and retires the original', async () => {
    await localTripRepository.create(trip('split-source', { seed: 1, points: 128, distance: 12 }));
    await drain();
    expect(contentVersions('split-source').size).toBe(1);

    await localTripRepository.create(trip('split-a', { seed: 1, points: 64, distance: 6 }));
    await localTripRepository.create(trip('split-b', { seed: 2, points: 64, distance: 6 }));
    await localTripRepository.delete('split-source');
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    for (const id of ['split-a', 'split-b']) {
      expect(contentVersions(id).size).toBe(1);
      expect(rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, id).length).toBeGreaterThan(0);
    }
    // The retired subject keeps no derived content, and its heads say so.
    for (const name of [P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
      P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
      P6_TRIP_DERIVED_STORES.CONTRIBUTIONS]) {
      expect(rowsFor(name, 'split-source')).toEqual([]);
    }
    const manifests = store(P6_TRIP_DERIVED_STORES.MANIFESTS);
    expect(manifests.records.get(`${P6_DOMAIN_KEYS.ANALYTICS}:split-source`)).toMatchObject({
      reason: 'SOURCE_TOMBSTONED', complete: true,
    });

    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-05T12:00:00Z') });
    expect(stats.completedCount).toBe(2);
    expect(stats.totalKm).toBeCloseTo(12, 9);
  }, 120_000);

  it('rejects a publication whose source moved under it', async () => {
    const created = await localTripRepository.create(trip('stale-publish', { points: 64 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const first = String(store(P6_TRIP_SOURCE_STORE).records.get('stale-publish').source_revision);

    await localTripRepository.update(created.id, { distance_km: 44 });
    const second = String(store(P6_TRIP_SOURCE_STORE).records.get('stale-publish').source_revision);
    expect(second).not.toBe(first);

    // A marker whose source already moved on - a replayed or late notification -
    // must publish nothing rather than write derived state for a revision the
    // canonical owner no longer holds.
    const marker = store(P6_TRIP_DERIVED_STORES.WORK).records.get('stale-publish');
    store(P6_TRIP_DERIVED_STORES.WORK).records.set('stale-publish', {
      ...marker, desiredRevision: first, state: 'DIRTY', cursor: null,
    });
    const before = {
      contributions: rowsFor(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'stale-publish')
        .map((row) => row.revisionToken),
      chunks: rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'stale-publish').length,
    };
    const stale = await stepP6BrowserTripDerivedUpdate({ explicit: true });
    expect(stale.state).toBe('STALE_SOURCE');
    // Nothing moved: the refusal is a refusal, not a partial publication.
    expect(rowsFor(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'stale-publish')
      .map((row) => row.revisionToken)).toEqual(before.contributions);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'stale-publish')).toHaveLength(before.chunks);

    // The correct marker converges to the revision the owner actually holds.
    store(P6_TRIP_DERIVED_STORES.WORK).records.set('stale-publish', {
      ...marker, desiredRevision: second, state: 'DIRTY', cursor: null,
    });
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const versions = contentVersions('stale-publish');
    expect(versions.size).toBe(1);
    expect([...versions][0]).toContain(second);
    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-01T12:00:00Z') });
    expect(stats.totalKm).toBeCloseTo(44, 9);
  }, 120_000);
});
