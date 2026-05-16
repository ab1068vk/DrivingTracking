import { describe, expect, it, vi } from 'vitest';
import { computePreTripRisk, PRE_TRIP_RISK_WEIGHTS } from '@/lib/preTripRisk';

const trip = (score, offsetDays = 0) => {
  const date = new Date(2026, 0, 10 - offsetDays, 12, 0, 0);
  return {
    status: 'completed',
    start_time: date.toISOString(),
    end_time: new Date(date.getTime() + 30 * 60000).toISOString(),
    score_overall: score,
  };
};

describe('preTripRisk', () => {
  it('returns low risk with all-good signals', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const state = computePreTripRisk(Array.from({ length: 6 }, (_, i) => trip(95, i)), {}, { fatigueLevel: 'low' });
    expect(state.riskLevel).toBe('low');
    vi.useRealTimers();
  });

  it('dailyFatigueState critical drives high composite risk', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 23));
    const state = computePreTripRisk([trip(20)], {}, { fatigueLevel: 'critical' });
    expect(state.riskLevel).toBe('high');
    vi.useRealTimers();
  });

  it('signal weights sum to 1.0', () => {
    const total = Object.values(PRE_TRIP_RISK_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('readinessScore is 100 minus compositeRisk', () => {
    const state = computePreTripRisk([]);
    expect(state.readinessScore).toBe(100 - state.compositeRisk);
  });

  it('handles empty trips gracefully', () => {
    expect(() => computePreTripRisk([])).not.toThrow();
  });

  it('primaryConcern follows the highest signal risk', () => {
    const state = computePreTripRisk([trip(95)], {}, { fatigueLevel: 'critical' });
    expect(state.primaryConcern).toBe('High daily fatigue accumulation');
  });
});
