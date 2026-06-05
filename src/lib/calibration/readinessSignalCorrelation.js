import { getJson, setJson } from '@/lib/mobileStorage';
import { clamp } from '@/lib/mathUtils';
import { pearsonCorrelation, round } from './numberUtils.js';
import { scoringValue } from '@/lib/scoringConstants';

export const READINESS_HISTORY_KEY = 'readiness_signal_history_v1';
export const MIN_HISTORY_FOR_CORRELATION = scoringValue('READINESS_HISTORY_MIN_FOR_CORRELATION') ?? 20;
export const MAX_HISTORY_RECORDS = 200;
export const MIN_CORRELATION_THRESHOLD = scoringValue('READINESS_MIN_CORRELATION_THRESHOLD') ?? 0.15;

const defaultStorage = {
  get: (key) => getJson(key, null),
  set: (key, value) => setJson(key, value),
};

const finiteRisk = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
};

const finiteScore = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : null;
};

const sanitizeSignals = (signals = {}) => Object.fromEntries(
  Object.entries(signals || {})
    .map(([key, value]) => [key, finiteRisk(value)])
    .filter(([, value]) => value != null)
);

export async function recordReadinessSnapshot(
  signals,
  compositeRisk,
  weights,
  storage = defaultStorage
) {
  const record = {
    id: `rs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    capturedAt: new Date().toISOString(),
    signals: sanitizeSignals(signals),
    compositeRisk: finiteRisk(compositeRisk),
    weights: Object.fromEntries(
      Object.entries(weights || {})
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Number(value)])
    ),
    actualScore: null,
  };
  const history = await storage.get(READINESS_HISTORY_KEY) ?? [];
  const next = [...(Array.isArray(history) ? history : []), record].slice(-MAX_HISTORY_RECORDS);
  await storage.set(READINESS_HISTORY_KEY, next);
  return record.id;
}

export async function pairOutcome(recordId, actualScore, storage = defaultStorage) {
  const score = finiteScore(actualScore);
  if (!recordId || score == null) return false;

  const history = await storage.get(READINESS_HISTORY_KEY) ?? [];
  if (!Array.isArray(history)) return false;

  let changed = false;
  const next = history.map((record) => {
    if (record?.id !== recordId) return record;
    changed = true;
    return {
      ...record,
      actualScore: score,
      pairedAt: new Date().toISOString(),
    };
  });

  if (changed) await storage.set(READINESS_HISTORY_KEY, next);
  return changed;
}

export async function computeSignalCorrelations(storage = defaultStorage) {
  const history = (await storage.get(READINESS_HISTORY_KEY) ?? [])
    .filter((record) => finiteScore(record?.actualScore) != null && record?.signals);

  if (history.length < MIN_HISTORY_FOR_CORRELATION) return {};

  const signalKeys = [...new Set(history.flatMap((record) => Object.keys(record.signals || {})))];
  const result = {};

  for (const key of signalKeys) {
    const pairs = history
      .map((record) => ({
        x: finiteRisk(record.signals?.[key]),
        y: finiteScore(record.actualScore),
      }))
      .filter((pair) => pair.x != null && pair.y != null);

    if (pairs.length < MIN_HISTORY_FOR_CORRELATION) continue;

    const r = pearsonCorrelation(pairs);
    if (r == null) continue;
    result[key] = {
      r: round(r, 3),
      n: pairs.length,
      predictive: Math.abs(r) >= MIN_CORRELATION_THRESHOLD,
    };
  }

  return result;
}

/**
 * Compute pairwise Pearson correlations between readiness signal risk values.
 * @param {object} storage - Optional storage adapter with async get/set.
 * @returns {Promise<object>} Map keyed as "signalA|signalB" with Pearson r values.
 */
export async function computePairwiseSignalCorrelation(storage = defaultStorage) {
  const history = (await storage.get(READINESS_HISTORY_KEY) ?? [])
    .filter((record) => finiteScore(record?.actualScore) != null && record?.signals);

  if (history.length < MIN_HISTORY_FOR_CORRELATION) return {};

  const signalKeys = [...new Set(history.flatMap((record) => Object.keys(record.signals || {})))];
  const result = {};

  for (let i = 0; i < signalKeys.length; i += 1) {
    for (let j = i + 1; j < signalKeys.length; j += 1) {
      const a = signalKeys[i];
      const b = signalKeys[j];
      const pairs = history
        .map((record) => ({
          x: finiteRisk(record.signals?.[a]),
          y: finiteRisk(record.signals?.[b]),
        }))
        .filter((pair) => pair.x != null && pair.y != null);

      if (pairs.length < MIN_HISTORY_FOR_CORRELATION) continue;

      const r = pearsonCorrelation(pairs);
      if (r != null) result[`${a}|${b}`] = round(r, 3);
    }
  }

  return result;
}
