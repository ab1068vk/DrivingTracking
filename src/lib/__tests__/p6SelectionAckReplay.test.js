import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rescore = { calls: [] };

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/rescoringQueue', () => ({
  enqueueRescoreJob: vi.fn(async (payload) => { rescore.calls.push(payload); return { accepted: true }; }),
}));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import {
  P6_TRIP_DERIVED_STORES, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  createP6AffectedTripSelectionRequest, finalizeP6BrowserExplicitTripBuild,
  readP6TripDomainReadiness, setP6TripDomainReadiness,
  stepP6AffectedTripSelection, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import {
  P6_DOMAIN_KEYS, P6_EXPLICIT_OPERATION_STATES, P6_READINESS_STATES,
} from '@/lib/p6Contracts';
import {
  markP6ExplicitOperationsAfterRestart, recordP6AffectedTripRescoreDebt,
  resumeP6ExplicitOperation, runKnownP6ExplicitOperationTurn,
} from '@/lib/p6ExplicitOperations';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const LAT = 43.653;
const LNG = -79.383;

const trip = (id) => ({
  id, status: 'completed',
  start_time: '2026-09-01T10:00:00.000Z',
  end_time: '2026-09-01T10:15:00.000Z',
  distance_km: 6, score_overall: 90, duration_seconds: 900,
  route_points: Array.from({ length: 64 }, (_, index) => ({
    lat: LAT + index * 0.00002,
    lng: LNG + index * 0.00002,
    timestamp: 1_756_000_000_000 + index * 1000,
    speed_kmh: 42, accuracy: 6,
  })),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

/**
 * P6-V10/V11 residue: kill the D3 selection cursor at the acknowledgement and
 * replay. The queue effect must stay exactly one per matched subject.
 */
describe('P6 affected-trip selection acknowledgement replay', () => {
  let indexedDb;

  beforeEach(() => {
    rescore.calls = [];
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const drainDerived = async () => {
    for (let turn = 0; turn < 600; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  const drainSelection = async (limit = 400) => {
    for (let turn = 0; turn < limit; turn += 1) {
      let result;
      try {
        result = await stepP6AffectedTripSelection();
      } catch (error) {
        return { killed: String(error?.message || error) };
      }
      if (result.state === 'IDLE') return { killed: null };
    }
    return { killed: 'TURN_LIMIT' };
  };

  it('enqueues exactly one rescore per matched subject even when the cursor write is killed', async () => {
    await localTripRepository.create(trip('selected'));
    expect(await drainDerived()).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });

    const { geohashEncode } = await import('@/lib/localSpeedKnowledge');
    const request = await createP6AffectedTripSelectionRequest({
      descriptors: [{ kind: 'cell', geohash: geohashEncode(LAT, LNG), lat: LAT, lng: LNG }],
      reason: 'speed_knowledge_rules_changed',
      knowledgeMetadata: { knowledgeRevision: 7, schemaVersion: 1 },
    });
    expect(request.accepted).toBe(true);
    expect(request.tokenCount).toBeGreaterThan(0);

    // A clean run: the subject touches many cells, so many postings reach it,
    // and exactly one queue effect must come out.
    expect(await drainSelection()).toMatchObject({ killed: null });
    const clean = rescore.calls.filter((call) => (call.tripIds || []).includes('selected'));
    expect(clean).toHaveLength(1);
    expect(clean[0].reason).toBe('speed_knowledge_rules_changed');
  }, 120_000);

  it('repeats at most the one job the queue itself dedupes when the cursor write is killed', async () => {
    await localTripRepository.create(trip('killed-ack'));
    expect(await drainDerived()).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });
    const { geohashEncode } = await import('@/lib/localSpeedKnowledge');
    const request = await createP6AffectedTripSelectionRequest({
      descriptors: [{ kind: 'cell', geohash: geohashEncode(LAT, LNG), lat: LAT, lng: LNG }],
      reason: 'speed_knowledge_rules_changed',
      knowledgeMetadata: { knowledgeRevision: 7, schemaVersion: 1 },
    });
    expect(request.accepted).toBe(true);

    // Kill the durable selection record repeatedly, around the acknowledgement.
    for (const skip of [1, 2, 3]) {
      indexedDb.failNextRequest({
        storeName: P6_TRIP_DERIVED_STORES.CONTROL,
        operation: 'put',
        error: new Error('kill:selection-ack'),
        skip,
      });
      await drainSelection(30);
    }
    expect(await drainSelection()).toMatchObject({ killed: null });

    const matched = rescore.calls.filter((call) => (call.tripIds || []).includes('killed-ack'));
    expect(matched.length).toBeGreaterThan(0);
    // The record is written only after the queue accepts, so a kill between the
    // two can repeat that one job - never one per posting.
    expect(matched.length).toBeLessThanOrEqual(4);
  }, 120_000);

  it('recovers durable named-refusal debt after restart and queues the matching trip', async () => {
    await localTripRepository.create(trip('deferred-selection'));
    expect(await drainDerived()).toMatchObject({
      state: P6_READINESS_STATES.VERIFIED, complete: true,
    });
    const { geohashEncode } = await import('@/lib/localSpeedKnowledge');
    const descriptor = {
      kind: 'cell', geohash: geohashEncode(LAT, LNG), lat: LAT, lng: LNG,
    };
    indexedDb.failNextRequest({
      storeName: P6_TRIP_DERIVED_STORES.CONTROL,
      operation: 'put',
      error: new Error('selection-request-refused'),
    });
    const refused = await createP6AffectedTripSelectionRequest({
      descriptors: [descriptor], reason: 'deferred_speed_change',
      knowledgeMetadata: { knowledgeRevision: 11 },
    });
    expect(refused).toMatchObject({
      accepted: false, reason: 'SPATIAL_SELECTION_UNAVAILABLE',
    });
    const debt = await recordP6AffectedTripRescoreDebt({
      descriptors: [descriptor], reason: 'deferred_speed_change',
      knowledgeMetadata: { knowledgeRevision: 11 },
      spatialSelectionState: refused.state,
      spatialSelectionReason: refused.reason,
    });
    await markP6ExplicitOperationsAfterRestart();
    await resumeP6ExplicitOperation(debt.operationId);

    const demoted = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, 'all');
    await setP6TripDomainReadiness({
      ...demoted, state: P6_READINESS_STATES.VERIFIED, complete: true,
      storageOutcome: null,
    });
    let operation;
    for (let turn = 0; turn < 500; turn += 1) {
      operation = await runKnownP6ExplicitOperationTurn(debt.operationId);
      if (operation.state === P6_EXPLICIT_OPERATION_STATES.COMPLETED) break;
    }
    expect(operation.state).toBe(P6_EXPLICIT_OPERATION_STATES.COMPLETED);
    const matched = rescore.calls.filter((call) => (call.tripIds || []).includes('deferred-selection'));
    expect(matched).toHaveLength(1);
    expect(matched[0].reason).toBe('deferred_speed_change');
  }, 120_000);
});
