import { getJson, setJson } from '@/lib/mobileStorage';
import { clearNativeCompletedTrips, getNativeCompletedTrips } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { calculateTripScores, calculateTripStats, detectDrivingEvents } from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';

const TRIPS_KEY = 'drivesense_trips';
const DB_NAME = 'drivesense_mobile';
const DB_VERSION = 1;
const TRIP_STORE = 'trips';

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

let importingNativeTrips = false;

const importNativeCompletedTrips = async () => {
  if (!isAndroid() || importingNativeTrips) return;

  importingNativeTrips = true;
  try {
    const nativeTrips = await getNativeCompletedTrips();
    if (!nativeTrips.length) return;

    for (const trip of nativeTrips) {
      const routePoints = trip.route_points || [];
      const settings = localSettings.get();
      const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time);
      const events = detectDrivingEvents(routePoints, {
        HARSH_BRAKE_MS2: settings.threshold_harsh_brake_ms2 || 4.5,
        RAPID_ACCEL_MS2: settings.threshold_rapid_accel_ms2 || 3.5,
        SHARP_TURN_DEG_PER_S: settings.threshold_sharp_turn_degs || 45,
        SPEEDING_FALLBACK_KMH: settings.threshold_speeding_kmh || 130,
        IDLE_SPEED_KMH: 5,
        IDLE_EVENT_SECONDS: settings.threshold_idle_seconds || 60,
        LONG_DRIVE_MINUTES: settings.threshold_long_drive_minutes || 120,
      });
      const scores = calculateTripScores(events, stats);

      await putTrip({
        ...trip,
        ...stats,
        ...scores,
        route_points: routePoints,
        driving_events: events,
        imported_from_native: true,
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
  updated_at: new Date().toISOString(),
});

export const localTripRepository = {
  async list({ sort = '-start_time', limit = 100 } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const trips = await getAllTrips();
    return sortTrips(trips, sort).slice(0, limit);
  },

  async getById(id) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const trips = await getAllTrips();
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
};
