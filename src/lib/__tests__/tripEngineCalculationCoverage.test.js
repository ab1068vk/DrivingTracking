import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  calculateAcceleration,
  calculateAggressiveDrivingScore,
  calculateBearing,
  calculateDefensiveDrivingScore,
  calculateEcoDrivingScore,
  calculateFuelBandScore,
  calculateJerkScore,
  calculateNightPenalty,
  calculateRouteSummary,
  calculateSpeedKmh,
  calculateTripScores,
  calculateTripStats,
  classifyRoadType,
  detectDrivingEvents,
  extractBrakingSequences,
  headingDiff,
  inferSpeedZones,
  splitTripAtStops,
  trimParkedTail,
  validateCandidateTrip,
} from '@/lib/tripEngine';

const at = (seconds) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();
const point = (index, patch = {}) => ({
  lat: 43.65 + index * 0.00018,
  lng: -79.38,
  speed_kmh: 45,
  accuracy: 8,
  heading: 0,
  timestamp: at(index * 10),
  ...patch,
});

describe('trip engine calculation coverage', () => {
  it('keeps base geometry calculations finite and direction-aware', () => {
    expect(calculateSpeedKmh(1, 60)).toBe(60);
    expect(calculateAcceleration(36, 72, 10)).toBeCloseTo(1, 1);
    expect(calculateBearing(43.65, -79.38, 43.66, -79.38)).toBeCloseTo(0, 0);
    expect(headingDiff(355, 5)).toBe(10);
  });

  it('preserves route points when parked-tail evidence is absent', () => {
    const moving = Array.from({ length: 8 }, (_, index) => point(index, { speed_kmh: 35 }));
    const parked = Array.from({ length: 8 }, (_, index) => point(8 + index, {
      lat: moving.at(-1).lat + index * 0.000001,
      speed_kmh: 0,
    }));

    const trimmed = trimParkedTail([...moving, ...parked]);

    expect(trimmed.trimmed).toBe(false);
    expect(trimmed.removedPoints).toBe(0);
    expect(trimmed.points.length).toBeGreaterThanOrEqual(moving.length);
  });

  it('validates candidate trips using movement, duration, and distance', () => {
    const route = Array.from({ length: 12 }, (_, index) => point(index, { speed_kmh: 32 }));

    expect(validateCandidateTrip({
      points: route,
      startTime: route[0].timestamp,
      now: route.at(-1).timestamp,
    }).confirmed).toBe(true);
    expect(validateCandidateTrip({
      points: route.slice(0, 2),
      startTime: route[0].timestamp,
      now: route[1].timestamp,
      forceFinal: true,
    }).discarded).toBe(true);
  });

  it('detects braking sequences and harsher event scores on abrupt speed drops', () => {
    const route = [
      point(0, { speed_kmh: 100, timestamp: at(0) }),
      point(1, { speed_kmh: 96, timestamp: at(2) }),
      point(2, { speed_kmh: 0, timestamp: at(4) }),
      point(3, { speed_kmh: 0, timestamp: at(6) }),
      point(4, { speed_kmh: 45, timestamp: at(10) }),
    ];
    const detection = detectDrivingEvents(route, DEFAULT_THRESHOLDS);
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const aggressive = calculateAggressiveDrivingScore(detection.events, stats);

    expect(extractBrakingSequences(route).length).toBeGreaterThan(0);
    expect(detection.events.some((event) => event.type === 'harsh_brake')).toBe(true);
    expect(aggressive.aggressive_driving_score).toBeLessThan(100);
  });

  it('scores smooth eco cruising above stop-and-go driving', () => {
    const cruise = Array.from({ length: 18 }, (_, index) => point(index, { speed_kmh: 82 }));
    const stopGo = Array.from({ length: 18 }, (_, index) => point(index, { speed_kmh: index % 3 === 0 ? 0 : 28 }));
    const cruiseStats = calculateTripStats(cruise, cruise[0].timestamp, cruise.at(-1).timestamp);
    const stopGoStats = calculateTripStats(stopGo, stopGo[0].timestamp, stopGo.at(-1).timestamp);

    expect(calculateEcoDrivingScore(cruise, cruiseStats, DEFAULT_THRESHOLDS).eco_driving_score).toBeGreaterThan(
      calculateEcoDrivingScore(stopGo, stopGoStats, DEFAULT_THRESHOLDS).eco_driving_score
    );
    expect(calculateFuelBandScore(cruise, DEFAULT_THRESHOLDS).fuel_band_score).toBeGreaterThan(
      calculateFuelBandScore(stopGo, DEFAULT_THRESHOLDS).fuel_band_score
    );
  });

  it('classifies route types and speed zones from observed speeds', () => {
    const highway = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 104 }));
    const residential = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: 18 }));
    const highwayZones = inferSpeedZones(highway, DEFAULT_THRESHOLDS);

    expect(classifyRoadType(highway).road_type).toBe('highway');
    expect(classifyRoadType(residential).road_type).toBe('residential');
    expect(highwayZones.some((zone) => zone.inferredZoneKmh >= 100)).toBe(true);
  });

  it('combines stats, events, and phone-use evidence into finite trip scores', () => {
    const route = Array.from({ length: 20 }, (_, index) => point(index, { speed_kmh: index % 5 === 0 ? 95 : 52 }));
    const stats = calculateTripStats(route, route[0].timestamp, route.at(-1).timestamp);
    const events = detectDrivingEvents(route, DEFAULT_THRESHOLDS).events;
    const scores = calculateTripScores(route, stats, events, DEFAULT_THRESHOLDS, stats.duration_seconds, {
      phone_use_score: 55,
      phone_use_risk: 'medium',
      phone_use_total_seconds: 30,
    });

    expect(scores.score_overall).toBeGreaterThanOrEqual(0);
    expect(scores.score_overall).toBeLessThanOrEqual(100);
    expect(Number.isFinite(scores.score_safety)).toBe(true);
    const defensive = calculateDefensiveDrivingScore(scores).defensive_driving_score;
    expect(defensive == null || defensive <= 100).toBe(true);
  });

  it('summarizes full routes and applies night penalties to overnight samples', () => {
    const route = Array.from({ length: 14 }, (_, index) => point(index, {
      timestamp: new Date(Date.UTC(2026, 0, 2, 3, index, 0)).toISOString(),
      speed_kmh: 50,
    }));
    const summary = calculateRouteSummary(route, route[0].timestamp, route.at(-1).timestamp);

    expect(summary.stats.distance_km).toBeGreaterThan(0);
    expect(summary.scores.score_overall).toBeGreaterThan(0);
    expect(calculateNightPenalty(route, DEFAULT_THRESHOLDS)).toBeGreaterThan(0);
    expect(calculateJerkScore(route, DEFAULT_THRESHOLDS)).toMatchObject({
      jerk_score: null,
      jerk_score_confidence: 'insufficient_data',
    });
  });

  it('splits trips around long parked stops', () => {
    const firstLeg = Array.from({ length: 8 }, (_, index) => point(index, { timestamp: at(index * 30), speed_kmh: 35 }));
    const stop = Array.from({ length: 12 }, (_, index) => point(8 + index, {
      lat: firstLeg.at(-1).lat,
      timestamp: at(240 + index * 30),
      speed_kmh: 0,
    }));
    const secondLeg = Array.from({ length: 8 }, (_, index) => point(20 + index, {
      timestamp: at(600 + index * 30),
      speed_kmh: 38,
    }));

    const parts = splitTripAtStops({
      id: 'trip-1',
      start_time: firstLeg[0].timestamp,
      end_time: secondLeg.at(-1).timestamp,
      route_points: [...firstLeg, ...stop, ...secondLeg],
    }, 5);

    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((part) => part.route_points.length > 1)).toBe(true);
  });
});
