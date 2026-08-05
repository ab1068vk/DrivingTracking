import { tripService } from '@/api/trips';
import {
  buildOpenSourceTripContextPatch,
  buildWeatherOnlyTripContextPatch,
} from '@/lib/openSourceTripContext';
import { getJson, setJson } from '@/lib/mobileStorage';
import { localSettings } from '@/lib/trackingStore';
import { recordSystemEvent } from '@/lib/systemLog';

const ROAD_CONTEXT_QUEUE_KEY = 'drivesense_pending_road_context_v1';
const activeJobs = new Map();

// A queued job only left the queue on success, and resume runs on every app foreground, so a
// trip that can never succeed re-hit the network forever. Bound both the rate and the total.
export const ROAD_CONTEXT_MAX_ATTEMPTS = 5;
const ROAD_CONTEXT_BACKOFF_BASE_MS = 60_000;
const ROAD_CONTEXT_BACKOFF_MAX_MS = 6 * 60 * 60_000;

const backoffDelayMs = (attempts) => Math.min(
  ROAD_CONTEXT_BACKOFF_MAX_MS,
  ROAD_CONTEXT_BACKOFF_BASE_MS * (2 ** Math.max(0, attempts - 1))
);

const isEntryDue = (entry, now = Date.now()) => {
  const attempts = Number(entry?.attempts) || 0;
  if (!attempts) return true;
  const lastAttemptMs = Date.parse(entry?.lastAttemptAt || '');
  if (!Number.isFinite(lastAttemptMs)) return true;
  return now - lastAttemptMs >= backoffDelayMs(attempts);
};

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
    { tripId: id, queuedAt: new Date().toISOString(), attempts: 0, lastAttemptAt: null },
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
    const roadOnlySettings = {
      ...settings,
      // Defense in depth: Get Road Data is never authorized to request weather.
      weather_context_enabled: false,
    };
    const patch = await buildOpenSourceTripContextPatch(trip, roadOnlySettings, {
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

export async function runWeatherContextRefresh(trip, settings = localSettings.get(), options = {}) {
  if (!trip?.id) throw new Error('Trip not loaded');
  const tripId = String(trip.id);
  const jobKey = `weather:${tripId}`;
  if (activeJobs.has(jobKey)) return activeJobs.get(jobKey);

  const job = (async () => {
    recordSystemEvent('weather_context_job_started', { trip_id: tripId }, { category: 'weather' });
    const patch = await buildWeatherOnlyTripContextPatch(trip, settings, {
      ...options,
      immediateRequests: options.immediateRequests !== false,
    });
    const updatedTrip = await tripService.update(tripId, patch);
    recordSystemEvent('weather_context_job_completed', { trip_id: tripId }, { category: 'weather' });
    return updatedTrip;
  })().finally(() => activeJobs.delete(jobKey));

  activeJobs.set(jobKey, job);
  return job;
}

async function recordFailedAttempt(tripId) {
  const id = String(tripId);
  const queue = await readQueue();
  const next = [];
  let exhausted = false;
  queue.forEach((entry) => {
    if (String(entry.tripId) !== id) {
      next.push(entry);
      return;
    }
    const attempts = (Number(entry.attempts) || 0) + 1;
    if (attempts >= ROAD_CONTEXT_MAX_ATTEMPTS) {
      exhausted = true;
      return;
    }
    next.push({ ...entry, attempts, lastAttemptAt: new Date().toISOString() });
  });
  await setJson(ROAD_CONTEXT_QUEUE_KEY, next);
  return exhausted;
}

export async function resumePendingRoadContextJobs() {
  const queue = await readQueue();
  const now = Date.now();
  for (const entry of queue) {
    if (!isEntryDue(entry, now)) continue;
    try {
      const trip = await tripService.getById(entry.tripId);
      await runRoadContextRefresh(trip, localSettings.get());
    } catch (error) {
      const exhausted = await recordFailedAttempt(entry.tripId);
      recordSystemEvent(exhausted ? 'road_context_job_abandoned' : 'road_context_job_resume_failed', {
        trip_id: String(entry.tripId),
        error: error?.message || 'Road-context recovery failed',
      }, { category: 'road_context', severity: 'warn' });
    }
  }
}

export const ROAD_CONTEXT_QUEUE_STORAGE_KEY = ROAD_CONTEXT_QUEUE_KEY;
