import { tripService } from '@/api/trips';
import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { logSystemFailure } from '@/lib/systemLog';

/**
 * Bounded, checkpointed trip-history jobs.
 *
 * P3.5 forbids any production path that materializes the complete trip
 * history. Calibration, privacy analysis/purge, rescore and score refresh all
 * used to call `tripService.listAll()` and hold every decrypted trip — route
 * traces included — in one array. This module is the single replacement
 * pattern they share:
 *
 *   bounded trip-ID page -> one payload stream -> process -> checkpoint -> close
 *
 * Memory is flat in the number of retained trips. The only per-iteration
 * allocation is one trip's own points, and callers that do not need points ask
 * for projections only. Progress is durable, so a job survives process death
 * and resumes from its last committed cursor instead of restarting a
 * multi-minute scan.
 */

export const BOUNDED_JOB_PAGE_SIZE = 50;
export const BOUNDED_JOB_STATE_VERSION = 1;

/**
 * Accumulated job state must itself stay bounded — a job that collects every
 * trip id it has ever seen is only a slower way to hold the whole history.
 * Callers get a hard ceiling rather than a lint rule.
 */
export const MAX_JOB_STATE_BYTES = 256 * 1024;

export class BoundedJobCancelledError extends Error {
  constructor(message = 'Bounded trip job was cancelled') {
    super(message);
    this.name = 'BoundedJobCancelledError';
    this.code = 'BOUNDED_JOB_CANCELLED';
  }
}

export class BoundedJobStateTooLargeError extends Error {
  constructor(bytes) {
    super(`Bounded trip job state exceeded ${MAX_JOB_STATE_BYTES} bytes (${bytes})`);
    this.name = 'BoundedJobStateTooLargeError';
    this.code = 'BOUNDED_JOB_STATE_TOO_LARGE';
  }
}

const throwIfCancelled = (signal) => {
  if (signal?.aborted) throw new BoundedJobCancelledError();
};

const checkpointKey = (jobKey) => `drivesense_bounded_job_${jobKey}`;

/**
 * Page trip projections with a cursor. Never accumulates across pages.
 *
 * `queryHistoryPage` is the one listing both the local and the native
 * repository expose with identical cursor semantics, so a job written against
 * this generator behaves the same on either backend.
 */
export async function* iterateTripProjectionPages({
  status = 'completed',
  sort = '-start_time',
  pageSize = BOUNDED_JOB_PAGE_SIZE,
  startCursor = null,
  signal = null,
} = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(Number(pageSize) || BOUNDED_JOB_PAGE_SIZE)));
  let cursor = startCursor || null;
  let guard = 0;
  for (;;) {
    throwIfCancelled(signal);
    const page = await tripService.queryHistoryPage({
      sort,
      limit,
      ...(status ? { status } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const rows = Array.isArray(page?.rows) ? page.rows : [];
    const nextCursor = page?.nextCursor || null;
    // A backend that returns the same cursor forever would otherwise spin
    // silently rather than fail, which is exactly the class of bug that turns
    // a bounded job into an unbounded one.
    //
    // P4-C-F01: this is asserted *before* the page is handed to the consumer,
    // not after it comes back. A stuck page used to be folded into domain
    // state, counted, and durably checkpointed against its own unchanged
    // cursor before the invariant was checked, so the retry that followed
    // resumed at that cursor and folded the very same rows a second time.
    // Refusing the page up front means a stuck cursor can never reach a fold
    // or a checkpoint at all.
    if (nextCursor && nextCursor === cursor) {
      throw new Error('Bounded trip page cursor did not advance');
    }
    yield { rows, cursor, nextCursor };
    if (!nextCursor) return;
    cursor = nextCursor;
    guard += 1;
    if (guard > 1_000_000) throw new Error('Bounded trip page iteration exceeded its safety guard');
  }
}

/**
 * Stream one trip's route points without ever holding two trips at once.
 *
 * Returns an async iterable of points. Both repositories implement
 * `getPayloadStream`; the local one yields from browser RSAS segments or a
 * legacy inline array, the native one from canonical chunks.
 */
export async function* streamTripPoints(tripId, { signal = null } = {}) {
  const stream = await tripService.getPayloadStream(tripId);
  for await (const point of stream) {
    throwIfCancelled(signal);
    yield point;
  }
}

const readCheckpoint = async (jobKey, fingerprint, isResumableState = null) => {
  const stored = await getJson(checkpointKey(jobKey), null).catch(() => null);
  if (!stored || typeof stored !== 'object') return null;
  if (Number(stored.version) !== BOUNDED_JOB_STATE_VERSION) return null;
  // A checkpoint is only resumable against the same job definition. A changed
  // fingerprint (different filter, different knowledge revision) must restart
  // rather than silently produce a result mixing two definitions.
  if (String(stored.fingerprint || '') !== String(fingerprint || '')) return null;
  // A matching fingerprint is not enough: the cursor is only meaningful for a
  // state the job can actually keep folding into. Resuming a cursor with a
  // reset accumulator would silently skip everything already consumed, so a
  // state the owner cannot vouch for restarts the whole pass instead.
  if (isResumableState && !isResumableState(stored.state)) return null;
  return stored;
};

const writeCheckpoint = async (jobKey, payload) => {
  const serialized = JSON.stringify(payload.state ?? null);
  const bytes = serialized ? serialized.length : 0;
  if (bytes > MAX_JOB_STATE_BYTES) throw new BoundedJobStateTooLargeError(bytes);
  await setJson(checkpointKey(jobKey), { version: BOUNDED_JOB_STATE_VERSION, ...payload });
};

export const clearBoundedJobCheckpoint = (jobKey) => removeJson(checkpointKey(jobKey)).catch(() => {});

export const readBoundedJobProgress = async (jobKey) => {
  const stored = await getJson(checkpointKey(jobKey), null).catch(() => null);
  if (!stored || Number(stored.version) !== BOUNDED_JOB_STATE_VERSION) return null;
  return {
    processed: Number(stored.processed) || 0,
    updatedAt: stored.updatedAt || null,
    done: stored.done === true,
  };
};

/**
 * Run a bounded, checkpointed pass over trip history.
 *
 * @param {object} options
 * @param {string} options.jobKey              durable checkpoint identity
 * @param {string} [options.fingerprint]       job-definition identity; a change forces a restart
 * @param {'completed'|'active'|''} [options.status]
 * @param {boolean} [options.loadPoints]       stream each trip's points
 * @param {boolean} [options.loadFullTrip]     load one complete trip at a time
 * @param {(context: object) => any} options.onTrip
 * @param {() => any} [options.initialState]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: object) => void} [options.onProgress]
 * @param {boolean} [options.resume]
 * @param {(state: any) => boolean} [options.isResumableState]
 *   Domain predicate over the persisted state. A checkpoint whose fingerprint
 *   matches but whose state fails this restarts from the beginning rather than
 *   resuming its cursor with a substituted state.
 * @param {number} [options.checkpointEveryPages]
 * @param {number} [options.maxPages] scheduler-turn page ceiling; 0 = run the
 *   whole pass in one invocation (the historical behaviour, and the default).
 */
export async function runBoundedTripJob({
  jobKey,
  fingerprint = '',
  status = 'completed',
  sort = '-start_time',
  pageSize = BOUNDED_JOB_PAGE_SIZE,
  loadPoints = false,
  loadFullTrip = false,
  onTrip,
  initialState = () => ({}),
  signal = null,
  onProgress = null,
  resume = true,
  checkpointEveryPages = 1,
  maxPages = 0,
  isResumableState = null,
} = {}) {
  if (!jobKey) throw new TypeError('runBoundedTripJob requires a jobKey');
  if (typeof onTrip !== 'function') throw new TypeError('runBoundedTripJob requires an onTrip handler');
  if (isResumableState !== null && typeof isResumableState !== 'function') {
    throw new TypeError('runBoundedTripJob isResumableState must be a predicate');
  }

  const restored = resume ? await readCheckpoint(jobKey, fingerprint, isResumableState) : null;
  let state = restored?.state ?? initialState();
  let processed = Number(restored?.processed) || 0;
  let startCursor = restored?.done === true ? null : (restored?.cursor || null);
  const resumed = Boolean(restored) && restored.done !== true;
  if (restored?.done === true) {
    // A completed job that is asked to run again starts over; the previous
    // result was already delivered to its caller.
    state = initialState();
    processed = 0;
    startCursor = null;
  }

  let pagesSinceCheckpoint = 0;
  // DN1: a non-cancellation failure must never be finalized. Rethrowing from
  // the catch below leaves the last durable checkpoint exactly as the last
  // committed page left it.
  let exhausted = false;
  let pagesThisRun = 0;
  let pendingCursor = startCursor;
  const pageBudget = Math.max(0, Math.floor(Number(maxPages) || 0));

  try {
    for await (const page of iterateTripProjectionPages({ status, sort, pageSize, startCursor, signal })) {
      for (const projection of page.rows) {
        throwIfCancelled(signal);
        const tripId = projection?.id;
        if (!tripId) continue;
        // Exactly one trip is resident per iteration. `trip` is released when
        // the handler returns; nothing here may be retained across iterations.
        const trip = loadFullTrip ? await tripService.getFullById(tripId) : null;
        const context = {
          projection,
          tripId,
          trip,
          state,
          points: loadPoints ? streamTripPoints(tripId, { signal }) : null,
          signal,
        };
        const nextState = await onTrip(context);
        if (nextState !== undefined) state = nextState;
        processed += 1;
      }
      pagesSinceCheckpoint += 1;
      pagesThisRun += 1;
      pendingCursor = page.nextCursor || null;
      onProgress?.({ processed, cursor: page.nextCursor, done: !page.nextCursor });
      if (pagesSinceCheckpoint >= Math.max(1, checkpointEveryPages)) {
        await writeCheckpoint(jobKey, {
          fingerprint,
          cursor: page.nextCursor,
          processed,
          state,
          done: !page.nextCursor,
          updatedAt: new Date().toISOString(),
        });
        pagesSinceCheckpoint = 0;
      }
      if (!page.nextCursor) {
        exhausted = true;
        break;
      }
      // One scheduler turn ends here. Leaving the generator early skips its
      // own cursor-advance assertion for this step, so the same guarantee is
      // asserted across turns instead: a turn that consumed pages without
      // moving the cursor would otherwise spin one turn at a time forever.
      if (pageBudget > 0 && pagesThisRun >= pageBudget) {
        if (pendingCursor === startCursor) {
          throw new Error('Bounded trip page cursor did not advance');
        }
        break;
      }
    }
  } catch (error) {
    if (error?.code === 'BOUNDED_JOB_CANCELLED') {
      // Cancellation keeps the checkpoint so an explicit retry resumes instead
      // of rescanning from zero. It is not a failure and is not logged as one.
      return { state, processed, cancelled: true, resumed, completed: false };
    }
    logSystemFailure('bounded_trip_job_failed', error, { job_key: jobKey, processed });
    throw error;
  }

  // DN1: only a pass that actually reached the end of history may be
  // finalized. A failure leaves the last committed boundary untouched; a turn
  // that stopped on its page budget records that boundary as resumable.
  //
  // P4-C-F01: this is the durable boundary the turn's own result claims, so it
  // runs on the success path and its failure fails the turn. It used to sit in
  // a `finally` behind `.catch(() => {})`, which let a turn report a
  // successful `hasMore` with no durable progress at all whenever
  // `checkpointEveryPages > 1` meant this was the only write.
  if (exhausted || pagesSinceCheckpoint > 0) {
    try {
      await writeCheckpoint(jobKey, {
        fingerprint,
        cursor: exhausted ? null : pendingCursor,
        processed,
        state,
        done: exhausted,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      logSystemFailure('bounded_trip_job_checkpoint_failed', error, { job_key: jobKey, processed });
      throw error;
    }
  }

  return {
    state,
    processed,
    cancelled: false,
    resumed,
    completed: exhausted,
    hasMore: !exhausted,
    cursor: exhausted ? null : pendingCursor,
  };
}

/**
 * One bounded scheduler turn over trip history.
 *
 * P4 owns *when* the next turn runs; this module keeps owning what a page and
 * a durable checkpoint mean. A turn never drives the remaining history: it
 * processes at most `maxPages` pages and reports `hasMore` so the coordinator
 * can tail re-admit the same logical instance.
 */
export const runBoundedTripJobTurn = (options = {}) => runBoundedTripJob({
  ...options,
  maxPages: Math.max(1, Math.floor(Number(options.maxPages) || 1)),
});
