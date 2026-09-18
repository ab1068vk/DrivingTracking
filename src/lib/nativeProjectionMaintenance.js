import { nativeTripArchive } from '@/lib/nativeTripArchive';
import {
  applyNativeProjectionTurn,
  readNativeProjectionState,
} from '@/lib/localTripRepository';

const PAGE_ITEMS = 100;
const PAGE_BYTES = 256 * 1024;

const freshState = (generation, snapshotSeq) => ({
  generation,
  mode: 'rebuild',
  cursor: null,
  snapshotSeq,
  afterSeq: 0,
  applied: 0,
  updatedAt: Date.now(),
});

const healthyGeneration = (health) => {
  const authorityReady = health?.authorityState === 'NATIVE' || health?.testAuthorityEnabled === true;
  if (!authorityReady || health?.recoveryState !== 'HEALTHY' || health?.sentinelMatches !== true) {
    return null;
  }
  const generation = String(health?.archiveGeneration || '');
  return generation || null;
};

const verifyProjectionCommitFence = async (expectedGeneration) => {
  const health = await nativeTripArchive.health();
  const generation = healthyGeneration(health);
  if (!generation) return { allowed: false, deferred: true, reason: 'canonical_not_healthy' };
  if (generation !== expectedGeneration) {
    return { allowed: false, obsolete: true, reason: 'canonical_generation_changed' };
  }
  return { allowed: true };
};

/**
 * Commit one bounded projection page.
 *
 * P4-B-F02: the fence is evaluated by the repository *inside* its commit
 * barrier rather than here, so a canonical rollover or erasure cannot land
 * between the last successful generation read and the durable write. Returns
 * the typed refusal when the fence rejected the commit, otherwise `null`.
 */
const commitProjectionTurn = async (generation, payload) => {
  const outcome = await applyNativeProjectionTurn({
    ...payload,
    generation,
    verifyCommit: () => verifyProjectionCommitFence(generation),
  });
  if (outcome?.refused !== true) return null;
  const fence = outcome.fence || {};
  if (fence.retry === true) {
    return { retry: true, reason: fence.reason || 'projection_retry_pending' };
  }
  if (fence.failed === true) {
    return { failed: true, reason: fence.reason || 'projection_commit_unavailable' };
  }
  return {
    ...(fence.obsolete === true ? { obsolete: true } : { deferred: true }),
    ...(fence.wake ? { wake: fence.wake } : {}),
    reason: fence.reason || 'canonical_generation_changed',
  };
};

/** One bounded, restartable native-catalog -> disposable-IDB projection turn. */
export async function runNativeProjectionTurn({ expectedGeneration = null } = {}) {
  const health = await nativeTripArchive.health();
  const generation = healthyGeneration(health);
  if (!generation) {
    return { deferred: true, reason: 'canonical_not_healthy' };
  }
  if (expectedGeneration !== null && generation !== String(expectedGeneration)) {
    return { obsolete: true, reason: 'canonical_generation_changed' };
  }
  let state = await readNativeProjectionState();
  if (!state || state.generation !== generation) {
    state = freshState(generation, Number(health.lastCommittedSeq) || 0);
  }

  if (state.mode === 'rebuild') {
    const page = await nativeTripArchive.queryHistoryPage({
      sort: '-start_time', maxItems: PAGE_ITEMS, maxBytes: PAGE_BYTES,
      ...(state.cursor ? { cursor: state.cursor } : {}),
    });
    const next = {
      ...state,
      cursor: page.nextCursor || null,
      mode: page.nextCursor ? 'rebuild' : 'catchup',
      afterSeq: page.nextCursor ? state.afterSeq : state.snapshotSeq,
      applied: state.applied + (page.items?.length || 0),
      updatedAt: Date.now(),
    };
    const refused = await commitProjectionTurn(generation, { items: page.items || [], checkpoint: next });
    if (refused) return refused;
    return { mode: next.mode, applied: page.items?.length || 0, done: next.mode === 'catchup' };
  }

  const feed = await nativeTripArchive.projectionFeed({
    afterSeq: Number(state.afterSeq) || 0,
    maxItems: PAGE_ITEMS,
    maxBytes: PAGE_BYTES,
  });
  if (Number(feed.oldestAvailableSeq) > Number(state.afterSeq) + 1) {
    const next = freshState(generation, Number(health.lastCommittedSeq) || Number(feed.requiredSeq) || 0);
    const refused = await commitProjectionTurn(generation, { checkpoint: next });
    if (refused) return refused;
    return { mode: 'rebuild', applied: 0, done: false, reason: 'event_window_compacted' };
  }
  const metadata = [];
  const deleted = [];
  const seen = new Set();
  for (const event of feed.items || []) {
    if (!event.tripId) continue;
    if (event.eventType === 'TOMBSTONE') { deleted.push(event.tripId); continue; }
    if (!['COMMIT', 'SUPERSEDE'].includes(event.eventType) || seen.has(event.tripId)) continue;
    seen.add(event.tripId);
    const item = await nativeTripArchive.metadata(event.tripId);
    if (item) metadata.push(item); else deleted.push(event.tripId);
  }
  const next = {
    ...state,
    afterSeq: Number(feed.afterSeq) || state.afterSeq,
    mode: feed.hasMore ? 'catchup' : 'idle',
    applied: state.applied + metadata.length,
    updatedAt: Date.now(),
  };
  const refused = await commitProjectionTurn(generation, { items: metadata, deletedIds: deleted, checkpoint: next });
  if (refused) return refused;
  return { mode: next.mode, applied: metadata.length, deleted: deleted.length, done: next.mode === 'idle' };
}
