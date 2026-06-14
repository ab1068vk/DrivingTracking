import { tripService } from '@/api/trips';
import { buildOpenSourceTripContextPatch } from '@/lib/openSourceTripContext';
import { getJson, setJson } from '@/lib/mobileStorage';
import { localSettings } from '@/lib/trackingStore';
import { recordSystemEvent } from '@/lib/systemLog';

const ROAD_CONTEXT_QUEUE_KEY = 'drivesense_pending_road_context_v1';
const activeJobs = new Map();

async function readQueue() {
  const queue = await getJson(ROAD_CONTEXT_QUEUE_KEY, []);
  return Array.isArray(queue) ? queue : [];
}

async function rememberTrip(tripId) {
  const queue = await readQueue();
  const id = String(tripId);
  if (queue.some((entry) => String(entry.tripId) === id)) return;
  await setJson(ROAD_CONTEXT_QUEUE_KEY, [
    ...queue,
    { tripId: id, queuedAt: new Date().toISOString() },
  ]);
}

async function forgetTrip(tripId) {
  const id = String(tripId);
  const queue = await readQueue();
  await setJson(ROAD_CONTEXT_QUEUE_KEY, queue.filter((entry) => String(entry.tripId) !== id));
}

export async function runRoadContextRefresh(trip, settings = localSettings.get(), options = {}) {
  if (!trip?.id) throw new Error('Trip not loaded');
  const tripId = String(trip.id);
  if (activeJobs.has(tripId)) return activeJobs.get(tripId);

  const job = (async () => {
    await rememberTrip(tripId);
    recordSystemEvent('road_context_job_queued', { trip_id: tripId }, { category: 'road_context' });
    const patch = await buildOpenSourceTripContextPatch(trip, settings, {
      ...options,
      immediateRequests: options.immediateRequests !== false,
    });
    const updatedTrip = await tripService.update(tripId, patch);
    await forgetTrip(tripId);
    recordSystemEvent('road_context_job_completed', { trip_id: tripId }, { category: 'road_context' });
    return updatedTrip;
  })().finally(() => activeJobs.delete(tripId));

  activeJobs.set(tripId, job);
  return job;
}

export async function resumePendingRoadContextJobs() {
  const queue = await readQueue();
  for (const entry of queue) {
    try {
      const trip = await tripService.getById(entry.tripId);
      await runRoadContextRefresh(trip, localSettings.get());
    } catch (error) {
      recordSystemEvent('road_context_job_resume_failed', {
        trip_id: String(entry.tripId),
        error: error?.message || 'Road-context recovery failed',
      }, { category: 'road_context', severity: 'warn' });
    }
  }
}

export const ROAD_CONTEXT_QUEUE_STORAGE_KEY = ROAD_CONTEXT_QUEUE_KEY;
