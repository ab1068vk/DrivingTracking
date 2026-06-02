import { beforeEach, describe, expect, it } from 'vitest';
import { removeJson } from '@/lib/mobileStorage';
import {
  CALIBRATION_MAX_OFFSET,
  CALIBRATION_MIN_TRIPS,
  CALIBRATION_STORAGE_KEY,
  calibrationSnapshot,
  loadCalibrationOffsets,
  loadCalibrationState,
  updateCalibration,
} from '@/lib/readinessCalibration';

const context = {
  compositeRisk: 70,
  readinessScore: 30,
  evidenceTier: 'calibrated',
  signals: { timeOfDay: 80, recentTrend: 30 },
  weights: { timeOfDay: 0.3, recentTrend: 0.2 },
};

describe('readinessCalibration', () => {
  beforeEach(async () => {
    await removeJson(CALIBRATION_STORAGE_KEY);
  });

  it('returns empty offsets before CALIBRATION_MIN_TRIPS', async () => {
    await updateCalibration(context, 88);

    const state = await loadCalibrationState();
    const offsets = await loadCalibrationOffsets();

    expect(state.tripCount).toBe(1);
    expect(offsets).toEqual({});
  });

  it('reduces timeOfDay offset when risk was over-predicted', async () => {
    for (let i = 0; i < CALIBRATION_MIN_TRIPS; i += 1) {
      await updateCalibration(context, 88);
    }

    const offsets = await loadCalibrationOffsets();

    expect(offsets.timeOfDay).toBeLessThan(0);
  });

  it('increases a signal offset when risk was under-predicted', async () => {
    const lowPrediction = {
      compositeRisk: 20,
      signals: { dayOfWeek: 80 },
      weights: { dayOfWeek: 0.4 },
    };

    for (let i = 0; i < CALIBRATION_MIN_TRIPS; i += 1) {
      await updateCalibration(lowPrediction, 40);
    }

    const offsets = await loadCalibrationOffsets();

    expect(offsets.dayOfWeek).toBeGreaterThan(0);
  });

  it('clamps offsets to CALIBRATION_MAX_OFFSET', async () => {
    const highErrorContext = {
      compositeRisk: 80,
      signals: { timeOfDay: 90 },
      weights: { timeOfDay: 0.5 },
    };

    for (let i = 0; i < 500; i += 1) {
      await updateCalibration(highErrorContext, 95);
    }

    const offsets = await loadCalibrationOffsets();

    expect(Math.abs(offsets.timeOfDay)).toBeLessThanOrEqual(CALIBRATION_MAX_OFFSET);
  });

  it('exposes an active snapshot only after enough trips', async () => {
    const pending = calibrationSnapshot(await loadCalibrationState());
    expect(pending.active).toBe(false);
    expect(pending.offsets).toEqual({});

    for (let i = 0; i < CALIBRATION_MIN_TRIPS; i += 1) {
      await updateCalibration(context, 88);
    }

    const active = calibrationSnapshot(await loadCalibrationState());
    expect(active.active).toBe(true);
    expect(active.tripCount).toBe(CALIBRATION_MIN_TRIPS);
    expect(active.offsets.timeOfDay).toBeLessThan(0);
  });
});
