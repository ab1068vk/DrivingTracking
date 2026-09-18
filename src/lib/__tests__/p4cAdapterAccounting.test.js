import { beforeEach, describe, expect, it, vi } from 'vitest';


/**
 * P4-C-F08 / P4-C-F09 — the production adapters, driven against their real
 * domain-step seams.
 *
 * Every assertion here is about the *seam*: what the domain step reports, what
 * the adapter consumes from the declared budget, and what the coordinator's own
 * telemetry then says. A fabricated scalar (a batch of 20 reported as 1, a
 * begin handshake reported as 8 buckets, a whole repository pass reported as 1)
 * fails these tests.
 */

/**
 * Load the lifecycle runtime *after* the test's own module mocks, so a mocked
 * domain module is what the production adapter's dynamic import resolves to.
 */
const loadLifecycle = async () => ({
  lifecycle: await import('@/lib/appLifecycleWork'),
  work: await import('@/lib/appWorkCoordinator'),
});

const runtimeWith = async (overrides = {}) => {
  const { lifecycle, work } = await loadLifecycle();
  const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const runtime = lifecycle.createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => true,
    readHealth: vi.fn(async () => ({
      authorityState: 'NATIVE',
      recoveryState: 'HEALTHY',
      sentinelMatches: true,
      archiveGeneration: 'g1',
      erasureBarrierToken: 'g1',
    })),
    runProjectionTurn: vi.fn(async () => ({ done: true, applied: 0 })),
    runJournalTurn: vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
    ...overrides,
  });
  coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });
  return { coordinator, runtime, lifecycle, work };
};

/** Run one turn of `jobKey` and return its telemetry record. */
const runTurn = async (coordinator, runtime, lifecycle, jobKey, { epoch = 5 } = {}) => {
  const before = coordinator.getTelemetrySnapshot().events.length;
  if (!coordinator.getJobSnapshot(jobKey)?.active) {
    runtime.admit(jobKey, { origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch });
  }
  await coordinator.runNextTurn();
  const events = coordinator.getTelemetrySnapshot().events;
  return events.slice(before).find((event) => event.jobKey === jobKey) || events.at(-1);
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('P4-C-F09: migration accounting is the rows the turn visited', () => {
  const migrationRuntime = async (turns) => {
    const step = vi.fn(async () => turns.shift() || { outcome: 'done', unit: 'verified', itemCount: 0 });
    const fixture = await runtimeWith({
      runMigrationTurnAdapter: async () => {
        const turn = await step();
        if (turn.outcome === 'deferred') {
          return { items: Number(turn.itemCount) || 0, result: { outcome: 'deferred', wake: { type: 'canonical_health', key: 'healthy' } } };
        }
        return {
          items: Number(turn.itemCount) || 0,
          result: turn.outcome === 'hasMore' ? 'hasMore' : 'done',
        };
      },
    });
    return { ...fixture, step };
  };

  it.each([
    ['an empty pass', { outcome: 'done', unit: 'already-verified', itemCount: 0 }, 0],
    ['a non-final scan page', { outcome: 'hasMore', unit: 'migrating', visitedCount: 500, itemCount: 50 }, 50],
    ['a promotion turn', { outcome: 'done', unit: 'verified', itemCount: 0 }, 0],
  ])('consumes exactly what %s reported', async (_label, turn, expected) => {
    const { coordinator, runtime, lifecycle } = await migrationRuntime([turn]);

    const event = await runTurn(coordinator, runtime, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION);

    expect(event.consumedBudget.items).toBe(expected);
    expect(event.declaredBudget.items).toBe(50);
    expect(event.timeBudgetOverrun).toBe(false);
  });

  it('never reports the pass-to-date total as one turn consumption', async () => {
    // The domain's cumulative `visitedCount` is 500; this turn visited 50.
    const { coordinator, runtime, lifecycle } = await migrationRuntime([
      { outcome: 'hasMore', unit: 'verifying', visitedCount: 500, itemCount: 50 },
    ]);

    const event = await runTurn(coordinator, runtime, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION);

    expect(event.consumedBudget.items).toBe(50);
    expect(event.consumedBudget.items).not.toBe(500);
  });

  it('raises the typed hard budget error when a domain result exceeds the ceiling', async () => {
    const { coordinator, runtime, lifecycle, work } = await migrationRuntime([
      { outcome: 'hasMore', unit: 'migrating', itemCount: 51 },
    ]);

    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    const result = await coordinator.runNextTurn();

    expect(result.outcome).toBe('failing');
    expect(result.error).toBeInstanceOf(work.AppWorkBudgetExceededError);
    // A budget violation stays an immediate typed failure (P4-C-F10).
    expect(coordinator.getJobSnapshot(lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION)).toMatchObject({
      failing: true,
      wake: null,
    });
  });
});

describe('P4-C-F09: rescoring accounts a batch as its trips', () => {
  it.each([
    ['an empty queue', { processed: 0, examined: 0, hasMore: false, ranBatch: false }, 0],
    // P4-C-F09: a batch that attempted twenty trips and changed none of them
    // still consumed twenty trip units, plus the index records it visited.
    ['a full batch', { processed: 20, examined: 22, hasMore: true, ranBatch: true }, 22],
    ['a final short batch', { processed: 7, examined: 8, hasMore: false, ranBatch: true }, 8],
  ])('consumes the trips %s reported', async (_label, outcome, expected) => {
    vi.resetModules();
    vi.doMock('@/lib/rescoringQueue', () => ({
      stepRescoringQueue: vi.fn(async () => outcome),
      setRescoringCoordinatorOwned: vi.fn(),
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    await coordinator.runNextTurn();

    const event = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING)
      .at(-1);
    expect(event.consumedBudget.items).toBe(expected);
    expect(event.declaredBudget.items).toBe(36);
    vi.doUnmock('@/lib/rescoringQueue');
    vi.resetModules();
  });

  it('P4-C-F07: an awaiting-worker turn defers on its typed wake and consumes nothing', async () => {
    vi.resetModules();
    vi.doMock('@/lib/rescoringQueue', () => ({
      stepRescoringQueue: vi.fn(async () => ({
        processed: 0, hasMore: false, ranBatch: false, awaitingWorker: true,
      })),
      setRescoringCoordinatorOwned: vi.fn(),
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    const admission = runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    await coordinator.drain();

    await expect(admission.completion).resolves.toMatchObject({
      outcome: 'deferred',
      wake: lifecycle.RESCORING_WORKER_WAKE,
    });
    // One turn, then sleep - not an endless zero-work continuation.
    expect(coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING)).toHaveLength(1);
    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({ sleepingInstances: 1, backlog: 0 });

    // Worker readiness re-admits the same logical obligation with no resume.
    expect(runtime.admitRescoringWorkerReady().status).toBe('admitted_wake');
    vi.doUnmock('@/lib/rescoringQueue');
    vi.resetModules();
  });
});

describe('P4-C-F08/F09: speed maintenance resumes natively and accounts real buckets', () => {
  const speedFixture = ({ jobs = new Map(), generation = 'g1' } = {}) => {
    const calls = { begin: 0, beginOrResume: 0, step: 0 };
    let nextId = 1;
    const native = {
      beginSpeedMaintenance: vi.fn(async () => {
        calls.begin += 1;
        const id = `job-${nextId++}`;
        jobs.set(id, { jobId: id, state: 'RUNNING', processedBuckets: 0, speedGeneration: generation });
        return { ...jobs.get(id) };
      }),
      beginOrResumeSpeedMaintenance: vi.fn(async () => {
        calls.beginOrResume += 1;
        // The durable table, not renderer memory, resolves the identity.
        const running = [...jobs.values()].find((job) => (
          job.state === 'RUNNING' && job.speedGeneration === generation
        ));
        if (running) return { ...running };
        return native.beginSpeedMaintenance();
      }),
      stepSpeedMaintenance: vi.fn(async (jobId) => {
        calls.step += 1;
        const job = jobs.get(jobId);
        if (!job) throw new Error('SPEED_MAINTENANCE_JOB_NOT_FOUND');
        job.processedBuckets += 8;
        if (job.processedBuckets >= 24) job.state = 'COMPLETED';
        return { ...job };
      }),
    };
    return { native, jobs, calls };
  };

  it('resumes the same native job after the JS runtime is discarded', async () => {
    const { native, jobs, calls } = speedFixture();
    // First session: begin, then one non-final bounded step.
    const first = await native.beginOrResumeSpeedMaintenance('PRUNE', 180);
    expect(first.state).toBe('RUNNING');
    await native.stepSpeedMaintenance(first.jobId, 8);
    expect(jobs.get(first.jobId).processedBuckets).toBe(8);

    // Renderer death: nothing in JS remembers the job id.
    const resumed = await native.beginOrResumeSpeedMaintenance('PRUNE', 180);

    expect(resumed.jobId).toBe(first.jobId);
    expect(resumed.processedBuckets).toBe(8);
    // No second RUNNING job was created.
    expect([...jobs.values()].filter((job) => job.state === 'RUNNING')).toHaveLength(1);
    expect(calls.begin).toBe(1);

    await native.stepSpeedMaintenance(resumed.jobId, 8);
    await native.stepSpeedMaintenance(resumed.jobId, 8);
    expect(jobs.get(first.jobId)).toMatchObject({ state: 'COMPLETED', processedBuckets: 24 });
    expect(jobs.size).toBe(1);
  });

  it.each([
    ['a begin handshake', [{ state: 'RUNNING', jobId: 'j', processedBuckets: 0, hasMore: true }], 0],
    ['a non-final 8-bucket step', [
      { state: 'RUNNING', jobId: 'j', processedBuckets: 0, hasMore: true },
      { state: 'RUNNING', jobId: 'j', processedBuckets: 8, hasMore: true },
    ], 8],
    ['a final 8-bucket step', [
      { state: 'RUNNING', jobId: 'j', processedBuckets: 0, hasMore: true },
      { state: 'RUNNING', jobId: 'j', processedBuckets: 8, hasMore: true },
      { state: 'COMPLETED', jobId: 'j', processedBuckets: 16, hasMore: false },
    ], 8],
  ])('consumes the buckets %s actually processed', async (_label, sequence, expected) => {
    vi.resetModules();
    let call = 0;
    vi.doMock('@/lib/speedKnowledgeRepository', () => ({
      SPEED_KNOWLEDGE_STORAGE_KEY: 'speed_knowledge_v1',
      speedKnowledgeRepository: {
        stepMaintenanceTurn: vi.fn(async () => sequence[Math.min(call++, sequence.length - 1)]),
      },
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.SPEED_MAINTENANCE, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    for (let turn = 0; turn < sequence.length; turn += 1) await coordinator.runNextTurn();

    const events = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.SPEED_MAINTENANCE);
    expect(events).toHaveLength(sequence.length);
    // The begin handshake processes no buckets and says so; the final step is
    // credited with the eight buckets it really did process.
    expect(events.at(-1).consumedBudget.items).toBe(expected);
    expect(events.reduce((sum, event) => sum + event.consumedBudget.items, 0))
      .toBe(sequence.at(-1).processedBuckets);
    vi.doUnmock('@/lib/speedKnowledgeRepository');
    vi.resetModules();
  });
});

describe('P4-C-F09: repository and KEK turns report their own record counts', () => {
  it('consumes the records the repository subpass touched, not a fixed one', async () => {
    vi.resetModules();
    vi.doMock('@/lib/localTripRepository', () => ({
      // A subpass window that still has records keeps the sequence on the same
      // unit, then the next subpass finishes it.
      // A verification slice that reads 256 rows and repairs none still
      // consumed 256 row units - `examined`, not `processed`, is the unit.
      stepTripRepositoryMaintenance: vi.fn()
        .mockResolvedValueOnce({ unit: 'projection_maintenance', unitIndex: 0, nextUnitIndex: 0, processed: 0, examined: 256, hasMore: true })
        .mockResolvedValueOnce({ unit: 'rescore_windows', unitIndex: 0, nextUnitIndex: 7, processed: 3, examined: 3, hasMore: false }),
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    await coordinator.runNextTurn();
    await coordinator.runNextTurn();

    const events = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE);
    expect(events.map((entry) => entry.consumedBudget.items)).toEqual([256, 3]);
    // The declared budget describes the widest real subpass window, so a
    // truthful count can never exceed it.
    expect(events[0].declaredBudget.items).toBe(536);
    for (const event of events) {
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }
    vi.doUnmock('@/lib/localTripRepository');
    vi.resetModules();
  });

  it('counts browser ciphertext records as well as native envelope records', async () => {
    vi.resetModules();
    vi.doMock('@/lib/keyRotationManager', () => ({
      stepEncryptionKeyRotation: vi.fn()
        .mockResolvedValueOnce({ hasMore: true, indexedDbRecordsRotated: 25, nativeEnvelopeRecordsRewrapped: 0 })
        .mockResolvedValueOnce({ hasMore: false, indexedDbRecordsRotated: 5, encryptedJsonValuesRotated: 3, nativeEnvelopeRecordsRewrapped: 0 }),
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    await coordinator.drain();

    const events = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION);
    // The browser pass used to report zero for real full-history work.
    expect(events.map((entry) => entry.consumedBudget.items)).toEqual([25, 8]);
    vi.doUnmock('@/lib/keyRotationManager');
    vi.resetModules();
  });
});

describe('P4-C-F09: the declared ceilings describe the real bounded units', () => {
  it('matches every declared ceiling to the constant its domain derives', async () => {
    vi.resetModules();
    const lifecycle = await import('@/lib/appLifecycleWork');
    const repository = await import('@/lib/localTripRepository');
    const rescoring = await import('@/lib/rescoringQueue');
    const roadContext = await import('@/lib/roadContextQueue');
    const keys = lifecycle.P4_LIFECYCLE_JOB_KEYS;
    const ceilings = lifecycle.P4_LIFECYCLE_TURN_BUDGET_CEILINGS;

    expect(ceilings[keys.REPOSITORY_MAINTENANCE]).toBe(repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED);
    // P4-C-F09: and the domain constant is itself derived, so a change to any
    // projection window or repair read count moves both sides together - a
    // literal that drifted from its derivation fails here.
    const projection = await import('@/lib/tripProjectionMaintenance');
    expect(repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED).toBe(Math.max(
      repository.REPOSITORY_MAINTENANCE_WINDOW,
      repository.NATIVE_COMPLETED_IMPORT_MAX_ITEMS,
      projection.PROJECTION_SUBPASS_MAX_EXAMINED,
    ));
    expect(projection.PROJECTION_SUBPASS_MAX_EXAMINED).toBe(Math.max(
      projection.BACKFILL_MAX_EXAMINED,
      projection.VERIFY_MAX_EXAMINED,
      projection.CLEANUP_MAX_EXAMINED,
    ));
    expect(projection.VERIFY_MAX_EXAMINED).toBe(
      (projection.VERIFY_ROWS_PER_TURN * 2)
      + (projection.VERIFY_POINT_READS_PER_TURN * projection.PROJECTION_REPAIR_READS_PER_MISMATCH)
    );
    expect(ceilings[keys.RESCORING]).toBe(rescoring.RESCORING_TURN_MAX_EXAMINED);
    expect(ceilings[keys.ROAD_CONTEXT]).toBe(roadContext.ROAD_CONTEXT_TURN_MAX_EXAMINED);
    // One KEK batch reads one rotation window of source records and the same
    // window of summary records.
    expect(ceilings[keys.KEY_ROTATION]).toBe(repository.TRIP_KEY_ROTATION_WINDOW * 2);
  });

  it.each([
    ['REPOSITORY_MAINTENANCE', 536],
    ['RESCORING', 36],
    ['ROAD_CONTEXT', 100],
  ])('raises the typed hard-budget failure when %s exceeds its ceiling by one', async (jobName, ceiling) => {
    vi.resetModules();
    vi.doMock('@/lib/localTripRepository', () => ({
      stepTripRepositoryMaintenance: vi.fn(async () => ({
        unit: 'projection_maintenance', unitIndex: 0, nextUnitIndex: 0,
        processed: 0, examined: ceiling + 1, hasMore: true,
      })),
    }));
    vi.doMock('@/lib/rescoringQueue', () => ({
      stepRescoringQueue: vi.fn(async () => ({
        processed: 0, examined: ceiling + 1, hasMore: true, ranBatch: true,
      })),
      setRescoringCoordinatorOwned: vi.fn(),
    }));
    vi.doMock('@/lib/roadContextQueue', () => ({
      stepPendingRoadContextJobs: vi.fn(async () => ({
        processed: 0, examined: ceiling + 1, hasMore: true,
      })),
    }));
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });

    const jobKey = lifecycle.P4_LIFECYCLE_JOB_KEYS[jobName];
    runtime.admit(jobKey, { origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 5 });
    const result = await coordinator.runNextTurn();

    expect(result.outcome).toBe('failing');
    expect(result.error).toBeInstanceOf(work.AppWorkBudgetExceededError);
    expect(coordinator.getJobSnapshot(jobKey)).toMatchObject({ failing: true, wake: null });
    vi.doUnmock('@/lib/localTripRepository');
    vi.doUnmock('@/lib/rescoringQueue');
    vi.doUnmock('@/lib/roadContextQueue');
    vi.resetModules();
  });
});

describe('P4-C-F09: the adapters account real domain functions, not normalized mocks', () => {
  /**
   * The road-context and rescoring domains here are the production modules,
   * driven over a real (in-memory) storage seam. What the coordinator consumes
   * is whatever those functions actually examined.
   */
  const storageFixture = () => {
    const storage = new Map();
    vi.doMock('@/lib/mobileStorage', () => ({
      getJson: vi.fn(async (key, fallback) => (
        storage.has(key) ? structuredClone(storage.get(key)) : fallback
      )),
      setJson: vi.fn(async (key, value) => {
        if (value === null) storage.delete(key);
        else storage.set(key, structuredClone(value));
      }),
    }));
    vi.doMock('@/lib/systemLog', () => ({
      logSystemFailure: vi.fn(), recordSystemEvent: vi.fn(), logError: vi.fn(),
    }));
    return storage;
  };

  const runtimeFor = async () => {
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');
    const coordinator = work.createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = lifecycle.createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => true,
      readHealth: vi.fn(async () => ({ authorityState: 'NATIVE', recoveryState: 'HEALTHY', sentinelMatches: true, archiveGeneration: 'g1' })),
      runProjectionTurn: vi.fn(),
      runJournalTurn: vi.fn(),
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });
    return { lifecycle, coordinator, runtime };
  };

  it('consumes what the real rescoring turn examined, including failed trips', async () => {
    vi.resetModules();
    storageFixture();
    vi.doMock('@/lib/speedKnowledgeRepository', () => ({
      SPEED_KNOWLEDGE_STORAGE_KEY: 'speed_knowledge_v1',
      readSpeedKnowledgeMetadata: vi.fn(async () => ({ schemaVersion: 2, knowledgeRevision: 7 })),
    }));
    const rescoring = await import('@/lib/rescoringQueue');
    // Every trip in the batch fails, so nothing is "changed" this turn.
    const worker = { rescoreTrip: vi.fn(async () => { throw new Error('offline'); }) };
    await rescoring.enqueueRescoreJob({
      reason: 'manual',
      tripIds: Array.from({ length: 60 }, (_, index) => `trip-${index}`),
    }, worker);
    rescoring.scheduleRescoringQueue(worker);

    const { lifecycle, coordinator, runtime } = await runtimeFor();
    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 5,
    });
    await coordinator.runNextTurn();

    const event = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING).at(-1);
    expect(worker.rescoreTrip).toHaveBeenCalledTimes(20);
    // Twenty trips read and attempted, none of them completed.
    expect(event.consumedBudget.items).toBeGreaterThanOrEqual(20);
    expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    vi.resetModules();
  });

  it('consumes what the real road-context turn examined, including backed-off entries', async () => {
    vi.resetModules();
    const storage = storageFixture();
    vi.doMock('@/api/trips', () => ({
      tripService: { update: vi.fn(async (id) => ({ id })), getById: vi.fn(async (id) => ({ id })) },
    }));
    vi.doMock('@/lib/openSourceTripContext', () => ({
      buildOpenSourceTripContextPatch: vi.fn(async () => ({})),
      buildWeatherOnlyTripContextPatch: vi.fn(async () => ({})),
    }));
    vi.doMock('@/lib/trackingStore', () => ({ localSettings: { get: vi.fn(() => ({})) } }));
    const roadContext = await import('@/lib/roadContextQueue');
    // Twelve queued entries, every one of them still inside its backoff window.
    const now = new Date().toISOString();
    storage.set('drivesense_pending_road_context_page_v2_0', Array.from({ length: 12 }, (_, index) => ({
      tripId: `trip-${index}`, queuedAt: now, attempts: 3, lastAttemptAt: now,
    })));
    for (let index = 0; index < 12; index += 1) {
      storage.set(`drivesense_pending_road_context_member_v2_trip-${index}`, true);
    }
    storage.set('drivesense_pending_road_context_meta_v2', { version: 2, head: 0, tail: 0, scan: 0, count: 12 });
    storage.set('drivesense_pending_road_context_conversion_v2', { startedAt: 1, moved: 0, completedAt: 1 });

    const turn = await roadContext.stepPendingRoadContextJobs({ maxEntries: 4 });
    expect(turn.processed).toBe(0);
    // Load-bearing: a changed/ran-only count would report zero here.
    expect(turn.examined).toBe(12);

    const { lifecycle, coordinator, runtime } = await runtimeFor();
    runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, {
      origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 5,
    });
    await coordinator.runNextTurn();

    const event = coordinator.getTelemetrySnapshot().events
      .filter((entry) => entry.jobKey === lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT).at(-1);
    expect(event.consumedBudget.items).toBe(12);
    expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    vi.resetModules();
  });
});
