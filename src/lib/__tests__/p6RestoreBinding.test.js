import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map();

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, readP6AchievementStats, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const trip = (id, { seed = 0, distance = 8, score = 88 } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: distance, score_overall: score, duration_seconds: 900,
  route_points: Array.from({ length: 48 }, (_, index) => ({
    lat: 43.6 + seed * 0.01 + index * 0.00022,
    lng: -79.4 - seed * 0.01 - index * 0.00019,
    timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
    speed_kmh: 44, accuracy: 6,
  })),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V14 browser half: a restore replaces canonical rows, and P6 must rebuild
 * against the new binding rather than carry anything across it. The derived
 * cache is never part of the backup, and a v1 write cannot slip past an E4
 * conversion that is already in flight.
 */
describe('P6-V14 browser restore binding', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);

  const drain = async () => {
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  it('never carries the derived cache into a backup', () => {
    // The backup format is the contract: no P6 derived store may appear in it,
    // so a restore can only ever produce a rebuild, never a resurrected cache.
    for (const path of ['src/lib/dataBackup.js', 'src/lib/dataBackupConstants.js']) {
      const source = readFileSync(path, 'utf8');
      for (const name of Object.values(P6_TRIP_DERIVED_STORES)) {
        expect(source.includes(name), `${path} references ${name}`).toBe(false);
      }
      expect(/p6[A-Z_]/.test(source), `${path} references a P6 symbol`).toBe(false);
    }
  });

  it('rebuilds against the new binding after a restore replaces the canonical rows', async () => {
    await localTripRepository.create(trip('restored', { seed: 0, distance: 8, score: 70 }));
    await localTripRepository.create(trip('untouched', { seed: 1, distance: 4, score: 80 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const beforeRevision = String(store(P6_TRIP_SOURCE_STORE).records.get('restored').source_revision);
    const beforeVersions = new Set(rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'restored')
      .map((row) => row.contentVersion));
    expect(beforeVersions.size).toBe(1);
    const before = await readP6AchievementStats({ now: Date.parse('2026-09-05T00:00:00Z') });
    expect(before.totalKm).toBeCloseTo(12, 9);

    // A restore rewrites the canonical row with different content under the
    // same identity, exactly as importing a backup does.
    await localTripRepository.create(trip('restored', { seed: 0, distance: 25, score: 96 }));
    const afterRevision = String(store(P6_TRIP_SOURCE_STORE).records.get('restored').source_revision);
    expect(afterRevision).not.toBe(beforeRevision);
    // The head is revoked immediately, so nothing serves the pre-restore state.
    await expect(readP6AchievementStats({ now: Date.parse('2026-09-05T00:00:00Z') })).resolves.toBeNull();

    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const afterVersions = new Set(rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'restored')
      .map((row) => row.contentVersion));
    expect(afterVersions.size).toBe(1);
    for (const version of beforeVersions) expect(afterVersions.has(version)).toBe(false);
    expect([...afterVersions][0]).toContain(afterRevision);

    const after = await readP6AchievementStats({ now: Date.parse('2026-09-05T00:00:00Z') });
    expect(after.completedCount).toBe(2);
    expect(after.totalKm).toBeCloseTo(29, 9);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'restored')).toHaveLength(1);
  }, 180_000);

  it('blocks a v1 saved-speed write while an E4 conversion is in flight', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    const model = (id, knowledgeRevision) => ({
      schemaVersion: 1, knowledgeRevision, cells: {},
      corrections: [{ id, geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
      excludedSections: [], roadMemory: { candidates: [] },
    });
    await repository.speedKnowledgeStore.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, model('before-e4', 3));
    const knowledge = indexedDb.getStoreState(
      repository.SPEED_KNOWLEDGE_DB_NAME, 'knowledge',
    ).records.get(repository.SPEED_KNOWLEDGE_STORAGE_KEY);

    expect(await repository.beginP6BrowserSpeedMigration())
      .toMatchObject({ state: 'CONVERSION_IN_PROGRESS' });

    // The v1 record the conversion fenced is byte-identical afterwards: the
    // concurrent write cannot move the predecessor under the fence.
    await repository.speedKnowledgeStore.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, model('during-e4', 4));
    const afterWrite = indexedDb.getStoreState(
      repository.SPEED_KNOWLEDGE_DB_NAME, 'knowledge',
    ).records.get(repository.SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(afterWrite.value).toEqual(knowledge.value);
    // v1 is still the authority, and the newer write is not lost: it is held in
    // the write-ahead record the fence could not touch.
    expect((await repository.readP6BrowserSpeedAuthority()).version).toBe(1);
    await expect(repository.speedKnowledgeStore.get()).resolves.toMatchObject({
      corrections: [expect.objectContaining({ id: 'during-e4' })],
    });
  }, 120_000);
});
