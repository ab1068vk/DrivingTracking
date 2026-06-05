import {
  MIN_FATIGUE_CALIBRATION_LABEL_COUNT,
  countFatigueCalibrationLabels,
  fitFatigueConstants,
} from '../../src/lib/calibrationFitting.js';
import { FATIGUE_PROMOTABLE_CONSTANT_KEYS } from './currentConstants.mjs';

function unchangedFatigueConstants(currentConstants = {}) {
  return Object.fromEntries(FATIGUE_PROMOTABLE_CONSTANT_KEYS.map((key) => [
    key,
    currentConstants[key],
  ]));
}

function mergeFatigueFit(result, fatigueFit) {
  return {
    ...result,
    constants: {
      ...result.constants,
      FATIGUE_SAFETY_PENALTY_SCALE: fatigueFit.FATIGUE_SAFETY_PENALTY_SCALE,
      FATIGUE_SAFETY_MAX_PENALTY: fatigueFit.FATIGUE_SAFETY_MAX_PENALTY,
    },
    fittedConstantKeys: [
      ...(result.fittedConstantKeys || ['PENALTY_SCALE_FACTOR']),
      ...FATIGUE_PROMOTABLE_CONSTANT_KEYS,
    ],
    fatigueCalibration: {
      status: 'refitted',
      eligibleCount: fatigueFit.eligibleCount,
      constants: {
        FATIGUE_SAFETY_PENALTY_SCALE: fatigueFit.FATIGUE_SAFETY_PENALTY_SCALE,
        FATIGUE_SAFETY_MAX_PENALTY: fatigueFit.FATIGUE_SAFETY_MAX_PENALTY,
      },
      validation: fatigueFit.validation,
    },
  };
}

function mergeUnchangedFatigueConstants(result, currentConstants, fatigueCount) {
  return {
    ...result,
    constants: {
      ...result.constants,
      ...unchangedFatigueConstants(currentConstants),
    },
    fittedConstantKeys: result.fittedConstantKeys || ['PENALTY_SCALE_FACTOR'],
    fatigueCalibration: {
      status: 'insufficient_labels',
      eligibleCount: fatigueCount,
      minSampleSize: MIN_FATIGUE_CALIBRATION_LABEL_COUNT,
      note: `Fatigue constants not refitted — need ${MIN_FATIGUE_CALIBRATION_LABEL_COUNT} fatigue-labeled trips, have ${fatigueCount}.`,
    },
  };
}

export function attachFatigueCalibration(result, labels, currentConstants) {
  const fatigueCount = countFatigueCalibrationLabels(labels);
  if (fatigueCount < MIN_FATIGUE_CALIBRATION_LABEL_COUNT) {
    return mergeUnchangedFatigueConstants(result, currentConstants, fatigueCount);
  }

  const fatigueFit = {
    ...fitFatigueConstants(labels),
    eligibleCount: fatigueCount,
  };
  return mergeFatigueFit(result, fatigueFit);
}
