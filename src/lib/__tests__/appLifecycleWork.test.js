import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APP_WORK_EXTENTS,
  APP_WORK_TRIGGER_ORIGINS,
  P4_LIFECYCLE_JOB_KEYS,
  P5_LIFECYCLE_JOB_KEYS,
  connectP4LifecycleWorkRuntime,
  createLifecycleWorkRegistrationBoundary,
  createP4LifecycleWorkRuntime,
} from '@/lib/appLifecycleWork';
import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';
import {
  __resetLifecycleAuthorityForTests,
  getLifecycleSnapshot,
  recordLifecycleSignal,
  subscribeLifecycleSignals,
} from '@/lib/lifecycleAuthority';

const healthy = (generation = 'g1', overrides = {}) => ({
  authorityState: 'NATIVE',
  recoveryState: 'HEALTHY',
  sentinelMatches: true,
  archiveGeneration: generation,
  erasureBarrierToken: generation,
  ...overrides,
});

const runtimeFixture = ({
  health = healthy(),
  available = true,
  projection = vi.fn(async () => ({ done: true, applied: 0 })),
  journal = vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
  onJournalSettled = vi.fn(async () => {}),
} = {}) => {
  let currentHealth = health;
  let nativeAvailable = available;
  const readHealth = vi.fn(async () => currentHealth);
  const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const runtime = createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => nativeAvailable,
    readHealth,
    runProjectionTurn: projection,
    runJournalTurn: journal,
    onJournalSettled,
  });
  return {
    runtime,
    coordinator,
    readHealth,
    projection,
    journal,
    onJournalSettled,
    setHealth: (next) => { currentHealth = next; },
    setAvailable: (next) => { nativeAvailable = next; },
  };
};

describe('P4 production lifecycle work boundary', () => {
  beforeEach(() => {
    __resetLifecycleAuthorityForTests({ documentVisible: false, nativeActive: false, epoch: 0 });
  });

  it.each([
    ['direct', (callback) => callback],
    ['alias', (callback) => callback],
    ['wrapper', (callback) => (...args) => callback(...args)],
    ['new helper name', () => async function newlyNamedMaintenance() {}],
  ])('V19/V31: rejects %s full-history lifecycle registration by semantics', (_label, wrap) => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    const boundary = createLifecycleWorkRegistrationBoundary(coordinator);
    const fullHistory = async () => APP_WORK_TURN_RESULTS.DONE;

    expect(() => boundary.register({
      jobKey: `forbidden-${_label}`,
      triggerOrigins: [APP_WORK_TRIGGER_ORIGINS.RESUME],
      workExtent: APP_WORK_EXTENTS.FULL_HISTORY,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      budget: { items: 1 },
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      runTurn: wrap(fullHistory),
    })).toThrow(/Full-history work cannot be registered/);
  });

  it('V19/V31: production projection and journal registrations are immutable bounded turns', () => {
    const { runtime } = runtimeFixture();
    const registrations = runtime.boundary.snapshot();

    // Every lifecycle-owned job in the runtime, including the step-12 domain
    // turns, is an immutable bounded turn declared for bootstrap/resume only.
    expect(new Set(registrations.map((entry) => entry.jobKey))).toEqual(new Set([
      ...Object.values(P4_LIFECYCLE_JOB_KEYS), ...Object.values(P5_LIFECYCLE_JOB_KEYS),
    ]));
    for (const entry of registrations.filter(({ jobKey }) => Object.values(P4_LIFECYCLE_JOB_KEYS).includes(jobKey))) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.workExtent).toBe(APP_WORK_EXTENTS.BOUNDED_TURN);
      expect(entry.triggerOrigins).toEqual([
        APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,
        APP_WORK_TRIGGER_ORIGINS.RESUME,
      ]);
    }
  });

  it('V21: native-disabled and web/no-native paths are explicit and never call native health', async () => {
    const fixture = runtimeFixture({ available: false });
    const admissions = fixture.runtime.admitAll({ origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 1 });
    await fixture.coordinator.drain();

    // The native-canonical jobs are ownerless without native authority; the
    // other step-12 domain turns are legitimate web work. P4-C-F02 adds legacy
    // migration to that set: every unit it performs is a native ingress commit.
    const nativeAdmissions = admissions.filter((entry) => (
      entry.jobKey === P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION ||
      entry.jobKey === P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST ||
      entry.jobKey === P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION
    ));
    expect(nativeAdmissions).toHaveLength(3);
    expect(nativeAdmissions.every((entry) => entry.status === 'ownerless')).toBe(true);
    expect(fixture.runtime.ownerless().map((entry) => entry.jobKey).sort()).toEqual([
      P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION,
      P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST,
      P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION,
      ...Object.values(P5_LIFECYCLE_JOB_KEYS),
    ].sort());
    expect(fixture.readHealth).not.toHaveBeenCalled();
    expect(fixture.projection).not.toHaveBeenCalled();
    expect(fixture.journal).not.toHaveBeenCalled();
  });

  it.each([
    ['recovery-required', healthy('g1', { recoveryState: 'RECOVERY_REQUIRED' })],
    ['sentinel mismatch', healthy('g1', { sentinelMatches: false })],
  ])('V11: %s fails closed with typed deferral and no domain call', async (_label, health) => {
    const fixture = runtimeFixture({ health });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 1,
    });
    await fixture.coordinator.drain();

    expect(fixture.projection).not.toHaveBeenCalled();
    await expect(admission.completion).resolves.toMatchObject({
      outcome: 'deferred',
      wake: { type: 'canonical_health', key: 'healthy' },
    });
  });

  it('V12/V30: G1 continuation becomes obsolete after same-epoch G2 rollover', async () => {
    let turn = 0;
    const projection = vi.fn(async () => {
      turn += 1;
      return { done: turn >= 3, applied: 1 };
    });
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 7,
    });
    await fixture.coordinator.runNextTurn();
    fixture.setHealth(healthy('g2'));
    await fixture.coordinator.runNextTurn();

    expect(projection).toHaveBeenCalledTimes(1);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete', turnCount: 2 });
  });

  it.each([
    ['recovery-required', healthy('g1', { recoveryState: 'RECOVERY_REQUIRED' })],
    ['sentinel mismatch', healthy('g1', { sentinelMatches: false })],
  ])('V11/V30: same-epoch %s defers a queued continuation before domain work', async (_label, nextHealth) => {
    const projection = vi.fn(async () => ({ done: false, applied: 1 }));
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 7,
    });
    await fixture.coordinator.runNextTurn();
    fixture.setHealth(nextHealth);
    await fixture.coordinator.runNextTurn();

    expect(projection).toHaveBeenCalledTimes(1);
    await expect(admission.completion).resolves.toMatchObject({
      outcome: 'deferred',
      wake: { type: 'canonical_health', key: 'healthy' },
    });
  });

  it('V13/V30: an erasure-token change invalidates queued derived work without a stale commit', async () => {
    let commits = 0;
    const projection = vi.fn(async () => {
      commits += 1;
      return { done: false, applied: 1 };
    });
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 8,
    });
    await fixture.coordinator.runNextTurn();
    fixture.setHealth(healthy('g1', { erasureBarrierToken: 'erased-2' }));
    await fixture.coordinator.runNextTurn();

    expect(commits).toBe(1);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete' });
  });

  it('V13: prompt erasure notification obsoletes an already-queued continuation', async () => {
    const projection = vi.fn(async () => ({ done: false, applied: 1 }));
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 9,
    });
    await fixture.coordinator.runNextTurn();
    fixture.runtime.invalidateAuthoritySensitiveWork('data_rights_erasure');
    await fixture.coordinator.runNextTurn();

    expect(projection).toHaveBeenCalledTimes(1);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete' });
  });

  it('V14: projection automatically converges through bounded tail turns under one identity', async () => {
    let turn = 0;
    const projection = vi.fn(async () => {
      turn += 1;
      return { done: turn === 4, applied: 1 };
    });
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 10,
    });
    await fixture.coordinator.drain();

    expect(projection).toHaveBeenCalledTimes(4);
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
      turnCount: 4,
    });
    const projectionEvents = fixture.coordinator.getTelemetrySnapshot().events
      .filter((event) => event.jobKey === P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION);
    expect(new Set(projectionEvents.map((event) => event.instanceId))).toEqual(new Set([admission.instanceId]));
  });

  it('V15: journal hasMore requeues in-session and converges under one identity', async () => {
    let turn = 0;
    const journal = vi.fn(async (maxItems, maxBytes) => {
      turn += 1;
      expect(maxItems).toBe(8);
      expect(maxBytes).toBe(8 * 1024 * 1024);
      return { hasMore: turn < 3, itemCount: 1, workBytes: 1_024 };
    });
    const fixture = runtimeFixture({ journal });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 11,
    });
    await fixture.coordinator.drain();

    expect(journal).toHaveBeenCalledTimes(3);
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
      turnCount: 3,
    });
  });

  it('step 5: the journal instance still reconciles once per trigger, even with nothing ingested', async () => {
    const journal = vi.fn(async () => ({ hasMore: false, itemCount: 0 }));
    const fixture = runtimeFixture({ journal });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, {
      origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,
      epoch: 1,
    });
    await fixture.coordinator.drain();

    // Historical `reconcileExisting: true` semantics: a trip saved in-app never
    // appears in the ingest, so reconciliation must not be gated on itemCount.
    expect(fixture.onJournalSettled).toHaveBeenCalledTimes(1);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
  });

  it('step 5: reconciles exactly once per logical instance across multiple journal turns', async () => {
    let turn = 0;
    const journal = vi.fn(async () => {
      turn += 1;
      return { hasMore: turn < 3, itemCount: 1, workBytes: 16 };
    });
    const fixture = runtimeFixture({ journal });
    fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 2,
    });
    await fixture.coordinator.drain();

    expect(journal).toHaveBeenCalledTimes(3);
    expect(fixture.onJournalSettled).toHaveBeenCalledTimes(1);
  });

  it('step 5: a deferred journal turn does not claim the reconciliation point', async () => {
    const fixture = runtimeFixture({ health: healthy('g1', { sentinelMatches: false }) });
    fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 3,
    });
    await fixture.coordinator.drain();

    expect(fixture.journal).not.toHaveBeenCalled();
    expect(fixture.onJournalSettled).not.toHaveBeenCalled();
  });

  it('step 8: a failing invalidation notification cannot fail the turn that follows it', async () => {
    const projection = vi.fn(async () => ({ done: false, applied: 1 }));
    const fixture = runtimeFixture({ projection });
    const admission = fixture.runtime.admit(P4_LIFECYCLE_JOB_KEYS.NATIVE_PROJECTION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 4,
    });
    await fixture.coordinator.runNextTurn();
    // An unregistered key is the throwing shape callers must never propagate.
    expect(() => fixture.coordinator.invalidateJob('not-registered')).toThrow();
    fixture.runtime.invalidateAuthoritySensitiveWork('data_rights_generation_erased');
    await fixture.coordinator.runNextTurn();

    expect(projection).toHaveBeenCalledTimes(1);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete' });
  });

  it('step 5: two raw resume signals schedule one effective epoch for both P4-B jobs', async () => {
    const projection = vi.fn(async () => ({ done: true, applied: 0 }));
    const journal = vi.fn(async () => ({ hasMore: false, itemCount: 0 }));
    const fixture = runtimeFixture({ projection, journal });
    const stop = connectP4LifecycleWorkRuntime(fixture.runtime, {
      snapshot: getLifecycleSnapshot,
      subscribe: subscribeLifecycleSignals,
    });

    recordLifecycleSignal('appStateChange', 'active');
    expect(projection).not.toHaveBeenCalled();
    recordLifecycleSignal('visibilitychange', 'visible');
    await fixture.coordinator.drain();

    expect(projection).toHaveBeenCalledTimes(1);
    expect(journal).toHaveBeenCalledTimes(1);
    expect(getLifecycleSnapshot()).toMatchObject({ epoch: 1, rawSequence: 2, effectiveForeground: true });
    stop();
  });
});

describe('P4-C-F02: migration is admitted through the coordinator, never executed by its trigger', () => {
  const migrationFixture = ({ available = true, turns = [] } = {}) => {
    const step = vi.fn(async () => turns.shift() || { outcome: 'done', unit: 'verified', verified: true });
    let nativeAvailable = available;
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    const runtime = createP4LifecycleWorkRuntime({
      coordinator,
      nativeAuthorityAvailable: () => nativeAvailable,
      readHealth: vi.fn(async () => healthy()),
      runProjectionTurn: vi.fn(async () => ({ done: true, applied: 0 })),
      runJournalTurn: vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
      // The production adapter shape, with the domain step itself instrumented.
      runMigrationTurnAdapter: async () => {
        const turn = await step();
        if (turn.outcome === 'deferred') {
          return {
            items: 0,
            result: { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'canonical_health', key: 'healthy' } },
          };
        }
        return {
          items: Number(turn.visitedCount) || 0,
          result: turn.outcome === 'hasMore' ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE,
        };
      },
    });
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 12 });
    return { coordinator, runtime, step, setAvailable: (next) => { nativeAvailable = next; } };
  };

  const migrationSnapshot = (coordinator) => (
    coordinator.getJobSnapshot(P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION)
  );

  it('creates exactly one logical migration instance and coalesces repeat triggers onto it', async () => {
    const { coordinator, runtime, step } = migrationFixture({
      turns: [
        { outcome: 'hasMore', unit: 'migrating', visitedCount: 50 },
        { outcome: 'hasMore', unit: 'verifying', visitedCount: 50 },
        { outcome: 'done', unit: 'verified', verified: true },
      ],
    });

    // The read/write trigger only ensures; it never runs the domain step.
    const first = runtime.ensureMigrationAdvancing();
    expect(first.status).toBe('admitted');
    expect(step).not.toHaveBeenCalled();

    // A second trigger before the instance settles is the same logical work.
    const second = runtime.ensureMigrationAdvancing();
    expect(second.instanceId).toBe(first.instanceId);
    expect(['already_admitted', 'coalesced_queued', 'followup_recorded']).toContain(second.status);
    expect(coordinator.getCoordinatorSnapshot().activeInstances).toBe(1);

    // Continuation is the coordinator's own tail re-admission: no further
    // trigger is needed for the remaining bounded units.
    await coordinator.drain();
    expect(step).toHaveBeenCalledTimes(3);
    expect(migrationSnapshot(coordinator).active).toBeNull();
    expect(migrationSnapshot(coordinator).lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      outcome: 'done',
    });
  });

  it('does not invent a lifecycle epoch for the trigger', async () => {
    const { coordinator, runtime } = migrationFixture();
    const admission = runtime.ensureMigrationAdvancing();

    expect(admission.epoch).toBe(12);
    expect(coordinator.getCoordinatorSnapshot().lifecycleEpoch).toBe(12);
    await coordinator.drain();
  });

  it('reports ownerless and makes no native call when migration authority is unavailable', async () => {
    const { coordinator, runtime, step } = migrationFixture({ available: false });

    const admission = runtime.ensureMigrationAdvancing();

    expect(admission).toMatchObject({
      status: 'ownerless',
      jobKey: P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION,
      reason: 'native_authority_unavailable',
    });
    await coordinator.drain();
    // No instance, no domain step, no spurious failing migration job.
    expect(step).not.toHaveBeenCalled();
    expect(migrationSnapshot(coordinator).active).toBeNull();
    expect(migrationSnapshot(coordinator).failing).toBe(false);
    expect(coordinator.getCoordinatorSnapshot().activeInstances).toBe(0);
  });

  it('a native-disabled resume leaves migration ownerless rather than admitting it', async () => {
    const { coordinator, runtime, step } = migrationFixture({ available: false });

    const admissions = runtime.admitAll({ origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 13 });
    await coordinator.drain();

    const migration = admissions.find((entry) => entry.jobKey === P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION);
    expect(migration.status).toBe('ownerless');
    expect(step).not.toHaveBeenCalled();
  });

  it('P4-C-F03: an unverified promotion defers on a real authority condition instead of completing', async () => {
    const { coordinator, runtime, step } = migrationFixture({
      turns: [
        { outcome: 'hasMore', unit: 'verifying-complete', visitedCount: 50 },
        { outcome: 'deferred', unit: 'shortfall', verified: false, code: 'RECOVERY_REQUIRED' },
      ],
    });

    const admission = runtime.ensureMigrationAdvancing();
    await coordinator.drain();

    await expect(admission.completion).resolves.toMatchObject({
      outcome: 'deferred',
      wake: { type: 'canonical_health', key: 'healthy' },
    });
    // Not done: the epoch does not get to call this background work complete.
    expect(migrationSnapshot(coordinator).lastTerminal.outcome).not.toBe('done');
    expect(step).toHaveBeenCalledTimes(2);

    // The next lifecycle epoch is the producer that retries the promotion.
    step.mockResolvedValueOnce({ outcome: 'done', unit: 'verified', verified: true });
    const retry = runtime.admit(P4_LIFECYCLE_JOB_KEYS.LEGACY_MIGRATION, {
      origin: APP_WORK_TRIGGER_ORIGINS.RESUME,
      epoch: 13,
    });
    expect(retry.status).toBe('admitted_wake');
    await coordinator.drain();
    expect(migrationSnapshot(coordinator).lastTerminal).toMatchObject({ outcome: 'done' });
  });
});
