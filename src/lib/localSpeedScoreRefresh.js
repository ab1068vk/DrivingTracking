import { tripService } from '@/api/trips';
import { correctionMatchesPoint, geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildLocalSpeedKnowledgeScorePatch } from '@/lib/openSourceTripContext';
import { recordSystemEvent } from '@/lib/systemLog';
import { localSettings } from '@/lib/trackingStore';
import { enqueueRescoreJob, getRescoringQueue, processRescoringQueue } from '@/lib/rescoringQueue';

const tripCrossesCell = (trip = {}, geohash = '') => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      geohashEncode(lat, lng) === geohash;
  })
);

const tripCrossesCorrection = (trip = {}, correction = null) => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => (
    correctionMatchesPoint(correction, Number(point?.lat), Number(point?.lng), undefined, {
      timestampMs: point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ?? null,
      headingDeg: point?.heading ?? point?.bearing ?? point?.course ?? null,
      utcOffsetMinutes: point?.utcOffsetMinutes ?? point?.utc_offset_minutes ??
        trip?.trip_utc_offset_minutes ?? null,
    })
  ))
);

const tripCrossesExclusion = (trip = {}, exclusion = null) => (
  Array.isArray(trip.route_points) &&
  trip.route_points.some((point) => (
    correctionMatchesPoint(exclusion, Number(point?.lat), Number(point?.lng), undefined, {
      timestampMs: point?.timestampMs ?? point?.timestamp_ms ?? point?.timestamp ?? point?.recorded_at ?? null,
      headingDeg: point?.heading ?? point?.bearing ?? point?.course ?? null,
      utcOffsetMinutes: point?.utcOffsetMinutes ?? point?.utc_offset_minutes ??
        trip?.trip_utc_offset_minutes ?? null,
      allowLegacyCellMatch: true,
    })
  ))
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
  const remainingTripCount = Math.max(0, Number(durableJob?.remainingTripIds?.length) || 0);
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

export async function refreshTripsCrossingLocalSpeedCell(geohash, settings = localSettings.get()) {
  if (!geohash) return [];
  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    tripCrossesCell(trip, geohash)
  ));
  return queueSpeedRescore(affectedTrips, settings, 'speed_knowledge_cell_changed');
}

export async function refreshTripsForLocalSpeedCorrections(corrections = [], settings = localSettings.get()) {
  const changedCorrections = uniqueCorrections(corrections);
  if (!changedCorrections.length) return [];
  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    changedCorrections.some((correction) => tripCrossesCorrection(trip, correction))
  ));
  return queueSpeedRescore(affectedTrips, settings, 'speed_knowledge_correction_changed');
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
  settings = localSettings.get()
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

  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    (
      changedCorrections.some((correction) => tripCrossesCorrection(trip, correction)) ||
      changedExclusions.some((exclusion) => tripCrossesExclusion(trip, exclusion)) ||
      changedCellGeohashes.some((geohash) => tripCrossesCell(trip, geohash))
    )
  ));
  return queueSpeedRescore(affectedTrips, settings, 'speed_knowledge_rules_changed', {
    knowledgeRevision: afterKnowledge?.knowledgeRevision,
    schemaVersion: afterKnowledge?.schemaVersion,
  });
}

export { tripCrossesCell, tripCrossesCorrection, tripCrossesExclusion };
