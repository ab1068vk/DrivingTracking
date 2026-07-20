import { localTripRepository } from "@/lib/localTripRepository";
import { suggestTripTag } from "@/lib/tripInsights";
import { normalizeTripTags } from "@/lib/tripMetadata";
import { buildTripSummary } from "@/lib/tripSummary";
import { measureAsync } from "@/lib/performanceTriage";
import { keepPreviousData } from '@tanstack/react-query';

// Trip records can contain precise GPS traces. Keep them local-only even when a
// backend API URL is configured for non-trip resources.
export const shouldUseLocalStore = () => true;

const repository = () => localTripRepository;

export const tripService = {
  listSummaries: async ({ sort = "-start_time", limit = 100 } = {}) => {
    return measureAsync('tripService.listSummaries', async () => {
      const trips = await repository().listSummaries({ sort, limit });
      return trips.map(buildTripSummary);
    }, { sort, limit });
  },

  listAllSummaries: async ({ sort = "-start_time" } = {}) => {
    return measureAsync('tripService.listAllSummaries', async () => {
      const trips = await repository().listAllSummaries({ sort });
      return trips.map(buildTripSummary);
    }, { sort });
  },

  list: ({ sort = "-start_time", limit = 100 } = {}) => measureAsync('tripService.list', () => {
    return repository().list({ sort, limit });
  }, { sort, limit }),

  listAll: ({ sort = "-start_time" } = {}) => {
    return repository().listAll({ sort });
  },

  listAllForExport: ({ sort = "-start_time", signal, onProgress } = {}) => {
    return repository().listAllForExport({ sort, signal, onProgress });
  },

  getById: (id) => {
    return repository().getById(id);
  },

  create: (trip) => {
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
    return repository().create(withSuggestion);
  },

  update: (id, patch) => {
    return repository().update(id, patch);
  },

  delete: (id) => {
    return repository().delete(id);
  },

  upsertMany: (trips) => {
    return repository().upsertMany(trips);
  },

  markCompletedForRescore: async (options = {}) => {
    return repository().markCompletedForRescore(options);
  },

  rescoreCompletedTrips: async (options = {}) => {
    return repository().rescoreCompletedTrips(options);
  },

  rescoreById: async (id, options = {}) => {
    return repository().rescoreTripById(id, options);
  },

  getScoreMigrationSummary: async () => {
    return repository().getScoreMigrationSummary();
  },
};

export const tripQueryKeys = {
  summaries: ['trip-summaries'],
  limitedSummaries: (limit = 50) => ['trip-summaries', 'limited', Number(limit) || 50],
  detail: (id) => ['trip', String(id)],
  map: ['map-trips'],
};

export const TRIP_DETAIL_STALE_TIME = 2 * 60 * 1000;
export const TRIP_DETAIL_GC_TIME = 5 * 60 * 1000;

export const limitedTripSummaryQueryOptions = (limit = 50) => {
  const safeLimit = Math.max(1, Number(limit) || 50);
  return {
    queryKey: tripQueryKeys.limitedSummaries(safeLimit),
    queryFn: () => measureAsync(
      'limitedTripSummaryQueryOptions.queryFn',
      () => tripService.listSummaries({ sort: '-start_time', limit: safeLimit }),
      { limit: safeLimit }
    ),
    staleTime: 2 * 60 * 1000,
    placeholderData: keepPreviousData,
  };
};

export const tripSummaryQueryOptions = () => ({
  queryKey: tripQueryKeys.summaries,
  queryFn: () => measureAsync(
    'tripSummaryQueryOptions.queryFn',
    () => tripService.listAllSummaries({ sort: '-start_time' })
  ),
  staleTime: 5 * 60 * 1000,
  placeholderData: keepPreviousData,
});

export const tripDetailQueryOptions = (id) => ({
  queryKey: tripQueryKeys.detail(id || 'none'),
  queryFn: () => tripService.getById(id),
  enabled: Boolean(id),
  staleTime: TRIP_DETAIL_STALE_TIME,
  gcTime: TRIP_DETAIL_GC_TIME,
});
