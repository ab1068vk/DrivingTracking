import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/localTripRepository', () => ({
  localTripRepository: {
    getById: mocks.getById,
    update: mocks.update,
  },
}));

vi.mock('@/lib/roadMemoryCoordinator', () => ({
  synchronizeLocalRoadMemory: vi.fn(),
}));

import { tripService } from '@/api/trips';

describe('tripService weather tag updates', () => {
  beforeEach(() => {
    mocks.getById.mockReset();
    mocks.update.mockReset();
  });

  it('removes stale weather-derived Rain when trusted weather becomes clear', async () => {
    mocks.getById.mockResolvedValue({
      id: 'weather-trip',
      tags: ['city', 'rain', 'errand'],
      tag: 'city',
      auto_tags: ['city', 'rain'],
      tag_sources: {
        city: { source: 'road_evidence' },
        rain: { source: 'weather_evidence' },
        errand: { source: 'trip_pattern' },
      },
    });
    mocks.update.mockImplementation(async (id, patch) => ({ id, ...patch }));

    const result = await tripService.update('weather-trip', {
      weather_context: {
        source: 'user_confirmed',
        status: 'user_confirmed',
        condition: 'clear',
      },
    });

    expect(mocks.update).toHaveBeenCalledWith('weather-trip', expect.objectContaining({
      tags: ['city', 'errand'],
      tag: 'city',
      weather_context: expect.objectContaining({ condition: 'clear' }),
    }));
    expect(result.tags).not.toContain('rain');
    expect(result.tag_sources.rain).toBeUndefined();
  });

  it('does not read the full trip for updates unrelated to weather', async () => {
    mocks.update.mockResolvedValue({ id: 'plain-trip', nickname: 'Home' });

    await tripService.update('plain-trip', { nickname: 'Home' });

    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith('plain-trip', { nickname: 'Home' });
  });
});
