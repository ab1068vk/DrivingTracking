import { describe, expect, it } from 'vitest';
import {
  buildPlaybackTimeline,
  buildRouteComparison,
  downsampleRoutePoints,
  playbackPositionAtElapsed,
  prepareMapRoutePoints,
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

  it('summarizes comparison deltas for repeated routes', () => {
    const comparison = buildRouteComparison(
      { score_overall: 90, driving_events: [], avg_speed_kmh: 45, harsh_brakes_count: 0 },
      { score_overall: 80, driving_events: [{ type: 'speeding' }], avg_speed_kmh: 55, harsh_brakes_count: 1 }
    );

    expect(comparison.rows).toHaveLength(4);
    expect(comparison.notes.some((note) => note.includes('fewer'))).toBe(true);
    expect(comparison.notes.some((note) => note.includes('slower'))).toBe(true);
  });
});
