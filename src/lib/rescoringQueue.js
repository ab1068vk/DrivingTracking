import { getJson, setJson } from '@/lib/mobileStorage';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const RESCORING_QUEUE_KEY = 'drivesense_rescoring_queue_v1';
export const PRIVACY_RESCORING_REASONS = new Set([
  'privacy_zone_added',
  'privacy_zone_updated',
  'privacy_zone_deleted',
  'privacy_zone_purged',
]);

const CHUNK = 20;
let scheduled = false;
let running = false;
let activeWorker = null;

const emitProgress = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RESCORE_PROGRESS_EVENT, { detail }));
};

const generateJobId = () => (
  `rescore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
);

const uniqueIds = (tripIds = []) => (
  Array.from(new Set((Array.isArray(tripIds) ? tripIds : [])
    .filter((id) => id != null && String(id).trim())
    .map((id) => String(id))))
);

export const isPrivacyRescoreReason = (reason) => PRIVACY_RESCORING_REASONS.has(reason);

export async function getRescoringQueue() {
  const queue = await getJson(RESCORING_QUEUE_KEY, []);
  return Array.isArray(queue) ? queue : [];
}

async function saveRescoringQueue(queue) {
  await setJson(RESCORING_QUEUE_KEY, queue);
}

function scheduleWorker(worker) {
  if (worker) activeWorker = worker;
  if (scheduled || running || !activeWorker?.rescoreTrip) return;
  scheduled = true;

  const run = () => {
    scheduled = false;
    void processRescoringQueue(activeWorker);
  };

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 30_000 });
    return;
  }
  setTimeout(run, 100);
}

export async function enqueueRescoreJob({ reason = 'manual', zoneId = null, tripIds = [] } = {}, worker) {
  const affectedTripIds = uniqueIds(tripIds);
  if (!affectedTripIds.length) {
    emitProgress({ status: 'complete', reason, zoneId, completed: 0, total: 0 });
    return null;
  }

  const job = {
    id: generateJobId(),
    reason,
    zoneId,
    tripIds: affectedTripIds,
    remainingTripIds: affectedTripIds,
    total: affectedTripIds.length,
    completed: 0,
    status: 'pending',
    enqueuedAt: Date.now(),
  };
  const queue = await getRescoringQueue();
  queue.push(job);
  await saveRescoringQueue(queue);
  emitProgress({ ...job, progress: job.completed });
  recordSystemEvent('rescore_job_enqueued', {
    job_id: job.id,
    reason,
    zone_id: zoneId,
    trip_count: job.total,
  }, { category: 'scoring', title: 'Trip re-score queued' });
  scheduleWorker(worker);
  return job;
}

export async function processRescoringQueue(worker = activeWorker) {
  if (running || !worker?.rescoreTrip) return null;
  running = true;
  activeWorker = worker;
  let shouldContinue = false;

  try {
    const queue = await getRescoringQueue();
    const job = queue.find((item) => item?.status === 'pending' || item?.status === 'running');
    if (!job) return null;

    job.status = 'running';
    job.remainingTripIds = uniqueIds(job.remainingTripIds?.length ? job.remainingTripIds : job.tripIds.slice(job.completed || 0));
    job.completed = Number(job.completed) || 0;
    job.startedAt = job.startedAt || Date.now();
    await saveRescoringQueue(queue);
    emitProgress({ ...job, progress: job.completed });

    const batch = job.remainingTripIds.splice(0, CHUNK);
    for (const tripId of batch) {
      try {
        await worker.rescoreTrip(tripId, job);
        job.completed += 1;
      } catch (error) {
        job.failed = (Number(job.failed) || 0) + 1;
        logSystemFailure('rescore_job_trip_failed', error, {
          job_id: job.id,
          trip_id: tripId,
          reason: job.reason,
        });
      }
      emitProgress({ ...job, progress: job.completed });
    }

    job.status = job.remainingTripIds.length ? 'pending' : 'complete';
    if (job.status === 'complete') job.completedAt = Date.now();
    shouldContinue = job.status === 'pending';
    await saveRescoringQueue(queue);
    emitProgress({ ...job, progress: job.completed });

    return job;
  } finally {
    running = false;
    if (shouldContinue) scheduleWorker(worker);
  }
}

export function scheduleRescoringQueue(worker) {
  scheduleWorker(worker);
}
