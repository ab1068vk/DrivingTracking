import { describe, expect, it, vi } from 'vitest';

import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  AppWorkContractViolationError,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';

const background = (overrides = {}) => ({
  jobKey: 'job',
  workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
  budget: { items: 10, turns: 50 },
  newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
  runTurn: async ({ budget }) => { budget.reportZeroWork(); return APP_WORK_TURN_RESULTS.DONE; },
  ...overrides,
});

const clocked = (options = {}) => {
  let now = 0;
  const coordinator = createAppWorkCoordinator({
    autoStart: false,
    yieldControl: vi.fn(),
    now: () => now,
    ...options,
  });
  return { coordinator, advance: (ms) => { now += ms; }, at: () => now };
};

describe('V23: coordinator failure ceiling', () => {
  it('backs off with bounded growth, then surfaces failing and stops retrying', async () => {
    let calls = 0;
    const { coordinator, advance } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({
      runTurn: async () => { calls += 1; throw new Error('domain turn failed'); },
    }));

    coordinator.admit('job', { epoch: 1 });
    const delays = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await coordinator.runNextTurn();
      const snapshot = coordinator.getJobSnapshot('job');
      if (snapshot.wake?.eligibleAt !== undefined) delays.push(snapshot.wake.eligibleAt);
      advance(10_000);
      coordinator.admit('job', { epoch: 1, wake: { type: 'time', eligibleAt: 0 } });
    }

    // 100ms then 200ms: bounded exponential growth, not an immediate hot loop.
    expect(delays).toEqual([100, 10_200]);
    expect(calls).toBe(3);

    const snapshot = coordinator.getJobSnapshot('job');
    // Each backoff wake is its own instance; the ceiling instance is the one
    // that ends `failing`.
    expect(snapshot.lastTerminal).toMatchObject({ outcome: 'failing', failed: true });
    expect(snapshot.failing).toBe(true);
    expect(snapshot.consecutiveFailures).toBe(3);
    // Automatic retry has stopped: nothing is queued and nothing is sleeping.
    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({ backlog: 0, sleepingInstances: 0 });

    await coordinator.drain();
    expect(calls).toBe(3);
  });

  it('surfaces the failure through bounded telemetry', async () => {
    const { coordinator, advance } = clocked({ failureCeiling: 2, backoffBaseMs: 50 });
    coordinator.registerJob(background({ runTurn: async () => { throw new Error('nope'); } }));
    coordinator.admit('job', { epoch: 4 });
    await coordinator.runNextTurn();
    advance(10_000);
    coordinator.admit('job', { epoch: 4, wake: { type: 'time', eligibleAt: 0 } });
    await coordinator.drain();

    const last = coordinator.getTelemetrySnapshot().events.at(-1);
    expect(last).toMatchObject({ turnOutcome: 'failing', failed: true, failureCeilingReached: true });
    expect(last.consecutiveFailures).toBe(2);
    expect(Object.isFrozen(last)).toBe(true);
  });

  it('a recovered turn clears the scheduler-level failure counter', async () => {
    let calls = 0;
    const { coordinator, advance } = clocked({ failureCeiling: 5, backoffBaseMs: 10 });
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('job', { epoch: 1 });
    await coordinator.runNextTurn();
    expect(coordinator.getJobSnapshot('job').consecutiveFailures).toBe(1);

    advance(1_000);
    coordinator.admit('job', { epoch: 1, wake: { type: 'time', eligibleAt: 0 } });
    await coordinator.drain();

    expect(coordinator.getJobSnapshot('job')).toMatchObject({ consecutiveFailures: 0, failing: false });
  });
});

describe('V22/V29: finite monotonic background-complete(E)', () => {
  it('stays false while an admitted instance still has hasMore work', async () => {
    let turn = 0;
    const { coordinator } = clocked();
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        return turn < 3 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('job', { epoch: 5 });
    expect(coordinator.backgroundComplete(5)).toBe(false);
    await coordinator.runNextTurn();
    expect(coordinator.backgroundComplete(5)).toBe(false);
    await coordinator.runNextTurn();
    expect(coordinator.backgroundComplete(5)).toBe(false);
    await coordinator.drain();
    expect(coordinator.backgroundComplete(5)).toBe(true);
  });

  it('requires every admitted instance in the epoch, across mixed outcomes', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(background({ jobKey: 'ok' }));
    coordinator.registerJob(background({
      jobKey: 'fails',
      runTurn: async () => { throw new Error('x'); },
    }));
    coordinator.registerJob(background({
      jobKey: 'obsolete',
      runTurn: async ({ budget }) => { budget.reportZeroWork(); return APP_WORK_TURN_RESULTS.OBSOLETE; },
    }));

    coordinator.admit('ok', { epoch: 9 });
    coordinator.admit('fails', { epoch: 9 });
    coordinator.admit('obsolete', { epoch: 9 });
    expect(coordinator.getEpochSnapshot(9)).toMatchObject({ admitted: 3, terminal: 0, complete: false });

    await coordinator.runNextTurn();
    expect(coordinator.backgroundComplete(9)).toBe(false);
    await coordinator.drain();

    // `done`, `failing` (at ceiling) and `obsolete` are all terminal for E.
    const snapshot = coordinator.getEpochSnapshot(9);
    expect(snapshot).toMatchObject({ admitted: 3, terminal: 3, complete: true });
  });

  it('V29: deferred closes the epoch only with a typed wake, and the later wake is separate', async () => {
    let turn = 0;
    const { coordinator } = clocked();
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        return turn === 1
          ? { outcome: 'deferred', wake: { type: 'authority', key: 'healthy' } }
          : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('job', { epoch: 11 });
    await coordinator.drain();
    // A typed wake record is installed, so epoch 11 is closed.
    expect(coordinator.backgroundComplete(11)).toBe(true);

    const wake = coordinator.admit('job', {
      epoch: 12,
      wake: { type: 'authority', key: 'healthy' },
    });
    expect(wake.status).toBe('admitted_wake');
    // The wake is observable under its own epoch and does not reopen 11.
    expect(coordinator.backgroundComplete(12)).toBe(false);
    expect(coordinator.backgroundComplete(11)).toBe(true);

    await coordinator.drain();
    expect(coordinator.backgroundComplete(12)).toBe(true);
    expect(coordinator.backgroundComplete(11)).toBe(true);
  });

  it('a published epoch snapshot is monotonic even as later work is admitted', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(background());

    coordinator.admit('job', { epoch: 20 });
    await coordinator.drain();
    expect(coordinator.backgroundComplete(20)).toBe(true);

    coordinator.admit('job', { epoch: 21 });
    expect(coordinator.backgroundComplete(20)).toBe(true);
    expect(coordinator.backgroundComplete(21)).toBe(false);
    await coordinator.drain();
    expect(coordinator.backgroundComplete(20)).toBe(true);
  });

  it('an epoch that admitted nothing is not complete, and epoch history stays bounded', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(background());

    expect(coordinator.backgroundComplete(99)).toBe(false);
    for (let epoch = 1; epoch <= 200; epoch += 1) {
      coordinator.admit('job', { epoch });
      await coordinator.drain();
    }
    // Bounded per-epoch retention: 200 epochs must not retain 200 records.
    expect(coordinator.epochs.size).toBeLessThanOrEqual(16);
    expect(coordinator.publishedEpochs.size).toBeLessThanOrEqual(16);
    expect(coordinator.backgroundComplete(200)).toBe(true);
  });
});

describe('P4-C-F10: failure classification follows ownership, not error class', () => {
  const snapshot = (coordinator) => coordinator.getJobSnapshot('job');

  it('gives a domain TypeError the same bounded retry every other domain failure gets', async () => {
    let calls = 0;
    const { coordinator, advance } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({
      runTurn: async () => { calls += 1; throw new TypeError('domain parser failed'); },
    }));

    coordinator.admit('job', { epoch: 1 });
    await coordinator.drain();
    // Attempt 1: failing, but retryable - a bounded time wake, ceiling not reached.
    expect(snapshot(coordinator).wake).toMatchObject({ type: 'time', eligibleAt: 100 });
    expect(snapshot(coordinator).failing).toBe(false);
    expect(snapshot(coordinator).consecutiveFailures).toBe(1);

    advance(100);
    coordinator.admit('job', { epoch: 1, wake: { type: 'time', eligibleAt: 0 } });
    await coordinator.drain();
    // Attempt 2: still retryable, with the doubled bounded backoff.
    expect(snapshot(coordinator).wake).toMatchObject({ type: 'time', eligibleAt: 300 });
    expect(snapshot(coordinator).failing).toBe(false);
    expect(snapshot(coordinator).consecutiveFailures).toBe(2);

    advance(200);
    coordinator.admit('job', { epoch: 1, wake: { type: 'time', eligibleAt: 0 } });
    await coordinator.drain();
    // Attempt 3 reaches the ceiling: terminal failing, no wake, no further retry.
    expect(snapshot(coordinator).wake).toBeNull();
    expect(snapshot(coordinator).failing).toBe(true);
    expect(snapshot(coordinator).lastTerminal).toMatchObject({ outcome: 'failing' });
    expect(calls).toBe(3);
  });

  it('keeps a malformed turn result an immediate typed contract failure', async () => {
    const { coordinator } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({ runTurn: async () => 'not-a-real-outcome' }));

    coordinator.admit('job', { epoch: 2 });
    const result = await coordinator.runNextTurn();

    expect(result.error).toBeInstanceOf(AppWorkContractViolationError);
    expect(result.error).toBeInstanceOf(TypeError);
    expect(snapshot(coordinator).failing).toBe(true);
    expect(snapshot(coordinator).wake).toBeNull();
  });

  it('keeps a missing typed wake an immediate typed contract failure', async () => {
    const { coordinator } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({
      runTurn: async () => ({ outcome: APP_WORK_TURN_RESULTS.DEFERRED }),
    }));

    coordinator.admit('job', { epoch: 3 });
    const result = await coordinator.runNextTurn();

    expect(result.error).toBeInstanceOf(AppWorkContractViolationError);
    expect(snapshot(coordinator).failing).toBe(true);
    expect(snapshot(coordinator).wake).toBeNull();
  });

  it('keeps accounting and budget violations immediate', async () => {
    const { coordinator } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({
      jobKey: 'unaccounted',
      runTurn: async () => APP_WORK_TURN_RESULTS.DONE,
    }));
    coordinator.registerJob(background({
      jobKey: 'over-budget',
      budget: { items: 2, turns: 50 },
      runTurn: async ({ budget }) => { budget.consume({ items: 3 }); return APP_WORK_TURN_RESULTS.DONE; },
    }));

    coordinator.admit('unaccounted', { epoch: 4 });
    coordinator.admit('over-budget', { epoch: 4 });
    await coordinator.drain();

    expect(coordinator.getJobSnapshot('unaccounted')).toMatchObject({ failing: true, wake: null });
    expect(coordinator.getJobSnapshot('over-budget')).toMatchObject({ failing: true, wake: null });
  });

  it('keeps a domain retryable:false failure immediately terminal', async () => {
    const { coordinator } = clocked({ failureCeiling: 3, backoffBaseMs: 100 });
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        budget.reportZeroWork();
        return { outcome: APP_WORK_TURN_RESULTS.FAILING, retryable: false };
      },
    }));

    coordinator.admit('job', { epoch: 5 });
    await coordinator.drain();

    expect(snapshot(coordinator)).toMatchObject({ failing: true, wake: null });
    expect(snapshot(coordinator).consecutiveFailures).toBe(1);
  });
});

describe('P4-C-F11: PRESERVE_INSTANCE transfers epoch accounting', () => {
  /** A job that reports `hasMore` for its first `pages` turns, then settles. */
  const paged = (pages, settle = APP_WORK_TURN_RESULTS.DONE) => {
    let turn = 0;
    return background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.consume({ items: 1 });
        return turn < pages ? APP_WORK_TURN_RESULTS.HAS_MORE : settle;
      },
    });
  };

  it('A: a queued rescope settles the old epoch and admits the same identity into the new one', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(paged(2));

    const first = coordinator.admit('job', { epoch: 1 });
    await coordinator.runNextTurn();
    expect(coordinator.getEpochSnapshot(1)).toMatchObject({ admitted: 1, terminal: 0, complete: false });

    const rescoped = coordinator.admit('job', { epoch: 2 });
    expect(rescoped.status).toBe('coalesced_rescoped_epoch');
    expect(rescoped.instanceId).toBe(first.instanceId);
    await coordinator.drain();

    // One logical instance, both epochs settled, neither left unfinished.
    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 2,
      outcome: 'done',
    });
    expect(coordinator.getEpochSnapshot(1)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
    expect(coordinator.getEpochSnapshot(2)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
  });

  it('B: a rescope arriving while the callback runs is accounted at the turn boundary', async () => {
    const { coordinator } = clocked();
    let turn = 0;
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.consume({ items: 1 });
        if (turn === 1) {
          // The resume lands mid-callback: the new epoch may not be recorded as
          // responsible until this turn is over.
          coordinator.admit('job', { epoch: 31 });
          expect(coordinator.getEpochSnapshot(31)).toMatchObject({ admitted: 0 });
          return APP_WORK_TURN_RESULTS.HAS_MORE;
        }
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const first = coordinator.admit('job', { epoch: 30 });
    await coordinator.drain();

    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 31,
    });
    expect(coordinator.getEpochSnapshot(30)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
    expect(coordinator.getEpochSnapshot(31)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
  });

  it('C: a rescope settled by deferred records the new epoch terminal', async () => {
    const { coordinator } = clocked();
    let turn = 0;
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        if (turn === 1) return APP_WORK_TURN_RESULTS.HAS_MORE;
        return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'domain', key: 'ready' } };
      },
    }));

    const first = coordinator.admit('job', { epoch: 40 });
    await coordinator.runNextTurn();
    coordinator.admit('job', { epoch: 41 });
    await coordinator.drain();

    expect(coordinator.getJobSnapshot('job')).toMatchObject({
      wake: { type: 'domain', key: 'ready' },
    });
    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 41,
      outcome: 'deferred',
    });
    expect(coordinator.getEpochSnapshot(40)).toMatchObject({ terminal: 1, complete: true });
    expect(coordinator.getEpochSnapshot(41)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
  });

  it('D: a rescope settled by backoff records the new epoch terminal', async () => {
    const { coordinator, at } = clocked();
    let turn = 0;
    coordinator.registerJob(background({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        if (turn === 1) return APP_WORK_TURN_RESULTS.HAS_MORE;
        return { outcome: APP_WORK_TURN_RESULTS.BACKOFF, wake: { type: 'time', eligibleAt: at() + 1000 } };
      },
    }));

    const first = coordinator.admit('job', { epoch: 50 });
    await coordinator.runNextTurn();
    coordinator.admit('job', { epoch: 51 });
    await coordinator.drain();

    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 51,
      outcome: 'backoff',
    });
    expect(coordinator.getEpochSnapshot(50)).toMatchObject({ terminal: 1, complete: true });
    expect(coordinator.getEpochSnapshot(51)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
  });

  it('E: several increasing epochs coalesce onto one identity and every epoch settles', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(paged(4));

    const first = coordinator.admit('job', { epoch: 60 });
    await coordinator.runNextTurn();
    for (const epoch of [61, 62, 63]) {
      expect(coordinator.admit('job', { epoch }).instanceId).toBe(first.instanceId);
      await coordinator.runNextTurn();
    }
    await coordinator.drain();

    // The oldest epochs are settled by transfer, the final one by completion.
    for (const epoch of [60, 61, 62]) {
      expect(coordinator.getEpochSnapshot(epoch)).toMatchObject({ terminal: 1, complete: true });
    }
    expect(coordinator.getEpochSnapshot(63)).toMatchObject({ admitted: 1, terminal: 1, complete: true });
    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 63,
    });
  });

  it('F: rescoping across more than the retained epoch history leaves no unfinished record', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(paged(40));

    const first = coordinator.admit('job', { epoch: 100 });
    await coordinator.runNextTurn();
    for (let epoch = 101; epoch <= 139; epoch += 1) {
      coordinator.admit('job', { epoch });
      await coordinator.runNextTurn();
    }
    await coordinator.drain();

    // Retention stays bounded, and no retained record is admitted-but-unfinished.
    expect(coordinator.epochs.size).toBeLessThanOrEqual(16);
    for (const [epoch, record] of coordinator.epochs) {
      expect(
        record.terminal.size,
        `epoch ${epoch} retained an unfinished record`,
      ).toBe(record.admitted.size);
    }
    expect(coordinator.getJobSnapshot('job').lastTerminal).toMatchObject({
      instanceId: first.instanceId,
      epoch: 139,
      outcome: 'done',
    });
    expect(coordinator.backgroundComplete(139)).toBe(true);
  });

  it('preserves the published monotonicity of an epoch settled by transfer', async () => {
    const { coordinator } = clocked();
    coordinator.registerJob(paged(3));

    coordinator.admit('job', { epoch: 70 });
    await coordinator.runNextTurn();
    coordinator.admit('job', { epoch: 71 });
    await coordinator.runNextTurn();
    expect(coordinator.backgroundComplete(70)).toBe(true);

    // Later work under a newer epoch cannot reopen the published snapshot.
    coordinator.admit('job', { epoch: 72 });
    await coordinator.drain();
    expect(coordinator.backgroundComplete(70)).toBe(true);
    expect(coordinator.backgroundComplete(71)).toBe(true);
  });
});
