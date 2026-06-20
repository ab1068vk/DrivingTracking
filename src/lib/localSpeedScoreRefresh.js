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

export async function refreshTripsCrossingLocalSpeedCorrection(correction, settings = localSettings.get()) {
  if (!correction) return [];
  const trips = await tripService.listAll({ sort: '-start_time' });
  const affectedTrips = trips.filter((trip) => (
    trip?.status === 'completed' &&
    tripCrossesCorrection(trip, correction)
  ));
  const results = [];
  for (const trip of affectedTrips) {
    results.push(await refreshTripForLocalSpeedKnowledge(trip, settings));
  }
  return results;
}

export { tripCrossesCell, tripCrossesCorrection };
