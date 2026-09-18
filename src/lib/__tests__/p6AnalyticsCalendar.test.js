import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settings = { value: {} };

vi.mock('@/lib/nativePlatform', async (importOriginal) => ({
  ...(await importOriginal()), isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/trackingStore', () => ({ localSettings: { get: () => settings.value } }));
vi.mock('@/lib/localVehicleRepository', () => ({ localVehicleRepository: { list: async () => null, getAllForReference: async () => null } }));

import {
  DB_NAME, P6_TRIP_DERIVED_STORES, TRIP_SCHEMA_VERSION, localTripRepository,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';
import {
  finalizeP6BrowserExplicitTripBuild, invalidateP6AnalyticsForSettings, readP6AchievementStats,
  readP6TripDomainReadiness, stepP6BrowserTripDerivedUpdate,
} from '@/lib/p6TripDerivedState';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const DAY = 24 * 60 * 60 * 1000;

const trip = (id, startIso, extra = {}) => ({
  id, status: 'completed',
  start_time: startIso,
  end_time: new Date(Date.parse(startIso) + 900_000).toISOString(),
  distance_km: 10, score_overall: 90, duration_seconds: 900,
  route_points: [],
  schema_version: TRIP_SCHEMA_VERSION, score_version: SCORING_VERSION, needs_rescore: false,
  defensive_driving_score: 90, brake_onset_sequence_count: 0, heading_deviation_available: true,
  heading_drift_beta_available: true, braking_efficiency_grade: 'smooth', overall_compliance_score: 95,
  dominant_road_type: 'urban', co2_saved_kg: 0.4, phone_use_score: 100, phone_use_risk: 'none',
  harsh_brakes_count: 0, rapid_accel_count: 0, sharp_turns_count: 0, speeding_events_count: 0,
  ...extra,
});

/**
 * P6-V07/V08 residue: calendar keying, clock advance, vehicle bucketing and
 * settings invalidation, all through the canonical owner and the production
 * D1 reader.
 */
describe('P6-V08 analytics calendar, clock and settings', () => {
  let indexedDb;

  beforeEach(() => {
    settings.value = {};
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const bucketKeys = () => [...indexedDb.getStoreState(DB_NAME, P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS)
    .records.keys()].sort();

  const drain = async () => {
    for (let turn = 0; turn < 600; turn += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    return finalizeP6BrowserExplicitTripBuild(false);
  };

  it('keys calendar buckets by the UTC instant, so a local DST shift cannot re-bucket a trip', async () => {
    // 2026-03-08T07:00Z is the North American spring-forward instant. Two trips
    // an hour apart across it share a UTC day and occupy distinct UTC hours.
    await localTripRepository.create(trip('before-dst', '2026-03-08T06:30:00.000Z'));
    await localTripRepository.create(trip('after-dst', '2026-03-08T07:30:00.000Z'));
    // And a trip that is the same local wall-clock hour on the next day.
    await localTripRepository.create(trip('next-day', '2026-03-09T07:30:00.000Z'));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const keys = bucketKeys();
    expect(keys).toContain('browser:utc-day:2026-03-08:2');
    expect(keys).toContain('browser:utc-day:2026-03-09:2');
    expect(keys).toContain('browser:utc-hour:2026-03-08T06:2');
    expect(keys).toContain('browser:utc-hour:2026-03-08T07:2');
    expect(keys).toContain('browser:utc-hour:2026-03-09T07:2');
    expect(keys).toContain('browser:global:2');
    // No local-time bucket exists at all, so no client offset or DST rule can
    // move a trip between buckets after it is published.
    expect(keys.some((key) => key.includes('local'))).toBe(false);

    const stats = await readP6AchievementStats({ now: Date.parse('2026-03-10T00:00:00Z') });
    expect(stats.completedCount).toBe(3);
    expect(stats.totalKm).toBeCloseTo(30, 9);
  }, 120_000);

  it('slides the rolling seven-day window with the clock without rebuilding anything', async () => {
    const base = Date.parse('2026-05-01T12:00:00.000Z');
    for (let index = 0; index < 6; index += 1) {
      await localTripRepository.create(trip(`window-${index}`, new Date(base + index * DAY).toISOString(), {
        harsh_brakes_count: index,
      }));
    }
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const keysAfterBuild = bucketKeys();

    const early = await readP6AchievementStats({ now: base + 5 * DAY + 3600_000 });
    expect(early.completedCount).toBe(6);
    expect(early.weekTripCount).toBe(6);
    expect(early.weekHarshBrakes).toBe(0 + 1 + 2 + 3 + 4 + 5);

    // Ten days later the same durable aggregates answer a different window.
    const late = await readP6AchievementStats({ now: base + 15 * DAY });
    expect(late.completedCount).toBe(6);
    expect(late.totalKm).toBeCloseTo(60, 9);
    expect(late.weekTripCount).toBe(0);
    expect(late.weekHarshBrakes).toBe(0);
    // Reading a different window is a read: it publishes nothing.
    expect(bucketKeys()).toEqual(keysAfterBuild);
  }, 120_000);

  it('moves a contribution between vehicle buckets without disturbing the totals', async () => {
    const created = await localTripRepository.create(
      trip('vehicle-move', '2026-06-01T10:00:00.000Z', { vehicle_id: 'car-a' }),
    );
    await localTripRepository.create(trip('no-vehicle', '2026-06-02T10:00:00.000Z'));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    expect(bucketKeys()).toContain('browser:vehicle:car-a:2');
    expect(bucketKeys()).toContain('browser:vehicle::2');
    const before = await readP6AchievementStats({ now: Date.parse('2026-06-05T00:00:00Z') });

    await localTripRepository.update(created.id, { vehicle_id: 'car-b' });
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    expect(bucketKeys()).toContain('browser:vehicle:car-b:2');
    // The old bucket is still addressable; what changed is its content, and the
    // whole-history totals are untouched by a pure re-bucketing.
    expect(bucketKeys()).toContain('browser:vehicle:car-a:2');
    const after = await readP6AchievementStats({ now: Date.parse('2026-06-05T00:00:00Z') });
    expect(after.completedCount).toBe(before.completedCount);
    expect(after.totalKm).toBeCloseTo(before.totalKm, 9);
    expect(after.avgScore).toBeCloseTo(before.avgScore, 9);
  }, 120_000);

  it('ranks the recent window by start time, not by insertion order', async () => {
    const base = Date.parse('2026-07-01T00:00:00.000Z');
    const order = [4, 0, 6, 2, 5, 1, 3];
    for (const index of order) {
      await localTripRepository.create(trip(`aging-${index}`, new Date(base + index * DAY).toISOString(), {
        score_overall: 50 + index * 5,
      }));
    }
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const stats = await readP6AchievementStats({ now: base + 10 * DAY });
    expect(stats.completedCount).toBe(7);
    expect(stats.recentFiveCount).toBe(5);
    // Newest five by start time are indexes 6..2, all with equal distance.
    expect(stats.recentFiveAvg).toBeCloseTo((80 + 75 + 70 + 65 + 60) / 5, 9);
    // Seven retained trips cannot satisfy a ten-trip streak, and a partial
    // window must never be reported as if it were the full one.
    expect(stats.defensiveStreak).toBe(false);
    expect(stats.defensiveRecentCount).toBeLessThanOrEqual(7);
  }, 120_000);

  it('rediscovers within bounded turns after a settings invalidation and returns the same totals', async () => {
    await localTripRepository.create(trip('settings-a', '2026-08-01T10:00:00.000Z'));
    await localTripRepository.create(trip('settings-b', '2026-08-02T10:00:00.000Z'));
    expect(await drain()).toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });
    const before = await readP6AchievementStats({ now: Date.parse('2026-08-05T00:00:00Z') });

    await invalidateP6AnalyticsForSettings('SETTINGS_OR_VEHICLE_CHANGED');
    const invalidated = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
    expect(invalidated.state).not.toBe(P6_READINESS_STATES.VERIFIED);
    // A revoked head is a refusal, never a stale answer.
    await expect(readP6AchievementStats({ now: Date.parse('2026-08-05T00:00:00Z') })).resolves.toBeNull();

    let turns = 0;
    for (; turns < 600; turns += 1) {
      const result = await stepP6BrowserTripDerivedUpdate({ explicit: true });
      expect(result.itemsWorked ?? 0).toBeLessThanOrEqual(512);
      if (result.state === 'IDLE' && result.hasMore === false) break;
    }
    expect(await finalizeP6BrowserExplicitTripBuild(false))
      .toMatchObject({ state: P6_READINESS_STATES.VERIFIED, complete: true });

    const after = await readP6AchievementStats({ now: Date.parse('2026-08-05T00:00:00Z') });
    expect(after.completedCount).toBe(before.completedCount);
    expect(after.totalKm).toBeCloseTo(before.totalKm, 9);
    expect(after.avgScore).toBeCloseTo(before.avgScore, 9);
  }, 120_000);
});
