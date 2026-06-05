import { hasRouteRiskIndex, saveRouteRiskIndex } from '@/lib/routeRisk/storage';
import { buildRouteRiskIndexFromTrips } from '@/lib/routeRisk/aggregate';

const runInlineRebuild = async ({ trips, privacyZones, onProgress }) => {
  onProgress?.({ status: 'running', completed: 0, total: trips.length });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const index = buildRouteRiskIndexFromTrips(trips, privacyZones);
  await saveRouteRiskIndex(index);
  onProgress?.({ status: 'complete', completed: trips.length, total: trips.length });
  return index;
};

const runWorkerRebuild = ({ trips, privacyZones, onProgress }) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./routeRiskRebuild.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = async (event) => {
    const detail = event.data || {};
    if (detail.status === 'running') {
      onProgress?.(detail);
      return;
    }
    if (detail.status === 'complete') {
      const index = new Map(detail.entries || []);
      Object.defineProperty(index, 'metadata', {
        value: detail.metadata || {},
        enumerable: false,
        configurable: true,
      });
      await saveRouteRiskIndex(index);
      onProgress?.(detail);
      worker.terminate();
      resolve(index);
    }
    if (detail.status === 'error') {
      worker.terminate();
      reject(new Error(detail.message || 'Route risk index rebuild failed'));
    }
  };
  worker.onerror = (error) => {
    worker.terminate();
    reject(error);
  };
  worker.postMessage({ trips, privacyZones });
});

export async function ensureRouteRiskIndexMigration({
  trips = [],
  privacyZones = [],
  onProgress,
} = {}) {
  if (await hasRouteRiskIndex()) return { started: false };
  const completedTrips = (trips || []).filter((trip) => trip?.status === 'completed');
  if (!completedTrips.length) {
    await saveRouteRiskIndex(new Map());
    return { started: false };
  }

  const canUseWorker = typeof Worker !== 'undefined' && typeof URL !== 'undefined';
  const index = canUseWorker
    ? await runWorkerRebuild({ trips: completedTrips, privacyZones, onProgress })
    : await runInlineRebuild({ trips: completedTrips, privacyZones, onProgress });
  return { started: true, index };
}
