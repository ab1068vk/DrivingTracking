import { describe, expect, it } from 'vitest';
import {
  formatEstimatedScore,
  formatScoreWithProvenance,
  isApproximateScoreOutput,
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
});
