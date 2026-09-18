import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localTripRepository } from '@/lib/localTripRepository';
import { P7_REDUCER_IDENTITIES, P7_UNAVAILABLE_CODES, P7_COMPLETENESS } from '@/lib/tripQueryContracts';
import {
  P7_REDUCER_IMPLEMENTATIONS,
  queryTripReducer,
  runTripReducerToExact,
} from '@/lib/tripQueryReducers';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';
import { observeIndexedDb } from './helpers/p7IndependentObservers';

/**
 * P7 Stage 2 — Q10: the named, versioned, deterministic reducers.
 *
 * Every terminal result is compared against an **independent fold** written
 * here, over the same seeded trips. The oracle deliberately does not import a
 * reducer, so a shared arithmetic bug cannot make both sides agree.
 */

let observer;

const installStorage = () => {
  const fake = new FakeIndexedDb();
  observer = observeIndexedDb(fake);
  vi.stubGlobal('indexedDB', observer.factory);
  const values = new Map([[
    'drivesense_settings',
    JSON.stringify({
      settings_defaults_version: 11,
      data_retention_days: 3650,
      raw_gps_retention_days: 3650,
      privacy_zones: [],
    }),
  ]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
};

const DAY = 86400000;
const BASE = Date.UTC(2026, 3, 6, 12);

/** Deterministic, varied fixtures: some clean, some not, one passenger trip. */
const fixture = (index) => ({
  id: `red-${String(index).padStart(2, '0')}`,
  status: 'completed',
  start_time: new Date(BASE + index * DAY).toISOString(),
  end_time: new Date(BASE + index * DAY + 1800000).toISOString(),
  distance_km: 10 + index,
  duration_seconds: 1200 + index * 60,
  score_overall: 70 + (index % 5) * 5,
  score_safety: 60 + (index % 4) * 10,
  score_smoothness: 65 + (index % 3) * 10,
  harsh_brakes_count: index % 3 === 0 ? 0 : 1,
  rapid_accel_count: index % 4 === 0 ? 0 : 2,
  sharp_turns_count: 0,
  speeding_events_count: index % 5 === 0 ? 0 : 1,
  night_driving: index % 2 === 0,
  route_points: [{ lat: 43.6, lng: -79.4 }],
  // Every third trip is a passenger trip: it is completed, but it is NOT
  // driver-eligible, which is what separates P-COMPLETED from P-DRIVER.
  ...(index % 3 === 2 ? { passenger_trip: true } : {}),
});

const seed = async (count) => {
  const trips = [];
  for (let index = 0; index < count; index += 1) {
    const trip = fixture(index);
    await localTripRepository.create(trip);
    trips.push(trip);
  }
  return trips;
};

const driverEligible = (trip) => trip.passenger_trip !== true;

describe('P7 Q10 — registry integrity', () => {
  it('implements exactly the sixteen frozen identities and no others', () => {
    expect(Object.keys(P7_REDUCER_IMPLEMENTATIONS).sort())
      .toEqual([...P7_REDUCER_IDENTITIES].sort());
  });

  it('gives every reducer a declared population and a fixed-size accumulator', () => {
    for (const [identity, implementation] of Object.entries(P7_REDUCER_IMPLEMENTATIONS)) {
      expect(implementation.population, identity).toBeTruthy();
      const empty = implementation.init({ days: [], months: [] });
      expect(empty, identity).toBeTypeOf('object');
      // No reducer may seed itself with a collection that grows with history.
      for (const [field, value] of Object.entries(empty)) {
        if (!Array.isArray(value)) continue;
        expect(value.length, `${identity}.${field}`).toBeLessThanOrEqual(31);
      }
    }
  });
});

describe('P7 Q10 — bounded turns and continuation', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('performs one bounded turn per invocation and only reaches EXACT at terminal EOF', async () => {
    await seed(7);

    observer.reset();
    const first = await queryTripReducer({ reducer: 'p7.report.eventTotals@1', limit: 3 });

    expect(first.completeness).toBe(P7_COMPLETENESS.PARTIAL);
    expect(first.continuation).not.toBeNull();
    // A PARTIAL accumulation is reported as partial, never as a total.
    expect(first.data.partial).toBeDefined();
    expect(observer.counts.sourceRowsVisited).toBeLessThanOrEqual(3 + 1);
    expect(observer.counts.wholeStoreGetAlls).toBe(0);

    const final = await runTripReducerToExact({ reducer: 'p7.report.eventTotals@1', limit: 3 });
    expect(final.completeness).toBe(P7_COMPLETENESS.EXACT);
    expect(final.continuation).toBeNull();
    expect(final.data.partial).toBeUndefined();
  });

  it('keeps the continuation fixed in size as history grows', async () => {
    await seed(4);
    const small = await queryTripReducer({ reducer: 'p7.report.eventTotals@1', limit: 2 });

    await seed(20);
    const large = await queryTripReducer({ reducer: 'p7.report.eventTotals@1', limit: 2 });

    // The accumulator is fixed in N, so the token does not grow with history.
    const drift = Math.abs(large.continuation.length - small.continuation.length);
    expect(drift).toBeLessThan(80);
  });

  it('refuses an unknown reducer and a wrong version rather than improvising', async () => {
    await seed(2);

    const unknown = await queryTripReducer({ reducer: 'p7.report.madeUp@1' });
    expect(unknown.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.REDUCER_UNKNOWN);
    expect(unknown.data).toBeNull();

    const wrongVersion = await queryTripReducer({ reducer: 'p7.report.eventTotals', version: 9 });
    expect(wrongVersion.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.REDUCER_VERSION_MISMATCH);
    expect(wrongVersion.data).toBeNull();
  });

  it('discards an accumulator whose snapshot moved, never merging across snapshots', async () => {
    await seed(6);
    const first = await queryTripReducer({ reducer: 'p7.report.eventTotals@1', limit: 2 });

    // A row-set-relevant mutation between turns.
    await localTripRepository.create({
      ...fixture(99),
      id: 'red-late',
    });

    const stale = await queryTripReducer({
      reducer: 'p7.report.eventTotals@1', limit: 2, continuation: first.continuation,
    });

    expect(stale.unavailable?.code).toBe(P7_UNAVAILABLE_CODES.ACCUMULATOR_SNAPSHOT_MISMATCH);
    expect(stale.data).toBeNull();
  });

  it('refuses a tampered continuation', async () => {
    await seed(6);
    const first = await queryTripReducer({ reducer: 'p7.report.eventTotals@1', limit: 2 });
    const tampered = `${first.continuation.slice(0, -6)}AAAAAA`;

    const refused = await queryTripReducer({
      reducer: 'p7.report.eventTotals@1', limit: 2, continuation: tampered,
    });

    expect([
      P7_UNAVAILABLE_CODES.CURSOR_MALFORMED,
      P7_UNAVAILABLE_CODES.ACCUMULATOR_SNAPSHOT_MISMATCH,
    ]).toContain(refused.unavailable?.code);
    expect(refused.data).toBeNull();
  });
});

describe('P7 Q10 — terminal results against an independent oracle', () => {
  beforeEach(() => { installStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('eventTotals folds the P-DRIVER population, not every completed trip', async () => {
    const trips = await seed(9);
    const eligible = trips.filter(driverEligible);

    const result = await runTripReducerToExact({ reducer: 'p7.report.eventTotals@1', limit: 4 });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    // The passenger trips are completed but not driver-eligible.
    expect(eligible.length).toBeLessThan(trips.length);
    expect(result.data.completed_count).toBe(eligible.length);
    expect(result.data.harsh_brakes)
      .toBe(eligible.reduce((sum, trip) => sum + trip.harsh_brakes_count, 0));
    expect(result.data.speeding_events)
      .toBe(eligible.reduce((sum, trip) => sum + trip.speeding_events_count, 0));
    // The Report clean predicate: the four primary counters all zero.
    expect(result.data.report_clean_trip_count).toBe(eligible.filter((trip) => (
      trip.harsh_brakes_count === 0 && trip.rapid_accel_count === 0
      && trip.sharp_turns_count === 0 && trip.speeding_events_count === 0
    )).length);
  });

  it('durationDistance keeps the plain and distance-weighted means separate', async () => {
    const trips = await seed(8);
    const eligible = trips.filter(driverEligible);

    const result = await runTripReducerToExact({ reducer: 'p7.report.durationDistance@1', limit: 3 });

    expect(result.data.trip_count).toBe(eligible.length);
    expect(result.data.distance_m)
      .toBeCloseTo(eligible.reduce((sum, trip) => sum + trip.distance_km * 1000, 0), 6);
    expect(result.data.duration_ms)
      .toBeCloseTo(eligible.reduce((sum, trip) => sum + trip.duration_seconds * 1000, 0), 6);
    // Plain mean inputs.
    expect(result.data.score_sum)
      .toBeCloseTo(eligible.reduce((sum, trip) => sum + trip.score_overall, 0), 6);
    expect(result.data.score_count).toBe(eligible.length);
    // Distance-weighted inputs, accumulated separately and never substituted.
    expect(result.data.score_distance_product)
      .toBeCloseTo(eligible.reduce((sum, trip) => sum + trip.score_overall * trip.distance_km, 0), 6);
    expect(result.data.score_distance_weight)
      .toBeCloseTo(eligible.reduce((sum, trip) => sum + trip.distance_km, 0), 6);
  });

  it('nightExposure reads the stored classification rather than re-deriving it', async () => {
    const trips = await seed(8);
    const eligible = trips.filter(driverEligible);
    const nights = eligible.filter((trip) => trip.night_driving);

    const result = await runTripReducerToExact({ reducer: 'p7.report.nightExposure@1', limit: 3 });

    expect(result.data.night_trip_count).toBe(nights.length);
    expect(result.data.night_duration_ms)
      .toBeCloseTo(nights.reduce((sum, trip) => sum + trip.duration_seconds * 1000, 0), 6);
  });

  it('dashboard activityStats counts distinct local days in fixed space', async () => {
    const trips = await seed(6);

    const result = await runTripReducerToExact({ reducer: 'p7.dashboard.activityStats@1', limit: 2 });

    // Population is P-COMPLETED here, so passenger trips DO count.
    expect(result.data.trip_count).toBe(trips.length);
    // One trip per day in the fixture, so distinct local days equals the count.
    expect(result.data.active_local_days).toBe(trips.length);
    expect(result.data.longest_trip_distance_m)
      .toBeCloseTo(Math.max(...trips.map((trip) => trip.distance_km)) * 1000, 6);
  });

  it('history filteredTotals reports truthful totals for the whole scan', async () => {
    const trips = await seed(5);

    const result = await runTripReducerToExact({ reducer: 'p7.history.filteredTotals@1', limit: 2 });

    expect(result.data.count).toBe(trips.length);
    expect(result.data.distance)
      .toBeCloseTo(trips.reduce((sum, trip) => sum + trip.distance_km, 0), 6);
  });

  it('scoreMigrationSummary returns a bounded preview, never a per-trip array', async () => {
    await seed(12);

    const result = await runTripReducerToExact({
      reducer: 'p7.settings.scoreMigrationSummary@1',
      limit: 5,
      context: { scoring_version: 'v-current', recentCutoffMs: BASE },
    });

    expect(result.completeness).toBe(P7_COMPLETENESS.EXACT);
    // Every seeded trip carries no score_version, so all of them mismatch.
    expect(result.data.mismatch_count).toBe(12);
    // The output is fixed in size whatever the mismatch count.
    expect(result.data.mismatch_preview.length).toBeLessThanOrEqual(4);
    expect(result.data.has_unknown_legacy_unrescored).toBe(true);
    expect(result.data.trips).toBeUndefined();
    for (const item of result.data.mismatch_preview) {
      expect(Object.keys(item).sort()).toEqual(['id', 'nickname', 'scoring_version', 'start_time']);
    }
  });

  it('produces the same terminal result whatever the page size', async () => {
    await seed(10);

    const onePage = await runTripReducerToExact({ reducer: 'p7.report.eventTotals@1', limit: 200 });
    const manyPages = await runTripReducerToExact({ reducer: 'p7.report.eventTotals@1', limit: 2 });

    // Associativity across page boundaries, asserted rather than assumed.
    expect(manyPages.data).toEqual(onePage.data);
  });
});
