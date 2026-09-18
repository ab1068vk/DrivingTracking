import { describe, expect, it, vi } from 'vitest';
import { geohashEncode, LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';

const emptyKnowledge = () => ({
  schemaVersion: 1,
  knowledgeRevision: 0,
  knowledgeUpdatedAt: null,
  cells: {},
  corrections: [],
  excludedSections: [],
  roadMemory: { version: 3, candidates: [], processedTrips: {}, intelligence: null },
  history: { undo: [], redo: [] },
});

describe('P3.5 native speed bucket scoping', () => {
  it('learns and saves a local rule without reading or rewriting unrelated buckets', async () => {
    const get = vi.fn(async () => { throw new Error('whole-model read forbidden'); });
    const set = vi.fn(async () => { throw new Error('whole-model write forbidden'); });
    const getForGeohashes = vi.fn(async () => emptyKnowledge());
    const setForGeohashes = vi.fn(async () => {});
    const knowledge = new LocalSpeedKnowledge({ get, set, getForGeohashes, setForGeohashes });
    const point = { lat: 43.6532, lng: -79.3832, limitKmh: 50, source: 'openstreetmap' };

    await knowledge.learnFromTrip([point], [], { tripId: 'local-trip' });
    await knowledge.saveUserCorrection(
      point.lat,
      point.lng,
      50,
      'Local rule',
      null,
      [],
      'user_confirmed_posted_sign',
      { sectionPoints: [point, { lat: 43.6534, lng: -79.3830 }] }
    );

    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(getForGeohashes).toHaveBeenCalledTimes(2);
    expect(setForGeohashes).toHaveBeenCalledTimes(2);
    const localPrefix = geohashEncode(point.lat, point.lng, 4);
    for (const [, bucketIds] of setForGeohashes.mock.calls) {
      expect(bucketIds).toContain(localPrefix);
      expect(bucketIds.length).toBeLessThanOrEqual(9);
    }
  });

  it('updates and removes an editor rule through bounded lookup and affected buckets only', async () => {
    const correction = {
      id: 'rule-local',
      geohash: geohashEncode(43.6532, -79.3832, 6),
      lat: 43.6532,
      lng: -79.3832,
      limitKmh: 40,
      source: 'user_entered_estimate',
      appliedAt: '2026-08-22T12:00:00.000Z',
      sectionPoints: [
        { lat: 43.6532, lng: -79.3832 },
        { lat: 43.6534, lng: -79.3830 },
      ],
    };
    let current = { ...emptyKnowledge(), corrections: [correction] };
    const get = vi.fn(async () => { throw new Error('whole-model read forbidden'); });
    const set = vi.fn(async () => { throw new Error('whole-model write forbidden'); });
    const getForGeohashes = vi.fn(async () => structuredClone(current));
    const setForGeohashes = vi.fn(async (value) => { current = structuredClone(value); });
    const queryEditorItems = vi.fn(async ({ kind }) => ({
      items: kind === 'correction' && current.corrections.length ? [current.corrections[0]] : [],
      nextCursor: null,
      bounded: true,
    }));
    const knowledge = new LocalSpeedKnowledge({
      get,
      set,
      getForGeohashes,
      setForGeohashes,
      queryEditorItems,
    });

    expect(await knowledge.updateUserCorrection('rule-local', 50)).toBe(true);
    expect(current.corrections[0].limitKmh).toBe(50);
    expect(await knowledge.removeUserCorrection('rule-local')).toBe(true);
    expect(current.corrections).toEqual([]);
    expect(queryEditorItems).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(getForGeohashes).toHaveBeenCalledTimes(2);
    expect(setForGeohashes).toHaveBeenCalledTimes(2);
    for (const [, bucketIds] of setForGeohashes.mock.calls) {
      expect(bucketIds.length).toBeLessThanOrEqual(9);
    }
  });

  it('uses the exact native identity index and encrypted bounded delta history for undo and redo', async () => {
    const bucketId = geohashEncode(43.6532, -79.3832, 4);
    const correction = {
      id: 'rule-indexed',
      geohash: geohashEncode(43.6532, -79.3832, 6),
      lat: 43.6532,
      lng: -79.3832,
      limitKmh: 40,
      source: 'user_entered_estimate',
      appliedAt: '2026-08-22T12:00:00.000Z',
      sectionPoints: [
        { lat: 43.6532, lng: -79.3832 },
        { lat: 43.6534, lng: -79.3830 },
      ],
    };
    let current = { ...emptyKnowledge(), corrections: [correction] };
    const get = vi.fn(async () => { throw new Error('whole-model read forbidden'); });
    const set = vi.fn(async () => { throw new Error('whole-model write forbidden'); });
    const getForGeohashes = vi.fn(async (bucketIds) => {
      const value = structuredClone(current);
      if (!bucketIds.includes(bucketId)) value.corrections = [];
      return value;
    });
    const setForGeohashes = vi.fn(async (value) => { current = structuredClone(value); });
    const getEditorItem = vi.fn(async (kind, id) => (
      kind === 'correction' && id === 'rule-indexed' && current.corrections.length
        ? { ...current.corrections[0], _bucketId: bucketId }
        : null
    ));
    const knowledge = new LocalSpeedKnowledge({
      get,
      set,
      getForGeohashes,
      setForGeohashes,
      getEditorItem,
      isNativeAuthorityReady: async () => true,
    });

    expect(await knowledge.updateUserCorrection('rule-indexed', 50)).toBe(true);
    expect(current.corrections[0].limitKmh).toBe(50);
    expect(await knowledge.getHistoryState()).toMatchObject({ canUndo: true, canRedo: false });
    expect(await knowledge.undo()).toBe(true);
    expect(current.corrections[0].limitKmh).toBe(40);
    expect(await knowledge.redo()).toBe(true);
    expect(current.corrections[0].limitKmh).toBe(50);
    expect(getEditorItem).toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    // The exact index avoids a global search; the correction update may still
    // load the fixed 3x3 geohash neighbourhood for each of its three bounded
    // section/anchor points; this stays independent of total learned geography.
    expect(getForGeohashes.mock.calls.every(([ids]) => ids.length <= 27)).toBe(true);
  });
});
