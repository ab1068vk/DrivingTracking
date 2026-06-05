import { describe, expect, it } from 'vitest';
import { explainTripScoreDrivers } from '@/lib/scoring/scoreExplainer';

describe('read-only trip score explanations', () => {
  it('ranks weaker stored components without changing the trip', () => {
    const trip = {
      component_scores: {
        braking_efficiency: { value: 58, evidence: 'high' },
        speed_limit_compliance: { value: 76, evidence: 'developing' },
        cornering_consistency: { value: 91, evidence: 'high' },
        eco_driving: { value: 82, evidence: 'high' },
      },
    };
    const before = structuredClone(trip);

    expect(explainTripScoreDrivers(trip)).toEqual([
      expect.objectContaining({ factor: 'braking_efficiency', score: 58, deficit: 42 }),
      expect.objectContaining({ factor: 'speed_limit_compliance', score: 76, deficit: 24 }),
      expect.objectContaining({ factor: 'eco_driving', score: 82, deficit: 18 }),
    ]);
    expect(trip).toEqual(before);
  });

  it('falls back to existing headline scores and recorded events for legacy trips', () => {
    expect(explainTripScoreDrivers({
      score_safety: 72,
      score_smoothness: 88,
      score_eco: 91,
      harsh_brakes_count: 2,
    })).toEqual([
      expect.objectContaining({ factor: 'safety', score: 72 }),
      expect.objectContaining({ factor: 'harsh_brakes_count', count: 2 }),
      expect.objectContaining({ factor: 'smoothness', score: 88 }),
    ]);
  });

  it('omits missing evidence instead of inventing score drivers', () => {
    expect(explainTripScoreDrivers({})).toEqual([]);
    expect(explainTripScoreDrivers({
      component_scores: {
        braking_efficiency: { value: null, evidence: 'unavailable' },
      },
    })).toEqual([]);
  });
});
