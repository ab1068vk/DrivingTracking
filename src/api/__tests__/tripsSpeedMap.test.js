import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listForSpeedMap: vi.fn(),
}));

vi.mock('@/lib/localTripRepository', () => ({
  localTripRepository: {
    listForSpeedMap: mocks.listForSpeedMap,
  },
}));

vi.mock('@/lib/roadMemoryCoordinator', () => ({
  synchronizeLocalRoadMemory: vi.fn(),
}));

import { tripService } from '@/api/trips';

describe('tripService.listForSpeedMap', () => {
  beforeEach(() => mocks.listForSpeedMap.mockReset());

  it('requests one bounded route batch without invoking the normal full-maintenance list', async () => {
    mocks.listForSpeedMap.mockResolvedValue({
      trips: [{ id: 'trip-81' }],
      totalAvailable: 240,
      nextOffset: 160,
    });

    const result = await tripService.listForSpeedMap({
      sort: '-start_time',
      offset: 80,
      limit: 80,
    });

    expect(mocks.listForSpeedMap).toHaveBeenCalledTimes(1);
    expect(mocks.listForSpeedMap).toHaveBeenCalledWith({
      sort: '-start_time',
      offset: 80,
      limit: 80,
    });
    expect(result).toEqual(expect.objectContaining({
      totalAvailable: 240,
      nextOffset: 160,
    }));
  });
});
