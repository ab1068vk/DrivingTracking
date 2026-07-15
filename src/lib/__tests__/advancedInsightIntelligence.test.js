import { describe, expect, it } from 'vitest';
import {
  answerDriveQuestion,
  buildAdvancedInsightIntelligence,
  buildComparableExperimentProgress,
  createComparableExperiment,
} from '@/lib/advancedInsightIntelligence';

const trip = ({
  id,
  startTime,
  score = 80,
  routeKey = 'route-a',
  distanceKm = 10,
  harshBrakes = 0,
  events = [],
  componentScore = score,
}) => ({
  id,
  status: 'completed',
  start_time: startTime,
  distance_km: distanceKm,
  score_overall: score,
  score_safety: componentScore,
  score_smoothness: componentScore,
  intersection_score: componentScore,
  route_key: routeKey,
  dominant_road_type: 'city',
  vehicle_id: 'vehicle-1',
  harsh_brakes_count: harshBrakes,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  component_scores: {
    safety: { value: componentScore },
    smoothness: { value: componentScore },
    intersection: { value: componentScore },
  },
  driving_events: events,
});

const analysisFor = (currentTrips, previousTrips = []) => ({
  currentTrips,
  previousTrips,
  hotspots: [],
  evidenceTrips: currentTrips,
  routes: [],
  eventMovement: [],
  phoneUseSummary: {},
  primaryFinding: {
    headline: 'Recent driving summary',
    explanation: 'Recorded evidence is still developing.',
  },
});

describe('advanced insight intelligence', () => {
  it('compares the strongest context-matched trip pair', () => {
    const current = trip({
      id: 'current',
      startTime: '2026-07-08T08:00:00.000Z',
      score: 88,
      harshBrakes: 1,
    });
    const matchingBaseline = trip({
      id: 'matching',
      startTime: '2026-06-10T08:00:00.000Z',
      score: 78,
      harshBrakes: 3,
    });
    const unrelatedBaseline = trip({
      id: 'unrelated',
      startTime: '2026-06-11T08:00:00.000Z',
      score: 95,
      routeKey: 'route-z',
    });

    const intelligence = buildAdvancedInsightIntelligence(
      analysisFor([current], [unrelatedBaseline, matchingBaseline]),
      {},
      {
        allTrips: [current, matchingBaseline, unrelatedBaseline],
        now: new Date('2026-07-13T08:00:00.000Z'),
      }
    );

    expect(intelligence.matched).toMatchObject({
      matchedTripCount: 1,
      currentScore: 88,
      baselineScore: 78,
      scoreDelta: 10,
    });
    expect(intelligence.matched.pairs[0]).toMatchObject({
      currentTripId: 'current',
      baselineTripId: 'matching',
    });
    expect(intelligence.matched.pairs[0].why).toContain('same route');
  });

  it('reconstructs the stored headline blend without invented deductions', () => {
    const current = trip({
      id: 'ledger',
      startTime: '2026-07-08T08:00:00.000Z',
      score: 82,
      componentScore: 82,
    });

    const intelligence = buildAdvancedInsightIntelligence(
      analysisFor([current]),
      {},
      { allTrips: [current], now: new Date('2026-07-13T08:00:00.000Z') }
    );

    expect(intelligence.attribution.reconstructedScore).toBe(82);
    expect(intelligence.attribution.recordedScore).toBe(82);
    expect(intelligence.attribution.exactBlend).toBe(true);
    expect(intelligence.attribution.rows.length).toBeGreaterThan(0);
  });

  it('detects a persistent score change after four-trip baselines', () => {
    const trips = [
      ...Array.from({ length: 4 }, (_, index) => trip({
        id: `before-${index}`,
        startTime: `2026-06-0${index + 1}T08:00:00.000Z`,
        score: 90,
      })),
      ...Array.from({ length: 5 }, (_, index) => trip({
        id: `after-${index}`,
        startTime: `2026-06-${String(index + 5).padStart(2, '0')}T08:00:00.000Z`,
        score: 70,
      })),
    ];

    const intelligence = buildAdvancedInsightIntelligence(
      analysisFor(trips),
      {},
      { allTrips: trips, now: new Date('2026-07-13T08:00:00.000Z') }
    );

    expect(intelligence.changePoint).toMatchObject({
      direction: 'declined',
      delta: -20,
      persisted: true,
      tripId: 'after-0',
    });
  });

  it('counts only comparable trips in a frozen five-drive experiment', () => {
    const baselineTrips = [
      trip({
        id: 'baseline-1',
        startTime: '2026-06-01T08:00:00.000Z',
        harshBrakes: 2,
      }),
      trip({
        id: 'baseline-2',
        startTime: '2026-06-02T08:00:00.000Z',
        harshBrakes: 2,
      }),
    ];
    const experiment = {
      ...createComparableExperiment({
        id: 'harsh_brakes',
        title: 'Harsh braking reset',
        metricKey: 'harsh_brakes_count',
        baseline: 20,
        target: 14,
      }, baselineTrips),
      startedAt: '2026-07-01T00:00:00.000Z',
    };
    const afterTrips = [
      ...Array.from({ length: 5 }, (_, index) => trip({
        id: `matched-${index}`,
        startTime: `2026-07-0${index + 2}T08:00:00.000Z`,
        harshBrakes: 0,
      })),
      trip({
        id: 'excluded-route',
        startTime: '2026-07-08T08:00:00.000Z',
        routeKey: 'route-z',
        harshBrakes: 9,
      }),
    ];

    const progress = buildComparableExperimentProgress(experiment, afterTrips);

    expect(progress).toMatchObject({
      tripCount: 5,
      targetTrips: 5,
      excludedTripCount: 1,
      complete: true,
      targetMet: true,
      currentValue: 0,
    });
    expect(progress.tripIds).not.toContain('excluded-route');
  });

  it('preserves exact event evidence and returns cited local answers', () => {
    const event = {
      type: 'harsh_brake',
      severity: 'high',
      timestamp: '2026-07-08T08:04:00.000Z',
      lat: 43.6532,
      lng: -79.3832,
      speed_kmh: 52,
      speed_limit_kmh: 40,
    };
    const current = trip({
      id: 'event-trip',
      startTime: '2026-07-08T08:00:00.000Z',
      events: [event],
    });
    const baseline = trip({
      id: 'event-baseline',
      startTime: '2026-06-10T08:00:00.000Z',
      score: 70,
    });
    const analysis = analysisFor([current], [baseline]);
    const intelligence = buildAdvancedInsightIntelligence(
      analysis,
      {},
      { allTrips: [current, baseline], now: new Date('2026-07-13T08:00:00.000Z') }
    );

    expect(intelligence.eventEvidence[0]).toMatchObject({
      tripId: 'event-trip',
      type: 'harsh_brake',
      lat: 43.6532,
      lng: -79.3832,
      speedKmh: 52,
      speedLimitKmh: 40,
    });

    const answer = answerDriveQuestion('Am I improving?', analysis, intelligence);
    expect(answer.localOnly).toBe(true);
    expect(answer.answer).toContain('comparable trip');
    expect(answer.citations[0]).toMatchObject({ tripId: 'event-trip' });
  });

  it('compares reconstructed scores only across trips with recorded headlines', () => {
    const scored = trip({ id: 'scored', startTime: '2026-07-08T08:00:00.000Z', score: 82, componentScore: 82 });
    const missingHeadline = trip({ id: 'missing', startTime: '2026-07-09T08:00:00.000Z', componentScore: 40 });
    delete missingHeadline.score_overall;
    const intelligence = buildAdvancedInsightIntelligence(
      analysisFor([scored, missingHeadline]),
      {},
      { allTrips: [scored, missingHeadline], now: new Date('2026-07-13T08:00:00.000Z') }
    );

    expect(intelligence.attribution).toMatchObject({
      reconstructedScore: 82,
      recordedScore: 82,
      reconstructionDelta: 0,
      exactBlend: true,
    });
  });

  it('identifies questions the local intent set does not support', () => {
    const analysis = analysisFor([]);
    const answer = answerDriveQuestion('What music did I play?', analysis, {
      attribution: { rows: [] }, matched: { pairs: [] }, eventEvidence: [], forecast: {},
    });

    expect(answer).toMatchObject({ supported: false, localOnly: true });
    expect(answer.answer).toContain('supported questions');
  });
});
