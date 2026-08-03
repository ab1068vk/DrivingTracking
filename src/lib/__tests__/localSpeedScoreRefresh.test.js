import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { setJson } from '@/lib/mobileStorage';
import {
  getRescoringQueue,
  processRescoringQueue,
  RESCORING_QUEUE_KEY,
} from '@/lib/rescoringQueue';

describe('local speed score refresh', () => {
  beforeEach(async () => {
    await setJson(RESCORING_QUEUE_KEY, []);
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

  afterEach(() => {
    vi.unstubAllGlobals();
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
        sectionPoints: [
          { lat: 43.6532, lng: -79.3842 },
          { lat: 43.6532, lng: -79.3822 },
        ],
      }],
    };
    const after = {
      cells: {},
      corrections: [{
        geohash,
        ...matchingPoint,
        limitKmh: 50,
        directionMode: 'both',
        sectionPoints: [
          { lat: 43.6532, lng: -79.3842 },
          { lat: 43.6532, lng: -79.3822 },
        ],
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

  it('recalculates trips crossed by either side of a moved traced rule', async () => {
    const beforeRule = {
      id: 'moved-rule',
      geohash: 'old-cell',
      lat: 43.6532,
      lng: -79.3832,
      limitKmh: 50,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.6531, lng: -79.3833 },
        { lat: 43.6533, lng: -79.3831 },
      ],
    };
    const afterRule = {
      ...beforeRule,
      geohash: 'new-cell',
      lat: 43.6572,
      lng: -79.3872,
      limitKmh: 40,
      sectionPoints: [
        { lat: 43.6571, lng: -79.3873 },
        { lat: 43.6573, lng: -79.3871 },
      ],
    };
    state.trips = [
      {
        id: 'crosses-old-section',
        status: 'completed',
        route_points: [{ lat: 43.6532, lng: -79.3832 }],
      },
      {
        id: 'crosses-new-section',
        status: 'completed',
        route_points: [{ lat: 43.6572, lng: -79.3872 }],
      },
      {
        id: 'unaffected',
        status: 'completed',
        route_points: [{ lat: 43.66, lng: -79.39 }],
      },
    ];

    const updated = await refreshTripsForLocalSpeedKnowledgeChanges(
      { cells: {}, corrections: [beforeRule] },
      { cells: {}, corrections: [afterRule] },
      {}
    );

    expect(updated).toHaveLength(2);
    expect(state.update).toHaveBeenCalledTimes(2);
    expect(state.update.mock.calls.map(([id]) => id).sort()).toEqual([
      'crosses-new-section',
      'crosses-old-section',
    ]);
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

  it('records a completed zero-trip marker when only the durable knowledge revision changes', async () => {
    const updated = await refreshTripsForLocalSpeedKnowledgeChanges(
      { schemaVersion: 2, knowledgeRevision: 10, cells: {}, corrections: [] },
      { schemaVersion: 2, knowledgeRevision: 11, cells: {}, corrections: [] },
      {}
    );
    const queue = await getRescoringQueue();

    expect(updated).toHaveLength(0);
    expect(updated.totalAffectedTripCount).toBe(0);
    expect(updated.queuedTripCount).toBe(0);
    expect(updated.targetKnowledgeRevision).toBe(11);
    expect(queue.at(-1)).toMatchObject({
      reason: 'speed_knowledge_rules_changed',
      status: 'complete',
      total: 0,
      completed: 0,
      knowledgeRevision: 11,
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('recalculates a trip when an exclusion alone starts suppressing an unchanged rule', async () => {
    const point = { lat: 43.6532, lng: -79.3832 };
    const rule = {
      id: 'unchanged-rule',
      geohash: geohashEncode(point.lat, point.lng),
      ...point,
      limitKmh: 50,
      directionMode: 'both',
      sectionPoints: [
        { lat: 43.6530, lng: -79.3834 },
        { lat: 43.6534, lng: -79.3830 },
      ],
    };
    const exclusion = {
      id: 'new-private-section',
      geohash: rule.geohash,
      ...point,
      directionMode: 'both',
      sectionPoints: rule.sectionPoints,
    };
    state.trips = [{ id: 'affected-by-exclusion', status: 'completed', route_points: [point] }];

    const updated = await refreshTripsForLocalSpeedKnowledgeChanges(
      { schemaVersion: 2, knowledgeRevision: 20, cells: {}, corrections: [rule], excludedSections: [] },
      { schemaVersion: 2, knowledgeRevision: 21, cells: {}, corrections: [rule], excludedSections: [exclusion] },
      {}
    );

    expect(updated).toHaveLength(1);
    expect(updated.totalAffectedTripCount).toBe(1);
    expect(state.update).toHaveBeenCalledWith('affected-by-exclusion', expect.any(Object));
  });

  it('reports the 20 processed and 5 durably queued trips truthfully for a 25-trip change', async () => {
    const storage = new Map();
    vi.stubGlobal('localStorage', {
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index] ?? null,
      getItem: (key) => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
      clear: () => storage.clear(),
    });
    await setJson(RESCORING_QUEUE_KEY, []);
    const point = { lat: 43.6532, lng: -79.3832 };
    const geohash = geohashEncode(point.lat, point.lng);
    state.trips = Array.from({ length: 25 }, (_, index) => ({
      id: `trip-${index}`,
      status: 'completed',
      route_points: [point],
    }));

    const updated = await refreshTripsCrossingLocalSpeedCell(geohash, {});

    expect(updated).toHaveLength(20);
    expect(updated.totalAffectedTripCount).toBe(25);
    expect(updated.queuedTripCount).toBe(5);
    expect(state.update).toHaveBeenCalledTimes(20);

    await processRescoringQueue();
    expect(state.update).toHaveBeenCalledTimes(25);
    expect((await getRescoringQueue()).at(-1)).toMatchObject({
      status: 'complete',
      total: 25,
      completed: 25,
      remainingTripIds: [],
    });
  });
});
