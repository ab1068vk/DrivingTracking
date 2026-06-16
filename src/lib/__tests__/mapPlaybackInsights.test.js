import { describe, expect, it } from 'vitest';
import {
  buildPlaybackTimeline,
  buildRouteComparison,
  downsampleRoutePoints,
  hasRecoverableOriginalRouteGeometry,
  injectTimestampGapMarkers,
  playbackPositionAtElapsed,
  prepareMapRoutePoints,
  restoreOriginalRouteGeometry,
  routeDistanceAtPlaybackPosition,
} from '@/lib/mapPlaybackInsights';

const point = (index, speed = 40, extra = {}) => ({
  lat: 43.65 + index * 0.001,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 10)).toISOString(),
  ...extra,
});

describe('mapPlaybackInsights', () => {
  it('builds a playback timeline with segments, events, stops, and violations', () => {
    const points = [
      point(0, 20, { speed_limit_kmh: 50 }),
      point(1, 60, { speed_limit_kmh: 50 }),
      point(2, 0, { speed_limit_kmh: 50 }),
      point(9, 0, { speed_limit_kmh: 50 }),
    ];
    const timeline = buildPlaybackTimeline(points, [{
      type: 'speeding',
      lat: points[1].lat,
      lng: points[1].lng,
      timestamp: points[1].timestamp,
      speed_kmh: 60,
    }]);

    expect(timeline.segments).toHaveLength(3);
    expect(timeline.events[0].playbackIndex).toBe(1);
    expect(timeline.violations.length).toBeGreaterThan(0);
    expect(timeline.stops[0].durationSeconds).toBeGreaterThanOrEqual(60);
    expect(timeline.story.length).toBeGreaterThan(0);
  });

  it('interpolates playback position by elapsed time', () => {
    const points = [point(0, 0), point(1, 60)];
    const position = playbackPositionAtElapsed(points, 5);

    expect(position.index).toBe(1);
    expect(position.point.lat).toBeCloseTo(43.6505, 4);
    expect(position.point.speed_kmh).toBeCloseTo(30, 0);
  });

  it('uses elapsed time rather than point index for timeline progress', () => {
    const points = [
      point(0, 30, { timestamp: '2026-01-01T12:00:00.000Z' }),
      point(1, 0, { timestamp: '2026-01-01T12:00:10.000Z' }),
      point(2, 30, { timestamp: '2026-01-01T12:01:40.000Z' }),
    ];
    const timeline = buildPlaybackTimeline(points);
    expect(timeline.segments[0].progressEnd).toBeCloseTo(10, 3);
    expect(timeline.segments[0].progressEnd).not.toBe(50);
  });

  it('keeps traveled distance tied to route progress during stopped playback time', () => {
    const points = [
      point(0, 30, { timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString() }),
      point(1, 0, { timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 10)).toISOString() }),
      point(1, 0, { timestamp: new Date(Date.UTC(2026, 0, 1, 12, 1, 10)).toISOString() }),
      point(2, 30, { timestamp: new Date(Date.UTC(2026, 0, 1, 12, 1, 20)).toISOString() }),
    ];
    const timeline = buildPlaybackTimeline(points, []);
    const beforeStopDistanceKm = timeline.cumulativeDistancesKm[1];
    const positionDuringStop = playbackPositionAtElapsed(points, 40);

    expect(routeDistanceAtPlaybackPosition(timeline, positionDuringStop, positionDuringStop.index))
      .toBeCloseTo(beforeStopDistanceKm, 6);
  });

  it('downsamples dense routes but preserves the first and last point', () => {
    const points = Array.from({ length: 100 }, (_, index) => point(index));
    const sampled = downsampleRoutePoints(points, 10);

    expect(sampled).toHaveLength(10);
    expect(sampled[0].lat).toBe(points[0].lat);
    expect(sampled.at(-1).lat).toBe(points.at(-1).lat);
  });

  it('prepares map points by dropping poor GPS fixes while keeping untimed routes drawable', () => {
    const noisyPoints = [
      point(0, 20, { accuracy: 8 }),
      point(1, 20, { accuracy: 180 }),
      point(2, 20, { accuracy: 8 }),
    ];
    const prepared = prepareMapRoutePoints(noisyPoints, { maxPoints: null, smooth: false });

    expect(prepared).toHaveLength(2);
    expect(prepared[1].lat).toBe(noisyPoints[2].lat);

    const untimed = prepareMapRoutePoints([
      { lat: 43.65, lng: -79.38 },
      { lat: 43.66, lng: -79.39 },
    ], { maxPoints: null });

    expect(untimed).toHaveLength(2);
  });

  it('marks long GPS gaps and excludes the straight-line jump from playback distance', () => {
    const route = [
      point(0, 40, { lat: 43.65, timestamp: '2026-01-01T12:00:00.000Z' }),
      point(1, 40, { lat: 43.651, timestamp: '2026-01-01T12:00:10.000Z' }),
      point(2, 0, { lat: 45.9, timestamp: '2026-01-01T15:00:00.000Z' }),
      point(3, 40, { lat: 45.901, timestamp: '2026-01-01T15:00:10.000Z' }),
    ];

    const prepared = prepareMapRoutePoints(route, { maxPoints: null, smooth: false });
    const timeline = buildPlaybackTimeline(prepared, []);

    expect(prepared[2].tracking_gap).toBe(true);
    expect(timeline.stats.distanceKm).toBeLessThan(0.3);
    expect(timeline.segments.every((segment) => segment.durationSeconds <= 120)).toBe(true);
  });

  it('drops impossible visual jumps even when GPS reports high speed', () => {
    const route = [
      point(0, 40, { lat: 43.65, timestamp: '2026-01-01T12:00:00.000Z' }),
      point(1, 180, { lat: 44.1, timestamp: '2026-01-01T12:01:00.000Z' }),
      point(2, 40, { lat: 43.651, timestamp: '2026-01-01T12:02:00.000Z' }),
    ];

    const prepared = prepareMapRoutePoints(route, { maxPoints: null, smooth: false });

    expect(prepared).toHaveLength(2);
    expect(prepared.some((item) => item.speed_kmh === 180)).toBe(false);
  });

  it('re-injects timestamp gap markers after visual downsampling removes the marked point', () => {
    const route = [
      point(0, 40, { timestamp: '2026-01-01T12:00:00.000Z' }),
      point(1, 40, { timestamp: '2026-01-01T12:00:10.000Z' }),
      point(2, 40, { timestamp: '2026-01-01T12:05:00.000Z', tracking_gap: true }),
      point(3, 40, { timestamp: '2026-01-01T12:05:10.000Z' }),
      point(4, 40, { timestamp: '2026-01-01T12:05:20.000Z' }),
    ];

    const prepared = prepareMapRoutePoints(route, { maxPoints: 3, smooth: false });

    expect(prepared).toHaveLength(3);
    expect(prepared[1].timestamp).toBe('2026-01-01T12:05:10.000Z');
    expect(prepared[1].tracking_gap).toBe(true);
  });

  it('can inject timestamp gap markers directly without changing existing gap points', () => {
    const marked = point(2, 40, { timestamp: '2026-01-01T12:05:00.000Z', route_gap: true });
    const injected = injectTimestampGapMarkers([
      point(0, 40, { timestamp: '2026-01-01T12:00:00.000Z' }),
      point(1, 40, { timestamp: '2026-01-01T12:03:00.000Z' }),
      marked,
    ]);

    expect(injected[1].tracking_gap).toBe(true);
    expect(injected[2]).toBe(marked);
  });

  it('drops privacy-masked null coordinates instead of treating them as zero-zero', () => {
    const maskedRoute = [
      { lat: null, lng: null, speed_kmh: 20, timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString() },
      point(1, 30),
      point(2, 35),
      { lat: null, lng: null, speed_kmh: 10, timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 30)).toISOString() },
    ];

    const prepared = prepareMapRoutePoints(maskedRoute, { maxPoints: null, smooth: false });
    expect(prepared).toHaveLength(2);
    expect(prepared.some((item) => item.lat === 0 || item.lng === 0)).toBe(false);

    const timeline = buildPlaybackTimeline(maskedRoute, []);
    expect(timeline.stats.distanceKm).toBeGreaterThan(0.1);
    expect(timeline.stats.distanceKm).toBeLessThan(0.2);
  });

  it('drops out-of-range coordinates before map and playback math', () => {
    const route = [
      point(0, 20),
      { lat: 512, lng: -79.38, speed_kmh: 20, timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 10)).toISOString() },
      { lat: 43.652, lng: -724, speed_kmh: 20, timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 20)).toISOString() },
      point(3, 20),
    ];

    const prepared = prepareMapRoutePoints(route, { maxPoints: null, smooth: false });
    const timeline = buildPlaybackTimeline(route, []);

    expect(prepared).toHaveLength(2);
    expect(prepared.every((item) => item.lat >= -90 && item.lat <= 90 && item.lng >= -180 && item.lng <= 180)).toBe(true);
    expect(timeline.stats.distanceKm).toBeGreaterThan(0);
    expect(timeline.stats.distanceKm).toBeLessThan(0.5);
  });

  it('recovers routes collapsed by old map-matching updates', () => {
    const damaged = [0, 1, 2].map((index) => ({
      lat: 43.7,
      lng: -79.4,
      original_lat: 43.65 + index * 0.001,
      original_lng: -79.38,
      map_matched: true,
      timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 10)).toISOString(),
      speed_kmh: 40,
    }));

    expect(hasRecoverableOriginalRouteGeometry(damaged)).toBe(true);

    const restored = restoreOriginalRouteGeometry(damaged);
    expect(restored[0].lat).toBe(damaged[0].original_lat);
    expect(restored[2].lat).toBe(damaged[2].original_lat);
    expect(restored[0].matched_lat).toBe(43.7);

    const timeline = buildPlaybackTimeline(damaged, []);
    expect(timeline.stats.distanceKm).toBeGreaterThan(0.2);
  });

  it('summarizes comparison deltas for repeated routes', () => {
    const comparison = buildRouteComparison(
      { score_overall: 90, driving_events: [], avg_speed_kmh: 45, harsh_brakes_count: 0 },
      { score_overall: 80, driving_events: [{ type: 'speeding' }], avg_speed_kmh: 55, harsh_brakes_count: 1 }
    );

    expect(comparison.rows).toHaveLength(4);
    expect(comparison.notes.some((note) => note.includes('fewer'))).toBe(true);
    expect(comparison.notes.some((note) => note.includes('slower'))).toBe(true);
  });

  it('keeps missing comparison scores unavailable instead of converting them to zero', () => {
    const comparison = buildRouteComparison(
      { score_overall: null, driving_events: [], avg_speed_kmh: 45 },
      { score_overall: null, driving_events: [], avg_speed_kmh: 45 }
    );
    const scoreRow = comparison.rows.find((row) => row.label === 'Score');

    expect(scoreRow.current).toBe('Unavailable');
    expect(scoreRow.other).toBe('Unavailable');
    expect(scoreRow.higherWins).toBeNull();
  });
});
