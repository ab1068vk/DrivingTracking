import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => ({}) } }));
vi.mock('@/lib/localVehicleRepository', () => ({
  localVehicleRepository: { list: async () => null, getAllForReference: async () => null },
}));

import {
  DB_NAME,
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
  localTripRepository,
  openP6TripDerivedDatabase,
} from '@/lib/localTripRepository';
import {
  finalizeP6BrowserExplicitTripBuild,
  readP6AchievementStats,
  stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const done = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('transaction aborted'));
});

const empty = () => ({
  completedCount: 0, totalKm: 0, nightCount: 0, cleanTripCount: 0,
  noHarshTrips: 0, noRapidTrips: 0, noSharpTrips: 0, noSpeedingTrips: 0,
  routeReplayTrips: 0, longTrips: 0, cleanLongTrips: 0, cleanNightTrips: 0,
  highScoreTrips: 0, excellentScoreTrips: 0, cleanExcellentTrips: 0,
  smoothBrakeTrips: 0, distractionFreeTrips: 0, cruiseMasterTrips: 0,
  manoeuvreAlertFreeTrips: 0, scoreDistanceProduct: 0, scoreDistanceWeight: 0,
  carbonCo2SavedKg: 0, carbonEligibleTripCount: 0,
});

// Independent arithmetic/reference fold. It deliberately does not import the
// production achievement accumulator or the P6 reducer.
const reference = (rows, now) => {
  const stats = empty();
  const completed = [...rows.values()].filter((trip) => trip.status === 'completed');
  for (const trip of completed) {
    const clean = ['harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count',
      'speeding_events_count'].every((key) => (trip[key] || 0) === 0);
    const distance = typeof trip.distance_km === 'number' && Number.isFinite(trip.distance_km)
      ? trip.distance_km : 0;
    const scoreEligible = typeof trip.score_overall === 'number'
      && Number.isFinite(trip.score_overall) && distance > 0;
    stats.completedCount += 1; stats.totalKm += distance;
    if (trip.night_driving) stats.nightCount += 1;
    if (clean) stats.cleanTripCount += 1;
    if ((trip.harsh_brakes_count || 0) === 0) stats.noHarshTrips += 1;
    if ((trip.rapid_accel_count || 0) === 0) stats.noRapidTrips += 1;
    if ((trip.sharp_turns_count || 0) === 0) stats.noSharpTrips += 1;
    if ((trip.speeding_events_count || 0) === 0) stats.noSpeedingTrips += 1;
    if (trip.route_replay_available === true) stats.routeReplayTrips += 1;
    if ((trip.duration_seconds || 0) >= 3600) { stats.longTrips += 1; if (clean) stats.cleanLongTrips += 1; }
    if (clean && trip.night_driving) stats.cleanNightTrips += 1;
    if ((trip.score_overall || 0) >= 90) stats.highScoreTrips += 1;
    if ((trip.score_overall || 0) >= 95) { stats.excellentScoreTrips += 1; if (clean) stats.cleanExcellentTrips += 1; }
    if (trip.smooth_braking_ratio === 100) stats.smoothBrakeTrips += 1;
    if (trip.phone_use_score_available === true && trip.phone_use_risk === 'none') stats.distractionFreeTrips += 1;
    if (trip.band_label === 'excellent cruise') stats.cruiseMasterTrips += 1;
    if ((trip.close_proximity_count ?? 0) === 0) stats.manoeuvreAlertFreeTrips += 1;
    if (scoreEligible) { stats.scoreDistanceProduct += trip.score_overall * distance; stats.scoreDistanceWeight += distance; }
    if (typeof trip.co2_saved_kg === 'number' && Number.isFinite(trip.co2_saved_kg)) {
      stats.carbonCo2SavedKg += trip.co2_saved_kg; stats.carbonEligibleTripCount += 1;
    }
  }
  const recent = completed.sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)).slice(0, 10);
  const five = recent.slice(0, 5);
  const recentWeight = five.reduce((sum, trip) => sum + (
    typeof trip.score_overall === 'number' && Number.isFinite(trip.score_overall)
      && Number(trip.distance_km) > 0 ? Number(trip.distance_km) : 0), 0);
  const recentProduct = five.reduce((sum, trip) => sum + (
    typeof trip.score_overall === 'number' && Number.isFinite(trip.score_overall)
      && Number(trip.distance_km) > 0 ? trip.score_overall * Number(trip.distance_km) : 0), 0);
  return {
    ...stats,
    weekTripCount: completed.filter((trip) => Date.parse(trip.start_time) >= now - 7 * 86400000).length,
    weekHarshBrakes: completed.filter((trip) => Date.parse(trip.start_time) >= now - 7 * 86400000)
      .reduce((sum, trip) => sum + (trip.harsh_brakes_count || 0), 0),
    recentFiveCount: five.length,
    recentFiveAvg: recentWeight > 0 ? recentProduct / recentWeight : 0,
    avgScore: stats.scoreDistanceWeight > 0 ? stats.scoreDistanceProduct / stats.scoreDistanceWeight : 0,
    defensiveStreak: recent.length >= 10
      && recent.every((trip) => ['defensive', 'exemplary'].includes(trip.defensive_grade)),
    defensiveRecentCount: recent.filter((trip) => ['defensive', 'exemplary'].includes(trip.defensive_grade)).length,
  };
};

describe('P6 browser D1 independent oracle', () => {
  let indexedDb;
  let rows;
  let revision;
  let sequence;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb(); vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 4e9, usage: 0 }) } });
    rows = new Map(); revision = new Map(); sequence = 0;
    vi.spyOn(localTripRepository, 'getFullById').mockImplementation(async (id) => {
      const trip = rows.get(String(id)); if (!trip) throw new Error('Trip not found'); return structuredClone(trip);
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const queue = async (trip, disposition = 'UPSERT') => {
    const id = String(trip.id); const nextRevision = (revision.get(id) || 0) + 1;
    revision.set(id, nextRevision); sequence += 1;
    if (disposition === 'UPSERT') rows.set(id, { ...trip, source_revision: String(nextRevision) });
    else rows.delete(id);
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction([P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    if (disposition === 'UPSERT') tx.objectStore(P6_TRIP_SOURCE_STORE).put(rows.get(id));
    else tx.objectStore(P6_TRIP_SOURCE_STORE).delete(id);
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      tripId: id, desiredRevision: String(nextRevision), sourceHash: `hash-${id}-${nextRevision}`,
      desiredSeq: sequence, disposition, dirtyDomains: Object.values(P6_DOMAIN_KEYS),
      state: 'DIRTY', cursor: null, updatedAt: Date.now(),
    });
    await done(tx); db.close();
  };

  const drain = async () => {
    for (let turn = 0; turn < 500; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    const final = await finalizeP6BrowserExplicitTripBuild(false);
    expect(final).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
  };

  it('matches randomized insert, replacement, delete and replay with strict null semantics', async () => {
    const now = Date.parse('2026-08-20T12:37:00.000Z');
    let seed = 0x6d2b79f5;
    const random = () => { seed = Math.imul(seed ^ (seed >>> 15), seed | 1); seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61); return ((seed ^ (seed >>> 14)) >>> 0) / 4294967296; };
    for (let index = 0; index < 24; index += 1) {
      const start = now - Math.floor(random() * 12 * 86400000);
      await queue({
        id: `d1-${index}`, status: index % 9 === 0 ? 'draft' : 'completed',
        start_time: new Date(start).toISOString(), distance_km: 1 + Math.floor(random() * 30),
        score_overall: index % 7 === 0 ? null : index % 11 === 0 ? 0 : 70 + Math.floor(random() * 30),
        co2_saved_kg: index % 6 === 0 ? null : index % 10 === 0 ? 0 : Number((random() * 2).toFixed(3)),
        harsh_brakes_count: index % 4, rapid_accel_count: index % 3 === 0 ? 1 : 0,
        sharp_turns_count: index % 5 === 0 ? 1 : 0, speeding_events_count: index % 6 === 0 ? 1 : 0,
        night_driving: index % 3 === 0, duration_seconds: index % 4 === 0 ? 4000 : 900,
        route_replay_available: index % 2 === 0, smooth_braking_ratio: index % 5 === 0 ? 100 : 90,
        phone_use_score_available: true, phone_use_risk: index % 8 === 0 ? 'high' : 'none',
        band_label: index % 7 === 0 ? 'excellent cruise' : 'ordinary',
        close_proximity_count: index % 5 === 0 ? 1 : 0,
        defensive_grade: index < 12 ? 'defensive' : 'ordinary', route_points: [],
      });
    }
    await drain();

    for (const index of [2, 7, 13, 18]) {
      const prior = rows.get(`d1-${index}`);
      await queue({ ...prior, start_time: new Date(now - index * 1234567).toISOString(),
        distance_km: prior.distance_km + 3, score_overall: index === 7 ? null : 97,
        harsh_brakes_count: 0, defensive_grade: 'exemplary' });
    }
    for (const index of [1, 9, 17]) await queue({ id: `d1-${index}` }, 'TOMBSTONE');
    await drain();

    // Retention: the route payload expires but the scored fields do not, so the
    // independent fold must produce exactly the same totals afterwards.
    for (const index of [4, 11, 20]) {
      const retained = rows.get(`d1-${index}`);
      if (!retained) continue;
      await queue({
        ...retained,
        route_points: [],
        route_data_expired_at: '2026-08-21T00:00:00.000Z',
        route_data_retention_days: 30,
      });
    }
    await drain();

    // Restore: several subjects are replaced in one sweep, as a backup restore
    // replaces canonical rows.
    for (const index of [0, 5, 10, 15]) {
      const restored = rows.get(`d1-${index}`);
      if (!restored) continue;
      await queue({
        ...restored,
        distance_km: restored.distance_km + 7,
        score_overall: 84,
        co2_saved_kg: 1.25,
        night_driving: !restored.night_driving,
      });
    }
    await drain();

    // Replaying an already-applied current revision after a close/reopen must
    // replace the same contribution rather than inflate any bucket.
    const replay = structuredClone(rows.get('d1-3'));
    revision.set('d1-3', Number(replay.source_revision) - 1);
    await queue(replay);
    await drain();

    const actual = await readP6AchievementStats({ now });
    const expected = reference(rows, now);
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === 'number') expect(actual[key], key).toBeCloseTo(value, 9);
      else expect(actual[key], key).toBe(value);
    }

    const source = indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE);
    expect(source.records.size).toBe(rows.size);
  });

  it('demotes a corrupt verified aggregate instead of returning partial totals', async () => {
    await queue({ id: 'corrupt-d1', status: 'completed', start_time: '2026-08-20T10:00:00.000Z',
      distance_km: 5, score_overall: 90, co2_saved_kg: 1, route_points: [] });
    await drain();
    const db = await openP6TripDerivedDatabase();
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
    const row = await new Promise((resolve, reject) => { const request = store.get('browser:global:2');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    store.put({ ...row, payload: { corrupt: true } }); await done(tx); db.close();

    await expect(readP6AchievementStats({ now: Date.parse('2026-08-20T12:00:00Z') })).resolves.toBeNull();
    const manifests = indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.MANIFESTS);
    expect(manifests.records.get(`${P6_DOMAIN_KEYS.ANALYTICS}:all`)).toMatchObject({
      state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
    });
    expect(indexedDb.getStoreState(DB_NAME, P6_TRIP_SOURCE_STORE).records.has('corrupt-d1')).toBe(true);
  });

  it('handles late imports and out-of-order edits beyond the recent-ten window', async () => {
    const now = Date.parse('2026-08-20T12:00:00.000Z');
    for (let index = 0; index < 12; index += 1) {
      await queue({
        id: `ordered-${index}`, status: 'completed',
        start_time: new Date(now - index * 86400000).toISOString(),
        distance_km: 5, score_overall: 90 - index,
        harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0,
        speeding_events_count: 0, defensive_grade: 'defensive', route_points: [],
      });
    }
    await drain();
    const initial = await readP6AchievementStats({ now });

    // This canonical import is older than every member of the bounded recent
    // window. It contributes to all-time totals once without displacing a
    // recent row or changing the recent-five result.
    const late = {
      id: 'late-import', status: 'completed',
      start_time: new Date(now - 90 * 86400000).toISOString(),
      distance_km: 7, score_overall: 42,
      harsh_brakes_count: 1, rapid_accel_count: 0, sharp_turns_count: 0,
      speeding_events_count: 0, defensive_grade: 'ordinary', route_points: [],
    };
    await queue(late); await drain();
    const afterLate = await readP6AchievementStats({ now });
    expect(afterLate.completedCount).toBe(initial.completedCount + 1);
    expect(afterLate.recentFiveAvg).toBe(initial.recentFiveAvg);
    expect(afterLate.defensiveRecentCount).toBe(initial.defensiveRecentCount);

    // Replaying that import under a newer canonical revision replaces its one
    // contribution. An out-of-order edit of a former recent member moves it
    // behind the window and refills from the next canonical trip.
    await queue(late); await drain();
    await queue({ ...rows.get('ordered-0'),
      start_time: new Date(now - 120 * 86400000).toISOString(), score_overall: 10 });
    await drain();
    const actual = await readP6AchievementStats({ now });
    const expected = reference(rows, now);
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === 'number') expect(actual[key], key).toBeCloseTo(value, 9);
      else expect(actual[key], key).toBe(value);
    }
    expect(actual.completedCount).toBe(13);
  });
});
