import { describe, expect, it } from 'vitest';
import {
  SCORE_ESTIMATE_NOTICE,
  formatEstimatedScore,
  formatScoreWithProvenance,
  isApproximateScoreOutput,
  scoreEstimateProgressText,
} from '@/lib/scoreDisplay';

describe('score display formatting', () => {
  it('marks approximate score provenance with a tilde', () => {
    expect(isApproximateScoreOutput({ calibration_status: 'approximate' })).toBe(true);
    expect(formatScoreWithProvenance(88, { calibration_status: 'approximate' })).toBe('~88');
  });

  it('can withhold the tilde after score output calibration is proven', () => {
    expect(isApproximateScoreOutput({ calibration_status: 'calibrated' })).toBe(false);
    expect(formatScoreWithProvenance(88, { calibration_status: 'calibrated' })).toBe('88');
  });

  it('keeps current and legacy score values approximate by default', () => {
    expect(formatEstimatedScore(88)).toBe('~88');
    expect(formatScoreWithProvenance(88)).toBe('~88');
  });

  it('uses the expanded score estimate disclaimer and early-trip progress copy', () => {
    expect(SCORE_ESTIMATE_NOTICE).toContain('personal driving estimates based on GPS patterns');
    expect(SCORE_ESTIMATE_NOTICE).toContain('insurance, legal, or safety-critical decisions');
    expect(scoreEstimateProgressText(9)).toBe('Estimate - improves after 1 more trip');
    expect(scoreEstimateProgressText(10)).toBeNull();
  });
});
