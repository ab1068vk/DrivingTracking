import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_STATUSES,
  SCORING_CONSTANTS,
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
    expect(PHONE_USE_PENALTY_POINTS.high).toBe(scoringValue('PHONE_PENALTY_HIGH'));
    expect(TIME_OF_DAY_NIGHT_MULTIPLIER).toBe(scoringValue('UBI_NIGHT_MULTIPLIER'));
  });

  it('exposes provisional settings and affected score surfaces as approximate', () => {
    expect(getProvisionalScoringConstants().some(({ key }) => key === 'PENALTY_SCALE_FACTOR')).toBe(true);
    expect(calibrationEntryForSetting('threshold_harsh_brake_ms2')).toMatchObject({
      calibration_status: 'provisional',
      key: 'HARSH_BRAKE_MS2',
    });
    expect(hasProvisionalCalibration(['score_overall'])).toBe(true);
    expect(hasProvisionalCalibration(['ubi_score'])).toBe(true);
  });
});
