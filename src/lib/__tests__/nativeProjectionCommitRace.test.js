import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-B-F02 regressions.
 *
 * The projection turn read the canonical generation fence and then committed
 * its rows and checkpoint into disposable IndexedDB as a *separate* async step.
 * A generation rollover or a data-rights erasure landing in that window left G1
 * projection rows and a G1 checkpoint behind after authority had moved to G2.
 *
 * These are real race fixtures: the real repository commit path, the real
 * projection maintenance turn, the real domain barrier and the real coordinator
 * invalidation, paused at the exact point the finding describes.
 */

const archive = vi.hoisted(() => ({
  generation: 'g1',
  lastCommittedSeq: 5,
  health: vi.fn(),
  queryHistoryPage: vi.fn(),
  projectionFeed: vi.fn(),
  metadata: vi.fn(),
  eraseGeneration: vi.fn(),
  reportIndexedDbOpen: vi.fn(async () => undefined),
}));

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: archive,
  CanonicalArchiveError: class CanonicalArchiveError extends Error {},
  readNativeTripPayload: vi.fn(),
  iterateNativeTripJsonArray: vi.fn(),
  streamJsonToCanonicalCommit: vi.fn(),
}));

/**
 * Only `logSystemFailure` is replaced, so a test can make the logger itself
 * throw. Everything else in the module keeps its real behaviour.
 */
const logger = vi.hoisted(() => ({ impl: vi.fn() }));
vi.mock('@/lib/systemLog', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, logSystemFailure: (...args) => logger.impl(...args) };
});

import {
  DB_NAME,
  NATIVE_PROJECTION_STATE_KEY,
  TRIP_META_STORE,
  TRIP_PROJECTION_STORE,
  readNativeProjectionState,
} from '@/lib/localTripRepository';
import { runNativeProjectionTurn } from '@/lib/nativeProjectionMaintenance';
import {
  PROJECTION_DISCARD_MAX_ATTEMPTS,
  __resetProjectionDiscardStateForTests,
  hasPendingProjectionDiscard,
  pendingProjectionDiscardSnapshot,
  runCanonicalGenerationRollover,
} from '@/lib/nativeProjectionBarrier';
import { nativeTripRepository } from '@/lib/nativeTripRepository';
import {
  APP_WORK_TRIGGER_ORIGINS,
  P4_LIFECYCLE_JOB_KEYS,
  createP4LifecycleWorkRuntime,
} from '@/lib/appLifecycleWork';
import { createAppWorkCoordinator } from '@/lib/appWorkCoordinator';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

const PROJECTION = P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION;

/**
 * A fake IndexedDB that can hold exactly one `open` call open, so a test can
 * pause a projection turn *after* its last successful generation fence and
 * *before* its commit becomes durable.
 */
class GatedIndexedDb extends FakeIndexedDb {
  constructor() {
    super();
    this.openCount = 0;
    this.gateOpenNumber = 0;
    this.failOpenNumber = 0;
    this.failAll = false;
    this.reached = null;
    this._release = null;
  }

  /** Arm the gate on the nth `open` from now, and reset the counter. */
  gateOpen(nth) {
    this.openCount = 0;
    this.gateOpenNumber = nth;
    this.reached = new Promise((resolve) => { this._reachedResolve = resolve; });
  }

  /** Make the nth `open` from now fail, so a real IDB write path can throw. */
  failOpen(nth) {
    this.openCount = 0;
    this.failOpenNumber = nth;
  }

  /** Fail every `open` until `healStorage()` is called. */
  failAllOpens() {
    this.failAll = true;
  }

  healStorage() {
    this.failAll = false;
    this.failOpenNumber = 0;
  }

  release() {
    const release = this._release;
    this._release = null;
    this.gateOpenNumber = 0;
    release?.();
  }

  open(name, version) {
    this.openCount += 1;
    if (this.failAll || this.openCount === this.failOpenNumber) {
      if (!this.failAll) this.failOpenNumber = 0;
      const failed = {
        error: new Error('Injected IndexedDB open failure'),
        result: undefined, transaction: null,
        onerror: null, onsuccess: null, onupgradeneeded: null,
      };
      queueMicrotask(() => failed.onerror?.({ target: failed }));
      return failed;
    }
    if (this.openCount !== this.gateOpenNumber) return super.open(name, version);
    const outer = {
      error: null, result: undefined, transaction: null,
      onerror: null, onsuccess: null, onupgradeneeded: null,
    };
    this._release = () => {
      const inner = super.open(name, version);
      inner.onupgradeneeded = (event) => {
        outer.result = inner.result;
        outer.transaction = inner.transaction;
        outer.onupgradeneeded?.({ ...event, target: outer });
      };
      inner.onsuccess = () => { outer.result = inner.result; outer.onsuccess?.({ target: outer }); };
      inner.onerror = () => { outer.error = inner.error; outer.onerror?.({ target: outer }); };
    };
    this._reachedResolve?.();
    return outer;
  }
}

let fake;

const healthFor = (generation) => ({
  authorityState: 'NATIVE',
  recoveryState: 'HEALTHY',
  sentinelMatches: true,
  archiveGeneration: generation,
  erasureBarrierToken: generation,
  lastCommittedSeq: archive.lastCommittedSeq,
});

const storeRecords = (name) => [
  ...(fake.databases.get(DB_NAME)?.stores.get(name)?.records.values() || []),
];

const projectionRowsFor = (generation) => storeRecords(TRIP_PROJECTION_STORE)
  .filter((record) => String(record?.native_generation || '') === generation);

const storedCheckpoint = () => storeRecords(TRIP_META_STORE)
  .find((record) => record?.key === NATIVE_PROJECTION_STATE_KEY) || null;

const makeRuntime = ({ available = true } = {}) => {
  const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const runtime = createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => available,
    readHealth: () => archive.health(),
    runProjectionTurn: (options) => runNativeProjectionTurn(options),
    runJournalTurn: vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
    runMilestoneReconciliationTurn: vi.fn(async () => ({ items: 0, result: 'done' })),
  });
  return { coordinator, runtime };
};

describe('P4-B-F02: projection commit cannot outlive its generation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    logger.impl = vi.fn();
    __resetProjectionDiscardStateForTests();
    fake = new GatedIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    archive.generation = 'g1';
    archive.health.mockImplementation(async () => healthFor(archive.generation));
    archive.queryHistoryPage.mockImplementation(async () => ({
      items: [{ id: 'trip-a', revision: 1, start_time: '2026-07-01T09:00:00.000Z', status: 'completed' }],
      nextCursor: 'page-2',
    }));
    archive.eraseGeneration.mockImplementation(async () => {
      archive.generation = 'g2';
      return { verified: true, generation: 'g2' };
    });
    // Warm the db-name migration and create the stores, so the gated open below
    // is unambiguously the commit's own open.
    await readNativeProjectionState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves no G1 rows or checkpoint when a G2 rollover races the commit', async () => {
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 1,
    });

    // 1-4: run the turn, project the bounded page, pass the last G1 fence, and
    // pause before the disposable commit becomes durable.
    fake.gateOpen(2);
    const drained = coordinator.drain();
    await fake.reached;
    expect(projectionRowsFor('g1')).toHaveLength(0);

    // 5: canonical generation rolls to G2, plus the normal prompt invalidation.
    const rollover = runCanonicalGenerationRollover(
      () => archive.eraseGeneration('generation_rollover'),
      { reason: 'generation_rollover' }
    );
    runtime.invalidateAuthoritySensitiveWork('canonical_generation_rollover');

    // 6: resume the original G1 turn.
    fake.release();
    await drained;
    await rollover;

    expect(projectionRowsFor('g1')).toEqual([]);
    expect(storedCheckpoint()).toBeNull();
    await expect(readNativeProjectionState()).resolves.toBeNull();
    // The G1 instance cannot settle as a successful continuation either.
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete' });
  });

  it('leaves no G1 rows or checkpoint when a data-rights erasure races the commit', async () => {
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 2,
    });

    fake.gateOpen(2);
    const drained = coordinator.drain();
    await fake.reached;

    // The production erasure path, not a hand-rolled stand-in.
    const erasure = nativeTripRepository.eraseAll();
    runtime.invalidateAuthoritySensitiveWork('trip_generation_erased');

    fake.release();
    await drained;
    await expect(erasure).resolves.toMatchObject({ verified: true });

    expect(projectionRowsFor('g1')).toEqual([]);
    expect(storedCheckpoint()).toBeNull();
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete' });
  });

  it('refuses the commit outright when the rollover wins the barrier first', async () => {
    // Pause before the turn even reads its checkpoint, so the rollover completes
    // while nothing holds the barrier: the in-barrier fence must then refuse.
    fake.gateOpen(1);
    const turn = runNativeProjectionTurn({ expectedGeneration: 'g1' });
    await fake.reached;
    await runCanonicalGenerationRollover(
      () => archive.eraseGeneration('generation_rollover'),
      { reason: 'generation_rollover' }
    );
    fake.release();

    await expect(turn).resolves.toMatchObject({
      obsolete: true,
      reason: 'canonical_generation_changed',
    });
    expect(projectionRowsFor('g1')).toEqual([]);
    expect(storedCheckpoint()).toBeNull();
  });

  it('rebuilds the new generation in bounded turns without a further user resume', async () => {
    await runCanonicalGenerationRollover(
      () => archive.eraseGeneration('generation_rollover'),
      { reason: 'generation_rollover' }
    );
    archive.queryHistoryPage.mockImplementation(async ({ cursor = null }) => (
      cursor
        ? { items: [{ id: 'trip-c', revision: 1, start_time: '2026-07-03T09:00:00.000Z', status: 'completed' }], nextCursor: null }
        : { items: [{ id: 'trip-b', revision: 1, start_time: '2026-07-02T09:00:00.000Z', status: 'completed' }], nextCursor: 'page-2' }
    ));

    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 3,
    });
    await coordinator.drain();

    // One external admission, several bounded tail continuations, no second
    // resume needed - and every page request stayed within the frozen bound.
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(archive.queryHistoryPage.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of archive.queryHistoryPage.mock.calls) {
      expect(request.maxItems).toBe(100);
      expect(request.maxBytes).toBe(256 * 1024);
    }
    expect(projectionRowsFor('g1')).toEqual([]);
    expect(projectionRowsFor('g2').length).toBeGreaterThan(0);
    await expect(readNativeProjectionState()).resolves.toMatchObject({ generation: 'g2' });
  });

  // ── Closure: cleanup and logging may never change a verified canonical result ──

  /** Commit one real G1 page so there is stale derived state to discard. */
  const seedG1Projection = async () => {
    await runNativeProjectionTurn({ expectedGeneration: 'g1' });
    expect(projectionRowsFor('g1').length).toBeGreaterThan(0);
    expect(storedCheckpoint()).not.toBeNull();
  };

  it('keeps a verified erasure verified when the projection discard fails', async () => {
    await seedG1Projection();
    fake.failOpen(1);

    await expect(nativeTripRepository.eraseAll()).resolves.toMatchObject({ verified: true });

    // The disposable rows physically survived the failed discard...
    expect(projectionRowsFor('g1').length).toBeGreaterThan(0);
    // ...but the projection is fail-closed: the superseded checkpoint is
    // unreadable, so nothing can resume from it.
    expect(hasPendingProjectionDiscard()).toBe(true);
    expect(pendingProjectionDiscardSnapshot()).toMatchObject({ attempts: 1 });
    await expect(readNativeProjectionState()).resolves.toBeNull();
    expect(logger.impl).toHaveBeenCalledWith(
      'native_projection_discard_after_generation_rollover',
      expect.any(Error),
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('refuses to commit over a superseded generation while its discard is pending', async () => {
    await seedG1Projection();
    fake.failOpen(1);
    await nativeTripRepository.eraseAll();

    // The next turn's own bounded retry fails too, so it defers instead of
    // writing G2 rows on top of undiscarded G1 state. The suppressed checkpoint
    // read opens nothing, so the retry's discard is this turn's first open.
    fake.failOpen(1);
    // Within the automatic allowance this is a continuation, not a deferral:
    // the same logical instance retries on its next coordinated turn.
    await expect(runNativeProjectionTurn({ expectedGeneration: 'g2' })).resolves.toEqual({
      retry: true,
      reason: 'projection_discard_pending',
    });
    expect(hasPendingProjectionDiscard()).toBe(true);
    expect(projectionRowsFor('g2')).toEqual([]);
  });

  /** A two-page G2 catalog so a rebuild converges instead of looping. */
  const twoPageG2Catalog = () => {
    archive.queryHistoryPage.mockImplementation(async ({ cursor = null }) => (
      cursor
        ? { items: [{ id: 'trip-c', revision: 1, start_time: '2026-07-03T09:00:00.000Z', status: 'completed' }], nextCursor: null }
        : { items: [{ id: 'trip-b', revision: 1, start_time: '2026-07-02T09:00:00.000Z', status: 'completed' }], nextCursor: 'page-2' }
    ));
  };

  it('retries the discard automatically, with no further admission of any kind', async () => {
    await seedG1Projection();
    twoPageG2Catalog();

    // One admission, before the failure exists. Nothing external happens after.
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 5,
    });
    const admitSpy = vi.spyOn(coordinator, 'admit');

    // The erasure's own discard fails, and so do the next two coordinated
    // retries; then storage comes back on its own.
    fake.failAllOpens();
    await nativeTripRepository.eraseAll();
    expect(hasPendingProjectionDiscard()).toBe(true);

    await coordinator.runNextTurn();
    expect(hasPendingProjectionDiscard()).toBe(true);
    expect(pendingProjectionDiscardSnapshot()).toMatchObject({ attempts: 2 });
    // The instance stayed live and re-queued itself behind the mandatory
    // background yield: no sleep, no external wake, no tight spin.
    const queued = coordinator.getJobSnapshot(PROJECTION).active;
    expect(queued.instanceId).toBe(admission.instanceId);
    expect(['continuing', 'yielded']).toContain(queued.state);

    fake.healStorage();
    await coordinator.drain();

    // Cleanup ran on its own next bounded turn, and the rebuild converged.
    expect(hasPendingProjectionDiscard()).toBe(false);
    expect(projectionRowsFor('g1')).toEqual([]);
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
    });
    await expect(readNativeProjectionState()).resolves.toMatchObject({ generation: 'g2' });
    for (const [request] of archive.queryHistoryPage.mock.calls) {
      expect(request.maxItems).toBe(100);
    }
    // Nothing re-admitted the job: no resume, no bootstrap, no lifecycle signal.
    expect(admitSpy).not.toHaveBeenCalled();
    admitSpy.mockRestore();
  });

  it('settles the exhausted allowance as a surfaced terminal failure', async () => {
    await seedG1Projection();
    twoPageG2Catalog();
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 6,
    });
    const admitSpy = vi.spyOn(coordinator, 'admit');

    fake.failAllOpens();
    await nativeTripRepository.eraseAll();
    const discardAttemptsBefore = pendingProjectionDiscardSnapshot()?.attempts ?? 0;
    await coordinator.drain();

    // One attempt per eligible turn, capped by the declared allowance: the
    // rollover's own attempt plus the coordinated retries.
    expect(discardAttemptsBefore).toBe(1);
    expect(logger.impl.mock.calls.filter(
      ([event]) => event === 'native_projection_discard_after_generation_rollover'
    ).length).toBe(PROJECTION_DISCARD_MAX_ATTEMPTS);

    // The instance is terminal, not asleep on a wake nothing can produce.
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'failing',
      failureCeilingReached: true,
    });
    const snapshot = coordinator.getJobSnapshot(PROJECTION);
    expect(snapshot.active).toBeNull();
    expect(snapshot.wake).toBeNull();
    expect(snapshot.failing).toBe(true);
    expect(snapshot.lastTerminal).toMatchObject({ outcome: 'failing' });

    // Telemetry says failing, and the epoch's background work is complete with
    // a terminal instance rather than an open-ended deferral.
    const projectionEvents = coordinator.getTelemetrySnapshot().events
      .filter((event) => event.jobKey === PROJECTION);
    const last = projectionEvents[projectionEvents.length - 1];
    expect(last.turnOutcome).toBe('failing');
    expect(last.failureCeilingReached).toBe(true);
    expect(coordinator.backgroundComplete(6)).toBe(true);

    // No hidden extra retry, and nothing re-admitted the job.
    expect(admitSpy).not.toHaveBeenCalled();
    admitSpy.mockRestore();

    // Fail-closed throughout: no stale checkpoint was ever resumable, and the
    // superseded generation's rows are still not commitable over.
    expect(hasPendingProjectionDiscard()).toBe(true);
    await expect(readNativeProjectionState()).resolves.toBeNull();
    expect(projectionRowsFor('g2')).toEqual([]);
    expect(projectionRowsFor('g1').length).toBeGreaterThan(0);
  });

  it('gives a later legitimate admission its own bounded allowance', async () => {
    await seedG1Projection();
    twoPageG2Catalog();
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(PROJECTION, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 7 });

    fake.failAllOpens();
    await nativeTripRepository.eraseAll();
    await coordinator.drain();
    // The allowance is per logical instance, so the next one is not born
    // already terminal; the fail-closed marker itself survives.
    expect(pendingProjectionDiscardSnapshot()).toMatchObject({ attempts: 0 });
    expect(hasPendingProjectionDiscard()).toBe(true);

    fake.healStorage();
    const next = runtime.admit(PROJECTION, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 8 });
    await coordinator.drain();

    await expect(next.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(hasPendingProjectionDiscard()).toBe(false);
    expect(projectionRowsFor('g1')).toEqual([]);
  });

  it('keeps a verified erasure verified when the failure logger itself throws', async () => {
    await seedG1Projection();
    logger.impl = vi.fn(() => { throw new Error('logger down'); });
    fake.failOpen(1);

    await expect(nativeTripRepository.eraseAll()).resolves.toMatchObject({ verified: true });

    expect(logger.impl).toHaveBeenCalled();
    // Fail-closed state was recorded before the logger was ever called.
    expect(hasPendingProjectionDiscard()).toBe(true);
    await expect(readNativeProjectionState()).resolves.toBeNull();
  });

  it('does not convert an unverified or throwing canonical erasure into success', async () => {
    await seedG1Projection();
    archive.eraseGeneration.mockResolvedValueOnce({ verified: false, reason: 'refused' });

    await expect(nativeTripRepository.eraseAll()).resolves.toMatchObject({ verified: false });
    // Canonical authority never moved, so nothing derived was discarded and no
    // fail-closed marker was raised.
    expect(hasPendingProjectionDiscard()).toBe(false);
    expect(projectionRowsFor('g1').length).toBeGreaterThan(0);
    expect(storedCheckpoint()).not.toBeNull();

    archive.eraseGeneration.mockRejectedValueOnce(new Error('native erase failed'));
    await expect(nativeTripRepository.eraseAll()).rejects.toThrow('native erase failed');
    expect(hasPendingProjectionDiscard()).toBe(false);
  });

  it('makes no native call at all on the web/native-disabled path', async () => {
    const { coordinator, runtime } = makeRuntime({ available: false });
    archive.health.mockClear();

    const admissions = runtime.admitAll({ origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 4 });
    await coordinator.drain();

    expect(admissions.find((entry) => entry.jobKey === PROJECTION)).toMatchObject({
      status: 'ownerless',
      reason: 'native_authority_unavailable',
    });
    expect(archive.health).not.toHaveBeenCalled();
    expect(archive.queryHistoryPage).not.toHaveBeenCalled();
    expect(archive.projectionFeed).not.toHaveBeenCalled();
  });
});
