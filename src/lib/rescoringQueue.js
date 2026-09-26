import { getJson, setJson } from '@/lib/mobileStorage';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { readSpeedKnowledgeMetadata } from '@/lib/speedKnowledgeRepository';
import {
  MONOLITHIC_DOCUMENT_OWNER,
  compatibilityWake,
} from '@/lib/monolithicCompatibility';

/** The pre-P4-C-F06 monolithic queue document. v1 only; never read by a turn. */
export const RESCORING_QUEUE_KEY = 'drivesense_rescoring_queue_v1';
export const PRIVACY_RESCORING_REASONS = new Set([
  'privacy_zone_added',
  'privacy_zone_updated',
  'privacy_zone_deleted',
  'privacy_zone_purged',
]);

const CHUNK = 20;
const MAX_ATTEMPTS_PER_TRIP = 3;

/**
 * P4-C-F06-B/C/D — the queue index is bounded, not one growing document.
 *
 * `drivesense_rescoring_queue_v1` held every job ever enqueued as a single JSON
 * array, and a bounded turn read it twice and rewrote it whole. The job index is
 * now: fixed scalar metadata (`head`/`tail`/`headOffset`/`count`) plus an O(1)
 * `activeId` head pointer, fixed-size pages of job *descriptors* (ids), and one
 * O(1) record per job. A turn reads the metadata, at most one job record and one
 * page of that job's trip ids.
 *
 * Per-trip retry metadata used to live in an unbounded `attemptCounts` map on
 * the job. An attempt count now travels with the queued id itself inside the
 * job's own bounded page, so retained retry state is bounded by what is still
 * queued while `MAX_ATTEMPTS_PER_TRIP` semantics are unchanged.
 *
 * Completed jobs are retained in a bounded recent ring for reporting instead of
 * accumulating in the index.
 *
 * The Web Lock, dedupe, per-trip attempt ceiling and every progress event are
 * unchanged - only where the rows live and who is allowed to read them.
 */
export const RESCORING_JOB_PAGE_SIZE = 100;
export const RESCORING_QUEUE_PAGE_SIZE = 25;
const RESCORING_PAGE_PREFIX = 'drivesense_rescoring_job_page_v2_';
const RESCORING_IDS_PREFIX = 'drivesense_rescoring_job_ids_v2_';
const RESCORING_QUEUE_META_KEY = 'drivesense_rescoring_queue_meta_v2';
const RESCORING_QUEUE_PAGE_PREFIX = 'drivesense_rescoring_queue_page_v2_';
const RESCORING_JOB_RECORD_PREFIX = 'drivesense_rescoring_job_record_v2_';
const RESCORING_DEDUPE_PREFIX = 'drivesense_rescoring_dedupe_v2_';
const RESCORING_RECENT_KEY = 'drivesense_rescoring_recent_v2';
const RESCORING_CONVERSION_KEY = 'drivesense_rescoring_conversion_v2';
/** One durable conversion checkpoint per legacy job id. */
const RESCORING_CONVERT_PREFIX = 'drivesense_rescoring_convert_v2_';

/**
 * P4-C-F06 — publication phases for one legacy job.
 *
 * Everything before `PUBLISHED` is *staging*: durable, deterministic, and
 * invisible to ordinary queue consumption. The queued descriptor is the
 * authority switch, so a job record on its own never means "converted".
 */
export const RESCORING_CONVERSION_PHASES = Object.freeze({
  STAGING_IDS: 'staging_ids',
  STAGING_JOB: 'staging_job',
  STAGING_DEDUPE: 'staging_dedupe',
  READY_TO_PUBLISH: 'ready_to_publish',
  PUBLISHED: 'published',
});
/** A bounded failure sample; `failed` is the authoritative count. */
const MAX_RETAINED_FAILED_IDS = 100;
/** A bounded completed-job sample for reporting; never read by a turn. */
const MAX_RETAINED_RECENT_JOBS = 25;
/** How many index records one turn may skip past before it reports no work. */
const RESCORING_INDEX_PROBES = 8;
/**
 * P4-C-F09. The most logical units one rescoring turn can examine: one CHUNK of
 * trip ids plus the job descriptors it had to skip past to find them.
 */
export const RESCORING_TURN_MAX_EXAMINED = CHUNK + (RESCORING_INDEX_PROBES * 2);

const jobPageKey = (jobId, index) => `${RESCORING_PAGE_PREFIX}${jobId}_${index}`;
const jobIdsKey = (jobId) => `${RESCORING_IDS_PREFIX}${jobId}`;
const queuePageKey = (index) => `${RESCORING_QUEUE_PAGE_PREFIX}${index}`;
const jobRecordKey = (jobId) => `${RESCORING_JOB_RECORD_PREFIX}${jobId}`;
const dedupeRecordKey = (identity) => `${RESCORING_DEDUPE_PREFIX}${identity}`;
const conversionRecordKey = (jobId) => `${RESCORING_CONVERT_PREFIX}${jobId}`;

const readJobPage = async (jobId, index) => {
  const page = await getJson(jobPageKey(jobId, index), []);
  return Array.isArray(page) ? page : [];
};

const writeJobPage = (jobId, index, ids) => setJson(jobPageKey(jobId, index), ids.length ? ids : null);

const readJobIds = async (jobId) => {
  const ids = await getJson(jobIdsKey(jobId), []);
  return Array.isArray(ids) ? ids : [];
};

const emptyPages = () => ({ head: 0, tail: 0, headOffset: 0 });

/**
 * P4-C-F06-C. A queued id is either a bare id (never attempted) or an
 * `{ id, attempts }` pair. Retry state therefore lives with the queued row and
 * is released with it, instead of in a per-job map that only ever grew.
 */
const normalizeQueuedId = (entry) => (
  entry && typeof entry === 'object'
    ? { id: String(entry.id), attempts: Math.max(0, Number(entry.attempts) || 0) }
    : { id: String(entry), attempts: 0 }
);

const storableQueuedId = (entry) => {
  const normalized = normalizeQueuedId(entry);
  return normalized.attempts > 0 ? normalized : normalized.id;
};

/** Append ids to a job's tail page, opening new pages as each one fills. */
const appendJobIds = async (job, ids) => {
  if (!ids.length) return;
  const pages = { ...(job.pages || emptyPages()) };
  let tail = pages.tail;
  let page = await readJobPage(job.id, tail);
  for (const id of ids) {
    if (page.length >= RESCORING_JOB_PAGE_SIZE) {
      await writeJobPage(job.id, tail, page);
      tail += 1;
      page = [];
    }
    page.push(storableQueuedId(id));
  }
  await writeJobPage(job.id, tail, page);
  job.pages = { ...pages, tail };
  job.pending = Math.max(0, Number(job.pending) || 0) + ids.length;
};

/**
 * Take up to `count` queued ids from the head of a job's pages. Reads and
 * rewrites one page, never the whole id set.
 */
const takeJobIds = async (job, count) => {
  const pages = { ...(job.pages || emptyPages()) };
  const taken = [];
  let guard = 0;
  while (taken.length < count && pages.head <= pages.tail && guard < 8) {
    const page = await readJobPage(job.id, pages.head);
    const slice = page.slice(pages.headOffset, pages.headOffset + (count - taken.length));
    taken.push(...slice.map(normalizeQueuedId));
    pages.headOffset += slice.length;
    if (pages.headOffset >= page.length) {
      if (pages.head < pages.tail) {
        await setJson(jobPageKey(job.id, pages.head), null);
        pages.head += 1;
        pages.headOffset = 0;
      } else {
        break;
      }
    }
    guard += 1;
  }
  job.pages = pages;
  job.pending = Math.max(0, (Number(job.pending) || 0) - taken.length);
  return taken;
};

/**
 * P4-C-F06 — write a job's id pages at *deterministic* positions.
 *
 * `appendJobIds` is position-dependent: replaying it after a crash appends the
 * same ids a second time. Conversion instead derives page `i` from source slice
 * `[i*size, (i+1)*size)`, so repeating a partially-completed staging pass
 * rewrites byte-identical pages and can neither duplicate nor drop an id.
 */
const stageJobIdPages = async (jobId, entries) => {
  const pageCount = Math.max(1, Math.ceil(entries.length / RESCORING_JOB_PAGE_SIZE));
  for (let index = 0; index < pageCount; index += 1) {
    const slice = entries
      .slice(index * RESCORING_JOB_PAGE_SIZE, (index + 1) * RESCORING_JOB_PAGE_SIZE)
      .map(storableQueuedId);
    await writeJobPage(jobId, index, slice);
  }
  return { head: 0, tail: pageCount - 1, headOffset: 0 };
};

/** Release a drained job's page and id records. */
const releaseJobRecords = async (job) => {
  const pages = job.pages || emptyPages();
  for (let index = pages.head; index <= pages.tail; index += 1) {
    await setJson(jobPageKey(job.id, index), null);
  }
  await setJson(jobIdsKey(job.id), null);
  job.pages = emptyPages();
  job.pending = 0;
};

// --- the bounded job index -------------------------------------------------

const emptyQueueMeta = () => ({
  version: 2, head: 0, tail: 0, headOffset: 0, count: 0, activeId: null,
});

const readQueueMeta = async () => {
  const stored = await getJson(RESCORING_QUEUE_META_KEY, null);
  if (!stored || typeof stored !== 'object') return emptyQueueMeta();
  const head = Math.max(0, Number(stored.head) || 0);
  const tail = Math.max(head, Number(stored.tail) || 0);
  return {
    version: 2,
    head,
    tail,
    headOffset: Math.max(0, Number(stored.headOffset) || 0),
    count: Math.max(0, Number(stored.count) || 0),
    activeId: stored.activeId ? String(stored.activeId) : null,
  };
};

const writeQueueMeta = (meta) => setJson(RESCORING_QUEUE_META_KEY, meta);

const readQueuePage = async (index) => {
  const page = await getJson(queuePageKey(index), []);
  return Array.isArray(page) ? page : [];
};

const readJobRecord = async (jobId) => {
  const record = await getJson(jobRecordKey(jobId), null);
  return record && typeof record === 'object' ? record : null;
};

const writeJobRecord = (job) => setJson(jobRecordKey(job.id), job);

/** Append one job descriptor to the index tail page. */
const pushQueuedJobId = async (jobId) => {
  const meta = await readQueueMeta();
  let tail = meta.tail;
  let page = await readQueuePage(tail);
  if (page.length >= RESCORING_QUEUE_PAGE_SIZE) {
    tail += 1;
    page = [];
  }
  await setJson(queuePageKey(tail), [...page, String(jobId)]);
  await writeQueueMeta({ ...meta, tail, count: meta.count + 1 });
};

/**
 * P4-C-F06 — publish a descriptor at most once.
 *
 * Conversion may replay its final step after a crash between the descriptor
 * write and its checkpoint. A converting job is always the most recently
 * published one, so checking the tail page - one O(1) read - is enough to make
 * the publication idempotent without scanning the index.
 */
const publishQueuedJobId = async (jobId) => {
  const meta = await readQueueMeta();
  const tailPage = await readQueuePage(meta.tail);
  if (tailPage.includes(String(jobId))) return false;
  await pushQueuedJobId(jobId);
  return true;
};

/** Take the next job descriptor. Reads at most one index page per probe. */
const shiftQueuedJobId = async (meta) => {
  let { head, headOffset } = meta;
  const { tail } = meta;
  let guard = 0;
  while (head <= tail && guard <= RESCORING_INDEX_PROBES) {
    const page = await readQueuePage(head);
    if (headOffset < page.length) {
      return {
        id: String(page[headOffset]),
        meta: { ...meta, head, headOffset: headOffset + 1, count: Math.max(0, meta.count - 1) },
        visited: guard + 1,
      };
    }
    if (head >= tail) break;
    await setJson(queuePageKey(head), null);
    head += 1;
    headOffset = 0;
    guard += 1;
  }
  return { id: null, meta: { ...meta, head, headOffset, count: 0 }, visited: guard + 1 };
};

/**
 * The O(1) head pointer. Reads the active job's own record, skipping past at
 * most `RESCORING_INDEX_PROBES` index entries whose job is already settled, and
 * never materializes the index.
 */
const claimActiveJob = async () => {
  let meta = await readQueueMeta();
  let visited = 0;
  for (let probe = 0; probe < RESCORING_INDEX_PROBES; probe += 1) {
    if (meta.activeId) {
      const job = await readJobRecord(meta.activeId);
      visited += 1;
      if (job && (job.status === 'pending' || job.status === 'running')) return { meta, job, visited };
      meta = { ...meta, activeId: null };
      await writeQueueMeta(meta);
    }
    const next = await shiftQueuedJobId(meta);
    visited += next.visited;
    if (!next.id) {
      await writeQueueMeta(next.meta);
      return { meta: next.meta, job: null, visited };
    }
    meta = { ...next.meta, activeId: next.id };
    await writeQueueMeta(meta);
  }
  return { meta, job: null, visited };
};

/** A bounded completed-job sample. Scalars only - never a job's id set. */
const pushRecentJob = async (job) => {
  const stored = await getJson(RESCORING_RECENT_KEY, []);
  const recent = (Array.isArray(stored) ? stored : []).filter((item) => item?.id !== job.id);
  const { pages: _pages, ...snapshot } = job;
  recent.push(snapshot);
  await setJson(RESCORING_RECENT_KEY, recent.slice(-MAX_RETAINED_RECENT_JOBS));
};

/** Retire a settled job: release its pages, its record and its dedupe marker. */
const retireJob = async (job) => {
  await releaseJobRecords(job);
  await pushRecentJob(job);
  await setJson(jobRecordKey(job.id), null);
  if (job.dedupeKey) await setJson(dedupeRecordKey(job.dedupeKey), null);
  const meta = await readQueueMeta();
  if (meta.activeId === job.id) await writeQueueMeta({ ...meta, activeId: null });
};

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

/**
 * The dedupe identity a job is registered under, so finding an existing job for
 * the same knowledge revision is one O(1) record read rather than a scan of
 * every queued job.
 */
const dedupeIdentity = (reason, zoneId, revision) => {
  if (!Number.isFinite(revision)) return null;
  const stamped = Math.max(0, Math.floor(revision));
  if (String(reason).startsWith('speed_knowledge')) return `sk_${stamped}`;
  if (isPrivacyRescoreReason(reason)) return `pz_${String(zoneId || '')}_${stamped}`;
  return null;
};

// --- P4-C-F06-D: the monolithic v1 document is an explicit session -----------

/** O(1). Never reads the legacy document itself. */
const readLegacyConversionState = async () => {
  const stored = await getJson(RESCORING_CONVERSION_KEY, null);
  if (!stored || typeof stored !== 'object') return { started: false, completed: false, converted: 0 };
  return {
    started: Boolean(stored.startedAt),
    completed: Boolean(stored.completedAt),
    converted: Math.max(0, Number(stored.converted) || 0),
  };
};

/** One legacy job's durable conversion checkpoint. O(1). */
const readConversionRecord = async (jobId) => {
  const stored = await getJson(conversionRecordKey(jobId), null);
  return stored && typeof stored === 'object' ? stored : null;
};

const writeConversionRecord = (jobId, phase, extra = {}) => setJson(
  conversionRecordKey(jobId),
  { id: String(jobId), phase, updatedAt: Date.now(), ...extra },
);

/**
 * Has this job id been published, or is it still staged?
 *
 * Only a legacy-converted job has a conversion record, so this is O(1) and
 * exact. A staged job must stay invisible to ordinary queue consumption -
 * including the enqueue-time dedupe merge, which would otherwise add trips to a
 * job nothing will ever claim.
 */
const isStagedButUnpublished = async (jobId) => {
  const record = await readConversionRecord(jobId);
  return Boolean(record) && record.phase !== RESCORING_CONVERSION_PHASES.PUBLISHED;
};

/**
 * Convert one pre-existing v1 job. Every step is idempotent, and the queued
 * descriptor is written last, so the job is either invisible or complete.
 */
const convertOneLegacyJob = async (legacyJob) => {
  const jobId = String(legacyJob.id);
  const existing = await readConversionRecord(jobId);
  if (existing?.phase === RESCORING_CONVERSION_PHASES.PUBLISHED) return false;
  // No checkpoint at all, but a live job record: this job was published by an
  // earlier session that ran to completion and then retired its checkpoints.
  // Re-staging it would reset a queue position the worker has since advanced.
  // (During a crashed session the checkpoint is still there, so this fast path
  // can never hide an unpublished job - that is the F06 publication law.)
  if (!existing && await readJobRecord(jobId)) return false;

  const job = { ...legacyJob };
  const remaining = uniqueIds(job.remainingTripIds?.length ? job.remainingTripIds : job.tripIds);
  const allIds = uniqueIds(job.tripIds?.length ? job.tripIds : remaining);
  const attemptCounts = job.attemptCounts && typeof job.attemptCounts === 'object'
    ? job.attemptCounts
    : {};
  delete job.remainingTripIds;
  delete job.tripIds;
  delete job.attemptCounts;
  job.total = Number(job.total) || allIds.length;
  job.completed = Number(job.completed) || 0;
  job.failed = Number(job.failed) || 0;
  job.failedTripIds = uniqueIds(job.failedTripIds).slice(-MAX_RETAINED_FAILED_IDS);

  const settled = job.status !== 'pending' && job.status !== 'running';
  if (settled) {
    job.pages = emptyPages();
    job.pending = 0;
    // A settled job carries no queued work; the reporting ring dedupes by id,
    // so replaying this is a no-op.
    await pushRecentJob(job);
    await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.PUBLISHED);
    return true;
  }

  // 1. STAGING_IDS - deterministic pages, replayable byte-for-byte.
  const entries = remaining.map((id) => ({ id, attempts: Number(attemptCounts[id]) || 0 }));
  await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.STAGING_IDS, {
    total: entries.length,
  });
  await setJson(jobIdsKey(jobId), allIds);
  const pages = await stageJobIdPages(jobId, entries);
  job.pages = pages;
  job.pending = entries.length;

  // 2. STAGING_JOB - the record exists but is NOT yet reachable.
  job.dedupeKey = dedupeIdentity(job.reason, job.zoneId, Number(job.knowledgeRevision));
  await writeJobRecord(job);
  await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.STAGING_JOB, {
    total: entries.length,
  });

  // 3. STAGING_DEDUPE - still unreachable; `isStagedButUnpublished` keeps the
  //    enqueue-time merge away from it until publication.
  if (job.dedupeKey) await setJson(dedupeRecordKey(job.dedupeKey), jobId);
  await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.STAGING_DEDUPE, {
    total: entries.length,
  });

  // 4. READY_TO_PUBLISH - everything durable; only the authority switch is left.
  await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.READY_TO_PUBLISH, {
    total: entries.length,
  });

  // 5. The queued descriptor IS the publication. Idempotent, so a crash between
  //    this write and the checkpoint below republishes nothing.
  await publishQueuedJobId(jobId);
  await writeConversionRecord(jobId, RESCORING_CONVERSION_PHASES.PUBLISHED, {
    total: entries.length,
  });
  return true;
};

/**
 * The explicit, non-lifecycle compatibility session. It is the only caller that
 * reads `drivesense_rescoring_queue_v1` and the only place a v1 job's inline
 * `tripIds`/`remainingTripIds`/`attemptCounts` are materialized.
 *
 * P4-C-F06 publication law: a legacy job is converted only once its queued
 * descriptor is durably published. Every earlier artifact - id record, id pages,
 * job record, dedupe record - is staging, and a job record on its own never
 * means "converted". The legacy document is removed only after every job it
 * holds has reached `PUBLISHED`, so an interrupted session can always re-read
 * its source.
 */
export async function convertLegacyRescoringQueue() {
  const state = await readLegacyConversionState();
  if (state.completed) return { converted: 0, completed: true, published: 0 };
  const legacy = await getJson(RESCORING_QUEUE_KEY, null);
  let converted = 0;
  let published = 0;
  if (Array.isArray(legacy)) {
    await setJson(RESCORING_CONVERSION_KEY, {
      startedAt: Date.now(), converted: state.converted, completedAt: null,
    });
    const convertible = legacy.filter((legacyJob) => legacyJob?.id);
    for (const legacyJob of convertible) {
      const didWork = await convertOneLegacyJob(legacyJob);
      if (didWork) converted += 1;
      published += 1;
    }
    if (published < convertible.length) {
      // Unreachable while `convertOneLegacyJob` either finishes or throws, but
      // stated so the removal below can never run on a partial pass.
      return { converted, completed: false, published };
    }
    // Every job is published: the source may go, and so may the per-job
    // checkpoints it was keeping alive.
    await setJson(RESCORING_QUEUE_KEY, null);
    for (const legacyJob of convertible) {
      await setJson(conversionRecordKey(String(legacyJob.id)), null);
    }
  }
  await setJson(RESCORING_CONVERSION_KEY, {
    startedAt: Date.now(),
    converted: state.converted + converted,
    completedAt: Date.now(),
  });
  return { converted, completed: true, published };
}

/**
 * Every job the queue still knows about, newest last. Reporting only - the
 * bounded turn reads the metadata scalars and one job record instead.
 */
export async function getRescoringQueue() {
  const meta = await readQueueMeta();
  const stored = await getJson(RESCORING_RECENT_KEY, []);
  const jobs = Array.isArray(stored) ? [...stored] : [];
  const ids = [];
  if (meta.activeId) ids.push(meta.activeId);
  for (let index = meta.head; index <= meta.tail; index += 1) {
    const page = await readQueuePage(index);
    ids.push(...(index === meta.head ? page.slice(meta.headOffset) : page));
  }
  for (const id of ids) {
    if (jobs.some((item) => item?.id === id)) continue;
    const job = await readJobRecord(id);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (Number(a?.enqueuedAt) || 0) - (Number(b?.enqueuedAt) || 0));
}

/**
 * How many trips a job still has queued. Reads the job's own scalar, falling
 * back to a pre-conversion v1 job's inline array.
 */
export const pendingTripCount = (job) => (
  Number.isFinite(Number(job?.pending))
    ? Math.max(0, Number(job.pending))
    : uniqueIds(job?.remainingTripIds).length
);

const failedTripCount = (job) => (
  Number.isFinite(Number(job?.failed))
    ? Math.max(0, Number(job.failed))
    : uniqueIds(job?.failedTripIds).length
);

/** The ids a job still has queued. Reporting only - never used by a turn. */
export async function readRescoringJobRemaining(jobId) {
  const job = await readJobRecord(jobId);
  if (!job) return [];
  if (Array.isArray(job.remainingTripIds)) return uniqueIds(job.remainingTripIds);
  const pages = job.pages || emptyPages();
  const ids = [];
  for (let index = pages.head; index <= pages.tail; index += 1) {
    const page = await readJobPage(jobId, index);
    const slice = index === pages.head ? page.slice(pages.headOffset) : page;
    ids.push(...slice.map((entry) => normalizeQueuedId(entry).id));
  }
  return ids;
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
  // Scalar counters, so status never materializes a job's id set.
  return {
    activeJobs: active.length,
    pendingTrips: active.reduce((sum, job) => sum + pendingTripCount(job), 0),
    completedTrips: active.reduce((sum, job) => sum + (Number(job?.completed) || 0), 0),
    totalTrips: active.reduce((sum, job) => sum + (Number(job?.total) || 0), 0),
    failedTrips: matching.reduce((sum, job) => sum + failedTripCount(job), 0),
    latest,
  };
}

// M23: once this queue is classified as lifecycle-owned suspendible work, the
// coordinator owns admission of its next turn. The durable queue, dedupe,
// per-trip attempt ceiling, Web Lock and progress events are untouched; only
// the private idle self-scheduling is suppressed.
let coordinatorOwned = false;
export const setRescoringCoordinatorOwned = (owned) => { coordinatorOwned = owned === true; };

/**
 * P4-C-F07 — worker registration is the producer of the readiness signal.
 *
 * Coordinator ownership is claimed at boot, but the rescoring worker is
 * registered later, behind the app's quiet gate. A resume in between used to
 * find persisted pending work with no worker to run it, return
 * `hasMore: true, ranBatch: false`, and be re-admitted immediately - a
 * zero-work turn loop that could never converge. The turn now defers on a typed
 * `rescoring_worker` wake, and this listener is what satisfies it: the same
 * logical obligation wakes when a worker actually exists, with no private
 * next-turn scheduling restored.
 */
let workerReadyListener = null;
export const setRescoringWorkerReadyListener = (listener) => {
  workerReadyListener = typeof listener === 'function' ? listener : null;
};

/**
 * DPD-040. Work that arrives, or is left pending, OUTSIDE a coordinator turn.
 *
 * A user-triggered rescore (saving a road speed) enqueues its job and runs one
 * direct batch from the page. Under coordinator ownership nothing else asked
 * the coordinator for the rest: the lifecycle instance for this epoch had
 * already settled, and a same-epoch lifecycle re-admission answers
 * `already_admitted`. On the A54 at 3,000 trips a posted-sign save rescored 20
 * of 156 matching trips and the other 136 waited, with the app open, until it
 * was backgrounded and reopened. This listener is the coordinator's declared
 * domain follow-up for exactly that event. It is only signalled outside a
 * coordinator turn (inside one, the turn's own `hasMore` continues) and never
 * while a direct batch is still running, so it cannot drive zero-work turns.
 */
let workEnqueuedListener = null;
let coordinatorTurnDepth = 0;
export const setRescoringWorkEnqueuedListener = (listener) => {
  workEnqueuedListener = typeof listener === 'function' ? listener : null;
};

/** True when some worker able to rescore a trip is currently registered. */
export const hasRescoringWorker = (worker = null) => Boolean(
  worker?.rescoreTrip || activeWorker?.rescoreTrip || jobWorkers.size > 0
);

function scheduleWorker(worker) {
  const hadWorker = Boolean(activeWorker?.rescoreTrip);
  if (worker?.rescoreTrip) activeWorker = worker;
  if (coordinatorOwned) {
    // Registration - not a timer - is what re-admits the deferred obligation.
    if (!hadWorker && worker?.rescoreTrip && workerReadyListener) {
      try { workerReadyListener(); } catch { /* admission failures are logged by the runtime */ }
    }
    if (coordinatorTurnDepth === 0 && !running && workEnqueuedListener) {
      try { workEnqueuedListener(); } catch { /* admission failures are logged by the runtime */ }
    }
    return;
  }
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
  // Enqueue is an explicit, user-initiated operation, so it is a legitimate
  // owner of the v1 compatibility session. A bounded turn never reaches here.
  await convertLegacyRescoringQueue();
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

  const identity = dedupeIdentity(reason, zoneId, resolvedKnowledgeRevision);
  let sameRevisionJob = null;
  if (identity) {
    const existingId = await getJson(dedupeRecordKey(identity), null);
    if (existingId) {
      const candidate = await readJobRecord(String(existingId));
      const reachable = candidate && !(await isStagedButUnpublished(candidate.id));
      if (reachable && (candidate.status === 'pending' || candidate.status === 'running')) {
        sameRevisionJob = candidate;
      } else if (!candidate) {
        // P4-C-F06: a dedupe record whose job record is gone is stale and is
        // repaired. One pointing at a *staged* job is not stale - conversion
        // will publish it - so it is left alone and simply not merged into.
        await setJson(dedupeRecordKey(identity), null);
      }
    }
  }
  if (sameRevisionJob) {
    // Dedupe reads the job's own id record - an enqueue-time cost, never a
    // scheduler turn's.
    const existing = await readJobIds(sameRevisionJob.id);
    const alreadyQueued = new Set(existing);
    const additions = affectedTripIds.filter((id) => !alreadyQueued.has(id));
    const allIds = uniqueIds([...existing, ...additions]);
    await setJson(jobIdsKey(sameRevisionJob.id), allIds);
    await appendJobIds(sameRevisionJob, additions);
    sameRevisionJob.total = allIds.length;
    await writeJobRecord(sameRevisionJob);
    if (worker?.rescoreTrip) jobWorkers.set(sameRevisionJob.id, worker);
    emitProgress({ ...sameRevisionJob, progress: sameRevisionJob.completed });
    scheduleWorker(worker);
    return sameRevisionJob;
  }

  const job = {
    id: generateJobId(),
    reason,
    zoneId,
    // The ids live in the job's own pages; the job record keeps scalars.
    pages: emptyPages(),
    pending: 0,
    total: affectedTripIds.length,
    completed: 0,
    failed: 0,
    failedTripIds: [],
    dedupeKey: identity,
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
    // Nothing to run: it goes straight into the bounded reporting ring rather
    // than onto the index.
    await pushRecentJob(job);
    emitProgress({ ...job, progress: 0 });
    return job;
  }
  await setJson(jobIdsKey(job.id), affectedTripIds);
  await appendJobIds(job, affectedTripIds);
  await writeJobRecord(job);
  if (identity) await setJson(dedupeRecordKey(identity), job.id);
  await pushQueuedJobId(job.id);
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
    // O(1) head pointer: metadata plus this job's own record.
    const claimed = await claimActiveJob();
    const job = claimed.job;
    if (!job) return null;
    currentJobId = job.id;
    currentWorker = jobWorkers.get(job.id) || worker || activeWorker;
    if (!currentWorker?.rescoreTrip) return null;

    job.status = 'running';
    job.completed = Number(job.completed) || 0;
    job.startedAt = job.startedAt || Date.now();
    await writeJobRecord(job);
    emitProgress({ ...job, progress: job.completed });

    job.failedTripIds = uniqueIds(job.failedTripIds);
    // Exactly one CHUNK of ids is read out of the job's current page.
    const batch = await takeJobIds(job, CHUNK);
    // P4-C-F09: the size of the unit this turn actually attempted, and the
    // index records it had to visit to get to it.
    job.batchSize = batch.length;
    job.queueEntriesVisited = claimed.visited;
    const requeued = [];
    for (const entry of batch) {
      const tripId = entry.id;
      try {
        await currentWorker.rescoreTrip(tripId, job);
        job.completed += 1;
      } catch (error) {
        const attempts = entry.attempts + 1;
        if (attempts < MAX_ATTEMPTS_PER_TRIP) {
          requeued.push({ id: tripId, attempts });
        } else {
          job.failedTripIds = uniqueIds([...job.failedTripIds, tripId])
            .slice(-MAX_RETAINED_FAILED_IDS);
          job.failed = (Number(job.failed) || 0) + 1;
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
    // Retries go back onto the tail page carrying their own attempt count: one
    // more bounded page write, not a rewrite of the job's whole id set.
    if (requeued.length) await appendJobIds(job, requeued);

    job.failed = Number(job.failed) || 0;
    job.status = pendingTripCount(job)
      ? 'pending'
      : job.failed
        ? 'complete_with_failures'
        : 'complete';
    if (job.status !== 'pending') {
      job.completedAt = Date.now();
      await retireJob(job);
    } else {
      await writeJobRecord(job);
    }
    currentJobPending = job.status === 'pending';
    if (!currentJobPending) jobWorkers.delete(job.id);
    const after = await readQueueMeta();
    hasMoreWork = Boolean(after.activeId) || after.count > 0;
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

/**
 * One bounded rescoring scheduler turn: exactly one existing `CHUNK` batch of
 * the current job. Returns `hasMore` while any job remains pending or running.
 *
 * P4-C-F06-D: the monolithic v1 document is never parsed here. One fixed-size
 * marker read says whether the compatibility obligation is still outstanding,
 * and that obligation belongs to `convertLegacyRescoringQueue()`.
 */
export async function stepRescoringQueue(worker = null) {
  const conversion = await readLegacyConversionState();
  const legacyDocument = conversion.completed ? null : {
    legacyDocumentPending: true,
    legacyDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
    legacyDocumentWake: compatibilityWake(RESCORING_QUEUE_KEY),
  };
  coordinatorTurnDepth += 1;
  let job;
  try {
    job = await processRescoringQueue(worker);
  } finally {
    coordinatorTurnDepth -= 1;
  }
  const meta = await readQueueMeta();
  const pending = Boolean(meta.activeId) || meta.count > 0;
  if (!job && pending && !hasRescoringWorker(worker)) {
    // P4-C-F07: real pending work, no worker able to run it. This is a wait for
    // a named condition, not a continuation - reporting `hasMore` here is what
    // produced an endless zero-work turn loop.
    return {
      job: null,
      hasMore: false,
      ranBatch: false,
      processed: 0,
      examined: 0,
      awaitingWorker: true,
      ...legacyDocument,
    };
  }
  const batchSize = job ? Math.max(0, Number(job.batchSize) || 0) : 0;
  return {
    job: job?.id || null,
    hasMore: pending,
    ranBatch: job !== null,
    // P4-C-F09: the batch's real trip count, not a fixed 1.
    processed: batchSize,
    // P4-C-F09: every logical unit the turn read, including the index records
    // it visited and the trips it attempted and failed.
    examined: batchSize + (job ? Math.max(0, Number(job.queueEntriesVisited) || 0) : 0),
    ...legacyDocument,
  };
}

/** Storage keys the erasure sweep and its tests need to know about. */
export const RESCORING_QUEUE_META_STORAGE_KEY = RESCORING_QUEUE_META_KEY;
export const RESCORING_QUEUE_CONVERSION_STORAGE_KEY = RESCORING_CONVERSION_KEY;
export const RESCORING_QUEUE_RECENT_STORAGE_KEY = RESCORING_RECENT_KEY;
/** Page, job, dedupe and recent records are retired by the `drivesense_` sweep. */
export const RESCORING_QUEUE_RECORD_PREFIXES = Object.freeze([
  RESCORING_PAGE_PREFIX,
  RESCORING_IDS_PREFIX,
  RESCORING_QUEUE_PAGE_PREFIX,
  RESCORING_JOB_RECORD_PREFIX,
  RESCORING_DEDUPE_PREFIX,
  RESCORING_CONVERT_PREFIX,
]);
