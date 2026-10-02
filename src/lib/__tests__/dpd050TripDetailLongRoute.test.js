import { describe, expect, it, vi } from 'vitest';
import { previewTripSplitsAtStops, splitTripAtStops } from '../tripEngine';
import { buildPlaybackTimeline, eventIndexForRoute, prepareMapRoutePoints } from '../mapPlaybackInsights';
import { buildTripSpeedLimitReviewCells } from '../speedLimitReview';

const baseMs = Date.parse('2026-10-02T20:50:00Z');
const point = (index, options = {}) => ({
  lat: 43.58 + index * 0.00009,
  lng: -79.70 + index * 0.00004,
  timestamp: new Date(baseMs + index * 1000).toISOString(),
  speed_kmh: 70,
  accuracy: 5,
  heading: 35,
  ...options,
});

const stoppedRoute = (count) => {
  const stopAt = Math.floor(count / 2);
  const stopLength = 330;
  return Array.from({ length: count }, (_, index) => {
    const position = index >= stopAt ? index - Math.min(stopLength, index - stopAt) : index;
    return point(index, {
      lat: 43.58 + position * 0.00009,
      lng: -79.70 + position * 0.00004,
      speed_kmh: index >= stopAt && index < stopAt + stopLength ? 0 : 70,
    });
  });
};

describe('DPD-050 production-style long-route detail work', () => {
  it('does not create a proposed split for an uninterrupted trip', () => {
    expect(previewTripSplitsAtStops({ route_points: Array.from({ length: 500 }, (_, index) => point(index)) }, 5)).toEqual([]);
  });

  it('previews only the fields displayed by Split and preserves the explicit full Split result', () => {
    const route = stoppedRoute(1000);
    const trip = { id: 'native_trip_dpd050', status: 'completed', route_points: route };
    const before = JSON.stringify(trip);
    const preview = previewTripSplitsAtStops(trip, 5);
    const full = splitTripAtStops(trip, 5);
    expect(preview).toHaveLength(full.length);
    expect(preview.length).toBeGreaterThanOrEqual(2);
    expect(preview).toEqual(full.map(({ start_time, end_time, distance_km, duration_seconds }) => ({
      start_time, end_time, distance_km, duration_seconds,
    })));
    expect(preview.every(segment => !('route_points' in segment) && !('driving_events' in segment))).toBe(true);
    expect(previewTripSplitsAtStops(trip, 5)).toEqual(preview);
    expect(JSON.stringify(trip)).toBe(before);
  });

  it('keeps split-preview distance and duration equivalent on a ~5,000-point stopped route', () => {
    const trip = { id: 'native_trip_long', status: 'completed', route_points: stoppedRoute(5000) };
    const preview = previewTripSplitsAtStops(trip, 5);
    const full = splitTripAtStops(trip, 5);
    expect(preview).toEqual(full.map(({ start_time, end_time, distance_km, duration_seconds }) => ({
      start_time, end_time, distance_km, duration_seconds,
    })));
    expect(preview).toHaveLength(2);
  }, 30000);

  it('preserves distance and duration across a tracking gap, noisy point and private boundary', () => {
    const route = stoppedRoute(900);
    route[100] = { ...route[100], privacy_boundary: true, privacy_zone_id: 'home' };
    route[101] = { ...route[101], lat: null, lng: null, masked_for_privacy: true };
    route[102] = { ...route[102], privacy_boundary: true, privacy_zone_id: 'home' };
    route[110] = { ...route[110], lat: route[109].lat + 2, lng: route[109].lng + 2 };
    for (let index = 700; index < route.length; index++) {
      route[index] = { ...route[index], timestamp: new Date(Date.parse(route[index].timestamp) + 180000).toISOString() };
    }
    const trip = { id: 'native_trip_gap', route_points: route };
    const preview = previewTripSplitsAtStops(trip, 5);
    const full = splitTripAtStops(trip, 5);
    expect(preview).toEqual(full.map(({ start_time, end_time, distance_km, duration_seconds }) => ({
      start_time, end_time, distance_km, duration_seconds,
    })));
  });

  it('keeps repeated-stop ranges identical to the canonical split', () => {
    const route = Array.from({ length: 1400 }, (_, index) => {
      const stopped = (index >= 300 && index < 630) || (index >= 850 && index < 1180);
      const movingPosition = index < 300 ? index : index < 630 ? 300 : index < 850 ? index - 330 : index < 1180 ? 520 : index - 660;
      return point(index, {
        lat: 43.58 + movingPosition * 0.00009,
        lng: -79.70 + movingPosition * 0.00004,
        speed_kmh: stopped ? 0 : 70,
      });
    });
    const trip = { id: 'native_trip_two_stops', route_points: route };
    const full = splitTripAtStops(trip, 5);
    expect(previewTripSplitsAtStops(trip, 5)).toEqual(full.map(({ start_time, end_time, distance_km, duration_seconds }) => ({
      start_time, end_time, distance_km, duration_seconds,
    })));
    expect(full).toHaveLength(3);
  });

  it('matches every event to the same point as the original full scan, including ties', () => {
    const route = Array.from({ length: 1000 }, (_, index) => point(index));
    const visual = prepareMapRoutePoints(route, { maxPoints: 900 });
    const events = Array.from({ length: 208 }, (_, index) => ({
      type: 'speeding',
      timestamp: new Date(baseMs + index * 4000 + 500).toISOString(),
      lat: route[0].lat,
      lng: route[0].lng,
    }));
    const timeline = buildPlaybackTimeline(visual, events);
    expect(timeline.points).toHaveLength(900);
    expect(timeline.events.map(event => event.playbackIndex).sort((a, b) => a - b))
      .toEqual(events.map(event => eventIndexForRoute(event, timeline.points)).sort((a, b) => a - b));
    const tie = { timestamp: new Date((Date.parse(timeline.points[10].timestamp) + Date.parse(timeline.points[11].timestamp)) / 2).toISOString(), lat: 0, lng: 0 };
    expect(buildPlaybackTimeline(timeline.points, [tie]).events[0].playbackIndex)
      .toBe(eventIndexForRoute(tie, timeline.points));
  });

  it('preserves untimed/unsorted route fallback and DPD-044 review output', () => {
    const unsorted = [point(0), point(2), point(1)];
    const event = { timestamp: point(1).timestamp, lat: point(1).lat, lng: point(1).lng };
    expect(eventIndexForRoute(event, unsorted)).toBe(2);
    const route = stoppedRoute(1000);
    const trip = { route_points: route };
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T23:00:00Z'));
    try {
      const first = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
      const second = buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity });
      expect(second).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
