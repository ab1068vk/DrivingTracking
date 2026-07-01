import { tripService } from '@/api/trips';
import { correctionMatchesPoint, geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildLocalSpeedKnowledgeScorePatch } from '@/lib/openSourceTripContext';
import { recordSystemEvent } from '@/lib/systemLog';
import { localSettings } from '@/lib/trackingStore';

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
  const results = [];
  for (const trip of affectedTrips) {
    results.push(await refreshTripForLocalSpeedKnowledge(trip, settings));
  }
  return results;
}

export async function refreshTripsForLocalSpeedCorrections(corrections = [], settings = localSettings.get()) {
  const changedCorrections = uniqueCorrections(corrections);
  if (!changedCorrections.length) return [];
  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    changedCorrections.some((correction) => tripCrossesCorrection(trip, correction))
  ));
  const results = [];
  for (const trip of affectedTrips) {
    results.push(await refreshTripForLocalSpeedKnowledge(trip, settings));
  }
  return results;
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
  const changedCorrections = correctionKeys.flatMap((geohash) => (
    [beforeCorrections[geohash], afterCorrections[geohash]].filter(Boolean)
  ));
  const changedCellKeys = new Set(changedKeys(beforeKnowledge?.cells, afterKnowledge?.cells));
  const changedCellGeohashes = [...changedCellKeys];

  if (!changedCorrections.length && !changedCellKeys.size) return [];

  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    (
      changedCorrections.some((correction) => tripCrossesCorrection(trip, correction)) ||
      changedCellGeohashes.some((geohash) => tripCrossesCell(trip, geohash))
    )
  ));
  const results = [];
  for (const trip of affectedTrips) {
    results.push(await refreshTripForLocalSpeedKnowledge(trip, settings));
  }
  return results;
}

export { tripCrossesCell, tripCrossesCorrection };
