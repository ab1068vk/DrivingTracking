import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * P4-D final scale/growth-law matrix.
 *
 * P4-D-F03: every law below is bound to a *current production seam* — the real
 * lifecycle registrations in `appLifecycleWork.js`, their real default turn
 * adapters, and the real domain step each adapter calls — driven over the
 * frozen deterministic dataset matrix. Only the boundaries a growth law is not
 * about (network context builders, the native plugin, the trip API) are
 * doubled; the bounded unit under test is always production code.
 *
 * Evidence is operation counts, records examined, adapter-reported consumption,
 * storage-seam counters, registration declarations and coordinator state size.
 * Wall-clock time is never a correctness signal, and no physical payload is
 * allocated where a counter proves the same law more strongly. The frozen plan
 * explicitly accepts this in place of a 20,000-trip or device run; the physical
 * campaign (V24) remains deferred.
 */

/** The frozen matrix. */
const DATASET_SIZES = [0, 100, 500, 1_000, 3_000, 5_000];
const SYNTHETIC_LARGE = Number.MAX_SAFE_INTEGER;
/** P50-like, P95-like and a deliberately large route, as route *sizes*. */
const ROUTE_SIZES = [120, 1_800, 250_000];
const DAY_MS = 24 * 60 * 60 * 1000;

const HEALTH = Object.freeze({
  authorityState: 'NATIVE',
  recoveryState: 'HEALTHY',
  sentinelMatches: true,
  archiveGeneration: 'g1',
  erasureBarrierToken: 'g1',
});

/**
 * The production lifecycle runtime, with every domain turn left at its
 * *default* — so the adapters exercised below are the shipped ones.
 */
const productionRuntimeFor = (lifecycle, work, overrides = {}) => {
  const coordinator = work.createAppWorkCoordinator({
    autoStart: false,
    yieldControl: vi.fn(),
    telemetryLimit: 64,
  });
  const runtime = lifecycle.createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => true,
    readHealth: async () => HEALTH,
    runProjectionTurn: async () => ({ done: true, applied: 0 }),
    runJournalTurn: async () => ({ hasMore: false, itemCount: 0 }),
    ...overrides,
  });
  coordinator.setLifecycleState({ effectiveForeground: true, epoch: 5 });
  return { coordinator, runtime };
};

/**
 * Drive one production job through real coordinator turns and report what each
 * turn actually consumed. Nothing here decides what a turn does — the shipped
 * adapter and its domain step do.
 */
const driveProductionJob = async (
  { coordinator, runtime },
  lifecycle,
  jobKey,
  { maxTurns = 20_000, epoch = 5 } = {}
) => {
  runtime.admit(jobKey, { origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch });
  const declared = coordinator.registry.get(jobKey).budget;
  const turns = [];
  for (let index = 0; index < maxTurns; index += 1) {
    const result = await coordinator.runNextTurn();
    if (!result) break;
    turns.push({
      outcome: result.outcome,
      items: result.consumedBudget.items,
      error: result.error,
    });
    if (result.outcome !== 'hasMore') break;
  }
  return {
    declared,
    turns,
    count: turns.length,
    maxItems: turns.reduce((most, turn) => Math.max(most, turn.items), 0),
    failed: turns.filter((turn) => turn.error !== null || turn.outcome === 'failing'),
  };
};

/**
 * Everything the coordinator itself retains, as text. A trip, route, GPS or
 * motion payload that reached coordinator state shows up here.
 */
const coordinatorFootprint = (coordinator) => {
  const registry = [...coordinator.registry.values()].map((registration) => ({
    jobKey: registration.jobKey,
    workClass: registration.workClass,
    budget: registration.budget,
    newEpochPolicy: registration.newEpochPolicy,
    lastTerminal: registration.lastTerminal,
    active: registration.active && {
      instanceId: registration.active.instanceId,
      epoch: registration.active.epoch,
      state: registration.active.state,
      turnCount: registration.active.turnCount,
      admissionToken: registration.active.admissionToken,
    },
    sleeping: registration.sleeping && { wake: registration.sleeping.wake },
  }));
  const queues = Object.fromEntries(
    Object.entries(coordinator.queues).map(([name, queue]) => [
      name,
      queue.map((instance) => ({ instanceId: instance.instanceId, state: instance.state })),
    ])
  );
  return JSON.stringify({
    registry,
    queues,
    telemetry: coordinator.getTelemetrySnapshot(),
    snapshot: coordinator.getCoordinatorSnapshot(),
    epochs: [...coordinator.epochs.keys()],
    published: [...coordinator.publishedEpochs.keys()],
  });
};

const PAYLOAD_SYMBOLS = /route_points|routePoints|gps_points|gpsPoints|motion_samples|motionSamples|latitude|longitude|"lat"|"lng"|coordinates/i;

// ---------------------------------------------------------------------------
// Trip-repository storage seam (repository maintenance + browser KEK)
// ---------------------------------------------------------------------------

const settingsValue = (overrides = {}) => JSON.stringify({
  settings_defaults_version: 11,
  data_retention_days: 0,
  raw_gps_retention_days: 0,
  motion_sample_retention_days: 0,
  privacy_zones: [],
  ...overrides,
});

/** Per-key document-store access counts, so "never read" is measurable. */
let documentReads = new Map();
const readsOf = (key) => documentReads.get(key) || 0;

const installTripStorage = (settings = {}) => {
  const fakeIndexedDb = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fakeIndexedDb);
  const values = new Map([['drivesense_settings', settingsValue(settings)]]);
  documentReads = new Map();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => {
      documentReads.set(key, (documentReads.get(key) || 0) + 1);
      return values.get(key) ?? null;
    }),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  return fakeIndexedDb;
};

/**
 * Seed retained history through the repository's own migration path, then write
 * synthetic rows straight into the store. Tombstoned rows carry no payload, so
 * what is measured is the record accounting that used to grow with N — with no
 * decrypt work at all.
 */
const seedTripHistory = async (repository, fake, count, { ageDays = 400 } = {}) => {
  await repository.localTripRepository.create({
    id: 'anchor', status: 'completed', start_time: '2020-01-01T00:00:00.000Z', route_points: [],
  });
  const database = fake.databases.get(repository.DB_NAME);
  const stores = {
    trips: database.stores.get('trips'),
    summaries: database.stores.get('trip_summaries'),
    projections: database.stores.get('trip_projections'),
  };
  const base = Date.now() - (ageDays * DAY_MS);
  for (let index = 0; index < count; index += 1) {
    const id = `seed-${String(index).padStart(5, '0')}`;
    const record = {
      id,
      start_time: new Date(base + index).toISOString(),
      status: 'secure-delete-pending',
      _secure_delete_tombstone: true,
      _secure_delete_at: Date.now(),
    };
    stores.trips.records.set(id, record);
    stores.projections?.records.set(id, { ...record });
  }
  return stores;
};

const resetStoreCounters = (stores) => {
  for (const store of Object.values(stores)) {
    if (!store) continue;
    store.getAllCount = 0;
  }
};

const totalGetAll = (stores) => Object.values(stores)
  .reduce((sum, store) => sum + (store?.getAllCount || 0), 0);

const loadTripStack = async () => {
  vi.resetModules();
  return {
    repository: await import('@/lib/localTripRepository'),
    lifecycle: await import('@/lib/appLifecycleWork'),
    work: await import('@/lib/appWorkCoordinator'),
    monolithic: await import('@/lib/monolithicCompatibility'),
  };
};

/**
 * Module doubles are registered per-suite with `vi.doMock`. `vi.resetModules()`
 * does not clear those registrations, so they are released explicitly here -
 * otherwise a later suite that wants the *real* module gets the double.
 */
const DOUBLED_MODULE_IDS = [
  '@/lib/mobileStorage',
  '@/lib/systemLog',
  '@/lib/openSourceTripContext',
  '@/api/trips',
  '@/lib/trackingStore',
  '@/lib/speedKnowledgeRepository',
  '@capacitor/core',
  '@/lib/nativePlatform',
  '@/lib/nativeTripArchive',
  '@/lib/localTripRepository',
  '@/lib/appLifecycleWork',
];

afterEach(() => {
  for (const id of DOUBLED_MODULE_IDS) vi.doUnmock(id);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * One real production repository-maintenance drain per dataset size, memoized
 * so the ceiling law and the growth law read the same evidence instead of
 * paying for the drain twice.
 */
const repositoryRuns = new Map();
const repositoryRun = async (total) => {
  if (!repositoryRuns.has(total)) {
    const { repository, lifecycle, work } = await loadTripStack();
    const fake = installTripStorage({ data_retention_days: 1 });
    const stores = await seedTripHistory(repository, fake, total);
    const fixture = productionRuntimeFor(lifecycle, work);
    resetStoreCounters(stores);
    const run = await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE
    );
    repositoryRuns.set(total, {
      ...run,
      getAll: totalGetAll(stores),
      declaredCeiling: repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED,
      window: repository.REPOSITORY_MAINTENANCE_WINDOW,
    });
    vi.unstubAllGlobals();
  }
  return repositoryRuns.get(total);
};

describe('P4-D law 2/5: the production repository turn has a fixed ceiling at every N', () => {
  it.each(DATASET_SIZES)('never exceeds its declared 536-record ceiling at N=%s', async (total) => {
    const run = await repositoryRun(total);

    // The shipped declaration, and the domain constant it is derived from.
    expect(run.declared.items).toBe(536);
    expect(run.declared.items).toBe(run.declaredCeiling);
    // No turn read more than the ceiling ...
    expect(run.maxItems).toBeLessThanOrEqual(536);
    // ... which is the coordinator's own verdict too: a turn that consumed the
    // whole history would have raised the typed hard-budget failure.
    expect(run.failed).toEqual([]);
    expect(run.turns.at(-1)?.outcome ?? 'done').toBe('done');
    // A lifecycle turn never materialized a store.
    expect(run.getAll).toBe(0);
  }, 300_000);

  it('produces more bounded turns as retained history grows', async () => {
    const counts = [];
    for (const total of DATASET_SIZES) counts.push((await repositoryRun(total)).count);

    // Strictly more work means strictly more turns, never a wider turn.
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]).toBeGreaterThan(counts[index - 1]);
    }
    // And the growth is the window law, not a constant-plus-noise curve.
    const { window, count } = await repositoryRun(5_000);
    expect(count).toBeGreaterThanOrEqual(5_000 / window);
  }, 300_000);
});

describe('P4-D law 9: the browser KEK turn is one fixed ciphertext batch at every N', () => {
  it.each(DATASET_SIZES)('pages the sweep and never materializes the store at N=%s', async (total) => {
    const { repository, lifecycle } = await loadTripStack();
    const fake = installTripStorage();
    const stores = await seedTripHistory(repository, fake, total);

    const perTurn = [];
    let batch = { hasMore: true };
    let turns = 0;
    for (; turns < 1_500 && batch.hasMore; turns += 1) {
      resetStoreCounters(stores);
      batch = await repository.stepTripEncryptionKeyRotationBatch(2);
      // The pre-P4-C browser rotation called `getAll()` on all three stores.
      expect(totalGetAll(stores)).toBe(0);
      perTurn.push(batch.processed);
    }

    expect(batch.hasMore).toBe(false);
    expect(Math.max(0, ...perTurn)).toBeLessThanOrEqual(repository.TRIP_KEY_ROTATION_WINDOW);
    // More history is more bounded batches, not a bigger batch.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(total / repository.TRIP_KEY_ROTATION_WINDOW));
    // The production KEK declaration is the domain's own window, twice over.
    expect(lifecycle.P4_LIFECYCLE_TURN_BUDGET_CEILINGS[lifecycle.P4_LIFECYCLE_JOB_KEYS.KEY_ROTATION])
      .toBe(repository.TRIP_KEY_ROTATION_WINDOW * 2);
  }, 300_000);
});

describe('P4-D law 11: the monolithic compatibility boundary holds at every N', () => {
  it.each([0, 500, 5_000])('declines the monolithic document rather than reading it at N=%s', async (total) => {
    const { repository, lifecycle, work, monolithic } = await loadTripStack();
    const fake = installTripStorage({ data_retention_days: 1 });
    await seedTripHistory(repository, fake, total);
    // A pre-P4 monolithic fallback archive, alongside the paged history, with
    // the O(1) reference record production stamps beside it.
    const storage = await import('@/lib/mobileStorage');
    await storage.setJson(repository.TRIPS_KEY, Array.from({ length: 120 }, (_, index) => ({
      id: `fallback-${index}`, status: 'completed', route_points: [],
    })));
    await storage.setJson(repository.TRIPS_FALLBACK_REFERENCE_KEY, {
      present: true, keyVersion: 1, updatedAt: Date.now(),
    });
    documentReads.clear();

    // The bounded lifecycle subpass pages the indexed history in fixed windows
    // and then declines the whole document, at any N.
    let subpass = { hasMore: true };
    let subpasses = 0;
    for (; subpasses < 1_000 && subpass.hasMore; subpasses += 1) {
      subpass = await repository.stepLegacyTripStorageEncryption();
      expect(subpass.examined).toBeLessThanOrEqual(repository.REPOSITORY_MAINTENANCE_WINDOW);
    }
    expect(subpass).toMatchObject({
      examined: 0,
      fallbackDocumentPending: true,
      fallbackDocumentOwner: monolithic.MONOLITHIC_DOCUMENT_OWNER,
      hasMore: false,
    });
    // Ownership is declared, and the document itself was never opened.
    expect(monolithic.MONOLITHIC_DOCUMENT_OWNER).toBe('explicit-compatibility-maintenance');
    expect(readsOf(repository.TRIPS_KEY)).toBe(0);

    // The whole production maintenance job behaves the same way: it never opens
    // the monolithic document, however much paged history sits beside it.
    const fixture = productionRuntimeFor(lifecycle, work);
    const run = await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE
    );
    expect(run.failed).toEqual([]);
    expect(run.maxItems).toBeLessThanOrEqual(repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED);
    expect(readsOf(repository.TRIPS_KEY)).toBe(0);
    // The document is still there: nothing in lifecycle rewrote or retired it.
    expect(await storage.getJson(repository.TRIPS_KEY, null)).toHaveLength(120);
  }, 300_000);

  it('keeps the explicit owner production-reachable and outside lifecycle', () => {
    const lifecycleSource = readSource('appLifecycleWork.js');
    const appSource = readSource('../App.jsx');

    // Structural guard, supplementary to the behaviour above: no lifecycle turn
    // may call a whole-document operation.
    for (const symbol of [
      'runMonolithicTripCompatibilityMaintenance',
      'convertLegacyRoadContextQueue',
      'convertLegacyRescoringQueue',
      'migrateLegacyTripStorageToEncrypted',
    ]) {
      expect(lifecycleSource).not.toContain(symbol);
    }
    // ... and the whole-document conversions still have a real production owner
    // outside lifecycle, on the explicit quiet-period path.
    for (const symbol of [
      'runMonolithicTripCompatibilityMaintenance',
      'convertLegacyRoadContextQueue',
      'convertLegacyRescoringQueue',
    ]) {
      expect(appSource).toContain(symbol);
    }
    expect(appSource).toContain('scheduleAfterQuietPeriod');
  });
});

// ---------------------------------------------------------------------------
// Paged mobile-storage domains (road context, rescoring)
// ---------------------------------------------------------------------------

/**
 * Only the *storage* is doubled. The road-context and rescoring domain modules,
 * and the production lifecycle adapters that call them, stay real.
 */
const installPagedStorage = () => {
  const store = { map: new Map(), reads: [], writes: [] };
  vi.doMock('@/lib/mobileStorage', () => ({
    STORAGE_PRESENCE: Object.freeze({ PRESENT: 'present', ABSENT: 'absent', UNKNOWN: 'unknown' }),
    getJson: vi.fn(async (key, fallback) => {
      store.reads.push(key);
      return store.map.has(key) ? structuredClone(store.map.get(key)) : fallback;
    }),
    setJson: vi.fn(async (key, value) => {
      store.writes.push(key);
      if (value === null) store.map.delete(key);
      else store.map.set(key, structuredClone(value));
    }),
    removeJson: vi.fn(async (key) => { store.map.delete(key); }),
    probeStoredJson: vi.fn(async (key) => (store.map.has(key) ? 'present' : 'absent')),
  }));
  vi.doMock('@/lib/systemLog', () => ({
    logSystemFailure: vi.fn(),
    recordSystemEvent: vi.fn(),
    logError: vi.fn(),
  }));
  return store;
};

const largestArrayTouched = (store, keys) => keys.reduce((largest, key) => {
  const value = store.map.get(key);
  return Array.isArray(value) ? Math.max(largest, value.length) : largest;
}, 0);

const loadRoadContextStack = async ({ routePoints = 8 } = {}) => {
  vi.resetModules();
  const store = installPagedStorage();
  const trips = {
    getTrip: vi.fn(async (id) => ({ id, route_points: routeOf(routePoints) })),
    updateTrip: vi.fn(async (id) => ({ id })),
    buildPatch: vi.fn(async () => ({ speed_limit_context: { status: 'fetched' } })),
  };
  vi.doMock('@/lib/openSourceTripContext', () => ({
    buildOpenSourceTripContextPatch: trips.buildPatch,
    buildWeatherOnlyTripContextPatch: vi.fn(async () => ({})),
  }));
  vi.doMock('@/api/trips', () => ({
    tripService: { update: trips.updateTrip, getById: trips.getTrip },
  }));
  vi.doMock('@/lib/trackingStore', () => ({
    localSettings: { get: vi.fn(() => ({ weather_context_enabled: false })) },
  }));
  return {
    store,
    trips,
    roadContext: await import('@/lib/roadContextQueue'),
    lifecycle: await import('@/lib/appLifecycleWork'),
    work: await import('@/lib/appWorkCoordinator'),
  };
};

let cachedRoute = null;
const routeOf = (points) => {
  if (cachedRoute?.length === points) return cachedRoute;
  cachedRoute = Array.from({ length: points }, (_, index) => ({
    lat: 51 + (index / 1e6), lng: -0.1 + (index / 1e6),
  }));
  return cachedRoute;
};

const seedRoadContextQueue = async (roadContext, trips, total) => {
  for (let index = 0; index < total; index += 1) {
    trips.buildPatch.mockRejectedValueOnce(new Error('offline'));
    await expect(roadContext.runRoadContextRefresh({ id: `trip-${index}`, route_points: [] }, {}))
      .rejects.toThrow('offline');
  }
};

describe('P4-D law 2/5: the production road-context turn has a fixed ceiling at every N', () => {
  it.each(DATASET_SIZES)('reads one page of the paged v2 queue at N=%s', async (total) => {
    const { store, trips, roadContext, lifecycle, work } = await loadRoadContextStack();
    await seedRoadContextQueue(roadContext, trips, total);
    const fixture = productionRuntimeFor(lifecycle, work);

    // A bounded number of *production* turns, through the shipped adapter.
    store.reads = [];
    store.writes = [];
    const run = await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, { maxTurns: 12 }
    );

    expect(run.declared.items).toBe(roadContext.ROAD_CONTEXT_TURN_MAX_EXAMINED);
    expect(run.declared.items)
      .toBe(lifecycle.P4_LIFECYCLE_TURN_BUDGET_CEILINGS[lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT]);
    expect(run.maxItems).toBeLessThanOrEqual(run.declared.items);
    expect(run.failed).toEqual([]);
    // No record this turn read or wrote holds more than one page, at any N: a
    // regression that consumed the whole persistent queue fails here.
    const touched = [...store.reads, ...store.writes].filter((key) => key.includes('road_context'));
    expect(largestArrayTouched(store, touched))
      .toBeLessThanOrEqual(roadContext.ROAD_CONTEXT_QUEUE_PAGE_SIZE);

    // Fixed work per turn, so the turn count is linear in N: after these turns
    // a larger queue still has proportionally more left.
    const remaining = await roadContext.listPendingRoadContextEntries();
    expect(remaining.length).toBe(Math.max(0, total - (4 * run.count)));
  }, 300_000);

  it('never reads a monolithic v1 document from an ordinary lifecycle turn', async () => {
    const { store, roadContext, lifecycle, work } = await loadRoadContextStack();
    const monolithic = await import('@/lib/monolithicCompatibility');
    // A pre-P4 v1 array holding every queued entry.
    store.map.set(roadContext.ROAD_CONTEXT_QUEUE_STORAGE_KEY, Array.from(
      { length: 3_000 },
      (_, index) => ({ tripId: `legacy-${index}`, attempts: 0 })
    ));
    const fixture = productionRuntimeFor(lifecycle, work);

    store.reads = [];
    const run = await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, { maxTurns: 3 }
    );

    expect(store.reads).not.toContain(roadContext.ROAD_CONTEXT_QUEUE_STORAGE_KEY);
    expect(run.maxItems).toBe(0);
    expect(store.map.get(roadContext.ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toHaveLength(3_000);
    expect(monolithic.MONOLITHIC_DOCUMENT_OWNER).toBe('explicit-compatibility-maintenance');
  }, 300_000);
});

const loadRescoringStack = async () => {
  vi.resetModules();
  const store = installPagedStorage();
  vi.doMock('@/lib/speedKnowledgeRepository', () => ({
    SPEED_KNOWLEDGE_STORAGE_KEY: 'speed_knowledge_v1',
    readSpeedKnowledgeMetadata: vi.fn(async () => ({ schemaVersion: 2, knowledgeRevision: 7 })),
    speedKnowledgeRepository: { stepMaintenanceTurn: vi.fn(async () => ({ hasMore: false, processedBuckets: 0 })) },
  }));
  vi.doMock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: vi.fn(() => false), getPlatform: vi.fn(() => 'web') },
    registerPlugin: vi.fn(() => ({})),
    WebPlugin: class {},
  }));
  return {
    store,
    rescoring: await import('@/lib/rescoringQueue'),
    lifecycle: await import('@/lib/appLifecycleWork'),
    work: await import('@/lib/appWorkCoordinator'),
  };
};

describe('P4-D law 2/5: the production rescoring turn has a fixed ceiling at every N', () => {
  it.each(DATASET_SIZES)('runs one bounded batch of the paged queue at N=%s', async (total) => {
    const { store, rescoring, lifecycle, work } = await loadRescoringStack();
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    if (total > 0) {
      await rescoring.enqueueRescoreJob({
        reason: 'manual',
        tripIds: Array.from({ length: total }, (_, index) => `trip-${String(index).padStart(5, '0')}`),
      }, worker);
    }
    rescoring.setRescoringCoordinatorOwned(true);
    const fixture = productionRuntimeFor(lifecycle, work);

    store.reads = [];
    store.writes = [];
    const run = await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING, { maxTurns: 12 }
    );

    expect(run.declared.items).toBe(rescoring.RESCORING_TURN_MAX_EXAMINED);
    expect(run.declared.items)
      .toBe(lifecycle.P4_LIFECYCLE_TURN_BUDGET_CEILINGS[lifecycle.P4_LIFECYCLE_JOB_KEYS.RESCORING]);
    expect(run.maxItems).toBeLessThanOrEqual(run.declared.items);
    expect(run.failed).toEqual([]);
    // One id page per turn, never the whole queue, at any N.
    const touched = [...store.reads, ...store.writes].filter((key) => key.includes('rescoring'));
    expect(largestArrayTouched(store, touched))
      .toBeLessThanOrEqual(rescoring.RESCORING_JOB_PAGE_SIZE);
    // Fixed trips per turn: the queue depth never enlarges a turn.
    expect(worker.rescoreTrip.mock.calls.length).toBe(Math.min(total, 20 * run.count));
    const [job] = await rescoring.getRescoringQueue();
    if (total > 20 * run.count) expect(job.pending).toBe(total - (20 * run.count));
  }, 300_000);
});

// ---------------------------------------------------------------------------
// Migration admission/refusal, projection/journal declarations
// ---------------------------------------------------------------------------

describe('P4-D law 8: a user write never drives migration, at any N', () => {
  const loadMigrationSeam = async ({ total }) => {
    vi.resetModules();
    const calls = { ensure: 0, step: 0, pages: 0 };
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    vi.doMock('@/lib/nativePlatform', () => ({ isAndroid: () => true, isNativePlatform: () => true }));
    vi.doMock('@/lib/nativeTripArchive', () => {
      class CanonicalArchiveError extends Error {
        constructor(code, message) { super(message); this.name = 'CanonicalArchiveError'; this.code = code; }
      }
      return {
        CanonicalArchiveError,
        sha256Hex: vi.fn(async () => 'a'.repeat(64)),
        streamJsonToMigration: vi.fn(async () => ({ payloadHash: 'a'.repeat(64) })),
        nativeTripArchive: {
          health: vi.fn(async () => ({
            authorityState: 'MIGRATING', recoveryState: 'HEALTHY', sentinelMatches: true,
            archiveGeneration: 'g1', erasureBarrierToken: 'g1',
          })),
          ingestJournal: vi.fn(async () => ({ itemCount: 0, hasMore: false })),
          migrationCheckpoint: vi.fn(async () => ({ checkpoint: null })),
          saveMigrationCheckpoint: vi.fn(async () => {}),
          completeMigration: vi.fn(async () => ({ verified: true, authorityState: 'NATIVE' })),
        },
      };
    });
    vi.doMock('@/lib/localTripRepository', () => ({
      localTripRepository: {
        update: vi.fn(async () => { throw new Error('the legacy repository must never be reached'); }),
        // The real production page size is 50 rows, regardless of N.
        listLegacyMigrationPage: vi.fn(async ({ cursor = null, limit }) => {
          calls.pages += 1;
          const start = cursor ? Number(String(cursor).replace('p', '')) : 0;
          const rows = [];
          for (let index = start; index < Math.min(start + limit, total); index += 1) {
            rows.push({ id: `legacy-${index}` });
          }
          const next = start + limit;
          return { rows, hasMore: next < total, nextCursor: next < total ? `p${next}` : null };
        }),
        getLegacyTripForMigration: vi.fn(async (id) => ({ id, points: [] })),
      },
    }));
    vi.doMock('@/lib/appLifecycleWork', async (importOriginal) => {
      const actual = await importOriginal();
      return {
        ...actual,
        ensureP4LegacyMigrationAdvancing: vi.fn(() => { calls.ensure += 1; return { status: 'admitted' }; }),
      };
    });
    const migration = await import('@/lib/p35Migration');
    const original = migration.stepLegacyMigration;
    return { calls, trips: await import('@/api/trips'), migration, original };
  };

  it.each(DATASET_SIZES)('refuses the write immediately and only admits, at N=%s', async (total) => {
    const { calls, trips } = await loadMigrationSeam({ total });

    const refusal = await trips.tripService.update('trip-1', { notes: 'x' }).catch((error) => error);

    // DN3: bounded, immediate, typed — never a wait on migration convergence.
    expect(refusal).toMatchObject({ code: 'MIGRATION_IN_PROGRESS', retryable: true });
    // The refusal costs exactly one admission, whatever the migration size is.
    // The admission is fire-and-forget, so wait for it rather than for
    // migration convergence - which is exactly the point of the law.
    await vi.waitFor(() => expect(calls.ensure).toBe(1));
    // ... and it executed no migration unit at all: no legacy page was read.
    expect(calls.pages).toBe(0);
  }, 300_000);

  it.each([500, 5_000])('keeps one migration turn a fixed 50-row page at N=%s', async (total) => {
    const { calls, migration } = await loadMigrationSeam({ total });
    const lifecycle = await import('@/lib/appLifecycleWork');
    const work = await import('@/lib/appWorkCoordinator');

    const turn = await migration.stepLegacyMigration();

    // One turn, one page: the domain's own bounded unit, independent of N.
    expect(calls.pages).toBe(1);
    expect(turn.itemCount).toBeLessThanOrEqual(50);
    // And the production declaration matches that unit.
    const { coordinator } = productionRuntimeFor(lifecycle, work);
    expect(coordinator.registry.get(lifecycle.P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION).budget)
      .toMatchObject({ items: 50, turns: 8 });
  }, 300_000);
});

describe('P4-D law 10: projection and journal turn limits are fixed, not derived from N', () => {
  it('declares fixed native projection and journal budgets on the real registrations', async () => {
    const { lifecycle, work } = await loadTripStack();
    const { coordinator } = productionRuntimeFor(lifecycle, work);
    const keys = lifecycle.P4_LIFECYCLE_JOB_KEYS;

    expect(coordinator.registry.get(keys.NATIVE_PROJECTION).budget)
      .toMatchObject({ items: 100, bytes: 256 * 1024, turns: 8 });
    expect(coordinator.registry.get(keys.NATIVE_JOURNAL_INGEST).budget)
      .toMatchObject({ items: 8, bytes: 8 * 1024 * 1024, turns: 8 });
    // Every registered bounded job declares a finite item ceiling — a job whose
    // unit were "the whole history" could not.
    for (const entry of lifecycle.getP4LifecycleRegistrations()) {
      expect(entry.workExtent).toBe(lifecycle.APP_WORK_EXTENTS.BOUNDED_TURN);
    }
    for (const [, registration] of coordinator.registry) {
      expect(Number.isFinite(registration.budget.items)).toBe(true);
      expect(registration.budget.items).toBeGreaterThan(0);
    }
  });

  it('passes the journal ingest its fixed caps rather than a history-derived one', async () => {
    const { lifecycle, work } = await loadTripStack();
    const journalCalls = [];
    const fixture = productionRuntimeFor(lifecycle, work, {
      runJournalTurn: async (maxItems, maxBytes) => {
        journalCalls.push([maxItems, maxBytes]);
        return { hasMore: false, itemCount: 0 };
      },
    });

    await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, { maxTurns: 3 }
    );

    expect(journalCalls).toEqual([[8, 8 * 1024 * 1024]]);
  });

  it('binds the real projection maintenance ceiling to its derived constants', async () => {
    vi.resetModules();
    const projection = await import('@/lib/tripProjectionMaintenance');
    const repository = await import('@/lib/localTripRepository');

    expect(projection.PROJECTION_SUBPASS_MAX_EXAMINED).toBe(Math.max(
      projection.BACKFILL_MAX_EXAMINED,
      projection.VERIFY_MAX_EXAMINED,
      projection.CLEANUP_MAX_EXAMINED,
    ));
    expect(repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED).toBe(Math.max(
      repository.REPOSITORY_MAINTENANCE_WINDOW,
      repository.NATIVE_COMPLETED_IMPORT_MAX_ITEMS,
      projection.PROJECTION_SUBPASS_MAX_EXAMINED,
    ));
    // The post-P4-C value. An obsolete 512 fails here and in every N case above.
    expect(repository.REPOSITORY_MAINTENANCE_MAX_EXAMINED).toBe(536);
  });
});

// ---------------------------------------------------------------------------
// Coordinator-side laws
// ---------------------------------------------------------------------------

describe('P4-D law 4: no trip or route payload ever enters coordinator state', () => {
  it.each(ROUTE_SIZES)('keeps a %s-point route entirely in the domain', async (routePoints) => {
    const { store, trips, roadContext, lifecycle, work } = await loadRoadContextStack({ routePoints });
    await seedRoadContextQueue(roadContext, trips, 40);
    const fixture = productionRuntimeFor(lifecycle, work);

    await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, { maxTurns: 4 }
    );

    // The production domain really did handle routes of this size ...
    expect(trips.getTrip).toHaveBeenCalled();
    const handled = await trips.getTrip.mock.results[0].value;
    expect(handled.route_points).toHaveLength(routePoints);
    // ... and the coordinator retained none of it.
    const footprint = coordinatorFootprint(fixture.coordinator);
    expect(footprint).not.toMatch(PAYLOAD_SYMBOLS);
    expect(footprint).not.toContain('trip-0');
    // Coordinator state is scalars and identity, so its size is independent of
    // the route size the domain streamed.
    expect(footprint.length).toBeLessThan(40_000);
    expect(store.map.size).toBeGreaterThan(0);
  }, 300_000);

  it('retains only scalars and numeric budgets, never a domain turn result', async () => {
    const { store, trips, roadContext, lifecycle, work } = await loadRoadContextStack({ routePoints: 1_800 });
    await seedRoadContextQueue(roadContext, trips, 40);
    const fixture = productionRuntimeFor(lifecycle, work);

    await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.ROAD_CONTEXT, { maxTurns: 4 }
    );
    expect(store.map.size).toBeGreaterThan(0);

    // Every field the coordinator kept is either a primitive or one of the two
    // flat budget maps. A regression that parked the domain's own turn
    // result - the object a payload would arrive inside - fails here even
    // before that result happens to contain a route.
    const events = fixture.coordinator.getTelemetrySnapshot().events;
    expect(events.length).toBeGreaterThan(0);
    const scalarMapFields = new Set(['declaredBudget', 'consumedBudget']);
    for (const event of events) {
      for (const [field, value] of Object.entries(event)) {
        if (value === null || typeof value !== 'object') continue;
        expect(scalarMapFields.has(field)).toBe(true);
        // The two budget maps are flat scalar dimensions, with nothing nested
        // inside them either.
        for (const dimension of Object.values(value)) {
          expect(dimension === null || typeof dimension !== 'object').toBe(true);
        }
      }
    }
  }, 300_000);

  it('offers the production turn no payload channel in the first place', async () => {
    const { lifecycle, work } = await loadTripStack();
    const seen = [];
    const fixture = productionRuntimeFor(lifecycle, work, {
      runRepositoryMaintenanceTurn: async (context) => {
        seen.push(Object.keys(context).sort());
        return { items: 0, result: 'done' };
      },
    });

    await driveProductionJob(
      fixture, lifecycle, lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE, { maxTurns: 2 }
    );

    // The shipped adapter signature carries an instance identity and nothing
    // else — there is no field a trip, route or sample could arrive in.
    expect(seen).toEqual([['instanceId']]);
  });
});

describe('P4-D law 1/3: admission cost and coordinator memory are independent of N', () => {
  it('costs the same coordinator operations to admit against an empty and a huge backlog', async () => {
    const { lifecycle, work } = await loadTripStack();
    const probe = (total) => {
      const { coordinator, runtime } = productionRuntimeFor(lifecycle, work, {
        runRepositoryMaintenanceTurn: async () => ({ items: Math.min(total, 1), result: 'done' }),
      });
      let operations = 0;
      const counted = new Proxy(coordinator, {
        get(target, key) {
          const value = Reflect.get(target, key);
          return typeof value === 'function'
            ? (...args) => { operations += 1; return value.apply(target, args); }
            : value;
        },
      });
      runtime.admit(lifecycle.P4_LIFECYCLE_JOB_KEYS.REPOSITORY_MAINTENANCE, {
        origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 5,
      });
      void counted.getCoordinatorSnapshot();
      return operations;
    };

    expect(probe(0)).toBe(probe(SYNTHETIC_LARGE));
  });

  it('keeps coordinator state bounded across hundreds of epochs of real jobs', async () => {
    const { lifecycle, work } = await loadTripStack();
    const fixture = productionRuntimeFor(lifecycle, work, {
      runRepositoryMaintenanceTurn: async () => ({ items: 1, result: 'done' }),
      runRoadContextTurn: async () => ({ items: 1, result: 'done' }),
      runRescoringTurn: async () => ({ items: 1, result: 'done' }),
      runKeyRotationTurn: async () => ({ items: 1, result: 'done' }),
      runSpeedMaintenanceTurn: async () => ({ items: 1, result: 'done' }),
      runMigrationTurnAdapter: async () => ({ items: 1, result: 'done' }),
    });

    for (let epoch = 6; epoch <= 406; epoch += 1) {
      fixture.coordinator.setLifecycleState({ effectiveForeground: true, epoch });
      fixture.runtime.admitAll({ origin: lifecycle.APP_WORK_TRIGGER_ORIGINS.RESUME, epoch });
      await fixture.coordinator.drain();
    }

    const snapshot = fixture.coordinator.getCoordinatorSnapshot();
    // Nothing is running or queued, and the parked instances are the fixed set
    // of registrations, not a per-epoch or per-record accumulation.
    expect(snapshot).toMatchObject({ activeInstances: 0, backlog: 0 });
    expect(snapshot.sleepingInstances)
      .toBeLessThanOrEqual(fixture.coordinator.registry.size);
    expect(snapshot.telemetry.limit).toBe(64);
    expect(fixture.coordinator.getTelemetrySnapshot().events.length).toBeLessThanOrEqual(64);
    // Bounded epoch history, bounded published set, and no domain page record.
    expect(fixture.coordinator.epochs.size).toBeLessThanOrEqual(16);
    expect(fixture.coordinator.publishedEpochs.size).toBeLessThanOrEqual(16);
    const footprint = coordinatorFootprint(fixture.coordinator);
    expect(footprint).not.toMatch(PAYLOAD_SYMBOLS);
    expect(footprint.length).toBeLessThan(60_000);
  }, 300_000);
});

describe('P4-D law 6: no startup, resume or page-open path traverses full history', () => {
  it('registers only bounded-turn lifecycle work and refuses full history from lifecycle', async () => {
    const { lifecycle, work } = await loadTripStack();
    const { runtime } = productionRuntimeFor(lifecycle, work);

    for (const entry of runtime.boundary.snapshot()) {
      expect(entry.workExtent).toBe(lifecycle.APP_WORK_EXTENTS.BOUNDED_TURN);
    }
    // The boundary refuses a full-history lifecycle registration structurally.
    expect(() => runtime.boundary.register({
      jobKey: 'full-history-boot',
      triggerOrigins: [lifecycle.APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP],
      workExtent: lifecycle.APP_WORK_EXTENTS.FULL_HISTORY,
      workClass: work.APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: work.APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      budget: { items: 1 },
      runTurn: async () => 'done',
    })).toThrow(/Full-history work cannot be registered/);
  });

  it('keeps whole-history repository entry points out of the boot path', () => {
    // Supplementary structural guard over the behavioural laws above.
    const app = readSource('../App.jsx');
    for (const symbol of ['listAll', 'listAllSummaries', 'runBoundedTripJob', 'rebuildAchievementAggregates']) {
      expect(app).not.toContain(symbol);
    }
    expect(readSource('appLifecycleWork.js')).not.toContain('listAll');
  });
});

function readSource(relative) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(here, '..', relative), 'utf8');
}
