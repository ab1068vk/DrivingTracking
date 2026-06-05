import { mean, pearsonCorrelation, round } from './numberUtils.js';
import { MIN_FATIGUE_CALIBRATION_LABEL_COUNT } from './fatigueSelfReport.js';
import { predictFatigueSafety } from './fatigueScaleFit.js';

function meanPredictedSafety(rows, report, constants) {
  return mean(
    rows
      .filter((row) => row.fatigueSelfReport === report)
      .map((row) => predictFatigueSafety(row, constants))
  );
}

export function validateFatigueFit(rows, constants) {
  const fatigueCorrelation = pearsonCorrelation(rows.map((row) => ({
    x: row.fatigueRisk,
    y: row.fatigueReportScore,
  })));
  const alertMean = meanPredictedSafety(rows, 'alert', constants);
  const veryTiredMean = meanPredictedSafety(rows, 'very_tired', constants);

  return {
    fatigueCorrelation: round(fatigueCorrelation, 3),
    alertVsTiredMeanScoreDiff: alertMean != null && veryTiredMean != null
      ? round(alertMean - veryTiredMean, 3)
      : null,
    minSampleSize: MIN_FATIGUE_CALIBRATION_LABEL_COUNT,
  };
}
