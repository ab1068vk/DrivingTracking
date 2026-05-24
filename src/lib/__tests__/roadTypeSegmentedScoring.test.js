import { describe, expect, it } from 'vitest';
import {
  calculateRoadTypeSegmentedScores,
  calculateTripStats,
  detectDrivingEvents,
  DEFAULT_THRESHOLDS,
} from '@/lib/tripEngine';

const point = (index, speedKmh = 95, latStep = 0.00025) => ({
  lat: 43.65 + index * latStep,
  lng: -79.38,
  speed_kmh: speedKmh,
  accuracy: 5,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

const route = (count, speedKmh, latStep) => Array.from({ length: count }, (_, index) => point(index, speedKmh, latStep));

describe('road-type segmented scoring', () => {
  it('handles empty route points', () => {
    expect(calculateRoadTypeSegmentedScores([], [], {}, DEFAULT_THRESHOLDS)).toMatchObject({
      highway_score: null,
      urban_score: null,
      residential_score: null,
      dominant_road_type: 'mixed',
    });
  });

  it('handles a single route point', () => {
    expect(calculateRoadTypeSegmentedScores([point(0)], [], {}, DEFAULT_THRESHOLDS).highway_score).toBeNull();
  });

  it('scores a deterministic highway segment', () => {
    const points = route(90, 100, 0.00027);
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const events = detectDrivingEvents(points).events;
    const scores = calculateRoadTypeSegmentedScores(points, events, stats, DEFAULT_THRESHOLDS);

    expect(scores.highway_score?.overall).toBeGreaterThan(0);
    expect(scores.highway_score?.confidence).toBeGreaterThan(0);
    expect(scores.dominant_road_type).toBe('highway');
  });

  it('requires sufficient distance and duration before scoring a segment', () => {
    const points = route(20, 100, 0.0001);
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    expect(calculateRoadTypeSegmentedScores(points, [], stats, DEFAULT_THRESHOLDS).highway_score).toBeNull();
  });

  it('keeps same-rate highway scoring stable across doubled distance', () => {
    const short = route(90, 100, 0.00027);
    const long = route(180, 100, 0.00027);
    const shortStats = calculateTripStats(short, short[0].timestamp, short.at(-1).timestamp);
    const longStats = calculateTripStats(long, long[0].timestamp, long.at(-1).timestamp);
    const shortScore = calculateRoadTypeSegmentedScores(short, [], shortStats, DEFAULT_THRESHOLDS).highway_score.overall;
    const longScore = calculateRoadTypeSegmentedScores(long, [], longStats, DEFAULT_THRESHOLDS).highway_score.overall;

    expect(Math.abs(shortScore - longScore)).toBeLessThanOrEqual(15);
  });
});
