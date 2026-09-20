import { localSettings } from '@/lib/trackingStore';
import { logSystemFailure } from '@/lib/systemLog';

let synchronizationChain = Promise.resolve();
let historyBackfillPromise = null;

async function synchronize(trips = [], { rescore = true, force = false } = {}) {
  const completed = (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed' && Array.isArray(trip?.route_points));
  if (!completed.length) return { changed: false, changedCandidates: [] };

  const settings = localSettings.get();
  if (!force && settings?.road_memory_learning_enabled === false) {
    return { changed: false, changedCandidates: [], skipped: 'learning_disabled' };
  }
  // Canonical commit/import already wrote exact P6 desired rows in its owner
  // transaction. J1/J2 consume those rows; replaying the payload here would
  // restore the retired whole-model learner and double-apply evidence.
  return {
    changed: false,
    changedCandidates: [],
    delegated: 'p6RoadMemoryUpdates',
    queuedTripCount: completed.length,
    rescoreRequested: rescore === true,
  };
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
  signal = null,
  onProgress = null,
} = {}) {
  if (historyBackfillPromise) return historyBackfillPromise;

  historyBackfillPromise = (async () => {
    const [{
      startKnownP6ExplicitOperation,
      runKnownP6ExplicitOperationTurn,
      cancelP6ExplicitOperation,
      resumeP6ExplicitOperation,
    }, {
      P6_EXPLICIT_OPERATION_STATES,
      P6_EXPLICIT_OPERATION_TYPES,
    }, speedStore] = await Promise.all([
      import('@/lib/p6ExplicitOperations'),
      import('@/lib/p6Contracts'),
      import('@/lib/speedKnowledgeRepository'),
    ]);
    const terminal = new Set([
      P6_EXPLICIT_OPERATION_STATES.COMPLETED,
      P6_EXPLICIT_OPERATION_STATES.CANCELLED,
      P6_EXPLICIT_OPERATION_STATES.FAILED,
    ]);
    const runToPause = async (type) => {
      let operation = await startKnownP6ExplicitOperation(type);
      if ([P6_EXPLICIT_OPERATION_STATES.PAUSED_AFTER_RESTART,
        P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN].includes(operation.state)) {
        operation = await resumeP6ExplicitOperation(operation.operationId);
      }
      while (!terminal.has(operation.state)) {
        if (signal?.aborted) await cancelP6ExplicitOperation(operation.operationId);
        operation = await runKnownP6ExplicitOperationTurn(operation.operationId);
        onProgress?.(operation);
        if ([P6_EXPLICIT_OPERATION_STATES.PAUSED_HIDDEN,
          P6_EXPLICIT_OPERATION_STATES.WAITING_FOR_OWNER].includes(operation.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (operation.state === P6_EXPLICIT_OPERATION_STATES.FAILED) {
        const error = new Error(operation.failure?.message || 'P6 explicit operation failed');
        error.code = operation.failure?.code || 'P6_EXPLICIT_OPERATION_FAILED';
        throw error;
      }
      return operation;
    };
    // Run the browser cutover whenever the browser owns saved speeds. This was
    // `!isAndroid()`, which skipped E4 on the platform the product ships on, so
    // retained-history learning then ran against a v1 authority and every
    // subject came back CONVERSION_REQUIRED having learned nothing.
    if (!speedStore.isNativeSpeedAuthoritySelected() && !await speedStore.isP6BrowserSpeedV2Authority()) {
      const migration = await runToPause(P6_EXPLICIT_OPERATION_TYPES.BROWSER_SPEED_MIGRATION);
      if (migration.state !== P6_EXPLICIT_OPERATION_STATES.COMPLETED) return {
        changed: false, state: migration.state, operation: migration,
        scannedTripCount: 0, processedTripCount: 0, observationCount: 0,
      };
    }
    const result = await runToPause(P6_EXPLICIT_OPERATION_TYPES.RETAINED_HISTORY_LEARNING);
    return {
      changed: result.state === P6_EXPLICIT_OPERATION_STATES.COMPLETED,
      state: result.state,
      operation: result,
      scannedTripCount: Number(result.progress?.itemsWorked) || 0,
      processedTripCount: Number(result.progress?.itemsWorked) || 0,
      observationCount: 0,
      totalAvailable: null,
      truncated: result.state !== P6_EXPLICIT_OPERATION_STATES.COMPLETED,
      changedCandidates: [],
    };
  })().finally(() => {
    historyBackfillPromise = null;
  });

  return historyBackfillPromise;
}
