import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, setJson } from '@/lib/mobileStorage';
import {
  enqueueRescoreJob,
  getRescoringQueueStatus,
  processRescoringQueue,
  RESCORING_QUEUE_KEY,
} from '@/lib/rescoringQueue';

const speedKnowledgeRepositoryMocks = vi.hoisted(() => ({
  readSpeedKnowledgeMetadata: vi.fn(async () => ({
    schemaVersion: 2,
    knowledgeRevision: 37,
  })),
}));

vi.mock('@/lib/speedKnowledgeRepository', () => speedKnowledgeRepositoryMocks);

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

describe('rescoringQueue', () => {
  afterEach(async () => {
    await setJson(RESCORING_QUEUE_KEY, []);
    // Cancel any idle callback token retained by the module before the next
    // test replaces timer globals. This mirrors a runtime queue drain and
    // keeps scheduling assertions independent of the preceding test.
    await processRescoringQueue();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('deduplicates trip ids and processes queued rescoring work', async () => {
    const rescoreTrip = vi.fn(async () => {});

    const job = await enqueueRescoreJob({
      reason: 'privacy_zone_added',
      zoneId: 'home',
      tripIds: ['trip-1', 'trip-1', 'trip-2'],
    });
    const processed = await processRescoringQueue({ rescoreTrip });
    const queue = await getJson(RESCORING_QUEUE_KEY, []);

    expect(job.total).toBe(2);
    expect(rescoreTrip).toHaveBeenCalledTimes(2);
    expect(rescoreTrip.mock.calls.map(([tripId]) => tripId)).toEqual(['trip-1', 'trip-2']);
    expect(processed.status).toBe('complete');
    expect(queue[0]).toMatchObject({
      id: job.id,
      status: 'complete',
      completed: 2,
      total: 2,
    });
  });

  it('keeps a multi-batch job pending until every chunk is processed', async () => {
    const rescoreTrip = vi.fn(async () => {});
    const tripIds = Array.from({ length: 25 }, (_, index) => `trip-${index}`);

    await enqueueRescoreJob({ reason: 'privacy_zone_updated', zoneId: 'home', tripIds });
    const firstBatch = await processRescoringQueue({ rescoreTrip });
    const firstBatchSnapshot = {
      status: firstBatch.status,
      completed: firstBatch.completed,
      total: firstBatch.total,
    };
    const secondBatch = await processRescoringQueue({ rescoreTrip });

    expect(firstBatchSnapshot).toEqual({ status: 'pending', completed: 20, total: 25 });
    expect(secondBatch).toMatchObject({ status: 'complete', completed: 25, total: 25 });
    expect(rescoreTrip).toHaveBeenCalledTimes(25);
  });

  it('stamps the current saved-speed revision and merges duplicate jobs for it', async () => {
    const first = await enqueueRescoreJob({
      reason: 'speed_knowledge_rules_changed',
      tripIds: ['trip-1'],
    });
    const duplicate = await enqueueRescoreJob({
      reason: 'speed_knowledge_rules_changed',
      tripIds: ['trip-1', 'trip-2'],
    });
    const queue = await getJson(RESCORING_QUEUE_KEY, []);
    const status = await getRescoringQueueStatus({ knowledgeRevisionOnly: true });

    expect(speedKnowledgeRepositoryMocks.readSpeedKnowledgeMetadata).toHaveBeenCalledTimes(2);
    expect(duplicate.id).toBe(first.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      knowledgeRevision: 37,
      targetKnowledgeRevision: 37,
      knowledgeSchemaVersion: 2,
      total: 2,
      remainingTripIds: ['trip-1', 'trip-2'],
    });
    expect(status.latest?.knowledgeRevision).toBe(37);
  });

  it('uses an origin-wide Web Lock when the runtime provides one', async () => {
    const request = vi.fn(async (_name, _options, operation) => operation());
    vi.stubGlobal('navigator', { locks: { request } });

    await enqueueRescoreJob({ reason: 'manual', tripIds: [] });

    expect(request).toHaveBeenCalledWith(
      'drivesense:rescoring_queue_v1',
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });

  it('automatically schedules the next queued job after a short job completes', async () => {
    const callbacks = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', (callback, delay, ...args) => {
      if (delay === 100) {
        callbacks.push(callback);
        return callbacks.length;
      }
      return realSetTimeout(callback, delay, ...args);
    });
    const rescoreTrip = vi.fn(async () => {});
    const worker = { rescoreTrip };
    await enqueueRescoreJob({ reason: 'first', tripIds: ['trip-1'] }, worker);
    await enqueueRescoreJob({ reason: 'second', tripIds: ['trip-2'] }, worker);

    expect(callbacks).toHaveLength(1);
    callbacks.shift()();
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    expect(rescoreTrip).toHaveBeenCalledTimes(1);
    callbacks.shift()();
    await vi.waitFor(() => expect(rescoreTrip).toHaveBeenCalledTimes(2));

    const queue = await getJson(RESCORING_QUEUE_KEY, []);
    expect(queue.map((job) => job.status)).toEqual(['complete', 'complete']);
  });

  it('retries transient failures and reports a permanently failed trip', async () => {
    const attempts = new Map();
    const rescoreTrip = vi.fn(async (tripId) => {
      const next = (attempts.get(tripId) || 0) + 1;
      attempts.set(tripId, next);
      if (tripId === 'always-fails' || next === 1) throw new Error('temporary failure');
    });

    await enqueueRescoreJob({
      reason: 'speed_knowledge_rules_changed',
      tripIds: ['recovers', 'always-fails'],
    });
    await processRescoringQueue({ rescoreTrip });
    await processRescoringQueue({ rescoreTrip });
    const final = await processRescoringQueue({ rescoreTrip });
    const status = await getRescoringQueueStatus({ reasonPrefix: 'speed_knowledge' });

    expect(attempts.get('recovers')).toBe(2);
    expect(attempts.get('always-fails')).toBe(3);
    expect(final.status).toBe('complete_with_failures');
    expect(final.failedTripIds).toEqual(['always-fails']);
    expect(status.failedTrips).toBe(1);
  });
});
