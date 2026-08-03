import { describe, expect, it } from 'vitest';
import eventfulSpeeding from '@/lib/__tests__/goldenFixtures/eventful_speeding_v2_1_0.json';
import urbanSmooth from '@/lib/__tests__/goldenFixtures/urban_smooth_v2_1_0.json';
import { METRIC_REGISTRY } from '@/lib/metricRegistry';
import {
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  DEFAULT_THRESHOLDS,
  SCORING_VERSION,
} from '@/lib/tripEngine';

const fixtures = [urbanSmooth, eventfulSpeeding];

const SCORE_KEYS = [
  'score_overall',
  'score_safety',
  'score_smoothness',
  'score_confidence_label',
  'harsh_brakes_count',
  'rapid_accel_count',
  'sharp_turns_count',
  'speeding_events_count',
  'speed_creep_score',
  'aggressive_driving_score',
  'defensive_driving_score',
];

const scoreMetricKeys = SCORE_KEYS.filter((key) => key !== 'score_confidence_label');

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

function componentExpectation(componentScore) {
  return {
    value: componentScore.value,
    evidence: componentScore.evidence,
    dataSource: componentScore.dataSource,
    sampleCount: componentScore.sampleCount,
  };
}

function calculateFixture(fixture) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(fixture.thresholds || {}),
  };
  const stats = calculateTripStats(
    fixture.points,
    fixture.startTime,
    fixture.endTime,
    thresholds
  );
  const detected = detectDrivingEvents(fixture.points, thresholds, fixture.endTime);
  const scores = calculateTripScores(
    detected.events,
    stats,
    fixture.points,
    thresholds,
    stats.duration_seconds,
    detected.phoneUse,
    { endTime: fixture.endTime, includeRoadTypeSegments: false }
  );

  return { stats, scores };
}

describe('golden scoring fixtures', () => {
  it.each(fixtures)('$id keeps canonical scores stable for scoring version $scoring_version', (fixture) => {
    expect(fixture.scoring_version).toBe(SCORING_VERSION);
    expect(fixture.human_verified).toBe(true);
    expect(fixture.points.length).toBeGreaterThan(1);
    expect(fixture.points.every((point) => typeof point.timestamp === 'string')).toBe(true);
    expect(scoreMetricKeys.filter((key) => !METRIC_REGISTRY[key])).toEqual([]);

    const { stats, scores } = calculateFixture(fixture);

    expect(pick(stats, Object.keys(fixture.expected.stats))).toEqual(fixture.expected.stats);
    expect(pick(scores, SCORE_KEYS)).toEqual(fixture.expected.scores);

    for (const [componentKey, expected] of Object.entries(fixture.expected.component_scores)) {
      expect(componentExpectation(scores.component_scores[componentKey])).toEqual(expected);
    }

    expect(scores.score_provenance.scoring_version).toBe(fixture.expected.score_provenance.scoring_version);
    expect(pick(
      scores.score_provenance.components,
      Object.keys(fixture.expected.score_provenance.components)
    )).toEqual(fixture.expected.score_provenance.components);
  });
});
