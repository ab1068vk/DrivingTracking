import { clamp } from '@/lib/mathUtils';
import { getJson, setJson } from '@/lib/mobileStorage';
import { READINESS_HISTORY_KEY } from '@/lib/calibration/readinessSignalCorrelation';

export const THRESHOLD_FIT_KEY = 'readiness_threshold_fit_v1';
export const MIN_PAIRS_FOR_THRESHOLD = 30;
export const GOOD_TRIP_SCORE_FLOOR = 72;

const defaultStorage = {
  get: (key) => getJson(key, null),
  set: (key, value) => setJson(key, value),
};

const finiteRisk = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
};

const finiteScore = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
};

export function readinessPairsFromHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .map((record) => ({
      compositeRisk: finiteRisk(record?.compositeRisk),
      actualScore: finiteScore(record?.actualScore),
    }))
    .filter((pair) => pair.compositeRisk != null && pair.actualScore != null);
}

export function fitReadinessThresholds(pairs = []) {
  if (!pairs || pairs.length < MIN_PAIRS_FOR_THRESHOLD) return null;

  let bestF1 = -Infinity;
  let bestHighFloor = 60;
  let bestModFloor = 35;

  for (let high = 55; high <= 80; high += 5) {
    for (let mod = 25; mod < high; mod += 5) {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const { compositeRisk, actualScore } of pairs) {
        const predictedHighRisk = compositeRisk >= high;
        const actualBadTrip = actualScore < GOOD_TRIP_SCORE_FLOOR;
        if (predictedHighRisk && actualBadTrip) tp += 1;
        if (predictedHighRisk && !actualBadTrip) fp += 1;
        if (!predictedHighRisk && actualBadTrip) fn += 1;
      }

      const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
      const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      if (f1 > bestF1) {
        bestF1 = f1;
        bestHighFloor = high;
        bestModFloor = mod;
      }
    }
  }

  return {
    highRiskFloor: clamp(bestHighFloor, 50, 80),
    moderateRiskFloor: clamp(bestModFloor, 20, bestHighFloor - 5),
    f1: Math.round(bestF1 * 1000) / 1000,
    n: pairs.length,
  };
}

export function crossValidateThresholds(pairs = []) {
  if (!pairs || pairs.length < MIN_PAIRS_FOR_THRESHOLD + 5) return null;

  const outcomes = pairs
    .map((pair, index) => {
      const trainSet = pairs.filter((_, trainIndex) => trainIndex !== index);
      const result = fitReadinessThresholds(trainSet);
      if (!result) return null;
      const predicted = pair.compositeRisk >= result.highRiskFloor;
      const actual = pair.actualScore < GOOD_TRIP_SCORE_FLOOR;
      return predicted === actual ? 1 : 0;
    })
    .filter((value) => value != null);

  if (!outcomes.length) return null;
  const mean = outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  const variance = outcomes.reduce((sum, value) => sum + (value - mean) ** 2, 0) / outcomes.length;
  return {
    accuracy: Math.round(mean * 1000) / 1000,
    n: outcomes.length,
    stdDev: Math.round(Math.sqrt(variance) * 1000) / 1000,
  };
}

export async function computeAndStoreReadinessThresholdFit(storage = defaultStorage) {
  const pairs = readinessPairsFromHistory(await storage.get(READINESS_HISTORY_KEY));
  const fit = fitReadinessThresholds(pairs);
  if (!fit) return null;

  const stored = {
    ...fit,
    validation: crossValidateThresholds(pairs),
    goodTripScoreFloor: GOOD_TRIP_SCORE_FLOOR,
    storageKey: THRESHOLD_FIT_KEY,
    fittedAt: new Date().toISOString(),
  };
  await storage.set(THRESHOLD_FIT_KEY, stored);
  return stored;
}

export async function loadReadinessThresholdFit(storage = defaultStorage) {
  const stored = await storage.get(THRESHOLD_FIT_KEY);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;

  const highRiskFloor = finiteRisk(stored.highRiskFloor);
  const moderateRiskFloor = finiteRisk(stored.moderateRiskFloor);
  if (highRiskFloor == null || moderateRiskFloor == null || highRiskFloor <= moderateRiskFloor) return null;

  return {
    ...stored,
    highRiskFloor,
    moderateRiskFloor,
  };
}
