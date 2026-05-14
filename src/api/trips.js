import { apiClient } from "@/api/client";
import { localTripRepository } from "@/lib/localTripRepository";
import { isNativePlatform } from "@/lib/nativePlatform";

const shouldUseLocalStore = () => isNativePlatform() || !import.meta.env.VITE_API_URL;

const repository = () => (shouldUseLocalStore() ? localTripRepository : null);

export const tripService = {
  list: ({ sort = "-start_time", limit = 100 } = {}) => {
    const local = repository();
    return local ? local.list({ sort, limit }) : apiClient.get("/trips", { query: { sort, limit } });
  },

  getById: (id) => {
    const local = repository();
    return local ? local.getById(id) : apiClient.get(`/trips/${encodeURIComponent(id)}`);
  },

  create: (trip) => {
    const local = repository();
    return local ? local.create(trip) : apiClient.post("/trips", trip);
  },

  update: (id, patch) => {
    const local = repository();
    return local ? local.update(id, patch) : apiClient.patch(`/trips/${encodeURIComponent(id)}`, patch);
  },

  delete: (id) => {
    const local = repository();
    return local ? local.delete(id) : apiClient.delete(`/trips/${encodeURIComponent(id)}`);
  },

  upsertMany: (trips) => {
    const local = repository();
    if (local) return local.upsertMany(trips);
    return Promise.all(trips.map((trip) => (
      trip.id
        ? apiClient.patch(`/trips/${encodeURIComponent(trip.id)}`, trip).catch(() => apiClient.post("/trips", trip))
        : apiClient.post("/trips", trip)
    )));
  },
};
