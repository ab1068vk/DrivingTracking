/**
 * Label count required to fit the global provisional penalty scale.
 *
 * This target belongs to the OFFLINE fitting script
 * (`scripts/fit-calibration-labels.mjs`), not to anything running on a user's
 * device. Label upload is hard-disabled (`canUploadCalibrationLabels()` returns
 * false), so survey labels stay `local_only` and a single device can never
 * reach this count. Nothing in the app should present it as user-facing
 * progress; on-device surveys feed personal detection thresholds via
 * `thresholdCalibration.js` instead.
 */
export const MIN_CALIBRATION_LABEL_COUNT = 2000;
export const CALIBRATION_PENDING_MESSAGE = 'Calibration pending: not enough labeled trips yet.';

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

function labelTargetScore(label) {
  const target = finiteNumber(label?.surveyLabel?.targetScore ?? label?.survey?.target_score ?? label?.target_score);
  if (target != null) return clamp(target, 0, 100);
  const base = surveyRatingToTargetScore(label?.surveyLabel?.overallDriveRating ?? label?.survey?.rating ?? label?.survey_rating);
  const accuracy = label?.surveyLabel?.scoreAccuracy ?? label?.survey?.scoreAccuracy;
  if (accuracy === 'too_high') return clamp(base - 10, 0, 100);
  if (accuracy === 'too_low') return clamp(base + 10, 0, 100);
  return base;
}

function labelFeatures(label) {
  const summary = label?.tripFeatureSummary || label?.trip_feature_summary || {};
  const inferredPenaltyRate = (
    finiteNumber(summary.harshBrakesPer100Km, 0) * 6 +
    finiteNumber(summary.rapidAccelPer100Km, 0) * 5 +
    finiteNumber(summary.sharpTurnsPer100Km, 0) * 5 +
    finiteNumber(summary.speedingRatio, 0) * 10
  ) / 100;
  return {
    ...(label?.calibration_features || label?.features || {}),
    penalty_rate_per_km: finiteNumber(label?.calibration_features?.penalty_rate_per_km, null) ?? inferredPenaltyRate,
    fatigue_risk_score: finiteNumber(label?.calibration_features?.fatigue_risk_score ?? summary.fatigueRisk, 0),
    route_risk_score: finiteNumber(label?.calibration_features?.route_risk_score ?? summary.routeRisk, 0),
    event_rate_per_km: finiteNumber(label?.calibration_features?.event_rate_per_km, null) ??
      ((finiteNumber(summary.harshBrakesPer100Km, 0) + finiteNumber(summary.rapidAccelPer100Km, 0) + finiteNumber(summary.sharpTurnsPer100Km, 0)) / 100),
    city_road_ratio: finiteNumber(label?.calibration_features?.city_road_ratio ?? summary.cityRoadRatio, 0),
    highway_road_ratio: finiteNumber(label?.calibration_features?.highway_road_ratio ?? summary.highwayRoadRatio, 0),
  };
}

function isEligibleLabel(label) {
  if (label?.eligibleForCalibration === false || label?.eligible_for_calibration === false) return false;
  const flags = label?.dataQualityFlags || label?.qualityFlags || label?.quality_flags || [];
  return !flags.some((flag) => [
    'passenger_trip',
    'distance_too_short',
    'duration_too_short',
    'gps_quality_low',
    'privacy_masking_high',
    'sample_count_low',
    'test_or_debug_trip',
    'incomplete_or_crash_recovered',
  ].includes(flag));
}

function rSquared(rows, predict) {
  if (rows.length < 2) return null;
  const targets = rows.map((row) => row.target);
  const mean = targets.reduce((sum, value) => sum + value, 0) / targets.length;
  const ssTotal = targets.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  const ssResidual = rows.reduce((sum, row) => sum + (row.target - predict(row)) ** 2, 0);
  return ssTotal > 0 ? clamp(1 - ssResidual / ssTotal, -1, 1) : null;
}

function fitPenaltyScale(rows) {
  const usable = rows
    .map((row) => ({
      rate: finiteNumber(row.features.penalty_rate_per_km, 0),
      target: row.target,
    }))
    .filter((row) => row.rate > 0);

  const denominator = usable.reduce((sum, row) => sum + row.rate ** 2, 0);
  if (!usable.length || denominator <= 0) {
    return { value: null, r2: null, n: usable.length };
  }

  const numerator = usable.reduce((sum, row) => sum + row.rate * (100 - row.target), 0);
  const value = clamp(numerator / denominator, 0, 200);
  const fitRows = usable.map((row) => ({ ...row, target: row.target }));
  const r2 = rSquared(fitRows, (row) => clamp(100 - row.rate * value, 0, 100));

  return { value: round(value, 2), r2: round(r2, 3), n: usable.length };
}

function fitFatigueScale(rows, penaltyScale) {
  const usable = rows
    .map((row) => {
      const fatigue = finiteNumber(row.features.fatigue_risk_score, 0);
      const eventReduction = finiteNumber(row.features.penalty_rate_per_km, 0) * (penaltyScale || 0);
      return {
        fatigue,
        requiredReduction: Math.max(0, 100 - row.target - eventReduction),
        target: row.target,
        eventReduction,
      };
    })
    .filter((row) => row.fatigue > 0);

  const denominator = usable.reduce((sum, row) => sum + row.fatigue ** 2, 0);
  if (!usable.length || denominator <= 0) {
    return { value: null, r2: null, n: usable.length };
  }

  const numerator = usable.reduce((sum, row) => sum + row.fatigue * row.requiredReduction, 0);
  const value = clamp(numerator / denominator, 0, 1);
  const r2 = rSquared(usable, (row) => clamp(100 - row.eventReduction - row.fatigue * value, 0, 100));

  return { value: round(value, 3), r2: round(r2, 3), n: usable.length };
}

function covarianceWeight(rows, featureKey) {
  const pairs = rows
    .map((row) => ({
      x: finiteNumber(row.features[featureKey]),
      y: (100 - row.target) / 100,
    }))
    .filter((row) => row.x != null);
  if (pairs.length < 2) return 0;

  const normalizedPairs = pairs.map((row) => ({
    x: Math.abs(row.x) > 1 ? row.x / 100 : row.x,
    y: row.y,
  }));
  const meanX = normalizedPairs.reduce((sum, row) => sum + row.x, 0) / normalizedPairs.length;
  const meanY = normalizedPairs.reduce((sum, row) => sum + row.y, 0) / normalizedPairs.length;
  const covariance = normalizedPairs.reduce((sum, row) => sum + (row.x - meanX) * (row.y - meanY), 0);
  return Math.max(0, covariance);
}

function fitRouteRiskWeights(rows) {
  const raw = {
    event_rate: covarianceWeight(rows, 'event_rate_per_km'),
    fatigue: covarianceWeight(rows, 'fatigue_risk_score'),
    route_risk: covarianceWeight(rows, 'route_risk_score'),
  };
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return {
      weights: null,
      n: rows.length,
      note: 'No positive relationship between available route-risk features and survey risk.',
    };
  }
  return {
    weights: Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, round(value / total, 3)])),
    n: rows.length,
    note: 'Normalized positive covariance against survey-derived risk; review before committing constants.',
  };
}

function splitTrainValidation(rows, validationRatio = 0.2) {
  const validationSize = Math.max(1, Math.floor(rows.length * validationRatio));
  return {
    train: rows.slice(0, Math.max(1, rows.length - validationSize)),
    validation: rows.slice(Math.max(1, rows.length - validationSize)),
  };
}

function predictScore(row, fitted) {
  const penaltyScale = finiteNumber(fitted.penaltyScale, 40);
  const fatigueScale = finiteNumber(fitted.fatigueScale, 0.15);
  const routeRiskWeight = finiteNumber(fitted.routeRiskWeight, 0);
  const cityModifier = finiteNumber(fitted.cityPenaltyModifier, 1);
  const highwayModifier = finiteNumber(fitted.highwayPenaltyModifier, 1);
  const roadModifier = 1 +
    (finiteNumber(row.features.city_road_ratio, 0) * (cityModifier - 1)) +
    (finiteNumber(row.features.highway_road_ratio, 0) * (highwayModifier - 1));
  const penalty = finiteNumber(row.features.penalty_rate_per_km, 0) * penaltyScale * Math.max(0, roadModifier);
  const fatigue = finiteNumber(row.features.fatigue_risk_score, 0) * fatigueScale;
  const route = finiteNumber(row.features.route_risk_score, 0) * routeRiskWeight;
  return clamp(100 - penalty - fatigue - route, 0, 100);
}

function validationError(rows, fitted) {
  if (!rows.length) return { mae: null, rmse: null, n: 0 };
  const errors = rows.map((row) => row.target - predictScore(row, fitted));
  const mae = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  return { mae: round(mae, 3), rmse: round(rmse, 3), n: rows.length };
}

function fitRouteRiskWeight(rows, penaltyScale, fatigueScale) {
  const usable = rows.map((row) => {
    const routeRisk = finiteNumber(row.features.route_risk_score, 0);
    const baseReduction = finiteNumber(row.features.penalty_rate_per_km, 0) * (penaltyScale || 0) +
      finiteNumber(row.features.fatigue_risk_score, 0) * (fatigueScale || 0);
    return {
      routeRisk,
      requiredReduction: Math.max(0, 100 - row.target - baseReduction),
    };
  }).filter((row) => row.routeRisk > 0);
  const denominator = usable.reduce((sum, row) => sum + row.routeRisk ** 2, 0);
  if (!usable.length || denominator <= 0) return { value: null, n: usable.length };
  const numerator = usable.reduce((sum, row) => sum + row.routeRisk * row.requiredReduction, 0);
  return { value: round(clamp(numerator / denominator, 0, 1), 3), n: usable.length };
}

function roadModifier(rows, key) {
  const withRoad = rows.filter((row) => finiteNumber(row.features[key], 0) > 0.5);
  const withoutRoad = rows.filter((row) => finiteNumber(row.features[key], 0) <= 0.5);
  if (withRoad.length < 20 || withoutRoad.length < 20) return 1;
  const avgError = (items) => items.reduce((sum, row) => sum + (100 - row.target), 0) / items.length;
  return round(clamp(avgError(withRoad) / Math.max(1, avgError(withoutRoad)), 0.5, 1.5), 3);
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
  const validationMetrics = /** @type {{ mae?: number | null, rmse?: number | null }} */ (validation || {});
  return {
    scoring_model_version: scoringModelVersion,
    dataset_id: datasetId,
    eligible_labeled_trip_count: eligibleLabeledTripCount,
    validation_mae: validationMetrics.mae ?? null,
    validation_rmse: validationMetrics.rmse ?? null,
    calibration_date: calibrated ? calibrationDate : null,
    minimum_labeled_trips: minimumLabeledTrips,
    warning: calibrated ? null : CALIBRATION_PENDING_MESSAGE,
    calibration_status: calibrated ? 'calibrated' : 'heuristic_beta',
  };
}

export function fitCalibrationDataset(labels = [], options = {}) {
  const targetCount = Math.max(1, Number(options.targetCount) || MIN_CALIBRATION_LABEL_COUNT);
  const datasetId = options.datasetId || `trip-survey-${new Date().toISOString().slice(0, 10)}`;
  const rows = (Array.isArray(labels) ? labels : [])
    .filter(isEligibleLabel)
    .map((label) => {
      try {
        return {
          label,
          target: labelTargetScore(label),
          features: labelFeatures(label),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const { train, validation } = splitTrainValidation(rows);
  const penaltyScale = fitPenaltyScale(train);
  const fatigueScale = fitFatigueScale(train, penaltyScale.value);
  const routeRiskWeight = fitRouteRiskWeight(train, penaltyScale.value, fatigueScale.value);
  const routeRiskWeights = fitRouteRiskWeights(train);
  const fitted = {
    penaltyScale: penaltyScale.value,
    fatigueScale: fatigueScale.value,
    routeRiskWeight: routeRiskWeight.value,
    cityPenaltyModifier: roadModifier(train, 'city_road_ratio'),
    highwayPenaltyModifier: roadModifier(train, 'highway_road_ratio'),
  };
  const error = validationError(validation, fitted);
  const enoughLabels = rows.length >= targetCount;
  const outputStatus = enoughLabels ? 'calibrated' : 'heuristic_beta';
  const proposalStatus = enoughLabels ? 'calibrated_candidate' : 'heuristic_beta';

  return {
    dataset: {
      dataset_id: datasetId,
      labeled_trip_count: rows.length,
      eligible_labeled_trip_count: rows.length,
      target_labeled_trip_count: targetCount,
      calibration_ready: enoughLabels,
      status: enoughLabels ? 'calibrated_candidate' : 'insufficient_labels',
      train_count: train.length,
      validation_count: validation.length,
    },
    suggested_constants: {
      PENALTY_SCALE_FACTOR: {
        value: penaltyScale.value,
        r2: penaltyScale.r2,
        fitted_sample_count: penaltyScale.n,
        calibration_status: proposalStatus,
      },
      FATIGUE_SAFETY_PENALTY_SCALE: {
        value: fatigueScale.value,
        r2: fatigueScale.r2,
        fitted_sample_count: fatigueScale.n,
        calibration_status: proposalStatus,
      },
      ROUTE_RISK_WEIGHT: {
        value: routeRiskWeight.value,
        fitted_sample_count: routeRiskWeight.n,
        calibration_status: proposalStatus,
      },
      CITY_PENALTY_MODIFIER: {
        value: fitted.cityPenaltyModifier,
        calibration_status: proposalStatus,
      },
      HIGHWAY_PENALTY_MODIFIER: {
        value: fitted.highwayPenaltyModifier,
        calibration_status: proposalStatus,
      },
    },
    route_risk_weights: routeRiskWeights,
    validation_error: error,
    constants_metadata: buildCalibrationMetadata({
      datasetId,
      scoringModelVersion: options.scoringModelVersion ?? labels.find(Boolean)?.scoringModelVersion ?? null,
      eligibleLabeledTripCount: rows.length,
      validation: error,
      calibrationDate: options.calibrationDate || new Date().toISOString().slice(0, 10),
      minimumLabeledTrips: targetCount,
    }),
    calibration_report: {
      dataset_id: datasetId,
      eligible_trip_count: rows.length,
      train_count: train.length,
      validation_count: validation.length,
      validation_mae: error.mae,
      validation_rmse: error.rmse,
      status: outputStatus,
      message: enoughLabels
        ? 'Calibration candidate produced from eligible labeled trips.'
        : CALIBRATION_PENDING_MESSAGE,
    },
    citation_comment: enoughLabels
      ? `Calibration candidate from labeled post-trip survey dataset ${datasetId} (eligible n=${rows.length}, validation MAE=${error.mae}, RMSE=${error.rmse}). Human review required before committing constants.`
      : `Provisional fit only: collect at least ${targetCount} labeled trips before treating constants as calibrated.`,
  };
}
