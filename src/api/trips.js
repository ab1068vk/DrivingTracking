import { API_BASE_URL, apiClient } from "@/api/client";
import { isEphemeralModeActive } from "@/lib/ephemeralTripMode";
import { localTripRepository } from "@/lib/localTripRepository";
import { isNativePlatform } from "@/lib/nativePlatform";
import { suggestTripTag } from "@/lib/tripInsights";
import { normalizeTripTags } from "@/lib/tripMetadata";

export const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

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
    if (isEphemeralModeActive()) {
      return Promise.resolve({
        ...trip,
        id: trip?.id || `ephemeral_${Date.now()}`,
        ephemeral_trip: true,
      });
    }
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
    if (isEphemeralModeActive()) return Promise.resolve({ id, ...patch, ephemeral_trip: true });
    const local = repository();
    return local ? local.update(id, patch) : apiClient.patch(`/trips/${encodeURIComponent(id)}`, patch);
  },

  delete: (id) => {
    const local = repository();
    return local ? local.delete(id) : apiClient.delete(`/trips/${encodeURIComponent(id)}`);
  },

  deleteAll: async () => {
    const local = repository();
    if (local?.deleteAll) return local.deleteAll();
    const trips = await apiClient.get("/trips", { query: { sort: "-start_time", limit: 10000 } });
    await Promise.all(trips.map((trip) => apiClient.delete(`/trips/${encodeURIComponent(trip.id)}`)));
    return { success: true };
  },

  upsertMany: (trips) => {
    if (isEphemeralModeActive()) {
      return Promise.resolve(trips.map((trip, index) => ({
        ...trip,
        id: trip?.id || `ephemeral_${Date.now()}_${index}`,
        ephemeral_trip: true,
      })));
    }
    const local = repository();
    if (local) return local.upsertMany(trips);
    return Promise.all(trips.map((trip) => (
      trip.id
        ? apiClient.patch(`/trips/${encodeURIComponent(trip.id)}`, trip).catch(() => apiClient.post("/trips", trip))
        : apiClient.post("/trips", trip)
    )));
  },

  markCompletedForRescore: async (options = {}) => {
    const local = repository();
    if (local?.markCompletedForRescore) return local.markCompletedForRescore(options);
    const trips = await apiClient.get("/trips", { query: { sort: "-start_time", limit: 5000 } });
    const completed = trips.filter((trip) => trip.status === "completed");
    await Promise.all(completed.map((trip) => (
      apiClient.patch(`/trips/${encodeURIComponent(trip.id)}`, { needs_rescore: true })
    )));
    return completed.length;
  },

  getScoreMigrationSummary: async () => {
    const local = repository();
    if (local?.getScoreMigrationSummary) return local.getScoreMigrationSummary();
    return {
      scoring_version: null,
      completed_count: 0,
      mismatch_count: 0,
      recent_window_days: 28,
      recent_completed_count: 0,
      recent_mismatch_count: 0,
      recent_mismatch_ratio: 0,
      auto_rescore_threshold_ratio: 0.2,
      auto_rescore_recommended: false,
      unavailable_score_count: 0,
      trips: [],
    };
  },
};
