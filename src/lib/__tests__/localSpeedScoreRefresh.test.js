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
import {
  refreshTripsCrossingLocalSpeedCell,
  refreshTripsForLocalSpeedCorrections,
  refreshTripsForLocalSpeedKnowledgeChanges,
} from '@/lib/localSpeedScoreRefresh';

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

  it('recalculates each affected trip once when speed knowledge is restored', async () => {
    const matchingPoint = { lat: 43.6532, lng: -79.3832 };
    const geohash = geohashEncode(matchingPoint.lat, matchingPoint.lng);
    state.trips = [
      { id: 'matching', status: 'completed', route_points: [matchingPoint] },
      { id: 'other-road', status: 'completed', route_points: [{ lat: 45.4215, lng: -75.6972 }] },
    ];
    const before = {
      cells: {},
      corrections: [{
        geohash,
        ...matchingPoint,
        limitKmh: 60,
        directionMode: 'both',
      }],
    };
    const after = {
      cells: {},
      corrections: [{
        geohash,
        ...matchingPoint,
        limitKmh: 50,
        directionMode: 'both',
      }],
    };

    const updated = await refreshTripsForLocalSpeedKnowledgeChanges(before, after, {});

    expect(updated).toHaveLength(1);
    expect(state.buildPatch).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith('matching', {
      score_overall: 88,
      needs_rescore: false,
    });
  });

  it('detects a removed traced rule even when another rule shares its geohash', async () => {
    const sharedGeohash = 'same-cell';
    const removedRule = {
      id: 'removed-eastbound',
      geohash: sharedGeohash,
      lat: 43.6532,
      lng: -79.3832,
      limitKmh: 50,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.6532, lng: -79.3832 },
        { lat: 43.6533, lng: -79.3831 },
      ],
    };
    const retainedRule = {
      id: 'retained-westbound',
      geohash: sharedGeohash,
      lat: 43.6572,
      lng: -79.3872,
      limitKmh: 60,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.6572, lng: -79.3872 },
        { lat: 43.6573, lng: -79.3871 },
      ],
    };
    state.trips = [
      {
        id: 'crosses-removed-rule',
        status: 'completed',
        route_points: [{ lat: 43.65321, lng: -79.38319 }],
      },
      {
        id: 'elsewhere',
        status: 'completed',
        route_points: [{ lat: 43.66, lng: -79.39 }],
      },
    ];

    const updated = await refreshTripsForLocalSpeedKnowledgeChanges(
      { cells: {}, corrections: [removedRule, retainedRule] },
      { cells: {}, corrections: [retainedRule] },
      {}
    );

    expect(updated).toHaveLength(1);
    expect(state.update).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledWith('crosses-removed-rule', {
      score_overall: 88,
      needs_rescore: false,
    });
  });

  it('recalculates a trip once when multiple changed corrections match it', async () => {
    const routePoint = { lat: 43.6532, lng: -79.3832 };
    state.trips = [
      {
        id: 'matching-once',
        status: 'completed',
        route_points: [routePoint],
      },
    ];
    const corrections = [
      {
        id: 'first-rule',
        geohash: 'cell-1',
        ...routePoint,
        limitKmh: 50,
        directionMode: 'both',
        sectionPoints: [
          { lat: 43.6531, lng: -79.3833 },
          { lat: 43.6533, lng: -79.3831 },
        ],
      },
      {
        id: 'second-rule',
        geohash: 'cell-2',
        ...routePoint,
        limitKmh: 60,
        directionMode: 'both',
        sectionPoints: [
          { lat: 43.6530, lng: -79.3834 },
          { lat: 43.6534, lng: -79.3830 },
        ],
      },
    ];

    const updated = await refreshTripsForLocalSpeedCorrections(corrections, {});

    expect(updated).toHaveLength(1);
    expect(state.buildPatch).toHaveBeenCalledTimes(1);
    expect(state.update).toHaveBeenCalledTimes(1);
  });
});
