import { describe, expect, it, vi } from 'vitest';
import { summarizeDistanceWeightedScore } from '@/lib/driverScoreSummary';

describe('distance-weighted driver score summary', () => {
  it('weights eligible driver scores by distance and excludes passenger rows', () => {
    const rows = [
      { id: 'short-driver', driver_metric_eligible: true, score_overall: 90, distance_km: 1 },
      { id: 'long-driver', driver_metric_eligible: true, score_overall: 50, distance_km: 9 },
      { id: 'passenger', driver_metric_eligible: false, score_overall: 100, distance_km: 1000 },
    ];
    const scoreForTrip = vi.fn((trip) => ({ value: trip.score_overall, evidence: 'high' }));

    const result = summarizeDistanceWeightedScore(rows, scoreForTrip, {
      includeTrip: (trip) => trip.driver_metric_eligible === true,
    });

    // (90 * 1 + 50 * 9) / 10 = 54. A plain mean would be 80; including the
    // passenger would produce a value close to 100. This one literal catches
    // both mutations without borrowing the production formula.
    expect(result).toEqual({
      avgScore: 54,
      avgScoreEvidence: 'high',
      basis: 'distance_weighted',
      scoredTripCount: 2,
    });
    expect(scoreForTrip).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable instead of substituting a plain mean at zero scored distance', () => {
    const result = summarizeDistanceWeightedScore([
      { score_overall: 90, distance_km: 0 },
      { score_overall: 50 },
    ], (trip) => ({ value: trip.score_overall, evidence: 'developing' }));

    expect(result).toEqual({
      avgScore: null,
      avgScoreEvidence: 'developing',
      basis: 'unavailable',
      scoredTripCount: 2,
    });
  });

  it('visits each included row once for a large loaded view', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => ({
      driver_metric_eligible: index % 2 === 0,
      score_overall: 70,
      distance_km: 1,
    }));
    let scoreReads = 0;

    const result = summarizeDistanceWeightedScore(rows, (trip) => {
      scoreReads += 1;
      return { value: trip.score_overall, evidence: 'high' };
    }, {
      includeTrip: (trip) => trip.driver_metric_eligible === true,
    });

    expect(result.avgScore).toBe(70);
    expect(result.scoredTripCount).toBe(50_000);
    expect(scoreReads).toBe(50_000);
  });
});
