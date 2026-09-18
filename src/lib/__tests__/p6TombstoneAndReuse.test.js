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
  finalizeP6BrowserExplicitTripBuild, queryP6GeometryPreviewPage, readP6AchievementStats,
  readP6TripDomainReadiness, setP6TripDomainReadiness, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = 48, score = 88, distance = 8 } = {}) => ({
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

/** P6-V05: tombstone, absent source, identity reuse and recent-window refill. */
describe('P6-V05 browser tombstone, reuse and refill', () => {
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
    for (let turn = 0; turn < 800; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  const derivedRowCount = (tripId) => [
    P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
    P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
    P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
    P6_TRIP_DERIVED_STORES.CONTRIBUTIONS,
    P6_TRIP_DERIVED_STORES.RECENT_ORDER,
  ].reduce((sum, name) => sum + rowsFor(name, tripId).length, 0);

  it('subtracts a deleted trip exactly and leaves no derived residue or stale preview', async () => {
    await localTripRepository.create(trip('keep', { seed: 0, distance: 10, score: 92 }));
    await localTripRepository.create(trip('remove', { seed: 1, distance: 6, score: 70 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const before = await readP6AchievementStats({ now: Date.parse('2026-09-05T12:00:00Z') });
    expect(before.completedCount).toBe(2);
    expect(before.totalKm).toBeCloseTo(16, 9);
    expect(derivedRowCount('remove')).toBeGreaterThan(0);

    await localTripRepository.delete('remove');
    expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get('remove').disposition).toBe('TOMBSTONE');
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const after = await readP6AchievementStats({ now: Date.parse('2026-09-05T12:00:00Z') });
    expect(after.completedCount).toBe(1);
    expect(after.totalKm).toBeCloseTo(10, 9);
    expect(after.avgScore).toBeCloseTo(92, 9);
    // Exact subtraction, not a rebuild: the surviving trip is untouched.
    expect(store(P6_TRIP_SOURCE_STORE).records.has('keep')).toBe(true);
    expect(derivedRowCount('remove')).toBe(0);

    // No stale negative result: the removed subject is not offered by the
    // bounded D2 preview reader either.
    const preview = await queryP6GeometryPreviewPage({ maxTrips: 40 });
    expect(preview.items.map((item) => item.id)).not.toContain('remove');
    expect(preview.items.map((item) => item.id)).toContain('keep');
  }, 120_000);

  it('rebuilds from scratch when a deleted identity is reused', async () => {
    await localTripRepository.create(trip('reused-id', { seed: 0, distance: 5, score: 60 }));
    await drain();
    const firstChunks = rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'reused-id')
      .map((row) => row.contentVersion);
    expect(firstChunks.length).toBeGreaterThan(0);

    await localTripRepository.delete('reused-id');
    await drain();
    expect(derivedRowCount('reused-id')).toBe(0);

    // The same identity comes back as a different trip.
    await localTripRepository.create(trip('reused-id', { seed: 4, points: 96, distance: 21, score: 99 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const secondChunks = rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'reused-id')
      .map((row) => row.contentVersion);
    expect(secondChunks.length).toBeGreaterThan(0);
    for (const version of secondChunks) expect(firstChunks).not.toContain(version);

    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-10T12:00:00Z') });
    expect(stats.completedCount).toBe(1);
    expect(stats.totalKm).toBeCloseTo(21, 9);
    expect(stats.avgScore).toBeCloseTo(99, 9);
  }, 120_000);

  it('refills the recent window when one of the newest five is deleted', async () => {
    for (let index = 0; index < 8; index += 1) {
      await localTripRepository.create(trip(`recent-${index}`, {
        seed: index, distance: 10, score: 60 + index * 5,
      }));
    }
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const before = await readP6AchievementStats({ now: Date.parse('2026-09-20T12:00:00Z') });
    expect(before.recentFiveCount).toBe(5);
    // Newest five are seeds 7..3, all with equal distance, so the mean is theirs.
    expect(before.recentFiveAvg).toBeCloseTo((95 + 90 + 85 + 80 + 75) / 5, 9);

    await localTripRepository.delete('recent-7');
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const after = await readP6AchievementStats({ now: Date.parse('2026-09-20T12:00:00Z') });
    expect(after.completedCount).toBe(7);
    // The window is replenished from the retained history rather than shrinking.
    expect(after.recentFiveCount).toBe(5);
    expect(after.recentFiveAvg).toBeCloseTo((90 + 85 + 80 + 75 + 70) / 5, 9);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.RECENT_ORDER, 'recent-7')).toEqual([]);
  }, 180_000);

  it('never mistakes a failed source read for a deletion', async () => {
    await localTripRepository.create(trip('unreadable', { seed: 3 }));
    await drain();
    const derivedBefore = derivedRowCount('unreadable');
    expect(derivedBefore).toBeGreaterThan(0);

    // The canonical row is present but cannot be read: a decrypt, quota or IO
    // failure, not a deletion.
    const marker = store(P6_TRIP_DERIVED_STORES.WORK).records.get('unreadable');
    store(P6_TRIP_DERIVED_STORES.WORK).records.set('unreadable', {
      ...marker, state: 'DIRTY', cursor: null,
    });
    vi.spyOn(localTripRepository, 'getFullById').mockRejectedValue(new Error('payload unreadable'));

    const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
    expect(result.state).toBe('SOURCE_READ_FAILED');
    // Nothing was erased, and no head claims the subject is current.
    expect(derivedRowCount('unreadable')).toBe(derivedBefore);
    expect(store(P6_TRIP_SOURCE_STORE).records.has('unreadable')).toBe(true);
    expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get('unreadable').state).toBe('SOURCE_UNREADABLE');
    for (const domain of Object.values(P6_DOMAIN_KEYS)) {
      expect(store(P6_TRIP_DERIVED_STORES.MANIFESTS).records.get(`${domain}:unreadable`)).toMatchObject({
        state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false, reason: 'SOURCE_READ_FAILED',
      });
    }
    // The unreadable subject itself is the only outstanding work. It must keep
    // every covered domain unverified; no unrelated DIRTY row is allowed to
    // mask this assertion.
    vi.restoreAllMocks();
    expect(await finalizeP6BrowserExplicitTripBuild(false)).toMatchObject({
      state: P6_READINESS_STATES.PARTIAL, complete: false,
    });
    expect(await finalizeP6BrowserExplicitTripBuild(true)).toMatchObject({
      state: P6_READINESS_STATES.PARTIAL, complete: false,
    });
    for (const domain of Object.values(P6_DOMAIN_KEYS)) {
      expect(store(P6_TRIP_DERIVED_STORES.MANIFESTS).records.get(`${domain}:all`)).not.toMatchObject({
        state: P6_READINESS_STATES.VERIFIED, complete: true,
      });
    }
    await expect(readP6AchievementStats({ now: Date.parse('2026-09-05T12:00:00Z') }))
      .resolves.toBeNull();
  }, 120_000);

  it('does not let an E1-owned D1/D2 finalization re-verify a demoted D3 head', async () => {
    await localTripRepository.create(trip('domain-owner', { seed: 6 }));
    await drain();
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.SPATIAL_SELECTION, subject: 'all', sourceBinding: 'browser',
      state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false, reason: 'D3_ONLY_DEMOTION',
    });
    for (const domain of [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY]) {
      await setP6TripDomainReadiness({
        domain, subject: 'all', sourceBinding: 'browser',
        state: P6_READINESS_STATES.DIRTY, complete: false,
      });
    }
    await expect(finalizeP6BrowserExplicitTripBuild({
      includeRoad: false, domains: [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY],
    })).resolves.toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    await expect(readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, 'all'))
      .resolves.toMatchObject({ state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false });
  }, 120_000);

  it('treats a marker whose canonical source is absent as a tombstone', async () => {
    await localTripRepository.create(trip('absent-source', { seed: 2 }));
    await drain();
    expect(derivedRowCount('absent-source')).toBeGreaterThan(0);

    // The canonical row disappears without the owner writing a tombstone: a
    // torn delete, or a restore that dropped it. The marker must still converge.
    store(P6_TRIP_SOURCE_STORE).records.delete('absent-source');
    const marker = store(P6_TRIP_DERIVED_STORES.WORK).records.get('absent-source');
    store(P6_TRIP_DERIVED_STORES.WORK).records.set('absent-source', {
      ...marker, state: 'DIRTY', cursor: null,
    });

    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    expect(derivedRowCount('absent-source')).toBe(0);
    expect(store(P6_TRIP_DERIVED_STORES.MANIFESTS).records
      .get(`${P6_DOMAIN_KEYS.ANALYTICS}:absent-source`)).toMatchObject({
      reason: 'SOURCE_TOMBSTONED',
    });
    const stats = await readP6AchievementStats({ now: Date.parse('2026-09-05T12:00:00Z') });
    expect(stats.completedCount).toBe(0);
  }, 120_000);
});
