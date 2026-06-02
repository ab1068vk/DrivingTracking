import { describe, expect, it } from 'vitest';
import {
  buildHabitProfile,
  computeAdaptiveHalfLife,
  scoreAutocorrelation,
} from '@/lib/habitProfile';

const completedTrip = (score, index, daySpacing = 1) => {
  const start = new Date(2026, 0, 1 + index * daySpacing, 8, 0, 0);
  return {
    status: 'completed',
    start_time: start.toISOString(),
    end_time: new Date(start.getTime() + 30 * 60000).toISOString(),
    score_overall: score,
    distance_km: 10,
  };
};

const makeSteadyTrips = ({ score = 82, count = 30 } = {}) => (
  Array.from({ length: count }, (_, index) => completedTrip(score, index))
);

const makeErraticTrips = ({ count = 30 } = {}) => {
  const scores = [
    90, 40, 65, 88, 52, 73, 35, 84, 58, 77,
    43, 96, 61, 70, 48, 81, 55, 92, 37, 68,
    50, 86, 46, 79, 57, 94, 41, 72, 63, 85,
  ];
  return scores.slice(0, count).map((score, index) => completedTrip(score, index));
};

describe('habit profile adaptive half-life', () => {
  it('scoreAutocorrelation returns 1 for identical flat sequences', () => {
    expect(scoreAutocorrelation([80, 80, 80, 80, 80, 80], 1)).toBeCloseTo(1);
  });

  it('scoreAutocorrelation returns near 0 for low-persistence score noise', () => {
    const scores = [49, 90, 72, 91, 38, 86, 57, 38, 39, 94, 93, 67, 62, 68, 71, 82];

    expect(Math.abs(scoreAutocorrelation(scores, 1))).toBeLessThan(0.4);
  });

  it('computeAdaptiveHalfLife returns a shorter window for erratic drivers', () => {
    const erratic = computeAdaptiveHalfLife(makeErraticTrips());
    const stable = computeAdaptiveHalfLife(makeSteadyTrips());

    expect(erratic).toBeLessThan(stable);
    expect(erratic).toBeGreaterThanOrEqual(7);
    expect(stable).toBeLessThanOrEqual(60);
  });

  it('computeAdaptiveHalfLife returns default when fewer than minimum trips exist', () => {
    expect(computeAdaptiveHalfLife([])).toBe(21);
    expect(computeAdaptiveHalfLife(makeErraticTrips({ count: 5 }))).toBe(21);
  });

  it('buildHabitProfile exposes adaptive halfLifeDays', () => {
    const profile = buildHabitProfile(makeSteadyTrips());

    expect(profile.halfLifeDays).toBe(60);
  });
});
