import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rescore = { calls: [] };
const storage = new Map();

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/rescoringQueue', () => ({
  enqueueRescoreJob: vi.fn(async (payload) => { rescore.calls.push(payload); return { accepted: true }; }),
}));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback),
  setJson: async (key, value) => { storage.set(key, structuredClone(value)); },
  removeJson: async (key) => { storage.delete(key); },
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import { composeP6CandidateEvidence } from '@/lib/p6RoadEvidence';
import {
  createP6AffectedTripSelectionRequest, finalizeP6BrowserExplicitTripBuild,
  stepP6AffectedTripSelection, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const LAT = 43.6532;
const LNG = -79.3832;
const CAPTURED_AT = 1_756_000_000_000;

const receiptFor = (tripId) => ({
  receiptId: `${tripId}:1:0`,
  tripId,
  sourceRevision: '1',
  observationOrdinal: 0,
  observedAt: CAPTURED_AT,
  membershipToken: `token-${tripId}`,
  sourceIdentity: `browser:${tripId}`,
  overlapKnown: true,
  scalars: {
    supportCount: 2, sampleCount: 30, limitVotes: { 50: 2 },
    agreementNumerator: 1.5, agreementDenominator: 2,
    confidenceNumerator: 1.2, confidenceDenominator: 2,
    timeBuckets: { day: 2 },
  },
});

const candidate = (tripIds) => ({
  id: 'shared-candidate',
  geohash: 'dpz800',
  limitKmh: 50,
  sampleCount: 60,
  supportCount: 4,
  confidence: 0.7,
  source: 'road_memory',
  observedAtMs: CAPTURED_AT,
  tripVotes: Object.fromEntries(tripIds.map((id) => [`browser:${id}`, 2])),
  tripVoteOrder: tripIds.map((id) => `browser:${id}`),
  recentObservations: tripIds.map((id) => ({ tripId: `browser:${id}`, lat: LAT, lng: LNG, at: CAPTURED_AT })),
  timeBuckets: { day: { tripVotes: Object.fromEntries(tripIds.map((id) => [`browser:${id}`, 2])) } },
  p6AutomaticEvidence: { frozenBaseline: [], receiptedEvidence: tripIds.map(receiptFor) },
});

const trip = (id) => ({
  id, status: 'completed',
  start_time: '2026-09-01T10:00:00.000Z',
  end_time: '2026-09-01T10:15:00.000Z',
  distance_km: 7, score_overall: 90, duration_seconds: 900,
  route_points: Array.from({ length: 64 }, (_, index) => ({
    lat: LAT + index * 0.00002, lng: LNG + index * 0.00002,
    timestamp: CAPTURED_AT + index * 1000, speed_kmh: 42, accuracy: 6,
  })),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V13: erasing an identity subtracts its learned support rather than
 * freezing it, removes every derived row and reference it owned, and cannot be
 * outrun by a build or a query that was already in flight.
 */
describe('P6-V13 browser identity erasure', () => {
  let indexedDb;
  let repository;

  beforeEach(async () => {
    rescore.calls = [];
    storage.clear();
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    vi.stubGlobal('localStorage', (() => {
      const local = new Map();
      return {
        getItem: (key) => (local.has(key) ? local.get(key) : null),
        setItem: (key, value) => { local.set(key, String(value)); },
        removeItem: (key) => { local.delete(key); },
        clear: () => local.clear(),
        key: (index) => [...local.keys()][index] ?? null,
        get length() { return local.size; },
      };
    })());
    repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    storage.set(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY, {
      version: 2, state: 'ACTIVE', stageId: 'erasure-initial', publicationVersion: 1,
    });
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'erasure-initial', publicationVersion: 1,
      });
    await repository.speedKnowledgeStore.setForGeohashes({
      cells: {}, corrections: [], excludedSections: [],
      roadMemory: { candidates: [candidate(['erased-trip', 'kept-trip'])] },
    }, ['dpz8']);
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);
  const derivedRowCount = (tripId) => [
    P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
    P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
    P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
    P6_TRIP_DERIVED_STORES.CONTRIBUTIONS,
  ].reduce((sum, name) => sum + rowsFor(name, tripId).length, 0);

  const drain = async () => {
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  const readCandidate = async () => {
    const model = await repository.speedKnowledgeStore.getForGeohashes(['dpz8']);
    return (model?.roadMemory?.candidates || []).find((item) => item.id === 'shared-candidate');
  };

  it('subtracts the erased identity instead of freezing it, and keeps the rest', async () => {
    await localTripRepository.create(trip('erased-trip'));
    await localTripRepository.create(trip('kept-trip'));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const before = composeP6CandidateEvidence({
      ...(await readCandidate()).p6AutomaticEvidence, now: CAPTURED_AT + 86_400_000,
    });
    expect(before.supportCount).toBe(4);
    expect(before.sampleCount).toBe(60);

    await localTripRepository.delete('erased-trip');
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const after = await readCandidate();
    // Erasure subtracts: the receipt is gone and no frozen share stands in for
    // it, which is exactly what retention FREEZE does instead.
    expect(after.p6AutomaticEvidence.frozenBaseline).toHaveLength(0);
    expect(after.p6AutomaticEvidence.receiptedEvidence.map((item) => item.tripId)).toEqual(['kept-trip']);
    const totals = composeP6CandidateEvidence({
      ...after.p6AutomaticEvidence, now: CAPTURED_AT + 86_400_000,
    });
    expect(totals.supportCount).toBe(2);
    expect(totals.sampleCount).toBe(30);
    expect(totals.limitVotes).toEqual({ 50: 2 });

    // Every reference to the erased identity is gone; the retained one stays.
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain('erased-trip');
    expect(serialized).toContain('kept-trip');
    expect(after.tripVotes['browser:kept-trip']).toBe(2);

    // And no derived row of the erased subject survives, while the retained
    // subject is untouched.
    expect(derivedRowCount('erased-trip')).toBe(0);
    expect(derivedRowCount('kept-trip')).toBeGreaterThan(0);
    expect(store(P6_TRIP_SOURCE_STORE).records.has('erased-trip')).toBe(false);
    expect(store(P6_TRIP_SOURCE_STORE).records.has('kept-trip')).toBe(true);
  }, 180_000);

  it('erases a subject whose build was still staging', async () => {
    await localTripRepository.create(trip('erased-trip'));
    // Two turns only: the contribution is published and geometry is mid-stage.
    await stepP6BrowserTripDerivedUpdate({ explicit: true });
    await stepP6BrowserTripDerivedUpdate({ explicit: true });
    expect(derivedRowCount('erased-trip')).toBeGreaterThan(0);
    expect(store(P6_TRIP_DERIVED_STORES.WORK).records.get('erased-trip').state)
      .not.toBe('COMPLETE');

    await localTripRepository.delete('erased-trip');
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    expect(derivedRowCount('erased-trip')).toBe(0);
    const after = await readCandidate();
    expect(JSON.stringify(after)).not.toContain('erased-trip');
  }, 180_000);

  it('does not queue a rescore for a subject erased while a query was in flight', async () => {
    await localTripRepository.create(trip('erased-trip'));
    await localTripRepository.create(trip('kept-trip'));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const { geohashEncode } = await import('@/lib/localSpeedKnowledge');
    const request = await createP6AffectedTripSelectionRequest({
      descriptors: [{ kind: 'cell', geohash: geohashEncode(LAT, LNG), lat: LAT, lng: LNG }],
      reason: 'speed_knowledge_rules_changed',
      knowledgeMetadata: { knowledgeRevision: 1, schemaVersion: 1 },
    });
    expect(request.accepted).toBe(true);

    // One turn reaches a candidate, then the identity is erased under it.
    await stepP6AffectedTripSelection();
    rescore.calls = [];
    await localTripRepository.delete('erased-trip');
    await drain();

    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6AffectedTripSelection();
      if (result.state === 'IDLE') break;
    }
    const queued = new Set(rescore.calls.flatMap((call) => call.tripIds || []));
    expect(queued.has('erased-trip')).toBe(false);
    expect(queued.has('kept-trip')).toBe(true);
  }, 180_000);
});
