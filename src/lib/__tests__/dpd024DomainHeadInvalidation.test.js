import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async () => null), setJson: vi.fn(async () => {}), removeJson: vi.fn(async () => {}),
}));

const publishSpy = vi.fn();
vi.mock('@/lib/p7SourceChange', () => ({
  publishP7SourceChange: (...args) => publishSpy(...args),
  subscribeP7SourceChange: () => () => {},
  getP7SourceToken: () => 'token',
  resetP7SourceChangeForTests: () => {},
}));

import {
  P6_TRIP_DERIVED_STORES, P6_TRIP_SOURCE_STORE, localTripRepository, openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { readP6TripDomainReadiness, stepP6BrowserTripDerivedUpdate } from '@/lib/p6TripDerivedState';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

/**
 * DPD-024 -- the Dashboard kept showing a bounded aggregate after D1 had already
 * converged behind it, and only a process restart moved it.
 *
 * The invalidation channel was never the problem: `publishP7SourceChange` already
 * makes the query client drop everything under the `p7` key. Every publisher was a
 * trip-write path, so background convergence -- which writes derived state, not
 * trips -- had no way to say it had finished.
 *
 * The law: when a `:all` domain head actually transitions to VERIFIED, that is
 * published. Not on every turn, and not on an idempotent rewrite.
 */
describe('DPD-024 domain head promotion publishes a source change', () => {
  let indexedDb;
  let rows;

  beforeEach(() => {
    publishSpy.mockClear();
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (_name, _options, operation) => operation() },
    });
    rows = new Map();
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const seedAnalyticsWork = async (id) => {
    const trip = {
      id, status: 'completed', source_revision: '1',
      start_time: '2026-09-02T09:00:00.000Z', distance_km: 12, score_overall: 88,
      duration_seconds: 900,
      route_points: Array.from({ length: 24 }, (_, index) => ({
        lat: 43.65 + index * 0.0002, lng: -79.38 - index * 0.00015,
        timestamp: 1_756_200_000_000 + index * 1000, speed_kmh: 48, accuracy: 5,
      })),
    };
    rows.set(trip.id, trip);
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction(
      [P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK, P6_TRIP_DERIVED_STORES.MANIFESTS],
      'readwrite'
    );
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(trip);
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: trip.id, desiredRevision: '1', sourceHash: `hash-${id}`, desiredSeq: 1,
      disposition: 'UPSERT', dirtyDomains: [P6_DOMAIN_KEYS.ANALYTICS],
      state: 'DIRTY', cursor: null, updatedAt: 1,
    });
    // The global head starts incremental, which is the state a converging device
    // is actually in: subjects outstanding, head not yet VERIFIED.
    tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
      key: `${P6_DOMAIN_KEYS.ANALYTICS}:all`, domain: P6_DOMAIN_KEYS.ANALYTICS, subject: 'all',
      sourceBinding: 'browser', state: P6_READINESS_STATES.DIRTY, complete: false, updatedAt: 1,
    });
    await done(tx); db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 200; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({});
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
  };

  it('publishes exactly when the analytics head reaches VERIFIED', async () => {
    await seedAnalyticsWork('dpd024-trip');

    await drain();

    const analytics = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
    expect(analytics.state).toBe(P6_READINESS_STATES.VERIFIED);

    const reasons = publishSpy.mock.calls.map(([reason]) => reason);
    expect(reasons).toContain('p6_domain_head_verified');
  });

  it('does not publish again once the head is already VERIFIED', async () => {
    await seedAnalyticsWork('dpd024-trip');
    await drain();
    expect(publishSpy.mock.calls.map(([reason]) => reason)).toContain('p6_domain_head_verified');

    publishSpy.mockClear();
    // Nothing is dirty now, so further turns must be silent. A publisher that
    // fired every turn would invalidate the whole query cache continuously, which
    // is the polling loop this fix exists to avoid.
    await drain();

    expect(publishSpy.mock.calls.map(([reason]) => reason))
      .not.toContain('p6_domain_head_verified');
  });

  it('publishes only once the head is VERIFIED, never before', async () => {
    await seedAnalyticsWork('dpd024-trip');

    // Step one turn at a time and record, at each step, whether the head was
    // VERIFIED and whether a publish had happened. A conditional assertion could
    // pass vacuously, so this asserts the invariant over the whole sequence
    // instead: no publish may appear on any turn where the head is not yet
    // VERIFIED.
    let sawUnverifiedTurn = false;
    for (let turn = 0; turn < 200; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({});
      const head = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
      const published = publishSpy.mock.calls
        .map(([reason]) => reason)
        .includes('p6_domain_head_verified');

      if (head.state !== P6_READINESS_STATES.VERIFIED) {
        sawUnverifiedTurn = true;
        expect(published, `published on turn ${turn} while the head was ${head.state}`)
          .toBe(false);
      }
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }

    // The sequence must actually have passed through an unverified state, or the
    // assertion above never ran and this test proves nothing.
    expect(sawUnverifiedTurn, 'the head was VERIFIED from the first turn').toBe(true);
    expect(publishSpy.mock.calls.map(([reason]) => reason))
      .toContain('p6_domain_head_verified');
  });
});
