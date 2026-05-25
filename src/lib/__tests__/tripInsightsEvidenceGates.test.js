import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BEST_WINDOW_MIN_TRIPS,
  PERSONAL_PERCENTILE_MIN_WEEKS,
  buildDrivingCoachInsights,
  computePersonalBaseline,
} from '@/lib/tripInsights';

const trip = (startTime, score = 80, overrides = {}) => ({
  id: `trip-${startTime}`,
  status: 'completed',
  start_time: startTime,
  distance_km: 10,
  duration_seconds: 1800,
  score_overall: score,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  ...overrides,
});

describe('trip insight evidence gates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withholds personal percentile until enough recorded weeks exist', () => {
    vi.setSystemTime(new Date('2026-05-25T12:00:00.000Z'));

    const oneWeek = computePersonalBaseline([
      trip('2026-05-24T08:00:00.000Z', 88),
      trip('2026-05-23T08:00:00.000Z', 84),
    ]);
    const fourWeeks = computePersonalBaseline([
      trip('2026-05-24T08:00:00.000Z', 88),
      trip('2026-05-17T08:00:00.000Z', 84),
      trip('2026-05-10T08:00:00.000Z', 78),
      trip('2026-05-03T08:00:00.000Z', 72),
    ]);

    expect(PERSONAL_PERCENTILE_MIN_WEEKS).toBe(4);
    expect(oneWeek.percentile).toBeNull();
    expect(oneWeek.percentile_label).toBe('Percentile among your recorded weeks');
    expect(fourWeeks.weeks_analyzed).toBeGreaterThanOrEqual(PERSONAL_PERCENTILE_MIN_WEEKS);
    expect(fourWeeks.percentile).not.toBeNull();
  });

  it('requires minimum trips before selecting a best driving window', () => {
    const sparse = buildDrivingCoachInsights([
      trip('2026-05-24T08:00:00.000Z', 95),
      trip('2026-05-24T18:00:00.000Z', 70),
    ]);
    const sampled = buildDrivingCoachInsights([
      trip('2026-05-24T08:00:00.000', 95),
      trip('2026-05-23T08:00:00.000', 96),
      trip('2026-05-22T18:00:00.000', 82),
      trip('2026-05-21T18:00:00.000', 83),
      trip('2026-05-20T18:00:00.000', 84),
    ]);

    expect(BEST_WINDOW_MIN_TRIPS).toBe(3);
    expect(sparse.best_window).toBeNull();
    expect(sampled.best_window).toMatchObject({
      label: 'Evening',
      trips: 3,
    });
    expect(sampled.actions.some((action) => action.includes('(3 trips)'))).toBe(true);
  });
});
