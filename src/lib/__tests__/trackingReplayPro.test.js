import { describe, expect, it } from 'vitest';
import {
  buildCompareReplayData,
  buildReplayTripOptions,
  compareRouteSimilarity,
  isReplayTripAvailable,
  replayUnavailableReason,
} from '@/lib/trackingReplayPro';

const makeRoute = (startMs = Date.parse('2026-07-09T12:00:00.000Z'), offset = 0) => (
  Array.from({ length: 5 }, (_, index) => ({
    lat: 43.65 + offset + index * 0.0001,
    lng: -79.38 + index * 0.0001,
    timestamp: new Date(startMs + index * 60_000).toISOString(),
    speed_kmh: 35 + index * 5,
    speed_limit_kmh: index < 3 ? 40 : 50,
    speed_limit_source: index < 3 ? 'openstreetmap' : 'region_default_estimate',
    ...(index === 3 ? { route_gap: true } : {}),
  }))
);

const primaryTrip = {
  id: 'trip-a',
  status: 'completed',
  start_time: '2026-07-09T12:00:00.000Z',
  distance_km: 4.2,
  avg_speed_kmh: 40,
  route_replay_available: true,
  route_points: makeRoute(),
  driving_events: [{
    type: 'harsh_brake',
    timestamp: '2026-07-09T12:02:00.000Z',
    lat: 43.6502,
    lng: -79.3798,
    value: -4.1,
  }],
};

const secondaryTrip = {
  ...primaryTrip,
  id: 'trip-b',
  start_time: '2026-07-08T12:00:00.000Z',
  distance_km: 4.4,
  avg_speed_kmh: 46,
  route_points: makeRoute(Date.parse('2026-07-08T12:00:00.000Z'), 0.00005),
  driving_events: [{
    type: 'speeding',
    timestamp: '2026-07-08T12:03:00.000Z',
    lat: 43.65035,
    lng: -79.37965,
    speed_kmh: 58,
    speed_limit_kmh: 50,
  }],
};

describe('tracking replay pro helpers', () => {
  it('blocks summary-only private trips and expired route data', () => {
    expect(isReplayTripAvailable(primaryTrip)).toBe(true);
    expect(isReplayTripAvailable({ ...primaryTrip, privacy_mode: 'summary_only' })).toBe(false);
    expect(replayUnavailableReason({ ...primaryTrip, privacy_mode: 'summary_only' })).toContain('summary data only');
    expect(isReplayTripAvailable({ ...primaryTrip, route_data_expired_at: '2026-07-09T13:00:00.000Z' })).toBe(false);
    expect(replayUnavailableReason({ ...primaryTrip, route_data_expired_at: '2026-07-09T13:00:00.000Z' })).toContain('expired');
  });

  it('sorts replay options and marks blocked trips', () => {
    const options = buildReplayTripOptions([
      { ...primaryTrip, id: 'blocked', privacy_mode: 'summary_only', start_time: '2026-07-10T12:00:00.000Z' },
      primaryTrip,
    ]);

    expect(options[0]).toMatchObject({
      id: 'blocked',
      available: false,
    });
    expect(options[1]).toMatchObject({
      id: 'trip-a',
      available: true,
      routePointCount: 5,
    });
  });

  it('labels same or similar routes from endpoint and distance evidence', () => {
    expect(compareRouteSimilarity(primaryTrip, secondaryTrip)).toMatchObject({
      status: 'similar',
      label: 'Same or similar route',
    });
    expect(compareRouteSimilarity(primaryTrip, {
      ...secondaryTrip,
      route_points: makeRoute(Date.parse('2026-07-08T12:00:00.000Z'), 0.05),
    })).toMatchObject({
      status: 'different',
      label: 'Route geometry differs',
    });
  });

  it('builds overlays, gaps, speed-source changes, and event chapters', () => {
    const data = buildCompareReplayData({
      primaryTrip: {
        ...primaryTrip,
        route_points: [
          ...primaryTrip.route_points,
          { lat: null, lng: null, timestamp: '2026-07-09T12:05:00.000Z', masked_for_privacy: true, privacy_gap: true },
        ],
      },
      secondaryTrip,
      playbackMode: 'event_to_event',
      settings: {},
    });

    expect(data.primaryAvailable).toBe(true);
    expect(data.secondaryAvailable).toBe(true);
    expect(data.speedOverlayRows).toHaveLength(2);
    expect(data.eventOverlayRows.some((row) => row.label === 'Harsh Brake')).toBe(true);
    expect(data.routeGapRows.length).toBeGreaterThan(0);
    expect(data.speedLimitSourceRows.some((row) => row.source === 'region_default_estimate')).toBe(true);
    expect(data.privacyGapRows.length).toBeGreaterThan(0);
    expect(data.chapterRows.some((row) => row.detail === '3D replay event chapter')).toBe(true);
    expect(data.playbackRows.every((row) => row.detail === 'event-to-event playback segment')).toBe(true);
  });

  it('builds normalized playback rows from route progress', () => {
    const data = buildCompareReplayData({
      primaryTrip,
      secondaryTrip,
      playbackMode: 'normalized',
      settings: {},
    });

    expect(data.playbackRows.length).toBeGreaterThan(0);
    expect(data.playbackRows[0].detail).toBe('normalized route progress');
  });
});
