import {
  MIN_FATIGUE_CALIBRATION_LABEL_COUNT,
} from './fatigueSelfReport.js';
import {
  countFatigueCalibrationLabels,
  fatigueCalibrationRows,
} from './fatigueLabelRows.js';
import {
  fitFatigueMaxPenalty,
  fitFatiguePenaltyScale,
} from './fatigueScaleFit.js';
import { validateFatigueFit } from './fatigueValidation.js';

export { MIN_FATIGUE_CALIBRATION_LABEL_COUNT, countFatigueCalibrationLabels };

export function fitFatigueConstants(labels = []) {
  const rows = fatigueCalibrationRows(labels);
  if (!rows.length) {
    throw new Error('fitFatigueConstants requires at least one fatigue-labeled trip.');
  }

  const FATIGUE_SAFETY_PENALTY_SCALE = fitFatiguePenaltyScale(rows);
  const FATIGUE_SAFETY_MAX_PENALTY = fitFatigueMaxPenalty(rows, FATIGUE_SAFETY_PENALTY_SCALE);
  const constants = {
    FATIGUE_SAFETY_PENALTY_SCALE,
    FATIGUE_SAFETY_MAX_PENALTY,
  };

  return {
    ...constants,
    validation: validateFatigueFit(rows, constants),
  };
}
