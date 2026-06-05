import {
  CALIBRATION_LABEL_TARGET_COUNT,
  getNextCalibrationMilestone,
} from '@/lib/calibrationLabeling';

export function calibrationProgress(labelCount) {
  const count = Math.max(0, Math.floor(Number(labelCount) || 0));
  return {
    count,
    target: CALIBRATION_LABEL_TARGET_COUNT,
    percent: Math.min(100, (count / CALIBRATION_LABEL_TARGET_COUNT) * 100),
    nextMilestone: getNextCalibrationMilestone(count),
  };
}
