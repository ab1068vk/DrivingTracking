import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { cleanRoutePoints } from '@/engine/utils';
import { detectDrivingEvents } from '@/engine/detection';
import { calculateTripScores, calculateTripStats } from '@/engine/scoring';
import { DEFAULT_THRESHOLDS, EVENT_TYPES, SCORING_VERSION, weightedBlend } from '@/engine/calibration';
import { scoringValue } from '@/lib/scoringConstants';
import { buildPhoneUseGap, buildRealisticScoringTrip } from './fixtures/scoringPipelineTrip';

const scoreValues = (componentScores = {}) => (
  Object.values(componentScores)
    .map((component) => component?.value)
    .filter((value) => value != null)
);

const expectValidComponentScore = (value) => {
  expect(Number.isNaN(value)).toBe(false);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(100);
};

const expectedOverallScore = (scores) => {
  const blend = scoringValue('OVERALL_SCORE_BLEND_WEIGHTS');
  return weightedBlend([
    { score: scores.score_safety, weight: blend.safety },
    { score: scores.score_smoothness, weight: blend.smoothness },
    { score: scores.score_eco, weight: blend.eco },
    { score: scores.intersection_score, weight: blend.intersection },
  ]);
};

describe('scoring pipeline integration', () => {
  it('processes a realistic GPS trip into bounded scores, explanation, and current provenance quickly', () => {
    const routePoints = buildRealisticScoringTrip();
    const thresholds = {
      ...DEFAULT_THRESHOLDS,
      SPEEDING_FALLBACK_KMH: 100,
      PHONE_USE_AFFECTS_SCORE: false,
      ADVANCED_SAFETY_DETECTION_ENABLED: false,
    };

    const started = performance.now();
    const cleaned = cleanRoutePoints(routePoints, thresholds);
    const detected = detectDrivingEvents(cleaned, thresholds, cleaned.at(-1)?.timestamp);
    const stats = calculateTripStats(cleaned, cleaned[0].timestamp, cleaned.at(-1).timestamp, thresholds);
    const scores = calculateTripScores(detected.events, stats, cleaned, thresholds, stats.duration_seconds, buildPhoneUseGap(), {
      endTime: cleaned.at(-1).timestamp,
      includeRoadTypeSegments: false,
    });
    const elapsedMs = performance.now() - started;

    expect(cleaned.length).toBeGreaterThanOrEqual(500);
    expect(stats.distance_km).toBeGreaterThanOrEqual(15);
    expect(detected.events.some((event) => event.type === EVENT_TYPES.HARSH_BRAKE)).toBe(true);
    expect(detected.events.some((event) => event.type === EVENT_TYPES.SPEEDING)).toBe(true);
    expect(scores.phone_use_score_status).toBe('usage_access_required');

    scoreValues(scores.component_scores).forEach(expectValidComponentScore);
    expect(scores.score_provenance.scoring_version).toBe(SCORING_VERSION);
    expect(scores.score_explanation.top_factors.length).toBeGreaterThan(0);
    expect(expectedOverallScore(scores)).toBeCloseTo(scores.score_overall, 0);
    expect(elapsedMs).toBeLessThan(300);
  });
});
