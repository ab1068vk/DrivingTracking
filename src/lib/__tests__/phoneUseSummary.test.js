import { describe, expect, it } from 'vitest';
import {
  buildCompactPhoneUseSummary,
  buildPhoneUseEventContext,
  summarizePhoneUseAcrossTrips,
  summarizeTripPhoneUse,
} from '@/lib/phoneUseSummary';
import { buildTripSummary } from '@/lib/tripSummary';

const phoneUseEvent = ({
  startTime = '2026-06-18T12:05:00.000Z',
  endTime = '2026-06-18T12:05:25.000Z',
  durationS = 25,
  speedKmh = 52,
  severity = 'medium',
} = {}) => ({
  type: 'phone_use',
  source: 'android_usage_access',
  startTime,
  endTime,
  timestamp: startTime,
  durationS,
  duration_seconds: durationS,
  speed_kmh: speedKmh,
  confidence: 0.92,
  confidence_level: 'high',
  severity,
});

describe('phone use summary', () => {
  it('normalizes confirmed trip phone-use evidence into one reusable shape', () => {
    const summary = summarizeTripPhoneUse({
      id: 'trip-phone-1',
      start_time: '2026-06-18T12:00:00.000Z',
      end_time: '2026-06-18T12:10:00.000Z',
      duration_seconds: 600,
      phone_use_events: [phoneUseEvent()],
    });

    expect(summary).toMatchObject({
      tripId: 'trip-phone-1',
      scoreAvailable: true,
      scoreStatus: 'android_usage_access',
      risk: 'medium',
      windowCount: 1,
      totalSeconds: 25,
      hasConfirmedUse: true,
      avgSpeedKmh: 52,
    });
    expect(summary.score).toBeLessThan(100);
    expect(summary.events).toHaveLength(1);
  });

  it('aggregates measured, unmeasured, latest, and longest phone-use trips', () => {
    const trips = [
      {
        id: 'old-short',
        start_time: '2026-06-17T12:00:00.000Z',
        duration_seconds: 600,
        phone_use_events: [phoneUseEvent({ durationS: 10, speedKmh: 35, severity: 'low' })],
      },
      {
        id: 'new-long',
        start_time: '2026-06-18T12:00:00.000Z',
        duration_seconds: 900,
        phone_use_events: [phoneUseEvent({ durationS: 95, speedKmh: 102, severity: 'high' })],
      },
      {
        id: 'unmeasured',
        start_time: '2026-06-19T12:00:00.000Z',
        duration_seconds: 300,
        phone_use_score_status: 'usage_access_required',
      },
    ];

    const aggregate = summarizePhoneUseAcrossTrips(trips);

    expect(aggregate).toMatchObject({
      totalTrips: 3,
      measuredTrips: 2,
      unmeasuredTrips: 1,
      tripsWithConfirmedUse: 2,
      totalWindows: 2,
      totalSeconds: 105,
      worstRisk: 'high',
    });
    expect(aggregate.latestPhoneUseTrip.tripId).toBe('new-long');
    expect(aggregate.longestPhoneUseTrip.tripId).toBe('new-long');
    expect(aggregate.riskCounts.high).toBe(1);
  });

  it('retains confirmed counts and worst-moment data in a coordinate-free compact summary', () => {
    const fullTrip = {
      id: 'compact-source',
      start_time: '2026-06-18T12:00:00.000Z',
      duration_seconds: 600,
      phone_use_events: [phoneUseEvent({
        durationS: 35,
        speedKmh: 78,
        severity: 'medium',
      })],
    };

    const compact = buildCompactPhoneUseSummary(fullTrip);
    const summaryOnlyTrip = {
      id: fullTrip.id,
      start_time: fullTrip.start_time,
      duration_seconds: fullTrip.duration_seconds,
      phone_use_window_count: compact.windowCount,
      phone_use_total_seconds: compact.totalSeconds,
      phone_use_score: compact.score,
      phone_use_score_available: true,
      phone_use_score_status: 'android_usage_access',
      phone_use_summary: compact,
    };
    const restored = summarizeTripPhoneUse(summaryOnlyTrip);

    expect(compact.worstEvent).toMatchObject({
      durationSeconds: 35,
      speedKmh: 78,
      severity: 'medium',
    });
    expect(compact.worstEvent.lat).toBeUndefined();
    expect(restored).toMatchObject({
      hasConfirmedUse: true,
      windowCount: 1,
      totalSeconds: 35,
      dataQuality: 'summary_only',
    });
  });

  it('stores compact phone analytics in trip lists without retaining event coordinates', () => {
    const event = phoneUseEvent({ durationS: 18, speedKmh: 64 });
    event.lat = 43.6532;
    event.lng = -79.3832;
    const summary = buildTripSummary({
      id: 'trip-list-summary',
      start_time: '2026-06-18T12:00:00.000Z',
      duration_seconds: 600,
      phone_use_events: [event],
      route_points: [{
        timestamp: event.timestamp,
        lat: event.lat,
        lng: event.lng,
        speed_kmh: event.speed_kmh,
      }],
    });

    expect(summary.phone_use_events).toBeUndefined();
    expect(summary.route_points).toBeUndefined();
    expect(summary.phone_use_summary).toMatchObject({
      windowCount: 1,
      totalSeconds: 18,
    });
    expect(summary.phone_use_summary.worstEvent.lat).toBeUndefined();
    expect(summary.phone_use_summary.worstEvent.lng).toBeUndefined();
  });

  it('keeps route point counts in summaries without retaining route geometry', () => {
    const routePoints = Array.from({ length: 20 }, (_, index) => ({
      timestamp: new Date(Date.parse('2026-06-18T12:00:00.000Z') + index * 1000).toISOString(),
      lat: 43.65 + index * 0.0001,
      lng: -79.38 - index * 0.0001,
      speed_kmh: index === 0 ? 0 : 42,
    }));
    const summary = buildTripSummary({
      id: 'trip-list-route-counts',
      status: 'completed',
      route_points: routePoints,
      route_points_raw_count: 24,
    });
    const expired = buildTripSummary({
      id: 'expired-route',
      status: 'completed',
      route_points: [],
      route_points_raw_count: 24,
      route_points_map_count: 0,
      route_replay_available: true,
      route_data_expired_at: '2026-06-18T13:00:00.000Z',
    });

    expect(summary.route_points).toBeUndefined();
    expect(summary.route_points_map_count).toBe(20);
    expect(summary.route_replay_available).toBe(true);
    expect(expired.route_points_map_count).toBe(0);
    expect(expired.route_replay_available).toBe(false);
  });

  it('adds only supported road, intersection, weather, and nearby-event context', () => {
    const event = phoneUseEvent({
      startTime: '2026-06-18T12:05:00.000Z',
      endTime: '2026-06-18T12:05:25.000Z',
      durationS: 25,
      speedKmh: 62,
    });
    event.package_name = 'com.example.messaging';
    const contextual = buildPhoneUseEventContext({
      start_time: '2026-06-18T12:00:00.000Z',
      route_points: [{
        timestamp: '2026-06-18T12:05:01.000Z',
        speed_kmh: 62,
        road_type: 'urban',
        near_intersection: true,
      }],
      driving_events: [{
        type: 'harsh_brake',
        timestamp: '2026-06-18T12:05:10.000Z',
        severity: 'medium',
      }],
      weather_context: { condition: 'rain' },
    }, event);

    expect(contextual).toMatchObject({
      activityKey: 'messaging',
      activityLabel: 'Messaging',
      offsetSeconds: 300,
      nearIntersection: true,
      roadType: 'urban',
      weatherCondition: 'rain',
    });
    expect(contextual.contextLabels).toEqual(expect.arrayContaining([
      'Near a recorded intersection or traffic stop',
      'Urban road',
      'Rain conditions',
      'Near Harsh Brake',
    ]));
  });

  it('classifies privacy-preserving unlock context without an app package name', () => {
    const event = phoneUseEvent({ durationS: 12, speedKmh: 45 });
    event.started_after_screen_on = true;
    event.started_after_unlock = true;
    event.interaction_context = 'after_unlock';
    const contextual = buildPhoneUseEventContext({
      start_time: '2026-06-18T12:00:00.000Z',
      route_points: [{
        timestamp: event.timestamp,
        speed_kmh: 45,
      }],
    }, event);

    expect(contextual).toMatchObject({
      activityKey: 'foreground_after_unlock',
      activityLabel: 'Foreground activity after unlock',
    });
    expect(contextual.contextLabels).toContain('Started within 10 seconds of an unlock');
    expect(contextual).not.toHaveProperty('package_name');
  });

  it('excludes passenger trips and computes a deterministic seven-day trend', () => {
    const trips = [
      {
        id: 'current-driver',
        start_time: '2026-06-18T12:00:00.000Z',
        duration_seconds: 600,
        phone_use_events: [phoneUseEvent({ durationS: 10, speedKmh: 40, severity: 'low' })],
      },
      {
        id: 'previous-driver',
        start_time: '2026-06-10T12:00:00.000Z',
        duration_seconds: 600,
        phone_use_events: [phoneUseEvent({ durationS: 20, speedKmh: 40, severity: 'medium' })],
      },
      {
        id: 'passenger',
        start_time: '2026-06-18T13:00:00.000Z',
        duration_seconds: 600,
        passenger_trip: true,
        excluded_from_driver_score: true,
        phone_use_events: [phoneUseEvent({ durationS: 95, speedKmh: 110, severity: 'high' })],
      },
    ];

    const aggregate = summarizePhoneUseAcrossTrips(trips, {
      now: '2026-06-19T12:00:00.000Z',
    });

    expect(aggregate).toMatchObject({
      totalTrips: 3,
      driverTrips: 2,
      excludedPassengerTrips: 1,
      totalSeconds: 30,
      trendDirection: 'improving',
      trendPct: -50,
    });
    expect(aggregate.worstRisk).toBe('medium');
    expect(aggregate.worstMoment.tripId).toBe('previous-driver');
  });

  it('includes coordinate-free phone evidence from privacy-masked trips', () => {
    const aggregate = summarizePhoneUseAcrossTrips([{
      id: 'privacy-masked-phone-trip',
      start_time: '2026-06-18T12:00:00.000Z',
      duration_seconds: 600,
      privacy_zone_touched: true,
      phone_use_events: [phoneUseEvent({ durationS: 20 })],
    }]);

    expect(aggregate).toMatchObject({
      totalTrips: 1,
      measuredTrips: 1,
      tripsWithConfirmedUse: 1,
      totalSeconds: 20,
    });
  });
});
