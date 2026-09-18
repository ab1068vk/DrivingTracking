import { describe, expect, it, vi } from 'vitest';

import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  AppWorkAccountingContractError,
  AppWorkBudgetExceededError,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';

const backgroundRegistration = (overrides = {}) => ({
  jobKey: 'background-job',
  workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
  budget: { timeMs: 50, items: 10, bytes: 1_024, work: 10 },
  newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
  runTurn: async ({ budget }) => {
    budget.reportZeroWork();
    return APP_WORK_TURN_RESULTS.DONE;
  },
  ...overrides,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

const terminalResult = (outcome) => {
  if (outcome === APP_WORK_TURN_RESULTS.DEFERRED) {
    return { outcome, wake: { type: 'authority', key: 'healthy' } };
  }
  if (outcome === APP_WORK_TURN_RESULTS.BACKOFF) {
    return { outcome, wake: { type: 'time', eligibleAt: 0 } };
  }
  return outcome;
};

const TERMINAL_MATRIX = [
  APP_WORK_TURN_RESULTS.DONE,
  APP_WORK_TURN_RESULTS.FAILING,
  APP_WORK_TURN_RESULTS.OBSOLETE,
  APP_WORK_TURN_RESULTS.DEFERRED,
  APP_WORK_TURN_RESULTS.BACKOFF,
];

describe('application work coordinator foundation', () => {
  it('keeps native-owned durability work observe-only and outside dispatch ownership', () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false, telemetryLimit: 2 });
    coordinator.registerJob({
      jobKey: 'native-commit',
      workClass: APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    });

    expect(() => coordinator.admit('native-commit', { epoch: 1 })).toThrow(/observe-only/);
    coordinator.observeNativeOwned('native-commit', { epoch: 1, state: 'native_running' });
    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({
      registeredJobs: 1,
      activeInstances: 0,
      backlog: 0,
    });
    expect(coordinator.getTelemetrySnapshot().events[0]).toMatchObject({
      jobKey: 'native-commit',
      lifecycleEpoch: 1,
      turnCount: 0,
      turnOutcome: null,
      convergenceState: 'native_running',
    });
  });

  it('uses semantic work classes for admission without numeric or weighted priority', async () => {
    const order = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      jobKey: 'background',
      runTurn: async ({ budget }) => {
        order.push('background');
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    coordinator.registerJob({
      jobKey: 'interactive',
      workClass: APP_WORK_CLASSES.INTERACTIVE_EXPLICIT,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      runTurn: async ({ budget }) => {
        order.push('interactive');
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    });

    coordinator.admit('background', { epoch: 1 });
    coordinator.admit('interactive', { epoch: 1 });
    await coordinator.drain();

    expect(order).toEqual(['interactive', 'background']);
  });

  it('V3: holds one logical instance through multiple bounded continuation turns', async () => {
    const contexts = [];
    const outcomes = [
      APP_WORK_TURN_RESULTS.HAS_MORE,
      APP_WORK_TURN_RESULTS.HAS_MORE,
      APP_WORK_TURN_RESULTS.DONE,
    ];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async (context) => {
        contexts.push(context);
        context.budget.consume({ items: 1, bytes: 4, work: 1 });
        return outcomes.shift();
      },
    }));

    const admission = coordinator.admit('background-job', { epoch: 7 });
    expect(admission.status).toBe('admitted');

    await coordinator.runNextTurn();
    expect(coordinator.getJobSnapshot('background-job').active).toMatchObject({
      instanceId: admission.instanceId,
      state: 'yielded',
      turnCount: 1,
    });
    await coordinator.drain();

    expect(contexts).toHaveLength(3);
    expect(new Set(contexts.map((context) => context.instanceId))).toEqual(new Set([admission.instanceId]));
    expect(contexts.map((context) => context.turnNumber)).toEqual([1, 2, 3]);
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      epoch: 7,
      outcome: 'done',
      turnCount: 3,
    });
    expect(coordinator.getJobSnapshot('background-job').active).toBeNull();
  });

  it('V4: coalesces a duplicate received before the first turn starts', async () => {
    const runTurn = vi.fn(async ({ budget }) => {
      budget.reportZeroWork();
      return APP_WORK_TURN_RESULTS.DONE;
    });
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({ runTurn }));

    const first = coordinator.admit('background-job', { epoch: 1 });
    const duplicate = coordinator.admit('background-job', { epoch: 1 });
    expect(duplicate).toMatchObject({ status: 'coalesced_queued', instanceId: first.instanceId });

    await coordinator.drain();
    expect(runTurn).toHaveBeenCalledOnce();
  });

  it('V4: records one follow-up after the first callback has begun without creating an instance', async () => {
    const started = deferred();
    const release = deferred();
    const instanceIds = [];
    const runTurn = vi.fn(async ({ instanceId, budget }) => {
      instanceIds.push(instanceId);
      if (runTurn.mock.calls.length === 1) {
        started.resolve();
        await release.promise;
      }
      budget.reportZeroWork();
      return APP_WORK_TURN_RESULTS.DONE;
    });
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({ runTurn }));

    const first = coordinator.admit('background-job', { epoch: 3 });
    const executing = coordinator.runNextTurn();
    await started.promise;
    const duplicate = coordinator.admit('background-job', { epoch: 3 });
    expect(duplicate).toMatchObject({ status: 'followup_recorded', instanceId: first.instanceId });
    release.resolve();
    await executing;
    await coordinator.drain();

    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(new Set(instanceIds)).toEqual(new Set([first.instanceId]));
  });

  it('V4: keeps internal hasMore continuation and coalesces one trigger while it is queued', async () => {
    const outcomes = [
      APP_WORK_TURN_RESULTS.HAS_MORE,
      APP_WORK_TURN_RESULTS.DONE,
      APP_WORK_TURN_RESULTS.DONE,
    ];
    const instanceIds = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ instanceId, budget }) => {
        instanceIds.push(instanceId);
        budget.reportZeroWork();
        return outcomes.shift();
      },
    }));

    const first = coordinator.admit('background-job', { epoch: 4 });
    await coordinator.runNextTurn();
    expect(coordinator.getJobSnapshot('background-job').active.state).toBe('yielded');
    expect(coordinator.admit('background-job', { epoch: 4 }).status).toBe('followup_recorded');
    await coordinator.drain();

    expect(instanceIds).toHaveLength(3);
    expect(new Set(instanceIds)).toEqual(new Set([first.instanceId]));
  });

  it.each(TERMINAL_MATRIX)(
    'F02: honours one running-state follow-up after a %s turn result',
    async (terminalOutcome) => {
      const started = deferred();
      const release = deferred();
      const seenInstanceIds = [];
      let turn = 0;
      const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
      coordinator.registerJob(backgroundRegistration({
        runTurn: async ({ instanceId, budget }) => {
          turn += 1;
          seenInstanceIds.push(instanceId);
          budget.reportZeroWork();
          if (turn === 1) {
            started.resolve();
            await release.promise;
            return terminalResult(terminalOutcome);
          }
          return APP_WORK_TURN_RESULTS.DONE;
        },
      }));

      const admission = coordinator.admit('background-job', { epoch: 5 });
      const executing = coordinator.runNextTurn();
      await started.promise;
      expect(coordinator.admit('background-job', { epoch: 5 })).toMatchObject({
        status: 'followup_recorded',
        instanceId: admission.instanceId,
      });
      release.resolve();
      const firstTurn = await executing;

      expect(firstTurn.outcome).toBe(terminalOutcome);
      expect(coordinator.getJobSnapshot('background-job').active).toMatchObject({
        instanceId: admission.instanceId,
        turnCount: 1,
      });
      if (
        terminalOutcome === APP_WORK_TURN_RESULTS.DEFERRED ||
        terminalOutcome === APP_WORK_TURN_RESULTS.BACKOFF
      ) {
        expect(coordinator.getJobSnapshot('background-job').wake).toEqual(
          terminalResult(terminalOutcome).wake
        );
      }
      await coordinator.drain();

      expect(seenInstanceIds).toEqual([admission.instanceId, admission.instanceId]);
      await expect(admission.completion).resolves.toMatchObject({
        instanceId: admission.instanceId,
        epoch: 5,
        outcome: 'done',
        turnCount: 2,
      });
      expect(coordinator.admit('background-job', { epoch: 5 }).status).toBe('already_admitted');
    }
  );

  it.each(TERMINAL_MATRIX)(
    'F02: applies one pending PRESERVE_INSTANCE rescope after a %s turn result',
    async (terminalOutcome) => {
      const started = deferred();
      const release = deferred();
      const seen = [];
      let turn = 0;
      const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
      coordinator.registerJob(backgroundRegistration({
        newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
        runTurn: async (context) => {
          turn += 1;
          seen.push([context.instanceId, context.lifecycleEpoch]);
          context.budget.reportZeroWork();
          if (turn === 1) {
            started.resolve();
            await release.promise;
            if (terminalOutcome === APP_WORK_TURN_RESULTS.FAILING) {
              throw new Error('epoch-5 failure');
            }
            return terminalResult(terminalOutcome);
          }
          return APP_WORK_TURN_RESULTS.DONE;
        },
      }));

      const admission = coordinator.admit('background-job', { epoch: 5 });
      const executing = coordinator.runNextTurn();
      await started.promise;
      expect(coordinator.admit('background-job', { epoch: 6 }).status).toBe('coalesced_rescoped_epoch');
      release.resolve();
      const firstTurn = await executing;

      expect(firstTurn.outcome).toBe(terminalOutcome);
      expect(coordinator.admit('background-job', { epoch: 6 }).status).toBe('coalesced_rescoped_epoch');
      if (
        terminalOutcome === APP_WORK_TURN_RESULTS.DEFERRED ||
        terminalOutcome === APP_WORK_TURN_RESULTS.BACKOFF
      ) {
        expect(coordinator.getJobSnapshot('background-job').wake).toEqual(
          terminalResult(terminalOutcome).wake
        );
      }
      await coordinator.drain();

      expect(seen).toEqual([
        [admission.instanceId, 5],
        [admission.instanceId, 6],
      ]);
      await expect(admission.completion).resolves.toMatchObject({
        instanceId: admission.instanceId,
        epoch: 6,
        outcome: 'done',
        turnCount: 2,
      });
      expect(coordinator.admit('background-job', { epoch: 6 }).status).toBe('already_admitted');
    }
  );

  it('V5: admits at most one external logical instance per job and epoch', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration());

    const first = coordinator.admit('background-job', { epoch: 10 });
    await coordinator.drain();
    expect(coordinator.admit('background-job', { epoch: 10 })).toMatchObject({
      status: 'already_admitted',
      instanceId: first.instanceId,
    });

    const next = coordinator.admit('background-job', { epoch: 11 });
    expect(next.status).toBe('admitted');
    expect(next.instanceId).not.toBe(first.instanceId);
    await coordinator.drain();
  });

  it('declares and exercises PRESERVE_INSTANCE for a new epoch while work is non-terminal', async () => {
    const seen = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      runTurn: async (context) => {
        seen.push([context.instanceId, context.lifecycleEpoch]);
        context.budget.reportZeroWork();
        return seen.length === 1 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const first = coordinator.admit('background-job', { epoch: 20 });
    await coordinator.runNextTurn();
    expect(coordinator.admit('background-job', { epoch: 21 }).status).toBe('coalesced_rescoped_epoch');
    await coordinator.drain();

    expect(seen).toEqual([
      [first.instanceId, 20],
      [first.instanceId, 21],
    ]);
  });

  it('does not lose a PRESERVE_INSTANCE epoch that arrives while the callback is running', async () => {
    const started = deferred();
    const release = deferred();
    const seen = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      runTurn: async (context) => {
        seen.push([context.instanceId, context.lifecycleEpoch]);
        if (seen.length === 1) {
          started.resolve();
          await release.promise;
        }
        context.budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const first = coordinator.admit('background-job', { epoch: 22 });
    const executing = coordinator.runNextTurn();
    await started.promise;
    expect(coordinator.admit('background-job', { epoch: 23 }).status).toBe('coalesced_rescoped_epoch');
    release.resolve();
    await executing;
    await coordinator.drain();

    expect(seen).toEqual([
      [first.instanceId, 22],
      [first.instanceId, 23],
    ]);
  });

  it('declares and exercises TERMINATE_AND_READMIT without duplicating the old instance', async () => {
    const seen = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,
      runTurn: async (context) => {
        seen.push([context.instanceId, context.lifecycleEpoch]);
        context.budget.reportZeroWork();
        return context.lifecycleEpoch === 30
          ? APP_WORK_TURN_RESULTS.HAS_MORE
          : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const first = coordinator.admit('background-job', { epoch: 30 });
    const executing = coordinator.runNextTurn();
    expect(coordinator.admit('background-job', { epoch: 31 }).status).toBe('followup_new_epoch');
    await executing;
    await expect(first.completion).resolves.toMatchObject({ outcome: 'obsolete', epoch: 30 });
    await coordinator.drain();

    expect(seen).toHaveLength(2);
    expect(seen[0][0]).toBe(first.instanceId);
    expect(seen[1][0]).not.toBe(first.instanceId);
    expect(seen.map((entry) => entry[1])).toEqual([30, 31]);
  });

  it('keeps deferred/backoff terminal only with a typed wake record and observes wake admission separately', async () => {
    let turn = 0;
    let now = 100;
    const coordinator = createAppWorkCoordinator({ autoStart: false, now: () => now });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        if (turn === 1) return { outcome: 'deferred', wake: { type: 'authority', key: 'healthy' } };
        if (turn === 2) return { outcome: 'backoff', wake: { type: 'time', eligibleAt: 500 } };
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const first = coordinator.admit('background-job', { epoch: 40 });
    await coordinator.drain();
    await expect(first.completion).resolves.toMatchObject({ outcome: 'deferred' });
    expect(coordinator.admit('background-job', { epoch: 40 }).status).toBe('coalesced_wake');

    const wakeAdmission = coordinator.admit('background-job', {
      epoch: 40,
      wake: { type: 'authority', key: 'healthy' },
    });
    expect(wakeAdmission.status).toBe('admitted_wake');
    await coordinator.drain();
    await expect(wakeAdmission.completion).resolves.toMatchObject({ outcome: 'backoff' });

    now = 499;
    expect(coordinator.admit('background-job', { epoch: 40 }).status).toBe('coalesced_wake');
    now = 500;
    const backoffAdmission = coordinator.admit('background-job', { epoch: 40 });
    expect(backoffAdmission.status).toBe('admitted_wake');
    await coordinator.drain();
    await expect(backoffAdmission.completion).resolves.toMatchObject({ outcome: 'done' });
  });

  it('accounts for a typed wake admitted in a later epoch exactly once', async () => {
    let turn = 0;
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        return turn === 1
          ? { outcome: 'deferred', wake: { type: 'authority', key: 'healthy' } }
          : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('background-job', { epoch: 41 });
    await coordinator.drain();
    const wakeAdmission = coordinator.admit('background-job', {
      epoch: 42,
      wake: { type: 'authority', key: 'healthy' },
    });
    await coordinator.drain();

    expect(wakeAdmission.status).toBe('admitted_wake');
    expect(coordinator.admit('background-job', { epoch: 42 })).toMatchObject({
      status: 'already_admitted',
      instanceId: wakeAdmission.instanceId,
    });
  });

  it('F01: closes a deferred epoch while allowing an unwoken later epoch to run', async () => {
    let turn = 0;
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        return turn === 1
          ? { outcome: 'deferred', wake: { type: 'canonical_health' } }
          : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    const epochOne = coordinator.admit('background-job', { epoch: 100 });
    await coordinator.drain();
    const epochOneTerminal = await epochOne.completion;
    expect(epochOneTerminal).toMatchObject({ epoch: 100, outcome: 'deferred' });
    expect(coordinator.admit('background-job', { epoch: 100 }).status).toBe('coalesced_wake');

    const epochTwo = coordinator.admit('background-job', { epoch: 101 });
    expect(epochTwo).toMatchObject({ status: 'admitted_wake', epoch: 101 });
    expect(epochTwo.instanceId).not.toBe(epochOne.instanceId);
    await coordinator.drain();

    await expect(epochTwo.completion).resolves.toMatchObject({ epoch: 101, outcome: 'done' });
    await expect(epochOne.completion).resolves.toEqual(epochOneTerminal);
    expect(turn).toBe(2);
  });

  it('F01: preserves a future time-backoff gate across later lifecycle epochs', async () => {
    let now = 200;
    let turn = 0;
    const coordinator = createAppWorkCoordinator({ autoStart: false, now: () => now });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.reportZeroWork();
        return turn === 1
          ? { outcome: 'backoff', wake: { type: 'time', eligibleAt: 500 } }
          : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('background-job', { epoch: 110 });
    await coordinator.drain();
    now = 499;
    expect(coordinator.admit('background-job', { epoch: 111 }).status).toBe('coalesced_wake');
    expect(turn).toBe(1);

    now = 500;
    const eligible = coordinator.admit('background-job', { epoch: 111 });
    expect(eligible).toMatchObject({ status: 'admitted_wake', epoch: 111 });
    await coordinator.drain();
    await expect(eligible.completion).resolves.toMatchObject({ outcome: 'done', epoch: 111 });
    expect(turn).toBe(2);
  });

  it('rejects deferred/backoff outcomes without their required wake metadata', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({ runTurn: async () => ({ outcome: 'deferred' }) }));
    const admission = coordinator.admit('background-job', { epoch: 50 });

    const result = await coordinator.runNextTurn();
    expect(result).toMatchObject({ outcome: 'failing' });
    expect(result.error).toBeInstanceOf(TypeError);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'failing', failed: true });
  });

  it.each([100, 5_000, Number.MAX_SAFE_INTEGER])(
    'V8: enforces the same one-turn ceiling without allocating workload N=%s',
    async (totalItems) => {
      let remaining = totalItems;
      const coordinator = createAppWorkCoordinator({ autoStart: false });
      coordinator.registerJob(backgroundRegistration({
        budget: { items: 7, bytes: 28, work: 1, timeMs: 50 },
        runTurn: async ({ budget }) => {
          const items = Math.min(remaining, 7);
          budget.consume({ items, bytes: items * 4, work: 1 });
          expect(() => budget.consume({ items: 1 })).toThrow(AppWorkBudgetExceededError);
          remaining -= items;
          return remaining > 0 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
        },
      }));

      coordinator.admit('background-job', { epoch: 60 });
      const result = await coordinator.runNextTurn();
      expect(result.consumedBudget).toMatchObject({ items: 7, bytes: 28, work: 1, turns: 1 });
      expect(coordinator.getCoordinatorSnapshot()).toMatchObject({ registeredJobs: 1, activeInstances: 1 });
    }
  );

  it('F03: preserves hasMore and convergence after a post-hoc time overrun', async () => {
    let now = 0;
    let turn = 0;
    const coordinator = createAppWorkCoordinator({
      autoStart: false,
      now: () => now,
      yieldControl: vi.fn(),
    });
    coordinator.registerJob(backgroundRegistration({
      budget: { items: 1, timeMs: 50 },
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.consume({ items: 1 });
        now += turn === 1 ? 51 : 1;
        return turn === 1 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 70 });

    const first = await coordinator.runNextTurn();
    expect(first).toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'hasMore',
      timeBudgetOverrun: true,
    });
    await coordinator.drain();

    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
      turnCount: 2,
    });
    expect(coordinator.getTelemetrySnapshot().events[0]).toMatchObject({
      declaredBudget: { timeMs: 50 },
      consumedBudget: { timeMs: 51 },
      turnOutcome: 'hasMore',
      timeBudgetOverrun: true,
    });
  });

  it('F03: preserves done after a post-hoc time overrun', async () => {
    let now = 0;
    const coordinator = createAppWorkCoordinator({ autoStart: false, now: () => now });
    coordinator.registerJob(backgroundRegistration({
      budget: { work: 1, timeMs: 50 },
      runTurn: async ({ budget }) => {
        budget.consume({ work: 1 });
        now = 51;
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 71 });

    const result = await coordinator.runNextTurn();
    expect(result).toMatchObject({ outcome: 'done', timeBudgetOverrun: true, error: null });
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
  });

  it('F03: keeps an explicit hard item overrun as a typed contract failure', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      budget: { items: 1 },
      runTurn: async ({ budget }) => {
        budget.consume({ items: 2 });
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 72 });

    const result = await coordinator.runNextTurn();
    expect(result.outcome).toBe('failing');
    expect(result.error).toBeInstanceOf(AppWorkBudgetExceededError);
    expect(result.error?.code).toBe('APP_WORK_BUDGET_EXCEEDED');
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'failing' });
  });

  it('F04: rejects a normal turn that omits its accounting disposition', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async () => APP_WORK_TURN_RESULTS.HAS_MORE,
    }));
    const admission = coordinator.admit('background-job', { epoch: 73 });

    const result = await coordinator.runNextTurn();
    expect(result.outcome).toBe('failing');
    expect(result.error).toBeInstanceOf(AppWorkAccountingContractError);
    expect(result.error?.code).toBe('APP_WORK_ACCOUNTING_REQUIRED');
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'failing' });
  });

  it('F04: accepts legitimate zero work only through the explicit zero-work contract', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 74 });

    const result = await coordinator.runNextTurn();
    expect(result).toMatchObject({
      outcome: 'done',
      consumedBudget: { accounting: 'zero', items: 0, bytes: 0, work: 0 },
    });
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
  });

  it('F04: enforces a declared turns ceiling per scheduler run without terminating the instance', async () => {
    let turn = 0;
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      budget: { turns: 2 },
      runTurn: async ({ budget }) => {
        turn += 1;
        budget.consume({ work: 1 });
        return turn < 5 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 75 });

    await expect(coordinator.drain()).resolves.toEqual({
      turns: 2,
      hasMore: true,
      turnBudgetExhausted: true,
    });
    expect(coordinator.getJobSnapshot('background-job').active).toMatchObject({
      instanceId: admission.instanceId,
      turnCount: 2,
    });
    await expect(coordinator.drain()).resolves.toEqual({
      turns: 2,
      hasMore: true,
      turnBudgetExhausted: true,
    });
    await expect(coordinator.drain()).resolves.toEqual({
      turns: 1,
      hasMore: false,
      turnBudgetExhausted: false,
    });

    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
      turnCount: 5,
    });
  });

  it.each([
    { items: 0 },
    { items: 0, bytes: 0 },
    { timeMs: 0, items: 0, bytes: 0, work: 0 },
  ])('F04: rejects an all-zero budget %#', (budget) => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    expect(() => coordinator.registerJob(backgroundRegistration({ budget }))).toThrow(/permit progress/);
  });

  it('F04: accepts a zero optional dimension when another declared dimension permits progress', () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    expect(() => coordinator.registerJob(backgroundRegistration({
      budget: { items: 0, bytes: 16 },
    }))).not.toThrow();
  });

  it('yields before every subsequent suspendible background turn and re-enters at the tail', async () => {
    const order = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: false,
      yieldControl: async () => { order.push('yield'); },
    });
    coordinator.registerJob(backgroundRegistration({
      jobKey: 'first',
      runTurn: async ({ turnNumber, budget }) => {
        order.push(`first:${turnNumber}`);
        budget.reportZeroWork();
        return turnNumber === 1 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    coordinator.registerJob(backgroundRegistration({
      jobKey: 'second',
      runTurn: async ({ budget }) => {
        order.push('second:1');
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('first', { epoch: 80 });
    coordinator.admit('second', { epoch: 80 });
    await coordinator.drain();

    expect(order).toEqual(['first:1', 'yield', 'second:1', 'yield', 'first:2']);
  });

  it('retains the background-yield boundary across a temporarily empty queue', async () => {
    const order = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: false,
      yieldControl: async () => { order.push('yield'); },
    });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ turnNumber, budget }) => {
        order.push(`turn:${turnNumber}`);
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('background-job', { epoch: 81 });
    await coordinator.drain();
    coordinator.admit('background-job', { epoch: 82 });
    await coordinator.drain();

    expect(order).toEqual(['turn:1', 'yield', 'turn:1']);
  });

  it('V9: finishes the current safe turn, suspends its continuation while hidden, and resumes later', async () => {
    const entered = deferred();
    const release = deferred();
    const commits = [];
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ turnNumber, budget, criticalSection }) => criticalSection.run(async () => {
        entered.resolve();
        if (turnNumber === 1) await release.promise;
        commits.push(turnNumber);
        budget.consume({ items: 1 });
        return turnNumber === 1 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      }),
    }));
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });
    const admission = coordinator.admit('background-job', { epoch: 1 });

    const firstTurn = coordinator.runNextTurn();
    await entered.promise;
    coordinator.setLifecycleState({ effectiveForeground: false, epoch: 2 });
    release.resolve();
    await expect(firstTurn).resolves.toMatchObject({ outcome: 'hasMore' });
    expect(commits).toEqual([1]);
    await expect(coordinator.drain()).resolves.toMatchObject({ turns: 0, hasMore: true });

    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 3 });
    coordinator.admit('background-job', { epoch: 3 });
    await coordinator.drain();
    expect(commits).toEqual([1, 2]);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done', turnCount: 2 });
  });

  it('V9: does not begin a suspendible turn while already hidden', async () => {
    const runTurn = vi.fn(async ({ budget }) => {
      budget.reportZeroWork();
      return APP_WORK_TURN_RESULTS.DONE;
    });
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({ runTurn }));
    coordinator.setLifecycleState({ effectiveForeground: false, epoch: 1 });
    coordinator.admit('background-job', { epoch: 1 });

    await expect(coordinator.drain()).resolves.toMatchObject({ turns: 0, hasMore: true });
    expect(runTurn).not.toHaveBeenCalled();
  });

  it('V10: hiding cannot admit, cancel, or replay observed native-critical work', () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob({
      jobKey: 'native-critical',
      workClass: APP_WORK_CLASSES.DURABILITY_CRITICAL_NATIVE_OWNED,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    });
    coordinator.setLifecycleState({ effectiveForeground: false, epoch: 9 });
    coordinator.observeNativeOwned('native-critical', { epoch: 9, state: 'commit_in_progress' });

    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({ activeInstances: 0, backlog: 0 });
    expect(coordinator.getTelemetrySnapshot().events.at(-1)).toMatchObject({
      jobKey: 'native-critical',
      convergenceState: 'commit_in_progress',
    });
    expect(() => coordinator.admit('native-critical', { epoch: 9 })).toThrow(/observe-only/);
  });

  it('V12/V30: revalidates a queued continuation and obsoletes a changed admission token', async () => {
    let generation = 'g1';
    const commits = [];
    const guard = vi.fn(async () => ({
      outcome: 'ready',
      token: { archiveGeneration: generation, erasureToken: generation },
    }));
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      admissionGuard: guard,
      runTurn: async ({ turnNumber, budget }) => {
        commits.push(generation);
        budget.consume({ items: 1 });
        return turnNumber === 1 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));
    const admission = coordinator.admit('background-job', { epoch: 10 });
    await coordinator.runNextTurn();
    generation = 'g2';
    await coordinator.runNextTurn();

    expect(guard).toHaveBeenCalledTimes(2);
    expect(commits).toEqual(['g1']);
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'obsolete', turnCount: 2 });
  });

  it('V11/V30: typed authority deferral does not execute the domain callback', async () => {
    const runTurn = vi.fn();
    const coordinator = createAppWorkCoordinator({ autoStart: false });
    coordinator.registerJob(backgroundRegistration({
      admissionGuard: async () => ({
        outcome: APP_WORK_TURN_RESULTS.DEFERRED,
        wake: { type: 'canonical_health', key: 'healthy' },
      }),
      runTurn,
    }));
    const admission = coordinator.admit('background-job', { epoch: 11 });
    await coordinator.runNextTurn();

    expect(runTurn).not.toHaveBeenCalled();
    await expect(admission.completion).resolves.toMatchObject({
      outcome: 'deferred',
      wake: { type: 'canonical_health', key: 'healthy' },
    });
  });

  it('V20: keeps telemetry bounded and reading it cannot recursively schedule work', async () => {
    let turns = 0;
    const yieldControl = vi.fn(async () => {});
    const coordinator = createAppWorkCoordinator({
      autoStart: false,
      telemetryLimit: 4,
      yieldControl,
    });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        turns += 1;
        budget.consume({ items: 1 });
        return turns < 8 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    }));

    coordinator.admit('background-job', { epoch: 90 });
    await coordinator.drain();
    const before = coordinator.getCoordinatorSnapshot();
    const telemetry = coordinator.getTelemetrySnapshot();
    const again = coordinator.getTelemetrySnapshot();
    const after = coordinator.getCoordinatorSnapshot();

    expect(telemetry).toMatchObject({ limit: 4, dropped: 4 });
    expect(telemetry.events).toHaveLength(4);
    expect(telemetry.events.at(-1)).toMatchObject({
      jobKey: 'background-job',
      lifecycleEpoch: 90,
      turnCount: 8,
      turnOutcome: 'done',
      convergenceState: 'done',
      backlog: 0,
    });
    expect(again).toEqual(telemetry);
    expect(after).toEqual(before);
    expect(yieldControl).toHaveBeenCalledTimes(7);
  });

  it('P4-B-F01-3-A: refuses a domain follow-up for a job that declared no such capability', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration());
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 7 });

    expect(coordinator.admit('background-job', { epoch: 7 }).status).toBe('admitted');
    await coordinator.drain();
    const settled = coordinator.getJobSnapshot('background-job');
    const turnsWhenSettled = coordinator.getTelemetrySnapshot().count;

    const rejected = coordinator.admitDomainFollowUp('background-job', {
      reason: 'progression_migration_complete',
    });

    expect(rejected.status).toBe('domain_followup_unauthorized');
    expect(rejected.instanceId).toBeNull();
    // No same-epoch rerun: no instance, nothing queued, and draining runs nothing.
    expect(coordinator.getJobSnapshot('background-job').active).toBeNull();
    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({ activeInstances: 0, backlog: 0 });
    await coordinator.drain();
    expect(coordinator.getTelemetrySnapshot().count).toBe(turnsWhenSettled);
    expect(coordinator.getJobSnapshot('background-job').lastTerminal).toEqual(settled.lastTerminal);
    // latestExternalEpoch is untouched: epoch 7 is still spent, and the next
    // epoch is still admissible exactly once.
    expect(coordinator.admit('background-job', { epoch: 7 }).status).toBe('already_admitted');
    expect(coordinator.admit('background-job', { epoch: 8 }).status).toBe('admitted');
  });

  it('P4-B-F01-3-A: an unauthorized domain follow-up leaves a sleeping job asleep on its own wake', async () => {
    const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
    coordinator.registerJob(backgroundRegistration({
      runTurn: async ({ budget }) => {
        budget.reportZeroWork();
        return { outcome: APP_WORK_TURN_RESULTS.DEFERRED, wake: { type: 'domain', key: 'expected' } };
      },
    }));
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 12 });

    coordinator.admit('background-job', { epoch: 12 });
    await coordinator.drain();
    const asleep = coordinator.getJobSnapshot('background-job');
    expect(coordinator.getCoordinatorSnapshot().sleepingInstances).toBe(1);
    expect(asleep.wake).toEqual({ type: 'domain', key: 'expected' });

    const rejected = coordinator.admitDomainFollowUp('background-job', {
      reason: 'progression_migration_complete',
    });

    expect(rejected.status).toBe('domain_followup_unauthorized');
    expect(rejected.instanceId).toBeNull();
    // Still asleep, on exactly the wake the turn installed, with no new instance.
    expect(coordinator.getCoordinatorSnapshot()).toMatchObject({
      sleepingInstances: 1,
      activeInstances: 0,
      backlog: 0,
    });
    const after = coordinator.getJobSnapshot('background-job');
    expect(after.wake).toEqual({ type: 'domain', key: 'expected' });
    expect(after.active).toBeNull();
    // And the wake still works: only the real signal wakes it.
    expect(coordinator.admit('background-job', { epoch: 12, wake: { type: 'domain', key: 'expected' } }).status)
      .toBe('admitted_wake');
  });
});
