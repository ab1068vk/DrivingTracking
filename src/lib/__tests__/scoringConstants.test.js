import { readFileSync } from 'node:fs';
import { describe, expect, it, test } from 'vitest';
import {
  CALIBRATION_STATUSES,
  DEFAULT_HOURLY_RISK_PROFILE,
  PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS,
  SCORE_OUTPUT_CALIBRATION_STATUSES,
  SCORING_CONSTANTS,
  SCORING_VERSION,
  calibrationStatusForMetrics,
  calibrationEntryForSetting,
  getProvisionalScoringConstants,
  hasProvisionalCalibration,
  scoringValue,
} from '@/lib/scoringConstants';
import { FATIGUE_SAFETY_MAX_PENALTY, FATIGUE_SAFETY_PENALTY_SCALE, PENALTY_SCALE_FACTOR } from '@/lib/appConstants';
import { PHONE_USE_PENALTY_POINTS } from '@/lib/phoneUsageAccess';
import { DEFAULT_THRESHOLDS } from '@/lib/tripEngine';
import { TIME_OF_DAY_NIGHT_MULTIPLIER } from '@/lib/ubiReport';

describe('scoring constants registry', () => {
  it('uses a generated content-hash scoring version', () => {
    expect(SCORING_VERSION).toMatch(/^[a-f0-9]{8}$/);
    expect(SCORING_VERSION).not.toMatch(/^\d+\.\d+\.\d+$/);
  });

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

  test('every constant with @promotionBlocker has a calibrationRequirement comment', () => {
    const source = readFileSync(new URL('../scoringConstants.js', import.meta.url), 'utf8');
    const promotionBlockerBlocks = source.match(/\/\*\*[\s\S]*?@promotionBlocker true[\s\S]*?\*\//g) ?? [];

    expect(promotionBlockerBlocks.length).toBeGreaterThan(0);
    for (const block of promotionBlockerBlocks) {
      expect(block).toContain('@calibrationRequirement');
    }
  });

  test('fatigue promotion blockers keep their literature anchor explicit', () => {
    const source = readFileSync(new URL('../scoringConstants.js', import.meta.url), 'utf8');

    expect(source).toContain('@literatureAnchor Williamson & Feyer (Occup Environ Med 2000;57:649-655)');
    expect(source).toContain('18-hour wakefulness → impairment equivalent to BAC 0.05%');
    expect(source).toContain('Recalibration against fatigue self-reports may update this anchor.');
  });

  it('drives existing scoring exports from the central values', () => {
    expect(PENALTY_SCALE_FACTOR).toBe(scoringValue('PENALTY_SCALE_FACTOR'));
    expect(FATIGUE_SAFETY_PENALTY_SCALE).toBe(scoringValue('FATIGUE_SAFETY_PENALTY_SCALE'));
    expect(FATIGUE_SAFETY_MAX_PENALTY).toBe(scoringValue('FATIGUE_SAFETY_MAX_PENALTY'));
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS).toBe(scoringValue('HILL_INFRACTION_PENALTY_POINTS'));
    expect(DEFAULT_THRESHOLDS.HILL_INFRACTION_PENALTY_POINTS_PER_KM).toBe(scoringValue('HILL_INFRACTION_PENALTY_POINTS_PER_KM'));
    expect(PHONE_USE_PENALTY_POINTS.high).toBe(scoringValue('PHONE_PENALTY_HIGH'));
    expect(TIME_OF_DAY_NIGHT_MULTIPLIER).toBe(scoringValue('UBI_NIGHT_MULTIPLIER'));
  });

  it('keeps blend weights normalized and non-negative', () => {
    const blendConfigs = [
      ['OVERALL_SCORE_BLEND_WEIGHTS', SCORING_CONSTANTS.OVERALL_SCORE_BLEND_WEIGHTS.value],
      ['SAFETY_SCORE_BLEND_WEIGHTS', SCORING_CONSTANTS.SAFETY_SCORE_BLEND_WEIGHTS.value],
      ['SMOOTHNESS_SCORE_BLEND_WEIGHTS', SCORING_CONSTANTS.SMOOTHNESS_SCORE_BLEND_WEIGHTS.value],
      ['ECO_SCORE_BLEND_WEIGHTS', SCORING_CONSTANTS.ECO_SCORE_BLEND_WEIGHTS.value],
      ['DEFENSIVE_SCORE_BLEND_WEIGHTS', SCORING_CONSTANTS.DEFENSIVE_SCORE_BLEND_WEIGHTS.value],
      ['UBI_CATEGORY_WEIGHTS', SCORING_CONSTANTS.UBI_CATEGORY_WEIGHTS.value],
      ['PRE_TRIP_RISK_WEIGHTS', SCORING_CONSTANTS.PRE_TRIP_RISK_WEIGHTS.value],
    ];

    for (const [key, weights] of blendConfigs) {
      const values = Object.values(weights);
      const sum = values.reduce((total, weight) => total + weight, 0);

      expect(sum, key).toBeCloseTo(1.0, 6);
      for (const weight of values) {
        expect(Number.isFinite(weight), key).toBe(true);
        expect(weight, key).toBeGreaterThanOrEqual(0);
      }
    }
    expect(SCORING_CONSTANTS.SAFETY_SCORE_BLEND_WEIGHTS.value.phoneUse).toBe(scoringValue('PHONE_USE_SAFETY_WEIGHT'));
  });

  it('registers the default hourly fallback risk profile with calibration metadata', () => {
    expect(SCORING_CONSTANTS.DEFAULT_HOURLY_RISK_PROFILE).toBe(DEFAULT_HOURLY_RISK_PROFILE);
    expect(scoringValue('DEFAULT_HOURLY_RISK_PROFILE')).toEqual([
      60, 60, 60, 60, 60, 20, 20, 35, 35, 35, 20, 20,
      20, 20, 20, 20, 40, 40, 40, 20, 20, 20, 60, 60,
    ]);
    expect(DEFAULT_HOURLY_RISK_PROFILE).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
      calibration_note: expect.stringContaining('Global default fallback'),
      calibration_metadata: {
        profile_version: 'default-hourly-risk-profile-v1',
        replacement_policy: expect.stringContaining('SCORING_VERSION-gated'),
      },
    });
  });

  it('exposes provisional settings and affected score surfaces as approximate', () => {
    expect(getProvisionalScoringConstants().some(({ key }) => key === 'PENALTY_SCALE_FACTOR')).toBe(true);
    expect(SCORING_CONSTANTS.PENALTY_SCALE_FACTOR).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.PROVISIONAL,
      calibration_note: expect.stringContaining('Uncalibrated'),
      affected_metrics: expect.arrayContaining(['score_overall', 'score_safety']),
      calibration_metadata: {
        calibration_process_id: PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS.process_id,
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
    expect(SCORING_CONSTANTS.FATIGUE_SAFETY_MAX_PENALTY).toMatchObject({
      calibration_status: CALIBRATION_STATUSES.CITED,
      calibration_note: expect.stringContaining('flat Safety score deduction'),
      value: 15,
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
    expect(hasProvisionalCalibration()).toBe(true);
    expect(calibrationStatusForMetrics(['score_overall'])).toBe(SCORE_OUTPUT_CALIBRATION_STATUSES.APPROXIMATE);
  });

  it('documents the repeatable penalty scale calibration process beside the constant', () => {
    const { calibration_metadata: metadata } = SCORING_CONSTANTS.PENALTY_SCALE_FACTOR;
    const process = metadata.calibration_process;

    expect(process).toBe(PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS);
    expect(process.current_runtime_policy).toContain('downstream score outputs approximate');
    expect(process.dataset_requirements.minimum_eligible_labeled_trips).toBe(2000);
    expect(process.dataset_requirements.accepted_label_sources).toEqual(expect.arrayContaining([
      expect.stringContaining('licensed fleet or insurer telematics dataset'),
    ]));
    expect(process.fitting_method.command).toBe('npm run calibration:fit -- <labels.json> --target=2000');
    expect(process.fitting_method.model).toContain('penalty_rate_per_km * PENALTY_SCALE_FACTOR');
    expect(process.promotion_criteria.commit_requirements).toEqual(expect.arrayContaining([
      expect.stringContaining('change SCORING_CONSTANTS.PENALTY_SCALE_FACTOR.calibration_status to calibrated'),
      expect.stringContaining('regenerate the content-derived SCORING_VERSION'),
    ]));
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
