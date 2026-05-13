import { getJson, setJson } from '@/lib/mobileStorage';

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
    const trips = await getAllTrips();
    return sortTrips(trips, sort).slice(0, limit);
  },

  async getById(id) {
    const trips = await getAllTrips();
    const trip = trips.find((item) => String(item.id) === String(id));
    if (!trip) throw new Error('Trip not found');
    return trip;
  },

  async create(trip) {
    const saved = withId({ ...trip, created_at: new Date().toISOString() });
    await putTrip(saved);
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
