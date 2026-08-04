import { describe, expect, it } from 'vitest';
import {
  calculateDrivingConsistency,
  computePersonalBaseline,
  PERSONAL_BASELINE_MIN_TRIPS,
} from '@/lib/tripInsights';
import { calculateFatigueScore, SCORING_VERSION } from '@/lib/tripEngine';

const DAY_MS = 24 * 60 * 60 * 1000;

const completedTrip = (score, overrides = {}) => ({
  status: 'completed',
  score_overall: score,
  score_version: SCORING_VERSION,
  distance_km: 10,
  start_time: new Date(Date.now() - DAY_MS).toISOString(),
  dominant_road_type: 'urban',
  ...overrides,
});

// Baselines only consider trips inside the trailing four-week window.
const recentTrip = (score, daysAgo) => completedTrip(score, {
  start_time: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
});

describe('zero-score trips are real data, not missing data', () => {
  it('keeps a floored 0 score in the personal baseline', () => {
    const goodTrips = Array.from(
      { length: PERSONAL_BASELINE_MIN_TRIPS },
      (_unused, index) => recentTrip(80, index + 1)
    );
    const withoutWorst = computePersonalBaseline(goodTrips);
    const withWorst = computePersonalBaseline([...goodTrips, recentTrip(0, 0)]);

    // The catastrophic trip must drag the baseline down rather than vanish from it.
    expect(withoutWorst.baseline_avg).toBe(80);
    expect(withWorst.baseline_avg).toBeLessThan(withoutWorst.baseline_avg);
  });

  it('counts a floored 0 score toward consistency spread', () => {
    const result = calculateDrivingConsistency([
      completedTrip(80),
      completedTrip(80),
      completedTrip(80),
      completedTrip(0),
    ]);

    expect(result.trip_count).toBe(4);
  });

  it('still ignores trips with no score at all', () => {
    const result = calculateDrivingConsistency([
      completedTrip(80),
      completedTrip(80),
      completedTrip(80),
      completedTrip(null),
      completedTrip(undefined),
    ]);

    expect(result.trip_count).toBe(3);
  });
});

describe('fatigue scoring uses the trip timezone, not the device timezone', () => {
  const routeAt = (isoTimestamp, utcOffsetMinutes) => ([
    { timestamp: isoTimestamp, utc_offset_minutes: utcOffsetMinutes, speed_kmh: 60 },
    { timestamp: isoTimestamp, utc_offset_minutes: utcOffsetMinutes, speed_kmh: 60 },
  ]);

  it('applies the late-night bucket using the recorded offset', () => {
    // 03:30 local in a UTC-4 zone: squarely inside the 02:00-05:00 fatigue window,
    // even though the same instant is 07:30 UTC and would look like daytime.
    const lateNight = calculateFatigueScore(1800, routeAt('2026-01-02T07:30:00.000Z', -240));
    const midMorning = calculateFatigueScore(1800, routeAt('2026-01-02T14:30:00.000Z', -240));

    expect(lateNight).toBeGreaterThan(midMorning);
  });

  it('scores the same instant differently when the recorded offset differs', () => {
    const instant = '2026-01-02T07:30:00.000Z';
    const drivenAtNight = calculateFatigueScore(1800, routeAt(instant, -240)); // 03:30 local
    const drivenMidday = calculateFatigueScore(1800, routeAt(instant, 240)); // 11:30 local

    expect(drivenAtNight).toBeGreaterThan(drivenMidday);
  });
});
