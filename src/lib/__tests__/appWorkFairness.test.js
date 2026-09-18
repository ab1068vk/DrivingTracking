import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';

/**
 * V6 / V7 — M6 and DN13.
 *
 * Every assertion here is driven by an injectable clock and by operation
 * counts. Wall-clock timing is never the correctness signal.
 */

const GATE_MS = 100;
const DEADLINE_MS = 500;
const BACKGROUND_TURN_MS = 20;

const harness = ({ backgroundTurns = 12 } = {}) => {
  let now = 0;
  const order = [];
  let remaining = backgroundTurns;

  const coordinator = createAppWorkCoordinator({
    autoStart: false,
    yieldControl: vi.fn(),
    now: () => now,
    backgroundDeadlineMs: DEADLINE_MS,
    interactiveLatencyGateMs: GATE_MS,
  });

  coordinator.registerJob({
    jobKey: 'background',
    workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 4, timeMs: BACKGROUND_TURN_MS, turns: 200 },
    runTurn: async ({ budget }) => {
      order.push({ kind: 'background', at: now });
      budget.consume({ items: 1 });
      // A background turn consumes real (virtual) time, bounded by its budget.
      now += BACKGROUND_TURN_MS;
      remaining -= 1;
      return remaining > 0 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
    },
  });

  coordinator.registerJob({
    jobKey: 'interactive',
    workClass: APP_WORK_CLASSES.INTERACTIVE_EXPLICIT,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 1 },
    runTurn: async ({ budget }) => {
      order.push({ kind: 'interactive', at: now, waited: now - interactiveQueuedAt });
      budget.consume({ items: 1 });
      now += 1;
      return APP_WORK_TURN_RESULTS.DONE;
    },
  });

  let interactiveQueuedAt = 0;
  let interactiveEpoch = 1;
  const enqueueInteractive = () => {
    interactiveQueuedAt = now;
    interactiveEpoch += 1;
    coordinator.admit('interactive', { epoch: interactiveEpoch });
  };

  return {
    coordinator,
    order,
    enqueueInteractive,
    advance: (ms) => { now += ms; },
    at: () => now,
    backgroundRemaining: () => remaining,
  };
};

describe('V6: interactive precedence', () => {
  it('serves each pending interactive operation before the next ordinary background turn', async () => {
    const h = harness();
    const admission = h.coordinator.admit('background', { epoch: 1 });

    // Sustained interactive traffic: one operation enqueued before every
    // scheduler turn, always inside the aging deadline.
    for (let round = 0; round < 6; round += 1) {
      h.enqueueInteractive();
      await h.coordinator.runNextTurn();
      h.advance(10);
    }

    // Every one of those turns went to interactive work, never background.
    expect(h.order.map((entry) => entry.kind)).toEqual(Array(6).fill('interactive'));
    expect(h.coordinator.getJobSnapshot('background').active.instanceId).toBe(admission.instanceId);
  });

  it('keeps foreground latency inside the declared gate', async () => {
    const h = harness();
    h.coordinator.admit('background', { epoch: 1 });

    for (let round = 0; round < 8; round += 1) {
      h.enqueueInteractive();
      await h.coordinator.runNextTurn();
      h.advance(10);
    }

    const waits = h.order.filter((entry) => entry.kind === 'interactive').map((entry) => entry.waited);
    // Deterministic: an interactive operation admitted while no background
    // instance is overdue waits for nothing at all.
    expect(Math.max(...waits)).toBeLessThanOrEqual(GATE_MS);
    expect(waits.every((wait) => wait === 0)).toBe(true);
  });

  it('observes the declared gate rather than asserting it at registration', async () => {
    // P4-D-F02: the gate is measured. An interactive operation that waited
    // longer than the declared gate is *reported*, and nothing about the
    // scheduling decision or the domain result changes.
    const h = harness();
    h.coordinator.admit('background', { epoch: 1 });
    h.enqueueInteractive();
    h.advance(DEADLINE_MS + 1);

    await h.coordinator.runNextTurn(); // the one aged background turn
    await h.coordinator.runNextTurn(); // interactive precedence restored

    const events = h.coordinator.getTelemetrySnapshot().events;
    const interactive = events.filter((event) => event.jobKey === 'interactive');
    expect(interactive).toHaveLength(1);
    expect(interactive[0].interactiveLatencyGateMs).toBe(GATE_MS);
    // It waited past the deadline before the aged turn, so the observation is
    // truthful rather than decorative.
    expect(interactive[0].interactiveLatencyGateExceeded).toBe(true);
    const background = events.filter((event) => event.jobKey === 'background');
    // The gate is not applied to background work at all.
    expect(background.every((event) => event.interactiveLatencyGateExceeded === false)).toBe(true);
  });

  it('uses no numeric, weighted or ratio priority mechanism', () => {
    const source = readCoordinatorSource();
    // Comments are stripped: this asserts about the mechanism, not the prose
    // describing which mechanisms were rejected.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/\bweight\b|\bpriorityValue\b|priorityNumber/i);
    expect(code).not.toMatch(/3\s*:\s*1|\bratio\b/i);
    expect(code).not.toMatch(/secureBridge|withSecureBulkAdmission|writerPriority/i);
    // The fairness decision is an age comparison against the injectable clock.
    expect(code).toMatch(/_backgroundIsOverdue\(\)[\s\S]{0,240}>= this\.backgroundDeadlineMs/);
  });
});

describe('V7: background convergence under sustained interactive load', () => {
  it('still reaches a terminal state through bounded aged admissions', async () => {
    const h = harness({ backgroundTurns: 6 });
    const admission = h.coordinator.admit('background', { epoch: 1 });

    // Interactive work never stops arriving. Without aging this loop would
    // starve the background instance forever.
    let guard = 0;
    while (h.backgroundRemaining() > 0 && guard < 500) {
      h.enqueueInteractive();
      await h.coordinator.runNextTurn();
      h.advance(60);
      guard += 1;
    }
    await h.coordinator.drain();

    const backgroundTurns = h.order.filter((entry) => entry.kind === 'background');
    const interactiveTurns = h.order.filter((entry) => entry.kind === 'interactive');

    expect(backgroundTurns).toHaveLength(6);
    expect(interactiveTurns.length).toBeGreaterThan(0);
    await expect(admission.completion).resolves.toMatchObject({
      instanceId: admission.instanceId,
      outcome: 'done',
      turnCount: 6,
    });
    // Convergence came from more bounded turns, not a bigger turn.
    expect(h.coordinator.getTelemetrySnapshot().events
      .filter((event) => event.jobKey === 'background')
      .every((event) => event.consumedBudget.items <= 4)).toBe(true);
  });

  it('the aged opportunity is exactly one bounded turn, and is counted', async () => {
    const h = harness({ backgroundTurns: 3 });
    h.coordinator.admit('background', { epoch: 1 });

    // Park the background instance past its deadline with interactive pending.
    h.enqueueInteractive();
    h.advance(DEADLINE_MS + 1);
    await h.coordinator.runNextTurn();

    // The overdue background instance took the slot exactly once.
    expect(h.order.at(-1).kind).toBe('background');
    expect(h.coordinator.agedAdmissions).toBe(1);

    // The still-pending interactive operation is served immediately after,
    // delayed by at most one bounded background turn.
    await h.coordinator.runNextTurn();
    expect(h.order.at(-1).kind).toBe('interactive');
    expect(h.order.at(-1).waited).toBeLessThanOrEqual(
      DEADLINE_MS + 1 + BACKGROUND_TURN_MS
    );
    const telemetry = h.coordinator.getTelemetrySnapshot().events;
    expect(telemetry.some((event) => event.admittedByAging === true)).toBe(true);
  });

  it('does not age in background work while the app is effectively hidden', async () => {
    const h = harness({ backgroundTurns: 3 });
    h.coordinator.admit('background', { epoch: 1 });
    h.coordinator.setLifecycleState({ effectiveForeground: false, epoch: 2 });

    h.enqueueInteractive();
    h.advance(DEADLINE_MS * 10);
    await h.coordinator.runNextTurn();

    // Hidden-state suspension still wins: aging never overrides it.
    expect(h.order.at(-1).kind).toBe('interactive');
    expect(h.coordinator.agedAdmissions).toBe(0);
  });
});

/**
 * P4-D-F01 — the aged opportunity is one turn, not one per overdue job.
 *
 * The pre-fix coordinator recomputed aging from whatever background instance
 * had become the new head, so two overdue background jobs produced the order
 * `A, B, I`: the interactive delay grew with the number of overdue
 * registrations instead of staying one bounded background turn.
 */
const multiHarness = ({ backgrounds, turnsEach = 1 }) => {
  let now = 0;
  const order = [];
  const remaining = new Map(backgrounds.map((jobKey) => [jobKey, turnsEach]));

  const coordinator = createAppWorkCoordinator({
    autoStart: false,
    yieldControl: vi.fn(),
    now: () => now,
    backgroundDeadlineMs: DEADLINE_MS,
    interactiveLatencyGateMs: GATE_MS,
  });

  for (const jobKey of backgrounds) {
    coordinator.registerJob({
      jobKey,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      budget: { items: 4, turns: 1_000 },
      runTurn: async ({ budget }) => {
        budget.consume({ items: 1 });
        now += BACKGROUND_TURN_MS;
        const left = remaining.get(jobKey) - 1;
        remaining.set(jobKey, left);
        return left > 0 ? APP_WORK_TURN_RESULTS.HAS_MORE : APP_WORK_TURN_RESULTS.DONE;
      },
    });
  }

  coordinator.registerJob({
    jobKey: 'interactive',
    workClass: APP_WORK_CLASSES.INTERACTIVE_EXPLICIT,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 1 },
    runTurn: async ({ budget }) => {
      budget.consume({ items: 1 });
      now += 1;
      return APP_WORK_TURN_RESULTS.DONE;
    },
  });

  let interactiveEpoch = 1;

  /**
   * One scheduler step, recorded with the queue state that existed when the
   * admission decision was taken. `interactivePending` is what makes the
   * fairness law checkable: two background turns in a row are only a violation
   * while runnable interactive work was actually waiting.
   */
  const step = async () => {
    const interactivePending = coordinator.queues.interactive.length;
    const result = await coordinator.runNextTurn();
    if (!result) return null;
    const entry = {
      jobKey: result.jobKey,
      kind: result.jobKey === 'interactive' ? 'interactive' : 'background',
      interactivePending,
      at: now,
    };
    order.push(entry);
    return entry;
  };

  return {
    coordinator,
    order,
    step,
    advance: (ms) => { now += ms; },
    enqueueInteractive: () => {
      interactiveEpoch += 1;
      coordinator.admit('interactive', { epoch: interactiveEpoch });
    },
    backgroundRemaining: () => [...remaining.values()].reduce((sum, left) => sum + left, 0),
  };
};

/**
 * The invariant, stated once: no two aged background admissions may occur back
 * to back while runnable interactive work is still pending.
 */
const noConsecutiveAgedAdmissions = (order) => {
  for (let index = 1; index < order.length; index += 1) {
    const previous = order[index - 1];
    const current = order[index];
    if (
      previous.kind === 'background' &&
      current.kind === 'background' &&
      current.interactivePending > 0
    ) {
      return { violated: true, at: index, pair: [previous.jobKey, current.jobKey] };
    }
  }
  return { violated: false };
};

describe('P4-D-F01: an aged background turn restores interactive precedence', () => {
  it('does not chain a second overdue background ahead of pending interactive work', async () => {
    const h = multiHarness({ backgrounds: ['a', 'b'], turnsEach: 1 });
    h.coordinator.admit('a', { epoch: 1 });
    h.coordinator.admit('b', { epoch: 1 });
    // Both background instances are past the aging deadline; one interactive
    // operation is waiting behind them.
    h.advance(DEADLINE_MS + 1);
    h.enqueueInteractive();

    await h.step();
    await h.step();
    await h.step();

    // The reproduced pre-fix order was exactly ['a', 'b', 'interactive'].
    expect(h.order.map((entry) => entry.jobKey)).toEqual(['a', 'interactive', 'b']);
    expect(h.order.map((entry) => entry.kind))
      .toEqual(['background', 'interactive', 'background']);
    expect(noConsecutiveAgedAdmissions(h.order)).toEqual({ violated: false });
    // Exactly one aged exception was spent before interactive ran again.
    expect(h.coordinator.agedAdmissions).toBe(1);
  });

  it('converges every overdue background under continuous interactive traffic', async () => {
    const h = multiHarness({ backgrounds: ['a', 'b', 'c', 'd'], turnsEach: 3 });
    for (const jobKey of ['a', 'b', 'c', 'd']) h.coordinator.admit(jobKey, { epoch: 1 });
    h.advance(DEADLINE_MS + 1);

    let guard = 0;
    while (h.backgroundRemaining() > 0 && guard < 400) {
      // Interactive work never stops arriving, and every background head keeps
      // ageing past the deadline.
      h.enqueueInteractive();
      await h.step();
      h.advance(DEADLINE_MS + 1);
      guard += 1;
    }
    await h.coordinator.drain();

    // (1) the law itself, across the whole run.
    expect(noConsecutiveAgedAdmissions(h.order)).toEqual({ violated: false });
    // (2) every background converged - bounded progress, not starvation.
    expect(h.backgroundRemaining()).toBe(0);
    for (const jobKey of ['a', 'b', 'c', 'd']) {
      expect(h.coordinator.getJobSnapshot(jobKey)).toMatchObject({
        active: null,
        lastTerminal: expect.objectContaining({ outcome: 'done', turnCount: 3 }),
      });
    }
    // (3) interactive work kept recurring throughout, never blocked out.
    const interactiveTurns = h.order.filter((entry) => entry.kind === 'interactive');
    expect(interactiveTurns.length).toBeGreaterThanOrEqual(11);
    // (4) and it is not a ratio: aged admissions and interactive turns simply
    // alternate, one aged exception per restored interactive opportunity.
    expect(h.coordinator.agedAdmissions).toBe(12);
  });

  it('applies the same law to a re-admitted hasMore instance and a second job', async () => {
    const h = multiHarness({ backgrounds: ['a', 'b'], turnsEach: 2 });
    h.coordinator.admit('a', { epoch: 1 });
    h.coordinator.admit('b', { epoch: 1 });
    h.advance(DEADLINE_MS + 1);

    let guard = 0;
    while (h.backgroundRemaining() > 0 && guard < 60) {
      h.enqueueInteractive();
      await h.step();
      h.advance(DEADLINE_MS + 1);
      guard += 1;
    }

    // A `hasMore` requeue refreshes `queuedAt`, so the same logical instance
    // cannot keep its old age and take the exception twice running; and the
    // *other* overdue job cannot inherit it either.
    expect(h.order.map((entry) => entry.jobKey))
      .toEqual(['a', 'interactive', 'b', 'interactive', 'a', 'interactive', 'b']);
    expect(noConsecutiveAgedAdmissions(h.order)).toEqual({ violated: false });
    expect(h.backgroundRemaining()).toBe(0);
  });

  it('grants no aged admission at all while the app is effectively hidden', async () => {
    const h = multiHarness({ backgrounds: ['a', 'b'], turnsEach: 2 });
    const admissionA = h.coordinator.admit('a', { epoch: 1 });
    const admissionB = h.coordinator.admit('b', { epoch: 1 });
    h.coordinator.setLifecycleState({ effectiveForeground: false, epoch: 2 });
    h.advance(DEADLINE_MS * 10);

    for (let round = 0; round < 6; round += 1) {
      h.enqueueInteractive();
      await h.step();
      h.advance(DEADLINE_MS + 1);
    }

    // Hidden-state suspension still wins over aging, for every overdue job.
    expect(h.order.every((entry) => entry.kind === 'interactive')).toBe(true);
    expect(h.coordinator.agedAdmissions).toBe(0);

    // Foreground again: the scheduler resumes coherently and the same two
    // logical instances continue - no duplicates were created while hidden.
    h.coordinator.setLifecycleState({ effectiveForeground: true, epoch: 2 });
    expect(h.coordinator.getJobSnapshot('a').active.instanceId).toBe(admissionA.instanceId);
    expect(h.coordinator.getJobSnapshot('b').active.instanceId).toBe(admissionB.instanceId);
    await h.coordinator.drain();
    expect(h.backgroundRemaining()).toBe(0);
    expect(noConsecutiveAgedAdmissions(h.order)).toEqual({ violated: false });
  });

  it('is one boolean of scheduling state, with no ratio, bucket or weight', () => {
    const code = strippedCoordinatorSource();

    // The restoration rule exists ...
    expect(code).toMatch(/agedOpportunityConsumed/);
    // ... and it is a boolean, never an accumulating allowance.
    expect(code).not.toMatch(/agedOpportunityConsumed\s*[+-]=/);
    expect(code).not.toMatch(/tokenBucket|refill|allowance|quota/i);
    expect(code).not.toMatch(/\bweight\b|\bratio\b/i);
  });
});

describe('P4-D-F02: elapsed time is observational, never a registration gate', () => {
  const coordinator = () => createAppWorkCoordinator({
    autoStart: false,
    yieldControl: vi.fn(),
    interactiveLatencyGateMs: GATE_MS,
  });

  const background = (overrides = {}) => ({
    jobKey: 'bounded-background',
    workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
    newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
    budget: { items: 4, turns: 8 },
    runTurn: async ({ budget }) => {
      budget.consume({ items: 1 });
      return APP_WORK_TURN_RESULTS.DONE;
    },
    ...overrides,
  });

  it('accepts a bounded background job whose declared time target exceeds the gate', () => {
    // The removed rule rejected exactly this declaration.
    expect(() => coordinator().registerJob(background({
      budget: { items: 4, timeMs: GATE_MS + 1, turns: 8 },
    }))).not.toThrow();
    expect(() => coordinator().registerJob(background({
      budget: { items: 4, timeMs: 5_000, turns: 8 },
    }))).not.toThrow();
  });

  it('accepts a bounded background job that declares no time target at all', () => {
    // ... while this one - the shape every current production registration
    // uses - was always accepted, which is why the rule protected nothing.
    expect(() => coordinator().registerJob(background())).not.toThrow();
  });

  it('preserves a safe domain result when the turn overruns its declared time', async () => {
    let now = 0;
    const instance = createAppWorkCoordinator({
      autoStart: false,
      yieldControl: vi.fn(),
      now: () => now,
      interactiveLatencyGateMs: GATE_MS,
    });
    instance.registerJob(background({
      budget: { items: 4, timeMs: 10, turns: 8 },
      runTurn: async ({ budget }) => {
        budget.consume({ items: 2 });
        // Ten times its declared target.
        now += 100;
        return APP_WORK_TURN_RESULTS.HAS_MORE;
      },
    }));

    const admission = instance.admit('bounded-background', { epoch: 1 });
    const result = await instance.runNextTurn();

    // The domain's own outcome stands.
    expect(result.outcome).toBe(APP_WORK_TURN_RESULTS.HAS_MORE);
    expect(result.error).toBeNull();
    // The overrun is reported, truthfully, as telemetry.
    expect(result.timeBudgetOverrun).toBe(true);
    expect(result.consumedBudget.timeMs).toBe(100);
    const event = instance.getTelemetrySnapshot().events.at(-1);
    expect(event.timeBudgetOverrun).toBe(true);
    expect(event.consumedBudget.items).toBe(2);
    // And it is not terminal: the same logical instance continues.
    expect(instance.getJobSnapshot('bounded-background')).toMatchObject({
      failing: false,
      consecutiveFailures: 0,
      active: expect.objectContaining({ instanceId: admission.instanceId }),
    });
  });

  it('still rejects a real budget violation', () => {
    // Removing the time gate did not weaken budget validation itself.
    expect(() => coordinator().registerJob(background({ budget: {} })))
      .toThrow(/at least one finite turn-budget dimension/);
    expect(() => coordinator().registerJob(background({ budget: { items: 0, bytes: 0 } })))
      .toThrow(/permit progress/);
    expect(() => coordinator().registerJob(background({ budget: { items: Number.NaN } })))
      .toThrow(/non-negative finite number/);
    expect(() => coordinator().registerJob(background({ budget: null })))
      .toThrow(/require a declared turn budget/);
  });

  it('leaves no unenforceable latency exclusion behind in the coordinator', () => {
    const code = strippedCoordinatorSource();

    expect(code).not.toMatch(/timeMs\s*>\s*this\.interactiveLatencyGateMs/);
    expect(code).not.toMatch(/exceeds the declared interactive latency gate/);
    // The gate survives only in its observational role.
    expect(code).toMatch(/interactiveLatencyGateExceeded/);
  });
});

function strippedCoordinatorSource() {
  return readCoordinatorSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readCoordinatorSource() {
  // Imported lazily so the assertion reads the shipped module text.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFileSync(path.join(here, '..', 'appWorkCoordinator.js'), 'utf8');
}
