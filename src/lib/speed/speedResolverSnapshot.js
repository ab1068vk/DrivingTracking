/**
 * A memoized, index-backed view of the saved speed knowledge for the resolver.
 *
 * Resolving one live GPS fix used to cost: open IndexedDB, AES-decrypt the whole
 * knowledge blob, read the write-ahead key, rebuild the normalized document,
 * re-decorate every Road Memory candidate, and re-run the correction-coverage
 * and exclusion filters over all of them. Per fix. On the UI thread. Dashboard
 * and LiveCoachOverlay both do this on every position update.
 *
 * None of that depends on the point being resolved, so it is done once and held
 * until the knowledge actually changes. Invalidation is explicit — every write
 * calls `invalidateSpeedResolverSnapshot` — and mirrored across tabs over a
 * BroadcastChannel, because the change event was a same-window CustomEvent and
 * a second tab could serve stale limits indefinitely.
 */

export const SPEED_KNOWLEDGE_CHANGED_EVENT = 'speed-knowledge-changed';
export const SPEED_KNOWLEDGE_BROADCAST_CHANNEL = 'roadsage-speed-knowledge';

/** @type {{store: any, snapshot: any} | null} */
let cache = null;
/** @type {{store: any, promise: Promise<any>} | null} */
let inflight = null;
let listenersAttached = false;
/** @type {BroadcastChannel | null} */
let channel = null;
let localBroadcastToken = 0;

export function invalidateSpeedResolverSnapshot() {
  cache = null;
  inflight = null;
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(SPEED_KNOWLEDGE_BROADCAST_CHANNEL);
    channel.onmessage = (event) => {
      // Our own writes already invalidated synchronously; ignoring the echo
      // keeps a burst of local edits from thrashing the cache.
      if (event?.data?.token === localBroadcastToken) return;
      invalidateSpeedResolverSnapshot();
    };
  } catch {
    channel = null;
  }
  return channel;
}

function attachListeners() {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;
  window.addEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, invalidateSpeedResolverSnapshot);
  ensureChannel();
}

/** Tell other tabs their snapshot is stale. Safe to call when BroadcastChannel is absent. */
export function broadcastSpeedKnowledgeChanged(detail = {}) {
  const active = ensureChannel();
  if (!active) return;
  localBroadcastToken = (localBroadcastToken + 1) % Number.MAX_SAFE_INTEGER;
  try {
    active.postMessage({ token: localBroadcastToken, action: detail?.action ?? null });
  } catch {
    // A closed channel is not worth failing a write over.
  }
}

/**
 * @param {any} store The backing store, used as the cache identity.
 * @param {() => Promise<any>} build Loads and prepares the resolver document.
 */
export async function getSpeedResolverSnapshot(store, build) {
  attachListeners();
  if (cache && cache.store === store) return cache.snapshot;
  if (inflight && inflight.store === store) return inflight.promise;

  const promise = (async () => {
    const snapshot = await build();
    // A write during the build invalidates it: `inflight` is cleared, so this
    // result is already stale and must not be installed as the cache.
    if (inflight && inflight.promise === promise) {
      cache = { store, snapshot };
      inflight = null;
    }
    return snapshot;
  })();

  inflight = { store, promise };
  return promise;
}

/** Whether a snapshot is currently held. For tests and diagnostics. */
export function speedResolverSnapshotCached(store) {
  return Boolean(cache && cache.store === store);
}

/**
 * Test-only reset. Vitest runs with `--pool=forks --maxWorkers=1`, so module
 * state persists across test files in a worker unless it is cleared.
 */
export function __resetSpeedResolverSnapshot() {
  cache = null;
  inflight = null;
  if (channel) {
    try {
      channel.close();
    } catch {
      // Already closed.
    }
  }
  channel = null;
  if (listenersAttached && typeof window !== 'undefined') {
    window.removeEventListener(SPEED_KNOWLEDGE_CHANGED_EVENT, invalidateSpeedResolverSnapshot);
  }
  listenersAttached = false;
  localBroadcastToken = 0;
}
