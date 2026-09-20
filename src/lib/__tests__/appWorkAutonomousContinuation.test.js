import { describe, expect, it } from 'vitest';

import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';
import { P6_TURN_BUDGET } from '@/lib/p6Contracts';

/**
 * DPD-015 — a bounded job with unfinished work must keep being admitted until it
 * converges, from a single external trigger.
 *
 * Measured on an A54 at 500 trips: after a 372-trip delta import, D1 advanced
 * roughly 1.09 subjects per *manufactured* HOME/relaunch cycle and made
 * essentially no progress across 27 minutes of ordinary foreground use. Draining
 * the delta would have needed on the order of 450 synthetic resume events, which
 * no real user produces.
 *
 * The architectural law under test: bounded work may need many turns, but those
 * turns must continue to be admitted without a human manufacturing lifecycle
 * events. These tests drive the real coordinator with a P6-shaped registration
 * (`P6_TURN_BUDGET`, SUSPENDIBLE_BACKGROUND) and assert the observable outcome —
 * subjects actually drained from one admission — not that a flag was set.
 */

/** A P6-shaped job that owns `subjects` units of work, one per turn. */
const drainingJob = (jobKey, subjects, log) => {
  const state = { remaining: subjects, turns: 0 };
  return {
    registration: {
      jobKey,
      workClass: APP_WORK_CLASSES.SUSPENDIBLE_BACKGROUND,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.TERMINATE_AND_READMIT,
      budget: { ...P6_TURN_BUDGET },
      runTurn: async ({ budget }) => {
        state.turns += 1;
        log.push(jobKey);
        if (state.remaining <= 0) {
          budget.reportZeroWork();
          return APP_WORK_TURN_RESULTS.DONE;
        }
        state.remaining -= 1;
        budget.consume({ items: 1, bytes: 16 });
        return state.remaining > 0
          ? APP_WORK_TURN_RESULTS.HAS_MORE
          : APP_WORK_TURN_RESULTS.DONE;
      },
    },
    state,
  };
};

/**
 * Let the autoStart pump run until `done()` or the wall-clock bound.
 * Condition-based rather than a fixed tick count, so a slow pump is reported as
 * a failure to converge instead of as a test timeout.
 */
const settle = async (done = () => false, budgetMs = 8000) => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (done()) return true;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return done();
};

describe('DPD-015 autonomous continuation of bounded work', () => {
  it('drains a large backlog from ONE admission, without further lifecycle events', async () => {
    const log = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: true,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
      scheduleDispatch: (callback) => setTimeout(callback, 0),
    });
    const job = drainingJob('p6-derived', 400, log);
    coordinator.registerJob(job.registration);
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });

    // Exactly one external trigger — the bootstrap admission. Nothing after this
    // simulates a resume, a page open, or any user action.
    coordinator.admit('p6-derived', { epoch: 1 });

    await settle(() => job.state.remaining === 0, 15000);

    expect(job.state.remaining,
      'a single admission must drain the backlog; leftovers mean the user has to manufacture wakes')
      .toBe(0);
    // Many bounded turns, not one giant turn.
    expect(job.state.turns).toBeGreaterThan(100);
  }, 30_000);

  it('keeps each turn within its declared item budget', async () => {
    const log = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: true,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
      scheduleDispatch: (callback) => setTimeout(callback, 0),
    });
    const job = drainingJob('p6-derived', 60, log);
    coordinator.registerJob(job.registration);
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });
    coordinator.admit('p6-derived', { epoch: 1 });
    await settle(() => job.state.remaining === 0, 10000);

    expect(job.state.remaining).toBe(0);
    // One unit per turn by construction: proves no turn swallowed the backlog.
    expect(job.state.turns).toBeGreaterThanOrEqual(60);
  }, 30_000);

  it('lets a second registered job progress too — no single-job monopoly', async () => {
    const log = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: true,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
      scheduleDispatch: (callback) => setTimeout(callback, 0),
    });
    const derived = drainingJob('p6-derived', 200, log);
    const road = drainingJob('p6-road', 200, log);
    coordinator.registerJob(derived.registration);
    coordinator.registerJob(road.registration);
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });

    coordinator.admit('p6-derived', { epoch: 1 });
    coordinator.admit('p6-road', { epoch: 1 });

    await settle(() => derived.state.remaining === 0 && road.state.remaining === 0, 20000);

    expect(derived.state.remaining, 'derived job starved by the other job').toBe(0);
    expect(road.state.remaining, 'road job starved by the other job').toBe(0);
    // Interleaving, not one job to completion then the other.
    const firstRoad = log.indexOf('p6-road');
    const lastDerived = log.lastIndexOf('p6-derived');
    expect(firstRoad).toBeGreaterThanOrEqual(0);
    expect(firstRoad).toBeLessThan(lastDerived);
  }, 30_000);

  it('does not hot-spin once the backlog is empty', async () => {
    const log = [];
    const coordinator = createAppWorkCoordinator({
      autoStart: true,
      yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
      scheduleDispatch: (callback) => setTimeout(callback, 0),
    });
    const job = drainingJob('p6-derived', 5, log);
    coordinator.registerJob(job.registration);
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 1 });
    coordinator.admit('p6-derived', { epoch: 1 });
    await settle(() => job.state.remaining === 0, 8000);

    const turnsAfterDrain = job.state.turns;
    await settle(() => false, 1500);
    expect(job.state.turns - turnsAfterDrain,
      'coordinator kept running turns after the queue emptied').toBeLessThanOrEqual(1);
  }, 30_000);
});
