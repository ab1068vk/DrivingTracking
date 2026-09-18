/**
 * AUD-001 / RL-002 — the one P7 source-change coordinator.
 *
 * THE DEFECT. P7 query keys are stable by semantic query shape, which is right: putting a
 * source revision into every key would mint a new cache identity per mutation and, under a
 * 30-minute gc window, grow the cache in proportion to how much the user drives. But
 * nothing then told those stable keys that the source underneath them had changed. The
 * invalidations that existed named legacy families — `['trip-summaries']`, `['trips']`,
 * `['map-trips']` — none of which prefix-match a `['p7', ...]` key, so they refreshed
 * nothing on the migrated surfaces while appearing to.
 *
 * THE MECHANISM. Exactly one piece of O(1) state: the latest source token. No revision
 * history is kept, because nothing needs to ask what changed — only whether anything did.
 * Signals coalesce into one notification per microtask, so a batch import that advances
 * the revision sixty times costs one invalidation, not sixty.
 *
 * WHERE IT IS PUBLISHED. At the canonical source-revision boundaries themselves, after the
 * change is durable (or, for the conservative epoch, once it is known to have advanced
 * even though the durable write failed) — never at each individual UI action, which is how
 * paths get missed. Every mutation class that changes a P7 answer reaches one of those two
 * boundaries: create, update/edit, split, chunked persist, import, restore, native
 * completed-trip intake, journal ingest, delete, erasure and generation rollover.
 *
 * WHAT SUBSCRIBES. The query client applies semantic invalidation to the live `['p7']`
 * families; surfaces that accumulate rows OUTSIDE React Query — the history pages — also
 * reset what they accumulated, because page 1 from the new snapshot may not be shown above
 * later pages from the old one.
 */

/** The only state. Monotonic, O(1), and never a list. */
let latestToken = 0;
let latestReason = '';
let pending = false;

/** @type {Set<(change: {token: number, reason: string}) => void>} */
const listeners = new Set();

const notify = () => {
  const change = { token: latestToken, reason: latestReason };
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // A failing subscriber must not stop the others from being told, and must not
      // propagate into the mutation that published: a refresh is not worth failing a save.
    }
  }
};

/**
 * Announce that the canonical source has advanced.
 *
 * Safe to call more often than strictly necessary — over-invalidation is legal, a missed
 * invalidation is not — because the notification coalesces.
 *
 * @param {string} [reason] diagnostics only; never used to decide what to invalidate
 * @returns {number} the new token
 */
export function publishP7SourceChange(reason = 'source_changed') {
  latestToken += 1;
  latestReason = String(reason || 'source_changed');
  if (pending) return latestToken;
  pending = true;
  const flush = () => {
    pending = false;
    notify();
  };
  if (typeof queueMicrotask === 'function') queueMicrotask(flush);
  else Promise.resolve().then(flush);
  return latestToken;
}

/** The latest token. A consumer compares it with the one it last acted on. */
export function getP7SourceToken() {
  return latestToken;
}

/**
 * @param {(change: {token: number, reason: string}) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeP7SourceChange(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam. Never called by application code. */
export function resetP7SourceChangeForTests() {
  listeners.clear();
  latestToken = 0;
  latestReason = '';
  pending = false;
}
