import { describe, expect, it } from 'vitest';
import {
  createCoachProgram,
  emptyCoachProgramStore,
} from '@/lib/coachPrograms';
import { buildAdvancedPostDriveAnalysis } from '@/lib/postDriveAdvancedAnalysis';

const trip = ({
  id,
  start,
  speeding = 0,
  score = 82,
  route = 'route-a',
  distance = 10,
  events = [],
  points = [],
} = {}) => ({
  id,
  status: 'completed',
  start_time: start,
  end_time: new Date(new Date(start).getTime() + 600000).toISOString(),
  duration_seconds: 600,
  distance_km: distance,
  route_key: route,
  dominant_road_type: 'urban',
  score_overall: score,
  speeding_events_count: speeding,
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  driving_events: events,
  route_points: points,
});

const baselineTrips = [
  trip({ id: 'affected-1', start: '2026-07-25T08:00:00.000Z', speeding: 1, score: 78 }),
  trip({ id: 'affected-2', start: '2026-07-26T08:00:00.000Z', speeding: 1, score: 80 }),
  trip({ id: 'clean-1', start: '2026-07-27T08:00:00.000Z', speeding: 0, score: 90 }),
  trip({ id: 'clean-2', start: '2026-07-28T08:00:00.000Z', speeding: 0, score: 88 }),
];

describe('advanced post-drive analysis', () => {
  it('identifies recurrence, an exact moment, a likely speed-limit transition, and personal upside', () => {
    const points = [
      { timestamp: '2026-07-30T08:00:00.000Z', speed_kmh: 55, speed_limit_kmh: 60, road_type: 'urban' },
      { timestamp: '2026-07-30T08:00:20.000Z', speed_kmh: 53, speed_limit_kmh: 60, road_type: 'urban' },
      { timestamp: '2026-07-30T08:00:40.000Z', speed_kmh: 55, speed_limit_kmh: 40, road_type: 'residential' },
      { timestamp: '2026-07-30T08:01:00.000Z', speed_kmh: 38, speed_limit_kmh: 40, road_type: 'residential' },
    ];
    const current = trip({
      id: 'current',
      start: '2026-07-30T08:00:00.000Z',
      speeding: 1,
      score: 81,
      points,
      events: [{
        type: 'speeding',
        severity: 'medium',
        timestamp: points[2].timestamp,
        point_index: 2,
        speed_kmh: 55,
        speed_limit_kmh: 40,
      }],
    });

    const analysis = buildAdvancedPostDriveAnalysis(
      current,
      baselineTrips,
      'speeding',
      emptyCoachProgramStore()
    );

    expect(analysis.pattern).toMatchObject({
      classification: 'recurring',
      affectedTrips: 2,
      comparableTripCount: 4,
      currentRatePer10Km: 1,
      historicalRatePer10Km: 0.5,
    });
    expect(analysis.moment.headline).toContain('55 in a 40 km/h zone');
    expect(analysis.moment.headline).toContain('40s into the drive');
    expect(analysis.cause).toMatchObject({
      headline: 'Likely speed-limit transition',
      confidence: 'strong',
    });
    expect(analysis.cause.detail).toContain('60 to 40 km/h');
    expect(analysis.target.target).toBe(0.4);
    expect(analysis.upside.available).toBe(true);
    expect(analysis.upside.estimate).toBe(10);
  });

  it('does not invent an event location or cause when event-level evidence is absent', () => {
    const current = trip({
      id: 'summary-only',
      start: '2026-07-30T08:00:00.000Z',
      speeding: 1,
      events: [],
      points: [],
    });

    const analysis = buildAdvancedPostDriveAnalysis(current, baselineTrips, 'speeding');

    expect(analysis.moment.available).toBe(false);
    expect(analysis.moment.headline).toBe('No precise event moment retained');
    expect(analysis.cause).toMatchObject({
      headline: 'Cause not established',
      confidence: 'limited',
    });
    expect(analysis.limitation).toContain('not proof');
  });

  it('shows progress from a post-drive experiment on a newer trip', () => {
    const source = trip({
      id: 'source',
      start: '2026-07-28T08:00:00.000Z',
      speeding: 2,
      score: 78,
    });
    const program = {
      ...createCoachProgram({
        focusId: 'speeding',
        targetTripCount: 3,
        contextMode: 'comparable',
        routeKey: 'route-a',
        trips: [...baselineTrips, source],
        now: new Date('2026-07-28T09:00:00.000Z'),
      }),
      source: 'post_drive_review',
      sourceTripId: source.id,
    };
    const current = trip({
      id: 'newer',
      start: '2026-07-30T08:00:00.000Z',
      speeding: 0,
      score: 90,
    });

    const analysis = buildAdvancedPostDriveAnalysis(current, [...baselineTrips, source], 'speeding', {
      ...emptyCoachProgramStore(),
      active: program,
    });

    expect(analysis.outcome.status).toBe('active');
    expect(analysis.outcome.headline).toContain('1 of 3 drives measured');
    expect(analysis.outcome.progress.latestReview.tripId).toBe('newer');
  });

  it('returns the final before-and-after verdict directly in the latest review', () => {
    const source = trip({
      id: 'source-final',
      start: '2026-07-25T08:00:00.000Z',
      speeding: 2,
      score: 76,
    });
    const program = {
      ...createCoachProgram({
        focusId: 'speeding',
        targetTripCount: 3,
        contextMode: 'comparable',
        routeKey: 'route-a',
        trips: [...baselineTrips, source],
        now: new Date('2026-07-25T09:00:00.000Z'),
      }),
      source: 'post_drive_review',
      sourceTripId: source.id,
    };
    const improved = [
      trip({ id: 'result-1', start: '2026-07-26T10:00:00.000Z', speeding: 0, score: 90 }),
      trip({ id: 'result-2', start: '2026-07-27T10:00:00.000Z', speeding: 0, score: 91 }),
      trip({ id: 'result-3', start: '2026-07-28T10:00:00.000Z', speeding: 0, score: 92 }),
    ];

    const analysis = buildAdvancedPostDriveAnalysis(
      improved[2],
      [...baselineTrips, source, improved[0], improved[1]],
      'speeding',
      { ...emptyCoachProgramStore(), active: program }
    );

    expect(analysis.outcome.status).toBe('validated');
    expect(analysis.outcome.headline).toContain('target met');
    expect(analysis.outcome.detail).toContain('three-drive comparison is complete');
  });
});
