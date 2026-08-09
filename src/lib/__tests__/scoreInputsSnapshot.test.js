import { describe, it, expect } from 'vitest';
import {
  buildScoreInputsSnapshot,
  isScoreInputsSnapshotUsable,
  SCORE_INPUTS_VERSION,
} from '@/lib/scoring/scoreInputsSnapshot';
import { calculateTripScores, DEFAULT_THRESHOLDS } from '@/lib/tripEngine';

const point = (lat = 51.5, lng = -0.1) => ({ lat, lng });

describe('buildScoreInputsSnapshot', () => {
  it('counts only the points compliance reported as scored', () => {
    // Compliance scored index 2 alone (0 was stationary, 1 sat at the
    // threshold), so the denominator must be 1 even though 3 points exist.
    const snapshot = buildScoreInputsSnapshot({
      points: [point(), point(), point()],
      scoredPointIndexes: [2],
      speedLimitContexts: [
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 50 },
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 50 },
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 50 },
      ],
      roadTypesByPoint: ['urban', 'urban', 'urban'],
      stationarySpeedKmh: 5,
    });

    expect(snapshot.scored_sample_count).toBe(1);
    expect(snapshot.total_point_count).toBe(3);
    expect(snapshot.placed_point_count).toBe(3);
    expect(snapshot.speed_limit_sources[0].count).toBe(1);
  });

  it('counts points without coordinates out of the placed total', () => {
    const snapshot = buildScoreInputsSnapshot({
      points: [point(), { lat: null, lng: null }],
      scoredPointIndexes: [0, 1],
      speedLimitContexts: [{ limitSource: 'inferred' }, { limitSource: 'inferred' }],
      roadTypesByPoint: ['urban', 'urban'],
      stationarySpeedKmh: 5,
    });

    expect(snapshot.total_point_count).toBe(2);
    expect(snapshot.placed_point_count).toBe(1);
  });

  it('splits region-derived sources by country but not posted sources', () => {
    const snapshot = buildScoreInputsSnapshot({
      points: [point(), point(), point()],
      scoredPointIndexes: [0, 1, 2],
      speedLimitContexts: [
        { limitSource: 'region_default_estimate', speedLimitDefaultCountry: 'GB' },
        { limitSource: 'region_default_estimate', speedLimitDefaultCountry: 'fr' },
        { limitSource: 'openstreetmap', speedLimitDefaultCountry: 'GB' },
      ],
      roadTypesByPoint: ['urban', 'urban', 'highway'],
      stationarySpeedKmh: 5,
    });

    const keys = snapshot.speed_limit_sources.map((entry) => entry.key).sort();
    expect(keys).toEqual([
      'openstreetmap',
      'region_default_estimate:fr',
      'region_default_estimate:gb',
    ]);
    // Posted evidence is never split by country, so it stays a single row.
    const posted = snapshot.speed_limit_sources.find((entry) => entry.key === 'openstreetmap');
    expect(posted.count).toBe(1);
  });

  it('stores raw counts rather than percentages so copy changes need no rescore', () => {
    const snapshot = buildScoreInputsSnapshot({
      points: [point(), point(), point(), point()],
      scoredPointIndexes: [0, 1, 2, 3],
      speedLimitContexts: [
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 50 },
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 50 },
        { limitSource: 'openstreetmap', confidence: 0.9, effectiveLimitKmh: 30 },
        { limitSource: 'inferred', confidence: 0.35, effectiveLimitKmh: 60 },
      ],
      roadTypesByPoint: ['urban', 'urban', 'residential', 'highway'],
      stationarySpeedKmh: 5,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(/percent/);
    expect(serialized).not.toMatch(/OpenStreetMap posted/);
    const posted = snapshot.speed_limit_sources.find((entry) => entry.source === 'openstreetmap');
    expect(posted.count).toBe(3);
    expect(posted.limits).toEqual([30, 50]);
    expect(snapshot.road_type_counts).toEqual({ urban: 2, residential: 1, highway: 1 });
  });

  it('records the region profile in force when scoring ran', () => {
    const snapshot = buildScoreInputsSnapshot({
      points: [point()],
      scoredPointIndexes: [0],
      speedLimitContexts: [{ limitSource: 'osm_highway_default' }],
      roadTypesByPoint: ['urban'],
      stationarySpeedKmh: 5,
      fallbackCountry: 'GB',
    });

    expect(snapshot.fallback_country).toBe('gb');
    expect(snapshot.speed_limit_sources[0].key).toBe('osm_highway_default:gb');
  });

  it('returns an empty but usable snapshot for a trip with no route points', () => {
    const snapshot = buildScoreInputsSnapshot({ points: [] });
    expect(snapshot.scored_sample_count).toBe(0);
    expect(snapshot.speed_limit_sources).toEqual([]);
    expect(isScoreInputsSnapshotUsable(snapshot)).toBe(true);
  });
});

describe('calculateTripScores integration', () => {
  const routePoint = (index) => ({
    lat: 43.6532 + index * 0.001,
    lng: -79.3832,
    timestamp: new Date(1700000000000 + index * 10000).toISOString(),
    speed_kmh: 45,
    accuracy: 6,
  });

  it('freezes a usable inputs snapshot on every scored trip', () => {
    const points = Array.from({ length: 12 }, (_, index) => routePoint(index));
    const scores = calculateTripScores(
      [],
      { distance_km: 10, fatigue_risk_score: 0 },
      points,
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(isScoreInputsSnapshotUsable(scores.score_inputs)).toBe(true);
    expect(scores.score_inputs.total_point_count).toBe(12);
    expect(scores.score_inputs.scored_sample_count).toBeGreaterThan(0);
    expect(scores.score_inputs.speed_limit_sources.length).toBeGreaterThan(0);
  });

  it('stamps provenance and the inputs snapshot with one timestamp', () => {
    // The page renders "Score last calculated <time>" from provenance while the
    // source rows come from the snapshot; two clocks would let them disagree.
    const points = Array.from({ length: 12 }, (_, index) => routePoint(index));
    const scores = calculateTripScores(
      [],
      { distance_km: 10, fatigue_risk_score: 0 },
      points,
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.score_inputs.computed_at).toBe(scores.score_provenance.computed_at);
  });

  it('never counts stationary points toward the scored denominator', () => {
    const points = Array.from({ length: 12 }, (_, index) => ({
      ...routePoint(index),
      // Same coordinate repeated, so every point is parked.
      lat: 43.6532,
      speed_kmh: 0,
    }));
    const scores = calculateTripScores(
      [],
      { distance_km: 0, fatigue_risk_score: 0 },
      points,
      DEFAULT_THRESHOLDS,
      600,
      {},
      { includeRoadTypeSegments: false }
    );

    expect(scores.score_inputs.scored_sample_count).toBe(0);
    expect(scores.score_inputs.placed_point_count).toBe(12);
  });
});

describe('isScoreInputsSnapshotUsable', () => {
  it('rejects missing, malformed, and future-version snapshots', () => {
    expect(isScoreInputsSnapshotUsable(null)).toBe(false);
    expect(isScoreInputsSnapshotUsable(undefined)).toBe(false);
    expect(isScoreInputsSnapshotUsable({})).toBe(false);
    expect(isScoreInputsSnapshotUsable({
      version: SCORE_INPUTS_VERSION + 1,
      scored_sample_count: 4,
      speed_limit_sources: [],
    })).toBe(false);
    expect(isScoreInputsSnapshotUsable({
      version: SCORE_INPUTS_VERSION,
      scored_sample_count: 4,
    })).toBe(false);
  });
});
