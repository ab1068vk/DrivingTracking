import { describe, expect, it } from 'vitest';
import { calculateDrivingConsistency } from '@/lib/tripInsights';

const trip = (score, roadType) => ({
  status: 'completed',
  score_overall: score,
  dominant_road_type: roadType,
});

describe('driving consistency', () => {
  it('does not over-penalize stop-and-go urban score spread', () => {
    const result = calculateDrivingConsistency([
      trip(5, 'urban'),
      trip(5, 'urban'),
      trip(40, 'urban'),
      trip(40, 'urban'),
    ]);

    expect(result.q1).toBe(5);
    expect(result.q3).toBe(40);
    expect(result.consistency_score).toBeGreaterThanOrEqual(50);
  });

  it('keeps highway consistency scoring aligned with narrower speed bands', () => {
    const result = calculateDrivingConsistency([
      trip(95, 'highway'),
      trip(95, 'highway'),
      trip(110, 'highway'),
      trip(110, 'highway'),
    ]);

    expect(result.q1).toBe(95);
    expect(result.q3).toBe(110);
    expect(result.consistency_score).toBeGreaterThanOrEqual(70);
  });
});
