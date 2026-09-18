import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { value: {} };
const storage = new Map();

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => settings.value } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
// A real in-memory backend: the privacy audit fence writes and then reads its
// own record back, so a no-op stub would look like unavailable storage.
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, TRIP_SCHEMA_VERSION,
  localTripRepository, runLegacyBrowserRawGpsRetention, stepRawGpsRetention,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import { composeP6CandidateEvidence } from '@/lib/p6RoadEvidence';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const TRIP_ID = 'retention-frozen';
const SOURCE_IDENTITY = `browser:${TRIP_ID}`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const CAPTURED_AT = NOW - 40 * DAY;

const receipt = {
  receiptId: `${TRIP_ID}:1:0`,
  tripId: TRIP_ID,
  sourceRevision: '1',
  observationOrdinal: 0,
  observedAt: CAPTURED_AT,
  membershipToken: 'membership-token-1',
  sourceIdentity: SOURCE_IDENTITY,
  overlapKnown: true,
  scalars: {
    supportCount: 3,
    sampleCount: 41,
    limitVotes: { 50: 3 },
    agreementNumerator: 2.5,
    agreementDenominator: 3,
    confidenceNumerator: 1.8,
    confidenceDenominator: 3,
    timeBuckets: { day: 3 },
  },
};

const candidate = {
  id: 'frozen-candidate',
  geohash: 'dpz800',
  limitKmh: 50,
  sampleCount: 41,
  supportCount: 3,
  confidence: 0.6,
  source: 'road_memory',
  observedAtMs: CAPTURED_AT,
  tripVotes: { [SOURCE_IDENTITY]: 3 },
  tripVoteOrder: [SOURCE_IDENTITY],
  recentObservations: [{ tripId: SOURCE_IDENTITY, lat: 43.651, lng: -79.381, at: CAPTURED_AT }],
  timeBuckets: { day: { tripVotes: { [SOURCE_IDENTITY]: 3 } } },
  p6AutomaticEvidence: { frozenBaseline: [], receiptedEvidence: [receipt] },
};

const trip = {
  id: TRIP_ID,
  status: 'completed',
  start_time: new Date(CAPTURED_AT).toISOString(),
  end_time: new Date(CAPTURED_AT + 900_000).toISOString(),
  distance_km: 9,
  score_overall: 88,
  duration_seconds: 900,
  schema_version: TRIP_SCHEMA_VERSION,
  score_version: SCORING_VERSION,
  needs_rescore: false,
  defensive_driving_score: 90,
  brake_onset_sequence_count: 0,
  heading_deviation_available: true,
  heading_drift_beta_available: true,
  braking_efficiency_grade: 'smooth',
  overall_compliance_score: 95,
  dominant_road_type: 'urban',
  co2_saved_kg: 0.4,
  phone_use_score: 100,
  phone_use_risk: 'none',
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  // Large enough that the canonical writer spools it through the browser RSAS
  // segments, which is the path raw-GPS retention actually purges.
  route_points: Array.from({ length: 400 }, (_, index) => ({
    lat: 43.651 + index * 0.00022,
    lng: -79.381 - index * 0.00019,
    timestamp: CAPTURED_AT + index * 1000,
    speed_kmh: 47,
    accuracy: 6,
  })),
};

/**
 * P6-V06: real browser raw-GPS retention over a learned road-memory candidate.
 * FREEZE has to keep every learned scalar and the operational state while the
 * expired coordinates, timestamps and trip identity become unreachable.
 */
describe('P6-V06 retention FREEZE keeps learned support and drops identity', () => {
  let indexedDb;
  let repository;

  beforeEach(async () => {
    settings.value = { raw_gps_retention_days: 7 };
    storage.clear();
    // The privacy audit fence is a localStorage record on the web.
    const local = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key) => (local.has(key) ? local.get(key) : null),
      setItem: (key, value) => { local.set(key, String(value)); },
      removeItem: (key) => { local.delete(key); },
      clear: () => local.clear(),
      key: (index) => [...local.keys()][index] ?? null,
      get length() { return local.size; },
    });
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      // A granted lock, as the Web Locks API hands to its callback.
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    // Browser v2 authority, the state in which P6 evidence exists at all.
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'freeze-initial', publicationVersion: 1,
      });
    await repository.speedKnowledgeStore.setForGeohashes({
      cells: {}, corrections: [], excludedSections: [],
      roadMemory: { candidates: [structuredClone(candidate)] },
    }, ['dpz8']);
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  /**
   * Routine lifecycle never decrypts a predecessor inline route: it reports the
   * record as legacy raw-GPS debt and defers to the explicit one-record
   * compatibility operation, which is the path Settings runs.
   */
  const expireRetainedRoute = async () => {
    const routine = await stepRawGpsRetention({ now: NOW, force: true });
    expect(routine).toMatchObject({ legacyRawGpsDebt: true, legacyTripId: TRIP_ID, processed: 0 });
    return runLegacyBrowserRawGpsRetention({ tripId: TRIP_ID, retentionDays: 7, now: NOW });
  };

  const readCandidate = async () => {
    const model = await repository.speedKnowledgeStore.getForGeohashes(['dpz8']);
    return (model?.roadMemory?.candidates || []).find((item) => item.id === 'frozen-candidate');
  };

  it('preserves every learned scalar while the trip identity becomes unreachable', async () => {
    await localTripRepository.create(structuredClone(trip));
    const before = await readCandidate();
    expect(before.p6AutomaticEvidence.receiptedEvidence).toHaveLength(1);
    const beforeTotals = composeP6CandidateEvidence({
      ...before.p6AutomaticEvidence, now: NOW,
    });

    const outcome = await expireRetainedRoute();
    expect(outcome).toMatchObject({ state: 'COMPLETE' });

    // The canonical route is gone.
    const stored = indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.get(TRIP_ID);
    expect(stored.route_data_expired_at).toBeTruthy();
    expect(stored.route_points == null || stored.route_points.length === 0).toBe(true);

    const after = await readCandidate();
    expect(after).toBeTruthy();
    // The receipt is frozen, not dropped: the learned totals are identical.
    expect(after.p6AutomaticEvidence.receiptedEvidence).toHaveLength(0);
    expect(after.p6AutomaticEvidence.frozenBaseline).toHaveLength(1);
    const afterTotals = composeP6CandidateEvidence({ ...after.p6AutomaticEvidence, now: NOW });
    expect(afterTotals.supportCount).toBe(beforeTotals.supportCount);
    expect(afterTotals.sampleCount).toBe(beforeTotals.sampleCount);
    expect(afterTotals.limitVotes).toEqual(beforeTotals.limitVotes);
    expect(afterTotals.timeBuckets).toEqual(beforeTotals.timeBuckets);
    expect(afterTotals.agreementNumerator).toBeCloseTo(beforeTotals.agreementNumerator, 9);
    expect(afterTotals.agreementDenominator).toBeCloseTo(beforeTotals.agreementDenominator, 9);
    expect(afterTotals.confidenceNumerator).toBeCloseTo(beforeTotals.confidenceNumerator, 9);
    expect(afterTotals.confidenceDenominator).toBeCloseTo(beforeTotals.confidenceDenominator, 9);

    // The frozen share carries the operational state and nothing that could
    // name the trip, its revision, its ordinal, its time or its geometry.
    const [share] = after.p6AutomaticEvidence.frozenBaseline;
    expect(share.frozen).toBe(true);
    expect(typeof share.operationalAtFreeze).toBe('boolean');
    expect(Object.keys(share).sort()).toEqual(
      ['algorithmVersion', 'frozen', 'membershipToken', 'operationalAtFreeze', 'scalars'],
    );
    const serialized = JSON.stringify(after);
    expect(serialized).not.toContain(TRIP_ID);
    // The frozen evidence itself carries no time at all, and no captured point
    // time survives anywhere on the candidate.
    expect(JSON.stringify(after.p6AutomaticEvidence)).not.toContain(String(CAPTURED_AT));
    for (const index of [1, 2, 17, 399]) {
      expect(serialized).not.toContain(String(CAPTURED_AT + index * 1000));
    }
    // Learned recency survives: it is operational state, not a retained capture
    // timestamp, and the decay and freshness of the candidate depend on it.
    expect(after.observedAtMs).toBe(CAPTURED_AT);
    expect(after.tripVotes?.[SOURCE_IDENTITY]).toBeUndefined();
    expect(after.tripVoteOrder || []).not.toContain(SOURCE_IDENTITY);
    expect((after.recentObservations || []).some((row) => String(row?.tripId) === SOURCE_IDENTITY)).toBe(false);
    expect(JSON.stringify(after.timeBuckets || {})).not.toContain(TRIP_ID);
  }, 120_000);

  it('keeps the expired coordinates out of every P6 and export surface', async () => {
    await localTripRepository.create(structuredClone(trip));
    expect(await expireRetainedRoute()).toMatchObject({ state: 'COMPLETE' });

    const derived = await import('@/lib/p6TripDerivedState');
    for (let turn = 0; turn < 400; turn += 1) {
      const result = await derived.stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    await derived.finalizeP6BrowserExplicitTripBuild(false);

    // P6 surface: no public geometry survives for an expired trip.
    const geometry = [...indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS)
      .records.values()].filter((row) => String(row.tripId) === TRIP_ID);
    expect(JSON.stringify(geometry)).not.toContain('43.651');
    const preview = await derived.queryP6GeometryPreviewPage({ maxTrips: 40 });
    expect(JSON.stringify(preview.items || [])).not.toContain('43.651');

    // Speed cache and export surfaces: the learned candidate is still there, and
    // still carries no coordinate or identity from the expired trip.
    const { LocalSpeedKnowledge } = await import('@/lib/localSpeedKnowledge');
    const knowledge = new LocalSpeedKnowledge(repository.speedKnowledgeStore);
    const exported = await knowledge.exportDataForPoints([{ lat: 43.651, lng: -79.381 }]);
    const exportedCandidates = exported?.roadMemory?.candidates || [];
    expect(exportedCandidates.some((item) => item.id === 'frozen-candidate')).toBe(true);
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain(TRIP_ID);
    for (const index of [1, 2, 17, 399]) {
      expect(serialized).not.toContain(String(CAPTURED_AT + index * 1000));
    }
    expect(serialized).not.toContain('43.65122');
  }, 120_000);

  it('keeps one retention turn bounded when one trip has evidence in more than one page of buckets', async () => {
    await localTripRepository.create(structuredClone(trip));
    const bucketIds = Array.from({ length: 55 }, (_, index) => `b${String(index).padStart(3, '0')}`);
    const candidates = bucketIds.map((bucketId, index) => ({
      ...structuredClone(candidate),
      id: `bounded-${index}`,
      geohash: `${bucketId}00`,
      p6AutomaticEvidence: {
        frozenBaseline: [],
        receiptedEvidence: [{
          ...structuredClone(receipt),
          receiptId: `${TRIP_ID}:1:${index}`,
          observationOrdinal: index,
          membershipToken: `membership-token-${index}`,
        }],
      },
    }));
    await repository.speedKnowledgeStore.setForGeohashes({
      cells: {}, corrections: [], excludedSections: [], roadMemory: { candidates },
    }, bucketIds);

    const transactionsBefore = indexedDb.transactionCount;
    const first = await runLegacyBrowserRawGpsRetention({
      tripId: TRIP_ID, retentionDays: 7, now: NOW,
    });
    expect(first).toMatchObject({ state: 'P6_FREEZE_PARTIAL', hasMore: true });
    expect(first.itemsWorked).toBeLessThanOrEqual(100);
    expect(indexedDb.transactionCount - transactionsBefore).toBeLessThanOrEqual(110);
    expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.get(TRIP_ID)
      .route_data_expired_at).toBeFalsy();

    const second = await runLegacyBrowserRawGpsRetention({
      tripId: TRIP_ID, retentionDays: 7, now: NOW,
    });
    expect(second).toMatchObject({ state: 'COMPLETE' });
    expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.get(TRIP_ID)
      .route_data_expired_at).toBeTruthy();
  }, 120_000);
});
