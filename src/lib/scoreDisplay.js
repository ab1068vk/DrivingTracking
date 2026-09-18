import { SCORE_OUTPUT_CALIBRATION_STATUSES } from '@/lib/scoringConstants';

export const SCORE_ESTIMATE_NOTICE = 'Scores are estimates - not validated against real-world crash data';
export const UBI_INSURANCE_NOTICE = 'NOT AN INSURANCE RATING';
export const UBI_INSURANCE_NOTICE_DETAIL = 'This score card is an internal coaching estimate only. It is not insurer-validated and must not be used for insurance eligibility, underwriting, or pricing.';

/**
 * The only score-output status the product allows to render unqualified.
 *
 * `SCORE_OUTPUT_CALIBRATION_STATUSES` is the canonical enumeration for a score's
 * own calibration, and `CALIBRATED` is its single qualified member. Everything
 * else a record can carry — an absent status, the literal `approximate`, the
 * repository's `unknown_legacy_unrescored` legacy tag, or any token this build
 * does not recognise — is not proof of calibration and must not be shown as an
 * exact measurement. Per-constant statuses such as `heuristic_beta` belong to
 * the constants metadata, not to a trip's score provenance, and are therefore
 * not qualified here either.
 */
const QUALIFIED_SCORE_OUTPUT_STATUSES = new Set([SCORE_OUTPUT_CALIBRATION_STATUSES.CALIBRATED]);

export function isApproximateScoreOutput(provenanceOrStatus = null) {
  const status = typeof provenanceOrStatus === 'string'
    ? provenanceOrStatus
    : provenanceOrStatus?.calibration_status;
  return !QUALIFIED_SCORE_OUTPUT_STATUSES.has(status);
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

/**
 * Derived-score provenance (HPR-009).
 *
 * A mastery, current-form or other aggregate produced from per-trip scores is
 * only as calibrated as the inputs it was folded from, so the derived number
 * must carry provenance of its own rather than arriving on screen bare.
 *
 * The rule is conservative and deterministic, and it is taken from the display
 * contract above rather than invented here: `isApproximateScoreOutput` already
 * treats an absent calibration status as approximate, so
 *
 *   - any constituent that is approximate **or** unknown makes the aggregate
 *     approximate;
 *   - otherwise the aggregate carries the single qualified status every
 *     constituent shares;
 *   - a mixture of different explicit statuses cannot honestly claim any one of
 *     them, so it falls back to approximate — the weakest applicable state
 *     governs.
 *
 * An empty constituent list is approximate: nothing proved otherwise.
 *
 * @param {Array<{calibration_status?: string}|string|null|undefined>} provenances
 * @returns {{calibration_status: string}}
 */
export function deriveAggregateScoreProvenance(provenances = []) {
  const list = Array.isArray(provenances) ? provenances : [];
  if (!list.length) return { calibration_status: 'approximate' };
  const statuses = new Set();
  for (const entry of list) {
    if (isApproximateScoreOutput(entry)) return { calibration_status: 'approximate' };
    statuses.add(typeof entry === 'string' ? entry : entry.calibration_status);
  }
  return statuses.size === 1
    ? { calibration_status: [...statuses][0] }
    : { calibration_status: 'approximate' };
}
