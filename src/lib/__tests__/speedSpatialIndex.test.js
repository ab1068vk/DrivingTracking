import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { buildSpeedSpatialIndex, createSpeedSpatialIndex } from '@/lib/speed/speedSpatialIndex';
import {
  __resetSpeedResolverSnapshot,
  invalidateSpeedResolverSnapshot,
} from '@/lib/speed/speedResolverSnapshot';

const ROAD_SECTION_MATCH_RADIUS_KM = 0.045;

/** Deterministic PRNG so a failure is reproducible. */
function seededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const pointsFor = (record) => record.sectionPoints;

function buildCorrections(count, random) {
  return Array.from({ length: count }, (_, index) => {
    const lat = 43.6 + random() * 0.05;
    const lng = -79.4 + random() * 0.05;
    const length = 0.0004 + random() * 0.004;
    return {
      id: `correction-${index}`,
      limitKmh: 50,
      source: 'user_confirmed_posted_sign',
      lat,
      lng,
      sectionPoints: [
        { lat, lng },
        { lat: lat + (random() - 0.5) * length, lng: lng + length },
      ],
    };
  });
}

describe('speed spatial index', () => {
  it('returns a superset of every record a linear scan would test', () => {
    const random = seededRandom(20260806);
    const records = buildCorrections(400, random);
    const index = buildSpeedSpatialIndex(records, pointsFor, ROAD_SECTION_MATCH_RADIUS_KM);

    const withinRadius = (record, lat, lng) => {
      const points = record.sectionPoints;
      for (let i = 1; i < points.length; i += 1) {
        if (segmentDistanceKm(lat, lng, points[i - 1], points[i]) <= ROAD_SECTION_MATCH_RADIUS_KM) {
          return true;
        }
      }
      return false;
    };

    for (let probe = 0; probe < 500; probe += 1) {
      const lat = 43.6 + random() * 0.05;
      const lng = -79.4 + random() * 0.05;
      const linear = records.filter((record) => withinRadius(record, lat, lng));
      const indexed = new Set(index.query(lat, lng));
      for (const record of linear) {
        expect(indexed.has(record)).toBe(true);
      }
    }
  });

  it('narrows the candidate set well below the full scan', () => {
    const random = seededRandom(7);
    const records = buildCorrections(1000, random);
    const index = buildSpeedSpatialIndex(records, pointsFor, ROAD_SECTION_MATCH_RADIUS_KM);
    const sampled = Array.from({ length: 50 }, () => index.query(
      43.6 + random() * 0.05,
      -79.4 + random() * 0.05
    ).length);
    const mean = sampled.reduce((sum, value) => sum + value, 0) / sampled.length;
    expect(mean).toBeLessThan(records.length / 10);
  });

  it('always offers records that have no usable geometry', () => {
    const index = createSpeedSpatialIndex();
    const ungeocoded = { id: 'no-geometry' };
    const located = { id: 'located' };
    index.insert(ungeocoded, [], 0);
    index.insert(located, [{ lat: 43.65, lng: -79.38 }], 0);

    expect(index.query(10, 10)).toEqual([ungeocoded]);
    expect(index.query(43.65, -79.38)).toEqual(expect.arrayContaining([ungeocoded, located]));
    expect(index.query(NaN, NaN)).toEqual([ungeocoded]);
  });

  it('covers the full length of a long segment, not just its endpoints', () => {
    const index = createSpeedSpatialIndex();
    const record = { id: 'long-road' };
    index.insert(record, [{ lat: 43.65, lng: -79.40 }, { lat: 43.65, lng: -79.30 }], 0);
    // A midpoint is nowhere near either endpoint but lies on the segment.
    expect(index.query(43.65, -79.35)).toContain(record);
  });
});

describe('resolver snapshot', () => {
  beforeEach(() => {
    __resetSpeedResolverSnapshot();
  });

  const knowledgeWith = (corrections) => ({
    schemaVersion: 2,
    knowledgeRevision: 1,
    cells: {},
    corrections,
    excludedSections: [],
    roadMemory: { candidates: [] },
    history: { undo: [], redo: [] },
  });

  const correction = {
    id: 'saved-50',
    limitKmh: 50,
    source: 'user_confirmed_posted_sign',
    sectionPoints: [
      { lat: 43.6532, lng: -79.3842 },
      { lat: 43.6532, lng: -79.3822 },
    ],
  };

  it('reads the store once across repeated lookups', async () => {
    const get = vi.fn(async () => knowledgeWith([correction]));
    const knowledge = new LocalSpeedKnowledge({ get, set: vi.fn(async () => {}) });

    for (let i = 0; i < 25; i += 1) {
      const resolved = await knowledge.getForPoint(43.6532, -79.3832, Date.now());
      expect(resolved?.limitKmh).toBe(50);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after the knowledge is invalidated', async () => {
    const get = vi.fn(async () => knowledgeWith([correction]));
    const knowledge = new LocalSpeedKnowledge({ get, set: vi.fn(async () => {}) });

    await knowledge.getForPoint(43.6532, -79.3832, Date.now());
    expect(get).toHaveBeenCalledTimes(1);

    invalidateSpeedResolverSnapshot();
    await knowledge.getForPoint(43.6532, -79.3832, Date.now());
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not leak derived resolver state into a structured clone', async () => {
    const knowledge = new LocalSpeedKnowledge({
      get: async () => knowledgeWith([correction]),
      set: async () => {},
    });
    const prepared = knowledge._prepareResolverData(knowledgeWith([correction]));

    expect(prepared._spatialIndex).toBeDefined();
    expect(Object.keys(prepared)).not.toContain('_spatialIndex');
    expect(() => structuredClone(prepared)).not.toThrow();
    expect(structuredClone(prepared)._spatialIndex).toBeUndefined();
  });

  it('does not serve a snapshot built from superseded knowledge', async () => {
    let limit = 50;
    const get = vi.fn(async () => knowledgeWith([{ ...correction, limitKmh: limit }]));
    const knowledge = new LocalSpeedKnowledge({ get, set: vi.fn(async () => {}) });

    const inflight = knowledge.getForPoint(43.6532, -79.3832, Date.now());
    limit = 70;
    invalidateSpeedResolverSnapshot();
    await inflight;

    const after = await knowledge.getForPoint(43.6532, -79.3832, Date.now());
    expect(after?.limitKmh).toBe(70);
  });
});

function segmentDistanceKm(lat, lng, start, end) {
  const latScale = 110.574;
  const lngScale = 111.32 * Math.cos((lat * Math.PI) / 180);
  const px = lng * lngScale;
  const py = lat * latScale;
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
