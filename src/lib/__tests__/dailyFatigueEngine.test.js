import { describe, expect, it, vi } from 'vitest';
import { computeDailyFatigue, getTodayTrips } from '@/lib/dailyFatigueEngine';

const baseNow = new Date(2026, 0, 2, 18, 0, 0);

const trip = (start, end, durationSeconds, idleSeconds = 0) => ({
  status: 'completed',
  start_time: start.toISOString(),
  end_time: end.toISOString(),
  duration_seconds: durationSeconds,
  idle_time_seconds: idleSeconds,
});

describe('dailyFatigueEngine', () => {
  it('getTodayTrips returns only today trips', () => {
    vi.setSystemTime(baseNow);
    const today = trip(new Date(2026, 0, 2, 9), new Date(2026, 0, 2, 10), 3600);
    const yesterday = trip(new Date(2026, 0, 1, 9), new Date(2026, 0, 1, 10), 3600);

    expect(getTodayTrips([today, yesterday])).toEqual([today]);
    vi.useRealTimers();
  });

  it('returns score 0 with no trips', () => {
    expect(computeDailyFatigue([]).cumulativeFatigueScore).toBe(0);
  });

  it('durationFatigue is capped at 5 for 5+ hours of driving', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 12));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 6), new Date(2026, 0, 2, 12), 6 * 3600),
    ]);

    expect(state.totalDrivingMinutes).toBe(360);
    expect(state.cumulativeFatigueScore).toBe(5);
    vi.useRealTimers();
  });

  it('recoveryCredit reduces score after 60+ minutes of rest', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 14));
    const recent = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 13, 45), 5 * 3600),
    ]);
    const rested = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 12), 5 * 3600),
    ]);

    expect(rested.cumulativeFatigueScore).toBeLessThan(recent.cumulativeFatigueScore);
    vi.useRealTimers();
  });

  it('fatigueLevel is critical at score >= 7', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 18));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 12), 4 * 3600),
      trip(new Date(2026, 0, 2, 12, 10), new Date(2026, 0, 2, 15), 3 * 3600),
      trip(new Date(2026, 0, 2, 15, 10), new Date(2026, 0, 2, 17, 50), 2 * 3600),
      trip(new Date(2026, 0, 2, 17, 52), new Date(2026, 0, 2, 17, 58), 6 * 60),
      trip(new Date(2026, 0, 2, 17, 59), new Date(2026, 0, 2, 18), 60),
    ]);

    expect(state.fatigueLevel).toBe('critical');
    vi.useRealTimers();
  });

  it('warns before trip for high and critical fatigue', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 18));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 13), 5 * 3600),
      trip(new Date(2026, 0, 2, 13, 10), new Date(2026, 0, 2, 17, 50), 3 * 3600),
    ]);

    expect(state.shouldWarnBeforeTrip).toBe(true);
    vi.useRealTimers();
  });
});
