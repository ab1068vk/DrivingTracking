import { describe, expect, it } from 'vitest';
import {
  calculateRoadTypeSegmentedScores,
  calculateTripStats,
  classifyRoadType,
  classifyRoadTypesByPointDetailed,
  detectDrivingEvents,
  DEFAULT_THRESHOLDS,
  inferSpeedZones,
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

  it('uses OSM road class ahead of the driver speed when road lookup is enabled', () => {
    const congestedMotorway = route(90, 12, 0.00027).map((entry) => ({
      ...entry,
      speed_limit_highway: 'motorway',
      speed_limit_source: 'osm_highway_default',
    }));
    const classification = classifyRoadType(congestedMotorway);
    const details = classifyRoadTypesByPointDetailed(congestedMotorway);

    expect(classification).toMatchObject({
      road_type: 'highway',
      road_type_source: 'openstreetmap',
    });
    expect(classification.road_type_confidence).toBeGreaterThanOrEqual(0.76);
    expect(details.every((item) => item.road_type === 'highway' && item.source === 'openstreetmap')).toBe(true);
  });

  it('does not let high driving speed override an OSM residential road', () => {
    const fastResidential = route(30, 92, 0.00025).map((entry) => ({
      ...entry,
      speed_limit_highway: 'residential',
      speed_limit_source: 'osm_highway_default',
    }));
    const classification = classifyRoadType(fastResidential);
    const zones = inferSpeedZones(fastResidential, DEFAULT_THRESHOLDS);

    expect(classification).toMatchObject({
      road_type: 'residential',
      road_type_source: 'openstreetmap',
    });
    expect(zones.every((zone) => (
      zone.road_type === 'residential' &&
      zone.road_type_source === 'openstreetmap'
    ))).toBe(true);
  });

  it('keeps OSM optional and reports a local GPS-pattern source when map fields are absent', () => {
    const localOnlyHighwayPattern = route(60, 100, 0.00027).map((entry) => ({
      ...entry,
      heading: 0,
    }));

    expect(classifyRoadType(localOnlyHighwayPattern)).toMatchObject({
      road_type: 'highway',
      road_type_source: 'gps_pattern',
    });
  });

  it('can ignore stored OSM fields when the user disables map road context', () => {
    const mappedRoute = route(40, 35, 0.0001).map((entry) => ({
      ...entry,
      speed_limit_highway: 'motorway',
    }));

    expect(classifyRoadType(mappedRoute)).toMatchObject({
      road_type: 'highway',
      road_type_source: 'openstreetmap',
    });
    expect(classifyRoadType(mappedRoute, { allowOsm: false }).road_type_source).toBe('gps_pattern');
  });

  it('gives a user-confirmed road type priority over conflicting map metadata', () => {
    const corrected = route(20, 90, 0.00025).map((entry) => ({
      ...entry,
      road_type: 'urban',
      road_type_source: 'user_confirmed',
      speed_limit_highway: 'motorway',
    }));

    expect(classifyRoadType(corrected)).toMatchObject({
      road_type: 'urban',
      road_type_source: 'user_confirmed',
    });
  });

  it('stores road classification provenance with each segmented score', () => {
    const congestedMotorway = route(90, 12, 0.00027).map((entry) => ({
      ...entry,
      speed_limit_highway: 'motorway',
      speed_limit_source: 'osm_highway_default',
    }));
    const stats = calculateTripStats(
      congestedMotorway,
      congestedMotorway[0].timestamp,
      congestedMotorway.at(-1).timestamp
    );
    const scores = calculateRoadTypeSegmentedScores(
      congestedMotorway,
      [],
      stats,
      DEFAULT_THRESHOLDS
    );

    expect(scores.highway_score).toMatchObject({
      road_type_source: 'openstreetmap',
    });
    expect(scores.highway_score?.road_type_confidence).toBeGreaterThanOrEqual(0.76);
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

    expect(Math.abs(shortScore - longScore)).toBeLessThanOrEqual(25);
  });
});
