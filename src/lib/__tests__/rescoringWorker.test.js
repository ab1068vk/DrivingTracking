import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  scheduleRescoringQueue: vi.fn(),
  tripService: {
    getById: vi.fn(async () => ({ id: 'trip-1' })),
    update: vi.fn(async () => ({ id: 'trip-1' })),
  },
}));

vi.mock('@/api/trips', () => ({
  tripService: mocks.tripService,
}));

vi.mock('@/lib/rescoringQueue', () => ({
  scheduleRescoringQueue: mocks.scheduleRescoringQueue,
}));

describe('rescoringWorker', () => {
  it('marks a queued trip for rescore and reloads it to run local scoring', async () => {
    const { rescoreTripForQueue } = await import('@/lib/rescoringWorker');

    await rescoreTripForQueue('trip-1');

    expect(mocks.tripService.update).toHaveBeenCalledWith('trip-1', expect.objectContaining({
      needs_rescore: true,
      score_update_acknowledged_at: null,
    }));
    expect(mocks.tripService.getById).toHaveBeenCalledWith('trip-1');
  });

  it('registers the app-wide rescoring queue worker', async () => {
    const { rescoreTripForQueue, startRescoringWorker } = await import('@/lib/rescoringWorker');

    startRescoringWorker();

    expect(mocks.scheduleRescoringQueue).toHaveBeenCalledWith({ rescoreTrip: rescoreTripForQueue });
  });
});
