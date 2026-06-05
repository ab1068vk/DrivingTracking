import { describe, expect, it } from 'vitest';
import { deriveWeights, PRE_TRIP_RISK_WEIGHTS } from '@/lib/preTripRisk';
import {
  computePairwiseSignalCorrelation,
  computeSignalCorrelations,
  MAX_HISTORY_RECORDS,
  MIN_HISTORY_FOR_CORRELATION,
  pairOutcome,
  READINESS_HISTORY_KEY,
  recordReadinessSnapshot,
} from '@/lib/calibration/readinessSignalCorrelation';

const memoryStorage = () => {
  const values = new Map();
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
    },
  };
};

async function recordPair(storage, signals, actualScore) {
  const id = await recordReadinessSnapshot(signals, signals.compositeRisk ?? 50, {}, storage);
  await pairOutcome(id, actualScore, storage);
  return id;
}

describe('readiness signal correlation', () => {
  it('computeSignalCorrelations returns empty object before minimum history records', async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MIN_HISTORY_FOR_CORRELATION - 1; index += 1) {
      await recordPair(storage, { timeOfDay: index }, 100 - index);
    }

    expect(await computeSignalCorrelations(storage)).toEqual({});
  });

  it('marks a perfectly anti-correlated signal as predictive', async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MIN_HISTORY_FOR_CORRELATION + 5; index += 1) {
      const risk = Math.round((index / (MIN_HISTORY_FOR_CORRELATION + 4)) * 100);
      await recordPair(storage, { timeOfDay: risk }, 100 - risk);
    }

    const correlations = await computeSignalCorrelations(storage);

    expect(correlations.timeOfDay.r).toBeCloseTo(-1, 3);
    expect(correlations.timeOfDay.n).toBe(MIN_HISTORY_FOR_CORRELATION + 5);
    expect(correlations.timeOfDay.predictive).toBe(true);
  });

  it('marks an uncorrelated signal as not predictive', async () => {
    const storage = memoryStorage();
    const pattern = [
      { weather: 20, score: 40 },
      { weather: 20, score: 80 },
      { weather: 80, score: 40 },
      { weather: 80, score: 80 },
    ];
    for (let index = 0; index < 8; index += 1) {
      for (const item of pattern) {
        await recordPair(storage, { weather: item.weather }, item.score);
      }
    }

    const correlations = await computeSignalCorrelations(storage);

    expect(Math.abs(correlations.weather.r)).toBeLessThan(0.01);
    expect(correlations.weather.predictive).toBe(false);
  });

  it('deriveWeights discounts non-predictive signals while preserving normalization', () => {
    const nonPredictiveCorr = {
      weather: { r: 0.02, n: MIN_HISTORY_FOR_CORRELATION + 5, predictive: false },
    };
    const baseWeights = deriveWeights(null, new Date(2026, 0, 10, 12), {}, {});
    const weights = deriveWeights(null, new Date(2026, 0, 10, 12), {}, nonPredictiveCorr);
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

    expect(total).toBeCloseTo(1);
    expect(weights.weather).toBeLessThan(baseWeights.weather);
    expect(baseWeights.weather).toBeCloseTo(PRE_TRIP_RISK_WEIGHTS.weather);
  });

  it('computes pairwise signal correlations across paired readiness history', async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MIN_HISTORY_FOR_CORRELATION + 5; index += 1) {
      const value = Math.round((index / (MIN_HISTORY_FOR_CORRELATION + 4)) * 100);
      await recordPair(storage, {
        timeOfDay: value,
        dayOfWeek: value,
        weather: index % 2 === 0 ? 20 : 80,
      }, 100 - value);
    }

    const pairwise = await computePairwiseSignalCorrelation(storage);

    expect(pairwise['timeOfDay|dayOfWeek']).toBeCloseTo(1, 3);
  });

  it('deriveWeights damps both signals when timeOfDay and dayOfWeek are highly correlated', () => {
    const pairwise = { 'timeOfDay|dayOfWeek': 0.85 };
    const base = deriveWeights(null, new Date(2026, 0, 10, 12), {}, {});
    const damped = deriveWeights(null, new Date(2026, 0, 10, 12), {}, pairwise);
    const total = Object.values(damped).reduce((sum, value) => sum + value, 0);

    expect(damped.timeOfDay).toBeLessThan(base.timeOfDay);
    expect(damped.dayOfWeek).toBeLessThan(base.dayOfWeek);
    expect(total).toBeCloseTo(1);
  });

  it('deriveWeights does not damp uncorrelated signal pairs', () => {
    const pairwise = { 'timeOfDay|weather': 0.1 };
    const base = deriveWeights(null, new Date(2026, 0, 10, 12), {}, {});
    const damped = deriveWeights(null, new Date(2026, 0, 10, 12), {}, pairwise);

    expect(damped.weather).toBeCloseTo(base.weather, 3);
  });

  it('caps readiness snapshot history to the most recent records', async () => {
    const storage = memoryStorage();
    for (let index = 0; index < MAX_HISTORY_RECORDS + 5; index += 1) {
      await recordReadinessSnapshot({ weather: index % 100 }, 50, {}, storage);
    }

    const history = await storage.get(READINESS_HISTORY_KEY);

    expect(history).toHaveLength(MAX_HISTORY_RECORDS);
    expect(history[0].signals.weather).toBe(5);
  });
});
