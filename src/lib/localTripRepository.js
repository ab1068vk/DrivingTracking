import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { clearNativeCompletedTrips, getNativeCompletedTrips } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { buildDrivingThresholds, calculateTripScores, calculateTripStats, detectDrivingEvents } from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';
import { localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import { invalidateDangerZoneCache } from '@/lib/dangerZoneEngine';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import {
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
} from '@/lib/phoneUsageAccess';
import { hasRecoverableOriginalRouteGeometry, restoreOriginalRouteGeometry } from '@/lib/mapPlaybackInsights';

const TRIPS_KEY = 'drivesense_trips';
const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';
const DB_NAME = 'drivesense_mobile';
const DB_VERSION = 1;
const TRIP_STORE = 'trips';
export const TRIP_SCHEMA_VERSION = 9;
/*
 * Completed trip record schema additions in version 3:
 * - road-type segmented scores: highway_score, urban_score, residential_score, dominant_road_type
 * - reaction proxy: reaction_score, avg_reaction_seconds, reaction_grade, reaction_sample_count
 * - cornering consistency: cornering_consistency_score, cornering_grade, mean_lateral_g, peak_lateral_g, corner_sample_count
 * - braking efficiency: braking_efficiency_score, braking_efficiency_grade, braking_sequence_count, avg_braking_smoothness
 * - compliance: highway_compliance, urban_compliance, residential_compliance, overall_compliance_score
 * - overtake quality: overtake_quality_score, overtake_quality_grade, overtake_count, unsafe_reentry_count
 * - road condition proxy: slippery_proxy, wet_signal_count, wet_ratio, safety_condition_bonus, avg_distance_ratio
 * - stats speed zones: speed_zones
 *
 * Completed trip record schema additions in version 4:
 * - phone use detection: phone_use_events, phone_use_window_count, phone_use_total_seconds,
 *   phone_use_risk, phone_use_score, phone_use_pct_of_trip, phone_use_high_confidence_count
 * - native cross-check: native_phone_proxy_count
 *
 * Completed trip record schema additions in version 6:
 * - Android Usage Access phone-use evidence: native_phone_usage_events,
 *   native_phone_usage_event_count, native_phone_usage_total_seconds,
 *   native_phone_usage_access_granted
 *
 * Version 7 recalculates completed trips with stricter lane-change,
 * erratic-speed, overtake-quality, traffic-stop, and night-card logic.
 *
 * Version 8 preserves and reconstructs phone-use events across rescoring and
 * OpenStreetMap/weather refreshes so historical phone-use trips remain visible.
 *
 * Version 9 recalculates trips after privacy-masked coordinates were excluded
 * from map, playback, segment, and speed-zone distance calculations.
 */

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const openDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(TRIP_STORE)) {
      const store = db.createObjectStore(TRIP_STORE, { keyPath: 'id' });
      store.createIndex('start_time', 'start_time');
      store.createIndex('status', 'status');
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const getAllTrips = async () => {
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readonly');
    const trips = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
    db.close();
    return trips;
  } catch {
    return getJson(TRIPS_KEY, []);
  }
};

const putTrip = async (trip) => {
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(TRIP_STORE).put(trip));
    db.close();
  } catch {
    const trips = await getJson(TRIPS_KEY, []);
    const next = [trip, ...trips.filter((item) => String(item.id) !== String(trip.id))];
    await setJson(TRIPS_KEY, next);
  }
};

const putTrips = async (incomingTrips) => {
  for (const trip of incomingTrips) {
    await putTrip(trip);
  }
};

const invalidateTripDerivedCaches = async () => {
  await Promise.all([
    removeJson(DRIVER_SIGNATURE_KEY),
    invalidateDangerZoneCache(),
    invalidateRouteRiskIndex(),
  ]);
};

let importingNativeTrips = false;

const mergedPhoneUseForTrip = (trip, routePoints, stats, detectionPhoneUse) => {
  return buildPhoneUseFromTripEvidence(trip, routePoints, stats.duration_seconds, detectionPhoneUse);
};

const eventFeedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

export const applyEventFeedbackToEvents = (events = [], feedback = {}) => {
  const reviewed = feedback && typeof feedback === 'object' ? feedback : {};
  let removed = 0;
  const filtered = events.filter((event, index) => {
    const verdict = reviewed[eventFeedbackKey(event, index)]?.verdict;
    if (verdict === 'wrong') {
      removed += 1;
      return false;
    }
    return true;
  });
  return { events: filtered, removed };
};

const rescoreTrip = (trip) => {
  if (!trip || trip.status !== 'completed') return trip;
  const routePoints = restoreOriginalRouteGeometry(trip.route_points || []);
  const settings = localSettings.get();
  const thresholds = buildDrivingThresholds(settings);
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
  const detection = detectDrivingEvents(routePoints, thresholds, trip.end_time);
  const events = Reflect.get(detection, 'events') ?? detection;
  const feedbackAdjusted = applyEventFeedbackToEvents(events, trip.event_feedback);
  const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, Reflect.get(detection, 'phoneUse') ?? {});
  const scores = calculateTripScores(feedbackAdjusted.events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
  const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
  const drivingEvents = applyEventFeedbackToEvents(
    mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || feedbackAdjusted.events, phoneUse),
    trip.event_feedback
  );
  return {
    ...trip,
    ...stats,
    ...scores,
    co2_saved_kg: economics.co2_saved_kg,
    route_points: routePoints,
    driving_events: drivingEvents.events,
    feedback_adjusted_events_count: feedbackAdjusted.removed + drivingEvents.removed,
    needs_rescore: false,
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
};

const needsRescore = (trip) => (
  trip?.status === 'completed' &&
  (
    trip.needs_rescore ||
    hasRecoverableOriginalRouteGeometry(trip.route_points || []) ||
    trip.defensive_driving_score == null ||
    trip.reaction_score == null ||
    trip.braking_efficiency_grade == null ||
    trip.overall_compliance_score == null ||
    trip.dominant_road_type == null ||
    trip.phone_use_score == null ||
    trip.phone_use_risk == null ||
    (Number(trip.phone_use_window_count) > 0 && !(trip.driving_events || []).some((event) => event?.type === 'phone_use')) ||
    trip.schema_version !== TRIP_SCHEMA_VERSION
  )
);

const rescoreTripsIfNeeded = async (trips = []) => {
  const next = [];
  for (const trip of trips) {
    if (needsRescore(trip)) {
      const rescored = rescoreTrip(trip);
      await putTrip(rescored);
      next.push(rescored);
    } else {
      next.push(trip);
    }
  }
  return next;
};

const importNativeCompletedTrips = async () => {
  if (!isAndroid() || importingNativeTrips) return;

  importingNativeTrips = true;
  try {
    const nativeTrips = await getNativeCompletedTrips();
    if (!nativeTrips.length) return;

    for (const trip of nativeTrips) {
      const routePoints = trip.route_points || [];
      const settings = localSettings.get();
      const thresholds = buildDrivingThresholds(settings);
      const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
      const detection = detectDrivingEvents(routePoints, thresholds, trip.end_time);
      const events = Reflect.get(detection, 'events') ?? detection;
      const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, Reflect.get(detection, 'phoneUse') ?? {});
      const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
      const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
      const drivingEvents = mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || events, phoneUse);

      const importedTrip = {
        ...trip,
        ...stats,
        ...scores,
        co2_saved_kg: economics.co2_saved_kg,
        route_points: routePoints,
        route_points_raw_count: Number(trip.route_points_raw_count) || routePoints.length,
        route_points_map_count: Number(trip.route_points_map_count) || routePoints.length,
        driving_events: drivingEvents,
        imported_from_native: true,
        schema_version: TRIP_SCHEMA_VERSION,
        updated_at: trip.updated_at || new Date().toISOString(),
      };

      await putTrip(importedTrip);

      const finalPoint = [...routePoints].reverse().find((point) => point?.lat != null && point?.lng != null);
      const endedStopped = importedTrip.parking_stop_detected ||
        Number(importedTrip.parking_stop_duration_seconds || 0) > 0 ||
        Number(finalPoint?.speed_kmh || 0) < (thresholds.IDLE_SPEED_KMH ?? 5);
      if (finalPoint && endedStopped) {
        await saveLastParkedLocation({
          lat: finalPoint.lat,
          lng: finalPoint.lng,
          timestamp: importedTrip.end_time || finalPoint.timestamp || new Date().toISOString(),
          tripId: importedTrip.id,
          source: importedTrip.parking_stop_detected ? 'native_parking_stop' : 'native_stopped_trip_end',
        });
        // Native background trips update the shared parked location only when they ended stopped.
      }
    }

    await clearNativeCompletedTrips();
    await invalidateTripDerivedCaches();
  } catch {
    // The existing JS store remains usable if the native bridge is unavailable.
  } finally {
    importingNativeTrips = false;
  }
};

const deleteTrip = async (id) => {
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(TRIP_STORE).delete(id));
    db.close();
  } catch {
    const trips = await getJson(TRIPS_KEY, []);
    await setJson(TRIPS_KEY, trips.filter((trip) => String(trip.id) !== String(id)));
  }
};

const pruneExpiredTrips = async () => {
  const retentionDays = Number(localSettings.get().data_retention_days || 0);
  if (!retentionDays) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const trips = await getAllTrips();
  const expired = trips.filter((trip) => {
    const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(when) && when > 0 && when < cutoff;
  });

  for (const trip of expired) {
    await deleteTrip(trip.id);
  }
};

const sortTrips = (trips, sort) => {
  const field = sort?.replace('-', '') || 'start_time';
  const dir = sort?.startsWith('-') ? -1 : 1;
  return [...trips].sort((a, b) => {
    const av = a[field] || '';
    const bv = b[field] || '';
    return av > bv ? dir : av < bv ? -dir : 0;
  });
};

const withId = (trip) => ({
  id: trip.id || `trip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  ...trip,
  schema_version: trip.schema_version || TRIP_SCHEMA_VERSION,
  updated_at: new Date().toISOString(),
});

export const localTripRepository = {
  async list({ sort = '-start_time', limit = 100 } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const trips = await rescoreTripsIfNeeded(await getAllTrips());
    return sortTrips(trips, sort).slice(0, limit);
  },

  async getById(id) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const trips = await rescoreTripsIfNeeded(await getAllTrips());
    const trip = trips.find((item) => String(item.id) === String(id));
    if (!trip) throw new Error('Trip not found');
    return trip;
  },

  async create(trip) {
    const saved = withId({ ...trip, created_at: new Date().toISOString() });
    await putTrip(saved);
    if (saved.status === 'completed') await invalidateTripDerivedCaches();
    await pruneExpiredTrips();
    return saved;
  },

  async update(id, patch) {
    const current = await this.getById(id);
    const updated = withId({ ...current, ...patch, id: current.id });
    await putTrip(updated);
    if (updated.status === 'completed') await invalidateTripDerivedCaches();
    return updated;
  },

  async delete(id) {
    await deleteTrip(id);
    return { success: true };
  },

  async upsertMany(trips = []) {
    const normalized = trips.map((trip) => {
      const next = withId({
        ...trip,
        created_at: trip.created_at || trip.start_time || new Date().toISOString(),
      });
      return needsRescore(next) ? rescoreTrip(next) : next;
    });
    await putTrips(normalized);
    if (normalized.some((trip) => trip.status === 'completed')) await invalidateTripDerivedCaches();
    await pruneExpiredTrips();
    return normalized;
  },

  async markCompletedForRescore() {
    const trips = await getAllTrips();
    const updated = trips.map((trip) => (
      trip.status === 'completed'
        ? { ...trip, needs_rescore: true, updated_at: new Date().toISOString() }
        : trip
    ));
    await putTrips(updated);
    await invalidateTripDerivedCaches();
    return updated.filter((trip) => trip.status === 'completed').length;
  },
};
