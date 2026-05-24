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

  it('caps accumulated active fatigue at score 10', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 12));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 6), new Date(2026, 0, 2, 12), 6 * 3600),
    ]);

    expect(state.totalDrivingMinutes).toBe(360);
    expect(state.accumulatedFatigueMinutes).toBe(360);
    expect(state.cumulativeFatigueScore).toBe(10);
    vi.useRealTimers();
  });

  it('rest after the last trip reduces accumulated fatigue after 30 minutes', () => {
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

  it('credits long breaks between short trips', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 13, 15));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 8, 25), 25 * 60),
      trip(new Date(2026, 0, 2, 10, 25), new Date(2026, 0, 2, 10, 50), 25 * 60),
      trip(new Date(2026, 0, 2, 12, 50), new Date(2026, 0, 2, 13, 15), 25 * 60),
    ]);

    expect(state.totalDrivingMinutes).toBe(75);
    expect(state.accumulatedFatigueMinutes).toBe(36);
    expect(state.longestBreakMinutes).toBe(120);
    expect(state.fatigueLevel).toBe('low');
    vi.useRealTimers();
  });

  it('treats an immediate second-drive readiness state as moderate after 55 active minutes', () => {
    vi.setSystemTime(new Date(2026, 0, 2, 8, 55));
    const state = computeDailyFatigue([
      trip(new Date(2026, 0, 2, 8), new Date(2026, 0, 2, 8, 55), 55 * 60),
    ]);

    expect(state.accumulatedFatigueMinutes).toBe(55);
    expect(state.cumulativeFatigueScore).toBe(3.1);
    expect(state.fatigueLevel).toBe('moderate');
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
