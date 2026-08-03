import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  storage: new Map(),
  trip: { id: 'trip-queued', route_points: [{ lat: 1, lng: 2 }, { lat: 1.1, lng: 2.1 }] },
  buildPatch: vi.fn(),
  buildWeatherPatch: vi.fn(),
  updateTrip: vi.fn(),
  getTrip: vi.fn(),
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => state.storage.has(key) ? state.storage.get(key) : fallback),
  setJson: vi.fn(async (key, value) => state.storage.set(key, value)),
}));

vi.mock('@/lib/openSourceTripContext', () => ({
  buildOpenSourceTripContextPatch: state.buildPatch,
  buildWeatherOnlyTripContextPatch: state.buildWeatherPatch,
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    update: state.updateTrip,
    getById: state.getTrip,
  },
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: vi.fn(() => ({ weather_context_enabled: true })) },
}));

vi.mock('@/lib/systemLog', () => ({ recordSystemEvent: vi.fn() }));

import {
  ROAD_CONTEXT_QUEUE_STORAGE_KEY,
  resumePendingRoadContextJobs,
  runRoadContextRefresh,
  runWeatherContextRefresh,
} from '@/lib/roadContextQueue';

describe('road context recovery queue', () => {
  beforeEach(() => {
    state.storage.clear();
    state.buildPatch.mockReset();
    state.buildWeatherPatch.mockReset();
    state.updateTrip.mockReset();
    state.getTrip.mockReset();
    state.buildPatch.mockResolvedValue({ speed_limit_context: { status: 'fetched' } });
    state.buildWeatherPatch.mockResolvedValue({ weather_context: { status: 'fetched' } });
    state.updateTrip.mockResolvedValue({ ...state.trip, speed_limit_context: { status: 'fetched' } });
    state.getTrip.mockResolvedValue(state.trip);
  });

  it('persists before work starts and clears only after the trip update succeeds', async () => {
    state.buildPatch.mockImplementationOnce(async () => {
      expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toEqual([
        expect.objectContaining({ tripId: state.trip.id }),
      ]);
      return { speed_limit_context: { status: 'fetched' } };
    });

    await runRoadContextRefresh(state.trip, {});

    expect(state.updateTrip).toHaveBeenCalledWith(state.trip.id, {
      speed_limit_context: { status: 'fetched' },
    });
    expect(state.buildPatch).toHaveBeenCalledWith(state.trip, {
      weather_context_enabled: false,
    }, {
      immediateRequests: true,
    });
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toEqual([]);
  });

  it('keeps interrupted work and completes it on the next resume', async () => {
    state.buildPatch.mockRejectedValueOnce(new Error('app closed'));
    await expect(runRoadContextRefresh(state.trip, {})).rejects.toThrow('app closed');
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toHaveLength(1);

    await resumePendingRoadContextJobs();

    expect(state.getTrip).toHaveBeenCalledWith(state.trip.id);
    expect(state.updateTrip).toHaveBeenCalledTimes(1);
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY)).toEqual([]);
  });

  it('strips weather authorization from every road-data job', async () => {
    await runRoadContextRefresh(state.trip, {
      weather_context_enabled: true,
      speed_limit_lookup_enabled: true,
    });

    expect(state.buildPatch).toHaveBeenCalledWith(state.trip, {
      weather_context_enabled: false,
      speed_limit_lookup_enabled: true,
    }, {
      immediateRequests: true,
    });
  });

  it('runs a weather-only refresh without adding a road-context recovery job', async () => {
    await runWeatherContextRefresh(state.trip, {});

    expect(state.buildWeatherPatch).toHaveBeenCalledWith(state.trip, {}, {
      immediateRequests: true,
    });
    expect(state.updateTrip).toHaveBeenCalledWith(state.trip.id, {
      weather_context: { status: 'fetched' },
    });
    expect(state.storage.get(ROAD_CONTEXT_QUEUE_STORAGE_KEY) || []).toEqual([]);
  });
});
