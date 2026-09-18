import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P4-C-F06 — legacy rescoring conversion is failure-atomic and restart-safe.
 *
 * The converter used to treat "a job record exists" as "this legacy job was
 * converted". A crash after the job record but before the queued descriptor
 * therefore made the next session skip the job, and the session could then drop
 * the legacy document — losing the work permanently. A crash after some page
 * writes but before the job record reconstructed empty page metadata and
 * appended the same trip ids a second time.
 *
 * The law under test: **a legacy job is converted only once its queued
 * descriptor is durably published.** Everything before that is staging, written
 * at deterministic keys so replaying it is a no-op, and the legacy document is
 * removed only after every job has reached `PUBLISHED`.
 *
 * Each case injects a durable-write failure at one crash window, rebuilds the
 * module (a fresh renderer), and re-runs the explicit conversion session.
 */

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  failOn: null,
  writes: [],
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => (
    fixture.storage.has(key) ? structuredClone(fixture.storage.get(key)) : fallback
  )),
  setJson: vi.fn(async (key, value) => {
    // The crash seam: a durable write that never lands, exactly as a killed
    // renderer would leave it.
    if (fixture.failOn && fixture.failOn(key, value, fixture.writes)) {
      throw new Error(`crash writing ${key}`);
    }
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

import { RESCORING_QUEUE_KEY } from '@/lib/rescoringQueue';

const LEGACY_KEY = RESCORING_QUEUE_KEY;

const tripIds = (count, prefix) => (
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, '0')}`)
);

/**
 * Two legacy jobs whose ids span more than one page, one of them carrying
 * partially-burned attempt counts.
 */
const legacyDocument = () => ([
  {
    id: 'legacy-a',
    reason: 'speed_knowledge_rules_changed',
    knowledgeRevision: 7,
    status: 'pending',
    tripIds: tripIds(140, 'a'),
    remainingTripIds: tripIds(140, 'a'),
    attemptCounts: { 'a-0000': 2, 'a-0101': 1 },
    total: 140,
    completed: 0,
    failedTripIds: [],
    enqueuedAt: 1,
  },
  {
    id: 'legacy-b',
    reason: 'manual',
    status: 'pending',
    tripIds: tripIds(30, 'b'),
    remainingTripIds: tripIds(30, 'b'),
    attemptCounts: {},
    total: 30,
    completed: 0,
    failedTripIds: [],
    enqueuedAt: 2,
  },
]);

/** A fresh renderer: no module state survives a crash. */
const freshQueue = async () => {
  vi.resetModules();
  return import('@/lib/rescoringQueue');
};

/** Everything the converted queue holds, read through the public surface. */
const readConvertedState = async () => {
  const queue = await freshQueue();
  const jobs = await queue.getRescoringQueue();
  const remaining = {};
  for (const job of jobs) {
    remaining[job.id] = await queue.readRescoringJobRemaining(job.id);
  }
  return { jobs, remaining };
};

/** Every queued id across every job page, with its attempt count. */
const stagedEntries = (jobId) => {
  const entries = [];
  for (const [key, value] of fixture.storage.entries()) {
    if (!key.startsWith(`drivesense_rescoring_job_page_v2_${jobId}_`)) continue;
    const index = Number(key.slice(key.lastIndexOf('_') + 1));
    entries.push({ index, value });
  }
  entries.sort((a, b) => a.index - b.index);
  return entries.flatMap(({ value }) => (Array.isArray(value) ? value : []))
    .map((entry) => (entry && typeof entry === 'object'
      ? { id: String(entry.id), attempts: Number(entry.attempts) || 0 }
      : { id: String(entry), attempts: 0 }));
};

const descriptorIds = () => {
  const ids = [];
  for (const [key, value] of fixture.storage.entries()) {
    if (key.startsWith('drivesense_rescoring_queue_page_v2_') && Array.isArray(value)) {
      ids.push(...value);
    }
  }
  return ids;
};

beforeEach(() => {
  fixture.storage.clear();
  fixture.writes = [];
  fixture.failOn = null;
  vi.clearAllMocks();
});

/**
 * The seven crash windows. Each predicate fires exactly once, on the write that
 * ends the named window.
 */
const nthWrite = (predicate, occurrence = 1) => {
  let seen = 0;
  return (key, value, writes) => {
    if (!predicate(key, value, writes)) return false;
    seen += 1;
    return seen === occurrence;
  };
};

const CRASH_WINDOWS = [
  ['A after the first id page write',
    () => nthWrite((key) => key.startsWith('drivesense_rescoring_job_page_v2_legacy-a_'), 2)],
  ['B after the final page write, before the job record',
    () => nthWrite((key) => key === 'drivesense_rescoring_job_record_v2_legacy-a')],
  ['C immediately after the job record',
    () => nthWrite((key) => key.startsWith('drivesense_rescoring_dedupe_v2_'))],
  ['D immediately after the dedupe record',
    () => nthWrite((key, value) => (
      key === 'drivesense_rescoring_convert_v2_legacy-a' && value?.phase === 'ready_to_publish'
    ))],
  ['E immediately before the descriptor is published',
    () => nthWrite((key) => key.startsWith('drivesense_rescoring_queue_page_v2_'))],
  ['F after the descriptor, before the conversion checkpoint',
    () => nthWrite((key, value) => (
      key === 'drivesense_rescoring_convert_v2_legacy-a' && value?.phase === 'published'
    ))],
  ['G between the two legacy jobs',
    () => nthWrite((key) => key === 'drivesense_rescoring_job_record_v2_legacy-b')],
];

describe('P4-C-F06: a crash in legacy rescoring conversion loses and duplicates nothing', () => {
  it.each(CRASH_WINDOWS)('survives a crash %s', async (_label, buildFailure) => {
    fixture.storage.set(LEGACY_KEY, legacyDocument());

    // First session: crashes at this window.
    fixture.failOn = buildFailure();
    const crashed = await freshQueue();
    await expect(crashed.convertLegacyRescoringQueue()).rejects.toThrow(/crash writing/);

    // The legacy source is still intact - nothing may be removed until every
    // job is published.
    expect(fixture.storage.get(LEGACY_KEY)).toHaveLength(2);

    // Second session, a fresh renderer.
    fixture.failOn = null;
    const resumed = await freshQueue();
    const outcome = await resumed.convertLegacyRescoringQueue();
    expect(outcome.completed).toBe(true);

    // Both jobs published exactly once.
    expect(descriptorIds().sort()).toEqual(['legacy-a', 'legacy-b']);
    const { jobs, remaining } = await readConvertedState();
    expect(jobs.map((job) => job.id).sort()).toEqual(['legacy-a', 'legacy-b']);

    // No id lost, none duplicated.
    expect(remaining['legacy-a']).toHaveLength(140);
    expect(new Set(remaining['legacy-a']).size).toBe(140);
    expect(remaining['legacy-b']).toHaveLength(30);
    expect(new Set(remaining['legacy-b']).size).toBe(30);
    expect(remaining['legacy-a']).toEqual(tripIds(140, 'a'));

    // Attempt counts survive exactly as the legacy source held them.
    const entries = stagedEntries('legacy-a');
    expect(entries.find((entry) => entry.id === 'a-0000').attempts).toBe(2);
    expect(entries.find((entry) => entry.id === 'a-0101').attempts).toBe(1);
    expect(entries.filter((entry) => entry.attempts > 0)).toHaveLength(2);

    // Scalars are the legacy job's, not a recount of a duplicated staging pass.
    const jobA = jobs.find((job) => job.id === 'legacy-a');
    expect(jobA).toMatchObject({ total: 140, pending: 140, completed: 0 });

    // The source is only now retired, and the per-job checkpoints with it.
    expect(fixture.storage.has(LEGACY_KEY)).toBe(false);
    expect([...fixture.storage.keys()].filter((key) => key.includes('_convert_v2_'))).toEqual([]);
  });

  it('leaves a staged-but-unpublished job invisible to ordinary queue consumption', async () => {
    fixture.storage.set(LEGACY_KEY, legacyDocument());
    // Crash exactly at the authority switch: everything is staged, nothing is
    // published.
    fixture.failOn = nthWrite((key) => key.startsWith('drivesense_rescoring_queue_page_v2_'));
    const crashed = await freshQueue();
    await expect(crashed.convertLegacyRescoringQueue()).rejects.toThrow(/crash writing/);

    // The job record and dedupe record exist ...
    expect(fixture.storage.has('drivesense_rescoring_job_record_v2_legacy-a')).toBe(true);
    expect(descriptorIds()).toEqual([]);

    fixture.failOn = null;
    const queue = await freshQueue();
    // ... but nothing reachable sees the job: no descriptor, no head pointer.
    await expect(queue.getRescoringQueue()).resolves.toEqual([]);
    const worker = { rescoreTrip: vi.fn(async () => {}) };
    // A turn finds no work and runs none - a job record alone is not published.
    const turn = await queue.stepRescoringQueue(worker);
    expect(turn).toMatchObject({ processed: 0, ranBatch: false });
    expect(worker.rescoreTrip).not.toHaveBeenCalled();
  });

  it('does not merge a new enqueue into a staged-but-unpublished job', async () => {
    fixture.storage.set(LEGACY_KEY, legacyDocument());
    fixture.failOn = nthWrite((key) => key.startsWith('drivesense_rescoring_queue_page_v2_'));
    const crashed = await freshQueue();
    await expect(crashed.convertLegacyRescoringQueue()).rejects.toThrow(/crash writing/);
    // The staged job carries the dedupe identity for revision 7.
    expect(fixture.storage.get('drivesense_rescoring_dedupe_v2_sk_7')).toBe('legacy-a');

    fixture.failOn = null;
    const queue = await freshQueue();
    // Enqueue runs the conversion first, so by the time dedupe is consulted the
    // staged job is published and merging into it is correct and visible.
    const job = await queue.enqueueRescoreJob({
      reason: 'speed_knowledge_rules_changed',
      knowledgeRevision: 7,
      tripIds: ['a-0000', 'brand-new'],
    });

    expect(job.id).toBe('legacy-a');
    expect(descriptorIds()).toContain('legacy-a');
    // The already-queued id is not queued twice; only the new one is added.
    const remaining = await queue.readRescoringJobRemaining('legacy-a');
    expect(remaining.filter((id) => id === 'a-0000')).toHaveLength(1);
    expect(remaining).toContain('brand-new');
    expect(remaining).toHaveLength(141);
  });

  it('a settled legacy job converts into the reporting ring exactly once', async () => {
    fixture.storage.set(LEGACY_KEY, [{
      id: 'legacy-done',
      reason: 'manual',
      status: 'complete_with_failures',
      tripIds: tripIds(5, 'c'),
      remainingTripIds: [],
      failedTripIds: ['c-0001'],
      failed: 1,
      total: 5,
      completed: 4,
      enqueuedAt: 3,
    }]);
    // Crash on the completion marker, after the ring push.
    fixture.failOn = nthWrite((key) => key === 'drivesense_rescoring_conversion_v2', 2);
    const crashed = await freshQueue();
    await expect(crashed.convertLegacyRescoringQueue()).rejects.toThrow(/crash writing/);

    fixture.failOn = null;
    const queue = await freshQueue();
    await queue.convertLegacyRescoringQueue();

    const jobs = await queue.getRescoringQueue();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: 'legacy-done', status: 'complete_with_failures', failed: 1, completed: 4,
    });
    // A settled job never becomes claimable work.
    expect(descriptorIds()).toEqual([]);
  });

  it('the lifecycle turn still never parses or converts the v1 document', async () => {
    fixture.storage.set(LEGACY_KEY, legacyDocument());
    const queue = await freshQueue();
    const worker = { rescoreTrip: vi.fn(async () => {}) };

    const turn = await queue.stepRescoringQueue(worker);

    expect(turn).toMatchObject({ processed: 0, legacyDocumentPending: true });
    expect(fixture.storage.get(LEGACY_KEY)).toHaveLength(2);
    expect(descriptorIds()).toEqual([]);
    expect(worker.rescoreTrip).not.toHaveBeenCalled();
  });
});
