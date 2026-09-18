import { tripService } from '@/api/trips';
import {
  buildOpenSourceTripContextPatch,
  buildWeatherOnlyTripContextPatch,
} from '@/lib/openSourceTripContext';
import { getJson, setJson } from '@/lib/mobileStorage';
import { localSettings } from '@/lib/trackingStore';
import { recordSystemEvent } from '@/lib/systemLog';
import {
  MONOLITHIC_DOCUMENT_OWNER,
  compatibilityWake,
} from '@/lib/monolithicCompatibility';

const ROAD_CONTEXT_QUEUE_KEY = 'drivesense_pending_road_context_v1';
const activeJobs = new Map();

/**
 * P4-C-F06 — the durable queue is paged, not one monolithic document.
 *
 * A bounded turn used to slice four entries *after* reading, parsing and
 * filtering the entire queue, and every `rememberTrip`/`forgetTrip`/failed
 * attempt rewrote the whole array. One turn's storage and memory cost therefore
 * grew with everything ever queued.
 *
 * The representation is now: fixed scalar metadata, fixed-size pages, and an
 * O(1) membership marker per queued trip. One turn reads the metadata and one
 * page; enqueue reads the metadata, one membership marker and the tail page.
 * Retry counters, `ROAD_CONTEXT_MAX_ATTEMPTS`, dedupe and the progress events
 * are unchanged - only where the rows live.
 */
const ROAD_CONTEXT_META_KEY = 'drivesense_pending_road_context_meta_v2';
const ROAD_CONTEXT_PAGE_PREFIX = 'drivesense_pending_road_context_page_v2_';
const ROAD_CONTEXT_MEMBER_PREFIX = 'drivesense_pending_road_context_member_v2_';
export const ROAD_CONTEXT_QUEUE_PAGE_SIZE = 25;

const pageKey = (index) => `${ROAD_CONTEXT_PAGE_PREFIX}${index}`;
const memberKey = (tripId) => `${ROAD_CONTEXT_MEMBER_PREFIX}${String(tripId)}`;

const emptyMeta = () => ({ version: 2, head: 0, tail: 0, scan: 0, count: 0 });

const readMeta = async () => {
  const stored = await getJson(ROAD_CONTEXT_META_KEY, null);
  if (!stored || typeof stored !== 'object') return emptyMeta();
  const head = Math.max(0, Number(stored.head) || 0);
  const tail = Math.max(head, Number(stored.tail) || 0);
  const scan = Math.min(tail, Math.max(head, Number(stored.scan) || head));
  return { version: 2, head, tail, scan, count: Math.max(0, Number(stored.count) || 0) };
};

const writeMeta = (meta) => setJson(ROAD_CONTEXT_META_KEY, meta);

const readPage = async (index) => {
  const page = await getJson(pageKey(index), []);
  return Array.isArray(page) ? page : [];
};

const writePage = (index, entries) => setJson(pageKey(index), entries);

const isQueued = async (tripId) => (await getJson(memberKey(tripId), null)) === true;

/**
 * P4-C-F06-A — the monolithic v1 document is an explicit compatibility session,
 * not lifecycle work.
 *
 * A bounded turn used to read, parse and rewrite the complete legacy array on
 * every conversion turn, so one turn's cost grew with everything the old build
 * had ever queued. The same rule the fallback trip archive uses now applies
 * here: a lifecycle turn learns whether the obligation is outstanding from one
 * fixed-size marker record and reports it as owned by the compatibility owner;
 * only the explicit session below ever touches the document.
 */
const ROAD_CONTEXT_LEGACY_CONVERSION_KEY = 'drivesense_pending_road_context_conversion_v2';

/** O(1). Never reads the legacy document itself. */
const readLegacyConversionState = async () => {
  const stored = await getJson(ROAD_CONTEXT_LEGACY_CONVERSION_KEY, null);
  if (!stored || typeof stored !== 'object') return { started: false, completed: false, moved: 0 };
  return {
    started: Boolean(stored.startedAt),
    completed: Boolean(stored.completedAt),
    moved: Math.max(0, Number(stored.moved) || 0),
  };
};

/**
 * Move one page worth of entries out of the legacy document. The document
 * shrinks by exactly one page per call and the marker records progress, so an
 * interrupted session resumes where it stopped and no queued trip is dropped.
 */
async function drainLegacyQueuePage(moved) {
  const legacy = await getJson(ROAD_CONTEXT_QUEUE_KEY, null);
  if (!Array.isArray(legacy) || !legacy.length) {
    if (Array.isArray(legacy)) await setJson(ROAD_CONTEXT_QUEUE_KEY, null);
    return 0;
  }
  const moving = legacy.slice(0, ROAD_CONTEXT_QUEUE_PAGE_SIZE);
  for (const entry of moving) {
    await appendEntry({
      tripId: String(entry?.tripId ?? ''),
      queuedAt: entry?.queuedAt || new Date().toISOString(),
      attempts: Number(entry?.attempts) || 0,
      lastAttemptAt: entry?.lastAttemptAt || null,
    });
  }
  const remaining = legacy.slice(moving.length);
  await setJson(ROAD_CONTEXT_QUEUE_KEY, remaining.length ? remaining : null);
  await setJson(ROAD_CONTEXT_LEGACY_CONVERSION_KEY, {
    startedAt: Date.now(),
    moved: moved + moving.length,
    completedAt: null,
  });
  return moving.length;
}

/**
 * The explicit, non-lifecycle compatibility session. It is the only caller that
 * reads the monolithic v1 document, it is restart-safe through the marker and
 * the shrinking document, and it stamps the marker complete so later lifecycle
 * turns can see the obligation is discharged at O(1).
 */
export async function convertLegacyRoadContextQueue() {
  const state = await readLegacyConversionState();
  if (state.completed) return { converted: 0, completed: true, pages: 0 };
  let converted = 0;
  let pages = 0;
  for (;;) {
    const movedNow = await drainLegacyQueuePage(state.moved + converted);
    if (!movedNow) break;
    converted += movedNow;
    pages += 1;
  }
  await setJson(ROAD_CONTEXT_LEGACY_CONVERSION_KEY, {
    startedAt: Date.now(),
    moved: state.moved + converted,
    completedAt: Date.now(),
  });
  return { converted, completed: true, pages };
}

/** Append one entry to the tail page, opening a new page when it is full. */
async function appendEntry(entry) {
  if (!entry.tripId) return;
  if (await isQueued(entry.tripId)) return;
  const meta = await readMeta();
  let tail = meta.tail;
  let page = await readPage(tail);
  if (page.length >= ROAD_CONTEXT_QUEUE_PAGE_SIZE) {
    tail += 1;
    page = [];
  }
  await writePage(tail, [...page, entry]);
  await setJson(memberKey(entry.tripId), true);
  await writeMeta({ ...meta, tail, count: meta.count + 1 });
}

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

/**
 * Every queued entry, for reporting and for the historical whole-queue resume
 * path. Deliberately not used by a bounded scheduler turn.
 */
async function readQueue() {
  const meta = await readMeta();
  const legacy = await getJson(ROAD_CONTEXT_QUEUE_KEY, null);
  const entries = [];
  for (let index = meta.head; index <= meta.tail; index += 1) {
    for (const entry of await readPage(index)) {
      if (entry?.tripId && await isQueued(entry.tripId)) entries.push(entry);
    }
  }
  return Array.isArray(legacy) ? [...entries, ...legacy] : entries;
}

async function rememberTrip(tripId) {
  await appendEntry({
    tripId: String(tripId),
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastAttemptAt: null,
  });
}

/**
 * Removal is an O(1) membership clear. The row itself is dropped when its page
 * is next processed, so no page but the head one is ever rewritten.
 */
async function forgetTrip(tripId) {
  const id = String(tripId);
  if (!(await isQueued(id))) return;
  await setJson(memberKey(id), null);
  const meta = await readMeta();
  await writeMeta({ ...meta, count: Math.max(0, meta.count - 1) });
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

/**
 * Record one failed attempt against a single entry. Only the page the entry
 * lives on is read and rewritten, never the whole queue.
 */
async function recordFailedAttempt(tripId, pageIndex = null) {
  const id = String(tripId);
  const meta = await readMeta();
  const index = pageIndex == null ? meta.head : pageIndex;
  const page = await readPage(index);
  let exhausted = false;
  const next = [];
  for (const entry of page) {
    if (String(entry.tripId) !== id) {
      next.push(entry);
      continue;
    }
    const attempts = (Number(entry.attempts) || 0) + 1;
    if (attempts >= ROAD_CONTEXT_MAX_ATTEMPTS) {
      exhausted = true;
      continue;
    }
    next.push({ ...entry, attempts, lastAttemptAt: new Date().toISOString() });
  }
  await writePage(index, next);
  if (exhausted) {
    await setJson(memberKey(id), null);
    await writeMeta({ ...meta, count: Math.max(0, meta.count - 1) });
  }
  return exhausted;
}

/**
 * One bounded road-context scheduler turn: at most `maxEntries` due queue
 * entries. The durable queue, dedupe, attempt counters, `ROAD_CONTEXT_MAX_ATTEMPTS`
 * and progress events are unchanged — only who decides when the next turn runs.
 */
/**
 * How many pages one turn may probe before reporting that it found no due work.
 * Fixed, so the probe cost never grows with the queue.
 */
const ROAD_CONTEXT_PAGE_PROBES = 4;

/**
 * P4-C-F09. The most queue entries one turn can read: every entry on every page
 * it is allowed to probe, whether or not any of them turned out to be due.
 */
export const ROAD_CONTEXT_TURN_MAX_EXAMINED = ROAD_CONTEXT_PAGE_PROBES * ROAD_CONTEXT_QUEUE_PAGE_SIZE;

export async function stepPendingRoadContextJobs({ maxEntries = 1 } = {}) {
  const ceiling = Math.max(1, Math.floor(Number(maxEntries) || 1));
  // P4-C-F06-A: the monolithic v1 document is never parsed by a lifecycle turn.
  // One fixed-size marker read says whether the compatibility obligation is
  // still outstanding; the obligation itself belongs to
  // `convertLegacyRoadContextQueue()`.
  const conversion = await readLegacyConversionState();
  const legacyDocument = conversion.completed ? null : {
    legacyDocumentPending: true,
    legacyDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
    legacyDocumentWake: compatibilityWake(ROAD_CONTEXT_QUEUE_KEY),
  };

  const meta = await readMeta();
  if (meta.count <= 0) return { processed: 0, examined: 0, hasMore: false, ...legacyDocument };

  // At most `ROAD_CONTEXT_PAGE_PROBES` pages - a fixed number of rows - are
  // read and rewritten per turn, no matter how many entries the queue holds.
  // The scan position advances every turn, so a page whose entries are all in
  // backoff cannot stall the others, and a page that has emptied is retired.
  const now = Date.now();
  let { head, tail } = meta;
  let index = Math.min(tail, Math.max(head, meta.scan));
  let live = [];
  let due = [];
  let examinedEntries = 0;
  // Never probe the same page twice: a queue with fewer pages than the probe
  // allowance is fully inspected in one pass, so the turn reads each row once.
  const probeLimit = Math.min(ROAD_CONTEXT_PAGE_PROBES, (tail - head) + 1);
  for (let probe = 0; probe < probeLimit; probe += 1) {
    const page = await readPage(index);
    examinedEntries += page.length;
    live = [];
    for (const entry of page) {
      if (await isQueued(entry?.tripId)) live.push(entry);
    }
    // Rows whose membership was cleared elsewhere are dropped before any
    // handler runs, so a completed or abandoned entry is never re-read.
    if (live.length !== page.length) await writePage(index, live);
    if (!live.length && index !== tail) {
      await setJson(pageKey(index), null);
      if (index === head && head < tail) head += 1;
    }
    due = live.filter((entry) => isEntryDue(entry, now));
    if (due.length) break;
    index = index + 1 > tail ? head : index + 1;
  }

  const batch = due.slice(0, ceiling);
  for (const entry of batch) {
    try {
      const trip = await tripService.getById(entry.tripId);
      await runRoadContextRefresh(trip, localSettings.get());
    } catch (error) {
      const exhausted = await recordFailedAttempt(entry.tripId, index);
      recordSystemEvent(exhausted ? 'road_context_job_abandoned' : 'road_context_job_resume_failed', {
        trip_id: String(entry.tripId),
        error: error?.message || 'Road-context recovery failed',
      }, { category: 'road_context', severity: 'warn' });
    }
  }

  const after = await readMeta();
  const scan = index + 1 > tail ? head : Math.max(head, index + 1);
  await writeMeta({ ...after, head, scan });

  return {
    processed: batch.length,
    // P4-C-F09: every queue entry this turn actually read counts, including the
    // ones it inspected and left in backoff.
    examined: examinedEntries,
    // More bounded work exists when this page still has due entries, or when a
    // turn that did work left queued entries behind. A turn that found only
    // entries in backoff reports no more work rather than spinning.
    hasMore: due.length > batch.length || (batch.length > 0 && after.count > 0),
    ...legacyDocument,
  };
}

/** Every queued entry, for reporting and tests. Never used by a bounded turn. */
export const listPendingRoadContextEntries = () => readQueue();

export async function resumePendingRoadContextJobs() {
  // P4-C-F06-A: the explicit resume is the compatibility owner. It converts the
  // monolithic v1 document here, once, outside any bounded lifecycle turn.
  await convertLegacyRoadContextQueue();
  // The explicit whole-queue resume is the bounded turn, repeated: it stops as
  // soon as a turn makes no progress, so entries in backoff are left alone.
  const meta = await readMeta();
  const ceiling = Math.max(1, meta.count + (meta.tail - meta.head) + 2);
  for (let pass = 0; pass < ceiling; pass += 1) {
    const turn = await stepPendingRoadContextJobs({ maxEntries: ROAD_CONTEXT_QUEUE_PAGE_SIZE });
    if (!turn.processed) break;
  }
}

export const ROAD_CONTEXT_QUEUE_STORAGE_KEY = ROAD_CONTEXT_QUEUE_KEY;
export const ROAD_CONTEXT_QUEUE_META_STORAGE_KEY = ROAD_CONTEXT_META_KEY;
export const ROAD_CONTEXT_QUEUE_CONVERSION_STORAGE_KEY = ROAD_CONTEXT_LEGACY_CONVERSION_KEY;
/** Page and membership records are retired by the `drivesense_` residual sweep. */
export const ROAD_CONTEXT_QUEUE_RECORD_PREFIXES = Object.freeze([
  ROAD_CONTEXT_PAGE_PREFIX,
  ROAD_CONTEXT_MEMBER_PREFIX,
]);
