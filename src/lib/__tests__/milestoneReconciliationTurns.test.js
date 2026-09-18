import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-B-F01 regressions.
 *
 * The terminal journal turn used to `await reconcileMilestonesAfterTripSave({})`
 * inside its own coordinator turn: a zero-ingest turn could report zero work and
 * then page up to 2,000 trip summaries and 500 vehicles, after waiting behind an
 * arbitrarily deep process-local milestone queue.
 *
 * These tests drive the *real* reconciliation seams - the milestone domain's
 * bounded step interface, the real progression build, the real durable
 * achievement aggregate, the real delivered-id filter and the real coordinator.
 * Only the Capacitor-facing notification sinks are replaced.
 */

const mocks = vi.hoisted(() => ({
  queryHistoryPage: vi.fn(),
  listVehiclePage: vi.fn(),
  progressionWindowSizes: [],
  syncNotifications: vi.fn(),
  realSyncAchievementNotifications: null,
  syncCalibrationNotifications: vi.fn(),
  mirrorCalibrationState: vi.fn(),
  syncNativeTrips: vi.fn(),
  boundedJobRuns: [],
  getSettings: vi.fn(),
  logFailure: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('@/api/trips', () => ({
  tripService: { queryHistoryPage: mocks.queryHistoryPage },
  P35_NATIVE_AUTHORITY_ENABLED: false,
}));
vi.mock('@/api/vehicles', () => ({
  vehicleService: { listPage: mocks.listVehiclePage },
}));
// P4-B-F01 closure: the REAL progression seam, wrapped only to record the size
// of the window it was handed. A constant-time stand-in here would hide the
// exact defect this suite has to detect - that the settlement slice can traverse
// thousands of trip summaries without charging for them.
vi.mock('@/lib/driverProgression', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    processDriverProgressionAfterTrip: (trips, settings, options) => {
      mocks.progressionWindowSizes.push(Array.isArray(trips) ? trips.length : 0);
      return actual.processDriverProgressionAfterTrip(trips, settings, options);
    },
  };
});
// The REAL bounded-job engine, wrapped so the *call graph* itself can be
// asserted. `runBoundedTripJob({ maxPages: 0 })` is the whole-history pass the
// finding names, and it is observable here because `achievementAggregates`
// imports it from this module - an internal spy on the aggregate module's own
// exports would not see its internal calls.
vi.mock('@/lib/boundedTripJob', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runBoundedTripJob: (options = {}) => {
      mocks.boundedJobRuns.push({
        jobKey: options.jobKey,
        maxPages: Math.max(0, Math.floor(Number(options.maxPages) || 0)),
      });
      return actual.runBoundedTripJob(options);
    },
  };
});
// The REAL durable aggregate module: `readAchievementSurfaces`, the week-window
// scan and the bounded repair turn all have to be observable, because the
// remaining F01 defect was that none of them were accounted for.
vi.mock('@/lib/localTripRepository', () => ({
  syncNativeCompletedTrips: mocks.syncNativeTrips,
  applyNativeProjectionTurn: vi.fn(),
  readNativeProjectionState: vi.fn(),
  stepTripRepositoryMaintenance: vi.fn(),
}));
// The REAL `syncAchievementNotifications`, so its durable delivered-id filter is
// exercised rather than mocked away. Only the two Capacitor-facing calibration
// sinks are replaced.
vi.mock('@/lib/notificationService', async (importOriginal) => {
  const actual = await importOriginal();
  mocks.realSyncAchievementNotifications = actual.syncAchievementNotifications;
  return {
    ...actual,
    syncAchievementNotifications: (...args) => mocks.syncNotifications(...args),
    syncCalibrationMilestoneNotifications: mocks.syncCalibrationNotifications,
    mirrorCalibrationStateToNative: mocks.mirrorCalibrationState,
  };
});
vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: mocks.getSettings },
}));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: mocks.logFailure,
  recordSystemEvent: mocks.recordEvent,
}));

import {
  APP_WORK_TRIGGER_ORIGINS,
  P4_DOMAIN_FOLLOW_UP_REASONS,
  P4_LIFECYCLE_JOB_KEYS,
  createP4LifecycleWorkRuntime,
  getP4WorkCoordinator,
} from '@/lib/appLifecycleWork';
import {
  APP_WORK_CLASSES,
  APP_WORK_NEW_EPOCH_POLICIES,
  APP_WORK_TURN_RESULTS,
  createAppWorkCoordinator,
} from '@/lib/appWorkCoordinator';
import {
  ACHIEVEMENT_AGGREGATE_KEY,
  ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS,
  emptyAchievementAggregate,
} from '@/lib/achievementAggregates';
import { __milestoneReconciliationNotificationStateForTests } from '@/lib/milestoneNotificationCoordinator';
import {
  beginProgressionMigrationSession,
  progressionMigrationNeeded,
  readLegacySourceCounters,
  resetLegacySourceCounters,
  runProgressionLedgerMigration,
  stepProgressionMigrationSession,
} from '@/lib/driverProgressionMigration';
import {
  buildDriverProgression,
  syncDriverProgressionLedger,
} from '@/lib/driverProgression';
import { loadDriverProgressionLedger } from '@/lib/driverProgressionLedger';
import { PROGRESSION_XP_SEGMENT_SIZE, readXpIndex } from '@/lib/driverProgressionStore';
import { setJson } from '@/lib/mobileStorage';
import {
  MILESTONE_ACHIEVEMENT_BADGE_CEILING,
  MILESTONE_NOTIFICATION_BADGE_CEILING,
  MILESTONE_NOTIFICATION_CANDIDATE_PAGE,
  MILESTONE_RECONCILIATION_MAX_SLICES,
  MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS,
  MILESTONE_VEHICLE_PAGE,
  __resetMilestoneReconciliationRunForTests,
  isMilestoneSyncBusy,
  reconcileMilestoneNotifications,
  reconcileMilestonesAfterTripSave,
  runExplicitProgressionMigration,
  syncNativeCompletedTripsAndMilestones,
} from '@/lib/milestoneNotificationCoordinator';

const JOURNAL = P4_LIFECYCLE_JOB_KEYS.NATIVE_JOURNAL_INGEST;
const MILESTONE = P4_LIFECYCLE_JOB_KEYS.MILESTONE_RECONCILIATION;
const PROGRESSION_LEDGER_KEY = 'drivesense_driver_progression_ledger_v1';
const NOTIFIED_ACHIEVEMENTS_KEY = 'drivesense_notified_achievements';

const healthy = (overrides = {}) => ({
  authorityState: 'NATIVE',
  recoveryState: 'HEALTHY',
  sentinelMatches: true,
  archiveGeneration: 'g1',
  erasureBarrierToken: 'g1',
  ...overrides,
});

/** A deferred gate, so a test can hold work open at a chosen point. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open: () => open(undefined) };
};

const makeRuntime = ({
  health = healthy(),
  journal = vi.fn(async () => ({ hasMore: false, itemCount: 0 })),
} = {}, overrides = {}) => {
  const coordinator = createAppWorkCoordinator({ autoStart: false, yieldControl: vi.fn() });
  const runtime = createP4LifecycleWorkRuntime({
    coordinator,
    nativeAuthorityAvailable: () => true,
    readHealth: async () => health,
    runProjectionTurn: vi.fn(async () => ({ done: true, applied: 0 })),
    runJournalTurn: journal,
    ...overrides,
  });
  return { coordinator, runtime, journal };
};

/** Drive the coordinator until the named job has no active instance left. */
const drainJob = async (coordinator, jobKey, maxRuns = 80) => {
  for (let run = 0; run < maxRuns; run += 1) {
    if (!coordinator.getJobSnapshot(jobKey)?.active) return run;
    await coordinator.drain();
  }
  return maxRuns;
};

const eventsFor = (coordinator, jobKey) => coordinator.getTelemetrySnapshot().events
  .filter((event) => event.jobKey === jobKey);

/** The settlement slice is the last accounted turn of a completed run. */
const settlementEvent = (coordinator) => {
  const events = eventsFor(coordinator, MILESTONE);
  return events[events.length - 1] || null;
};

/** Every badge id the notifier was offered across all bounded passes. */
const offeredBadgeIds = () => {
  const ids = new Set();
  for (const [batch] of mocks.syncNotifications.mock.calls) batch.forEach((badge) => ids.add(badge.id));
  return ids;
};

/** A history of exactly `pages` pages of 100 completed trips, all within the week. */
const historyOfPages = (pages) => {
  mocks.queryHistoryPage.mockImplementation(async ({ cursor = null }) => {
    const index = cursor === null ? 0 : Number(cursor);
    const rows = Array.from({ length: 100 }, (_, row) => ({
      id: `trip-${index}-${row}`,
      status: 'completed',
      start_time: new Date(Date.now() - row * 60_000).toISOString(),
      distance_km: 12,
      duration_seconds: 900,
      score_overall: 80,
    }));
    return { rows, nextCursor: index + 1 < pages ? String(index + 1) : null };
  });
};

/**
 * A real, Map-backed `localStorage`. The durable achievement aggregate, the
 * progression ledger and the delivered-id set all live here, so none of them is
 * mocked away.
 */
const createStorage = () => {
  const values = new Map();
  /** P4-B-F01-3: every durable read, so a whole-document parse is observable. */
  const reads = [];
  return {
    getItem: (key) => {
      const value = values.has(key) ? values.get(key) : null;
      reads.push({ key, bytes: value == null ? 0 : value.length });
      return value;
    },
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => { values.clear(); reads.length = 0; },
    // Key enumeration is what lets the store detect legacy conversion debt
    // without ever retrieving the O(legacy N) document (P4-B-F01-3-A).
    get length() { return values.size; },
    key: (position) => [...values.keys()][position] ?? null,
    _values: values,
    _reads: reads,
  };
};
let storage;

/** Seed a valid durable aggregate so a test exercises the read, not the repair. */
const seedBuiltAggregate = () => setJson(ACHIEVEMENT_AGGREGATE_KEY, {
  ...emptyAchievementAggregate(),
  built: true,
  updatedAt: new Date().toISOString(),
});

/** Seed `count` weekly-mission XP transactions, newest first. */
const seedProgressionLedger = (count) => {
  const now = Date.now();
  storage.setItem(PROGRESSION_LEDGER_KEY, JSON.stringify({
    version: 2,
    mastery: {},
    missions: {},
    seasons: {},
    weeklyPlans: {},
    celebrations: [],
    xpTransactions: Array.from({ length: count }, (_, index) => ({
      id: `xp:mission:w${index}`,
      sourceId: `mission:w${index}`,
      type: 'mission',
      title: `Weekly mission ${index}`,
      detail: 'Advanced weekly mission',
      amount: 100,
      tripId: null,
      earnedAt: new Date(now - index * 86400000).toISOString(),
    })),
  }));
};

const seedDeliveredIds = (ids) => {
  storage.setItem(NOTIFIED_ACHIEVEMENTS_KEY, JSON.stringify(ids));
};

/**
 * Records the progression domain owns. The delivered-id set is the notification
 * service's own durable structure with its own accepted growth law, so scoping
 * to these keys keeps the F01-3 assertions about F01-3.
 */
const isProgressionRecord = (key) => (
  key === PROGRESSION_LEDGER_KEY
  || String(key).startsWith('drivesense_progression_')
);

/** The same unlocks, already converted into the segmented store. */
const seedMigratedProgression = (count) => {
  seedProgressionLedger(count);
  runProgressionLedgerMigration();
};

describe('P4-B-F01: bounded, accounted milestone reconciliation', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __resetMilestoneReconciliationRunForTests();
    storage = createStorage();
    vi.stubGlobal('localStorage', storage);
    mocks.getSettings.mockReturnValue({ achievement_notifications: true });
    mocks.listVehiclePage.mockResolvedValue({ vehicles: [{ id: 'vehicle-1' }, { id: 'vehicle-2' }], returned: 2, hasMore: false, complete: true, continuation: null });
    mocks.progressionWindowSizes.length = 0;
    mocks.boundedJobRuns.length = 0;
    mocks.syncNotifications.mockImplementation(
      (...args) => mocks.realSyncAchievementNotifications(...args)
    );
    mocks.syncCalibrationNotifications.mockResolvedValue([]);
    mocks.mirrorCalibrationState.mockResolvedValue(true);
    historyOfPages(1);
    await seedBuiltAggregate();
  });

  it('A: a zero-ingest terminal journal turn cannot report zero work while reconciling', async () => {
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 1 });

    await coordinator.runNextTurn();

    // Nothing milestone-shaped ran inside - or was awaited by - the journal turn,
    // so its zero-work disposition is the whole truth about what it consumed.
    const [journalEvent] = eventsFor(coordinator, JOURNAL);
    expect(journalEvent.consumedBudget).toMatchObject({ accounting: 'zero', items: 0, bytes: 0 });
    expect(mocks.queryHistoryPage).not.toHaveBeenCalled();
    expect(mocks.listVehiclePage).not.toHaveBeenCalled();
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });

    // The obligation survives as its own admitted, separately accounted job.
    expect(coordinator.getJobSnapshot(MILESTONE).active).not.toBeNull();
    await drainJob(coordinator, MILESTONE);

    const milestoneEvents = eventsFor(coordinator, MILESTONE);
    expect(milestoneEvents.length).toBeGreaterThan(0);
    for (const event of milestoneEvents) {
      expect(event.consumedBudget.accounting).not.toBe('missing');
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }
    // The real reconciliation actually ran: this is not a no-op seam.
    expect(mocks.queryHistoryPage).toHaveBeenCalled();
    expect(mocks.syncNotifications).toHaveBeenCalledTimes(1);
    expect(mocks.mirrorCalibrationState).toHaveBeenCalledTimes(1);
  });

  it('B/C: a deep milestone backlog monopolises no turn and never delays interactive work', async () => {
    // Hold every already-queued trip-save reconciliation open inside the
    // milestone queue's own critical section.
    const held = gate();
    mocks.listVehiclePage.mockImplementation(async () => {
      await held.promise;
      return { vehicles: [], returned: 0, hasMore: false, complete: true, continuation: null };
    });
    const backlog = Array.from({ length: 25 }, (_, index) => (
      reconcileMilestonesAfterTripSave({ tripId: `queued-${index}` })
    ));
    await Promise.resolve();
    expect(isMilestoneSyncBusy()).toBe(true);

    const { coordinator, runtime } = makeRuntime();
    let interactiveTurns = 0;
    coordinator.registerJob({
      jobKey: 'interactive-probe',
      workClass: APP_WORK_CLASSES.INTERACTIVE_EXPLICIT,
      newEpochPolicy: APP_WORK_NEW_EPOCH_POLICIES.PRESERVE_INSTANCE,
      budget: { items: 1 },
      runTurn: async ({ budget }) => {
        interactiveTurns += 1;
        budget.reportZeroWork();
        return APP_WORK_TURN_RESULTS.DONE;
      },
    });

    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 4 });
    const interactive = coordinator.admit('interactive-probe', { epoch: 4, trigger: 'explicit-user' });

    // Every one of these completes while the 25-deep backlog is still blocked,
    // which is only possible because no coordinator turn joins that queue.
    for (let turn = 0; turn < 6; turn += 1) await coordinator.runNextTurn();

    await expect(interactive.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(interactiveTurns).toBe(1);
    expect(isMilestoneSyncBusy()).toBe(true);
    // The reconciliation is still pending its settlement slice rather than done.
    expect(coordinator.getJobSnapshot(MILESTONE).active).not.toBeNull();
    for (const event of eventsFor(coordinator, MILESTONE)) {
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }

    held.open();
    await Promise.all(backlog);
    await drainJob(coordinator, MILESTONE);
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  it('D: reconciliation happens exactly once at the journal instance settlement', async () => {
    let turn = 0;
    const journal = vi.fn(async () => {
      turn += 1;
      return { hasMore: turn < 3, itemCount: 1, workBytes: 32 };
    });
    const { coordinator, runtime } = makeRuntime({ journal });
    runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 5 });

    await coordinator.drain();
    await drainJob(coordinator, MILESTONE);

    expect(journal).toHaveBeenCalledTimes(3);
    // One logical milestone instance for the settled epoch, one settlement pass.
    const instances = new Set(eventsFor(coordinator, MILESTONE).map((event) => event.instanceId));
    expect(instances.size).toBe(1);
    expect(mocks.syncNotifications).toHaveBeenCalledTimes(1);
  });

  it('E: a hasMore journal turn does not claim the reconciliation point', async () => {
    const journal = vi.fn(async () => ({ hasMore: true, itemCount: 1, workBytes: 8 }));
    const { coordinator, runtime } = makeRuntime({ journal });
    runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 6 });

    await coordinator.runNextTurn();

    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
    expect(mocks.queryHistoryPage).not.toHaveBeenCalled();
    expect(mocks.syncNotifications).not.toHaveBeenCalled();
  });

  it('F: a deferred/refused journal turn does not claim the reconciliation point', async () => {
    const { coordinator, runtime, journal } = makeRuntime({
      health: healthy({ sentinelMatches: false }),
    });
    const admission = runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 7 });

    await coordinator.drain();

    expect(journal).not.toHaveBeenCalled();
    await expect(admission.completion).resolves.toMatchObject({ outcome: 'deferred' });
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
    expect(mocks.queryHistoryPage).not.toHaveBeenCalled();
  });

  it('G: a settlement failure is logged and never rewrites the journal result', async () => {
    mocks.listVehiclePage.mockRejectedValue(new Error('vehicles unavailable'));
    mocks.syncNotifications.mockRejectedValue(new Error('notifier unavailable'));
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 8 });

    await coordinator.drain();
    await drainJob(coordinator, MILESTONE);

    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(mocks.logFailure).toHaveBeenCalledWith(
      'lifecycle_milestone_notification_sync',
      expect.any(Error),
      expect.objectContaining({ trip_id: null }),
    );
  });

  it('G: a failing reconciliation slice surfaces on its own job, not the journal one', async () => {
    mocks.queryHistoryPage.mockRejectedValue(new Error('history unavailable'));
    const { coordinator, runtime } = makeRuntime();
    const admission = runtime.admit(JOURNAL, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 9 });

    await coordinator.drain();
    await drainJob(coordinator, MILESTONE);

    await expect(admission.completion).resolves.toMatchObject({ outcome: 'done' });
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'failing' });
    expect(mocks.logFailure).toHaveBeenCalledWith(
      'native_canonical_journal_milestone_sync',
      expect.any(Error),
    );
  });

  it.each([
    ['a short history', 1],
    ['a long history', 200],
  ])('H: page/item/work accounting is invariant in retained history (%s)', async (_label, pages) => {
    historyOfPages(pages);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 12 });

    await drainJob(coordinator, MILESTONE);

    const events = eventsFor(coordinator, MILESTONE);
    // One progression page per collect turn, and never more than the frozen
    // ceilings, whether the driver has 100 trips or 20,000.
    expect(events.length).toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICES + 2);
    for (const event of events) {
      expect(event.consumedBudget.turns).toBe(1);
      // The declared ceiling is the same frozen number at every history size.
      expect(event.declaredBudget.items).toBe(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }
    for (const [request] of mocks.queryHistoryPage.mock.calls) {
      expect(request.limit).toBeLessThanOrEqual(100);
    }
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  it('I: the declared ceiling is the milestone domain\'s own frozen derivation', () => {
    // 1 settlement pass + 20 x 100 collected summaries + one 500-vehicle page
    // + the 20 x 100 aggregate week scan + the 2,000 undelivered-badge batch.
    // Nothing in it scales with N.
    expect(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS).toBe(
      1 + (MILESTONE_RECONCILIATION_MAX_SLICES - 1) * 100
      + MILESTONE_VEHICLE_PAGE
      + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS
      + MILESTONE_NOTIFICATION_CANDIDATE_PAGE
      + MILESTONE_ACHIEVEMENT_BADGE_CEILING
    );
    expect(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS).toBe(6701);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 20 });
    // The registration declares exactly that number, so the coordinator's own
    // enforcement is the thing bounding the settlement.
    expect(coordinator.registry.get(MILESTONE).budget.items)
      .toBe(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
  });

  it('I: a maximum window and a maximum aggregate week scan are both charged', async () => {
    historyOfPages(200);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 21 });

    await drainJob(coordinator, MILESTONE);

    // The real progression seam received the full collected window.
    expect(mocks.progressionWindowSizes).toEqual([2000]);
    const settlement = settlementEvent(coordinator);
    // Consumption is the work actually performed, not a nominal one item: the
    // settlement pass, the whole progression window, the vehicle page, the
    // aggregate week scan, and the undelivered badge batch.
    // Candidates *examined*, not just delivered: the settlement pass, the whole
    // progression window, the vehicle page, the aggregate week scan, and the
    // bounded notification-candidate page it filtered.
    const [firstCandidates] = mocks.syncNotifications.mock.calls[0];
    expect(settlement.consumedBudget.items).toBeGreaterThanOrEqual(
      1 + 2000 + 2 + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS + firstCandidates.length
    );
    expect(settlement.consumedBudget.items)
      .toBeGreaterThanOrEqual(2000 + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS);
    expect(settlement.consumedBudget.items)
      .toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    expect(settlement.consumedBudget.accounting).toBe('reported');
  });

  it('I: settlement consumption tracks the window while the ceiling stays fixed', async () => {
    const measure = async (pages, epoch) => {
      __resetMilestoneReconciliationRunForTests();
      mocks.progressionWindowSizes.length = 0;
      mocks.syncNotifications.mockClear();
      mocks.queryHistoryPage.mockClear();
      historyOfPages(pages);
      const { coordinator, runtime } = makeRuntime();
      runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch });
      await drainJob(coordinator, MILESTONE);
      return {
        turns: eventsFor(coordinator, MILESTONE).length,
        settlement: settlementEvent(coordinator),
        window: mocks.progressionWindowSizes[0],
      };
    };

    const short = await measure(1, 22);
    const long = await measure(20, 23);

    expect(short.window).toBe(100);
    expect(long.window).toBe(2000);
    // Reported consumption scales with the progression and week work actually
    // done...
    expect(long.settlement.consumedBudget.items)
      .toBeGreaterThan(short.settlement.consumedBudget.items);
    // ...while the enforced per-turn ceiling is identical at both sizes, and a
    // longer history buys more bounded turns rather than one bigger turn.
    expect(short.settlement.declaredBudget.items).toBe(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    expect(long.settlement.declaredBudget.items).toBe(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    expect(long.turns).toBeGreaterThan(short.turns);
  });

  it('I: the declared ceiling cannot be exceeded silently', async () => {
    const { coordinator, runtime } = makeRuntime({}, {
      // A slice that under-reports is the defect; a slice that over-reports must
      // be caught rather than quietly accepted.
      runMilestoneReconciliationTurn: async () => ({
        items: MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS + 1,
        result: APP_WORK_TURN_RESULTS.DONE,
      }),
    });
    const admission = runtime.admit(MILESTONE, {
      origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP,
      epoch: 24,
    });

    await coordinator.drain();

    await expect(admission.completion).resolves.toMatchObject({ outcome: 'failing' });
    const [event] = eventsFor(coordinator, MILESTONE);
    expect(event.failed).toBe(true);
    expect(event.declaredBudget.items).toBe(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
  });

  // ── F01-A: no whole-history aggregate repair inside a lifecycle turn ────────

  /**
   * Drive the milestone job one coordinator turn at a time, recording how many
   * history pages each individual turn read. This is what separates a bounded
   * repair from a whole-history one: the total is the same, but a
   * `runBoundedTripJob({ maxPages: 0 })` fallback drains the entire cursor
   * inside a single settlement turn.
   */
  const runTurnByTurn = async (coordinator, maxTurns = 400) => {
    const pageReadsPerTurn = [];
    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (!coordinator.getJobSnapshot(MILESTONE)?.active) break;
      const before = mocks.queryHistoryPage.mock.calls.length;
      const result = await coordinator.runNextTurn();
      if (!result) break;
      pageReadsPerTurn.push(mocks.queryHistoryPage.mock.calls.length - before);
    }
    return pageReadsPerTurn;
  };

  // The largest page read any single legitimate slice may make: the one
  // aggregate week scan, plus the slice's own progression page.
  const MAX_PAGE_READS_PER_TURN = ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS / 100 + 1;

  it('J: an invalid aggregate is repaired one bounded page per turn', async () => {
    storage.removeItem(ACHIEVEMENT_AGGREGATE_KEY);
    historyOfPages(40);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 30 });

    const pageReadsPerTurn = await runTurnByTurn(coordinator);

    // No turn swallowed the repair: the whole-history fallback would have read
    // ~40 rebuild pages plus two 20-page week scans inside one settlement turn.
    expect(Math.max(...pageReadsPerTurn)).toBeLessThanOrEqual(MAX_PAGE_READS_PER_TURN);
    // The repair really did walk the history, one page per turn.
    expect(pageReadsPerTurn.filter((reads) => reads === 1).length).toBeGreaterThanOrEqual(40);
    for (const [request] of mocks.queryHistoryPage.mock.calls) {
      expect(request.limit).toBeLessThanOrEqual(100);
    }
    for (const event of eventsFor(coordinator, MILESTONE)) {
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
    // ...and it actually repaired: the durable aggregate is valid again.
    expect(JSON.parse(storage.getItem(ACHIEVEMENT_AGGREGATE_KEY)).built).toBe(true);
  });

  it('J: retained history buys more repair turns, never a larger one', async () => {
    const repairTurns = async (pages, epoch) => {
      __resetMilestoneReconciliationRunForTests();
      storage.clear();
      mocks.queryHistoryPage.mockClear();
      historyOfPages(pages);
      const { coordinator, runtime } = makeRuntime();
      runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch });
      const pageReadsPerTurn = await runTurnByTurn(coordinator);
      const events = eventsFor(coordinator, MILESTONE);
      return {
        turns: events.length,
        maxPageReads: Math.max(...pageReadsPerTurn),
        maxItems: Math.max(...events.map((event) => event.consumedBudget.items)),
      };
    };

    const small = await repairTurns(5, 31);
    const large = await repairTurns(40, 32);

    // More retained history costs more bounded turns...
    expect(large.turns).toBeGreaterThan(small.turns);
    // ...and not one larger turn, in either pages read or items charged.
    expect(large.maxPageReads).toBeLessThanOrEqual(MAX_PAGE_READS_PER_TURN);
    expect(small.maxPageReads).toBeLessThanOrEqual(MAX_PAGE_READS_PER_TURN);
    expect(large.maxItems).toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    expect(small.maxItems).toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
  });

  it('J: the lifecycle settlement never calls the whole-history rebuild', async () => {
    // A load-bearing structural guard: restoring `rebuildAchievementAggregates`
    // (or any `maxPages: 0` pass) on this path would reintroduce F01.
    const source = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../milestoneNotificationCoordinator.js', import.meta.url), 'utf8'
    ));
    expect(source).not.toContain('rebuildAchievementAggregates');
    expect(source).toContain('stepAchievementAggregateRepair');
    expect(source).toContain('readAchievementSurfaces');
    const aggregates = await import('node:fs').then(({ readFileSync }) => readFileSync(
      new URL('../achievementAggregates.js', import.meta.url), 'utf8'
    ));
    // Both rebuild entry points now run the one engine over one state schema.
    expect(aggregates).toContain('runAchievementRebuildPass');
    expect(aggregates).toContain('ACHIEVEMENT_REBUILD_STATE_VERSION');
    expect(aggregates).toMatch(/readAchievementSurfaces[\s\S]{0,900}needsRepair: true/);
  });

  // ── F01-B: the notification cap may only ever bound undelivered work ────────

  it('K: an already-delivered prefix cannot suppress an older undelivered unlock', async () => {
    // 2,001 progression unlocks; the newest 2,000 are already durably delivered
    // and the oldest one is not. Truncating candidates before the delivered-id
    // filter would present the same delivered prefix forever.
    seedMigratedProgression(2001);
    seedDeliveredIds(Array.from({ length: 2000 }, (_, index) => `progression_mission:w${index}`));

    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 40 });
    await drainJob(coordinator, MILESTONE);

    // Every offered batch is bounded, no already-delivered id ever consumed the
    // quota, and the older undelivered unlock is reached through the pages.
    for (const [batch] of mocks.syncNotifications.mock.calls) {
      expect(batch.length).toBeLessThanOrEqual(MILESTONE_NOTIFICATION_BADGE_CEILING);
      for (const badge of batch) expect(badge.id).not.toBe('progression_mission:w0');
    }
    expect(offeredBadgeIds().has('progression_mission:w2000')).toBe(true);
  });

  it('K: more undelivered candidates than the cap drain over bounded slices', async () => {
    seedMigratedProgression(2500);
    seedDeliveredIds([]);

    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 41 });
    await drainJob(coordinator, MILESTONE);

    // Two bounded notification passes, neither above the cap, no dropped tail,
    // and no second external admission was needed to drain them.
    expect(mocks.syncNotifications.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [batch] of mocks.syncNotifications.mock.calls) {
      expect(batch.length).toBeLessThanOrEqual(MILESTONE_NOTIFICATION_BADGE_CEILING);
    }
    expect(offeredBadgeIds().has('progression_mission:w2499')).toBe(true);
    for (const event of eventsFor(coordinator, MILESTONE)) {
      expect(event.consumedBudget.items).toBeLessThanOrEqual(event.declaredBudget.items);
    }
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  // ── F01-A: the real native-disabled lifecycle call graph ───────────────────

  it('L: the native-disabled lifecycle reconciliation never enters the whole-history rebuild', async () => {
    // The exact production shape: `App.jsx` -> syncNativeCompletedTripsToLocalStore
    // -> syncNativeCompletedTripsAndMilestones({ reconcileExisting, lifecycleBounded })
    // with an invalid durable aggregate, which is what used to reach maxPages:0.
    storage.removeItem(ACHIEVEMENT_AGGREGATE_KEY);
    historyOfPages(40);
    mocks.syncNativeTrips.mockResolvedValue({ importedTrips: [], matchedActiveTrip: null });

    await syncNativeCompletedTripsAndMilestones({ reconcileExisting: true, lifecycleBounded: true });

    // No whole-history pass was entered at all.
    expect(mocks.boundedJobRuns.filter((run) => run.maxPages === 0)).toEqual([]);
    // It also did not silently page all 40 pages some other way: the only reads
    // are the bounded progression window and the bounded week scan.
    expect(mocks.queryHistoryPage.mock.calls.length)
      .toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICES + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS / 100);
    // The aggregate is still invalid, because repairing it is the coordinated
    // job's bounded work rather than this pass's.
    expect(storage.getItem(ACHIEVEMENT_AGGREGATE_KEY)).toBeNull();
  });

  it('L: the explicit trip-save path keeps its historical run-to-completion repair', async () => {
    storage.removeItem(ACHIEVEMENT_AGGREGATE_KEY);
    historyOfPages(3);

    await reconcileMilestoneNotifications({ tripId: 'explicit-trip' });

    // Non-lifecycle callers are unchanged: the explicit run-to-completion
    // repair still runs, and still completes the aggregate.
    expect(mocks.boundedJobRuns.filter((run) => run.maxPages === 0).length).toBeGreaterThan(0);
    expect(JSON.parse(storage.getItem(ACHIEVEMENT_AGGREGATE_KEY)).built).toBe(true);
  });

  it('L: the coordinated job repairs what the native-disabled lifecycle pass left', async () => {
    storage.removeItem(ACHIEVEMENT_AGGREGATE_KEY);
    historyOfPages(4);
    mocks.syncNativeTrips.mockResolvedValue({ importedTrips: [], matchedActiveTrip: null });
    await syncNativeCompletedTripsAndMilestones({ reconcileExisting: true, lifecycleBounded: true });

    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 50 });
    await drainJob(coordinator, MILESTONE);

    // Every rebuild pass on this path was one bounded page.
    expect(mocks.boundedJobRuns.filter((run) => run.maxPages === 0)).toEqual([]);
    expect(mocks.boundedJobRuns.filter((run) => run.maxPages === 1).length).toBeGreaterThan(0);
    expect(JSON.parse(storage.getItem(ACHIEVEMENT_AGGREGATE_KEY)).built).toBe(true);
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  // ── F01-B: selection itself is bounded, not just delivery ──────────────────

  it.each([
    ['a small ledger', 100],
    ['a large ledger', 2500],
    ['a synthetic-large ledger', 10000],
  ])('M: selection work and retained state are invariant in candidate count (%s)', async (_label, count) => {
    seedMigratedProgression(count);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 60 });

    const states = [];
    const perTurnItems = [];
    for (let turn = 0; turn < 400; turn += 1) {
      if (!coordinator.getJobSnapshot(MILESTONE)?.active) break;
      const result = await coordinator.runNextTurn();
      if (!result) break;
      perTurnItems.push(result.consumedBudget.items);
      const state = __milestoneReconciliationNotificationStateForTests();
      if (state) states.push(state);
    }

    // One turn never examines more than the frozen candidate page plus the
    // fixed achievement catalog allowance, whatever the ledger holds.
    expect(Math.max(...perTurnItems)).toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    for (const [batch] of mocks.syncNotifications.mock.calls) {
      expect(batch.length).toBeLessThanOrEqual(MILESTONE_NOTIFICATION_BADGE_CEILING);
    }
    // Per-run notification state is a scalar cursor: no retained tail array,
    // and its size does not move with the candidate count.
    for (const state of states) {
      expect(state.retainedArrays).toEqual([]);
      expect(state.bytes).toBeLessThanOrEqual(40);
      // P4-B-F01-3: a `<segment>:<index>` store cursor, or nothing read yet -
      // never a materialized candidate tail.
      expect(
        state.notificationCursor === null || /^-?\d+:\d+$/.test(String(state.notificationCursor))
      ).toBe(true);
    }
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  it('M: more candidates buy more bounded selection turns', async () => {
    const measure = async (count, epoch) => {
      __resetMilestoneReconciliationRunForTests();
      storage.clear();
      await seedBuiltAggregate();
      seedMigratedProgression(count);
      seedDeliveredIds([]);
      mocks.syncNotifications.mockClear();
      historyOfPages(1);
      const { coordinator, runtime } = makeRuntime();
      runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch });
      await drainJob(coordinator, MILESTONE, 200);
      const events = eventsFor(coordinator, MILESTONE);
      return {
        turns: events.length,
        maxItems: Math.max(...events.map((event) => event.consumedBudget.items)),
      };
    };

    const small = await measure(100, 61);
    const large = await measure(10000, 62);

    expect(large.turns).toBeGreaterThan(small.turns);
    expect(large.maxItems).toBeLessThanOrEqual(MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS);
    // The extra candidates cost turns, not a bigger turn.
    expect(large.maxItems - small.maxItems)
      .toBeLessThanOrEqual(MILESTONE_NOTIFICATION_CANDIDATE_PAGE);
  });

  // ── F01-3: the durable progression reads are bounded at the storage layer ──

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('N: no lifecycle turn parses a whole progression document (%s)', async (_label, count) => {
    seedMigratedProgression(count);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 70 });

    let maxRecordBytes = 0;
    let maxRecordsPerTurn = 0;
    for (let turn = 0; turn < 400; turn += 1) {
      if (!coordinator.getJobSnapshot(MILESTONE)?.active) break;
      const before = storage._reads.length;
      const result = await coordinator.runNextTurn();
      if (!result) break;
      const reads = storage._reads.slice(before);
      maxRecordsPerTurn = Math.max(maxRecordsPerTurn, reads.length);
      for (const read of reads.filter((entry) => isProgressionRecord(entry.key))) {
        maxRecordBytes = Math.max(maxRecordBytes, read.bytes);
      }
    }

    // The old monolithic ledger made both of these grow with N. A segment
    // record and the summary document are both fixed-size, so the largest value
    // any turn parsed is a page, never the history.
    expect(maxRecordBytes).toBeLessThanOrEqual(MILESTONE_NOTIFICATION_CANDIDATE_PAGE * 40);
    // header + one segment per `PROGRESSION_XP_SEGMENT_SIZE` of the candidate
    // page, plus the bounded ledger/aggregate/delivered-id documents.
    expect(maxRecordsPerTurn)
      .toBeLessThanOrEqual(14 + Math.ceil(MILESTONE_NOTIFICATION_CANDIDATE_PAGE / PROGRESSION_XP_SEGMENT_SIZE));
    // The settlement may record a handful of freshly earned unlocks; nothing
    // was lost or duplicated.
    expect(readXpIndex().count).toBeGreaterThanOrEqual(count);
    expect(readXpIndex().count).toBeLessThanOrEqual(count + 32);
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  it('N: the largest record a lifecycle turn reads does not move with retained history', async () => {
    const measure = async (count, epoch) => {
      __resetMilestoneReconciliationRunForTests();
      storage.clear();
      await seedBuiltAggregate();
      seedMigratedProgression(count);
      seedDeliveredIds([]);
      historyOfPages(1);
      const { coordinator, runtime } = makeRuntime();
      runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch });
      let maxRecordBytes = 0;
      const mark = storage._reads.length;
      await drainJob(coordinator, MILESTONE, 200);
      for (const read of storage._reads.slice(mark).filter((entry) => isProgressionRecord(entry.key))) {
        maxRecordBytes = Math.max(maxRecordBytes, read.bytes);
      }
      return maxRecordBytes;
    };

    const small = await measure(100, 71);
    const medium = await measure(2500, 72);
    const large = await measure(10000, 73);

    // A hundred-fold history costs turns, not a larger read: once a segment is
    // saturated the largest progression record a turn reads stops moving, and
    // the one-segment store at N=100 is smaller still. The monolithic ledger
    // grew this number linearly in N.
    expect(large).toBe(medium);
    expect(small).toBeLessThanOrEqual(medium);
  });

  // --- F01-3-A: legacy conversion is not lifecycle work ----------------------

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('O: a lifecycle bootstrap reads zero legacy bytes for conversion (%s)', async (_label, count) => {
    seedProgressionLedger(count);
    seedDeliveredIds([]);
    expect(progressionMigrationNeeded()).toBe(true);
    resetLegacySourceCounters();
    const mark = storage._reads.length;

    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 76 });
    await drainJob(coordinator, MILESTONE, 200);

    // Not "one bounded record" - zero. The lifecycle never retrieves the
    // monolithic legacy value, and never converts it.
    const counters = readLegacySourceCounters();
    expect(counters.rawReads).toBe(0);
    expect(counters.rawBytes).toBe(0);
    expect(counters.elementsParsed).toBe(0);
    expect(storage._reads.slice(mark).filter((read) => read.key === PROGRESSION_LEDGER_KEY)).toEqual([]);
    // The debt is still outstanding and honestly reported, not falsified as done.
    expect(progressionMigrationNeeded()).toBe(true);
    expect(readXpIndex()).toBeNull();
    // The rest of the milestone domain still settled.
    expect(mocks.mirrorCalibrationState).toHaveBeenCalled();
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
  });

  it('O: the native-disabled lifecycle pass defers progression instead of converting', async () => {
    seedProgressionLedger(10000);
    mocks.syncNativeTrips.mockResolvedValue({ importedTrips: [], matchedActiveTrip: null });
    resetLegacySourceCounters();

    const result = await syncNativeCompletedTripsAndMilestones({
      reconcileExisting: true,
      lifecycleBounded: true,
    });

    expect(readLegacySourceCounters().rawReads).toBe(0);
    expect(result.milestoneUpdate.progressionMigrationPending).toBe(true);
    expect(progressionMigrationNeeded()).toBe(true);
  });

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('O: the explicit migration owner converts in one session and hands the work back (%s)', async (_label, count) => {
    seedProgressionLedger(count);
    seedDeliveredIds([]);
    resetLegacySourceCounters();

    const outcome = await runExplicitProgressionMigration({ admitReconciliation: false });

    expect(outcome.migrated).toBe(true);
    // One legacy acquisition for the whole conversion, not one per page.
    expect(readLegacySourceCounters().rawReads).toBe(1);
    expect(readXpIndex().count).toBe(count);
    expect(progressionMigrationNeeded()).toBe(false);

    // The deferred obligation is now reconcilable, and every unlock reaches the
    // notifier through the ordinary bounded milestone job.
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 80 });
    await drainJob(coordinator, MILESTONE, 200);
    expect(offeredBadgeIds().has('progression_mission:w0')).toBe(true);
    expect(offeredBadgeIds().has(`progression_mission:w${count - 1}`)).toBe(true);
  });

  it('O: completing the explicit migration admits the milestone job itself', async () => {
    seedProgressionLedger(300);
    seedDeliveredIds([]);

    const outcome = await runExplicitProgressionMigration();

    expect(outcome.migrated).toBe(true);
    // Admission goes through the existing bounded mechanism rather than waiting
    // for the user to happen to resume the app.
    expect(outcome.admitted).toBe(true);
    expect(getP4WorkCoordinator().getJobSnapshot(MILESTONE)?.active).not.toBeNull();
  });

  it('O: a migration completing in an already-settled epoch still runs the deferred work', async () => {
    // The exact page-open-after-bootstrap shape: the lifecycle milestone
    // instance already ran and settled in epoch E while conversion debt existed,
    // and opening a route does not advance the lifecycle epoch.
    seedProgressionLedger(600);
    seedDeliveredIds(['progression_mission:w5']);
    const { coordinator, runtime } = makeRuntime();
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 90 });
    expect(runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 90 }).status)
      .toBe('admitted');
    await drainJob(coordinator, MILESTONE, 200);

    // Settled, with progression deferred because the debt is outstanding.
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
    expect(progressionMigrationNeeded()).toBe(true);
    expect(offeredBadgeIds().has('progression_mission:w0')).toBe(false);
    const settledTurns = eventsFor(coordinator, MILESTONE).length;

    // The lifecycle law itself: a second external admission for the same epoch
    // creates nothing. This is what silently swallowed the obligation.
    expect(runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 90 }).status)
      .toBe('already_admitted');
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();

    // No epoch advance, no RESUME, no bootstrap - only the migration completing.
    const outcome = await runExplicitProgressionMigration({
      admitFollowUp: () => runtime.domainFollowUp(MILESTONE, 'progression_migration_complete'),
    });

    expect(outcome.migrated).toBe(true);
    expect(outcome.admissionStatus).toBe('admitted_domain_followup');
    expect(outcome.admitted).toBe(true);
    // A real bounded instance exists, under the same epoch.
    const followUp = coordinator.getJobSnapshot(MILESTONE);
    expect(followUp.active).not.toBeNull();
    expect(followUp.active.epoch).toBe(90);

    await drainJob(coordinator, MILESTONE, 200);

    // The deferred progression candidates were evaluated, the undelivered tail
    // recovered, and the already-delivered id never re-offered.
    const offered = offeredBadgeIds();
    expect(offered.has('progression_mission:w0')).toBe(true);
    expect(offered.has('progression_mission:w599')).toBe(true);
    expect(offered.has('progression_mission:w5')).toBe(false);
    // Exactly one further logical run, not a storm, and the epoch is unchanged.
    expect(eventsFor(coordinator, MILESTONE).length).toBeGreaterThan(settledTurns);
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toMatchObject({ outcome: 'done' });
    expect(coordinator.getCoordinatorSnapshot().lifecycleEpoch ?? 90).toBe(90);
  });

  it('O: the milestone job refuses a domain follow-up for any other reason', async () => {
    // P4-B-F01-3-A. The registration opts in to exactly one domain event. A
    // different reason - even against the one job that has the capability -
    // schedules nothing and mutates nothing.
    seedMigratedProgression(300);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 93 });
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 93 });
    await drainJob(coordinator, MILESTONE, 200);
    const settledTurns = eventsFor(coordinator, MILESTONE).length;
    const settled = coordinator.getJobSnapshot(MILESTONE);

    const rejected = runtime.domainFollowUp(MILESTONE, 'some_other_domain_event');

    expect(rejected.status).toBe('domain_followup_unauthorized');
    expect(rejected.instanceId).toBeNull();
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
    expect(coordinator.getCoordinatorSnapshot().backlog).toBe(0);
    // Nothing ran, and the settled instance's own record is untouched.
    expect(eventsFor(coordinator, MILESTONE).length).toBe(settledTurns);
    expect(coordinator.getJobSnapshot(MILESTONE).lastTerminal).toEqual(settled.lastTerminal);
    // The permitted reason still works from the same settled state.
    expect(runtime.domainFollowUp(MILESTONE, P4_DOMAIN_FOLLOW_UP_REASONS.PROGRESSION_MIGRATION_COMPLETE).status)
      .toBe('admitted_domain_followup');
    await drainJob(coordinator, MILESTONE, 200);
  });

  it('O: a second completion signal does not start a second reconciliation drain', async () => {
    seedProgressionLedger(300);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 91 });
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 91 });
    await drainJob(coordinator, MILESTONE, 200);

    const admissions = [];
    const admitFollowUp = () => {
      const result = runtime.domainFollowUp(MILESTONE, 'progression_migration_complete');
      admissions.push(result?.status);
      return result;
    };

    const first = await runExplicitProgressionMigration({ admitFollowUp });
    const second = await runExplicitProgressionMigration({ admitFollowUp });

    expect(first.admitted).toBe(true);
    // The conversion is already published, so the repeat signal admits nothing.
    expect(second.admissionStatus).toBe('not_required');
    expect(second.admitted).toBe(false);
    expect(admissions).toEqual(['admitted_domain_followup']);
    await drainJob(coordinator, MILESTONE, 200);
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
  });

  it('O: repeated follow-ups while one is in flight coalesce into a single instance', async () => {
    seedMigratedProgression(300);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    coordinator.setLifecycleState({ effectiveForeground: true, epoch: 92 });
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 92 });
    await drainJob(coordinator, MILESTONE, 200);

    const first = runtime.domainFollowUp(MILESTONE, 'progression_migration_complete');
    const second = runtime.domainFollowUp(MILESTONE, 'progression_migration_complete');

    expect(first.status).toBe('admitted_domain_followup');
    // One outstanding obligation, one instance: the second coalesces.
    expect(['coalesced_queued', 'followup_recorded']).toContain(second.status);
    expect(second.instanceId).toBe(first.instanceId);
    await drainJob(coordinator, MILESTONE, 200);
    expect(coordinator.getJobSnapshot(MILESTONE).active).toBeNull();
  });

  it('O: an interrupted explicit migration resumes in a new session, once', async () => {
    seedProgressionLedger(2500);
    const session = beginProgressionMigrationSession();
    stepProgressionMigrationSession(session);
    stepProgressionMigrationSession(session);
    expect(progressionMigrationNeeded()).toBe(true);
    resetLegacySourceCounters();

    // A lifecycle pass in between must still not touch the legacy value.
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.RESUME, epoch: 81 });
    await drainJob(coordinator, MILESTONE, 200);
    expect(readLegacySourceCounters().rawReads).toBe(0);

    await runExplicitProgressionMigration({ admitReconciliation: false });

    expect(readLegacySourceCounters().rawReads).toBe(1);
    expect(readXpIndex().count).toBe(2500);
    expect(readXpIndex().xpTotal).toBe(250000);
  });

  it.each([
    ['N=100', 100],
    ['N=2500', 2500],
    ['N=10000', 10000],
  ])('N: recording a new unlock never rewrites progression history (%s)', (_label, count) => {
    seedMigratedProgression(count);
    const ledger = loadDriverProgressionLedger();
    const progression = buildDriverProgression([], {}, { ledger, historyLimit: 0 });
    const mark = storage._reads.length;

    const result = syncDriverProgressionLedger(progression, ledger);

    // Nothing read the transaction history to decide what to append, and the
    // largest record touched is a page-sized one.
    for (const read of storage._reads.slice(mark)) {
      expect(read.bytes).toBeLessThanOrEqual(PROGRESSION_XP_SEGMENT_SIZE * 400);
    }
    expect(storage._reads.length - mark).toBeLessThanOrEqual(6);
    expect(result.ledger.xpTransactions).toBeUndefined();
    expect(readXpIndex().count).toBe(count);
  });

  it('N: the Milestones history surface still reads newest-first with nothing lost', () => {
    seedMigratedProgression(450);
    const ledger = loadDriverProgressionLedger();

    const first = buildDriverProgression([], {}, { ledger, historyLimit: 200 });
    expect(first.history).toHaveLength(200);
    expect(first.historyHasMore).toBe(true);
    // `seedProgressionLedger` writes w0 as the newest unlock.
    expect(first.history[0].id).toBe('xp:mission:w0');
    expect(first.history[0].detail).toBe('Advanced weekly mission · +100 XP');

    const all = buildDriverProgression([], {}, { ledger, historyLimit: 1000 });
    expect(all.history).toHaveLength(450);
    expect(all.historyHasMore).toBe(false);
    expect(all.history.at(-1).id).toBe('xp:mission:w449');
    expect(all.xp.total).toBe(45000);
  });

  it('M: a lost run still reconstructs the undelivered tail from durable state', async () => {
    seedMigratedProgression(2500);
    seedDeliveredIds([]);
    const { coordinator, runtime } = makeRuntime();
    runtime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 63 });
    await coordinator.runNextTurn();
    await coordinator.runNextTurn();

    // Simulate the in-memory run being lost (renderer restart).
    __resetMilestoneReconciliationRunForTests();
    mocks.syncNotifications.mockClear();

    const { coordinator: next, runtime: nextRuntime } = makeRuntime();
    nextRuntime.admit(MILESTONE, { origin: APP_WORK_TRIGGER_ORIGINS.BOOTSTRAP, epoch: 64 });
    await drainJob(next, MILESTONE, 200);

    // The tail is rebuilt from the durable ledger filtered by durable
    // delivered ids; nothing was lost with the in-memory run.
    expect(offeredBadgeIds().has('progression_mission:w2499')).toBe(true);
  });
});
