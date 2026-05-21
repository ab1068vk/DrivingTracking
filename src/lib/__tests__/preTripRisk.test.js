import { describe, expect, it, vi } from 'vitest';
import { computePreTripRisk, deriveSignalGates, deriveWeights, PRE_TRIP_RISK_WEIGHTS } from '@/lib/preTripRisk';

const trip = (score, offsetDays = 0) => {
  const date = new Date(2026, 0, 10 - offsetDays, 12, 0, 0);
  return {
    status: 'completed',
    start_time: date.toISOString(),
    end_time: new Date(date.getTime() + 30 * 60000).toISOString(),
    score_overall: score,
  };
};

const profile = (patch = {}) => ({
  confidence: 0.6,
  allTimeAvgScore: 80,
  trendRisk: 20,
  timeBuckets: {
    Morning: { avgScore: 80, riskScore: 20, tripCount: 3, stdDev: 0, insufficient: false },
    Afternoon: { avgScore: 80, riskScore: 20, tripCount: 3, stdDev: 0, insufficient: false },
    Evening: { avgScore: 80, riskScore: 20, tripCount: 3, stdDev: 0, insufficient: false },
    Night: { avgScore: 20, riskScore: 80, tripCount: 3, stdDev: 0, insufficient: false },
  },
  dayOfWeek: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
    day,
    { avgScore: 80, riskScore: 20, tripCount: 2, insufficient: false },
  ])),
  hourlyRisk: {},
  recentAvgScore: 80,
  trendDelta: 0,
  fatigueOnsetMinutes: 60,
  ...patch,
});

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

  it('includes predictive route risk in readiness signals', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const state = computePreTripRisk(
      Array.from({ length: 6 }, (_, i) => trip(90, i + 1)),
      {},
      { fatigueLevel: 'low' },
      { predictiveRouteRisk: { riskScore: 80, riskLevel: 'high' } }
    );

    expect(state.signals.routeForecast).toBe(80);
    expect(state.topSignals.some((signal) => signal.key === 'routeForecast')).toBe(true);
    vi.useRealTimers();
  });

  it('does not downgrade late-night readiness to low risk', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 0, 45));
    const state = computePreTripRisk(
      Array.from({ length: 6 }, (_, i) => trip(92, i + 1)),
      {},
      { fatigueLevel: 'low' },
      { predictiveRouteRisk: { riskScore: 42, riskLevel: 'moderate' } }
    );

    expect(state.signals.timeOfDay).toBe(60);
    expect(state.signals.routeForecast).toBe(42);
    expect(state.compositeRisk).toBeGreaterThanOrEqual(40);
    expect(state.riskLevel).toBe('moderate');
    expect(state.readinessScore).toBeLessThanOrEqual(60);
    vi.useRealTimers();
  });

  it('raises readiness concern when the previous trip ended recently', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 13));
    const recentTrip = trip(92);
    recentTrip.end_time = new Date(2026, 0, 10, 12, 50).toISOString();

    const state = computePreTripRisk([recentTrip], {}, { fatigueLevel: 'low' });

    expect(state.signals.recentRest).toBe(80);
    expect(state.topSignals[0].key).toBe('recentRest');
    vi.useRealTimers();
  });
});

describe('computePreTripRisk - with habitProfile', () => {
  it('uses personalised time bucket risk when data is sufficient', () => {
    const state = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 23) }, profile());

    expect(state.signals.timeOfDay).toBe(80);
    expect(state.dataQuality.sufficientTimeData).toBe(true);
  });

  it('falls back to clock risk when bucket is insufficient', () => {
    const habitProfile = profile({
      confidence: 0.2,
      timeBuckets: {
        ...profile().timeBuckets,
        Night: { avgScore: 20, riskScore: 80, tripCount: 1, stdDev: 0, insufficient: true },
      },
    });
    const state = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 23) }, habitProfile);

    expect(state.signals.timeOfDay).toBe(60);
    expect(state.dataQuality.sufficientTimeData).toBe(false);
  });

  it('normalises weights to 1.0 when a bucket is insufficient', () => {
    const habitProfile = profile({
      timeBuckets: {
        ...profile().timeBuckets,
        Morning: { avgScore: 80, riskScore: 20, tripCount: 1, stdDev: 0, insufficient: true },
      },
    });
    const weights = deriveWeights(habitProfile, new Date(2026, 0, 10, 8));
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

    expect(total).toBeCloseTo(1, 3);
  });

  it('shifts signal gate floors for a high-scoring driver', () => {
    const gates = deriveSignalGates(profile({ allTimeAvgScore: 90 }));

    expect(gates.highFloor).toBeLessThan(65);
  });

  it('keeps no-profile calls identical to the baseline optional-argument path', () => {
    const trips = Array.from({ length: 6 }, (_, i) => trip(88, i + 1));
    const context = {
      now: new Date(2026, 0, 10, 12),
      predictiveRouteRisk: { riskScore: 42, riskLevel: 'moderate' },
    };
    const baseline = computePreTripRisk(trips, {}, { fatigueLevel: 'low' }, context);
    const noProfile = computePreTripRisk(trips, {}, { fatigueLevel: 'low' }, context, undefined);

    expect(noProfile.riskLevel).toBe(baseline.riskLevel);
    expect(noProfile.compositeRisk).toBe(baseline.compositeRisk);
  });
});
