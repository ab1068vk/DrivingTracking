import { describe, expect, it } from 'vitest';
import {
  buildCalibrationLabelPayload,
  dataQualityFlagsForCalibration,
  getCalibrationMilestone,
  getNextCalibrationMilestone,
} from '@/lib/calibrationLabeling';
import { fitCalibrationDataset, surveyRatingToTargetScore } from '@/lib/calibrationFitting';
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

  it('builds anonymized post-trip survey labels without route geometry or private trip fields', () => {
    const payload = buildCalibrationLabelPayload(completedTrip, 4, {
      submittedAt: '2026-05-26T18:00:00.000Z',
      anonymousInstallIdHash: 'install_hash',
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
    expect(result.suggested_constants.FATIGUE_SAFETY_PENALTY_SCALE.calibration_status).toBe('heuristic_beta');
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
    }));

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
});
