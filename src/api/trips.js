import { API_BASE_URL, apiClient } from "@/api/client";
import { localTripRepository } from "@/lib/localTripRepository";
import { isNativePlatform } from "@/lib/nativePlatform";
import { suggestTripTag } from "@/lib/tripInsights";
import { normalizeTripTags } from "@/lib/tripMetadata";

const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

const repository = () => (shouldUseLocalStore() ? localTripRepository : null);

export const tripService = {
  list: ({ sort = "-start_time", limit = 100 } = {}) => {
    const local = repository();
    return local ? local.list({ sort, limit }) : apiClient.get("/trips", { query: { sort, limit } });
  },

  listAll: ({ sort = "-start_time" } = {}) => {
    const local = repository();
    return local ? local.listAll({ sort }) : apiClient.get("/trips", { query: { sort, limit: 10000 } });
  },

  getById: (id) => {
    const local = repository();
    return local ? local.getById(id) : apiClient.get(`/trips/${encodeURIComponent(id)}`);
  },

  create: (trip) => {
    const local = repository();
    const suggestion = suggestTripTag(trip);
    const withSuggestion = {
      ...suggestion,
      tag: trip.tag ?? null,
      tags: normalizeTripTags(trip),
      nickname: trip.nickname ?? "",
      notes: trip.notes ?? "",
      is_favorite: trip.is_favorite === true,
      ...trip,
      auto_tag: trip.auto_tag ?? suggestion.auto_tag,
      auto_tag_confidence: trip.auto_tag_confidence ?? suggestion.auto_tag_confidence,
    };
    return local ? local.create(withSuggestion) : apiClient.post("/trips", withSuggestion);
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

  markCompletedForRescore: async () => {
    const local = repository();
    if (local?.markCompletedForRescore) return local.markCompletedForRescore();
    const trips = await apiClient.get("/trips", { query: { sort: "-start_time", limit: 5000 } });
    const completed = trips.filter((trip) => trip.status === "completed");
    await Promise.all(completed.map((trip) => (
      apiClient.patch(`/trips/${encodeURIComponent(trip.id)}`, { needs_rescore: true })
    )));
    return completed.length;
  },
};
