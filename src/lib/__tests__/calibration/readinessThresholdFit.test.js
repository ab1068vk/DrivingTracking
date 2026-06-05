import { describe, expect, it } from 'vitest';
import {
  crossValidateThresholds,
  fitReadinessThresholds,
  GOOD_TRIP_SCORE_FLOOR,
  MIN_PAIRS_FOR_THRESHOLD,
  readinessPairsFromHistory,
} from '@/lib/calibration/readinessThresholdFit';

const makePairs = (count, riskForIndex = (index) => index % 100, scoreForRisk = (risk) => 100 - risk) => (
  Array.from({ length: count }, (_, index) => {
    const compositeRisk = riskForIndex(index);
    return {
      compositeRisk,
      actualScore: scoreForRisk(compositeRisk, index),
    };
  })
);

const makePerfectSeparationPairs = (count = 40) => makePairs(
  count,
  (index) => (index < count / 2 ? 40 : 65),
  (risk) => (risk >= 60 ? GOOD_TRIP_SCORE_FLOOR - 10 : GOOD_TRIP_SCORE_FLOOR + 10)
);

const makeClearSeparationPairs = (count = 50) => makePairs(
  count,
  (index) => (index < count / 2 ? 30 + (index % 10) : 60 + (index % 15)),
  (risk) => (risk >= 55 ? 60 + (risk % 5) : 82 - (risk % 5))
);

describe('readiness threshold fitting', () => {
  it('returns null when fewer than minimum pairs exist', () => {
    expect(fitReadinessThresholds(makePairs(10))).toBeNull();
    expect(fitReadinessThresholds(makePairs(MIN_PAIRS_FOR_THRESHOLD - 1))).toBeNull();
  });

  it('highRiskFloor is always above moderateRiskFloor', () => {
    const result = fitReadinessThresholds(makeClearSeparationPairs(50));

    expect(result.highRiskFloor).toBeGreaterThan(result.moderateRiskFloor);
  });

  it('perfect separation produces F1 of 1.0', () => {
    const result = fitReadinessThresholds(makePerfectSeparationPairs(40));

    expect(result.f1).toBeCloseTo(1);
    expect(result.highRiskFloor).toBeLessThanOrEqual(65);
  });

  it('crossValidateThresholds accuracy is greater than chance for meaningful data', () => {
    const cv = crossValidateThresholds(makeClearSeparationPairs(50));

    expect(cv.accuracy).toBeGreaterThan(0.5);
  });

  it('readinessPairsFromHistory keeps only finite paired risk and outcome records', () => {
    const pairs = readinessPairsFromHistory([
      { compositeRisk: 55, actualScore: 60 },
      { compositeRisk: null, actualScore: 60 },
      { compositeRisk: 40, actualScore: null },
      { compositeRisk: 'bad', actualScore: 80 },
    ]);

    expect(pairs).toEqual([{ compositeRisk: 55, actualScore: 60 }]);
  });
});
