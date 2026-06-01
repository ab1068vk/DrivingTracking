import { SCORING_VERSION } from './scoringVersion.generated.js';

export const MIN_CALIBRATION_LABEL_COUNT = 2000;
export const CALIBRATION_PENDING_MESSAGE = 'Calibration pending: not enough labeled trips yet.';

export class CalibrationQualityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CalibrationQualityError';
    this.details = details;
  }
}

const LABEL_BUCKETS = Object.freeze(['careful', 'normal', 'rushed', 'incident']);
const DEFAULT_CONSTANTS = Object.freeze({
  PENALTY_SCALE_FACTOR: 40,
  FATIGUE_SAFETY_PENALTY_SCALE: 0.15,
  FATIGUE_SAFETY_MAX_PENALTY: 15,
});

const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const finiteNumber = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function surveyRatingToTargetScore(rating) {
  const normalized = Number(rating);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 5) {
    throw new Error('Survey rating must be an integer from 1 to 5.');
  }
  return (normalized - 1) * 25;
}

function scoreBucket(score) {
  const value = clamp(Number(score) || 0, 0, 100);
  if (value >= 85) return 'careful';
  if (value >= 65) return 'normal';
  if (value >= 40) return 'rushed';
  return 'incident';
}

function labelTargetScore(label) {
  const target = finiteNumber(label?.surveyLabel?.targetScore ?? label?.survey?.target_score ?? label?.target_score);
  if (target != null) return clamp(target, 0, 100);
  const base = surveyRatingToTargetScore(label?.surveyLabel?.overallDriveRating ?? label?.survey?.rating ?? label?.survey_rating);
  const accuracy = label?.surveyLabel?.scoreAccuracy ?? label?.survey?.scoreAccuracy;
  if (accuracy === 'too_high') return clamp(base - 10, 0, 100);
  if (accuracy === 'too_low') return clamp(base + 10, 0, 100);
  return base;
}

function labelRating(label) {
  return Number(label?.surveyLabel?.overallDriveRating ?? label?.survey?.rating ?? label?.survey_rating);
}

function labelWasDriver(label) {
  return label?.surveyLabel?.wasDriver ??
    label?.surveyLabel?.was_driver ??
    label?.survey?.wasDriver ??
    label?.survey?.was_driver ??
    label?.was_driver;
}

function labelDistanceKm(label) {
  return finiteNumber(
    label?.tripFeatureSummary?.distanceKm ??
    label?.tripFeatureSummary?.trip_distance_km ??
    label?.trip_feature_summary?.distance_km ??
    label?.trip_distance_km,
    0
  );
}

function labelDurationMin(label) {
  return finiteNumber(
    label?.tripFeatureSummary?.durationMin ??
    label?.trip_feature_summary?.duration_min ??
    label?.duration_min,
    0
  );
}

function labelScoringVersion(label) {
  return label?.scoringModelVersion ??
    label?.scoring_model_version ??
    label?.scoringVersion ??
    label?.scoring_version ??
    label?.scoreOutput?.scoringVersion ??
    null;
}

function labelQualityFlags(label) {
  const flags = label?.dataQualityFlags || label?.qualityFlags || label?.quality_flags || [];
  return Array.isArray(flags) ? flags : [];
}

function labelTimeOfDay(label) {
  return label?.tripFeatureSummary?.timeOfDay ??
    label?.trip_feature_summary?.time_of_day ??
    label?.calibration_features?.time_of_day ??
    label?.features?.time_of_day ??
    null;
}

function isNightTime(value) {
  if (typeof value !== 'string') return false;
  const hour = Number(value.slice(0, 2));
  return Number.isFinite(hour) && (hour >= 22 || hour < 6);
}

function labelFeatures(label) {
  const summary = label?.tripFeatureSummary || label?.trip_feature_summary || {};
  const calibrationFeatures = label?.calibration_features || label?.features || {};
  const distanceKm = labelDistanceKm(label);
  const inferredPenaltyRate = (
    finiteNumber(summary.harshBrakesPer100Km, 0) * 6 +
    finiteNumber(summary.rapidAccelPer100Km, 0) * 5 +
    finiteNumber(summary.sharpTurnsPer100Km, 0) * 5 +
    finiteNumber(summary.speedingRatio, 0) * 10
  ) / 100;

  return {
    ...calibrationFeatures,
    distance_km: distanceKm,
    duration_min: labelDurationMin(label),
    penalty_rate_per_km: finiteNumber(
      calibrationFeatures.penalty_rate_per_km ??
      calibrationFeatures.actual_penalty_rate_per_km ??
      summary.penaltyRatePerKm ??
      label?.penalty_rate_per_km,
      null
    ) ?? inferredPenaltyRate,
    fatigue_risk_score: finiteNumber(calibrationFeatures.fatigue_risk_score ?? summary.fatigueRisk, 0),
    route_risk_score: finiteNumber(calibrationFeatures.route_risk_score ?? summary.routeRisk, 0),
    event_rate_per_km: finiteNumber(calibrationFeatures.event_rate_per_km, null) ??
      ((finiteNumber(summary.harshBrakesPer100Km, 0) + finiteNumber(summary.rapidAccelPer100Km, 0) + finiteNumber(summary.sharpTurnsPer100Km, 0)) / 100),
    city_road_ratio: finiteNumber(calibrationFeatures.city_road_ratio ?? summary.cityRoadRatio, 0),
    highway_road_ratio: finiteNumber(calibrationFeatures.highway_road_ratio ?? summary.highwayRoadRatio, 0),
    night_drive: Boolean(summary.nightDrive || calibrationFeatures.night_drive || isNightTime(labelTimeOfDay(label))),
  };
}

function rejectionReason(label) {
  const wasDriver = labelWasDriver(label);
  if (wasDriver === false || wasDriver === 'false' || wasDriver === 'no' || wasDriver == null) return 'passenger_trip';
  if (labelDistanceKm(label) < 2) return 'trip_distance_too_short';
  const scoringVersion = labelScoringVersion(label);
  if (scoringVersion && scoringVersion !== SCORING_VERSION) return 'scoring_version_mismatch';
  const flags = labelQualityFlags(label);
  if (flags.includes('gps_gaps') || flags.includes('signal_dropout')) return 'gps_signal_quality_rejected';
  if (label?.eligibleForCalibration === false || label?.eligible_for_calibration === false) return 'ineligible_for_calibration';
  if (flags.some((flag) => [
    'passenger_trip',
    'distance_too_short',
    'duration_too_short',
    'gps_quality_low',
    'privacy_masking_high',
    'sample_count_low',
    'test_or_debug_trip',
    'incomplete_or_crash_recovered',
  ].includes(flag))) return 'legacy_quality_flags_rejected';
  return null;
}

function normalizeLabels(labels = []) {
  const rejected = {};
  const rows = [];

  for (const label of Array.isArray(labels) ? labels : []) {
    const reason = rejectionReason(label);
    if (reason) {
      rejected[reason] = (rejected[reason] || 0) + 1;
      continue;
    }
    try {
      const target = labelTargetScore(label);
      rows.push({
        label,
        target,
        actualBucket: scoreBucket(target),
        rating: labelRating(label),
        features: labelFeatures(label),
      });
    } catch {
      rejected.invalid_survey_label = (rejected.invalid_survey_label || 0) + 1;
    }
  }

  return { rows, rejected };
}

function weightedMedian(items, fallback = null) {
  const usable = items
    .map((item) => ({
      value: finiteNumber(item.value),
      weight: Math.max(0, finiteNumber(item.weight, 0)),
    }))
    .filter((item) => item.value != null && item.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (!usable.length) return fallback;
  const total = usable.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of usable) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return usable[usable.length - 1].value;
}

function percentile(values, pct, fallback = null) {
  const usable = values.map((value) => finiteNumber(value)).filter((value) => value != null).sort((a, b) => a - b);
  if (!usable.length) return fallback;
  const index = clamp((usable.length - 1) * pct, 0, usable.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (index - lower);
}

function makeRng(seed = 123456789) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function labelDistribution(rows) {
  return Object.fromEntries(LABEL_BUCKETS.map((bucket) => [
    bucket,
    rows.filter((row) => row.actualBucket === bucket).length,
  ]));
}

function classBalanceWeight(row, distribution, total) {
  const count = Math.max(1, distribution[row.actualBucket] || 1);
  return total / (LABEL_BUCKETS.length * count);
}

function highFatigue(row) {
  return finiteNumber(row.features.duration_min, 0) > 60 || row.features.night_drive === true;
}

function fitPenaltyScale(rows, distribution = labelDistribution(rows)) {
  const total = Math.max(1, rows.length);
  const solutions = rows
    .map((row) => {
      const rate = finiteNumber(row.features.penalty_rate_per_km, 0);
      if (rate <= 0) return null;
      const deduction = clamp(100 - row.target, 0, 100);
      return {
        value: clamp(deduction / rate, 1, 200),
        weight: Math.max(1, finiteNumber(row.features.distance_km, 1)) * classBalanceWeight(row, distribution, total),
      };
    })
    .filter(Boolean);
  return round(weightedMedian(solutions, DEFAULT_CONSTANTS.PENALTY_SCALE_FACTOR), 2);
}

function fitFatigueScale(rows, penaltyScale, distribution = labelDistribution(rows)) {
  const total = Math.max(1, rows.length);
  const solutions = rows
    .filter((row) => highFatigue(row) && ['rushed', 'incident'].includes(row.actualBucket))
    .map((row) => {
      const fatigue = finiteNumber(row.features.fatigue_risk_score, 0);
      if (fatigue <= 0) return null;
      const eventReduction = finiteNumber(row.features.penalty_rate_per_km, 0) * penaltyScale;
      const requiredReduction = Math.max(0, 100 - row.target - eventReduction);
      return {
        value: clamp(requiredReduction / fatigue, 0.001, 1),
        weight: Math.max(1, finiteNumber(row.features.distance_km, 1)) * classBalanceWeight(row, distribution, total),
      };
    })
    .filter(Boolean);
  return round(weightedMedian(solutions, DEFAULT_CONSTANTS.FATIGUE_SAFETY_PENALTY_SCALE), 3);
}

function fitFatigueMaxPenalty(rows, fatigueScale) {
  const deductions = rows
    .filter((row) => highFatigue(row) && row.actualBucket === 'incident')
    .map((row) => finiteNumber(row.features.fatigue_risk_score, 0) * fatigueScale)
    .filter((value) => value > 0);
  return round(clamp(percentile(deductions, 0.95, DEFAULT_CONSTANTS.FATIGUE_SAFETY_MAX_PENALTY), 1, 20), 2);
}

function fitConstants(rows) {
  if (!rows.length) return { ...DEFAULT_CONSTANTS };
  const distribution = labelDistribution(rows);
  const penaltyScale = fitPenaltyScale(rows, distribution);
  const fatigueScale = fitFatigueScale(rows, penaltyScale, distribution);
  const fatigueMax = fitFatigueMaxPenalty(rows, fatigueScale);
  return {
    PENALTY_SCALE_FACTOR: penaltyScale,
    FATIGUE_SAFETY_PENALTY_SCALE: fatigueScale,
    FATIGUE_SAFETY_MAX_PENALTY: fatigueMax,
  };
}

function predictScore(row, constants = DEFAULT_CONSTANTS) {
  const penalty = finiteNumber(row.features.penalty_rate_per_km, 0) *
    finiteNumber(constants.PENALTY_SCALE_FACTOR, DEFAULT_CONSTANTS.PENALTY_SCALE_FACTOR);
  const fatigueRaw = finiteNumber(row.features.fatigue_risk_score, 0) *
    finiteNumber(constants.FATIGUE_SAFETY_PENALTY_SCALE, DEFAULT_CONSTANTS.FATIGUE_SAFETY_PENALTY_SCALE);
  const fatigue = Math.min(fatigueRaw, finiteNumber(constants.FATIGUE_SAFETY_MAX_PENALTY, DEFAULT_CONSTANTS.FATIGUE_SAFETY_MAX_PENALTY));
  return clamp(100 - penalty - fatigue, 0, 100);
}

function rSquared(pairs) {
  if (pairs.length < 2) return null;
  const mean = pairs.reduce((sum, pair) => sum + pair.actual, 0) / pairs.length;
  const ssTotal = pairs.reduce((sum, pair) => sum + (pair.actual - mean) ** 2, 0);
  const ssResidual = pairs.reduce((sum, pair) => sum + (pair.actual - pair.predicted) ** 2, 0);
  return ssTotal > 0 ? clamp(1 - ssResidual / ssTotal, -1, 1) : null;
}

function emptyConfusionMatrix() {
  return Object.fromEntries(LABEL_BUCKETS.map((actual) => [
    actual,
    Object.fromEntries(LABEL_BUCKETS.map((predicted) => [predicted, 0])),
  ]));
}

function confusionMatrix(rows, constants) {
  const matrix = emptyConfusionMatrix();
  for (const row of rows) {
    matrix[row.actualBucket][scoreBucket(predictScore(row, constants))] += 1;
  }
  return matrix;
}

function stratifiedFolds(rows, k = 5) {
  const strata = Object.fromEntries(LABEL_BUCKETS.map((bucket) => [bucket, []]));
  rows.forEach((row) => strata[row.actualBucket].push(row));
  return Array.from({ length: k }, (_, foldIndex) => {
    const holdout = [];
    const train = [];
    for (const bucket of LABEL_BUCKETS) {
      strata[bucket].forEach((row, index) => {
        if (index % k === foldIndex) holdout.push(row);
        else train.push(row);
      });
    }
    return { train: train.length ? train : rows, holdout };
  });
}

function crossValidate(rows, k = 5) {
  const predictions = [];
  for (const fold of stratifiedFolds(rows, k)) {
    if (!fold.holdout.length) continue;
    const constants = fitConstants(fold.train);
    fold.holdout.forEach((row) => {
      predictions.push({
        actual: row.target,
        predicted: predictScore(row, constants),
      });
    });
  }
  if (!predictions.length) return { mae: null, r2: null };
  const mae = predictions.reduce((sum, item) => sum + Math.abs(item.actual - item.predicted), 0) / predictions.length;
  return {
    mae: round(mae, 3),
    r2: round(rSquared(predictions), 3),
  };
}

function bootstrapInterval(rows, fitValue, iterations = 1000, seed = 20260601) {
  if (!rows.length) {
    return { low95: fitValue, high95: fitValue };
  }
  const rng = makeRng(seed);
  const values = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rng() * rows.length)]);
    const constants = fitConstants(sample);
    const value = finiteNumber(fitValue(constants));
    if (value != null) values.push(value);
  }
  const center = fitValue(fitConstants(rows));
  let low95 = round(percentile(values, 0.025, center), 3);
  let high95 = round(percentile(values, 0.975, center), 3);
  if (low95 === high95) {
    low95 = round(low95 - 0.001, 3);
    high95 = round(high95 + 0.001, 3);
  }
  return { low95, high95 };
}

function validationError(rows, constants) {
  if (!rows.length) return { mae: null, rmse: null, n: 0 };
  const errors = rows.map((row) => row.target - predictScore(row, constants));
  const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  return { mae: round(mae, 3), rmse: round(rmse, 3), n: rows.length };
}

function rejectionCount(rejected = {}) {
  return Object.values(rejected).reduce((sum, count) => sum + count, 0);
}

function maybeThrowPromotionGuard({ enoughLabels, validation, confidenceIntervals, enforcePromotionGuards }) {
  if (!enoughLabels && !enforcePromotionGuards) return;
  if (validation.crossValidationMAE != null && validation.crossValidationMAE > 12.0) {
    throw new CalibrationQualityError('Cross-validation MAE too high - not safe to promote', {
      crossValidationMAE: validation.crossValidationMAE,
    });
  }
  const penaltyInterval = confidenceIntervals.PENALTY_SCALE_FACTOR;
  if (penaltyInterval && (penaltyInterval.high95 - penaltyInterval.low95) > 15) {
    throw new CalibrationQualityError('Insufficient data for confident PENALTY_SCALE_FACTOR estimate', {
      confidenceInterval: penaltyInterval,
    });
  }
}

export function buildCalibrationMetadata({
  datasetId = null,
  scoringModelVersion = null,
  eligibleLabeledTripCount = 0,
  validation = {},
  calibrationDate = null,
  minimumLabeledTrips = MIN_CALIBRATION_LABEL_COUNT,
} = {}) {
  const calibrated = eligibleLabeledTripCount >= minimumLabeledTrips;
  return {
    scoring_model_version: scoringModelVersion,
    dataset_id: datasetId,
    eligible_labeled_trip_count: eligibleLabeledTripCount,
    validation_mae: validation.mae ?? validation.crossValidationMAE ?? null,
    validation_rmse: validation.rmse ?? null,
    calibration_date: calibrated ? calibrationDate : null,
    minimum_labeled_trips: minimumLabeledTrips,
    warning: calibrated ? null : CALIBRATION_PENDING_MESSAGE,
    calibration_status: calibrated ? 'calibrated' : 'heuristic_beta',
  };
}

export function fitCalibrationDataset(labels = [], options = {}) {
  const targetCount = Math.max(1, Number(options.targetCount) || MIN_CALIBRATION_LABEL_COUNT);
  const datasetId = options.datasetId || `trip-survey-${new Date().toISOString().slice(0, 10)}`;
  const { rows, rejected } = normalizeLabels(labels);

  if (!rows.length) {
    throw new CalibrationQualityError(`MIN_CALIBRATION_LABEL_COUNT requires eligible calibration labels before fitting; received 0 eligible labels.`, {
      rejected,
      minimumLabeledTrips: MIN_CALIBRATION_LABEL_COUNT,
    });
  }

  const constants = fitConstants(rows);
  const confidenceIntervals = {
    PENALTY_SCALE_FACTOR: bootstrapInterval(rows, (fit) => fit.PENALTY_SCALE_FACTOR, options.bootstrapIterations ?? 1000, 17),
    FATIGUE_SAFETY_PENALTY_SCALE: bootstrapInterval(rows, (fit) => fit.FATIGUE_SAFETY_PENALTY_SCALE, options.bootstrapIterations ?? 1000, 29),
    FATIGUE_SAFETY_MAX_PENALTY: bootstrapInterval(rows, (fit) => fit.FATIGUE_SAFETY_MAX_PENALTY, options.bootstrapIterations ?? 1000, 41),
  };
  const cv = crossValidate(rows, options.kFold || 5);
  const validation = {
    crossValidationMAE: cv.mae,
    crossValidationR2: cv.r2,
    confusionMatrix: confusionMatrix(rows, constants),
    labelDistribution: labelDistribution(rows),
    eligibleCount: rows.length,
    rejectedCount: rejectionCount(rejected),
    rejectedReasons: rejected,
  };
  const enoughLabels = rows.length >= targetCount;

  maybeThrowPromotionGuard({
    enoughLabels,
    validation,
    confidenceIntervals,
    enforcePromotionGuards: options.enforcePromotionGuards === true,
  });

  const error = validationError(rows, constants);
  const outputStatus = enoughLabels ? 'calibrated' : 'heuristic_beta';
  const proposalStatus = enoughLabels ? 'calibrated_candidate' : 'heuristic_beta';
  const metadata = {
    fittedAt: options.fittedAt || new Date().toISOString(),
    scoringVersionUsed: SCORING_VERSION,
    labelSchemaVersion: String(options.labelSchemaVersion || labels.find(Boolean)?.schemaVersion || '1'),
  };

  return {
    constants,
    confidenceIntervals,
    validation,
    metadata,
    dataset: {
      dataset_id: datasetId,
      labeled_trip_count: rows.length,
      eligible_labeled_trip_count: rows.length,
      target_labeled_trip_count: targetCount,
      calibration_ready: enoughLabels,
      status: enoughLabels ? 'calibrated_candidate' : 'insufficient_labels',
      train_count: rows.length,
      validation_count: rows.length,
      rejected_labeled_trip_count: rejectionCount(rejected),
    },
    suggested_constants: {
      PENALTY_SCALE_FACTOR: {
        value: constants.PENALTY_SCALE_FACTOR,
        confidence_interval: confidenceIntervals.PENALTY_SCALE_FACTOR,
        fitted_sample_count: rows.length,
        calibration_status: proposalStatus,
      },
      FATIGUE_SAFETY_PENALTY_SCALE: {
        value: constants.FATIGUE_SAFETY_PENALTY_SCALE,
        confidence_interval: confidenceIntervals.FATIGUE_SAFETY_PENALTY_SCALE,
        fitted_sample_count: rows.filter(highFatigue).length,
        calibration_status: proposalStatus,
      },
      FATIGUE_SAFETY_MAX_PENALTY: {
        value: constants.FATIGUE_SAFETY_MAX_PENALTY,
        confidence_interval: confidenceIntervals.FATIGUE_SAFETY_MAX_PENALTY,
        fitted_sample_count: rows.filter((row) => highFatigue(row) && row.actualBucket === 'incident').length,
        calibration_status: proposalStatus,
      },
    },
    route_risk_weights: {
      weights: null,
      n: rows.length,
      note: 'Route-risk weights require a separate segment-level route outcome fit.',
    },
    validation_error: error,
    constants_metadata: buildCalibrationMetadata({
      datasetId,
      scoringModelVersion: SCORING_VERSION,
      eligibleLabeledTripCount: rows.length,
      validation: { ...error, ...validation },
      calibrationDate: options.calibrationDate || new Date().toISOString().slice(0, 10),
      minimumLabeledTrips: targetCount,
    }),
    calibration_report: {
      dataset_id: datasetId,
      eligible_trip_count: rows.length,
      rejected_trip_count: rejectionCount(rejected),
      validation_mae: validation.crossValidationMAE,
      validation_r2: validation.crossValidationR2,
      status: outputStatus,
      message: enoughLabels
        ? 'Calibration candidate produced from stratified cross-validation.'
        : CALIBRATION_PENDING_MESSAGE,
    },
    citation_comment: enoughLabels
      ? `Calibration candidate from labeled post-trip survey dataset ${datasetId} (eligible n=${rows.length}, cross-validation MAE=${validation.crossValidationMAE}, R2=${validation.crossValidationR2}). Human review required before committing constants.`
      : `Provisional fit only: collect at least ${targetCount} labeled trips before treating constants as calibrated.`,
  };
}
