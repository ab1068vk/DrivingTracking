import { beforeEach, describe, expect, it } from 'vitest';
import {
  LIVE_SCORE_FATIGUE_MIN_SECONDS,
  LIVE_SCORE_MIN_ROUTE_POINTS,
  computeLiveTripScore,
  resetLiveTripScoreCache,
} from '@/lib/liveTripScore';
import {
  DEFAULT_THRESHOLDS,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';

const START_MS = Date.UTC(2026, 6, 1, 8, 0, 0);

const METRES_PER_DEGREE_LAT = 111320;

/**
 * Straight-line northbound drive whose positions are integrated from its own
 * speed profile, so GPS-derived and reported speed agree and the engine's
 * acceleration maths sees a physically consistent track. `harshAt` indexes drop
 * speed hard enough to clear HARSH_BRAKE_MS2, making one window deliberately
 * worse than another.
 */
const buildRoute = ({
  count,
  startMs = START_MS,
  intervalMs = 2000,
  speedKmh = 50,
  harshAt = [],
} = {}) => {
  const points = [];
  let lat = 51.5;
  for (let index = 0; index < count; index += 1) {
    const pointSpeed = harshAt.includes(index) ? 5 : speedKmh;
    points.push({
      lat,
      lng: -0.12,
      timestamp: new Date(startMs + index * intervalMs).toISOString(),
      speed_kmh: pointSpeed,
      accuracy: 5,
    });
    const metres = (pointSpeed / 3.6) * (intervalMs / 1000);
    lat += metres / METRES_PER_DEGREE_LAT;
  }
  return points;
};

const tripWith = (points, overrides = {}) => ({
  id: 'live-1',
  status: 'active',
  start_time: points[0]?.timestamp || new Date(START_MS).toISOString(),
  route_points: points,
  ...overrides,
});

describe('computeLiveTripScore', () => {
  beforeEach(() => {
    resetLiveTripScoreCache();
  });

  it('returns a no_active_trip result when nothing is recording', () => {
    const result = computeLiveTripScore(null, {}, { nowMs: START_MS });

    expect(result.status).toBe('no_active_trip');
    expect(result.provisionalScore).toBeNull();
    expect(result.fatigueAlert).toBe(false);
    expect(result.windowComparison.available).toBe(false);
  });

  it('reports insufficient_data below the minimum route-point count', () => {
    const points = buildRoute({ count: LIVE_SCORE_MIN_ROUTE_POINTS - 1 });
    const result = computeLiveTripScore(tripWith(points), {}, { nowMs: START_MS + 60000 });

    expect(result.status).toBe('insufficient_data');
    expect(result.confidence).toBe('insufficient_data');
    expect(result.provisionalScore).toBeNull();
  });

  it('produces a provisional score once enough evidence exists', () => {
    const points = buildRoute({ count: 400 });
    const result = computeLiveTripScore(tripWith(points), {}, { nowMs: START_MS + 800000 });

    expect(result.status).toBe('ok');
    expect(result.provisionalScore).toBeGreaterThan(0);
    expect(result.provisionalScore).toBeLessThanOrEqual(100);
    expect(result.distanceKm).toBeGreaterThan(0);
    expect(['early', 'developing', 'strong']).toContain(result.confidence);
  });

  it('returns the cached object identity for a second call inside the throttle interval', () => {
    const points = buildRoute({ count: 400 });
    const trip = tripWith(points);
    const first = computeLiveTripScore(trip, {}, { nowMs: START_MS + 800000, minIntervalMs: 20000 });
    const second = computeLiveTripScore(trip, {}, { nowMs: START_MS + 805000, minIntervalMs: 20000 });

    expect(second).toBe(first);
  });

  it('recomputes once the throttle interval elapses', () => {
    const points = buildRoute({ count: 400 });
    const first = computeLiveTripScore(tripWith(points), {}, { nowMs: START_MS + 800000, minIntervalMs: 20000 });
    const later = computeLiveTripScore(
      tripWith(buildRoute({ count: 500 })),
      {},
      { nowMs: START_MS + 825000, minIntervalMs: 20000 }
    );

    expect(later).not.toBe(first);
    expect(later.routePointCount).toBe(500);
  });

  it('keeps separate cache entries per trip id', () => {
    const a = computeLiveTripScore(tripWith(buildRoute({ count: 200 })), {}, { nowMs: START_MS + 400000 });
    const b = computeLiveTripScore(
      tripWith(buildRoute({ count: 300 }), { id: 'live-2' }),
      {},
      { nowMs: START_MS + 400000 }
    );

    expect(a.tripId).toBe('live-1');
    expect(b.tripId).toBe('live-2');
    expect(b.routePointCount).toBe(300);
  });

  it('ranks the loudest event types as score drivers', () => {
    const harshAt = Array.from({ length: 12 }, (_, index) => 20 + index * 12);
    const points = buildRoute({ count: 400, harshAt });
    const result = computeLiveTripScore(tripWith(points), {}, { nowMs: START_MS + 800000 });

    expect(result.topDrivers.length).toBeGreaterThan(0);
    expect(result.topDrivers.length).toBeLessThanOrEqual(3);
    result.topDrivers.forEach((driver) => {
      expect(driver.count).toBeGreaterThan(0);
      expect(driver.per100km).toBeGreaterThan(0);
    });
  });

  it('withholds the window comparison until both ten-minute windows have samples', () => {
    // Every point falls in the first window, so the trailing window is empty.
    const points = buildRoute({ count: 200 });
    const result = computeLiveTripScore(tripWith(points), {}, { nowMs: START_MS + 60 * 60 * 1000 });

    expect(result.windowComparison.available).toBe(false);
    expect(result.fatigueAlert).toBe(false);
  });

  it('matches the Dashboard fatigue comparison it replaces', () => {
    // Calm opening ten minutes, then a hard-braking tail two hours later.
    const head = buildRoute({ count: 200, startMs: START_MS, intervalMs: 2000 });
    const tailStart = START_MS + 2 * 60 * 60 * 1000;
    const tailHarsh = Array.from({ length: 30 }, (_, index) => 5 + index * 6);
    const tail = buildRoute({ count: 200, startMs: tailStart, intervalMs: 2000, harshAt: tailHarsh });
    const points = [...head, ...tail];
    const nowMs = tailStart + 200 * 2000;
    const trip = tripWith(points);

    const result = computeLiveTripScore(trip, {}, { nowMs });

    // Recreate the original inline Dashboard calculation exactly.
    const firstWindowEnd = START_MS + 10 * 60 * 1000;
    const lastWindowStart = nowMs - 10 * 60 * 1000;
    const firstPoints = points.filter((point) => new Date(point.timestamp).getTime() <= firstWindowEnd);
    const lastPoints = points.filter((point) => new Date(point.timestamp).getTime() >= lastWindowStart);
    const scoreOf = (window) => {
      const { events, phoneUse } = detectDrivingEvents(window);
      const stats = calculateTripStats(window, window[0].timestamp, window[window.length - 1].timestamp);
      return calculateTripScores(
        events,
        stats,
        window,
        DEFAULT_THRESHOLDS,
        stats.duration_seconds,
        phoneUse
      ).component_scores.overall.value;
    };
    const legacyFirst = scoreOf(firstPoints);
    const legacyLast = scoreOf(lastPoints);
    const legacyAlert = legacyLast != null && legacyFirst != null && legacyLast < legacyFirst - 15;

    // Guard against a vacuous comparison: the fixture must actually trip the alert.
    expect(legacyAlert).toBe(true);
    expect(result.windowComparison.available).toBe(true);
    expect(result.windowComparison.firstScore).toBe(legacyFirst);
    expect(result.windowComparison.lastScore).toBe(legacyLast);
    expect(result.windowComparison.declined).toBe(legacyAlert);
    expect(result.durationSeconds).toBeGreaterThan(LIVE_SCORE_FATIGUE_MIN_SECONDS);
    expect(result.fatigueAlert).toBe(legacyAlert);
  });

  it('never raises the fatigue alert on a short drive even when the tail scores lower', () => {
    const head = buildRoute({ count: 200, startMs: START_MS, intervalMs: 2000 });
    const tailStart = START_MS + 20 * 60 * 1000;
    const tailHarsh = Array.from({ length: 30 }, (_, index) => 5 + index * 6);
    const tail = buildRoute({ count: 200, startMs: tailStart, intervalMs: 2000, harshAt: tailHarsh });
    const nowMs = tailStart + 200 * 2000;

    const result = computeLiveTripScore(tripWith([...head, ...tail]), {}, { nowMs });

    expect(result.durationSeconds).toBeLessThan(LIVE_SCORE_FATIGUE_MIN_SECONDS);
    expect(result.fatigueAlert).toBe(false);
  });

  it('degrades safely on a trip with no usable timestamps', () => {
    const points = Array.from({ length: 40 }, () => ({ lat: 51.5, lng: -0.12, timestamp: null }));
    const result = computeLiveTripScore(tripWith(points, { start_time: null }), {}, { nowMs: START_MS });

    expect(result.status).toBe('insufficient_data');
    expect(result.windowComparison.available).toBe(false);
    expect(result.fatigueAlert).toBe(false);
  });
});
