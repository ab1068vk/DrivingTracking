import { clamp, finiteNumber } from './numberUtils.js';
import { fatigueReportScore, normalizeFatigueSelfReport } from './fatigueSelfReport.js';

const DEFAULT_CONSTANTS = Object.freeze({
  PENALTY_SCALE_FACTOR: 40,
  FATIGUE_SAFETY_PENALTY_SCALE: 0.15,
  FATIGUE_SAFETY_MAX_PENALTY: 15,
});

function surveyRatingToTargetScore(rating) {
  const normalized = Number(rating);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 5) {
    throw new Error('Survey rating must be an integer from 1 to 5.');
  }
  return (normalized - 1) * 25;
}

function labelTargetScore(label) {
  const target = finiteNumber(label?.surveyLabel?.targetScore ?? label?.survey?.target_score ?? label?.target_score);
  if (target != null) return clamp(target, 0, 100);

  const rating = label?.surveyLabel?.overallDriveRating ?? label?.survey?.rating ?? label?.survey_rating;
  return surveyRatingToTargetScore(rating);
}

function labelFatigueSelfReport(label) {
  return normalizeFatigueSelfReport(
    label?.surveyLabel?.fatigue_self_report ??
    label?.surveyLabel?.fatigueSelfReport ??
    label?.survey?.fatigue_self_report ??
    label?.fatigue_self_report
  );
}

function labelFatigueRisk(label) {
  const summary = label?.tripFeatureSummary || label?.trip_feature_summary || {};
  const features = label?.calibration_features || label?.features || {};
  return finiteNumber(features.fatigue_risk_score ?? summary.fatigueRisk ?? label?.fatigue_risk_score, 0);
}

function labelPenaltyRate(label) {
  const summary = label?.tripFeatureSummary || label?.trip_feature_summary || {};
  const features = label?.calibration_features || label?.features || {};
  return finiteNumber(
    features.penalty_rate_per_km ??
    features.actual_penalty_rate_per_km ??
    summary.penaltyRatePerKm ??
    label?.penalty_rate_per_km,
    0
  );
}

function currentFatigueDeduction(fatigueRisk) {
  return Math.min(
    fatigueRisk * DEFAULT_CONSTANTS.FATIGUE_SAFETY_PENALTY_SCALE,
    DEFAULT_CONSTANTS.FATIGUE_SAFETY_MAX_PENALTY
  );
}

function inferredBaselineSafety(label, fatigueRisk, penaltyRate) {
  const features = label?.calibration_features || label?.features || {};
  const explicit = finiteNumber(
    features.non_fatigue_safety_score ??
    features.fatigue_baseline_safety_score ??
    label?.non_fatigue_safety_score
  );
  if (explicit != null) return clamp(explicit, 0, 100);

  const scoredSafety = finiteNumber(label?.scoreOutput?.safety ?? label?.score_output?.safety);
  if (scoredSafety != null) return clamp(scoredSafety + currentFatigueDeduction(fatigueRisk), 0, 100);

  return clamp(100 - (penaltyRate * DEFAULT_CONSTANTS.PENALTY_SCALE_FACTOR), 0, 100);
}

function fatigueLabelRow(label) {
  const fatigueSelfReport = labelFatigueSelfReport(label);
  if (!fatigueSelfReport) return null;

  try {
    const fatigueRisk = labelFatigueRisk(label);
    const penaltyRate = labelPenaltyRate(label);

    return {
      label,
      fatigueSelfReport,
      fatigueReportScore: fatigueReportScore(fatigueSelfReport),
      fatigueRisk,
      targetScore: labelTargetScore(label),
      baselineSafety: inferredBaselineSafety(label, fatigueRisk, penaltyRate),
    };
  } catch {
    return null;
  }
}

export function fatigueCalibrationRows(labels = []) {
  return (Array.isArray(labels) ? labels : [])
    .map(fatigueLabelRow)
    .filter(Boolean);
}

export function countFatigueCalibrationLabels(labels = []) {
  return fatigueCalibrationRows(labels).length;
}
