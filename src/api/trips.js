import { API_BASE_URL, apiClient } from "@/api/client";
import { localTripRepository } from "@/lib/localTripRepository";
import { isNativePlatform } from "@/lib/nativePlatform";
import { suggestTripTag } from "@/lib/tripInsights";
import { normalizeTripTags } from "@/lib/tripMetadata";
import { buildTripSummary } from "@/lib/tripSummary";

export const shouldUseLocalStore = () => isNativePlatform() || !API_BASE_URL;

const repository = () => (shouldUseLocalStore() ? localTripRepository : null);

export const tripService = {
  listSummaries: async ({ sort = "-start_time", limit = 100 } = {}) => {
    const local = repository();
    const trips = local
      ? await local.listSummaries({ sort, limit })
      : await apiClient.get("/trips", { query: { sort, limit } });
    return trips.map(buildTripSummary);
  },

  listAllSummaries: async ({ sort = "-start_time" } = {}) => {
    const local = repository();
    const trips = local
      ? await local.listAllSummaries({ sort })
      : await apiClient.get("/trips", { query: { sort, limit: 10000 } });
    return trips.map(buildTripSummary);
  },

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

  rescoreCompletedTrips: async (options = {}) => {
    const local = repository();
    if (local?.rescoreCompletedTrips) return local.rescoreCompletedTrips(options);
    const requested = await tripService.markCompletedForRescore(options);
    return {
      requested,
      eligible: requested,
      completed: 0,
      changed: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      queued: requested,
      changes: [],
      skippedTrips: [],
      failures: [],
    };
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
      rescore_eligible_count: 0,
      rescore_ineligible_count: 0,
      mismatch_rescore_eligible_count: 0,
      mismatch_rescore_ineligible_count: 0,
      trips: [],
    };
  },
};

export const tripQueryKeys = {
  summaries: ['trip-summaries'],
  detail: (id) => ['trip', String(id)],
  map: ['map-trips'],
};

export const tripSummaryQueryOptions = () => ({
  queryKey: tripQueryKeys.summaries,
  queryFn: () => tripService.listAllSummaries({ sort: '-start_time' }),
  staleTime: 5 * 60 * 1000,
});
