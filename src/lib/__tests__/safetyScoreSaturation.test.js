/**
 * Guards against penalty saturation in the safety score.
 *
 * `baseSafety` is `100 - min(penaltyRate * PENALTY_SCALE_FACTOR, 100)` where
 * `penaltyRate = totalPenalty / distanceKm`. A high-severity harsh brake is 12
 * points scaled by up to 1.92 for speed, so ~23. At the original scale of 40
 * that produced a 263-point deduction against a 100-point cap on a 3.5 km trip:
 * every trip under ~9 km with one such event pinned to the floor, one harsh
 * brake and ten scored identically, and marking a false detection "Wrong"
 * could not move the score at all.
 *
 * These tests pin the sensitivity that the scale of 5 restores. If someone
 * raises PENALTY_SCALE_FACTOR again, or grows the per-event penalties without
 * rechecking the product, they fail — which is the point.
 *
 * The scale remains provisional and uncalibrated. When
 * `PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS` in scoringConstants.js is
 * completed against a labelled dataset, update the bounds here rather than
 * deleting the tests, so the range stays covered.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';

const buildRoute = (brakeIndexes, pointCount) => {
  const points = [];
  const start = Date.parse('2026-03-01T13:00:00.000Z');
  let lat = 43.6500;
  for (let index = 0; index < pointCount; index += 1) {
    const speed = brakeIndexes.includes(index) ? 25 : 85;
    points.push({
      lat: Number(lat.toFixed(7)),
      lng: -79.3800,
      speed_kmh: speed,
      accuracy: 5,
      altitude: 100,
      timestamp: new Date(start + (index * 1000)).toISOString(),
    });
    lat += (speed / 3.6) / 111320;
  }
  return points;
};

const scoreRoute = (pointCount, { dropFirstEvent = false } = {}) => {
  const points = buildRoute([60, 100], pointCount);
  const stats = calculateTripStats(points, DEFAULT_THRESHOLDS);
  const { events } = detectDrivingEvents(
    points,
    DEFAULT_THRESHOLDS,
    points[points.length - 1].timestamp,
    []
  );
  const scored = calculateTripScores(
    dropFirstEvent ? events.slice(1) : events,
    stats,
    points,
    DEFAULT_THRESHOLDS,
    stats.duration_seconds,
    null,
    {}
  );
  return { stats, events, scored };
};

describe('safety score penalty saturation', () => {
  it('detects both harsh brakes so the comparison is about scoring, not detection', () => {
    const { events } = scoreRoute(150);
    expect(events.filter((event) => event.type === 'harsh_brake')).toHaveLength(2);
  });

  it('distinguishes one harsh brake from two on a short trip', () => {
    const both = scoreRoute(150);
    const one = scoreRoute(150, { dropFirstEvent: true });
    expect(both.stats.distance_km).toBeLessThan(5);
    expect(one.scored.harsh_brakes_count).toBe(1);
    expect(both.scored.harsh_brakes_count).toBe(2);
    // This is the whole point of the scale change: on a short trip, removing a
    // false detection has to move the headline score. At the previous scale of
    // 40 both of these read 16 and marking an event "Wrong" did nothing.
    expect(one.scored.score_safety).toBeGreaterThan(both.scored.score_safety);
    expect(one.scored.score_overall).toBeGreaterThan(both.scored.score_overall);
    expect(one.scored.component_scores.aggressive_driving.value)
      .toBeGreaterThan(both.scored.component_scores.aggressive_driving.value);
  });

  it('leaves headroom rather than pinning a single event to the floor', () => {
    const one = scoreRoute(150, { dropFirstEvent: true });
    // One harsh brake on a 3.5 km trip used to deduct 263 points against a
    // 100-point cap. A single ordinary event must not exhaust the whole range.
    expect(one.scored.score_safety).toBeGreaterThan(50);
    expect(one.scored.score_safety).toBeLessThan(100);
  });

  it('regains sensitivity only once the trip is long enough to escape the cap', () => {
    const both = scoreRoute(900);
    const one = scoreRoute(900, { dropFirstEvent: true });
    expect(both.stats.distance_km).toBeGreaterThan(15);
    expect(one.scored.score_safety).toBeGreaterThan(both.scored.score_safety);
  });

  it('still separates a clean trip from a penalized one at every distance', () => {
    for (const pointCount of [150, 900]) {
      const penalized = scoreRoute(pointCount);
      const points = buildRoute([], pointCount);
      const stats = calculateTripStats(points, DEFAULT_THRESHOLDS);
      const clean = calculateTripScores(
        [], stats, points, DEFAULT_THRESHOLDS, stats.duration_seconds, null, {}
      );
      expect(clean.score_safety).toBeGreaterThan(penalized.scored.score_safety);
    }
  });
});
