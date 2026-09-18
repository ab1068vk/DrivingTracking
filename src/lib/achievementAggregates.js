import { getJson, setJson } from '@/lib/mobileStorage';
import { tripService } from '@/api/trips';
import { clearBoundedJobCheckpoint, runBoundedTripJob } from '@/lib/boundedTripJob';
import {
  buildAchievementBadgesFromStats,
  createAchievementStatsAccumulator,
} from '@/lib/tripInsights';
import { logSystemFailure } from '@/lib/systemLog';

/**
 * Durable achievement/calibration aggregates.
 *
 * Milestone reconciliation used to load every trip summary on every trip save
 * and on every boot. Achievements are counters, sums and two bounded recent
 * windows, so they are now maintained transactionally as trips complete and
 * rebuilt only by an explicit bounded job.
 *
 * Two kinds of value live here and they are treated differently:
 *
 *  - order-relative values (lifetime counters, the newest-ten window) are
 *    durable and stay correct indefinitely;
 *  - calendar-relative values (this week's trips and harsh braking) go stale as
 *    the week boundary moves, so they are never trusted from storage and are
 *    always recomputed from a bounded seven-day query.
 */

export const ACHIEVEMENT_AGGREGATE_KEY = 'drivesense_achievement_aggregates_v1';
export const ACHIEVEMENT_AGGREGATE_VERSION = 1;
export const ACHIEVEMENT_RECENT_WINDOW = 10;

/** Trips fetched to rebuild the calendar-relative terms. Bounded by driving rate, not history. */
const WEEK_WINDOW_PAGE = 100;
const WEEK_WINDOW_MAX_PAGES = 20;
/**
 * The frozen maximum number of rows one `readAchievementStats` week scan can
 * read. Exported so a bounded coordinator slice can declare a ceiling that
 * covers it instead of leaving the scan unaccounted (P4-B-F01).
 */
export const ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS = WEEK_WINDOW_PAGE * WEEK_WINDOW_MAX_PAGES;

/** The single durable rebuild checkpoint both rebuild entry points share. */
export const ACHIEVEMENT_REBUILD_JOB_KEY = 'achievement_aggregates';
/**
 * P4-B-F01. The rebuild checkpoint's *state schema* version, not just the
 * aggregate's.
 *
 * The explicit rebuild used to run with `resume:false` and `initialState: () => ({})`,
 * keeping its real tally in local variables, so a page it committed left a
 * same-fingerprint `{}` checkpoint behind. The bounded repair resumes and folds
 * into `{ stats, recentWindow }`, so it would have inherited that empty shape.
 * Both entry points now run the same engine over the same state, and this
 * fingerprint makes any checkpoint written by the old shape unresumable:
 * `readCheckpoint` rejects a fingerprint mismatch and the fold restarts clean.
 */
export const ACHIEVEMENT_REBUILD_STATE_VERSION = 2;
const ACHIEVEMENT_REBUILD_FINGERPRINT =
  `achievements:${ACHIEVEMENT_AGGREGATE_VERSION}:state${ACHIEVEMENT_REBUILD_STATE_VERSION}`;

/**
 * Process-local mutual exclusion for the one durable rebuild checkpoint.
 *
 * Both current entry points can be reached from production at the same time —
 * the bounded lifecycle repair from a coordinator turn, the explicit rebuild
 * from trip-save/native-import reconciliation — and both write the same
 * checkpoint. This is scheduling only: no durable state, no queue a coordinator
 * turn ever waits behind (the bounded slice try-acquires and yields instead).
 */
let rebuildLock = /** @type {Promise<unknown>} */ (Promise.resolve());
let rebuildLockDepth = 0;

/** True while either rebuild entry point holds the checkpoint. */
export const isAchievementRebuildBusy = () => rebuildLockDepth > 0;

const withAchievementRebuildLock = (task) => {
  rebuildLockDepth += 1;
  const run = rebuildLock.then(task, task);
  rebuildLock = run.catch(() => {});
  const release = () => { rebuildLockDepth = Math.max(0, rebuildLockDepth - 1); };
  run.then(release, release);
  return run;
};

const emptyStats = () => ({
  completedCount: 0,
  totalKm: 0,
  nightCount: 0,
  cleanTripCount: 0,
  weekTripCount: 0,
  weekHarshBrakes: 0,
  noHarshTrips: 0,
  noRapidTrips: 0,
  noSharpTrips: 0,
  noSpeedingTrips: 0,
  routeReplayTrips: 0,
  longTrips: 0,
  cleanLongTrips: 0,
  cleanNightTrips: 0,
  highScoreTrips: 0,
  excellentScoreTrips: 0,
  cleanExcellentTrips: 0,
  smoothBrakeTrips: 0,
  distractionFreeTrips: 0,
  cruiseMasterTrips: 0,
  manoeuvreAlertFreeTrips: 0,
  scoreDistanceProduct: 0,
  scoreDistanceWeight: 0,
  carbonCo2SavedKg: 0,
  carbonEligibleTripCount: 0,
});

export const emptyAchievementAggregate = () => ({
  version: ACHIEVEMENT_AGGREGATE_VERSION,
  built: false,
  stats: emptyStats(),
  recentWindow: [],
  seenTripIds: [],
  updatedAt: null,
});

const readAggregate = async () => {
  const stored = await getJson(ACHIEVEMENT_AGGREGATE_KEY, null).catch(() => null);
  if (!stored || Number(stored.version) !== ACHIEVEMENT_AGGREGATE_VERSION) return emptyAchievementAggregate();
  return {
    ...emptyAchievementAggregate(),
    ...stored,
    stats: { ...emptyStats(), ...(stored.stats || {}) },
    recentWindow: Array.isArray(stored.recentWindow) ? stored.recentWindow : [],
    seenTripIds: Array.isArray(stored.seenTripIds) ? stored.seenTripIds : [],
  };
};

const writeAggregate = (aggregate) => setJson(ACHIEVEMENT_AGGREGATE_KEY, aggregate);

/**
 * A deletion cannot be safely represented as a blind subtraction: the trip
 * may have been folded only partially, replaced, or outside the retained
 * idempotency window. Mark the durable aggregate invalid and let the existing
 * cursor/checkpoint rebuild derive exact values from live canonical history.
 */
export async function invalidateAchievementAggregates(reason = 'trip_removed') {
  const aggregate = await readAggregate();
  if (!aggregate.built) return aggregate;
  const invalid = {
    ...aggregate,
    built: false,
    invalidatedAt: new Date().toISOString(),
    invalidationReason: String(reason || 'trip_removed').slice(0, 80),
  };
  await writeAggregate(invalid);
  await clearBoundedJobCheckpoint(ACHIEVEMENT_REBUILD_JOB_KEY);
  return invalid;
}

const startedAtMs = (trip) => new Date(trip?.start_time).getTime() || 0;

const isCleanTrip = (trip) => (
  (trip?.harsh_brakes_count || 0) === 0 &&
  (trip?.rapid_accel_count || 0) === 0 &&
  (trip?.sharp_turns_count || 0) === 0 &&
  (trip?.speeding_events_count || 0) === 0
);

/**
 * Fold one completed trip into stored lifetime totals.
 *
 * Mirrors `createAchievementStatsAccumulator.addTrip` exactly, minus the
 * calendar-relative terms, which are excluded on purpose: a stored week counter
 * cannot be kept honest as the week boundary moves.
 */
const foldLifetime = (stats, trip, carbonKg) => {
  const clean = isCleanTrip(trip);
  const score = trip.score_overall || 0;
  const distance = Number(trip.distance_km);

  stats.completedCount += 1;
  stats.totalKm += trip.distance_km || 0;
  if (trip.night_driving) stats.nightCount += 1;
  if (clean) stats.cleanTripCount += 1;
  if ((trip.harsh_brakes_count || 0) === 0) stats.noHarshTrips += 1;
  if ((trip.rapid_accel_count || 0) === 0) stats.noRapidTrips += 1;
  if ((trip.sharp_turns_count || 0) === 0) stats.noSharpTrips += 1;
  if ((trip.speeding_events_count || 0) === 0) stats.noSpeedingTrips += 1;
  if (trip.route_replay_available === true) stats.routeReplayTrips += 1;
  if ((trip.duration_seconds || 0) >= 60 * 60) {
    stats.longTrips += 1;
    if (clean) stats.cleanLongTrips += 1;
  }
  if (clean && trip.night_driving) stats.cleanNightTrips += 1;
  if (score >= 90) stats.highScoreTrips += 1;
  if (score >= 95) {
    stats.excellentScoreTrips += 1;
    if (clean) stats.cleanExcellentTrips += 1;
  }
  if (trip.smooth_braking_ratio === 100) stats.smoothBrakeTrips += 1;
  if (trip.phone_use_score_available === true && trip.phone_use_risk === 'none') {
    stats.distractionFreeTrips += 1;
  }
  if (trip.band_label === 'excellent cruise') stats.cruiseMasterTrips += 1;
  if ((trip.close_proximity_count ?? 0) === 0) stats.manoeuvreAlertFreeTrips += 1;
  if (Number.isFinite(distance) && distance > 0 && Number.isFinite(Number(trip.score_overall))) {
    stats.scoreDistanceProduct += Number(trip.score_overall) * distance;
    stats.scoreDistanceWeight += distance;
  }
  if (Number.isFinite(carbonKg)) {
    stats.carbonCo2SavedKg += carbonKg;
    stats.carbonEligibleTripCount += 1;
  }
  return stats;
};

/**
 * Exact per-revision P6 contribution. This deliberately reuses the established
 * achievement accumulator for settings/vehicle dependent carbon semantics and
 * the established lifetime fold for every counter. XP settlement is absent:
 * P6 may replace derived analytics but never replay progression awards.
 */
export const buildAchievementTripContribution = (trip, settings = {}, vehicles = null) => {
  if (trip?.status !== 'completed') return emptyStats();
  const accumulator = createAchievementStatsAccumulator(settings, vehicles);
  accumulator.addTrip(trip);
  const single = accumulator.result();
  const carbonKg = single.carbonEligibleTripCount > 0 ? single.carbonCo2SavedKg : NaN;
  return foldLifetime(emptyStats(), trip, carbonKg);
};

const foldRecentWindow = (recentWindow, trip) => {
  const next = [...recentWindow, {
    id: String(trip.id),
    start: startedAtMs(trip),
    score_overall: trip.score_overall,
    distance_km: trip.distance_km,
    defensive_grade: trip.defensive_grade,
  }];
  next.sort((a, b) => b.start - a.start);
  return next.slice(0, ACHIEVEMENT_RECENT_WINDOW);
};

/**
 * Recompute the calendar-relative terms from a bounded query.
 *
 * Trips arrive newest-first, so paging stops at the first trip older than the
 * window. Work scales with how much the driver drove in seven days, never with
 * how long they have used the app.
 */
const readCurrentWeek = async (now = Date.now(), accounting = null) => {
  const weekAgo = now - 7 * 86400000;
  let weekTripCount = 0;
  let weekHarshBrakes = 0;
  let cursor = null;
  for (let pageIndex = 0; pageIndex < WEEK_WINDOW_MAX_PAGES; pageIndex += 1) {
    const page = await tripService.queryHistoryPage({
      sort: '-start_time',
      limit: WEEK_WINDOW_PAGE,
      status: 'completed',
      ...(cursor ? { cursor } : {}),
    });
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    if (accounting) accounting.items += rows.length;
    let reachedOlder = false;
    for (const trip of rows) {
      if (startedAtMs(trip) < weekAgo) { reachedOlder = true; break; }
      weekTripCount += 1;
      weekHarshBrakes += trip.harsh_brakes_count || 0;
    }
    if (reachedOlder || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { weekTripCount, weekHarshBrakes };
};

/** The one durable rebuild state both entry points fold into. */
const emptyRebuildState = () => ({ stats: emptyStats(), recentWindow: [] });

/**
 * Strict persisted-number test.
 *
 * P4-B-F01-2: `Number.isFinite(Number(value))` accepts values that are not
 * numbers — `'10'`, `''`, `true`, `false`, `null` all coerce to a finite
 * number. `normalizeRebuildState` spreads persisted values through unchanged
 * and `foldLifetime` accumulates with `+=`, so an accepted `completedCount:
 * '10'` folds the next trip as string concatenation (`'101'`), and an untouched
 * counter can be published verbatim by the finalizer. Only a real finite
 * `number` is foldable, so nothing is coerced here: a wrong persisted type
 * rejects the whole checkpoint and the pass restarts. Valid `0` and any valid
 * negative the fold can already produce are preserved.
 */
const isPersistedFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Whether a persisted rebuild state can be folded into from its own cursor.
 *
 * P4-B-F01: the fingerprint proves the *schema version*, not that this
 * particular record is intact. A state with the current fingerprint but a
 * missing or malformed tally used to be silently replaced with empty defaults
 * while the checkpoint's cursor and processed count were kept — so the pass
 * resumed mid-history with a zeroed accumulator and could publish a partial
 * aggregate as `built: true`. Anything this predicate cannot vouch for restarts
 * the whole pass instead.
 *
 * It validates exactly what the fold and the finalizer need:
 * `foldLifetime` requires every lifetime counter to be a persisted `number`
 * (not merely something that coerces to one — see `isPersistedFiniteNumber`),
 * and `foldRecentWindow` / `finalizeRebuiltAggregate` require the recent window
 * to be entries with an id and a persisted numeric sort key.
 */
export function isResumableAchievementRebuildState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  const { stats, recentWindow } = state;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false;
  for (const key of Object.keys(emptyStats())) {
    if (!isPersistedFiniteNumber(stats[key])) return false;
  }
  if (!Array.isArray(recentWindow)) return false;
  if (recentWindow.length > ACHIEVEMENT_RECENT_WINDOW) return false;
  for (const entry of recentWindow) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (typeof entry.id !== 'string' || !entry.id) return false;
    if (!isPersistedFiniteNumber(entry.start)) return false;
  }
  return true;
}

/**
 * Normalize a state that has already been accepted for resume, or a fresh one.
 * Validation is `isResumableAchievementRebuildState`; this only fills defaults
 * so the fold never sees `undefined`.
 */
const normalizeRebuildState = (state) => ({
  stats: { ...emptyStats(), ...(state?.stats || {}) },
  recentWindow: Array.isArray(state?.recentWindow) ? state.recentWindow : [],
});

/**
 * Fold exactly one completed projection into the durable rebuild state, using
 * the same accumulator (for the settings/vehicle-dependent carbon rule) and the
 * same lifetime/recent-window folds `applyCompletedTripToAggregates` uses.
 */
const foldProjectionIntoRebuildState = (state, projection, settings, vehicles) => {
  const current = normalizeRebuildState(state);
  const accumulator = createAchievementStatsAccumulator(settings, vehicles);
  accumulator.addTrip(projection);
  const single = accumulator.result();
  const carbonKg = single.carbonEligibleTripCount > 0 ? single.carbonCo2SavedKg : NaN;
  return {
    stats: foldLifetime(current.stats, projection, carbonKg),
    // Trips arrive newest-first, so the window fills once and is never
    // rewritten; nothing beyond it is retained.
    recentWindow: current.recentWindow.length < ACHIEVEMENT_RECENT_WINDOW
      ? foldRecentWindow(current.recentWindow, projection)
      : current.recentWindow,
  };
};

const finalizeRebuiltAggregate = async (state) => {
  const { stats, recentWindow } = normalizeRebuildState(state);
  const aggregate = {
    version: ACHIEVEMENT_AGGREGATE_VERSION,
    built: true,
    stats: Object.fromEntries(Object.keys(emptyStats()).map((key) => [key, stats[key] ?? 0])),
    recentWindow,
    seenTripIds: recentWindow.map((entry) => entry.id),
    updatedAt: new Date().toISOString(),
  };
  await writeAggregate(aggregate);
  await clearBoundedJobCheckpoint(ACHIEVEMENT_REBUILD_JOB_KEY);
  return aggregate;
};

/**
 * The one rebuild engine. `maxPages: 0` runs to completion (the explicit
 * entry point); `maxPages: 1` is one bounded turn (the lifecycle repair).
 * Identical job key, fingerprint, durable state schema and resume rules, so a
 * partial pass produced by either is safely resumable by the other.
 */
const runAchievementRebuildPass = (settings, {
  vehicles = null,
  signal = null,
  onProgress = null,
  maxPages = 0,
  onTripCounted = null,
} = {}) => runBoundedTripJob({
  jobKey: ACHIEVEMENT_REBUILD_JOB_KEY,
  fingerprint: ACHIEVEMENT_REBUILD_FINGERPRINT,
  status: 'completed',
  signal,
  onProgress,
  maxPages,
  resume: true,
  isResumableState: isResumableAchievementRebuildState,
  initialState: emptyRebuildState,
  onTrip: ({ projection, state }) => {
    onTripCounted?.();
    return foldProjectionIntoRebuildState(state, projection, settings, vehicles);
  },
});

/**
 * Rebuild every lifetime aggregate with one bounded streamed pass.
 *
 * Explicit only: nothing on startup, resume or page open may call this. It is
 * the run-to-completion repair path for a missing, corrupt or version-bumped
 * aggregate, and it is now a wrapper around the same engine and the same
 * durable checkpoint the bounded lifecycle repair uses.
 */
export async function rebuildAchievementAggregates(settings = {}, {
  vehicles = null,
  signal = null,
  onProgress = null,
} = {}) {
  return withAchievementRebuildLock(async () => {
    const outcome = await runAchievementRebuildPass(settings, {
      vehicles, signal, onProgress, maxPages: 0,
    });
    if (!outcome.completed) {
      const { stats, recentWindow } = normalizeRebuildState(outcome.state);
      return {
        aggregate: {
          ...emptyAchievementAggregate(),
          stats: Object.fromEntries(Object.keys(emptyStats()).map((key) => [key, stats[key] ?? 0])),
          recentWindow,
          seenTripIds: recentWindow.map((entry) => entry.id),
        },
        processed: outcome.processed,
        cancelled: outcome.cancelled,
      };
    }
    return {
      aggregate: await finalizeRebuiltAggregate(outcome.state),
      processed: outcome.processed,
      cancelled: outcome.cancelled,
    };
  });
}

/**
 * Fold one newly completed trip into the durable aggregate.
 *
 * Idempotent by trip id against the recent window, so a retried save or a
 * duplicate completion notification cannot double-count. A trip older than the
 * retained window cannot be checked this way and is applied as-is; that only
 * happens for out-of-order writes, which the archive does not produce.
 */
export async function applyCompletedTripToAggregates(trip, settings = {}, { vehicles = null } = {}) {
  if (trip?.status !== 'completed' || !trip?.id) return null;
  const aggregate = await readAggregate();
  if (!aggregate.built) return null;
  if (aggregate.seenTripIds.includes(String(trip.id))) return aggregate;

  // Reuse the shared accumulator for this one trip so the per-trip carbon rule
  // is applied by exactly the same code as the full rebuild.
  const accumulator = createAchievementStatsAccumulator(settings, vehicles);
  accumulator.addTrip(trip);
  const single = accumulator.result();
  const carbonKg = single.carbonEligibleTripCount > 0 ? single.carbonCo2SavedKg : NaN;

  const next = {
    ...aggregate,
    stats: foldLifetime({ ...aggregate.stats }, trip, carbonKg),
    recentWindow: foldRecentWindow(aggregate.recentWindow, trip),
    updatedAt: new Date().toISOString(),
  };
  next.seenTripIds = next.recentWindow.map((entry) => entry.id);
  await writeAggregate(next);
  return next;
}

/**
 * Achievement statistics ready for `buildAchievementBadgesFromStats`.
 *
 * Returns `null` when no aggregate has been built yet, so the caller can
 * decide whether to trigger the explicit rebuild rather than silently
 * reporting zero progress.
 */
export async function readAchievementStats({ now = Date.now(), accounting = null } = {}) {
  const { readP6AchievementStats } = await import('@/lib/p6TripDerivedState');
  const p6 = await readP6AchievementStats({ now }).catch(() => null);
  if (p6) return p6;
  const aggregate = await readAggregate();
  if (!aggregate.built) return null;
  const week = await readCurrentWeek(now, accounting).catch((error) => {
    logSystemFailure('achievement_week_window_read', error, {});
    return { weekTripCount: 0, weekHarshBrakes: 0 };
  });
  const recentWindow = [...aggregate.recentWindow].sort((a, b) => b.start - a.start);
  const recentFive = recentWindow.slice(0, 5);
  const lastTen = recentWindow.slice(0, 10);
  const weightedScore = (entries) => {
    let product = 0;
    let weight = 0;
    for (const entry of entries) {
      const distance = Number(entry.distance_km);
      const score = Number(entry.score_overall);
      if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(score)) continue;
      product += score * distance;
      weight += distance;
    }
    return weight > 0 ? product / weight : 0;
  };
  return {
    ...aggregate.stats,
    ...week,
    recentFiveCount: recentFive.length,
    recentFiveAvg: weightedScore(recentFive),
    avgScore: aggregate.stats.scoreDistanceWeight > 0
      ? aggregate.stats.scoreDistanceProduct / aggregate.stats.scoreDistanceWeight
      : 0,
    defensiveStreak: lastTen.length >= 10 && lastTen.every((entry) => (
      ['defensive', 'exemplary'].includes(entry.defensive_grade)
    )),
    defensiveRecentCount: lastTen.filter((entry) => (
      ['defensive', 'exemplary'].includes(entry.defensive_grade)
    )).length,
  };
}

/**
 * Achievement badges from durable aggregates, rebuilding once if needed.
 */
export async function readAchievementBadges(settings = {}, { vehicles = null, signal = null } = {}) {
  let stats = await readAchievementStats();
  if (!stats) {
    await rebuildAchievementAggregates(settings, { vehicles, signal });
    stats = await readAchievementStats();
  }
  return stats ? buildAchievementBadgesFromStats(stats, settings) : [];
}

/** True when no valid durable aggregate exists, without reading the week window. */
export async function achievementAggregateNeedsRepair() {
  const aggregate = await readAggregate();
  return aggregate.built !== true;
}

/**
 * The two aggregate-derived surfaces a milestone settlement needs, from a
 * single bounded stats read and **without** the explicit whole-history repair.
 *
 * P4-B-F01: `readAchievementBadges` and `readCalibrationProgressFromAggregates`
 * each read the stats separately (two week scans) and each fall back to
 * `rebuildAchievementAggregates`, whose default `maxPages: 0` walks all of
 * history. Neither is admissible inside a bounded lifecycle turn, and this
 * module's own contract already says the rebuild is explicit-only. This reader
 * shares one scan, charges it, and reports `needsRepair` instead of repairing —
 * the caller drives repair through its own bounded turns.
 *
 * @param {object} settings
 * @param {{vehicles?: Array|null, accounting?: {items: number}|null, now?: number}} [options]
 */
export async function readAchievementSurfaces(settings = {}, {
  vehicles: _vehicles = null,
  accounting = null,
  now = Date.now(),
} = {}) {
  const stats = await readAchievementStats({ now, accounting });
  if (!stats) return { badges: [], calibration: null, needsRepair: true };
  return {
    badges: buildAchievementBadgesFromStats(stats, settings),
    calibration: { tripsAnalyzed: stats.completedCount, kmAnalyzed: stats.totalKm },
    needsRepair: false,
  };
}

/**
 * One bounded repair turn for a missing or invalidated aggregate.
 *
 * Same durable job identity, fingerprint and finalisation rule as
 * `rebuildAchievementAggregates`; the only difference is that the running tally
 * lives in the bounded job's own checkpointed `state` instead of an in-memory
 * accumulator, so a turn can stop after `maxPages` and the next one resumes.
 * The per-trip fold is the same pair of functions `applyCompletedTripToAggregates`
 * already uses, so a repaired aggregate matches a folded one exactly. This adds
 * no second aggregate authority and no second checkpoint.
 *
 * @param {object} settings
 * @param {{vehicles?: Array|null, maxPages?: number}} [options]
 */
export async function stepAchievementAggregateRepair(settings = {}, {
  vehicles = null,
  maxPages = 1,
} = {}) {
  // Never wait for the explicit rebuild to finish: a coordinator turn may not
  // block on a process-local queue. A busy checkpoint yields this slice back so
  // the coordinator can re-admit it at the tail after the yield.
  if (isAchievementRebuildBusy()) {
    return { processed: 0, hasMore: true, built: false, busy: true };
  }
  let processedThisTurn = 0;
  // P4-B-F01: the lock must span the *whole* mutation, terminal publication
  // included. Releasing it after the last checkpoint write let an explicit
  // rebuild start and write its own checkpoint, which this finalizer would then
  // clear. One owner at a time holds page fold, aggregate publication and
  // checkpoint cleanup together.
  return withAchievementRebuildLock(async () => {
    const outcome = await runAchievementRebuildPass(settings, {
      vehicles,
      maxPages: Math.max(1, Math.floor(Number(maxPages) || 1)),
      onTripCounted: () => { processedThisTurn += 1; },
    });
    if (!outcome.completed) {
      return { processed: processedThisTurn, hasMore: true, built: false };
    }
    await finalizeRebuiltAggregate(outcome.state);
    return { processed: processedThisTurn, hasMore: false, built: true };
  });
}

/** Calibration progress from the same durable counters. */
export async function readCalibrationProgressFromAggregates() {
  let stats = await readAchievementStats();
  if (!stats) {
    await rebuildAchievementAggregates();
    stats = await readAchievementStats();
  }
  if (!stats) return null;
  return { tripsAnalyzed: stats.completedCount, kmAnalyzed: stats.totalKm };
}
