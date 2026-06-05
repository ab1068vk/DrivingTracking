import { clamp, mean, percentile, round } from './numberUtils.js';

const SCALE_SEARCH = Object.freeze({
  min: 0,
  max: 1,
  step: 0.001,
});

function predictedSafety(row, scale, maxPenalty = Number.POSITIVE_INFINITY) {
  const fatigueDeduction = Math.min(row.fatigueRisk * scale, maxPenalty);
  return clamp(row.baselineSafety - fatigueDeduction, 0, 100);
}

function meanAbsoluteError(rows, scale) {
  const errors = rows.map((row) => Math.abs(row.targetScore - predictedSafety(row, scale)));
  return mean(errors) ?? Number.POSITIVE_INFINITY;
}

function candidateScales() {
  const count = Math.round((SCALE_SEARCH.max - SCALE_SEARCH.min) / SCALE_SEARCH.step);
  return Array.from({ length: count + 1 }, (_, index) => SCALE_SEARCH.min + (index * SCALE_SEARCH.step));
}

export function fitFatiguePenaltyScale(rows) {
  const best = candidateScales().reduce((winner, scale) => {
    const mae = meanAbsoluteError(rows, scale);
    return mae < winner.mae ? { scale, mae } : winner;
  }, { scale: 0, mae: Number.POSITIVE_INFINITY });

  return round(best.scale, 3);
}

export function fittedFatigueDeductions(rows, scale) {
  return rows.map((row) => Math.max(0, row.baselineSafety - predictedSafety(row, scale)));
}

export function fitFatigueMaxPenalty(rows, scale) {
  const veryTiredDeductions = fittedFatigueDeductions(
    rows.filter((row) => row.fatigueSelfReport === 'very_tired'),
    scale
  );
  return round(clamp(percentile(veryTiredDeductions, 0.95, 15), 0, 100), 2);
}

export function predictFatigueSafety(row, constants) {
  return predictedSafety(
    row,
    constants.FATIGUE_SAFETY_PENALTY_SCALE,
    constants.FATIGUE_SAFETY_MAX_PENALTY
  );
}
