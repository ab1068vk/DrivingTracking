import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-C-F06 / P4-C-F07 — the rescoring queue's durable representation is paged,
 * and a turn with no worker waits on a typed condition instead of spinning.
 */

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  reads: [],
  writes: [],
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => {
    fixture.reads.push(key);
    return fixture.storage.has(key) ? structuredClone(fixture.storage.get(key)) : fallback;
  }),
  setJson: vi.fn(async (key, value) => {
    fixture.writes.push(key);
    if (value === null) fixture.storage.delete(key);
    else fixture.storage.set(key, structuredClone(value));
  }),
}));

vi.mock('@/lib/speedKnowledgeRepository', () => ({
  readSpeedKnowledgeMetadata: vi.fn(async () => ({ schemaVersion: 2, knowledgeRevision: 7 })),
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false), getPlatform: vi.fn(() => 'web') },
}));

import {
  RESCORING_JOB_PAGE_SIZE,
  RESCORING_QUEUE_KEY,
  RESCORING_QUEUE_CONVERSION_STORAGE_KEY,
  RESCORING_QUEUE_META_STORAGE_KEY,
  RESCORING_QUEUE_PAGE_SIZE,
  RESCORING_TURN_MAX_EXAMINED,
  convertLegacyRescoringQueue,
  enqueueRescoreJob,
  getRescoringQueue,
  readRescoringJobRemaining,
  setRescoringCoordinatorOwned,
  setRescoringWorkerReadyListener,
  stepRescoringQueue,
} from '@/lib/rescoringQueue';
import { MONOLITHIC_DOCUMENT_OWNER } from '@/lib/monolithicCompatibility';

const tripIds = (count, prefix = 'trip') => (
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(5, '0')}`)
);

const queueRecordKeys = (keys) => keys.filter((key) => key.includes('rescoring'));

const largestTouchedArray = (keys) => keys.reduce((largest, key) => {
  const value = fixture.storage.get(key);
  if (!Array.isArray(value)) return largest;
  return Math.max(largest, value.length);
}, 0);

beforeEach(async () => {
  fixture.storage.clear();
  fixture.reads = [];
  fixture.writes = [];
  setRescoringCoordinatorOwned(false);
  setRescoringWorkerReadyListener(null);
  vi.clearAllMocks();
});

describe('P4-C-F06: one rescoring turn reads and writes a fixed page, not the queue', () => {
  it.each([40, 250, 900])('keeps per-turn queue storage flat at N=%s trips', async (total) => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(total) }, worker);

    fixture.reads = [];
    fixture.writes = [];
    const turn = await stepRescoringQueue(worker);

    expect(turn.processed).toBe(20);
    // The queue document holds scalars, and only one id page is touched, so the
    // largest array this turn read or wrote is one page - never every queued id.
    const touched = queueRecordKeys([...fixture.reads, ...fixture.writes]);
    expect(largestTouchedArray(touched)).toBeLessThanOrEqual(RESCORING_JOB_PAGE_SIZE);
    // The number of distinct records touched is fixed, not a function of N.
    expect(new Set(touched).size).toBeLessThanOrEqual(12);

    // And the queue document itself never carries the id arrays again.
    const [job] = await getRescoringQueue();
    expect(job.tripIds).toBeUndefined();
    expect(job.remainingTripIds).toBeUndefined();
    expect(job.pending).toBe(total - 20);
    expect(job.total).toBe(total);
  });

  it('drains a large job through more turns of the same size', async () => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(230) }, worker);

    let turns = 0;
    for (; turns < 100; turns += 1) {
      const turn = await stepRescoringQueue(worker);
      expect(turn.processed).toBeLessThanOrEqual(20);
      if (!turn.hasMore) break;
    }

    expect(turns).toBeGreaterThanOrEqual(230 / 20 - 1);
    expect(worker.rescoreTrip).toHaveBeenCalledTimes(230);
    const [job] = await getRescoringQueue();
    expect(job).toMatchObject({ status: 'complete', completed: 230, pending: 0 });
    // The drained job's page and id records are released.
    expect([...fixture.storage.keys()].filter((key) => key.includes('_job_'))).toEqual([]);
  });

  it('preserves dedupe, retries and the per-trip attempt ceiling', async () => {
    const attempts = new Map();
    const worker = {
      rescoreTrip: vi.fn(async (tripId) => {
        const count = (attempts.get(tripId) || 0) + 1;
        attempts.set(tripId, count);
        if (tripId === 'recovers' && count === 1) throw new Error('transient');
        if (tripId === 'always-fails') throw new Error('permanent');
      }),
    };

    await enqueueRescoreJob({ reason: 'manual', tripIds: ['recovers', 'always-fails', 'recovers'] }, worker);
    // Dedupe still happens at enqueue time.
    const [queued] = await getRescoringQueue();
    expect(queued.total).toBe(2);

    for (let turn = 0; turn < 10; turn += 1) {
      const outcome = await stepRescoringQueue(worker);
      if (!outcome.hasMore) break;
    }

    const [job] = await getRescoringQueue();
    expect(job.status).toBe('complete_with_failures');
    expect(job.failedTripIds).toEqual(['always-fails']);
    expect(attempts.get('always-fails')).toBe(3);
    expect(attempts.get('recovers')).toBe(2);
  });

  it('reports every trip id it read, not only the ones that changed', async () => {
    const worker = { rescoreTrip: vi.fn(async () => { throw new Error('offline'); }) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(40) }, worker);

    const turn = await stepRescoringQueue(worker);

    // P4-C-F09: a batch where every trip failed still consumed twenty trip
    // units, plus the index records the turn visited to reach them.
    expect(turn.processed).toBe(20);
    expect(turn.examined).toBeGreaterThanOrEqual(20);
    expect(turn.examined).toBeLessThanOrEqual(RESCORING_TURN_MAX_EXAMINED);
  });
});

describe('P4-C-F06-B: the job index is bounded, not one growing document', () => {
  const enqueueJobs = async (count, worker) => {
    for (let index = 0; index < count; index += 1) {
      await enqueueRescoreJob({ reason: `manual-${index}`, tripIds: [`trip-${index}`] }, worker);
    }
  };

  it.each([10, 250, 2000])('keeps per-turn index cost flat at %s queued jobs', async (jobs) => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueJobs(jobs, worker);

    fixture.reads = [];
    fixture.writes = [];
    const turn = await stepRescoringQueue(worker);

    expect(turn.processed).toBe(1);
    const touched = queueRecordKeys([...fixture.reads, ...fixture.writes]);
    // Load-bearing: restoring the monolithic `RESCORING_QUEUE_KEY` job list puts
    // an array of every queued job back into this turn's reads and writes.
    expect(largestTouchedArray(touched)).toBeLessThanOrEqual(
      Math.max(RESCORING_JOB_PAGE_SIZE, RESCORING_QUEUE_PAGE_SIZE)
    );
    expect(new Set(touched).size).toBeLessThanOrEqual(16);
    expect(fixture.reads).not.toContain(RESCORING_QUEUE_KEY);
    expect(fixture.writes).not.toContain(RESCORING_QUEUE_KEY);
  });

  it('costs the same per turn at 10 jobs as at 2000, and drains through more turns', async () => {
    const costAt = async (jobs) => {
      fixture.storage.clear();
      const worker = { rescoreTrip: vi.fn(async () => {}) };
      await enqueueJobs(jobs, worker);
      fixture.reads = [];
      fixture.writes = [];
      await stepRescoringQueue(worker);
      return { reads: fixture.reads.length, writes: fixture.writes.length };
    };

    expect(await costAt(2000)).toEqual(await costAt(10));

    fixture.storage.clear();
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueJobs(6, worker);
    let turns = 0;
    for (; turns < 50; turns += 1) {
      const turn = await stepRescoringQueue(worker);
      if (!turn.hasMore) break;
    }
    // More queued jobs means more bounded turns, never a bigger turn.
    expect(turns).toBeGreaterThanOrEqual(5);
    expect(worker.rescoreTrip).toHaveBeenCalledTimes(6);
  });

  it('holds the head pointer in fixed metadata, never a job list', async () => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueJobs(120, worker);

    const meta = fixture.storage.get(RESCORING_QUEUE_META_STORAGE_KEY);
    expect(Object.keys(meta).sort()).toEqual(
      ['activeId', 'count', 'head', 'headOffset', 'tail', 'version']
    );
    expect(meta.count).toBe(120);
    // Descriptor pages, not one array of 120 jobs.
    expect(meta.tail).toBe(Math.floor((120 - 1) / RESCORING_QUEUE_PAGE_SIZE));
  });
});

describe('P4-C-F06-C: retained per-trip retry metadata is bounded', () => {
  it('carries an attempt count with the queued id instead of a per-job map', async () => {
    const worker = { rescoreTrip: vi.fn(async () => { throw new Error('offline'); }) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(900) }, worker);

    await stepRescoringQueue(worker);

    const [job] = await getRescoringQueue();
    // The unbounded `attemptCounts` map is gone entirely.
    expect(job.attemptCounts).toBeUndefined();
    // Retry state lives on the queued rows, so it is bounded by one page.
    const attemptRecords = [...fixture.storage.entries()]
      .filter(([key]) => key.includes('_job_page_'))
      .flatMap(([, value]) => (Array.isArray(value) ? value : []))
      .filter((entry) => entry && typeof entry === 'object');
    expect(attemptRecords.length).toBeLessThanOrEqual(RESCORING_JOB_PAGE_SIZE);
    expect(attemptRecords.every((entry) => entry.attempts === 1)).toBe(true);
  });

  it('still abandons a trip after the third attempt and forgets its retry state', async () => {
    const attempts = new Map();
    const worker = {
      rescoreTrip: vi.fn(async (tripId) => {
        attempts.set(tripId, (attempts.get(tripId) || 0) + 1);
        throw new Error('permanent');
      }),
    };
    await enqueueRescoreJob({ reason: 'manual', tripIds: ['doomed'] }, worker);

    for (let turn = 0; turn < 10; turn += 1) {
      const outcome = await stepRescoringQueue(worker);
      if (!outcome.hasMore) break;
    }

    expect(attempts.get('doomed')).toBe(3);
    const [job] = await getRescoringQueue();
    expect(job).toMatchObject({ status: 'complete_with_failures', failed: 1 });
    // Nothing retained the abandoned trip's counter.
    expect([...fixture.storage.keys()].filter((key) => key.includes('_job_page_'))).toEqual([]);
  });
});

describe('P4-C-F06-D: the monolithic v1 rescoring document is not lifecycle work', () => {
  const legacyDocument = (jobs, idsPerJob) => Array.from({ length: jobs }, (_, index) => {
    const ids = tripIds(idsPerJob, `legacy-${index}`);
    return {
      id: `legacy-job-${index}`,
      reason: 'manual',
      status: 'pending',
      tripIds: ids,
      remainingTripIds: ids,
      total: ids.length,
      completed: 0,
      failedTripIds: [],
      attemptCounts: {},
      enqueuedAt: index + 1,
    };
  });

  it.each([[10, 40], [50, 250], [200, 900]])(
    'a bounded turn never reads or converts the v1 document (%s jobs x %s trips)',
    async (jobs, idsPerJob) => {
      fixture.storage.set(RESCORING_QUEUE_KEY, legacyDocument(jobs, idsPerJob));
      const worker = { rescoreTrip: vi.fn(async () => {}) };
      fixture.reads = [];
      fixture.writes = [];

      const turn = await stepRescoringQueue(worker);

      // Load-bearing: restoring the whole-document `convertLegacyJob` pass puts
      // the legacy key back into these lists and fails here.
      expect(fixture.reads).not.toContain(RESCORING_QUEUE_KEY);
      expect(fixture.writes).not.toContain(RESCORING_QUEUE_KEY);
      expect(fixture.storage.get(RESCORING_QUEUE_KEY)).toHaveLength(jobs);
      expect(worker.rescoreTrip).not.toHaveBeenCalled();
      expect(turn).toMatchObject({
        processed: 0,
        legacyDocumentPending: true,
        legacyDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
      });
      expect(turn.legacyDocumentWake).toMatchObject({ type: 'compatibility_conversion' });
    }
  );

  it('converts inline job ids only in the explicit session, discarding nothing', async () => {
    fixture.storage.set(RESCORING_QUEUE_KEY, legacyDocument(1, 45));

    const session = await convertLegacyRescoringQueue();

    expect(session).toMatchObject({ converted: 1, completed: true });
    expect(fixture.storage.get(RESCORING_QUEUE_KEY)).toBeUndefined();
    await expect(readRescoringJobRemaining('legacy-job-0')).resolves.toHaveLength(45);

    const worker = { rescoreTrip: vi.fn(async () => {}) };
    const turn = await stepRescoringQueue(worker);
    expect(turn.processed).toBe(20);
    expect(turn.legacyDocumentPending).toBeUndefined();
    const [job] = await getRescoringQueue();
    expect(job.remainingTripIds).toBeUndefined();
    expect(job.tripIds).toBeUndefined();
    expect(job.pending).toBe(25);
  });

  it('is restart-safe: a re-run neither duplicates nor drops converted jobs', async () => {
    fixture.storage.set(RESCORING_QUEUE_KEY, legacyDocument(3, 5));

    await convertLegacyRescoringQueue();
    // A second session on a marker that was never stamped complete.
    fixture.storage.delete(RESCORING_QUEUE_CONVERSION_STORAGE_KEY);
    fixture.storage.set(RESCORING_QUEUE_KEY, legacyDocument(3, 5));
    const repeat = await convertLegacyRescoringQueue();

    expect(repeat.converted).toBe(0);
    const queue = await getRescoringQueue();
    expect(queue.map((job) => job.id)).toEqual([
      'legacy-job-0', 'legacy-job-1', 'legacy-job-2',
    ]);
  });

  it('preserves per-trip attempt counts through the conversion', async () => {
    const [legacyJob] = legacyDocument(1, 3);
    legacyJob.attemptCounts = { 'legacy-0-00001': 2 };
    fixture.storage.set(RESCORING_QUEUE_KEY, [legacyJob]);

    await convertLegacyRescoringQueue();

    const attempts = new Map();
    const worker = {
      rescoreTrip: vi.fn(async (tripId) => {
        attempts.set(tripId, (attempts.get(tripId) || 0) + 1);
        throw new Error('permanent');
      }),
    };
    for (let turn = 0; turn < 10; turn += 1) {
      const outcome = await stepRescoringQueue(worker);
      if (!outcome.hasMore) break;
    }

    // The trip that had already burned two attempts gets exactly one more.
    expect(attempts.get('legacy-0-00001')).toBe(1);
    expect(attempts.get('legacy-0-00000')).toBe(3);
  });
});

describe('P4-C-F07: a rescoring turn with no worker waits instead of spinning', () => {
  it('defers on a typed worker-readiness condition rather than reporting hasMore', async () => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(40) }, worker);

    // A fresh renderer: persisted pending work, coordinator ownership claimed
    // at boot, and no worker registered yet.
    vi.resetModules();
    const queue = await import('@/lib/rescoringQueue');
    queue.setRescoringCoordinatorOwned(true);

    const first = await queue.stepRescoringQueue();
    const second = await queue.stepRescoringQueue();

    // No zero-work `hasMore` the coordinator would re-admit forever.
    for (const turn of [first, second]) {
      expect(turn).toMatchObject({ ranBatch: false, hasMore: false, awaitingWorker: true, processed: 0 });
    }
  });

  it('worker registration is the producer that re-admits the deferred obligation', async () => {
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    await enqueueRescoreJob({ reason: 'manual', tripIds: tripIds(25) }, worker);

    vi.resetModules();
    const queue = await import('@/lib/rescoringQueue');
    queue.setRescoringCoordinatorOwned(true);
    const readmit = vi.fn();
    queue.setRescoringWorkerReadyListener(readmit);

    expect((await queue.stepRescoringQueue()).awaitingWorker).toBe(true);
    expect(readmit).not.toHaveBeenCalled();

    // Registration through the production path - not a timer - satisfies it.
    const registered = { rescoreTrip: vi.fn(async () => {}) };
    queue.scheduleRescoringQueue(registered);
    expect(readmit).toHaveBeenCalledTimes(1);

    // The same obligation now advances one bounded batch per turn.
    const turn = await queue.stepRescoringQueue(registered);
    expect(turn.processed).toBe(20);
    expect(turn.awaitingWorker).toBeUndefined();
    const final = await queue.stepRescoringQueue(registered);
    expect(final.hasMore).toBe(false);
    expect(registered.rescoreTrip).toHaveBeenCalledTimes(25);
  });

  it('does not privately self-schedule while the coordinator owns the queue', async () => {
    vi.resetModules();
    const queue = await import('@/lib/rescoringQueue');
    queue.setRescoringCoordinatorOwned(true);
    const requestIdleCallback = vi.fn();
    const setTimeoutSpy = vi.fn();
    vi.stubGlobal('window', { requestIdleCallback, dispatchEvent: vi.fn() });
    vi.stubGlobal('setTimeout', setTimeoutSpy);

    queue.scheduleRescoringQueue({ rescoreTrip: vi.fn(async () => {}) });

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
