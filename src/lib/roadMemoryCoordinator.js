import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { getPrivacyZones } from '@/lib/privacyZones';
import { localSettings } from '@/lib/trackingStore';
import { logSystemFailure } from '@/lib/systemLog';

let synchronizationChain = Promise.resolve();
let historyBackfillPromise = null;

async function synchronize(trips = [], { rescore = true } = {}) {
  const completed = (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed' && Array.isArray(trip?.route_points));
  if (!completed.length) return { changed: false, changedCandidates: [] };

  const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
  const result = await knowledge.learnRoadMemoryFromTrips(
    completed,
    getPrivacyZones(localSettings.get())
  );
  if (!result.changed || !result.changedCandidates?.length || rescore === false) return result;

  // A candidate that just became inactive or conflicted can change historical
  // scores just as much as one that became active, so rescore every changed
  // corridor rather than filtering only by its new state.
  const scoreRelevantCandidates = result.changedCandidates.filter(Boolean);
  if (scoreRelevantCandidates.length) {
    void import('@/lib/localSpeedScoreRefresh')
      .then(({ refreshTripsForLocalSpeedCorrections }) => (
        refreshTripsForLocalSpeedCorrections(scoreRelevantCandidates)
      ))
      .catch((error) => {
        logSystemFailure('road_memory_trip_rescore', error, {
          candidate_count: scoreRelevantCandidates.length,
        });
      });
  }
  return result;
}

export function synchronizeLocalRoadMemory(trips = [], options = {}) {
  const task = synchronizationChain
    .catch(() => null)
    .then(() => synchronize(trips, options));
  synchronizationChain = task.catch(() => null);
  return task.catch((error) => {
    logSystemFailure('road_memory_synchronization', error, {
      trip_count: Array.isArray(trips) ? trips.length : 0,
    });
    return { changed: false, changedCandidates: [], error };
  });
}

export function backfillLocalRoadMemoryFromTripHistory({
  batchSize = 80,
  maxTrips = 800,
  loadBatch = null,
} = {}) {
  if (historyBackfillPromise) return historyBackfillPromise;

  historyBackfillPromise = (async () => {
    const safeBatchSize = Math.max(1, Math.min(200, Math.floor(Number(batchSize) || 80)));
    const safeMaxTrips = Math.max(safeBatchSize, Math.floor(Number(maxTrips) || 800));
    const loader = loadBatch || (async (options) => {
      const { localTripRepository } = await import('@/lib/localTripRepository');
      return localTripRepository.listForSpeedMap(options);
    });
    const trips = [];
    let offset = 0;
    let totalAvailable = 0;

    while (offset < safeMaxTrips) {
      const result = await loader({
        sort: '-start_time',
        offset,
        limit: Math.min(safeBatchSize, safeMaxTrips - offset),
      });
      const batch = Array.isArray(result?.trips) ? result.trips : [];
      totalAvailable = Math.max(totalAvailable, Number(result?.totalAvailable) || 0);
      trips.push(...batch);
      const nextOffset = Math.max(offset + batch.length, Number(result?.nextOffset) || 0);
      if (!batch.length || nextOffset <= offset || nextOffset >= totalAvailable) break;
      offset = nextOffset;
    }

    if (!trips.length) {
      return {
        changed: false,
        processedTripCount: 0,
        observationCount: 0,
        scannedTripCount: 0,
        totalAvailable,
        truncated: totalAvailable > safeMaxTrips,
        changedCandidates: [],
      };
    }

    // Share the same chain as live trip completion. Otherwise a history import
    // can race a newly completed trip and the two whole-model writes can clobber
    // one another.
    const result = await synchronizeLocalRoadMemory(trips, { rescore: true });
    return {
      ...result,
      scannedTripCount: trips.length,
      totalAvailable: Math.max(totalAvailable, trips.length),
      truncated: totalAvailable > trips.length,
    };
  })().finally(() => {
    historyBackfillPromise = null;
  });

  return historyBackfillPromise;
}
