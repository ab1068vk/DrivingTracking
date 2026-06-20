import { describe, expect, it } from 'vitest';
import {
  scoreDeltaSummary,
  speedLimitScorePreview,
  speedLimitSourceLabel,
  summarizeTripScoreDeltas,
} from '@/lib/speedLimitDisplay';

describe('speed limit display helpers', () => {
  it('uses consistent labels for user-confirmed and estimated speeds', () => {
    expect(speedLimitSourceLabel('user_confirmed_posted_sign')).toBe('Your confirmed posted sign');
    expect(speedLimitSourceLabel('user_confirmed_posted_sign', { short: true })).toBe('Posted sign');
    expect(speedLimitSourceLabel('user_entered_estimate')).toBe('Your saved estimate');
  });

  it('summarizes score changes after rescoring', () => {
    expect(scoreDeltaSummary(82, 88)).toBe('Score updated: 82 -> 88.');
    expect(scoreDeltaSummary(88, 88)).toBe('Score unchanged at 88.');
    expect(summarizeTripScoreDeltas(
      [{ id: 'a', score_overall: 70 }],
      [{ id: 'a', score_overall: 76 }]
    )[0]).toMatchObject({
      text: 'Score updated: 70 -> 76.',
      changed: true,
    });
  });

  it('previews likely score direction from speed limit edits', () => {
    expect(speedLimitScorePreview(50, 60)).toContain('Likely raises');
    expect(speedLimitScorePreview(60, 50)).toContain('Likely lowers');
    expect(speedLimitScorePreview(50, 50)).toContain('Likely no score change');
  });
});

