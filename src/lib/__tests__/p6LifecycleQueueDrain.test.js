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
  finalizeP6BrowserExplicitTripBuild, listP6BrowserCanonicalSubjectPage,
  queryP6GeometryPreviewPage, queueP6ExplicitTripSubjects, readP6TripDomainReadiness,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

/**
 * DPD-009 — a compatibility-required subject must not stop the queue.
 *
 * `routePage` refuses a legacy inline `route_points` array on any non-explicit
 * pass; that gate is deliberate, because legacy inline routes are read only by
 * an explicit operation. The defect was the consequence at the call site: the
 * turn returned `hasMore: false`, and the coordinator reads that as "the queue
 * is finished", not "this subject is finished". One legacy-shaped trip at the
 * head of `by_desired_seq` therefore stopped the drain for every trip behind
 * it, on every launch.
 *
 * Every backup-restored history is legacy-shaped throughout, which is why an
 * imported history never converged and the Dashboard's lifetime totals never
 * arrived — measured on an A54 at 20 trips as `p6_source_applied = 1 / 20`,
 * unchanged across six cold launches.
 *
 * These tests drive the **lifecycle** stepper (`explicit: false`, the shape
 * `appLifecycleWork` calls) over a queue whose head is compatibility-required,
 * and assert the observable queue result rather than one turn's `hasMore`.
 */

const route = (seed, count) => Array.from({ length: count }, (_, index) => ({
  lat: 43.6 + seed * 0.01 + index * 0.00022,
  lng: -79.4 - seed * 0.01 - index * 0.00019,
  timestamp: 1_756_000_000_000 + seed * 86_400_000 + index * 1000,
  speed_kmh: 44, accuracy: 6, speed_limit_kmh: 60, speed_limit_source: 'osm',
}));

const trip = (id, { seed = 0, points = 64, ...extra } = {}) => ({
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

describe('DPD-009 lifecycle queue drains past a compatibility-required subject', () => {
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
  const record = (name, key) => store(name)?.records.get(key) || null;
  const workState = (tripId) => record(P6_TRIP_DERIVED_STORES.WORK, tripId)?.state || null;
  /** The D1 receipt the device metric `p6_source_applied` counts. */
  const analyticsApplied = (tripId) => Boolean(record(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED, `D1:browser:${tripId}`));

  /**
   * Turn the lifecycle crank the way the coordinator does: stop when a turn
   * reports the queue finished. `states` is the per-turn trace, so a subject
   * that retried forever shows up as a repeat rather than as a timeout.
   */
  const runLifecycleTurns = async (maxTurns = 400) => {
    const states = [];
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate();
      states.push(result.state);
      if (result.hasMore !== true) return { states, exhausted: false, last: result };
    }
    return { states, exhausted: true, last: null };
  };

  /**
   * Three trips, ordered so the compatibility-required one is at the head of
   * `by_desired_seq` (ties there fall back to the primary key, the trip id).
   * The tail trip is summary-only, so it has no public geometry and completes
   * entirely on the lifecycle path — it is the proof that the queue reaches
   * ordinary work behind the blocked head, not merely that it moved.
   */
  const seedQueue = async () => {
    await localTripRepository.create(trip('a-legacy-head', { seed: 1 }));
    await localTripRepository.create(trip('b-legacy-second', { seed: 2 }));
    await localTripRepository.create(trip('c-summary-only', { seed: 3, privacy_mode: 'summary_only' }));
  };

  it('publishes every queued subject instead of stopping at the legacy head', async () => {
    await seedQueue();

    const { states, exhausted } = await runLifecycleTurns();

    // The head must not be able to end the queue by itself.
    expect(exhausted).toBe(false);
    expect(states.filter((state) => state === 'EXPLICIT_LEGACY_SOURCE_REQUIRED')).toHaveLength(2);

    // The observable result: D1 applied for all three, not 1 of 3.
    expect(analyticsApplied('a-legacy-head')).toBe(true);
    expect(analyticsApplied('b-legacy-second')).toBe(true);
    expect(analyticsApplied('c-summary-only')).toBe(true);

    // And no work row is left drainable, so the queue is genuinely finished.
    expect(workState('a-legacy-head')).toBe('EXPLICIT_SOURCE_REQUIRED');
    expect(workState('b-legacy-second')).toBe('EXPLICIT_SOURCE_REQUIRED');
    expect(workState('c-summary-only')).toBe('COMPLETE');
  });

  it('leaves the legacy subject explicitly unbuilt rather than silently derived', async () => {
    await seedQueue();
    await runLifecycleTurns();

    for (const tripId of ['a-legacy-head', 'b-legacy-second']) {
      for (const domain of [P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION,
        P6_DOMAIN_KEYS.ROAD_LEARNING]) {
        const readiness = await readP6TripDomainReadiness(domain, tripId);
        expect(readiness.state, `${domain}:${tripId}`).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
        expect(readiness.complete).not.toBe(true);
        expect(readiness.reason).toBe('EXPLICIT_LEGACY_SOURCE_REQUIRED');
      }
    }

    // The trip behind the head is ordinary work and really is finished.
    const tail = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'c-summary-only');
    expect(tail.state).toBe(P6_READINESS_STATES.NO_PUBLIC_GEOMETRY);
    expect(tail.complete).toBe(true);
  });

  it('converges D1 while D2 keeps saying it owes an explicit rebuild', async () => {
    await seedQueue();
    await runLifecycleTurns();

    // Lifetime totals read D1's head. Draining past the legacy subject is what
    // lets it reach VERIFIED without the explicit repair.
    const analytics = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
    expect(analytics.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(analytics.complete).toBe(true);

    // D2 must not be promoted alongside it: its coverage now has a hole, and
    // claiming otherwise would withdraw the legal v1 compatibility route that
    // still serves those trips' geometry.
    const geometry = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all');
    expect(geometry.state).not.toBe(P6_READINESS_STATES.VERIFIED);
    const page = await queryP6GeometryPreviewPage({ maxTrips: 40 });
    expect(page.available).toBe(false);
    expect(page.compatibilityAllowed).toBe(true);
  });

  it('is idempotent across launches — repeated turns do no further work', async () => {
    await seedQueue();
    const first = await runLifecycleTurns();

    const second = await runLifecycleTurns();
    expect(second.exhausted).toBe(false);
    // A parked subject is never re-read, so a later launch finds nothing to do.
    expect(second.states).not.toContain('EXPLICIT_LEGACY_SOURCE_REQUIRED');
    expect(second.states.length).toBeLessThan(first.states.length);
    expect(second.last.hasMore).toBe(false);

    expect(workState('a-legacy-head')).toBe('EXPLICIT_SOURCE_REQUIRED');
    const geometry = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'a-legacy-head');
    expect(geometry.state).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
  });

  it('still lets the explicit repair rebuild the parked subject afterwards', async () => {
    await seedQueue();
    await runLifecycleTurns();

    // What E2's DISCOVER phase does: walk canonical source and re-mint work.
    const page = await listP6BrowserCanonicalSubjectPage({ maxItems: 32 });
    await queueP6ExplicitTripSubjects(page.rows);
    for (let turn = 0; turn < 900; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const finalized = await finalizeP6BrowserExplicitTripBuild(false);
    expect(finalized.pending).toBe(0);

    for (const tripId of ['a-legacy-head', 'b-legacy-second']) {
      const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, tripId);
      expect(readiness.state, tripId).toBe(P6_READINESS_STATES.VERIFIED);
      expect(readiness.complete).toBe(true);
    }
    const geometryHead = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all');
    expect(geometryHead.state).toBe(P6_READINESS_STATES.VERIFIED);
  });
});
