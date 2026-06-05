import { clamp } from '@/lib/mathUtils';
import { getJson, setJson } from '@/lib/mobileStorage';

export const CALIBRATION_STORAGE_KEY = 'readiness_calibration_v1';
export const CALIBRATION_VERSION = 1;
export const CALIBRATION_MIN_TRIPS = 30;
export const CALIBRATION_MAX_OFFSET = 0.15;
export const CALIBRATION_LEARNING_RATE = 0.02;

const emptyState = () => ({
  offsets: {},
  tripCount: 0,
  version: CALIBRATION_VERSION,
  updatedAt: null,
});

const isFiniteNumber = (value) => Number.isFinite(Number(value));

const normalizeOffsets = (offsets = {}) => Object.fromEntries(
  Object.entries(offsets || {})
    .filter(([, value]) => isFiniteNumber(value))
    .map(([key, value]) => [
      key,
      clamp(Number(value), -CALIBRATION_MAX_OFFSET, CALIBRATION_MAX_OFFSET),
    ])
);

export function normalizeCalibrationState(stored = null) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyState();
  return {
    offsets: normalizeOffsets(stored.offsets),
    tripCount: Math.max(0, Math.trunc(Number(stored.tripCount) || 0)),
    version: Number(stored.version) || CALIBRATION_VERSION,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

export function isCalibrationActive(state = {}) {
  return Number(state?.tripCount) >= CALIBRATION_MIN_TRIPS;
}

export async function loadCalibrationState() {
  return normalizeCalibrationState(await getJson(CALIBRATION_STORAGE_KEY, null));
}

export async function loadCalibrationOffsets() {
  const state = await loadCalibrationState();
  return isCalibrationActive(state) ? state.offsets : {};
}

export function calibrationSnapshot(state = {}) {
  const normalized = normalizeCalibrationState(state);
  return {
    storageKey: CALIBRATION_STORAGE_KEY,
    version: normalized.version,
    tripCount: normalized.tripCount,
    minTrips: CALIBRATION_MIN_TRIPS,
    active: isCalibrationActive(normalized),
    offsets: isCalibrationActive(normalized) ? normalized.offsets : {},
  };
}

export async function updateCalibration(preTripContext, actualScore) {
  if (!preTripContext?.signals || !isFiniteNumber(actualScore)) return null;

  const stored = normalizeCalibrationState(await getJson(CALIBRATION_STORAGE_KEY, null));
  stored.tripCount += 1;

  const actualRisk = 100 - clamp(Number(actualScore), 0, 100);
  const predictedRisk = isFiniteNumber(preTripContext.compositeRisk ?? preTripContext.bootstrapRisk)
    ? clamp(Number(preTripContext.compositeRisk ?? preTripContext.bootstrapRisk), 0, 100)
    : 50;
  const error = predictedRisk - actualRisk;

  for (const [signal, signalRisk] of Object.entries(preTripContext.signals || {})) {
    if (!isFiniteNumber(signalRisk)) continue;
    const weight = Number(preTripContext.weights?.[signal] ?? 0);
    if (!Number.isFinite(weight) || weight === 0) continue;

    const contribution = (clamp(Number(signalRisk), 0, 100) / 100) * weight;
    const signalError = error * (contribution / Math.max(predictedRisk, 1));
    const currentOffset = stored.offsets[signal] ?? 0;
    stored.offsets[signal] = clamp(
      currentOffset - signalError * CALIBRATION_LEARNING_RATE,
      -CALIBRATION_MAX_OFFSET,
      CALIBRATION_MAX_OFFSET
    );
  }

  stored.updatedAt = new Date().toISOString();
  await setJson(CALIBRATION_STORAGE_KEY, stored);
  return stored;
}
