import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_STATUSES,
  SCORE_OUTPUT_CALIBRATION_STATUSES,
  SCORING_CONSTANTS,
  calibrationStatusForMetrics,
  calibrationEntryForSetting,
  getProvisionalScoringConstants,
  hasProvisionalCalibration,
  scoringValue,
} from '@/lib/scoringConstants';
import { FATIGUE_SAFETY_PENALTY_SCALE, PENALTY_SCALE_FACTOR } from '@/lib/appConstants';
import { PHONE_USE_PENALTY_POINTS } from '@/lib/phoneUsageAccess';
import { DEFAULT_THRESHOLDS } from '@/lib/tripEngine';
import { TIME_OF_DAY_NIGHT_MULTIPLIER } from '@/lib/ubiReport';

describe('scoring constants registry', () => {
  it('registers domain constants with explicit calibration metadata', () => {
    const validStatuses = new Set(Object.values(CALIBRATION_STATUSES));

    expect(Object.keys(SCORING_CONSTANTS).length).toBeGreaterThan(30);
    Object.entries(SCORING_CONSTANTS).forEach(([key, entry]) => {
      expect(entry.label, key).toEqual(expect.any(String));
      expect(entry.domain, key).toEqual(expect.any(String));
      expect(entry.calibration_note, key).toEqual(expect.any(String));
      expect(validStatuses.has(entry.calibration_status), key).toBe(true);
    });
  });

  it('drives existing scoring exports from the central values', () => {
    expect(PENALTY_SCALE_FACTOR).toBe(scoringValue('PENALTY_SCALE_FACTOR'));
    expect(FATIGUE_SAFETY_PENALTY_SCALE).toBe(scoringValue('FATIGUE_SAFETY_PENALTY_SCALE'));
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS).toBe(scoringValue('HILL_INFRACTION_PENALTY_POINTS'));
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS_PER_KM).toBe(scoringValue('HILL_INFRACTION_PENALTY_POINTS_PER_KM'));
    expect(PHONE_USE_PENALTY_POINTS.high).toBe(scoringValue('PHONE_PENALTY_HIGH'));
    expect(TIME_OF_DAY_NIGHT_MULTIPLIER).toBe(scoringValue('UBI_NIGHT_MULTIPLIER'));
  });

  it('exposes provisional settings and affected score surfaces as approximate', () => {
    expect(getProvisionalScoringConstants().some(({ key }) => key === 'PENALTY_SCALE_FACTOR')).toBe(true);
    expect(SCORING_CONSTANTS.PENALTY_SCALE_FACTOR).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
      calibration_note: expect.stringContaining('Uncalibrated'),
      affected_metrics: expect.arrayContaining(['score_overall', 'score_safety']),
      calibration_metadata: {
        eligible_labeled_trip_count: 0,
        minimum_labeled_trips: 2000,
        warning: 'Calibration pending: not enough labeled trips yet.',
        calibration_status: 'heuristic_beta',
      },
    });
    expect(SCORING_CONSTANTS.FATIGUE_SAFETY_PENALTY_SCALE).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.CITED,
      calibration_note: expect.stringContaining('Williamson & Feyer'),
      calibration_metadata: {
        warning: 'Calibration pending: not enough labeled trips yet.',
      },
      value: 0.15,
    });
    expect(SCORING_CONSTANTS.HILL_INFRACTION_PENALTY_POINTS_PER_KM).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
      calibration_note: expect.stringContaining('per-km normalization'),
      value: 8,
    });
    expect(calibrationEntryForSetting('threshold_harsh_brake_ms2')).toMatchObject({
      calibration_status: 'provisional',
      key: 'HARSH_BRAKE_MS2',
    });
    expect(hasProvisionalCalibration(['score_overall'])).toBe(true);
    expect(hasProvisionalCalibration(['ubi_score'])).toBe(true);
    expect(calibrationStatusForMetrics(['score_overall'])).toBe(SCORE_OUTPUT_CALIBRATION_STATUSES.APPROXIMATE);
  });

  it('auto-flips score output status when affected constants are no longer provisional', () => {
    const validatedRegistry = {
      PENALTY_SCALE_FACTOR: {
        calibration_status: CALIBRATION_STATUSES.CALIBRATED,
        affected_metrics: ['score_overall', 'score_safety'],
      },
      FATIGUE_SAFETY_PENALTY_SCALE: {
        calibration_status: CALIBRATION_STATUSES.CITED,
        affected_metrics: ['score_overall', 'score_safety'],
      },
      UBI_NIGHT_MULTIPLIER: {
        calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
        affected_metrics: ['ubi_score'],
      },
    };

    expect(hasProvisionalCalibration(['score_overall'], validatedRegistry)).toBe(false);
    expect(calibrationStatusForMetrics(['score_overall'], validatedRegistry)).toBe(SCORE_OUTPUT_CALIBRATION_STATUSES.CALIBRATED);
    expect(calibrationStatusForMetrics(['ubi_score'], validatedRegistry)).toBe(SCORE_OUTPUT_CALIBRATION_STATUSES.APPROXIMATE);
  });
});
