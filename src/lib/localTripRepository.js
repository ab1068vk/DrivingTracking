import { getJson, setJson } from '@/lib/mobileStorage';
import { clearNativeCompletedTrips, getNativeCompletedTrips } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { DEFAULT_THRESHOLDS, calculateTripScores, calculateTripStats, detectDrivingEvents, simplifyRoute } from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';
import { localSettings } from '@/lib/trackingStore';

const TRIPS_KEY = 'drivesense_trips';
const DB_NAME = 'drivesense_mobile';
const DB_VERSION = 1;
const TRIP_STORE = 'trips';
export const TRIP_SCHEMA_VERSION = 2;

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

let importingNativeTrips = false;

const buildThresholds = (settings = localSettings.get()) => ({
  ...DEFAULT_THRESHOLDS,
  HARSH_BRAKE_MS2: settings.threshold_harsh_brake_ms2 || 4.5,
  RAPID_ACCEL_MS2: settings.threshold_rapid_accel_ms2 || 3.5,
  TAILGATE_DECEL_MS2: settings.threshold_tailgate_decel_ms2 || 2.5,
  SHARP_TURN_G_LOW: settings.threshold_sharp_turn_g_low || 0.30,
  SHARP_TURN_G_MEDIUM: settings.threshold_sharp_turn_g_medium || 0.45,
  SHARP_TURN_G_HIGH: settings.threshold_sharp_turn_g_high || 0.60,
  SPEEDING_FALLBACK_KMH: settings.threshold_speeding_kmh || 130,
  IDLE_SPEED_KMH: 5,
  IDLE_EVENT_SECONDS: settings.threshold_idle_seconds || 90,
  LONG_DRIVE_MINUTES: settings.threshold_long_drive_minutes || 120,
  MIN_SPEED_RAPID_ACCEL_KMH: settings.min_speed_rapid_accel_kmh || 15,
  MIN_SPEED_HARSH_BRAKE_KMH: settings.min_speed_harsh_brake_kmh || 25,
  threshold_harsh_brake_ms2: settings.threshold_harsh_brake_ms2 || 4.5,
  threshold_near_miss_brake_ms2: settings.threshold_near_miss_brake_ms2 || 3.5,
  threshold_near_miss_turn_degs: settings.threshold_near_miss_turn_degs || 30,
  threshold_drowsy_heading_std: settings.threshold_drowsy_heading_std || 8,
  threshold_phone_proxy_oscillations: settings.threshold_phone_proxy_oscillations || 3,
  threshold_speed_creep_kmh: settings.threshold_speed_creep_kmh || 10,
  threshold_overtake_accel_ms2: settings.threshold_overtake_accel_ms2 || 3.0,
});

const rescoreTrip = (trip) => {
  if (!trip || trip.status !== 'completed') return trip;
  const routePoints = trip.route_points || [];
  const settings = localSettings.get();
  const thresholds = buildThresholds(settings);
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time);
  const events = detectDrivingEvents(routePoints, thresholds);
  const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds);
  const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
  return {
    ...trip,
    ...stats,
    ...scores,
    co2_saved_kg: economics.co2_saved_kg,
    driving_events: scores.driving_events || events,
    needs_rescore: false,
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
};

const needsRescore = (trip) => (
  trip?.status === 'completed' &&
  (trip.needs_rescore || trip.defensive_driving_score == null || trip.schema_version !== TRIP_SCHEMA_VERSION)
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
      const thresholds = buildThresholds(settings);
      const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time);
      const events = detectDrivingEvents(routePoints, thresholds);
      const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds);
      const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
      const simplifiedRoutePoints = simplifyRoute(routePoints, 10, events);

      await putTrip({
        ...trip,
        ...stats,
        ...scores,
        co2_saved_kg: economics.co2_saved_kg,
        route_points: simplifiedRoutePoints,
        route_points_raw_count: routePoints.length,
        driving_events: scores.driving_events || events,
        imported_from_native: true,
        schema_version: TRIP_SCHEMA_VERSION,
        updated_at: trip.updated_at || new Date().toISOString(),
      });
    }

    await clearNativeCompletedTrips();
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
    await pruneExpiredTrips();
    return saved;
  },

  async update(id, patch) {
    const current = await this.getById(id);
    const updated = withId({ ...current, ...patch, id: current.id });
    await putTrip(updated);
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
    await pruneExpiredTrips();
    return normalized;
  },
};
