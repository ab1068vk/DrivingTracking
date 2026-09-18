import { logSystemFailure } from '@/lib/systemLog';

/**
 * P4-B-F02 — the domain-owned commit boundary for the disposable native
 * projection.
 *
 * The projection turn used to read the canonical generation fence and then, as
 * a *separate* asynchronous step, commit its rows and checkpoint into the
 * disposable IndexedDB cache. Canonical erasure/rollover could land in that
 * window, so a G1 turn could leave G1 rows and a G1 checkpoint behind after
 * authority had already moved to G2 or been erased.
 *
 * This module closes that window without moving any authority:
 *
 * - native still owns the canonical generation and the erasure;
 * - `localTripRepository` still owns the projection store and its checkpoint;
 * - the coordinator's token revalidation stays supplemental.
 *
 * All it adds is mutual exclusion plus an ordering rule, both inside the
 * domain: a projection commit re-reads the generation fence *while holding the
 * barrier*, and a canonical rollover/erasure drops the outgoing generation's
 * projection state *before releasing it*. Whichever of the two wins the
 * barrier, no G1 projection state can outlive a rollover to G2.
 */

let barrier = /** @type {Promise<unknown>} */ (Promise.resolve());
let holders = 0;

/**
 * Set when a verified rollover could not discard the outgoing generation's
 * projection state. While it is set the projection is **fail-closed**: no
 * checkpoint may be resumed and no new page may be committed until the discard
 * finally succeeds. One bounded retry is attempted per coordinated projection
 * turn and per subsequent rollover — never in a loop.
 */
let pendingDiscard = /** @type {{reason: string, attempts: number}|null} */ (null);

/** True while a projection commit or a canonical rollover holds the barrier. */
export const isProjectionBarrierHeld = () => holders > 0;

/**
 * How many discard attempts may be made automatically before the projection
 * stops retrying on its own.
 *
 * The first attempt happens in the rollover itself; the rest are one-per-turn
 * retries the coordinator re-drives through ordinary `hasMore` continuation.
 * Once exhausted the turn takes a typed deferral instead, so a permanently
 * broken disposable store cannot become a retry storm.
 */
export const PROJECTION_DISCARD_MAX_ATTEMPTS = 4;

/** True while a superseded generation's projection state still needs discarding. */
export const hasPendingProjectionDiscard = () => pendingDiscard !== null;

/** True once the automatic retry allowance for the pending discard is spent. */
export const isProjectionDiscardExhausted = () => (
  (pendingDiscard?.attempts || 0) >= PROJECTION_DISCARD_MAX_ATTEMPTS
);

/**
 * Report the spent allowance once and reset it for the next logical instance.
 *
 * The fail-closed marker itself is deliberately kept: the superseded generation
 * still has to stay unusable. Only the *retry* allowance is per logical
 * instance, so a later legitimate admission gets its own bounded attempts
 * instead of inheriting an already-terminal one.
 */
export function consumeProjectionDiscardAllowance() {
  if (!isProjectionDiscardExhausted()) return false;
  pendingDiscard = { reason: pendingDiscard.reason, attempts: 0 };
  return true;
}

/** Bounded scalar evidence for telemetry and tests; never a durable record. */
export const pendingProjectionDiscardSnapshot = () => (
  pendingDiscard ? Object.freeze({ ...pendingDiscard }) : null
);

/** Test seam: clear the in-memory fail-closed marker between fixtures. */
export const __resetProjectionDiscardStateForTests = () => { pendingDiscard = null; };

/**
 * Run one task with projection commits and canonical rollovers mutually
 * excluded. Not reentrant: a task must never call back into the barrier.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function runUnderProjectionBarrier(task) {
  holders += 1;
  const run = barrier.then(task, task);
  barrier = run.then(() => {}, () => {});
  const release = () => { holders = Math.max(0, holders - 1); };
  run.then(release, release);
  return run;
}

/**
 * Logging a disposable-cache failure may never change a canonical result, so a
 * logger that throws is swallowed here rather than propagating out of a
 * verified erasure.
 */
const bestEffortLog = (event, error, context) => {
  try {
    logSystemFailure(event, error, context);
  } catch {
    // A failing logger is not a failing erasure.
  }
};

/**
 * One bounded attempt to discard the superseded generation's projection state.
 * Never throws: on failure it records the fail-closed marker and returns false.
 * The caller already holds the barrier, so this must not take it again.
 *
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
export async function attemptPendingProjectionDiscard(reason = 'canonical_generation_rollover') {
  const attempts = (pendingDiscard?.attempts || 0) + 1;
  try {
    const { discardNativeProjectionState } = await import('@/lib/localTripRepository');
    await discardNativeProjectionState({ reason });
    pendingDiscard = null;
    return true;
  } catch (error) {
    // Fail closed *before* logging, so even a throwing logger cannot leave the
    // stale generation looking usable.
    pendingDiscard = { reason: String(reason || 'canonical_generation_rollover'), attempts };
    bestEffortLog('native_projection_discard_after_generation_rollover', error, { reason, attempts });
    return false;
  }
}

/**
 * Roll canonical authority forward (a generation rollover or an erasure) with
 * the disposable projection commit path excluded, and discard the projection
 * state the outgoing generation owned before the barrier is released.
 *
 * The rollover itself stays with its existing owner — this only wraps it. A
 * rollover that did not verify changes nothing, so nothing is discarded and its
 * result (or its rejection) is returned unchanged. Once it *has* verified,
 * nothing below may turn it into a failure: neither a failed discard of the
 * disposable cache nor a failure of the logging that reports it. A discard that
 * did not succeed leaves the projection fail-closed with a bounded retry, which
 * is why losing it cannot leave stale state usable.
 *
 * @template T
 * @param {() => Promise<T>} rollover
 * @param {{ reason?: string }} [options]
 * @returns {Promise<T>}
 */
export function runCanonicalGenerationRollover(rollover, { reason = 'canonical_generation_rollover' } = {}) {
  return runUnderProjectionBarrier(async () => {
    const result = await rollover();
    if (result?.verified !== true) return result;
    try {
      await attemptPendingProjectionDiscard(reason);
    } catch (error) {
      // Unreachable by construction; kept so no future edit inside the helper
      // can convert a verified canonical erasure into a rejected one.
      bestEffortLog('native_projection_discard_after_generation_rollover', error, { reason });
    }
    return result;
  });
}
