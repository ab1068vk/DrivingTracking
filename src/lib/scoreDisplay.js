export const SCORE_ESTIMATE_NOTICE =
  'Scores are personal driving estimates based on GPS patterns. ' +
  'They are not validated against crash outcomes and should not be ' +
  'used for insurance, legal, or safety-critical decisions.';
export const SCORE_BASELINE_TRIP_TARGET = 10;
export const UBI_INSURANCE_NOTICE = 'NOT AN INSURANCE RATING';
export const UBI_INSURANCE_NOTICE_DETAIL = 'This score card is an internal coaching estimate only. It is not insurer-validated and must not be used for insurance eligibility, underwriting, or pricing.';

export function isApproximateScoreOutput(provenanceOrStatus = null) {
  const status = typeof provenanceOrStatus === 'string'
    ? provenanceOrStatus
    : provenanceOrStatus?.calibration_status;
  return status == null || status === 'approximate';
}

export function formatEstimatedScore(value, { empty = '-', round = true, approximate = true } = {}) {
  if (value == null || value === '') return empty;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return empty;
  const display = round ? Math.round(numeric) : numeric;
  return `${approximate ? '~' : ''}${display}`;
}

export function formatScoreWithProvenance(value, scoreProvenance = null, options = {}) {
  return formatEstimatedScore(value, {
    ...options,
    approximate: isApproximateScoreOutput(scoreProvenance),
  });
}

export function scoreEstimateProgressText(tripCount, target = SCORE_BASELINE_TRIP_TARGET) {
  const count = Number(tripCount);
  if (!Number.isFinite(count) || count < 0 || count >= target) return null;
  const remaining = target - Math.floor(count);
  return `Estimate - improves after ${remaining} more trip${remaining !== 1 ? 's' : ''}`;
}

export function isEstimatedScoreMetric(metricKey) {
  return typeof metricKey === 'string' && (
    metricKey.startsWith('score_') ||
    metricKey === 'ubi_score' ||
    metricKey.endsWith('_score')
  );
}
