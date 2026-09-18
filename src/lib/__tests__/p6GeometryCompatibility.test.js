import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback)),
  setJson: vi.fn(async (key, value) => { storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { storage.delete(key); }),
}));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, queryP6GeometryPreviewPage, readP6TripDomainReadiness,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = 96, ...extra } = {}) => ({
  id, status: 'completed',
  start_time: new Date(1_756_000_000_000 + seed * 86_400_000).toISOString(),
  end_time: new Date(1_756_000_000_000 + seed * 86_400_000 + 900_000).toISOString(),
  distance_km: 9, score_overall: 88, duration_seconds: 900,
  route_points: route(seed, points),
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
  ...extra,
});

/**
 * P6-V18 browser half: the preview is a bounded sample, the spatial postings
 * are not. Long routes chunk, summary-only and expired routes publish no public
 * geometry, and nothing but browser-bound rows exists in IndexedDB.
 */
describe('P6-V18 browser geometry compatibility', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const store = (name) => indexedDb.getStoreState(DB_NAME, name);
  const rowsFor = (name, tripId) => [...(store(name)?.records.values() || [])]
    .filter((row) => String(row?.tripId ?? '') === tripId);

  const drain = async () => {
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  it('chunks a long route, caps the preview at 160 points and still posts every block', async () => {
    await localTripRepository.create(trip('long-route', { points: 1024 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const chunks = rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'long-route');
    const pages = chunks.filter((row) => row.ordinal >= 0).sort((left, right) => left.ordinal - right.ordinal);
    // 1024 points at 128 per page.
    expect(pages.map((row) => row.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pages.every((row) => row.pointCount === 128)).toBe(true);

    // The preview is one bounded chunk, and the reader caps what it returns.
    const preview = chunks.filter((row) => row.ordinal === -1);
    expect(preview).toHaveLength(1);
    expect(preview[0].pointCount).toBeLessThanOrEqual(160);
    const page = await queryP6GeometryPreviewPage({ maxTrips: 10 });
    const item = page.items.find((row) => row.id === 'long-route');
    expect(item.route_points.length).toBeLessThanOrEqual(160);
    expect(item.route_points.length).toBeGreaterThan(2);

    // The spatial index is built from every public point, not from the sample:
    // every published block contributes postings.
    const postings = rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'long-route');
    expect(new Set(postings.map((row) => row.blockOrdinal)))
      .toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(postings.length).toBeGreaterThan(item.route_points.length / 4);
  }, 180_000);

  it('publishes no public geometry for a summary-only trip', async () => {
    await localTripRepository.create(trip('summary-only', { points: 64, privacy_mode: 'summary_only' }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'summary-only');
    expect(readiness.state).toBe(P6_READINESS_STATES.NO_PUBLIC_GEOMETRY);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'summary-only')).toEqual([]);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'summary-only')).toEqual([]);
    const page = await queryP6GeometryPreviewPage({ maxTrips: 10 });
    expect(page.items.map((row) => row.id)).not.toContain('summary-only');
  }, 120_000);

  it('publishes no public geometry for an expired route', async () => {
    await localTripRepository.create(trip('expired-route', {
      points: 0,
      route_data_expired_at: '2026-08-01T00:00:00.000Z',
      route_data_expiration_reason: 'raw_gps_retention_policy',
    }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'expired-route');
    expect(readiness.state).toBe(P6_READINESS_STATES.NO_PUBLIC_GEOMETRY);
    expect(rowsFor(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'expired-route')).toEqual([]);
    // D4 still reports on its own terms, and D1 still counted the trip.
    expect((await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'expired-route')).state)
      .toBe(P6_READINESS_STATES.VERIFIED);
  }, 120_000);

  it('keeps only browser-bound geometry in IndexedDB', async () => {
    await localTripRepository.create(trip('browser-bound-a', { seed: 1, points: 160 }));
    await localTripRepository.create(trip('browser-bound-b', { seed: 2, points: 96 }));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const chunks = [...store(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).records.values()];
    const postings = [...store(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS).records.values()];
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((row) => row.sourceBinding === 'browser')).toBe(true);
    expect(postings.every((row) => row.sourceBinding === 'browser')).toBe(true);
    expect(postings.every((row) => String(row.key).startsWith('browser:'))).toBe(true);
  }, 120_000);
});
