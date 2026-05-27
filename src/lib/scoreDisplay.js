export const SCORE_ESTIMATE_NOTICE = 'Scores are estimates - not validated against real-world crash data';
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

export function isEstimatedScoreMetric(metricKey) {
  return typeof metricKey === 'string' && (
    metricKey.startsWith('score_') ||
    metricKey === 'ubi_score' ||
    metricKey.endsWith('_score')
  );
}
