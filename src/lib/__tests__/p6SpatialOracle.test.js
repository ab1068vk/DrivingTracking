import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rescore = { calls: [] };

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
vi.mock('@/lib/rescoringQueue', () => ({
  enqueueRescoreJob: vi.fn(async (payload) => { rescore.calls.push(payload); return { accepted: true }; }),
}));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import { TRIP_SCHEMA_VERSION, localTripRepository } from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  createP6AffectedTripSelectionRequest, finalizeP6BrowserExplicitTripBuild,
  stepP6AffectedTripSelection, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

/**
 * Independent geohash, written here rather than imported, so the oracle does
 * not agree with production by construction.
 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const oracleGeohash = (lat, lng, precision = 6) => {
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return '';
  let latitude = [-90, 90];
  let longitude = [-180, 180];
  let hash = '';
  let bit = 0;
  let value = 0;
  let even = true;
  while (hash.length < precision) {
    const range = even ? longitude : latitude;
    const target = even ? Number(lng) : Number(lat);
    const mid = (range[0] + range[1]) / 2;
    if (target >= mid) { value |= 1 << (4 - bit); range[0] = mid; } else { range[1] = mid; }
    even = !even;
    if (bit < 4) bit += 1;
    else { hash += BASE32[value]; bit = 0; value = 0; }
  }
  return hash;
};

const isPublic = (point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng))
  && Math.abs(Number(point.lat)) <= 90 && Math.abs(Number(point.lng)) <= 180
  && !(Math.abs(Number(point.lat)) < 0.001 && Math.abs(Number(point.lng)) < 0.001);

/** The exhaustive precise predicate: every public point of every trip. */
const oracleMatches = (trips, geohash) => new Set(
  [...trips.entries()]
    .filter(([, points]) => points.some((point) => (
      isPublic(point) && oracleGeohash(Number(point.lat), Number(point.lng)) === geohash
    )))
    .map(([id]) => id),
);

const trip = (id, points) => ({
  id, status: 'completed',
  start_time: '2026-09-01T10:00:00.000Z',
  end_time: '2026-09-01T10:15:00.000Z',
  distance_km: 5, score_overall: 90, duration_seconds: 900,
  route_points: points,
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
});

const line = (lat, lng, count, step = 0.00002) => Array.from({ length: count }, (_, index) => ({
  lat: lat + index * step, lng: lng + index * step,
  timestamp: 1_756_000_000_000 + index * 1000, speed_kmh: 40, accuracy: 6,
}));

describe('P6-V19 browser spatial selection against an exhaustive oracle', () => {
  let indexedDb;
  let routes;

  beforeEach(() => {
    rescore.calls = [];
    routes = new Map();
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const seed = async (id, points) => {
    routes.set(id, points);
    await localTripRepository.create(trip(id, points));
  };

  const build = async () => {
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  const select = async (descriptor) => {
    rescore.calls = [];
    const request = await createP6AffectedTripSelectionRequest({
      descriptors: [descriptor], reason: 'speed_knowledge_rules_changed',
      knowledgeMetadata: { knowledgeRevision: 1, schemaVersion: 1 },
    });
    let drained = false;
    let turns = 0;
    for (; turns < 900; turns += 1) {
      const result = await stepP6AffectedTripSelection();
      if (result.state === 'IDLE') { drained = true; break; }
    }
    return {
      request,
      drained,
      turns,
      matched: new Set(rescore.calls.flatMap((call) => call.tripIds || [])),
    };
  };

  it('matches the exhaustive predicate at a cell, its edges and its neighbours', async () => {
    // Two trips inside one cell, one in an adjacent cell, one far away, and one
    // that straddles a cell edge.
    await seed('inside-a', line(43.6532, -79.3832, 40));
    await seed('inside-b', line(43.65325, -79.38325, 40));
    await seed('neighbour', line(43.6544, -79.3844, 40));
    await seed('far', line(45.5019, -73.5674, 40));
    await seed('edge', line(43.65335, -79.38335, 60, 0.00004));
    expect(await build()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    for (const [lat, lng] of [[43.6532, -79.3832], [43.6544, -79.3844], [45.5019, -73.5674]]) {
      const geohash = oracleGeohash(lat, lng);
      const expected = oracleMatches(routes, geohash);
      const { request, matched, drained, turns } = await select({ kind: 'cell', geohash, lat, lng });
      expect(request.accepted).toBe(true);
      expect(drained, `selection did not drain in ${turns} turns for ${geohash}`).toBe(true);
      // No false negative: every trip the exhaustive predicate matches is
      // selected. The candidate set may be a superset; the precise predicate
      // decides, and the queue effect must equal the oracle exactly.
      for (const id of expected) expect(matched.has(id), `${geohash} missing ${id}`).toBe(true);
      expect([...matched].sort()).toEqual([...expected].sort());
    }
  }, 240_000);

  it('handles the dateline, the poles and unlocated inputs without a false result', async () => {
    await seed('dateline', line(12.3456, 179.9990, 30, 0.00003));
    await seed('antimeridian', line(12.3456, -179.9990, 30, 0.00003));
    await seed('high-latitude', line(85.0004, 12.3456, 30, 0.00003));
    await seed('normal', line(43.6532, -79.3832, 30));
    expect(await build()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    for (const [lat, lng] of [[12.3456, 179.9990], [12.3456, -179.9990], [85.0004, 12.3456]]) {
      const geohash = oracleGeohash(lat, lng);
      const expected = oracleMatches(routes, geohash);
      expect(expected.size).toBeGreaterThan(0);
      const { matched, drained, turns } = await select({ kind: 'cell', geohash, lat, lng });
      expect(drained, `selection did not drain in ${turns} turns for ${geohash}`).toBe(true);
      expect([...matched].sort()).toEqual([...expected].sort());
    }

    // Unlocated and invalid descriptors select nothing and raise nothing.
    for (const descriptor of [
      { kind: 'cell', geohash: '', lat: Number.NaN, lng: Number.NaN },
      { kind: 'cell', geohash: 'zzzzzz', lat: 1000, lng: 2000 },
      { kind: 'cell' },
    ]) {
      const { matched } = await select(descriptor);
      expect([...matched]).toEqual([]);
    }

    // Right at the pole a 45 m padded query spans an enormous number of
    // longitude cells. That must arrive as many bounded requests, never as one
    // unbounded one.
    const polar = await createP6AffectedTripSelectionRequest({
      descriptors: [{ kind: 'cell', geohash: oracleGeohash(89.98, 12.3456), lat: 89.98, lng: 12.3456 }],
      reason: 'speed_knowledge_rules_changed',
    });
    expect(polar.accepted).toBe(true);
    expect(polar.requestIds.length).toBeGreaterThan(1);
    expect(polar.tokenCount / polar.requestIds.length).toBeLessThanOrEqual(4096);
  }, 240_000);

  it('returns the same set for repeated queries over the same durable postings', async () => {
    await seed('repeat-a', line(43.6532, -79.3832, 40));
    await seed('repeat-b', line(43.7001, -79.4001, 40));
    expect(await build()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const geohash = oracleGeohash(43.6532, -79.3832);
    const expected = oracleMatches(routes, geohash);
    const descriptor = { kind: 'cell', geohash, lat: 43.6532, lng: -79.3832 };

    // Nothing about the answer depends on what an earlier query left in memory:
    // each request opens and closes its own connections, and the durable
    // postings are the only state. The equivalent proof across a real process
    // death is P6-V09's restart arm.
    const first = await select(descriptor);
    const second = await select(descriptor);
    const third = await select(descriptor);
    expect([...first.matched].sort()).toEqual([...expected].sort());
    expect([...second.matched].sort()).toEqual([...expected].sort());
    expect([...third.matched].sort()).toEqual([...expected].sort());
  }, 240_000);
});
