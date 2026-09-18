import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeIndexedDb';

vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: () => 'web',
  isAndroid: () => false,
  isNativePlatform: () => false,
}));

const { memoryStore, P6_EXPLICIT_OPERATION_STATE_KEY } = vi.hoisted(() => ({
  memoryStore: new Map(),
  P6_EXPLICIT_OPERATION_STATE_KEY: 'drivesense_p6_explicit_operations_v1',
}));

// Explicit operations are durable records, so criterion 5's E2 arm needs a
// storage mock that actually remembers what the production runner wrote.
vi.mock('@/lib/mobileStorage', async (importOriginal) => ({
  ...(await importOriginal()),
  getJson: vi.fn(async (key) => (memoryStore.has(key) ? structuredClone(memoryStore.get(key)) : null)),
  setJson: vi.fn(async (key, value) => {
    if (key === P6_EXPLICIT_OPERATION_STATE_KEY) memoryStore.set(key, structuredClone(value));
  }),
  removeJson: vi.fn(async (key) => { memoryStore.delete(key); }),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  encryptSensitiveValue: vi.fn(async (value, context) => ({
    encrypted: true, version: 1, key_version: 1, context, payload: structuredClone(value),
  })),
  decryptSensitiveValue: vi.fn(async (value) => structuredClone(value.payload)),
  encryptSensitiveValues: vi.fn(async (entries = []) => entries.map((entry) => ({
    encrypted: true, version: 1, key_version: 1, context: entry?.context || '',
    payload: structuredClone(entry?.value),
  }))),
  decryptSensitiveValues: vi.fn(async (entries = []) => entries.map(
    (entry) => structuredClone(entry?.payload?.payload),
  )),
  getEncryptedJson: vi.fn(async (_key, fallback) => fallback),
  isEncryptedPayload: (value) => value?.encrypted === true,
  removeEncryptedJson: vi.fn(async () => {}),
  setEncryptedJson: vi.fn(async () => {}),
}));

vi.mock('@/lib/systemLog', async (importOriginal) => ({
  ...(await importOriginal()),
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

vi.mock('@/lib/trackingStore', async (importOriginal) => ({
  ...(await importOriginal()),
  localSettings: { get: () => ({}), set: () => {}, subscribe: () => () => {} },
}));

vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => [], getAllForReference: async () => [] },
}));

const keyRange = {
  only: (only) => ({ only }),
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }),
  lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen }),
};

describe('P6 hot prefix-4 production owner', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); memoryStore.clear(); });

  it('keeps canonical ordinal zero, partitions automatic evidence at 7 MiB, and cleans obsolete stages', async () => {
    const indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
    const repository = await import('@/lib/speedKnowledgeRepository');
    const contracts = await import('@/lib/p6Contracts');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'initial-empty', publicationVersion: 1,
      });

    const blob = 'a'.repeat(2_200_000);
    const hot = {
      cells: {},
      corrections: [{ id: 'manual-x', geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
      excludedSections: [],
      roadMemory: { candidates: Array.from({ length: 4 }, (_, index) => ({
        id: `automatic-${index}`, geohash: `dpz80${index}`, payload: blob,
        p6AutomaticEvidence: { frozenBaseline: [], receiptedEvidence: [] },
      })) },
    };
    await repository.speedKnowledgeStore.setForGeohashes(hot, ['dpz8']);

    const manifestState = indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.MANIFESTS);
    const partitionState = indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.PARTITIONS);
    const editorState = indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.EDITOR_INDEX);
    const stageX = manifestState.records.get('dpz8');
    expect(stageX).toMatchObject({ bucketId: 'dpz8', state: 'COMMITTED', partitionCount: 3 });
    const stageXRows = [...partitionState.records.values()].filter((row) => row.stageId === stageX.stageId);
    expect(stageXRows.map((row) => row.ordinal)).toEqual([0, 1, 2]);
    expect(stageXRows.every((row) => row.commitState === 'COMMITTED')).toBe(true);
    expect(stageXRows[0]).toMatchObject({ bucketId: 'dpz8', partitionKind: 'CANONICAL' });
    expect(stageXRows[0].payload.payload.corrections).toEqual([expect.objectContaining({ id: 'manual-x' })]);
    expect(stageXRows[0].payload.payload.roadMemory.candidates).toEqual([]);
    expect(stageXRows.slice(1).every((row) => row.partitionKind === 'AUTOMATIC'
      && row.encodedBytes <= contracts.P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES)).toBe(true);
    expect((await repository.speedKnowledgeStore.getForGeohashes(['dpz8'])).roadMemory.candidates)
      .toHaveLength(4);

    // A staged editor identity with no current manifest is independently
    // present on disk but unavailable through the production editor reader.
    editorState.records.set('abandoned:dpz8:candidate:hidden:0', {
      key: 'abandoned:dpz8:candidate:hidden:0', stageId: 'abandoned', publicationVersion: 99,
      bucketId: 'dpz8', kind: 'candidate', identity: 'hidden', commitState: 'STAGED',
    });
    partitionState.records.set('abandoned:dpz8:0', {
      key: 'abandoned:dpz8:0', stageId: 'abandoned', publicationVersion: 99,
      bucketId: 'dpz8', ordinal: 0, commitState: 'STAGED', encodedBytes: 100,
    });
    await expect(repository.queryP6BrowserSpeedEditorItems({
      kind: 'candidate', filter: 'hidden', maxItems: 10,
    })).resolves.toMatchObject({ items: [], itemCount: 0 });

    const oversizedAutomatic = {
      cells: {}, corrections: hot.corrections, excludedSections: [],
      roadMemory: { candidates: [{ id: 'too-large', geohash: 'dpz800',
        payload: 'z'.repeat(contracts.P6_AUTOMATIC_SPEED_PARTITION_TARGET_BYTES) }] },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(repository.speedKnowledgeStore.setForGeohashes(oversizedAutomatic, ['dpz8']))
        .rejects.toMatchObject({ code: 'CAPACITY_BLOCKED', partitionKind: 'AUTOMATIC' });
      expect(manifestState.records.get('dpz8')).toEqual(stageX);
    }

    await repository.speedKnowledgeStore.setForGeohashes({
      cells: {},
      corrections: [{ id: 'manual-y', geohash: 'dpz800', limitKmh: 50, source: 'manual' }],
      excludedSections: [], roadMemory: { candidates: [] },
    }, ['dpz8']);
    const stageY = manifestState.records.get('dpz8');
    expect(stageY.bucketId).toBe('dpz8');
    expect(stageY.stageId).not.toBe(stageX.stageId);
    const visible = await repository.speedKnowledgeStore.getForGeohashes(['dpz8']);
    expect(visible.corrections).toEqual([expect.objectContaining({ id: 'manual-y' })]);
    expect(visible.roadMemory.candidates).toEqual([]);

    for (let turn = 0; turn < 40; turn += 1) {
      const result = await repository.reclaimP6BrowserSpeedDerivedTurn();
      if (result.state === 'NO_RECLAIMABLE_DERIVED_DATA') break;
    }
    expect([...partitionState.records.values()].filter((row) => [stageX.stageId, 'abandoned'].includes(row.stageId)))
      .toEqual([]);
    expect([...editorState.records.values()].filter((row) => [stageX.stageId, 'abandoned'].includes(row.stageId)))
      .toEqual([]);
    expect([...partitionState.records.values()].filter((row) => row.stageId === stageY.stageId)).toHaveLength(1);
  }, 30_000);

  it('persists CAPACITY_BLOCKED as a terminal target disposition through a real J2 turn', async () => {
    const indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
    const repository = await import('@/lib/speedKnowledgeRepository');
    const trips = await import('@/lib/localTripRepository');
    const contracts = await import('@/lib/p6Contracts');
    const derivedState = await import('@/lib/p6TripDerivedState');
    const { LocalSpeedKnowledge } = await import('@/lib/localSpeedKnowledge');
    const road = await import('@/lib/p6RoadMemoryState');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'j2-authority', publicationVersion: 10,
      });
    const derived = await trips.openP6TripDerivedDatabase(); derived.close();
    const workStore = indexedDb.getStoreState(trips.DB_NAME, trips.P6_TRIP_DERIVED_STORES.WORK);
    const windows = indexedDb.getStoreState(trips.DB_NAME, trips.P6_TRIP_DERIVED_STORES.ROAD_WINDOWS);
    const work = {
      tripId: 'capacity-trip', desiredRevision: 'rev-1', sourceHash: 'hash-1',
      state: 'COMPLETE', roadCursor: { phase: 'APPLY', outputOrdinal: 0 },
    };
    workStore.records.set(work.tripId, work);
    windows.records.set('output:capacity-trip:rev-1:0', {
      key: 'output:capacity-trip:rev-1:0', payload: { payload: { observation: { geohash: 'dpz800' } } },
    });
    windows.records.set('output:capacity-trip:rev-1:1', {
      key: 'output:capacity-trip:rev-1:1', payload: { payload: { observation: { geohash: 'f2m200' } } },
    });
    const capacity = Object.assign(new Error('CAPACITY_BLOCKED'), {
      code: 'CAPACITY_BLOCKED', bucketId: 'dpz8', partitionKind: 'AUTOMATIC', encodedBytes: 8 * 1024 ** 2,
    });
    const apply = vi.spyOn(LocalSpeedKnowledge.prototype, 'applyP6RoadMemoryObservations')
      .mockRejectedValueOnce(capacity)
      .mockResolvedValue({ changedCandidates: [] });

    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
      blockedTarget: { tripId: 'capacity-trip', sourceRevision: 'rev-1', outputOrdinal: 0, bucketId: 'dpz8' },
    });
    await expect(derivedState.readP6TripDomainReadiness(contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, 'all'))
      .resolves.toMatchObject({ state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, complete: false });
    expect(workStore.records.get(work.tripId).roadCursor).toEqual({ phase: 'APPLY', outputOrdinal: 1 });

    // Replaying the same target observes its durable receipt and never invokes
    // the encoder again. The next fitting target remains independently usable.
    workStore.records.set(work.tripId, { ...workStore.records.get(work.tripId), roadCursor: { phase: 'APPLY', outputOrdinal: 0 } });
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'CAPACITY_BLOCKED', hasMore: false });
    expect(apply).toHaveBeenCalledTimes(1);
    workStore.records.set(work.tripId, { ...workStore.records.get(work.tripId), roadCursor: { phase: 'APPLY', outputOrdinal: 1 } });
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'APPLY', hasMore: true });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('maps a typed J2 capacity disposition through the lifecycle turn without a generic failure', async () => {
    const [{ createP4LifecycleWorkRuntime, APP_WORK_TRIGGER_ORIGINS }, {
      createAppWorkCoordinator,
    }, { P6_JOB_KEYS }] = await Promise.all([
      import('@/lib/appLifecycleWork'), import('@/lib/appWorkCoordinator'), import('@/lib/p6Contracts'),
    ]);
    const runP6RoadMemoryTurn = vi.fn(async () => ({
      state: 'CAPACITY_BLOCKED', hasMore: false, itemsWorked: 1, bytesWorked: 0,
    }));
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });
    const runtime = createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => false,
      readHealth: async () => ({ state: 'UNAVAILABLE' }),
      enableP6Registrations: true,
      runP6RoadMemoryTurn,
    });
    const admission = runtime.admit(P6_JOB_KEYS.ROAD_MEMORY_UPDATES, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 1,
    });
    await coordinator.drain();
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(runP6RoadMemoryTurn).toHaveBeenCalledTimes(1);
    expect(coordinator.getJobSnapshot(P6_JOB_KEYS.ROAD_MEMORY_UPDATES).failing).toBe(false);
  });

  /** Every criterion-5 arm shares one real browser owner: a v2 authority, the
   * real trip-derived database and the real J2 turn entry point. */
  const bootJ2 = async () => {
    const indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
    const repository = await import('@/lib/speedKnowledgeRepository');
    const trips = await import('@/lib/localTripRepository');
    const contracts = await import('@/lib/p6Contracts');
    const derivedState = await import('@/lib/p6TripDerivedState');
    const { LocalSpeedKnowledge } = await import('@/lib/localSpeedKnowledge');
    const road = await import('@/lib/p6RoadMemoryState');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'criterion5-authority', publicationVersion: 11,
      });
    const derived = await trips.openP6TripDerivedDatabase(); derived.close();
    const store = (name) => indexedDb.getStoreState(trips.DB_NAME, name);
    return {
      indexedDb, repository, trips, contracts, derivedState, LocalSpeedKnowledge, road, store,
      work: store(trips.P6_TRIP_DERIVED_STORES.WORK),
      windows: store(trips.P6_TRIP_DERIVED_STORES.ROAD_WINDOWS),
      receipts: store(trips.P6_TRIP_DERIVED_STORES.SOURCE_APPLIED),
      source: store(trips.P6_TRIP_SOURCE_STORE),
    };
  };

  const capacityError = (bucketId, encodedBytes) => Object.assign(new Error('CAPACITY_BLOCKED'), {
    code: 'CAPACITY_BLOCKED', bucketId, partitionKind: 'AUTOMATIC', encodedBytes,
  });

  const seedOutput = (context, tripId, revision, ordinal, geohash) => {
    context.windows.records.set(`output:${tripId}:${revision}:${ordinal}`, {
      key: `output:${tripId}:${revision}:${ordinal}`,
      payload: { payload: { observation: { geohash } } },
    });
  };

  const admitForApply = (context, tripId, ordinal = 0) => {
    const current = context.work.records.get(tripId);
    context.work.records.set(tripId, {
      ...current, state: 'COMPLETE', roadCursor: { phase: 'APPLY', outputOrdinal: ordinal },
    });
    return current;
  };

  it('replaces a blocked target when the real canonical source revision changes', async () => {
    const context = await bootJ2();
    const { contracts, derivedState, road, trips } = context;
    const { localTripRepository } = trips;
    const tripId = 'canonical-capacity-trip';
    await localTripRepository.create({
      id: tripId, status: 'completed',
      start_time: new Date(1_756_000_000_000).toISOString(),
      end_time: new Date(1_756_000_900_000).toISOString(),
      distance_km: 6, duration_seconds: 900, score_overall: 88,
      route_points: Array.from({ length: 12 }, (_, index) => ({
        lat: 43.6 + index * 0.0002, lng: -79.4, speed_kmh: 44, accuracy: 6,
        timestamp: 1_756_000_000_000 + index * 1000,
      })),
    });
    const revisionX = String(context.work.records.get(tripId).desiredRevision);
    expect(revisionX).toBeTruthy();

    const apply = vi.spyOn(context.LocalSpeedKnowledge.prototype, 'applyP6RoadMemoryObservations')
      .mockRejectedValueOnce(capacityError('dpz8', 8 * 1024 ** 2))
      .mockRejectedValueOnce(capacityError('f2m2', 9 * 1024 ** 2))
      .mockResolvedValue({ changedCandidates: [] });

    seedOutput(context, tripId, revisionX, 0, 'dpz800');
    admitForApply(context, tripId);
    const blockedX = await road.stepP6RoadMemoryUpdate();
    expect(blockedX).toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
      blockedTarget: { tripId, sourceRevision: revisionX, bucketId: 'dpz8' },
    });
    const targetX = blockedX.blockedTarget.targetId;
    await expect(derivedState.readP6TripDomainReadiness(contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, 'all'))
      .resolves.toMatchObject({ state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED });

    // The real canonical mutation mints a new source revision, so the durable
    // target identity moves even though the trip identity does not.
    await localTripRepository.update(tripId, { notes: 'edited after the capacity block' });
    const revisionY = String(context.work.records.get(tripId).desiredRevision);
    expect(revisionY).not.toBe(revisionX);
    expect(context.receipts.records.get(`D4:browser:${tripId}:${revisionX}:0`))
      .toMatchObject({ state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED });

    // Y is genuinely encoded rather than replaying X's terminal receipt, and it
    // gets its own capacity disposition when it also cannot fit.
    seedOutput(context, tripId, revisionY, 0, 'dpz800');
    admitForApply(context, tripId);
    const blockedY = await road.stepP6RoadMemoryUpdate();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(blockedY).toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
      blockedTarget: { tripId, sourceRevision: revisionY, bucketId: 'f2m2' },
    });
    expect(blockedY.blockedTarget.targetId).not.toBe(targetX);

    // A further canonical change that does fit publishes and leaves no blocked
    // target on D4 at all.
    await localTripRepository.update(tripId, { notes: 'edited again' });
    const revisionZ = String(context.work.records.get(tripId).desiredRevision);
    expect(revisionZ).not.toBe(revisionY);
    seedOutput(context, tripId, revisionZ, 0, 'dpz800');
    admitForApply(context, tripId);
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'APPLY', hasMore: true });
    expect(apply).toHaveBeenCalledTimes(3);
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'COMPLETE' });
    await expect(derivedState.readP6TripDomainReadiness(contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, tripId))
      .resolves.toMatchObject({
        state: contracts.P6_READINESS_STATES.VERIFIED, complete: true, requiredVersion: revisionZ,
      });
    for (const subject of [tripId, 'all']) {
      const head = await derivedState.readP6TripDomainReadiness(
        contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, subject,
      );
      expect(head.state).not.toBe(contracts.P6_READINESS_STATES.CAPACITY_BLOCKED);
      expect(head.blockedTarget).toBeUndefined();
    }
  }, 30_000);

  it('re-evaluates a blocked target for an explicit E2 request and for nothing else', async () => {
    const context = await bootJ2();
    const { contracts, derivedState, road } = context;
    const operations = await import('@/lib/p6ExplicitOperations');
    const tripId = 'explicit-capacity-trip';
    context.source.records.set(tripId, { id: tripId, source_revision: 'rev-e2', status: 'completed' });
    context.work.records.set(tripId, {
      tripId, desiredRevision: 'rev-e2', sourceHash: 'hash-e2', state: 'COMPLETE',
      dirtyDomains: Object.values(contracts.P6_DOMAIN_KEYS),
      roadCursor: { phase: 'APPLY', outputOrdinal: 0 },
    });
    seedOutput(context, tripId, 'rev-e2', 0, 'dpz800');
    seedOutput(context, tripId, 'rev-e2', 1, 'f2m200');
    const apply = vi.spyOn(context.LocalSpeedKnowledge.prototype, 'applyP6RoadMemoryObservations')
      .mockRejectedValueOnce(capacityError('dpz8', 8 * 1024 ** 2))
      .mockResolvedValue({ changedCandidates: [] });

    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
    });
    expect(context.receipts.records.get(`D4:browser:${tripId}:rev-e2:0`))
      .toMatchObject({ state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED });

    // Ordinary J2 keeps the target terminal: no re-encode, no receipt change.
    admitForApply(context, tripId);
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'CAPACITY_BLOCKED' });
    expect(apply).toHaveBeenCalledTimes(1);

    // The real E2 operation marks the same target for capacity re-evaluation.
    const operation = await operations.startKnownP6ExplicitOperation(
      contracts.P6_EXPLICIT_OPERATION_TYPES.RETAINED_HISTORY_LEARNING,
    );
    await operations.runKnownP6ExplicitOperationTurn(operation.operationId);
    const queued = context.work.records.get(tripId);
    expect(queued.reevaluateCapacityBlocked).toBe(true);
    expect(String(queued.desiredRevision)).toBe('rev-e2');

    // The still-present blocked receipt no longer suppresses the observation.
    admitForApply(context, tripId);
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'APPLY', hasMore: true });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(context.receipts.records.get(`D4:browser:${tripId}:rev-e2:0`).state).toBeUndefined();
    expect(context.work.records.get(tripId).reevaluateCapacityBlocked).toBe(false);

    // Publication converges and the old disposition is gone from every head.
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'APPLY' });
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({ state: 'COMPLETE' });
    expect(apply).toHaveBeenCalledTimes(3);
    await expect(derivedState.readP6TripDomainReadiness(contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, tripId))
      .resolves.toMatchObject({ state: contracts.P6_READINESS_STATES.VERIFIED, complete: true });
    for (const subject of [tripId, 'all']) {
      const head = await derivedState.readP6TripDomainReadiness(
        contracts.P6_DOMAIN_KEYS.ROAD_LEARNING, subject,
      );
      expect(head.state).not.toBe(contracts.P6_READINESS_STATES.CAPACITY_BLOCKED);
      expect(head.blockedTarget).toBeUndefined();
    }
  }, 30_000);

  it('keeps an E2 re-evaluation that still cannot fit terminal for its new target', async () => {
    const context = await bootJ2();
    const { contracts, road } = context;
    const operations = await import('@/lib/p6ExplicitOperations');
    const tripId = 'explicit-capacity-still-blocked';
    context.source.records.set(tripId, { id: tripId, source_revision: 'rev-e2b', status: 'completed' });
    context.work.records.set(tripId, {
      tripId, desiredRevision: 'rev-e2b', sourceHash: 'hash-e2b', state: 'COMPLETE',
      dirtyDomains: Object.values(contracts.P6_DOMAIN_KEYS),
      roadCursor: { phase: 'APPLY', outputOrdinal: 0 },
    });
    seedOutput(context, tripId, 'rev-e2b', 0, 'dpz800');
    const apply = vi.spyOn(context.LocalSpeedKnowledge.prototype, 'applyP6RoadMemoryObservations')
      .mockRejectedValue(capacityError('dpz8', 8 * 1024 ** 2));

    const first = await road.stepP6RoadMemoryUpdate();
    expect(first.state).toBe(contracts.P6_READINESS_STATES.CAPACITY_BLOCKED);

    const operation = await operations.startKnownP6ExplicitOperation(
      contracts.P6_EXPLICIT_OPERATION_TYPES.RETAINED_HISTORY_LEARNING,
    );
    await operations.runKnownP6ExplicitOperationTurn(operation.operationId);
    expect(context.work.records.get(tripId).reevaluateCapacityBlocked).toBe(true);

    apply.mockRejectedValue(capacityError('gcpv', 12 * 1024 ** 2));
    admitForApply(context, tripId);
    const second = await road.stepP6RoadMemoryUpdate();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
      blockedTarget: { tripId, sourceRevision: 'rev-e2b', bucketId: 'gcpv' },
    });
    expect(context.work.records.get(tripId).reevaluateCapacityBlocked).toBe(false);

    // The grant was consumed: the unchanged target is terminal again.
    admitForApply(context, tripId);
    await expect(road.stepP6RoadMemoryUpdate()).resolves.toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED,
      blockedTarget: { bucketId: 'gcpv' },
    });
    expect(apply).toHaveBeenCalledTimes(2);

    // Module recreation is not a retry authority either.
    vi.resetModules();
    const restarted = await import('@/lib/p6RoadMemoryState');
    const { LocalSpeedKnowledge: RestartedKnowledge } = await import('@/lib/localSpeedKnowledge');
    const restartedApply = vi.spyOn(RestartedKnowledge.prototype, 'applyP6RoadMemoryObservations')
      .mockResolvedValue({ changedCandidates: [] });
    admitForApply(context, tripId);
    await expect(restarted.stepP6RoadMemoryUpdate()).resolves.toMatchObject({
      state: contracts.P6_READINESS_STATES.CAPACITY_BLOCKED, hasMore: false,
    });
    expect(restartedApply).not.toHaveBeenCalled();
  }, 30_000);

  it('selects source evidence in bounded pages independently of global evidence scale', async () => {
    const indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
    const repository = await import('@/lib/speedKnowledgeRepository');
    const crypto = await import('@/lib/securePayloadCrypto');
    await repository.readP6BrowserSpeedAuthority();
    indexedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
      .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
        key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
        stageId: 'evidence-authority', publicationVersion: 20,
      });
    const candidate = (id, sourceIdentity) => ({
      id, geohash: `dpz8${String(id).padStart(2, '0')}`,
      p6AutomaticEvidence: {
        frozenBaseline: [],
        receiptedEvidence: [{ sourceIdentity, sourceRevision: '1', membershipToken: `m-${id}` }],
      },
    });
    const measure = async (unrelatedCount) => {
      const observedDb = new FakeIndexedDb();
      vi.stubGlobal('indexedDB', observedDb);
      await repository.readP6BrowserSpeedAuthority();
      observedDb.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL)
        .records.set(repository.P6_SPEED_AUTHORITY_KEY, {
          key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
          stageId: 'evidence-authority', publicationVersion: 20,
        });
      const candidates = [candidate('target-a', 'browser:target'), candidate('target-b', 'browser:target')];
      for (let index = 0; index < unrelatedCount; index += 1) {
        candidates.push(candidate(`unrelated-${index}`, `browser:other-${index}`));
      }
      await repository.speedKnowledgeStore.setForGeohashes({
        cells: {}, corrections: [], excludedSections: [], roadMemory: { candidates },
      }, ['dpz8']);
      vi.mocked(crypto.decryptSensitiveValue).mockClear();
      const transactionsBefore = observedDb.transactionCount;
      const page = await repository.queryP6BrowserSpeedEditorItems({
        kind: 'evidence', filter: 'browser:target', maxItems: 2,
      });
      return {
        page,
        transactions: observedDb.transactionCount - transactionsBefore,
        decryptions: vi.mocked(crypto.decryptSensitiveValue).mock.calls.length,
      };
    };
    const small = await measure(20);
    const large = await measure(120);
    for (const observed of [small, large]) {
      expect(observed.page.items).toHaveLength(2);
      expect(observed.page.examinedCount).toBeLessThanOrEqual(2);
      expect(observed.transactions).toBeLessThanOrEqual(3);
      expect(observed.decryptions).toBeLessThanOrEqual(2);
    }
    expect(large.transactions).toBe(small.transactions);
    expect(large.decryptions).toBe(small.decryptions);
    expect(large.page.examinedCount).toBe(small.page.examinedCount);
  });
});
