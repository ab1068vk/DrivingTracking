import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  trips: [],
  buildPatch: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    getById: vi.fn(),
    listAll: vi.fn(async () => state.trips),
    update: state.update,
  },
}));

vi.mock('@/lib/openSourceTripContext', () => ({
  buildLocalSpeedKnowledgeScorePatch: state.buildPatch,
}));

vi.mock('@/lib/systemLog', () => ({
  recordSystemEvent: vi.fn(),
}));

vi.mock('@/lib/trackingStore', () => ({
  localSettings: { get: vi.fn(() => ({})) },
}));

import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { refreshTripsCrossingLocalSpeedCell } from '@/lib/localSpeedScoreRefresh';

describe('local speed score refresh', () => {
  beforeEach(() => {
    state.trips = [];
    state.buildPatch.mockReset();
    state.update.mockReset();
    state.buildPatch.mockResolvedValue({ score_overall: 88, needs_rescore: false });
    state.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
  });

  it('recalculates completed trips that crossed the edited road cell only', async () => {
    const matchingPoint = { lat: 43.6532, lng: -79.3832 };
    const geohash = geohashEncode(matchingPoint.lat, matchingPoint.lng);
    state.trips = [
      { id: 'matching', status: 'completed', route_points: [matchingPoint, { lat: 43.6533, lng: -79.3833 }] },
      { id: 'other-road', status: 'completed', route_points: [{ lat: 45.4215, lng: -75.6972 }] },
      { id: 'active', status: 'active', route_points: [matchingPoint] },
    ];

    const updated = await refreshTripsCrossingLocalSpeedCell(geohash, {});

    expect(updated).toHaveLength(1);
    expect(state.buildPatch).toHaveBeenCalledTimes(1);
    expect(state.buildPatch).toHaveBeenCalledWith(state.trips[0], {});
    expect(state.update).toHaveBeenCalledWith('matching', {
      score_overall: 88,
      needs_rescore: false,
    });
  });
});
