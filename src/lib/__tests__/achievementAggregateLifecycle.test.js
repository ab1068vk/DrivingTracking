import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  liveTrips: [],
  pageCalls: 0,
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => fixture.storage.has(key) ? fixture.storage.get(key) : fallback),
  setJson: vi.fn(async (key, value) => { fixture.storage.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => { fixture.storage.delete(key); }),
}));

vi.mock('@/api/trips', () => ({
  tripService: {
    queryHistoryPage: vi.fn(async () => {
      fixture.pageCalls += 1;
      return { rows: fixture.liveTrips.map((trip) => ({ ...trip })), nextCursor: null };
    }),
  },
}));

vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn() }));

import {
  ACHIEVEMENT_AGGREGATE_KEY,
  invalidateAchievementAggregates,
  readAchievementBadges,
  readCalibrationProgressFromAggregates,
  rebuildAchievementAggregates,
} from '@/lib/achievementAggregates';

const completed = (id, distance, day) => ({
  id,
  status: 'completed',
  distance_km: distance,
  duration_seconds: 600,
  start_time: `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`,
  end_time: `2026-08-${String(day).padStart(2, '0')}T10:10:00.000Z`,
  score_overall: 90,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
});

describe('achievement aggregate deletion and retention lifecycle', () => {
  beforeEach(() => {
    fixture.storage.clear();
    fixture.liveTrips = [completed('a', 10, 18), completed('b', 20, 19), completed('c', 30, 20)];
    fixture.pageCalls = 0;
  });

  it('invalidates on deletion and bounded-rebuilds exact current progress and badges', async () => {
    await rebuildAchievementAggregates();
    expect(await readCalibrationProgressFromAggregates()).toEqual({ tripsAnalyzed: 3, kmAnalyzed: 60 });

    fixture.liveTrips = fixture.liveTrips.filter((trip) => trip.id !== 'c');
    const invalid = await invalidateAchievementAggregates('trip_deleted');
    expect(invalid.built).toBe(false);
    expect(fixture.storage.get(ACHIEVEMENT_AGGREGATE_KEY).built).toBe(false);

    const rebuilt = await readCalibrationProgressFromAggregates();
    expect(rebuilt).toEqual({ tripsAnalyzed: 2, kmAnalyzed: 30 });
    expect(fixture.pageCalls).toBeGreaterThan(1);

    fixture.liveTrips = [];
    await invalidateAchievementAggregates('trip_deleted');
    const badges = await readAchievementBadges();
    expect(badges.find((badge) => badge.id === 'first_drive')?.earned).toBe(false);
  });

  it('invalidates retention removal and rebuilds from surviving canonical rows only', async () => {
    await rebuildAchievementAggregates();
    fixture.liveTrips = [fixture.liveTrips[2]];
    await invalidateAchievementAggregates('trip_retention_expired');
    expect(await readCalibrationProgressFromAggregates()).toEqual({ tripsAnalyzed: 1, kmAnalyzed: 30 });
  });
});
