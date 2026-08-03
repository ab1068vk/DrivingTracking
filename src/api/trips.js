import { localTripRepository } from "@/lib/localTripRepository";
import { normalizeTripTags } from "@/lib/tripMetadata";
import {
  getEffectiveTripTags,
  inferTripTags,
  reconcileWeatherDerivedTags,
} from "@/lib/tripTagIntelligence";
import { buildTripSummary } from "@/lib/tripSummary";
import { measureAsync } from "@/lib/performanceTriage";
import { synchronizeLocalRoadMemory } from "@/lib/roadMemoryCoordinator";
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

  listForSpeedMap: ({ sort = "-start_time", offset = 0, limit = 80 } = {}) => (
    measureAsync('tripService.listForSpeedMap', () => (
      repository().listForSpeedMap({ sort, offset, limit })
    ), { sort, offset, limit })
  ),

  listAll: ({ sort = "-start_time" } = {}) => {
    return repository().listAll({ sort });
  },

  listAllForExport: ({ sort = "-start_time", signal, onProgress } = {}) => {
    return repository().listAllForExport({ sort, signal, onProgress });
  },

  getById: (id) => {
    return repository().getById(id);
  },

  create: async (trip) => {
    const history = await repository().listAllSummaries({ sort: "-start_time" }).catch(() => []);
    const intelligence = inferTripTags(trip, history);
    const manualTags = normalizeTripTags(trip);
    const inferredTags = trip.tag_reviewed === true
      ? []
      : getEffectiveTripTags(trip, history).filter((tag) => !manualTags.includes(tag));
    const tags = [...new Set([...manualTags, ...inferredTags])];
    const primary = intelligence.primary;
    const now = new Date().toISOString();
    const tagSources = { ...(trip.tag_sources || {}) };
    manualTags.forEach((tag) => {
      tagSources[tag] = tagSources[tag] || {
        source: trip.tag_reviewed === true ? 'user_confirmed' : 'provided',
        confidence: trip.tag_reviewed === true ? 1 : null,
        reason: trip.tag_reviewed === true ? 'Confirmed by you.' : 'Saved with the trip.',
        applied_at: now,
      };
    });
    intelligence.candidates
      .filter((candidate) => inferredTags.includes(candidate.tag))
      .forEach((candidate) => {
        tagSources[candidate.tag] = {
          source: candidate.source,
          confidence: candidate.confidence,
          reason: candidate.reason,
          applied_at: now,
        };
    });
    const withSuggestion = {
      nickname: trip.nickname ?? "",
      notes: trip.notes ?? "",
      is_favorite: trip.is_favorite === true,
      ...trip,
      tag: trip.tag ?? tags[0] ?? null,
      tags,
      tag_sources: tagSources,
      auto_tag: trip.auto_tag ?? primary?.tag ?? null,
      auto_tag_confidence: trip.auto_tag_confidence ?? primary?.confidence_label ?? 'low',
      auto_tag_reason: trip.auto_tag_reason ?? primary?.reason ?? null,
      auto_tags: trip.auto_tags ?? intelligence.recommended_tags,
      tag_candidates: trip.tag_candidates ?? intelligence.candidates,
      tag_intelligence_version: trip.tag_intelligence_version ?? intelligence.version,
    };
    const saved = await repository().create(withSuggestion);
    if (saved?.status === 'completed') {
      await synchronizeLocalRoadMemory([saved], { rescore: true });
    }
    return saved;
  },

  update: async (id, patch) => {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'weather_context')) {
      return repository().update(id, patch);
    }
    const currentTrip = await repository().getById(id);
    const tagPatch = reconcileWeatherDerivedTags(currentTrip, patch.weather_context);
    return repository().update(id, {
      ...patch,
      ...tagPatch,
    });
  },

  delete: (id) => {
    return repository().delete(id);
  },

  upsertMany: async (trips) => {
    const saved = await repository().upsertMany(trips);
    await synchronizeLocalRoadMemory(saved, { rescore: true });
    return saved;
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
