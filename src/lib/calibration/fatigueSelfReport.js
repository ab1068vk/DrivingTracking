export const MIN_FATIGUE_CALIBRATION_LABEL_COUNT = 200;

export const FATIGUE_SELF_REPORT_VALUES = Object.freeze([
  'alert',
  'normal',
  'tired',
  'very_tired',
]);

export const FATIGUE_SELF_REPORT_SCORE = Object.freeze({
  alert: 0,
  normal: 1,
  tired: 2,
  very_tired: 3,
});

export function normalizeFatigueSelfReport(value) {
  if (value == null || value === '') return null;
  return FATIGUE_SELF_REPORT_VALUES.includes(value) ? value : null;
}

export function fatigueReportScore(value) {
  const normalized = normalizeFatigueSelfReport(value);
  return normalized == null ? null : FATIGUE_SELF_REPORT_SCORE[normalized];
}
