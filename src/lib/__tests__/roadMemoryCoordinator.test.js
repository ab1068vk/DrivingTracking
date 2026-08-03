import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  learn: vi.fn(),
}));

vi.mock('@/lib/localSpeedKnowledge', () => ({
  LocalSpeedKnowledge: class {
    learnRoadMemoryFromTrips(trips) {
      return mocks.learn(trips);
    }
  },
}));

vi.mock('@/lib/speedKnowledgeRepository', () => ({
  speedKnowledgeStore: {},
}));

vi.mock('@/lib/privacyZones', () => ({
  getPrivacyZones: () => [],
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: () => ({}) },
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
}));

import {
  backfillLocalRoadMemoryFromTripHistory,
  synchronizeLocalRoadMemory,
} from '@/lib/roadMemoryCoordinator';

describe('Road Memory history backfill', () => {
  beforeEach(() => {
    mocks.learn.mockReset();
    mocks.learn.mockResolvedValue({
      changed: true,
      processedTripCount: 3,
      observationCount: 7,
      changedCandidates: [],
    });
  });

  it('feeds stored completed trip routes into the learner in bounded batches', async () => {
    const loadBatch = vi.fn()
      .mockResolvedValueOnce({
        trips: [
          { id: 'trip-1', status: 'completed', route_points: [{}, {}] },
          { id: 'trip-2', status: 'completed', route_points: [{}, {}] },
        ],
        totalAvailable: 3,
        nextOffset: 2,
      })
      .mockResolvedValueOnce({
        trips: [
          { id: 'trip-3', status: 'completed', route_points: [{}, {}] },
        ],
        totalAvailable: 3,
        nextOffset: 3,
      });

    const result = await backfillLocalRoadMemoryFromTripHistory({
      batchSize: 2,
      maxTrips: 10,
      loadBatch,
    });

    expect(loadBatch).toHaveBeenCalledTimes(2);
    expect(mocks.learn).toHaveBeenCalledTimes(1);
    expect(mocks.learn.mock.calls[0][0].map((trip) => trip.id)).toEqual([
      'trip-1',
      'trip-2',
      'trip-3',
    ]);
    expect(result).toMatchObject({
      scannedTripCount: 3,
      totalAvailable: 3,
      processedTripCount: 3,
      observationCount: 7,
      truncated: false,
    });
  });

  it('serializes a history backfill behind live-trip learning', async () => {
    let releaseLiveLearning;
    mocks.learn
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseLiveLearning = () => resolve({
          changed: true,
          processedTripCount: 1,
          observationCount: 2,
          changedCandidates: [],
        });
      }))
      .mockResolvedValueOnce({
        changed: true,
        processedTripCount: 1,
        observationCount: 2,
        changedCandidates: [],
      });

    const liveSync = synchronizeLocalRoadMemory([{
      id: 'live-trip',
      status: 'completed',
      route_points: [{}, {}],
    }]);
    await vi.waitFor(() => expect(mocks.learn).toHaveBeenCalledTimes(1));

    const backfill = backfillLocalRoadMemoryFromTripHistory({
      batchSize: 1,
      maxTrips: 1,
      loadBatch: vi.fn(async () => ({
        trips: [{ id: 'stored-trip', status: 'completed', route_points: [{}, {}] }],
        totalAvailable: 1,
        nextOffset: 1,
      })),
    });
    await Promise.resolve();
    expect(mocks.learn).toHaveBeenCalledTimes(1);

    releaseLiveLearning();
    await Promise.all([liveSync, backfill]);
    expect(mocks.learn).toHaveBeenCalledTimes(2);
    expect(mocks.learn.mock.calls[1][0][0].id).toBe('stored-trip');
  });
});
