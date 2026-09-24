import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  processDriverProgressionAfterTrip,
  selectProgressionNotificationPage,
} from '@/lib/driverProgression';
import {
  progressionMigrationNeeded,
  runProgressionLedgerMigrationAsync,
} from '@/lib/driverProgressionMigration';
import { syncNativeCompletedTrips } from '@/lib/localTripRepository';
import { beginMeasure, measureAsync } from '@/lib/performanceTriage';
import {
  mirrorCalibrationStateToNative,
  selectUndeliveredAchievements,
  syncAchievementNotifications,
  syncCalibrationMilestoneNotifications,
} from '@/lib/notificationService';
import {
  CALIBRATION_KM_TARGET,
  CALIBRATION_TRIPS_TARGET,
  evaluateCalibrationMilestones,
  summarizeCalibrationProgress,
  summarizeCalibrationProgressFromCounters,
} from '@/lib/calibrationMilestones';
import { logSystemFailure } from '@/lib/systemLog';
import {
  ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS,
  achievementAggregateNeedsRepair,
  applyCompletedTripToAggregates,
  readAchievementBadges,
  readAchievementSurfaces,
  readCalibrationProgressFromAggregates,
  stepAchievementAggregateRepair,
} from '@/lib/achievementAggregates';
import { localSettings } from '@/lib/trackingStore';

let milestoneSyncQueue = /** @type {Promise<unknown>} */ (Promise.resolve());
/**
 * Depth of the process-local milestone queue.
 *
 * P4-B-F01: this queue stays the authoritative serialization/deduplication
 * point for milestone notification state, but a coordinator turn may never
 * *wait* behind it — its depth is a function of how many trips were saved, not
 * of any declared turn budget. The bounded reconciliation slice below tests
 * this instead of joining the chain, and yields its turn when it is busy.
 */
let milestoneSyncDepth = 0;

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const queueMilestoneSync = (task) => {
  milestoneSyncDepth += 1;
  const run = milestoneSyncQueue.then(task, task);
  milestoneSyncQueue = run.catch(() => {});
  const release = () => { milestoneSyncDepth = Math.max(0, milestoneSyncDepth - 1); };
  run.then(release, release);
  return run;
};

/** True while any milestone task is queued or running. */
export const isMilestoneSyncBusy = () => milestoneSyncDepth > 0;

/**
 * Trips driver progression actually needs.
 *
 * `buildDriverProgression` reads two bounded windows: the newest forty
 * eligible trips for mastery/form, and the current week plus the preceding
 * four weeks for missions. Paging stops as soon as both are satisfied, so the
 * work scales with how much the driver recently drove rather than with how
 * long they have used the app.
 */
const PROGRESSION_ELIGIBLE_TARGET = 40;
const PROGRESSION_WINDOW_DAYS = 35;
const PROGRESSION_PAGE = 100;
const PROGRESSION_MAX_PAGES = 20;

/** The single bounded vehicle page the settlement lists. */
export const MILESTONE_VEHICLE_PAGE = 500;
/**
 * Ceiling on the number of **undelivered** milestone notifications one bounded
 * slice hands the notifier.
 *
 * It is applied after `selectUndeliveredAchievements` has filtered against the
 * durable delivered-id set, never before: a prefix of already-delivered
 * candidates must not consume the quota, or an older undelivered unlock beyond
 * it could never advance into the call. Anything past the cap stays in the run
 * and drains through further bounded slices.
 */
export const MILESTONE_NOTIFICATION_BADGE_CEILING = 2000;
/**
 * Candidates one bounded slice may *materialize and filter*, not just deliver.
 *
 * P4-B-F01: capping delivery was not enough — building the tail still mapped
 * and filtered every persisted unlock in one turn and retained the remainder.
 * A slice now reads one bounded page of the durable ledger, filters it against
 * the delivered-id set, and carries only an integer cursor forward, so more
 * candidates cost more bounded turns instead of one larger turn.
 */
export const MILESTONE_NOTIFICATION_CANDIDATE_PAGE = MILESTONE_NOTIFICATION_BADGE_CEILING;
/**
 * P4-B-F01-3-A. Converting the legacy monolithic progression document is
 * explicit, non-lifecycle full-history maintenance: retrieving that value is
 * O(legacy N) bytes and cannot be made a bounded turn. No lifecycle slice below
 * performs it, so the frozen ceiling covers no conversion term at all.
 */
export const MILESTONE_LIFECYCLE_CONVERTS_LEGACY_PROGRESSION = false;
/** Fixed allowance for the achievement catalog, which is not history-derived. */
export const MILESTONE_ACHIEVEMENT_BADGE_CEILING = 200;
/**
 * P4-B-F01. The frozen per-slice work ceiling, derived from this module's own
 * bounded constants and **independent of total retained history N**:
 *
 *   1                                        the settlement pass itself
 * + PROGRESSION_MAX_PAGES x PROGRESSION_PAGE   the collected progression window
 * + MILESTONE_VEHICLE_PAGE                     the single vehicle page
 * + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS           the one aggregate week scan
 * + MILESTONE_NOTIFICATION_BADGE_CEILING       the undelivered badge batch
 *
 * A longer history makes the *collection* (and, when the durable aggregate has
 * to be repaired, the repair) take more bounded turns; it never makes any
 * single turn larger. `appLifecycleWork` declares exactly this number as the
 * milestone job's `items` budget, and the coordinator enforces it.
 */
export const MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS = 1
  + PROGRESSION_MAX_PAGES * PROGRESSION_PAGE
  + MILESTONE_VEHICLE_PAGE
  + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS
  + MILESTONE_NOTIFICATION_CANDIDATE_PAGE
  + MILESTONE_ACHIEVEMENT_BADGE_CEILING;

/**
 * One in-progress progression window read. The paging rules are identical
 * whether the window is read in one pass or one page per coordinated turn, so
 * both callers share this collector rather than restating the cutoffs.
 */
const startProgressionCollector = (settings, now = Date.now()) => ({
  cutoff: now - PROGRESSION_WINDOW_DAYS * 86400000,
  minimumTripKm: Number(settings?.progression_min_trip_km ?? 2),
  minimumTripSeconds: Number(settings?.progression_min_trip_seconds ?? 180),
  window: [],
  eligibleSeen: 0,
  reachedCutoff: false,
  cursor: null,
  pagesRead: 0,
  complete: false,
});

const isProgressionEligible = (trip, collector) => (
  Number(trip?.distance_km) >= collector.minimumTripKm &&
  Number(trip?.duration_seconds ?? collector.minimumTripSeconds) >= collector.minimumTripSeconds &&
  Number.isFinite(Number(trip?.score_overall))
);

/** Read exactly one bounded page into the collector. Returns the rows read. */
const collectProgressionPage = async (collector) => {
  const page = await tripService.queryHistoryPage({
    sort: '-start_time',
    limit: PROGRESSION_PAGE,
    status: 'completed',
    ...(collector.cursor ? { cursor: collector.cursor } : {}),
  });
  const rows = Array.isArray(page?.rows) ? page.rows : [];
  for (const trip of rows) {
    // The query already filters by status; re-check so a backend that
    // ignores the filter cannot leak a recording draft into progression.
    if (trip?.status !== 'completed') continue;
    collector.window.push(trip);
    if (isProgressionEligible(trip, collector)) collector.eligibleSeen += 1;
    if (new Date(trip?.start_time).getTime() < collector.cutoff) collector.reachedCutoff = true;
  }
  collector.pagesRead += 1;
  collector.cursor = page?.nextCursor || null;
  collector.complete = (collector.reachedCutoff && collector.eligibleSeen >= PROGRESSION_ELIGIBLE_TARGET)
    || !collector.cursor
    || collector.pagesRead >= PROGRESSION_MAX_PAGES;
  return rows.length;
};

const readProgressionWindow = async (settings, now = Date.now()) => {
  const collector = startProgressionCollector(settings, now);
  while (!collector.complete) await collectProgressionPage(collector);
  return collector.window;
};

/**
 * Evaluate every milestone source for an already-read progression window and
 * notify for newly earned items.
 *
 * `accounting` is an optional bounded work counter: the coordinated slice in
 * `stepMilestoneReconciliationRun` reports what this pass actually touched
 * instead of declaring a nominal one item.
 */
const settleMilestoneReconciliation = async (progressionWindow, settings, tripId, {
  accounting = null,
  notificationLimit = 0,
  boundedAggregateReads = false,
  skipProgression = false,
} = {}) => {
  const window = Array.isArray(progressionWindow) ? progressionWindow : [];
  // HPR-003/HPR-010. A prefix is not the fleet. The carbon accumulator resolves
  // each trip's `vehicle_id` against whatever collection it is handed and drops
  // the trip when the reference is absent, so a partial page silently zeroed
  // every beyond-prefix vehicle's contribution — absence read as deletion, the
  // one inference Wave 4 forbids.
  //
  // The P4-B-F01 slice ceiling below keeps this read bounded, so the answer is
  // not a bigger read: when the page cannot represent the fleet, no collection
  // is passed at all and the aggregate falls back to each trip's own recorded
  // figure instead of resolving references against a collection it knows is
  // incomplete. An empty *complete* collection stays authoritative.
  const vehiclePage = await vehicleService.listPage({
    sort: '-created_date',
    limit: MILESTONE_VEHICLE_PAGE,
  }).catch(() => null);
  const vehicles = !vehiclePage || vehiclePage.hasMore ? null : (vehiclePage.vehicles ?? []);
  if (accounting) accounting.items += vehiclePage?.vehicles?.length ?? 0;
  // Achievements and calibration come from durable aggregates maintained as
  // trips complete; progression comes from the bounded recent window above.
  // Neither path enumerates the archive.
  //
  // P4-B-F01: a bounded slice reads both aggregate surfaces from ONE charged
  // week scan and never triggers the explicit whole-history repair. The
  // one-pass callers keep the historical repair-if-missing behaviour.
  let achievementBadges;
  let aggregateCalibration = null;
  let needsAggregateRepair = false;
  if (boundedAggregateReads) {
    const surfaces = await readAchievementSurfaces(settings, { vehicles, accounting });
    achievementBadges = surfaces.badges;
    aggregateCalibration = surfaces.calibration;
    needsAggregateRepair = surfaces.needsRepair;
  } else {
    achievementBadges = await readAchievementBadges(settings, { vehicles });
    aggregateCalibration = await readCalibrationProgressFromAggregates().catch(() => null);
  }
  // P4-B-F01: `processDriverProgressionAfterTrip` runs `buildDriverProgression`
  // three times, and each of those filters, maps, sorts and reduces the whole
  // collected window. The window is therefore this slice's dominant work unit
  // and is charged as such - not as the single nominal item it used to be.
  //
  // P4-B-F01-3: a bounded pass whose legacy progression ledger has not been
  // converted yet skips progression rather than parsing the monolithic legacy
  // document inside this turn. Nothing is lost - the conversion advances one
  // bounded turn per pass and the durable delivered-id set means an unlock is
  // still delivered whenever it is next evaluated.
  if (accounting) accounting.items += window.length;
  const progressionUpdate = skipProgression ? null : processDriverProgressionAfterTrip(window, settings, {
    tripId,
    // A bounded slice materializes only one page of persisted unlocks; the
    // one-pass callers keep the historical "every persisted unlock" behaviour.
    ...(notificationLimit > 0 ? { notificationBadgeLimit: MILESTONE_NOTIFICATION_CANDIDATE_PAGE } : {}),
  });
  const candidates = [...achievementBadges, ...(progressionUpdate?.notificationBadges || [])];
  // Charge every candidate this slice actually examined, not only the ones it
  // ends up delivering.
  if (accounting) accounting.items += candidates.length;
  // Filter against the durable delivered-id set BEFORE applying any cap, so an
  // already-delivered prefix can never crowd out an older undelivered unlock.
  const { batch: notificationBadges } = selectUndeliveredAchievements(candidates, {
    limit: notificationLimit,
  });
  const notifiedMilestones = await syncAchievementNotifications(notificationBadges, {
    requestPermission: false,
  });

  // Personal detection calibration is its own system, not part of the
  // Milestones page. Its two inputs are the same lifetime counters the
  // achievement aggregate already maintains; a failure must not suppress
  // achievement notifications.
  const calibrationCounters = aggregateCalibration;
  const calibrationProgress = calibrationCounters
    ? summarizeCalibrationProgressFromCounters(calibrationCounters)
    : summarizeCalibrationProgress([]);
  const notifiedCalibrationMilestones = await syncCalibrationMilestoneNotifications(
    evaluateCalibrationMilestones(calibrationProgress),
    { requestPermission: false }
  ).catch((error) => {
    logSystemFailure('calibration_milestone_notification_sync', error, {
      trips_analyzed: calibrationProgress.tripsAnalyzed,
      km_analyzed: calibrationProgress.kmAnalyzed,
    });
    return [];
  });
  // Push the refreshed counters down so Android can notify for a milestone
  // crossed by a background trip without the app being opened.
  await mirrorCalibrationStateToNative(calibrationProgress, {
    tripsTarget: CALIBRATION_TRIPS_TARGET,
    kmTarget: CALIBRATION_KM_TARGET,
  });

  return {
    ...(progressionUpdate || {}),
    notifiedMilestones,
    calibrationProgress,
    notifiedCalibrationMilestones,
    // A bounded segment cursor into the durable store, never a retained tail.
    notificationCursor: progressionUpdate?.notificationCursor ?? null,
    notificationCandidatesRemain: progressionUpdate?.notificationCandidatesRemain === true,
    progressionMigrationPending: skipProgression === true,
    needsAggregateRepair,
  };
};

/**
 * Evaluate every milestone source and notify for newly earned items. Keeping
 * this outside the Milestones page means unlocks are processed as part of trip
 * completion, whether or not that page is open.
 */
export async function reconcileMilestoneNotifications({
  tripId = null,
  lifecycleBounded = false,
} = {}) {
  const settings = localSettings.get();
  // P4-B-F01-3. The legacy progression document is one indivisible JSON value,
  // so converting it is explicitly *not* lifecycle work: an explicit pass
  // (trip save, native import, Milestones) converts it in full, while a bounded
  // lifecycle pass advances it by exactly one bounded turn and defers its own
  // progression settlement until the conversion has been published.
  // An explicit pass owns the conversion and yields between its bounded chunks;
  // a bounded lifecycle pass only *detects* the debt from bounded metadata and
  // defers its own progression obligation until an explicit pass settles it.
  let progressionMigrationPending = false;
  if (lifecycleBounded === true) {
    progressionMigrationPending = progressionMigrationNeeded();
  } else if (progressionMigrationNeeded()) {
    await runProgressionLedgerMigrationAsync();
  }
  const progressionWindow = await readProgressionWindow(settings);
  // P4-B-F01-A: a lifecycle-owned caller (bootstrap/resume, native authority
  // disabled) must never reach the explicit whole-history aggregate rebuild.
  // It reads the bounded aggregate surfaces instead and leaves any repair to
  // the coordinated milestone job. An explicit trip-save/import pass keeps the
  // historical repair-if-missing reads and no cap.
  return settleMilestoneReconciliation(progressionWindow, settings, tripId, {
    boundedAggregateReads: lifecycleBounded === true,
    skipProgression: progressionMigrationPending,
  });
}

// ─── P4-B-F01: the milestone domain's own bounded reconciliation slices ──────

/**
 * The bootstrap/resume reconciliation used to run inside the native journal's
 * coordinator turn, which meant a turn could report zero journal consumption
 * and then page up to `PROGRESSION_MAX_PAGES` × `PROGRESSION_PAGE` trips and
 * list up to 500 vehicles — after waiting behind however many trip-save
 * reconciliations happened to be queued.
 *
 * The work itself is unchanged and still owned here. What changed is that it is
 * now handed out one bounded slice at a time, so the lifecycle coordinator can
 * account for it, yield between slices and serve interactive work in between.
 * The run state is in-memory and disposable: nothing durable is added, and the
 * milestone queue above remains the authoritative serialization point.
 */
let activeReconciliationRun = null;
let reconciliationRunSeq = 0;

/**
 * Worst-case slices for one *converted* run: every progression page, then the
 * settlement. A first run after upgrade adds one bounded conversion slice per
 * `PROGRESSION_MIGRATION_PAGE` legacy transactions, which is the intended
 * "more history buys more turns" behaviour rather than a larger turn.
 */
export const MILESTONE_RECONCILIATION_MAX_SLICES = PROGRESSION_MAX_PAGES + 1;

/**
 * Open one reconciliation run and return its id. A new run supersedes any
 * abandoned one, so a run left behind by a terminated logical instance cannot
 * accumulate.
 *
 * @param {{tripId?: string|null, now?: number}} [options]
 */
export function beginMilestoneReconciliationRun({ tripId = null, now = Date.now() } = {}) {
  reconciliationRunSeq += 1;
  const settings = localSettings.get();
  activeReconciliationRun = {
    runId: `milestone-reconciliation:${reconciliationRunSeq}`,
    tripId,
    settings,
    collector: startProgressionCollector(settings, now),
    /** collect -> repair (only when the aggregate is invalid) -> settle -> notify */
    phase: 'collect',
    /**
     * P4-B-F01-3-A: detected from bounded metadata only. A run that opens while
     * the legacy document is unconverted settles achievements and calibration
     * as usual and defers *only* the progression obligation; it never retrieves
     * or converts the legacy value.
     */
    progressionDeferred: progressionMigrationNeeded(),
    /**
     * Bounded per-run notification state: one `<segment>:<index>` cursor into
     * the durable store. Never a materialized tail, whatever the candidate
     * count.
     */
    notificationCursor: null,
  };
  return activeReconciliationRun.runId;
}

/**
 * Advance one run by exactly one bounded slice: either one progression page, or
 * the single settlement pass that evaluates and notifies.
 *
 * The settlement pass is the only part that mutates notification state, so it
 * is the only part that needs the milestone queue. It never *waits* for that
 * queue: a busy queue yields the slice back to the coordinator, which re-admits
 * it at the tail after serving anything more urgent.
 *
 * @param {string} runId
 */
export async function stepMilestoneReconciliationRun(runId) {
  const run = activeReconciliationRun;
  if (!run || run.runId !== runId) {
    return Object.freeze({ items: 0, hasMore: false, obsolete: true, phase: 'superseded' });
  }

  // ── collect: exactly one bounded progression page ──────────────────────────
  if (run.phase === 'collect') {
    if (!run.collector.complete) {
      const items = await collectProgressionPage(run.collector);
      return Object.freeze({ items, hasMore: true, phase: 'collect' });
    }
    // The durable aggregate is checked without reading the week window, so an
    // invalid one costs one cheap read rather than a scan.
    run.phase = (await achievementAggregateNeedsRepair()) ? 'repair' : 'settle';
    return Object.freeze({ items: 0, hasMore: true, phase: run.phase === 'repair' ? 'repair-required' : 'collected' });
  }

  // ── repair: one bounded aggregate page per turn, never a whole-history pass ─
  if (run.phase === 'repair') {
    let outcome;
    try {
      outcome = await stepAchievementAggregateRepair(run.settings, { maxPages: 1 });
    } catch (error) {
      // A repair that cannot progress must not strand the run: settle with the
      // surfaces that are available and let the next settlement retry.
      logSystemFailure('lifecycle_achievement_aggregate_repair', error, { trip_id: run.tripId });
      run.phase = 'settle';
      return Object.freeze({ items: 0, hasMore: true, phase: 'repair-failed' });
    }
    if (outcome?.hasMore !== false) {
      return Object.freeze({ items: Number(outcome?.processed) || 0, hasMore: true, phase: 'repair' });
    }
    run.phase = 'settle';
    return Object.freeze({ items: Number(outcome?.processed) || 0, hasMore: true, phase: 'repaired' });
  }

  // The notification/aggregate critical section stays owned and serialized by
  // the milestone queue. A coordinator turn never *waits* behind that queue:
  // if it is busy it yields the turn and re-enters through the coordinator.
  if (isMilestoneSyncBusy()) {
    return Object.freeze({ items: 0, hasMore: true, busy: true, phase: 'await-milestone-queue' });
  }

  // ── notify: page the durable ledger forward, one bounded page per turn ─────
  if (run.phase === 'notify') {
    const page = selectProgressionNotificationPage({
      cursor: run.notificationCursor,
      limit: MILESTONE_NOTIFICATION_CANDIDATE_PAGE,
    });
    run.notificationCursor = page.nextCursor;
    const { batch } = selectUndeliveredAchievements(page.candidates, {
      limit: MILESTONE_NOTIFICATION_BADGE_CEILING,
    });
    const delivered = batch.length
      ? await queueMilestoneSync(() => syncAchievementNotifications(batch, {
        requestPermission: false,
      }).catch((error) => {
        logSystemFailure('lifecycle_milestone_notification_drain', error, { trip_id: run.tripId });
        return [];
      }))
      : [];
    const hasMore = page.hasMore;
    if (!hasMore) activeReconciliationRun = null;
    // Charged by candidates examined, which is what bounds this slice.
    return Object.freeze({ items: page.candidates.length, hasMore, phase: 'notify', delivered });
  }

  // ── settle: the single evaluate-and-notify pass ────────────────────────────
  const accounting = { items: 1 };
  const update = await queueMilestoneSync(() => settleMilestoneReconciliation(
    run.collector.window,
    run.settings,
    run.tripId,
    {
      accounting,
      notificationLimit: MILESTONE_NOTIFICATION_BADGE_CEILING,
      boundedAggregateReads: true,
      skipProgression: run.progressionDeferred === true,
    }
  ).catch((error) => {
    logSystemFailure('lifecycle_milestone_notification_sync', error, { trip_id: run.tripId });
    return null;
  }));
  run.notificationCursor = update?.notificationCursor ?? null;
  if (update?.notificationCandidatesRemain === true) {
    run.phase = 'notify';
    return Object.freeze({ items: accounting.items, hasMore: true, phase: 'settle', update });
  }
  activeReconciliationRun = null;
  return Object.freeze({ items: accounting.items, hasMore: false, phase: 'settle', update });
}

/** Test seam: drop any run left open by an aborted fixture. */
export const __resetMilestoneReconciliationRunForTests = () => { activeReconciliationRun = null; };

/**
 * Test seam: the run's notification state, so its size can be asserted
 * invariant in the number of durable candidates.
 */
export const __milestoneReconciliationNotificationStateForTests = () => (
  activeReconciliationRun
    ? {
      phase: activeReconciliationRun.phase,
      notificationCursor: activeReconciliationRun.notificationCursor,
      bytes: JSON.stringify({ notificationCursor: activeReconciliationRun.notificationCursor }).length,
      retainedArrays: Object.entries(activeReconciliationRun)
        .filter(([key, value]) => key !== 'collector' && Array.isArray(value))
        .map(([key, value]) => ({ key, length: value.length })),
    }
    : null
);

/**
 * Admission statuses that mean a real bounded execution of the deferred
 * obligation is now scheduled - either a new instance, or an existing one that
 * has been told to run again before it settles.
 */
const FOLLOW_UP_SCHEDULED = new Set(['admitted_domain_followup', 'followup_recorded', 'coalesced_queued']);

/**
 * Hand the deferred progression obligation back to the bounded milestone job.
 *
 * P4-B-F01-3-A: this used to call `admitP4BootstrapWork`, which is the
 * *lifecycle* entry point and enforces one external admission per job per
 * epoch. Opening the Milestones page does not advance the lifecycle epoch, so
 * in the ordinary page-open-after-bootstrap shape the milestone instance had
 * already settled in the current epoch and that call returned
 * `already_admitted` while this function reported success - leaving the
 * deferred progression and notification work unevaluated until some unrelated
 * later epoch. A domain follow-up says the different, true thing: the
 * precondition the settled instance deferred on is now satisfied. No epoch is
 * advanced or invented.
 */
const admitDeferredMilestoneObligation = async () => {
  const lifecycle = await import('@/lib/appLifecycleWork');
  return lifecycle.admitP4DomainFollowUp(
    lifecycle.P4_LIFECYCLE_JOB_KEYS.MILESTONE_RECONCILIATION,
    lifecycle.P4_DOMAIN_FOLLOW_UP_REASONS.PROGRESSION_MIGRATION_COMPLETE
  );
};

/**
 * The explicit, non-lifecycle owner of the legacy progression conversion.
 *
 * P4-B-F01-3-A. Retrieving the legacy monolithic document is O(legacy N) bytes,
 * so it is full-history maintenance, not a bounded lifecycle turn. This runs one
 * migration session - one legacy read, then bounded chunks with a yield between
 * each - and, on success, hands the deferred progression obligation back to the
 * bounded milestone job. Calling it again once the conversion has been
 * published is a no-op, so duplicate completion signals cannot produce two
 * reconciliation drains.
 *
 * @param {{admitReconciliation?: boolean, admitFollowUp?: () => unknown}} [options]
 *   `admitFollowUp` exists so a test can drive its own real coordinator; it
 *   defaults to the production lifecycle runtime.
 */
export async function runExplicitProgressionMigration({
  admitReconciliation = true,
  admitFollowUp = admitDeferredMilestoneObligation,
} = {}) {
  if (!progressionMigrationNeeded()) {
    return { migrated: true, converted: 0, admitted: false, admissionStatus: 'not_required' };
  }
  let outcome;
  try {
    outcome = await runProgressionLedgerMigrationAsync();
  } catch (error) {
    // A durable write failed. The legacy document is still authoritative and the
    // checkpoint is intact, so a later explicit attempt resumes safely.
    logSystemFailure('progression_ledger_migration', error);
    return { migrated: false, converted: 0, admitted: false, admissionStatus: 'migration_failed', failed: true };
  }
  let admitted = false;
  let admissionStatus = admitReconciliation ? 'not_attempted' : 'not_requested';
  if (outcome.migrated && admitReconciliation) {
    try {
      const admission = await admitFollowUp();
      admissionStatus = admission?.status ?? 'unknown';
      // The result is inspected rather than assumed: only a status that
      // actually schedules a bounded execution counts as admitted.
      admitted = FOLLOW_UP_SCHEDULED.has(admissionStatus);
      if (!admitted) {
        logSystemFailure(
          'progression_migration_reconciliation_admission',
          new Error(`Deferred milestone obligation was not scheduled: ${admissionStatus}`)
        );
      }
    } catch (error) {
      admissionStatus = 'admission_failed';
      logSystemFailure('progression_migration_reconciliation_admission', error);
    }
  }
  return { ...outcome, admitted, admissionStatus };
}

/**
 * Reconcile every milestone system immediately after a completed trip is
 * saved in-app.
 *
 * A trip recorded in the app is written straight through `tripService.create`
 * and never appears in the native import list, so without this hook its
 * milestones waited until the next app boot or resume - the same "only
 * notifies when I open the app" problem, one system over.
 *
 * Serialized through the same queue as the native import path so a trip save
 * landing alongside an app-resume cannot double-notify.
 *
 * @param {{tripId?: string|null}} [options]
 */
export function reconcileMilestonesAfterTripSave({ tripId = null } = {}) {
  return queueMilestoneSync(() => reconcileMilestoneNotifications({ tripId }).catch((error) => {
    logSystemFailure('trip_save_milestone_notification_sync', error, {
      trip_id: tripId,
    });
    return null;
  }));
}

/**
 * Import native-completed trips and immediately run milestone notification
 * reconciliation. Calls are serialized because app-resume and visibility
 * events can arrive together on Android.
 */
export function syncNativeCompletedTripsAndMilestones({
  reconcileExisting = false,
  lifecycleBounded = false,
} = {}) {
  // Native-sync characterization (§39 P4): `app.nativeTripSync` is 8-10 s on the
  // A54 with an empty journal. These phase keys split it into the wait behind the
  // serialized milestone queue, the native intake (bridge page + repository), and
  // milestone reconciliation. Timing only; no behaviour change.
  const endQueueWait = beginMeasure('app.nativeTripSync.queueWait');
  return queueMilestoneSync(async () => {
    endQueueWait({ outcome: 'success' });
    const result = await measureAsync('app.nativeTripSync.intake', () => syncNativeCompletedTrips());
    const importedTrips = Array.isArray(result?.importedTrips) ? result.importedTrips : [];
    // Reconcile even when nothing was imported: a trip recorded and saved
    // locally never appears in `importedTrips`, so gating on it meant crossing
    // a milestone in-app produced no notification at all.
    const shouldReconcile = reconcileExisting || importedTrips.length > 0;
    // Natively imported trips never pass through `tripService.create`, so they
    // are folded into the durable aggregate here instead.
    const settings = localSettings.get();
    for (const trip of importedTrips.filter((item) => item?.status === 'completed')) {
      await applyCompletedTripToAggregates(trip, settings).catch((error) => {
        logSystemFailure('achievement_aggregate_apply_native', error, { trip_id: trip?.id });
      });
    }
    const latestImportedTrip = importedTrips
      .filter((trip) => trip?.status === 'completed')
      .sort((a, b) => new Date(b.end_time || b.start_time || 0).getTime() - new Date(a.end_time || a.start_time || 0).getTime())[0];
    let milestoneUpdate = null;
    if (shouldReconcile) {
      milestoneUpdate = await measureAsync('app.nativeTripSync.milestones', () => reconcileMilestoneNotifications({
        tripId: latestImportedTrip?.id || null,
        lifecycleBounded,
      })).catch((error) => {
        logSystemFailure('native_trip_milestone_notification_sync', error, {
          imported_trip_count: importedTrips.length,
          latest_trip_id: latestImportedTrip?.id || null,
        });
        return null;
      });
    }

    return {
      ...result,
      importedTrips,
      milestoneUpdate,
    };
  });
}
