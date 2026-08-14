/**
 * A memoized, index-backed view of the hazard knowledge for the live warning.
 *
 * Evaluating one GPS fix used to cost a full `loadDangerZones()` — open storage,
 * AES-decrypt the whole zone blob, parse it — and then a linear scan of every
 * zone in it. Per fix, on the UI thread, at a 1-2 s cadence, for the entire
 * drive. None of that depends on the point being evaluated.
 *
 * So it is done once and held until the knowledge actually changes. Invalidation
 * is explicit — every write calls `invalidateHazardHorizonSnapshot` — and
 * mirrored across tabs over a BroadcastChannel, because MapScreen can rewrite
 * the zone set while a drive is running in another tab.
 *
 * The spatial index is `buildSpeedSpatialIndex`, reused unchanged: nothing about
 * it is speed-specific, and a second implementation would only drift from the
 * one the speed resolver depends on.
 *
 * One thing this module fixes rather than mirrors: the stored zones have never
 * been privacy-filtered. `routeRiskIndex` applies a guard ring when it loads,
 * `dangerZoneEngine` applies nothing. The filter is applied here, on the live
 * path, rather than inside `dangerZoneEngine` — non-live surfaces build zones
 * from already-masked trip data and have their own display rules.
 */
import { buildSpeedSpatialIndex, DEFAULT_INDEX_CELL_DEG } from '@/lib/speed/speedSpatialIndex';
import { isPointInPrivacyZone } from '@/lib/privacyZones';
import { ROUTE_RISK_PRIVACY_ZONE_GUARD_M, ROUTE_RISK_SNAP_DISTANCE_M } from '@/lib/routeRiskIndex';
import { HAZARD_CORRIDOR_MAX_HALF_WIDTH_M } from '@/lib/appConstants';

export const HAZARD_KNOWLEDGE_CHANGED_EVENT = 'hazard-knowledge-changed';
export const HAZARD_KNOWLEDGE_BROADCAST_CHANNEL = 'roadsage-hazard-knowledge';

/** Half a grid cell, so consecutive samples cannot step over a bucket. */
const CORRIDOR_SAMPLE_STEP_M = (DEFAULT_INDEX_CELL_DEG * 111320) / 2;

/** @type {{key: string, snapshot: any} | null} */
let cache = null;
/** @type {{key: string, promise: Promise<any>} | null} */
let inflight = null;
let listenersAttached = false;
/** @type {BroadcastChannel | null} */
let channel = null;
let localBroadcastToken = 0;

export function invalidateHazardHorizonSnapshot() {
  cache = null;
  inflight = null;
}

function ensureChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try {
    channel = new BroadcastChannel(HAZARD_KNOWLEDGE_BROADCAST_CHANNEL);
    channel.onmessage = (event) => {
      // Our own writes already invalidated synchronously; ignoring the echo
      // keeps a burst of local edits from thrashing the cache.
      if (event?.data?.token === localBroadcastToken) return;
      invalidateHazardHorizonSnapshot();
    };
  } catch {
    channel = null;
  }
  return channel;
}

function attachListeners() {
  if (listenersAttached || typeof window === 'undefined') return;
  listenersAttached = true;
  window.addEventListener(HAZARD_KNOWLEDGE_CHANGED_EVENT, invalidateHazardHorizonSnapshot);
  ensureChannel();
}

/** Tell other tabs their snapshot is stale. Safe to call when BroadcastChannel is absent. */
export function broadcastHazardKnowledgeChanged(detail = {}) {
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
 * The single call a write path makes after changing hazard knowledge.
 *
 * `dangerZoneEngine` and `routeRiskIndex` reach this through `await import(...)`
 * from inside their async writers rather than a static import. This module
 * statically imports `routeRiskIndex` for its guard constants, so a static edge
 * back would be a cycle, and a cycle over `export const` bindings resolves to
 * undefined rather than failing loudly.
 */
export async function notifyHazardKnowledgeChanged(action = null) {
  invalidateHazardHorizonSnapshot();
  broadcastHazardKnowledgeChanged({ action });
}

/**
 * Zone geometry changes have to rebuild the index, so the zone set is part of
 * the cache identity rather than something the caller has to remember to clear.
 */
const privacySignature = (privacyZones = []) => (Array.isArray(privacyZones) ? privacyZones : [])
  .map((zone) => `${zone?.id ?? ''}:${zone?.lat ?? ''}:${zone?.lng ?? ''}:${zone?.radius_m ?? ''}`)
  .sort()
  .join('|');

const finite = (value) => Number.isFinite(Number(value));
const located = (record) => finite(record?.lat) && finite(record?.lng);

const outsidePrivacy = (record, privacyZones) => !isPointInPrivacyZone(
  { lat: Number(record.lat), lng: Number(record.lng) },
  privacyZones,
  ROUTE_RISK_PRIVACY_ZONE_GUARD_M
);

async function buildSnapshot(privacyZones) {
  // Imported lazily so `dangerZoneEngine` and `routeRiskIndex` can call
  // `invalidateHazardHorizonSnapshot` on write without a circular import.
  const [{ loadDangerZones }, { loadRouteRiskIndex }] = await Promise.all([
    import('@/lib/dangerZoneEngine'),
    import('@/lib/routeRiskIndex'),
  ]);

  const [storedZones, riskIndex] = await Promise.all([
    loadDangerZones().catch(() => []),
    loadRouteRiskIndex(privacyZones).catch(() => new Map()),
  ]);

  const zones = (Array.isArray(storedZones) ? storedZones : [])
    .filter((zone) => located(zone) && outsidePrivacy(zone, privacyZones));
  // loadRouteRiskIndex already applies the guard, but a segment with no midpoint
  // survives it unchecked, and one of those cannot be placed on a corridor anyway.
  const segments = [...(riskIndex instanceof Map ? riskIndex.values() : [])].filter(located);

  const records = [
    ...zones.map((zone) => ({ kind: 'zone', zone })),
    ...segments.map((segment) => ({ kind: 'segment', segment })),
  ];
  const index = buildSpeedSpatialIndex(
    records,
    (record) => (record.kind === 'zone'
      ? [{ lat: record.zone.lat, lng: record.zone.lng }]
      : [{ lat: record.segment.lat, lng: record.segment.lng }]),
    (record) => {
      const ownRadiusM = record.kind === 'zone'
        ? Number(record.zone.radiusM) || 0
        : ROUTE_RISK_SNAP_DISTANCE_M;
      return (ownRadiusM + HAZARD_CORRIDOR_MAX_HALF_WIDTH_M) / 1000;
    }
  );

  return {
    builtAt: Date.now(),
    zones,
    segments,
    index,
    stats: {
      zoneCount: zones.length,
      segmentCount: segments.length,
      privacyFilteredZones: (Array.isArray(storedZones) ? storedZones.length : 0) - zones.length,
      ...index.stats(),
    },
  };
}

/**
 * @param {{privacyZones?: Array<any>}} options
 * @returns {Promise<{builtAt, zones, segments, index, stats}>}
 */
export async function getHazardHorizonSnapshot({ privacyZones = [] } = {}) {
  attachListeners();
  const key = privacySignature(privacyZones);
  if (cache && cache.key === key) return cache.snapshot;
  if (inflight && inflight.key === key) return inflight.promise;

  const promise = (async () => {
    const snapshot = await buildSnapshot(privacyZones);
    // A write during the build invalidates it: `inflight` is cleared, so this
    // result is already stale and must not be installed as the cache.
    if (inflight && inflight.promise === promise) {
      cache = { key, snapshot };
      inflight = null;
    }
    return snapshot;
  })();

  inflight = { key, promise };
  return promise;
}

/**
 * Every record whose padded footprint touches the projected corridor.
 *
 * The index answers a point question, so the corridor is sampled at half-cell
 * spacing and the results unioned. Deliberately a superset — the precise
 * along/cross-track test still runs on whatever comes back.
 */
export function queryHazardCorridor(snapshot, path) {
  if (!snapshot?.index || !path?.points?.length) return [];
  const found = new Set();
  let nextSampleAt = 0;
  for (const point of path.points) {
    if (point.distanceM < nextSampleAt && point.distanceM !== 0) continue;
    nextSampleAt = point.distanceM + CORRIDOR_SAMPLE_STEP_M;
    for (const record of snapshot.index.query(point.lat, point.lng)) found.add(record);
  }
  // The corridor end is a sample even when it does not fall on the stride.
  const last = path.points[path.points.length - 1];
  for (const record of snapshot.index.query(last.lat, last.lng)) found.add(record);
  return [...found];
}

/** Whether a snapshot is currently held. For tests and diagnostics. */
export function hazardHorizonSnapshotCached(privacyZones = []) {
  return Boolean(cache && cache.key === privacySignature(privacyZones));
}

/**
 * Test-only reset. Vitest runs with `--pool=forks --maxWorkers=1`, so module
 * state persists across test files in a worker unless it is cleared.
 */
export function __resetHazardHorizonSnapshot() {
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
    window.removeEventListener(HAZARD_KNOWLEDGE_CHANGED_EVENT, invalidateHazardHorizonSnapshot);
  }
  listenersAttached = false;
  localBroadcastToken = 0;
}
