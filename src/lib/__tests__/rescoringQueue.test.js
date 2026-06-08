import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJson, setJson } from '@/lib/mobileStorage';
import {
  enqueueRescoreJob,
  processRescoringQueue,
  RESCORING_QUEUE_KEY,
} from '@/lib/rescoringQueue';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

describe('rescoringQueue', () => {
  afterEach(async () => {
    await setJson(RESCORING_QUEUE_KEY, []);
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
});
