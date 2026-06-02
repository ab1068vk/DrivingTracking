import { describe, expect, it } from 'vitest';
import {
  addLaplaceNoise,
  buildCalibrationLabelPayload,
  dataQualityFlagsForCalibration,
  readinessSurveySyntheticScore,
  shouldAskFatigueSelfReport,
  shouldAskReadinessSurvey,
  getCalibrationMilestone,
  getCompletionRate,
  getNextCalibrationMilestone,
} from '@/lib/calibrationLabeling';
import { fitCalibrationDataset, fitFatigueConstants, surveyRatingToTargetScore } from '@/lib/calibrationFitting';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { SCORING_VERSION } from '@/lib/scoringVersion.generated';

const completedTrip = {
  id: 'trip_private_id',
  vehicle_id: 'vehicle_private_id',
  status: 'completed',
  nickname: 'Home commute',
  notes: 'Private note',
  tags: ['work'],
  score_overall: 82,
  score_safety: 80,
  score_smoothness: 84,
  score_eco: 90,
  distance_km: 10,
  duration_seconds: 900,
  avg_running_speed_kmh: 50,
  max_speed_kmh: 82,
  night_driving: false,
  fatigue_risk_score: 20,
  route_risk_score: 35,
  harsh_brakes_count: 1,
  speeding_events_count: 1,
  route_points: Array.from({ length: 12 }, (_, index) => ({
    lat: 43.65 + index * 0.001,
    lng: -79.38 - index * 0.001,
    speed_kmh: 40 + index,
    accuracy: 8,
  })),
  driving_events: [
    { type: 'harsh_brake', severity: 'medium', lat: 43.65, lng: -79.38, timestamp: '2026-01-01T12:00:00.000Z' },
    { type: 'speeding', severity: 'low', lat: 43.66, lng: -79.39, timestamp: '2026-01-01T12:01:00.000Z' },
  ],
  score_provenance: {
    scoring_version: SCORING_VERSION,
    calibration_status: 'approximate',
    provisional_constants: ['PENALTY_SCALE_FACTOR'],
    constants_snapshot: { PENALTY_SCALE_FACTOR: 40 },
  },
};

const fatigueEligibleTrip = {
  ...completedTrip,
  duration_seconds: 60 * 60,
  end_time: '2026-01-01T22:15:00',
};

const makeReadinessTrip = (overrides = {}) => ({
  ...completedTrip,
  duration_seconds: 600,
  pre_trip_readiness_context: {
    signalHistoryRecordId: 'rs_abc',
    evidenceTier: 'calibrated',
  },
  readiness_signal_record_id: 'rs_abc',
  ...overrides,
});

const ratingForBucket = {
  careful: 5,
  normal: 4,
  rushed: 3,
  incident: 1,
};

const targetForBucket = {
  careful: 100,
  normal: 75,
  rushed: 50,
  incident: 0,
};

const syntheticCalibrationLabel = (bucket, index = 0, overrides = {}) => ({
  schemaVersion: 1,
  scoringModelVersion: SCORING_VERSION,
  createdAt: '2026-05-26T18:00:00.000Z',
  dataQualityFlags: [],
  eligibleForCalibration: true,
  surveyLabel: {
    overallDriveRating: ratingForBucket[bucket],
    rating: ratingForBucket[bucket],
    targetScore: targetForBucket[bucket],
    target_score: targetForBucket[bucket],
    wasDriver: 'yes',
    scoreAccuracy: null,
    contextTags: [],
  },
  tripFeatureSummary: {
    distanceKm: 5 + (index % 6),
    durationMin: bucket === 'incident' ? 75 : 35,
    fatigueRisk: bucket === 'incident' ? 70 : 0,
    nightDrive: bucket === 'incident',
    gpsQualityScore: 1,
    sampleCount: 60,
  },
  scoreOutput: {
    overall: targetForBucket[bucket],
    safety: targetForBucket[bucket],
    calibrationStatus: 'approximate',
  },
  calibration_features: {
    penalty_rate_per_km: (100 - targetForBucket[bucket]) / 40,
    fatigue_risk_score: bucket === 'incident' ? 70 : 0,
  },
  ...overrides,
});

const labelsFromDistribution = (distribution) => Object.entries(distribution).flatMap(([bucket, count]) => (
  Array.from({ length: count }, (_, index) => syntheticCalibrationLabel(bucket, index))
));

describe('calibration labeling pipeline', () => {
  it('reports intermediate calibration milestones before full calibration', () => {
    expect(getCalibrationMilestone(5)).toBeNull();
    expect(getNextCalibrationMilestone(5)).toMatchObject({
      count: 10,
      benefit: 'Trip rating history begins',
    });
    expect(getCalibrationMilestone(50)).toMatchObject({
      label: 'Early insights',
      benefit: 'Trend patterns emerging',
    });
    expect(getNextCalibrationMilestone(50)).toMatchObject({
      count: 200,
      benefit: 'Local threshold suggestions unlocked',
    });
    expect(getCalibrationMilestone(2500)).toMatchObject({
      label: 'Fully calibrated',
    });
    expect(getNextCalibrationMilestone(2500)).toBeNull();
  });

  it('returns zero completion rate for unlabeled scored trips without throwing', () => {
    const trips = Array.from({ length: 100 }, (_, index) => ({
      id: `trip_${index}`,
      status: 'completed',
      score_overall: 80,
      start_time: '2026-05-01T12:00:00.000Z',
    }));

    expect(getCompletionRate(trips, [])).toMatchObject({
      labeled: 0,
      total: 100,
      rate: 0,
    });
  });

  it('builds anonymized post-trip survey labels without route geometry or private trip fields', () => {
    const payload = buildCalibrationLabelPayload(completedTrip, 4, {
      submittedAt: '2026-05-26T18:00:00.000Z',
      anonymousInstallIdHash: 'install_hash',
      timestampNoiseRandom: () => 0.5,
    });
    const serialized = JSON.stringify(payload);

    expect(payload).toMatchObject({
      schemaVersion: 1,
      anonymousInstallIdHash: 'install_hash',
      scoringModelVersion: SCORING_VERSION,
      createdAt: '2026-05-26T18:00:00.000Z',
      surveyLabel: {
        overallDriveRating: 4,
        targetScore: 75,
      },
      scoreOutput: {
        overall: 82,
        calibrationStatus: 'approximate',
      },
      tripFeatureSummary: {
        distanceKm: 10,
        durationMin: 15,
        sampleCount: 12,
      },
      eligibleForCalibration: true,
    });
    expect(Object.keys(payload).sort()).toEqual([
      'anonymousInstallIdHash',
      'createdAt',
      'dataQualityFlags',
      'eligibleForCalibration',
      'labelId',
      'schemaVersion',
      'scoreOutput',
      'scoringModelVersion',
      'surveyLabel',
      'tripFeatureSummary',
    ].sort());
    expect(serialized).not.toContain('trip_private_id');
    expect(serialized).not.toContain('vehicle_private_id');
    expect(serialized).not.toContain('Home commute');
    expect(serialized).not.toContain('Private note');
    expect(serialized).not.toContain('43.65');
    expect(serialized).not.toContain('-79.38');
  });

  it('adds calibrated Laplace noise before hour rounding upload timestamps', () => {
    const startTimeMs = Date.parse('2026-05-26T18:00:00.000Z');

    expect(addLaplaceNoise(startTimeMs, 3_600_000, 1.0, () => 0.5))
      .toBe(startTimeMs);
    expect(addLaplaceNoise(startTimeMs, 3_600_000, 1.0, () => 0.75))
      .toBe(Date.parse('2026-05-26T19:00:00.000Z'));

    const payload = buildCalibrationLabelPayload({
      ...completedTrip,
      start_time: '2026-05-26T06:12:00.000Z',
    }, 4, {
      submittedAt: '2026-05-26T18:00:00.000Z',
      timestampNoiseRandom: () => 0.5,
    });

    expect(payload.createdAt).toBe('2026-05-26T06:00:00.000Z');
  });

  it('adds optional fatigue self-report only for long late or overnight trips', () => {
    expect(shouldAskFatigueSelfReport(fatigueEligibleTrip)).toBe(true);
    expect(shouldAskFatigueSelfReport({
      ...fatigueEligibleTrip,
      duration_seconds: 45 * 60,
    })).toBe(false);
    expect(shouldAskFatigueSelfReport({
      ...fatigueEligibleTrip,
      end_time: '2026-01-01T14:15:00',
    })).toBe(false);

    const eligiblePayload = buildCalibrationLabelPayload(fatigueEligibleTrip, {
      overallDriveRating: 4,
      wasDriver: 'yes',
      fatigue_self_report: 'very_tired',
    });
    const ordinaryPayload = buildCalibrationLabelPayload(completedTrip, {
      overallDriveRating: 4,
      wasDriver: 'yes',
      fatigue_self_report: 'very_tired',
    });

    expect(eligiblePayload.surveyLabel.fatigue_self_report).toBe('very_tired');
    expect(ordinaryPayload.surveyLabel.fatigue_self_report).toBeNull();
  });

  it('shouldAskReadinessSurvey returns false for bootstrapping tier', () => {
    const trip = makeReadinessTrip();
    const ctx = { recordId: 'rs_abc', evidenceTier: 'bootstrapping' };

    expect(shouldAskReadinessSurvey(trip, ctx)).toBe(false);
  });

  it('shouldAskReadinessSurvey returns true for calibrated trips with a recordId', () => {
    const trip = makeReadinessTrip();
    const ctx = { recordId: 'rs_abc', evidenceTier: 'calibrated' };

    expect(shouldAskReadinessSurvey(trip, ctx)).toBe(true);
  });

  it('shouldAskReadinessSurvey returns false when already answered', () => {
    const trip = makeReadinessTrip({ readiness_survey_answered: true });
    const ctx = { recordId: 'rs_abc', evidenceTier: 'calibrated' };

    expect(shouldAskReadinessSurvey(trip, ctx)).toBe(false);
  });

  it('stores readiness survey feedback only when the trip is eligible', () => {
    const eligible = buildCalibrationLabelPayload(makeReadinessTrip(), {
      overallDriveRating: 4,
      wasDriver: 'yes',
      readiness_accuracy: 'overestimated_risk',
    });
    const ineligible = buildCalibrationLabelPayload({
      ...makeReadinessTrip(),
      pre_trip_readiness_context: { signalHistoryRecordId: 'rs_abc', evidenceTier: 'bootstrapping' },
    }, {
      overallDriveRating: 4,
      wasDriver: 'yes',
      readiness_accuracy: 'overestimated_risk',
    });

    expect(eligible.surveyLabel.readiness_accuracy).toBe('overestimated_risk');
    expect(ineligible.surveyLabel.readiness_accuracy).toBeNull();
  });

  it('maps readiness survey feedback to synthetic calibration scores', () => {
    const trip = makeReadinessTrip({ score_overall: 80 });
    expect(readinessSurveySyntheticScore('underestimated_risk', {}, trip)).toBe(65);
    expect(readinessSurveySyntheticScore('accurate', {}, trip)).toBe(80);
    expect(readinessSurveySyntheticScore('overestimated_risk', {}, trip)).toBe(95);
    expect(readinessSurveySyntheticScore('no_estimate', {}, trip)).toBeNull();
  });

  it('marks passenger and low-quality trips as ineligible', () => {
    const passenger = buildCalibrationLabelPayload(completedTrip, {
      overallDriveRating: 4,
      wasDriver: 'no',
    });
    const short = buildCalibrationLabelPayload({
      ...completedTrip,
      distance_km: 0.2,
      duration_seconds: 60,
      route_points: completedTrip.route_points.slice(0, 3),
    }, {
      overallDriveRating: 4,
      wasDriver: 'yes',
    });

    expect(passenger.eligibleForCalibration).toBe(false);
    expect(passenger.dataQualityFlags).toContain('passenger_trip');
    expect(short.eligibleForCalibration).toBe(false);
    expect(short.dataQualityFlags).toEqual(expect.arrayContaining(['distance_too_short', 'duration_too_short', 'sample_count_low']));
    expect(dataQualityFlagsForCalibration(completedTrip, passenger.surveyLabel)).toContain('passenger_trip');
  });

  it('can skip the survey without creating a calibration label', async () => {
    const marker = await localCalibrationLabelRepository.markTripSkipped(`skip_${Date.now()}`);

    expect(marker).toMatchObject({
      skipped: true,
      upload_status: 'skipped',
    });
  });

  it('fits beta suggestions and keeps the calibrated gate closed below the target sample count', () => {
    const labels = [
      buildCalibrationLabelPayload({ ...completedTrip, distance_km: 10, fatigue_risk_score: 10 }, 5),
      buildCalibrationLabelPayload({ ...completedTrip, distance_km: 5, fatigue_risk_score: 60 }, 2),
      buildCalibrationLabelPayload({ ...completedTrip, distance_km: 20, fatigue_risk_score: 30 }, 3),
    ];

    const result = fitCalibrationDataset(labels, { targetCount: 2000 });

    expect(surveyRatingToTargetScore(1)).toBe(0);
    expect(surveyRatingToTargetScore(5)).toBe(100);
    expect(result.dataset).toMatchObject({
      labeled_trip_count: 3,
      target_labeled_trip_count: 2000,
      calibration_ready: false,
      status: 'insufficient_labels',
    });
    expect(result.suggested_constants.PENALTY_SCALE_FACTOR.calibration_status).toBe('heuristic_beta');
    expect(result.suggested_constants.FATIGUE_SAFETY_PENALTY_SCALE).toBeUndefined();
    expect(result.constants_metadata).toMatchObject({
      calibration_status: 'heuristic_beta',
      warning: 'Calibration pending: not enough labeled trips yet.',
    });
    expect(result.citation_comment).toContain('collect at least 2000');
  });

  it('creates a calibration report when at least 2000 eligible labels are available', () => {
    const labels = Array.from({ length: 2000 }, (_, index) => buildCalibrationLabelPayload({
      ...completedTrip,
      distance_km: 5 + (index % 20),
      duration_seconds: 300 + (index % 30) * 10,
      harsh_brakes_count: index % 4,
      rapid_accel_count: index % 3,
      sharp_turns_count: index % 2,
      fatigue_risk_score: index % 100,
      route_risk_score: (index * 3) % 100,
    }, {
      overallDriveRating: (index % 5) + 1,
      scoreAccuracy: index % 7 === 0 ? 'too_high' : 'accurate',
      wasDriver: 'yes',
    })).map((label) => {
      const target = label.surveyLabel.targetScore;
      return {
        ...label,
        surveyLabel: {
          ...label.surveyLabel,
          scoreAccuracy: null,
          targetScore: surveyRatingToTargetScore(label.surveyLabel.overallDriveRating),
          target_score: surveyRatingToTargetScore(label.surveyLabel.overallDriveRating),
        },
        calibration_features: {
          penalty_rate_per_km: (100 - surveyRatingToTargetScore(label.surveyLabel.overallDriveRating)) / 40,
          fatigue_risk_score: 0,
        },
        scoreOutput: {
          ...label.scoreOutput,
          overall: target,
          safety: target,
        },
      };
    });

    const result = fitCalibrationDataset(labels, { targetCount: 2000, datasetId: 'test-dataset' });

    expect(result.dataset).toMatchObject({
      dataset_id: 'test-dataset',
      eligible_labeled_trip_count: 2000,
      calibration_ready: true,
    });
    expect(result.suggested_constants.PENALTY_SCALE_FACTOR.calibration_status).toBe('calibrated_candidate');
    expect(result.validation_error.mae).toEqual(expect.any(Number));
    expect(result.calibration_report).toMatchObject({
      dataset_id: 'test-dataset',
      eligible_trip_count: 2000,
      status: 'calibrated',
    });
  });

  it('fits stratified synthetic labels with confidence intervals and confusion matrix counts', () => {
    const labels = labelsFromDistribution({ normal: 25, careful: 10, rushed: 10, incident: 5 });

    const result = fitCalibrationDataset(labels, { targetCount: 50, bootstrapIterations: 100 });

    Object.values(result.constants).forEach((value) => {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    });
    expect(result.confidenceIntervals.PENALTY_SCALE_FACTOR.low95)
      .toBeLessThan(result.confidenceIntervals.PENALTY_SCALE_FACTOR.high95);
    for (const [bucket, expectedCount] of Object.entries(result.validation.labelDistribution)) {
      const rowTotal = Object.values(result.validation.confusionMatrix[bucket])
        .reduce((sum, count) => sum + count, 0);
      expect(rowTotal).toBe(expectedCount);
    }
  });

  it('fits fatigue constants from fatigue-specific self reports', () => {
    const reports = ['alert', 'normal', 'tired', 'very_tired'];
    const targetByReport = {
      alert: 90,
      normal: 82,
      tired: 68,
      very_tired: 50,
    };
    const riskByReport = {
      alert: 5,
      normal: 25,
      tired: 55,
      very_tired: 85,
    };
    const labels = Array.from({ length: 200 }, (_, index) => {
      const report = reports[index % reports.length];
      return syntheticCalibrationLabel('normal', index, {
        surveyLabel: {
          overallDriveRating: 4,
          rating: 4,
          targetScore: targetByReport[report],
          target_score: targetByReport[report],
          wasDriver: 'yes',
          scoreAccuracy: null,
          contextTags: [],
          fatigue_self_report: report,
        },
        scoreOutput: {
          overall: targetByReport[report],
          safety: targetByReport[report],
          calibrationStatus: 'approximate',
        },
        tripFeatureSummary: {
          distanceKm: 12,
          durationMin: 70,
          fatigueRisk: riskByReport[report],
          nightDrive: true,
          gpsQualityScore: 1,
          sampleCount: 100,
        },
        calibration_features: {
          penalty_rate_per_km: 0,
          fatigue_risk_score: riskByReport[report],
          non_fatigue_safety_score: 92,
        },
      });
    });

    const result = fitFatigueConstants(labels);

    expect(result.FATIGUE_SAFETY_PENALTY_SCALE).toBeGreaterThan(0);
    expect(result.FATIGUE_SAFETY_MAX_PENALTY).toBeGreaterThan(0);
    expect(result.validation).toMatchObject({
      minSampleSize: 200,
      fatigueCorrelation: expect.any(Number),
      alertVsTiredMeanScoreDiff: expect.any(Number),
    });
    expect(result.validation.fatigueCorrelation).toBeGreaterThan(0.9);
    expect(result.validation.alertVsTiredMeanScoreDiff).toBeGreaterThan(20);
  });

  it('throws a minimum-label error when no labels are eligible', () => {
    expect(() => fitCalibrationDataset([])).toThrow(/MIN_CALIBRATION_LABEL_COUNT/);
  });

  it('does not make imbalanced incident labels look artificially better than balanced labels', () => {
    const balanced = labelsFromDistribution({ careful: 10, normal: 10, rushed: 10, incident: 10 });
    const imbalanced = labelsFromDistribution({ careful: 10, normal: 10, rushed: 10, incident: 13 });

    const balancedResult = fitCalibrationDataset(balanced, { targetCount: 100, bootstrapIterations: 100 });
    const imbalancedResult = fitCalibrationDataset(imbalanced, { targetCount: 100, bootstrapIterations: 100 });

    expect(imbalancedResult.validation.crossValidationMAE)
      .toBeGreaterThanOrEqual(balancedResult.validation.crossValidationMAE - 5);
  });
});
