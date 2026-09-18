import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));

import {
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  localTripRepository,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  finalizeP6BrowserExplicitTripBuild,
  queryP6AnalyticsAggregate,
  queryP6AnalyticsDayBuckets,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { queryAchievementSurfaces } from '@/lib/tripQueryFacade';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { P7_COMPLETENESS, P7_UNAVAILABLE_CODES, p7EnvelopeViolations } from '@/lib/tripQueryContracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

/**
 * P7 Stage 2 — Q4 and Q5 read facades over the existing P6 D1 buckets.
 *
 * The buckets are built by the **real** P6 browser update path, so these assert
 * against a ledger the owner actually produced rather than against a hand-written
 * fixture, and the expected totals come from an independent fold over the seeded
 * trips.
 */

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});

const DAY = 86400000;
const BASE = Date.UTC(2026, 0, 5);

describe('P7 Q4 / Q5 — analytics read facades', () => {
  let indexedDb;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id));
      if (!trip) throw new Error('Trip not found');
      return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip) => {
    const id = String(trip.id);
    const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision);
    sequence += 1;
    rows.set(id, { ...trip, source_revision: String(nextRevision) });
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id,
      desiredRevision: String(nextRevision),
      sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence,
      disposition: 'UPSERT',
      dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY',
      cursor: null,
      updatedAt: Date.now(),
    });
    await done(tx);
    db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 500; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  /** Three completed trips, one per UTC day, plus one non-completed row. */
  const seed = async () => {
    for (let index = 0; index < 3; index += 1) {
      const startTime = new Date(BASE + index * DAY + 3600000).toISOString();
      await queue({
        id: `t-${index}`,
        status: 'completed',
        start_time: startTime,
        end_time: startTime,
        distance_km: 10 + index,
        duration_seconds: 1800,
        score_overall: 90,
        vehicle_id: 'veh-1',
      });
    }
    await queue({
      id: 'in-progress',
      status: 'in_progress',
      start_time: new Date(BASE + 3600000).toISOString(),
      distance_km: 99,
    });
    await drain();
  };

  it('serves the lifetime aggregate EXACT from the global bucket, with readiness verbatim', async () => {
    await seed();

    const result = await queryP6AnalyticsAggregate({ scope: 'global' });

    expect(result.unavailable).toBeUndefined();
    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(result.continuation).toBeNull();
    // Completed-only by construction: the in-progress row contributes nothing.
    expect(result.data.totals.completedCount).toBe(3);
    expect(result.data.totals.totalKm).toBeCloseTo(10 + 11 + 12, 6);
    // Q4 is one of the four paths allowed to carry P6 readiness, and it carries
    // the normalized owner object rather than a synthesized one.
    expect(result.p6Readiness.domain).toBe(P6_DOMAIN_KEYS.ANALYTICS);
    expect(result.p6Readiness.state).toBe(P6_READINESS_STATES.VERIFIED);
    expect(result.p6Readiness.complete).toBe(true);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  });

  it('serves a per-vehicle lifetime total from the vehicle bucket', async () => {
    await seed();

    const result = await queryP6AnalyticsAggregate({ scope: 'vehicle', vehicleId: 'veh-1' });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(result.data.totals.completedCount).toBe(3);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  });

  it('sums a bounded day range from the day buckets', async () => {
    await seed();

    const result = await queryP6AnalyticsAggregate({
      scope: 'global', fromMs: BASE, toMs: BASE + 2 * DAY,
    });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    // Half-open [from, to): the first two days only.
    expect(result.data.totals.completedCount).toBe(2);
    expect(result.data.totals.totalKm).toBeCloseTo(10 + 11, 6);
  });

  it('refuses a range wider than its output bound instead of truncating it', async () => {
    await seed();

    const result = await queryP6AnalyticsAggregate({
      scope: 'global', fromMs: BASE, toMs: BASE + 400 * DAY,
    });

    expect(result.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED);
    expect(result.data).toBeNull();
    // Q4 owns no continuation and must never manufacture a generic PARTIAL.
    expect(result.continuation).toBeNull();
    expect(result.completeness).not.toBe(P7_COMPLETENESS.PARTIAL);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  });

  it('reports a not-ready owner as OWNER_NOT_READY with no data and no zero', async () => {
    // Nothing built: the analytics domain has never reached VERIFIED.
    const result = await queryP6AnalyticsAggregate({ scope: 'global' });

    expect(result.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.OWNER_NOT_READY);
    expect(result.data).toBeNull();
    expect(result.p6Readiness.complete).toBe(false);
    expect(result.p6Readiness.state).toBe(P6_READINESS_STATES.REBUILD_REQUIRED);
    expect(p7EnvelopeViolations('Q4', result)).toEqual([]);
  });

  it('serves a day-bucket range EXACT, and PARTIAL with a real continuation when truncated', async () => {
    await seed();

    const full = await queryP6AnalyticsDayBuckets({ fromMs: BASE, toMs: BASE + 3 * DAY });
    expect(full.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(full.continuation).toBeNull();
    expect(full.data).toHaveLength(3);
    expect(full.data.map((entry) => entry.bucket?.completedCount ?? 0)).toEqual([1, 1, 1]);

    const truncated = await queryP6AnalyticsDayBuckets({
      fromMs: BASE, toMs: BASE + 3 * DAY, limit: 2,
    });
    expect(truncated.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    // A PARTIAL must name a real, advancing continuation.
    expect(truncated.continuation).toEqual({ fromMs: BASE + 2 * DAY, toMs: BASE + 3 * DAY });
    expect(truncated.data).toHaveLength(2);
    expect(p7EnvelopeViolations('Q5', truncated)).toEqual([]);

    const rest = await queryP6AnalyticsDayBuckets(truncated.continuation);
    expect(rest.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(rest.data).toHaveLength(1);
  });

  it('reports a day with no completed trip as an absent bucket, never as a zero measurement', async () => {
    await seed();

    const result = await queryP6AnalyticsDayBuckets({
      fromMs: BASE + 5 * DAY, toMs: BASE + 7 * DAY,
    });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(result.data.every((entry) => entry.bucket === null)).toBe(true);
  });
});

describe('P7 Q9 — achievement surfaces, scope-restricted', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('reports an unbuilt aggregate as OWNER_NOT_READY, never as zero badges', async () => {
    const result = await queryAchievementSurfaces({});

    expect(result.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.OWNER_NOT_READY);
    expect(result.data).toBeNull();
    // The verbatim owner object, not a synthesized one.
    expect(result.p6Readiness.domain).toBe(P6_DOMAIN_KEYS.ANALYTICS);
    expect(result.p6Readiness.complete).toBe(false);
    expect(p7EnvelopeViolations('Q9', result)).toEqual([]);
  });

  it('never reaches the two whole-history rebuild readers', async () => {
    const aggregates = await import('@/lib/achievementAggregates');
    const badges = vi.spyOn(aggregates, 'readAchievementBadges');
    const calibration = vi.spyOn(aggregates, 'readCalibrationProgressFromAggregates');

    await queryAchievementSurfaces({});

    expect(badges).not.toHaveBeenCalled();
    expect(calibration).not.toHaveBeenCalled();
  });
});
