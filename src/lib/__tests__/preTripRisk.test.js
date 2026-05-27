import { describe, expect, it, vi } from 'vitest';
import {
  PRE_TRIP_RISK_WEIGHTS,
  PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO,
  PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS,
  computePreTripRisk,
  deriveSignalGates,
  deriveWeights,
} from '@/lib/preTripRisk';
import { getFallbackTimeRisk } from '@/lib/habitProfile';
import { estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
import { isEveningRushHour, isNightRiskHour } from '@/lib/appConstants';

const trip = (score, offsetDays = 0) => {
  const date = new Date(2026, 0, 10 - offsetDays, 12, 0, 0);
  return {
    status: 'completed',
    start_time: date.toISOString(),
    end_time: new Date(date.getTime() + 30 * 60000).toISOString(),
    distance_km: 10,
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
  it('does not use shared clock-risk fallback for pre-trip readiness', () => {
    const atSixPm = new Date(2026, 0, 10, 18);
    const atSevenPm = new Date(2026, 0, 10, 19);
    const preTripAtSix = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: atSixPm });
    const routeHistory = [{ ...trip(80), distance_km: 10 }];
    const routeAtSix = estimatePredictiveRouteRisk({ trips: routeHistory, now: atSixPm });
    const routeAtSeven = estimatePredictiveRouteRisk({ trips: routeHistory, now: atSevenPm });

    expect(isEveningRushHour(18)).toBe(true);
    expect(isEveningRushHour(19)).toBe(false);
    expect(getFallbackTimeRisk(18)).toBe(40);
    expect(preTripAtSix.signals.timeOfDay).toBeNull();
    expect(preTripAtSix.readinessScore).toBeNull();
    expect(routeAtSix.riskScore).toBeGreaterThan(routeAtSeven.riskScore);
  });

  it('uses the shared overnight window boundary', () => {
    expect(isNightRiskHour(22)).toBe(true);
    expect(isNightRiskHour(4)).toBe(true);
    expect(isNightRiskHour(5)).toBe(false);
  });

  it('returns low risk with all-good signals', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const state = computePreTripRisk(Array.from({ length: 6 }, (_, i) => trip(95, i)), {}, { fatigueLevel: 'low' }, {}, profile());
    expect(state.riskLevel).toBe('low');
    vi.useRealTimers();
  });

  it('dailyFatigueState critical drives high composite risk', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 23));
    const state = computePreTripRisk([trip(20)], {}, { fatigueLevel: 'critical' }, {}, profile({ allTimeAvgScore: 70 }));
    expect(state.riskLevel).toBe('high');
    vi.useRealTimers();
  });

  it('signal weights sum to 1.0', () => {
    const total = Object.values(PRE_TRIP_RISK_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('readinessScore is 100 minus compositeRisk', () => {
    const state = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 12) }, profile());
    expect(state.readinessScore).toBe(100 - state.compositeRisk);
  });

  it('suppresses readiness score when core personal signals are unavailable', () => {
    const state = computePreTripRisk([], {}, { fatigueLevel: 'critical' }, { now: new Date(2026, 0, 10, 2) });

    expect(state.compositeRisk).toBeNull();
    expect(state.readinessScore).toBeNull();
    expect(state.dataQuality.readinessEvidence).toBe('unavailable');
    expect(state.dataQuality.missingCoreSignals).toEqual(['timeOfDay', 'recentTrend']);
    expect(state.dataQuality.fallbackSignalCount).toBeGreaterThan(1);
    expect(state.dataQuality.fallbackGateTriggered).toBe(true);
  });

  it('returns unavailable when more than one personal readiness signal would be fallback data', () => {
    const state = computePreTripRisk(
      Array.from({ length: 3 }, (_, i) => trip(88, i + 1)),
      {},
      { fatigueLevel: 'low' },
      { now: new Date(2026, 0, 10, 12) }
    );

    expect(state.dataQuality.fallbackSignalKeys).toEqual(expect.arrayContaining(['dayOfWeek', 'recentTrend']));
    expect(state.dataQuality.fallbackSignalKeys).not.toContain('timeOfDay');
    expect(state.dataQuality.fallbackSignalCount).toBeGreaterThan(1);
    expect(state.dataQuality.fallbackGateTriggered).toBe(true);
    expect(state.compositeRisk).toBeNull();
    expect(state.readinessScore).toBeNull();
    expect(state.riskLevel).toBe('unavailable');
  });

  it('handles empty trips gracefully', () => {
    expect(() => computePreTripRisk([])).not.toThrow();
  });

  it('primaryConcern follows the highest signal risk', () => {
    const state = computePreTripRisk([trip(95)], {}, { fatigueLevel: 'critical' });
    expect(state.primaryConcern).toBe('High daily fatigue accumulation');
  });

  it('includes historical context risk in readiness signals', () => {
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

  it('treats insufficient historical context history as unavailable route evidence', () => {
    const state = computePreTripRisk(
      [],
      {},
      { fatigueLevel: 'low' },
      {
        predictiveRouteRisk: {
          status: 'insufficient_history',
          insufficientHistory: true,
          riskScore: null,
          riskLevel: null,
        },
      }
    );

    expect(state.signals.routeForecast).toBeNull();
  });

  it('suppresses late-night readiness when only generic clock risk would be available', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 0, 45));
    const state = computePreTripRisk(
      Array.from({ length: 6 }, (_, i) => trip(92, i + 1)),
      {},
      { fatigueLevel: 'low' },
      { predictiveRouteRisk: { riskScore: 42, riskLevel: 'moderate' } }
    );

    expect(state.signals.timeOfDay).toBeNull();
    expect(state.signals.routeForecast).toBe(42);
    expect(state.compositeRisk).toBeNull();
    expect(state.riskLevel).toBe('unavailable');
    expect(state.readinessScore).toBeNull();
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

  it('suppresses time-of-day risk when the personal bucket is insufficient', () => {
    const habitProfile = profile({
      confidence: 0.2,
      timeBuckets: {
        ...profile().timeBuckets,
        Night: { avgScore: 20, riskScore: 80, tripCount: 1, stdDev: 0, insufficient: true },
      },
    });
    const state = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 23) }, habitProfile);

    expect(state.signals.timeOfDay).toBeNull();
    expect(state.readinessScore).toBeNull();
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

  it('redistributes insufficient time-bucket weight to broader readiness signals', () => {
    const habitProfile = profile({
      timeBuckets: {
        ...profile().timeBuckets,
        Morning: { avgScore: 80, riskScore: 20, tripCount: 1, stdDev: 0, insufficient: true },
      },
    });
    const weights = deriveWeights(habitProfile, new Date(2026, 0, 10, 8));
    const freed = PRE_TRIP_RISK_WEIGHTS.timeOfDay * PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO;

    expect(weights.timeOfDay).toBeCloseTo(PRE_TRIP_RISK_WEIGHTS.timeOfDay - freed, 5);
    expect(weights.recentTrend).toBeCloseTo(
      PRE_TRIP_RISK_WEIGHTS.recentTrend + freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.recentTrend,
      5
    );
    expect(weights.dailyFatigue).toBeCloseTo(
      PRE_TRIP_RISK_WEIGHTS.dailyFatigue + freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.dailyFatigue,
      5
    );
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
