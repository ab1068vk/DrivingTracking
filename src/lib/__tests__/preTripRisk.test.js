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
import { decayWeight } from '@/lib/mathUtils';
import { ROUTE_RISK_CONSTANTS, estimatePredictiveRouteRisk } from '@/lib/predictiveRouteRisk';
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

const endedTrip = ({ score = 90, endedMinutesAgo = 15, now = new Date(2026, 0, 10, 12) } = {}) => {
  const end = new Date(now.getTime() - endedMinutesAgo * 60000);
  const start = new Date(end.getTime() - 30 * 60000);
  return {
    status: 'completed',
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    distance_km: 10,
    score_overall: score,
  };
};

const timeBucketTrip = ({ score, daysAgo = 0, hour = 8 }) => {
  const date = new Date(2026, 0, 10 - daysAgo, hour, 0, 0);
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
    { avgScore: 80, riskScore: 20, tripCount: 2, stdDev: 0, insufficient: false },
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

  it('applies calibration offsets and keeps weights normalized', () => {
    const weights = deriveWeights(null, new Date(2026, 0, 10, 12), {
      timeOfDay: -0.05,
      dailyFatigue: 0.05,
    });
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

    expect(total).toBeCloseTo(1, 5);
    expect(weights.timeOfDay).toBeLessThan(PRE_TRIP_RISK_WEIGHTS.timeOfDay);
    expect(weights.dailyFatigue).toBeGreaterThan(PRE_TRIP_RISK_WEIGHTS.dailyFatigue);
  });

  it('returns the calibrated weights used for the readiness result', () => {
    const state = computePreTripRisk(
      Array.from({ length: 6 }, (_, i) => trip(90, i)),
      {},
      { fatigueLevel: 'high' },
      { now: new Date(2026, 0, 10, 12) },
      profile(),
      { dailyFatigue: 0.05 }
    );

    expect(state.weights.dailyFatigue).toBeGreaterThan(PRE_TRIP_RISK_WEIGHTS.dailyFatigue);
  });

  it('readinessScore is 100 minus compositeRisk', () => {
    const state = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 12) }, profile());
    expect(state.readinessScore).toBe(100 - state.compositeRisk);
  });

  it('uses fitted thresholds from context for risk level classification', () => {
    const baseline = computePreTripRisk([], {}, { fatigueLevel: 'low' }, { now: new Date(2026, 0, 10, 12) }, profile());
    const fitted = computePreTripRisk(
      [],
      {},
      { fatigueLevel: 'low' },
      {
        now: new Date(2026, 0, 10, 12),
        fittedThresholds: {
          highRiskFloor: 10,
          moderateRiskFloor: 5,
        },
      },
      profile()
    );

    expect(baseline.compositeRisk).toBeGreaterThanOrEqual(10);
    expect(baseline.riskLevel).not.toBe('high');
    expect(fitted.riskLevel).toBe('high');
    expect(fitted.dataQuality.effectiveRiskFloors).toEqual({ high: 10, moderate: 5 });
  });

  it('compositeStdDev is null when compositeRisk is null', () => {
    const result = computePreTripRisk([], {}, null, { now: new Date(2026, 0, 10, 12) });

    expect(result.compositeRisk).toBeNull();
    expect(result.compositeStdDev).toBeNull();
    expect(result.readinessInterval).toBeNull();
  });

  it('readinessInterval.low is always less than or equal to readinessInterval.high', () => {
    const result = computePreTripRisk(
      Array.from({ length: 8 }, (_, index) => trip(82 - index, index)),
      {},
      { fatigueLevel: 'moderate' },
      { now: new Date(2026, 0, 10, 12) },
      profile()
    );

    expect(result.readinessInterval.low).toBeLessThanOrEqual(result.readinessInterval.high);
  });

  it('readiness interval is narrower when bucket variance is low', () => {
    const morningProfile = (stdDev) => profile({
      timeBuckets: {
        ...profile().timeBuckets,
        Morning: { avgScore: 80, riskScore: 20, tripCount: 5, stdDev, insufficient: false },
      },
      dayOfWeek: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [
        day,
        { avgScore: 80, riskScore: 20, tripCount: 5, stdDev, insufficient: false },
      ])),
    });
    const trips = Array.from({ length: 8 }, (_, index) => trip(82 - index, index));
    const context = { now: new Date(2026, 0, 10, 8) };
    const stable = computePreTripRisk(trips, {}, { fatigueLevel: 'moderate' }, context, morningProfile(2));
    const noisy = computePreTripRisk(trips, {}, { fatigueLevel: 'moderate' }, context, morningProfile(20));
    const stableWidth = stable.readinessInterval.high - stable.readinessInterval.low;
    const noisyWidth = noisy.readinessInterval.high - noisy.readinessInterval.low;

    expect(stableWidth).toBeLessThan(noisyWidth);
  });

  it('suppresses readiness score when core personal signals are unavailable', () => {
    const state = computePreTripRisk([], {}, { fatigueLevel: 'critical' }, { now: new Date(2026, 0, 10, 2) });

    expect(state.compositeRisk).toBeNull();
    expect(state.readinessScore).toBeNull();
    expect(state.evidenceTier).toBe('bootstrapping');
    expect(state.bootstrapReadinessScore).not.toBeNull();
    expect(state.dataQuality.readinessEvidence).toBe('bootstrapping');
    expect(state.dataQuality.missingCoreSignals).toEqual(['timeOfDay', 'recentTrend']);
    expect(state.dataQuality.fallbackSignalCount).toBeGreaterThan(1);
    expect(state.dataQuality.fallbackGateTriggered).toBe(true);
  });

  it('returns a developing score when at least two actual-user readiness signals exist', () => {
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
    expect(state.evidenceTier).toBe('developing');
    expect(state.compositeRisk).not.toBeNull();
    expect(state.readinessScore).not.toBeNull();
    expect(state.riskLevel).not.toBe('unavailable');
  });

  it('handles empty trips gracefully', () => {
    expect(() => computePreTripRisk([])).not.toThrow();
  });

  it('treats recentTrend as unavailable when trip count is below PERSONAL_BASELINE_MIN_TRIPS', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const trips = [trip(85)];
    const result = computePreTripRisk(trips, {}, null, { now: new Date(2026, 0, 10, 12) });

    expect(result.dataQuality.missingCoreSignals).toContain('recentTrend');
    expect(result.dataQuality.signalProvenance.recentTrend.fallback).toBe(true);
    expect(result.readinessScore).toBeNull();
    vi.useRealTimers();
  });

  it('does not mark recentTrend as actualUserData when baseline returns null', () => {
    const result = computePreTripRisk([], {}, null, { now: new Date() });

    expect(result.dataQuality.signalProvenance.recentTrend.actualUserData).not.toBe(true);
  });

  it('correctly marks recentTrend as actualUserData when sufficient baseline trips exist', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const trips = Array.from({ length: 10 }, (_, index) => trip(80 - index, index));
    const result = computePreTripRisk(trips, {}, null, { now: new Date(2026, 0, 10, 12) });

    expect(result.dataQuality.signalProvenance.recentTrend.actualUserData).toBe(true);
    vi.useRealTimers();
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

  it('danger zone risk uses exponential saturation matching predictiveRouteRisk model', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const zoneCount = 2;
    const expected = Math.round(
      (1 - Math.exp(-zoneCount / ROUTE_RISK_CONSTANTS.DANGER_ZONE_DECAY_COUNT)) * 100
    );

    const result = computePreTripRisk(
      Array.from({ length: 10 }, (_, index) => trip(90 - index, index)),
      {},
      null,
      { now: new Date(2026, 0, 10, 12), nearbyDangerZoneCount: zoneCount }
    );

    expect(result.signals.dangerZones).toBe(expected);
    vi.useRealTimers();
  });

  it('danger zone risk does not exceed 100 for very high zone counts', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 12));
    const result = computePreTripRisk(
      Array.from({ length: 10 }, (_, index) => trip(90 - index, index)),
      {},
      null,
      { now: new Date(2026, 0, 10, 12), nearbyDangerZoneCount: 50 }
    );

    expect(result.signals.dangerZones).toBeLessThanOrEqual(100);
    expect(result.signals.dangerZones).toBeGreaterThan(90);
    vi.useRealTimers();
  });

  it('recent bad trips raise risk more than equally bad trips from 60 days ago', () => {
    const context = { now: new Date(2026, 0, 10, 8) };
    const recentBadTrips = [
      ...Array.from({ length: 5 }, (_, index) => timeBucketTrip({ score: 45, daysAgo: index + 1 })),
      ...Array.from({ length: 5 }, (_, index) => timeBucketTrip({ score: 90, daysAgo: 60 + index })),
    ];
    const oldBadTrips = [
      ...Array.from({ length: 5 }, (_, index) => timeBucketTrip({ score: 90, daysAgo: index + 1 })),
      ...Array.from({ length: 5 }, (_, index) => timeBucketTrip({ score: 45, daysAgo: 60 + index })),
    ];

    const resultRecent = computePreTripRisk(recentBadTrips, {}, null, context);
    const resultOld = computePreTripRisk(oldBadTrips, {}, null, context);

    expect(resultRecent.signals.timeOfDay).toBeGreaterThan(resultOld.signals.timeOfDay);
  });

  it('decayWeight returns 1.0 for age 0 and 0.5 for age equal to half-life', () => {
    expect(decayWeight(0)).toBeCloseTo(1.0);
    expect(decayWeight(21)).toBeCloseTo(0.5);
    expect(decayWeight(42)).toBeCloseTo(0.25);
  });

  it('returns bootstrapReadinessScore for new users with only fatigue/rest signals', () => {
    const fatigueState = {
      cumulativeFatigueScore: 3,
      fatigueLevel: 'moderate',
      recommendedBreakMinutes: 20,
    };
    const result = computePreTripRisk([], {}, fatigueState, { now: new Date(2026, 0, 10, 12) });

    expect(result.evidenceTier).toBe('bootstrapping');
    expect(result.bootstrapReadinessScore).not.toBeNull();
    expect(result.readinessScore).toBeNull();
  });

  it('transitions to developing tier after sufficient actual-user signals appear', () => {
    const result = computePreTripRisk(
      Array.from({ length: 8 }, (_, index) => trip(86 - index, index)),
      {},
      null,
      { now: new Date(2026, 0, 10, 12) }
    );

    expect(['developing', 'calibrated']).toContain(result.evidenceTier);
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
    expect(state.evidenceTier).toBe('developing');
    expect(state.compositeRisk).not.toBeNull();
    expect(state.riskLevel).toBe('moderate');
    expect(state.readinessScore).not.toBeNull();
    vi.useRealTimers();
  });

  it('raises readiness concern when the previous trip ended recently', () => {
    vi.setSystemTime(new Date(2026, 0, 10, 13));
    const recentTrip = trip(92);
    recentTrip.end_time = new Date(2026, 0, 10, 12, 50).toISOString();

    const state = computePreTripRisk([recentTrip], {}, { fatigueLevel: 'low' });

    expect(state.signals.recentRest).toBe(67);
    expect(state.topSignals[0].key).toBe('recentRest');
    vi.useRealTimers();
  });

  it('rest risk is higher after a long drive with a short break than after a short drive with the same break', () => {
    const breakMinutes = 15;
    const now = new Date(2026, 0, 10, 12);
    const lastTrip = endedTrip({ endedMinutesAgo: breakMinutes, now });
    const resultHigh = computePreTripRisk(
      [],
      {},
      { recommendedBreakMinutes: 45 },
      { now, lastTrip }
    );
    const resultLow = computePreTripRisk(
      [],
      {},
      { recommendedBreakMinutes: 10 },
      { now, lastTrip }
    );

    expect(resultHigh.signals.recentRest).toBeGreaterThan(resultLow.signals.recentRest);
  });

  it('rest risk is 0 when break exceeds recommended threshold', () => {
    const now = new Date(2026, 0, 10, 12);
    const lastTrip = endedTrip({ endedMinutesAgo: 45, now });
    const result = computePreTripRisk(
      [],
      {},
      { recommendedBreakMinutes: 30 },
      { now, lastTrip }
    );

    expect(result.signals.recentRest).toBe(0);
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
    expect(state.evidenceTier).toBe('developing');
    expect(state.readinessScore).not.toBeNull();
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
