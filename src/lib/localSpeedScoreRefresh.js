import { tripService } from '@/api/trips';
import { correctionMatchesPoint, geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildLocalSpeedKnowledgeScorePatch } from '@/lib/openSourceTripContext';
import { recordSystemEvent } from '@/lib/systemLog';
import { localSettings } from '@/lib/trackingStore';
import { enqueueRescoreJob, getRescoringQueue, pendingTripCount, processRescoringQueue } from '@/lib/rescoringQueue';
import { clearBoundedJobCheckpoint, runBoundedTripJob } from '@/lib/boundedTripJob';

const pointCrossesCell = (point, geohash) => {
  const lat = Number(point?.lat);
  const lng = Number(point?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && geohashEncode(lat, lng) === geohash;
};

const pointCrossesCorrection = (point, correction, trip = {}) => correctionMatchesPoint(
  correction,
  Number(point?.lat),
  Number(point?.lng),
  undefined,
  {
    timestampMs: point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ?? null,
    headingDeg: point?.heading ?? point?.bearing ?? point?.course ?? null,
    utcOffsetMinutes: point?.utcOffsetMinutes ?? point?.utc_offset_minutes ??
      trip?.trip_utc_offset_minutes ?? null,
  }
);

const pointCrossesExclusion = (point, exclusion, trip = {}) => correctionMatchesPoint(
  exclusion,
  Number(point?.lat),
  Number(point?.lng),
  undefined,
  {
    timestampMs: point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ?? null,
    headingDeg: point?.heading ?? point?.bearing ?? point?.course ?? null,
    utcOffsetMinutes: point?.utcOffsetMinutes ?? point?.utc_offset_minutes ??
      trip?.trip_utc_offset_minutes ?? null,
    allowLegacyCellMatch: true,
  }
);

const tripCrossesCell = (trip = {}, geohash = '') => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => pointCrossesCell(point, geohash))
);

const tripCrossesCorrection = (trip = {}, correction = null) => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => pointCrossesCorrection(point, correction, trip))
);

const tripCrossesExclusion = (trip = {}, exclusion = null) => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => pointCrossesExclusion(point, exclusion, trip))
);

const correctionPointSignature = (points = []) => {
  const clean = (Array.isArray(points) ? points : [])
    .map((point) => ({
      lat: Number(point?.lat),
      lng: Number(point?.lng),
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!clean.length) return '';
  const first = clean[0];
  const last = clean.at(-1);
  return [
    clean.length,
    first.lat.toFixed(5),
    first.lng.toFixed(5),
    last.lat.toFixed(5),
    last.lng.toFixed(5),
  ].join(':');
};

const correctionTimeSignature = (rule = null) => {
  if (rule?.enabled !== true) return 'always';
  return [
    (rule.days || []).join(','),
    rule.startMinutes ?? rule.startTime ?? '',
    rule.endMinutes ?? rule.endTime ?? '',
  ].join(':');
};

const correctionIdentityKey = (correction = {}, _index = 0) => {
  const stableId = correction?.id || correction?.ruleId || correction?.sectionKey || correction?.correctionId;
  if (stableId) return `id:${stableId}`;
  return [
    'legacy',
    correction?.geohash || 'unknown',
    correction?.directionMode || 'both',
    Number.isFinite(Number(correction?.directionBearing)) ? Math.round(Number(correction.directionBearing)) : '',
    correctionTimeSignature(correction?.timeRule),
    correctionPointSignature(correction?.sectionPoints),
  ].join('|');
};

const correctionsByIdentity = (corrections = []) => Object.fromEntries(
  (Array.isArray(corrections) ? corrections : [])
    .filter(Boolean)
    .map((correction, index) => [correctionIdentityKey(correction, index), correction])
);

const uniqueCorrections = (corrections = []) => [
  ...new Map((Array.isArray(corrections) ? corrections : [])
    .filter(Boolean)
    .map((correction, index) => [correctionIdentityKey(correction, index), correction])).values(),
];

/**
 * Trip ids matched by a bounded scan, flushed to the durable rescore queue in
 * batches so neither the checkpointed job state nor this module ever holds the
 * whole matched set. Same-revision jobs merge, so repeated flushes build one
 * job rather than many.
 */
const RESCORE_FLUSH_BATCH = 200;

/**
 * The typed disposition of a D3 that has revoked coverage it once claimed.
 * It carries no trip ids on purpose: the retired all-history discovery scan is
 * not what a demoted spatial owner falls back to in the same breath. The next
 * call sees a domain that no longer claims coverage and takes the legal
 * bounded compatibility path.
 */
const refusedSpatialSelection = (request, operation = null) => {
  const result = [];
  Object.assign(result, {
    queuedTripCount: 0,
    totalAffectedTripCount: null,
    spatialSelectionState: request.state || null,
    spatialSelectionRefused: true,
    spatialSelectionPending: true,
    spatialSelectionReason: request.reason || null,
    p6OperationId: operation?.operationId || null,
  });
  return result;
};

const queueP6SpatialSelection = async (descriptors, reason, knowledgeMetadata = {}) => {
  const { createP6AffectedTripSelectionRequest } = await import('@/lib/p6TripDerivedState');
  let request;
  try {
    request = await createP6AffectedTripSelectionRequest({ descriptors, reason, knowledgeMetadata });
  } catch (error) {
    // Without the derived owner there can be no VERIFIED D3 head. Preserve the
    // pre-activation bounded legacy path; once D3 is readable, an operational
    // error still fails closed instead of silently restoring a full scan.
    if (error?.message !== 'IndexedDB unavailable') throw error;
    return null;
  }
  if (!request.accepted) {
    // A named reason is a demotion of a head that had claimed coverage. The
    // unnamed refusal is a domain that never claimed it, which is the only
    // case the retired bounded scan still legally serves.
    if (request.reason) {
      const { recordP6AffectedTripRescoreDebt } = await import('@/lib/p6ExplicitOperations');
      const operation = await recordP6AffectedTripRescoreDebt({
        descriptors, reason, knowledgeMetadata,
        spatialSelectionState: request.state,
        spatialSelectionReason: request.reason,
        selectionContinuation: request.partialAcceptance || null,
      });
      return refusedSpatialSelection(request, operation);
    }
    return null;
  }
  const result = [];
  Object.defineProperties(result, {
    queuedTripCount: { value: 0, enumerable: false },
    totalAffectedTripCount: { value: null, enumerable: false },
    spatialSelectionRequestId: { value: request.requestId, enumerable: false },
  });
  return result;
};

/**
 * Stream one trip's points through a predicate, stopping at the first match.
 *
 * The iterator is closed explicitly on an early exit so the underlying payload
 * handle is released rather than left to the garbage collector.
 */
const streamMatches = async (points, predicate, signal) => {
  const iterator = points[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal?.aborted) return false;
      const { value, done } = await iterator.next();
      if (done) return false;
      if (predicate(value)) return true;
    }
  } finally {
    await iterator.return?.().catch(() => {});
  }
};

/**
 * Bounded, checkpointed replacement for the former
 * `tripService.listAll()` + `Array.filter` pattern.
 *
 * Pages completed trip ids, streams one payload at a time, and enqueues
 * matches in batches. Memory is flat in retained history.
 */
async function scanAndQueueAffectedTrips({
  jobKey,
  fingerprint,
  matches,
  settings,
  reason,
  knowledgeMetadata = {},
  signal = null,
  onProgress = null,
}) {
  let totalAffected = 0;
  let lastJob = null;
  // One worker instance for the whole operation, so every trip it rescores —
  // across all flushes and the final queue drain — is reported back to the
  // caller. Its size is bounded by what the queue actually processes in this
  // invocation, not by how many trips matched.
  const worker = buildRescoreWorker(settings);

  const flush = async (ids) => {
    if (!ids.length) return;
    totalAffected += ids.length;
    lastJob = await enqueueRescoreJob({
      reason,
      tripIds: ids,
      knowledgeRevision: knowledgeMetadata.knowledgeRevision,
      knowledgeSchemaVersion: knowledgeMetadata.schemaVersion,
    }, worker);
  };

  const result = await runBoundedTripJob({
    jobKey,
    fingerprint,
    status: 'completed',
    loadPoints: true,
    signal,
    onProgress,
    initialState: () => ({ pending: [] }),
    onTrip: async ({ projection, tripId, state, points }) => {
      const matched = await streamMatches(points, (point) => matches(point, projection), signal);
      if (matched) state.pending.push(String(tripId));
      if (state.pending.length >= RESCORE_FLUSH_BATCH) {
        await flush(state.pending.splice(0, state.pending.length));
      }
      return state;
    },
  });

  await flush(result.state.pending.splice(0, result.state.pending.length));
  if (result.completed) await clearBoundedJobCheckpoint(jobKey);

  if (!totalAffected && !lastJob) {
    // No trip crosses the change. Still record the knowledge revision so the
    // queue reflects that this revision has been fully considered.
    lastJob = await enqueueRescoreJob({
      reason,
      tripIds: [],
      knowledgeRevision: knowledgeMetadata.knowledgeRevision,
      knowledgeSchemaVersion: knowledgeMetadata.schemaVersion,
    }, worker);
  }

  return finalizeRescoreResult({
    job: lastJob,
    worker,
    totalAffected,
    cancelled: result.cancelled,
  });
}

/**
 * Rescore worker that remembers what it updated.
 *
 * The queue hands it trip ids; it loads each trip itself, so no caller has to
 * retain trip objects for the queue's benefit.
 */
const buildRescoreWorker = (settings) => {
  const updatedById = new Map();
  return {
    rescoreTrip: async (tripId) => {
      const updated = await refreshTripForLocalSpeedKnowledge(tripId, settings);
      updatedById.set(String(tripId), updated);
      return updated;
    },
    updatedTrips: () => [...updatedById.values()].filter(Boolean),
  };
};

async function finalizeRescoreResult({ job, worker, totalAffected, cancelled = false }) {
  if (job && !cancelled) await processRescoringQueue(worker);
  const updated = worker.updatedTrips();
  const durableQueue = job ? await getRescoringQueue().catch(() => []) : [];
  const durableJob = durableQueue.find((item) => item?.id === job?.id) || job;
  const remainingTripCount = pendingTripCount(durableJob);
  Object.defineProperties(updated, {
    queuedTripCount: { value: remainingTripCount, enumerable: false },
    totalAffectedTripCount: { value: totalAffected, enumerable: false },
    targetKnowledgeRevision: {
      value: Number.isFinite(Number(job?.knowledgeRevision)) ? Number(job.knowledgeRevision) : null,
      enumerable: false,
    },
    scanCancelled: { value: cancelled === true, enumerable: false },
  });
  return updated;
}

async function queueSpeedRescore(affectedTrips = [], settings, reason, knowledgeMetadata = {}) {
  const trips = (Array.isArray(affectedTrips) ? affectedTrips : []).filter((trip) => trip?.id);
  const updatedById = new Map();
  const worker = {
    rescoreTrip: async (tripId) => {
      const trip = trips.find((item) => String(item.id) === String(tripId)) || tripId;
      const updated = await refreshTripForLocalSpeedKnowledge(trip, settings);
      updatedById.set(String(tripId), updated);
      return updated;
    },
  };
  const job = await enqueueRescoreJob({
    reason,
    tripIds: trips.map((trip) => trip.id),
    knowledgeRevision: knowledgeMetadata.knowledgeRevision,
    knowledgeSchemaVersion: knowledgeMetadata.schemaVersion,
  }, worker);
  if (job) await processRescoringQueue(worker);
  const updated = [...updatedById.values()].filter(Boolean);
  // Browser localStorage and native Preferences deserialize a fresh queue
  // object. Re-read the durable job after processing instead of inspecting
  // the stale object returned by enqueueRescoreJob.
  const durableQueue = job ? await getRescoringQueue().catch(() => []) : [];
  const durableJob = durableQueue.find((item) => item?.id === job?.id) || job;
  const remainingTripCount = pendingTripCount(durableJob);
  Object.defineProperties(updated, {
    queuedTripCount: { value: remainingTripCount, enumerable: false },
    totalAffectedTripCount: { value: trips.length, enumerable: false },
    targetKnowledgeRevision: {
      value: Number.isFinite(Number(job?.knowledgeRevision)) ? Number(job.knowledgeRevision) : null,
      enumerable: false,
    },
  });
  return updated;
}

export async function refreshTripForLocalSpeedKnowledge(tripOrId, settings = localSettings.get(), extraPatch = {}) {
  const trip = typeof tripOrId === 'object'
    ? tripOrId
    : await tripService.getById(tripOrId);
  if (!trip?.id) throw new Error('Trip not loaded');

  try {
    const scorePatch = await buildLocalSpeedKnowledgeScorePatch(trip, settings);
    const updatedTrip = await tripService.update(trip.id, {
      ...scorePatch,
      ...extraPatch,
    });
    recordSystemEvent('speed_knowledge_trip_rescored', {
      trip_id: String(trip.id),
    }, { category: 'speed_knowledge' });
    return updatedTrip;
  } catch (error) {
    recordSystemEvent('speed_knowledge_trip_rescore_failed', {
      trip_id: String(trip.id),
      error: error?.message || 'Local speed score refresh failed',
    }, {
      category: 'speed_knowledge',
      severity: 'error',
      title: 'Operation failed: speed_knowledge_trip_rescore',
    });
    throw error;
  }
}

export async function refreshTripsCrossingLocalSpeedCell(
  geohash,
  settings = localSettings.get(),
  { signal = null, onProgress = null } = {}
) {
  if (!geohash) return [];
  const indexed = await queueP6SpatialSelection([{ kind: 'cell', geohash }], 'speed_knowledge_cell_changed');
  if (indexed) return indexed;
  return scanAndQueueAffectedTrips({
    jobKey: 'speed_rescore_cell',
    fingerprint: `cell:${geohash}`,
    matches: (point) => pointCrossesCell(point, geohash),
    settings,
    reason: 'speed_knowledge_cell_changed',
    signal,
    onProgress,
  });
}

export async function refreshTripsForLocalSpeedCorrections(
  corrections = [],
  settings = localSettings.get(),
  { signal = null, onProgress = null } = {}
) {
  const changedCorrections = uniqueCorrections(corrections);
  if (!changedCorrections.length) return [];
  const indexed = await queueP6SpatialSelection(
    changedCorrections.map((value) => ({ ...value, kind: 'correction' })),
    'speed_knowledge_correction_changed'
  );
  if (indexed) return indexed;
  return scanAndQueueAffectedTrips({
    jobKey: 'speed_rescore_corrections',
    fingerprint: `corrections:${changedCorrections.map((item) => correctionIdentityKey(item)).sort().join('|')}`,
    matches: (point, projection) => changedCorrections.some(
      (correction) => pointCrossesCorrection(point, correction, projection)
    ),
    settings,
    reason: 'speed_knowledge_correction_changed',
    signal,
    onProgress,
  });
}

export async function refreshTripsCrossingLocalSpeedCorrection(correction, settings = localSettings.get()) {
  return refreshTripsForLocalSpeedCorrections(correction ? [correction] : [], settings);
}

const changedKeys = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter((key) => (
    JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)
  ));
};

export async function refreshTripsForLocalSpeedKnowledgeChanges(
  beforeKnowledge = {},
  afterKnowledge = {},
  settings = localSettings.get(),
  { signal = null, onProgress = null } = {}
) {
  const beforeCorrections = correctionsByIdentity(beforeKnowledge?.corrections);
  const afterCorrections = correctionsByIdentity(afterKnowledge?.corrections);
  const correctionKeys = changedKeys(beforeCorrections, afterCorrections);
  const beforeCandidates = correctionsByIdentity(beforeKnowledge?.roadMemory?.candidates);
  const afterCandidates = correctionsByIdentity(afterKnowledge?.roadMemory?.candidates);
  const candidateKeys = changedKeys(beforeCandidates, afterCandidates);
  const changedCorrections = [
    ...correctionKeys.flatMap((geohash) => (
    [beforeCorrections[geohash], afterCorrections[geohash]].filter(Boolean)
    )),
    ...candidateKeys.flatMap((key) => (
      [beforeCandidates[key], afterCandidates[key]].filter(Boolean)
    )),
  ];
  const beforeExclusions = correctionsByIdentity(beforeKnowledge?.excludedSections);
  const afterExclusions = correctionsByIdentity(afterKnowledge?.excludedSections);
  const exclusionKeys = changedKeys(beforeExclusions, afterExclusions);
  const changedExclusions = exclusionKeys.flatMap((key) => (
    [beforeExclusions[key], afterExclusions[key]].filter(Boolean)
  ));
  const changedCellKeys = new Set(changedKeys(beforeKnowledge?.cells, afterKnowledge?.cells));
  const changedCellGeohashes = [...changedCellKeys];

  if (!changedCorrections.length && !changedExclusions.length && !changedCellKeys.size) {
    const beforeRevision = Number(beforeKnowledge?.knowledgeRevision);
    const afterRevision = Number(afterKnowledge?.knowledgeRevision);
    return Number.isFinite(afterRevision) && afterRevision !== beforeRevision
      ? queueSpeedRescore([], settings, 'speed_knowledge_rules_changed', {
        knowledgeRevision: afterRevision,
        schemaVersion: afterKnowledge?.schemaVersion,
      })
      : [];
  }

  const changedCellSet = new Set(changedCellGeohashes);
  const indexed = await queueP6SpatialSelection([
    ...changedCellGeohashes.map((geohash) => ({ kind: 'cell', geohash })),
    ...changedCorrections.map((value) => ({ ...value, kind: 'correction' })),
    ...changedExclusions.map((value) => ({ ...value, kind: 'exclusion' })),
  ], 'speed_knowledge_rules_changed', {
    knowledgeRevision: afterKnowledge?.knowledgeRevision,
    schemaVersion: afterKnowledge?.schemaVersion,
  });
  if (indexed) return indexed;
  return scanAndQueueAffectedTrips({
    jobKey: 'speed_rescore_knowledge',
    fingerprint: `knowledge:${afterKnowledge?.knowledgeRevision ?? ''}:${
      changedCorrections.map((item) => correctionIdentityKey(item)).sort().join(',')
    }:${changedExclusions.map((item) => correctionIdentityKey(item)).sort().join(',')}:${
      changedCellGeohashes.slice().sort().join(',')
    }`,
    matches: (point, projection) => {
      const lat = Number(point?.lat);
      const lng = Number(point?.lng);
      if (changedCellSet.size && Number.isFinite(lat) && Number.isFinite(lng) &&
        changedCellSet.has(geohashEncode(lat, lng))) return true;
      if (changedCorrections.some((correction) => pointCrossesCorrection(point, correction, projection))) return true;
      return changedExclusions.some((exclusion) => pointCrossesExclusion(point, exclusion, projection));
    },
    settings,
    reason: 'speed_knowledge_rules_changed',
    knowledgeMetadata: {
      knowledgeRevision: afterKnowledge?.knowledgeRevision,
      schemaVersion: afterKnowledge?.schemaVersion,
    },
    signal,
    onProgress,
  });
}

export { tripCrossesCell, tripCrossesCorrection, tripCrossesExclusion };
