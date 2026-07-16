import { describe, expect, it } from 'vitest';
import {
  buildAdvancedInsights,
  buildInsightExperimentProgress,
} from '@/lib/advancedInsights';

const trip = (overrides = {}) => ({
  id: `trip_${Math.random().toString(36).slice(2)}`,
  status: 'completed',
  start_time: '2026-07-10T08:00:00.000Z',
  distance_km: 10,
  duration_seconds: 900,
  score_overall: 80,
  score_safety: 80,
  score_smoothness: 80,
  score_eco: 80,
  intersection_score: 80,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  driving_events: [],
  route_replay_available: true,
  route_points_map_count: 50,
  ...overrides,
});

describe('advanced insights', () => {
  it('explains comparable score and normalized event movement', () => {
    const currentEvents = [
      { type: 'harsh_brake', severity: 'high', lat: 43.65, lng: -79.38, timestamp: '2026-07-10T08:05:00.000Z' },
      { type: 'harsh_brake', severity: 'medium', lat: 43.65, lng: -79.38, timestamp: '2026-07-10T08:06:00.000Z' },
    ];
    const trips = [
      trip({
        id: 'current-1',
        score_overall: 70,
        score_safety: 60,
        score_smoothness: 76,
        harsh_brakes_count: 3,
        driving_events: currentEvents,
      }),
      trip({
        id: 'current-2',
        start_time: '2026-07-11T08:00:00.000Z',
        score_overall: 72,
        score_safety: 64,
        score_smoothness: 78,
        harsh_brakes_count: 1,
      }),
      trip({
        id: 'previous-1',
        start_time: '2026-05-20T08:00:00.000Z',
        score_overall: 90,
        score_safety: 92,
        score_smoothness: 88,
      }),
      trip({
        id: 'previous-2',
        start_time: '2026-05-21T08:00:00.000Z',
        score_overall: 90,
        score_safety: 92,
        score_smoothness: 88,
      }),
      trip({
        id: 'passenger',
        passenger_trip: true,
        score_overall: 20,
        harsh_brakes_count: 20,
      }),
    ];

    const insights = buildAdvancedInsights(trips, {}, {
      now: new Date('2026-07-13T12:00:00.000Z'),
      periodDays: 30,
    });

    expect(insights.currentScore).toBe(71);
    expect(insights.previousScore).toBe(90);
    expect(insights.scoreDelta).toBe(-19);
    expect(insights.primaryFinding).toMatchObject({
      tone: 'warn',
      headline: 'Your score is 19 points lower than the prior 30 days',
    });
    expect(insights.eventMovement.find((row) => row.id === 'harsh_brakes')).toMatchObject({
      currentCount: 4,
      currentRate: 20,
      previousRate: 0,
      direction: 'worse',
    });
    expect(insights.scoreMovement.find((row) => row.id === 'safety').estimatedImpact).toBeLessThan(0);
    expect(insights.hotspots).toHaveLength(1);
    expect(insights.experimentCandidate).toMatchObject({
      id: 'harsh_brakes',
      metricKey: 'harsh_brakes_count',
      targetTrips: 5,
    });
    expect(insights.dataQuality.passengerExcludedTrips).toBe(1);
  });

  it('includes privacy-masked trips in local trend evidence', () => {
    const trips = [
      trip({
        id: 'private-evidence-1',
        start_time: '2026-07-10T08:00:00.000Z',
        privacy_zone_touched: true,
        score_overall: 80,
        score_safety: 78,
        harsh_brakes_count: 1,
      }),
      trip({
        id: 'private-evidence-2',
        start_time: '2026-07-11T08:00:00.000Z',
        privacy_zone_touched: true,
        score_overall: 90,
        score_safety: 88,
      }),
    ];

    const insights = buildAdvancedInsights(trips, {}, {
      now: new Date('2026-07-13T12:00:00.000Z'),
      periodDays: 30,
    });

    expect(insights).toMatchObject({
      privacySafeSnapshot: false,
      comparisonAvailable: false,
      currentScore: 85,
      currentEventRate: 5,
    });
    expect(insights.currentTrips).toHaveLength(2);
    expect(insights.previousTrips).toHaveLength(0);
    expect(insights.scoreMovement.find((row) => row.id === 'safety')).toMatchObject({
      current: 83,
      previous: null,
    });
    expect(insights.dataQuality).toMatchObject({
      privacyExcludedTrips: 0,
      privacyProtectedTrips: 2,
      availableEligibleTrips: 2,
      trendEligibleTrips: 2,
      privacySafeSnapshot: false,
      scoredTrips: 2,
    });
  });
  it('measures a three-drive experiment against its frozen baseline', () => {
    const experiment = {
      id: 'harsh_brakes',
      metricKey: 'harsh_brakes_count',
      baseline: 20,
      target: 14,
      targetTrips: 3,
      startedAt: '2026-07-01T00:00:00.000Z',
    };
    const trips = [
      trip({ id: 'before', start_time: '2026-06-30T12:00:00.000Z', harsh_brakes_count: 9 }),
      trip({ id: 'drive-1', start_time: '2026-07-02T12:00:00.000Z', harsh_brakes_count: 1 }),
      trip({ id: 'drive-2', start_time: '2026-07-03T12:00:00.000Z', harsh_brakes_count: 0 }),
      trip({ id: 'drive-3', start_time: '2026-07-04T12:00:00.000Z', harsh_brakes_count: 0 }),
      trip({ id: 'passenger', start_time: '2026-07-05T12:00:00.000Z', passenger_trip: true, harsh_brakes_count: 20 }),
    ];

    const progress = buildInsightExperimentProgress(experiment, trips);

    expect(progress).toMatchObject({
      tripCount: 3,
      progressPct: 100,
      currentValue: 3.3,
      improvement: 16.7,
      targetMet: true,
      complete: true,
      status: 'validated',
      tripIds: ['drive-1', 'drive-2', 'drive-3'],
    });
  });

  it('keeps the selected period strict when it has no drives', () => {
    const insights = buildAdvancedInsights([
      trip({ id: 'older-1', start_time: '2026-01-10T08:00:00.000Z' }),
      trip({ id: 'older-2', start_time: '2026-01-11T08:00:00.000Z' }),
    ], {}, {
      now: new Date('2026-07-13T12:00:00.000Z'),
      periodDays: 7,
    });

    expect(insights.periodEmpty).toBe(true);
    expect(insights.periodFallback).toBe(false);
    expect(insights.currentTrips).toEqual([]);
    expect(insights.primaryFinding.headline).toBe('No eligible trips in the last 7 days');
  });

  it('changes the selected trips across the 7, 30, and 90 day filters', () => {
    const now = new Date('2026-07-13T12:00:00.000Z');
    const trips = [
      trip({ id: 'five-days', start_time: '2026-07-08T12:00:00.000Z' }),
      trip({ id: 'twenty-days', start_time: '2026-06-23T12:00:00.000Z' }),
      trip({ id: 'sixty-days', start_time: '2026-05-14T12:00:00.000Z' }),
    ];

    expect(buildAdvancedInsights(trips, {}, { now, periodDays: 7 }).currentTrips).toHaveLength(1);
    expect(buildAdvancedInsights(trips, {}, { now, periodDays: 30 }).currentTrips).toHaveLength(2);
    expect(buildAdvancedInsights(trips, {}, { now, periodDays: 90 }).currentTrips).toHaveLength(3);
  });
});
