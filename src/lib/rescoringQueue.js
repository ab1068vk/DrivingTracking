import { getJson, setJson } from '@/lib/mobileStorage';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { readSpeedKnowledgeMetadata } from '@/lib/speedKnowledgeRepository';

export const RESCORING_QUEUE_KEY = 'drivesense_rescoring_queue_v1';
export const PRIVACY_RESCORING_REASONS = new Set([
  'privacy_zone_added',
  'privacy_zone_updated',
  'privacy_zone_deleted',
  'privacy_zone_purged',
]);

const CHUNK = 20;
const MAX_ATTEMPTS_PER_TRIP = 3;
let scheduled = false;
let running = false;
let activeWorker = null;
let scheduledRunId = 0;
const jobWorkers = new Map();
let queueOperationChain = Promise.resolve();

const RESCORING_QUEUE_LOCK_NAME = 'drivesense:rescoring_queue_v1';

const runInRealmQueueOperation = (operation) => {
  const task = queueOperationChain
    .catch(() => null)
    .then(operation);
  queueOperationChain = task.catch(() => null);
  return task;
};

const runQueueOperation = (operation) => {
  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    // Exported operations call only their *Unlocked implementation, so the
    // same non-reentrant Web Lock is never requested recursively.
    return navigator.locks.request(
      RESCORING_QUEUE_LOCK_NAME,
      { mode: 'exclusive' },
      operation
    );
  }
  return runInRealmQueueOperation(operation);
};

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

const optionalFiniteNumber = (value) => {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Number(value);
};

export const isPrivacyRescoreReason = (reason) => PRIVACY_RESCORING_REASONS.has(reason);

export async function getRescoringQueue() {
  const queue = await getJson(RESCORING_QUEUE_KEY, []);
  return Array.isArray(queue) ? queue : [];
}

export async function getRescoringQueueStatus({ reasonPrefix = '', knowledgeRevisionOnly = false } = {}) {
  const queue = await getRescoringQueue();
  const matching = queue.filter((job) => (
    (!reasonPrefix || String(job?.reason || '').startsWith(reasonPrefix)) &&
    (!knowledgeRevisionOnly || Number.isFinite(Number(job?.knowledgeRevision)))
  ));
  const active = matching.filter((job) => job?.status === 'pending' || job?.status === 'running');
  const latest = [...matching].sort((a, b) => (
    Number(b?.completedAt || b?.startedAt || b?.enqueuedAt || 0) -
    Number(a?.completedAt || a?.startedAt || a?.enqueuedAt || 0)
  ))[0] || null;
  return {
    activeJobs: active.length,
    pendingTrips: active.reduce((sum, job) => sum + uniqueIds(job?.remainingTripIds).length, 0),
    completedTrips: active.reduce((sum, job) => sum + (Number(job?.completed) || 0), 0),
    totalTrips: active.reduce((sum, job) => sum + (Number(job?.total) || 0), 0),
    failedTrips: matching.reduce((sum, job) => sum + uniqueIds(job?.failedTripIds).length, 0),
    latest,
  };
}

async function saveRescoringQueue(queue) {
  await setJson(RESCORING_QUEUE_KEY, queue);
}

function scheduleWorker(worker) {
  if (worker?.rescoreTrip) activeWorker = worker;
  if (scheduled || running || !activeWorker?.rescoreTrip) return;
  scheduled = true;
  const runId = ++scheduledRunId;

  const run = () => {
    if (runId !== scheduledRunId) return;
    scheduled = false;
    void processRescoringQueue();
  };

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(run, { timeout: 30_000 });
    return;
  }
  setTimeout(run, 100);
}

async function enqueueRescoreJobUnlocked({
  reason = 'manual',
  zoneId = null,
  tripIds = [],
  knowledgeRevision = null,
  knowledgeSchemaVersion = null,
} = {}, worker) {
  const affectedTripIds = uniqueIds(tripIds);
  const revisionRelevant = String(reason).startsWith('speed_knowledge') || isPrivacyRescoreReason(reason);
  let resolvedKnowledgeRevision = optionalFiniteNumber(knowledgeRevision);
  let resolvedKnowledgeSchemaVersion = optionalFiniteNumber(knowledgeSchemaVersion);
  if (
    revisionRelevant &&
    (!Number.isFinite(resolvedKnowledgeRevision) || !Number.isFinite(resolvedKnowledgeSchemaVersion))
  ) {
    const metadata = await readSpeedKnowledgeMetadata().catch(() => null);
    if (!Number.isFinite(resolvedKnowledgeRevision)) {
      resolvedKnowledgeRevision = optionalFiniteNumber(metadata?.knowledgeRevision);
    }
    if (!Number.isFinite(resolvedKnowledgeSchemaVersion)) {
      resolvedKnowledgeSchemaVersion = optionalFiniteNumber(metadata?.schemaVersion);
    }
  }

  const queue = await getRescoringQueue();
  const sameRevisionJob = Number.isFinite(resolvedKnowledgeRevision)
    ? queue.find((item) => (
      (item?.status === 'pending' || item?.status === 'running') &&
      Number(item?.knowledgeRevision) === resolvedKnowledgeRevision &&
      (
        (String(reason).startsWith('speed_knowledge') && String(item?.reason || '').startsWith('speed_knowledge')) ||
        (isPrivacyRescoreReason(reason) && isPrivacyRescoreReason(item?.reason) && String(item?.zoneId || '') === String(zoneId || ''))
      )
    ))
    : null;
  if (sameRevisionJob) {
    const alreadyQueued = new Set(uniqueIds(sameRevisionJob.tripIds));
    const additions = affectedTripIds.filter((id) => !alreadyQueued.has(id));
    sameRevisionJob.tripIds = uniqueIds([...(sameRevisionJob.tripIds || []), ...additions]);
    sameRevisionJob.remainingTripIds = uniqueIds([
      ...(sameRevisionJob.remainingTripIds || []),
      ...additions,
    ]);
    sameRevisionJob.total = sameRevisionJob.tripIds.length;
    await saveRescoringQueue(queue);
    if (worker?.rescoreTrip) jobWorkers.set(sameRevisionJob.id, worker);
    emitProgress({ ...sameRevisionJob, progress: sameRevisionJob.completed });
    scheduleWorker(worker);
    return sameRevisionJob;
  }

  const job = {
    id: generateJobId(),
    reason,
    zoneId,
    tripIds: affectedTripIds,
    remainingTripIds: affectedTripIds,
    total: affectedTripIds.length,
    completed: 0,
    failedTripIds: [],
    attemptCounts: {},
    status: 'pending',
    enqueuedAt: Date.now(),
    ...(Number.isFinite(resolvedKnowledgeRevision) ? {
      knowledgeRevision: Math.max(0, Math.floor(resolvedKnowledgeRevision)),
      targetKnowledgeRevision: Math.max(0, Math.floor(resolvedKnowledgeRevision)),
    } : {}),
    ...(Number.isFinite(resolvedKnowledgeSchemaVersion) ? {
      knowledgeSchemaVersion: Math.max(0, Math.floor(resolvedKnowledgeSchemaVersion)),
    } : {}),
  };
  if (!affectedTripIds.length) {
    job.status = 'complete';
    job.completedAt = Date.now();
    queue.push(job);
    await saveRescoringQueue(queue.slice(-100));
    emitProgress({ ...job, progress: 0 });
    return job;
  }
  queue.push(job);
  await saveRescoringQueue(queue);
  if (worker?.rescoreTrip) jobWorkers.set(job.id, worker);
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

export function enqueueRescoreJob(options = {}, worker) {
  return runQueueOperation(() => enqueueRescoreJobUnlocked(options, worker));
}

async function processRescoringQueueUnlocked(worker = null) {
  if (running) return null;
  // Manual processing supersedes an already scheduled callback. The old
  // callback is harmless when it eventually fires because its token is stale.
  if (scheduled) {
    scheduled = false;
    scheduledRunId += 1;
  }
  if (worker?.rescoreTrip) activeWorker = worker;
  running = true;
  let currentJobPending = false;
  let hasMoreWork = false;
  let currentWorker = null;
  let currentJobId = null;

  try {
    const queue = await getRescoringQueue();
    const job = queue.find((item) => item?.status === 'pending' || item?.status === 'running');
    if (!job) return null;
    currentJobId = job.id;
    currentWorker = jobWorkers.get(job.id) || worker || activeWorker;
    if (!currentWorker?.rescoreTrip) return null;

    job.status = 'running';
    job.remainingTripIds = uniqueIds(job.remainingTripIds?.length ? job.remainingTripIds : job.tripIds.slice(job.completed || 0));
    job.completed = Number(job.completed) || 0;
    job.startedAt = job.startedAt || Date.now();
    await saveRescoringQueue(queue);
    emitProgress({ ...job, progress: job.completed });

    job.attemptCounts = job.attemptCounts && typeof job.attemptCounts === 'object'
      ? job.attemptCounts
      : {};
    job.failedTripIds = uniqueIds(job.failedTripIds);
    const batch = job.remainingTripIds.splice(0, CHUNK);
    for (const tripId of batch) {
      try {
        await currentWorker.rescoreTrip(tripId, job);
        job.completed += 1;
        delete job.attemptCounts[tripId];
      } catch (error) {
        const attempts = (Number(job.attemptCounts[tripId]) || 0) + 1;
        job.attemptCounts[tripId] = attempts;
        if (attempts < MAX_ATTEMPTS_PER_TRIP) {
          job.remainingTripIds.push(tripId);
        } else {
          job.failedTripIds = uniqueIds([...job.failedTripIds, tripId]);
        }
        logSystemFailure('rescore_job_trip_failed', error, {
          job_id: job.id,
          trip_id: tripId,
          reason: job.reason,
          attempt: attempts,
        });
      }
      emitProgress({ ...job, progress: job.completed });
    }

    job.failed = job.failedTripIds.length;
    job.status = job.remainingTripIds.length
      ? 'pending'
      : job.failedTripIds.length
        ? 'complete_with_failures'
        : 'complete';
    if (job.status !== 'pending') job.completedAt = Date.now();
    currentJobPending = job.status === 'pending';
    if (!currentJobPending) jobWorkers.delete(job.id);
    hasMoreWork = queue.some((item) => (
      item?.status === 'pending' || item?.status === 'running'
    ));
    await saveRescoringQueue(queue);
    emitProgress({ ...job, progress: job.completed });

    return job;
  } finally {
    running = false;
    if (currentJobPending) {
      // Finish every batch of the current job with the same worker contract.
      scheduleWorker(currentWorker);
    } else if (hasMoreWork) {
      scheduleWorker(activeWorker || currentWorker);
    } else if (currentJobId) {
      jobWorkers.delete(currentJobId);
    }
  }
}

export function processRescoringQueue(worker = null) {
  return runQueueOperation(() => processRescoringQueueUnlocked(worker));
}

export function scheduleRescoringQueue(worker) {
  scheduleWorker(worker);
}
