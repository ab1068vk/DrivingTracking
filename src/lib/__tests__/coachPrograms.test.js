import { describe, expect, it } from 'vitest';
import {
  buildCoachEvidenceAudit,
  buildCoachRouteOptions,
  buildCoachSegmentInsights,
  buildCoachingEffectiveness,
  buildCoachProgramProgress,
  buildCoachRecommendations,
  buildGroundedCoachAnswer,
  createCoachProgram,
  finishCoachProgram,
  normalizeCoachProgramStore,
  reconcileCoachProgramStore,
  recommendCoachDifficulty,
  recordCoachFeedback,
  repairCoachProgramEvidence,
} from '@/lib/coachPrograms';

const trip = ({
  id,
  start,
  distance = 20,
  harsh = 0,
  accel = 0,
  turns = 0,
  speeding = 0,
  score = 80,
  route = 'route-a',
  roadType = 'urban',
  duration = 1200,
} = {}) => ({
  id,
  status: 'completed',
  start_time: start,
  distance_km: distance,
  duration_seconds: duration,
  route_key: route,
  dominant_road_type: roadType,
  harsh_brakes_count: harsh,
  rapid_accel_count: accel,
  sharp_turns_count: turns,
  speeding_events_count: speeding,
  score_overall: score,
});

const baselineTrips = [
  trip({ id: 'b1', start: '2026-06-01T08:00:00.000Z', harsh: 2, score: 78 }),
  trip({ id: 'b2', start: '2026-06-02T08:00:00.000Z', harsh: 2, score: 82 }),
];

describe('coach programs', () => {
  it('creates a measurable event-rate target from the selected baseline', () => {
    const program = createCoachProgram({
      focusId: 'harsh_brakes',
      difficulty: 'standard',
      contextMode: 'comparable',
      targetTripCount: 5,
      trips: baselineTrips,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });

    expect(program.baseline.metric).toBe(10);
    expect(program.targetMetric).toBe(7.5);
    expect(program.context.label).toBe('This repeated route');
    expect(program.promptBudget).toBe(3);
  });

  it('measures only post-start trips from the matched context', () => {
    const program = createCoachProgram({
      focusId: 'harsh_brakes',
      difficulty: 'standard',
      contextMode: 'comparable',
      targetTripCount: 3,
      trips: baselineTrips,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });
    const after = [
      trip({ id: 'n1', start: '2026-06-04T08:00:00.000Z', harsh: 1 }),
      trip({ id: 'n2', start: '2026-06-05T08:00:00.000Z', harsh: 1 }),
      trip({ id: 'other-route', start: '2026-06-05T09:00:00.000Z', harsh: 8, route: 'route-b' }),
    ];

    const progress = buildCoachProgramProgress(program, [...after, ...baselineTrips]);

    expect(progress.completedCount).toBe(2);
    expect(progress.currentMetric).toBe(5);
    expect(progress.improvement).toBe(50);
    expect(progress.latestReview.tripId).toBe('n2');
    expect(progress.latestReview.metTarget).toBe(true);
  });

  it('supports higher-is-better consistency programs and graduation', () => {
    const program = createCoachProgram({
      focusId: 'consistency',
      difficulty: 'gentle',
      contextMode: 'all',
      targetTripCount: 3,
      trips: baselineTrips,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });
    const improved = [
      trip({ id: 'n1', start: '2026-06-04T08:00:00.000Z', score: 86 }),
      trip({ id: 'n2', start: '2026-06-05T08:00:00.000Z', score: 88 }),
      trip({ id: 'n3', start: '2026-06-06T08:00:00.000Z', score: 90 }),
    ];

    const progress = buildCoachProgramProgress(program, [...improved, ...baselineTrips]);
    const finished = finishCoachProgram(program, [...improved, ...baselineTrips]);

    expect(program.baseline.metric).toBe(80);
    expect(program.targetMetric).toBe(83);
    expect(progress.currentMetric).toBe(88);
    expect(progress.readyToGraduate).toBe(true);
    expect(finished.result.graduated).toBe(true);
  });

  it('prioritizes the coach focus and keeps recommendations unique', () => {
    const recommendations = buildCoachRecommendations({
      focus_area: 'braking',
      coach_brief: { why: 'Braking is the strongest current signal.', confidence: 'strong' },
      risk_patterns: [
        { key: 'harsh_brakes', label: 'Harsh braking', share_percent: 60, count: 6 },
        { key: 'speeding', label: 'Speeding', share_percent: 40, count: 4 },
      ],
    }, baselineTrips);

    expect(recommendations[0]).toMatchObject({ focusId: 'harsh_brakes', priority: 'high' });
    expect(new Set(recommendations.map((item) => item.focusId)).size).toBe(recommendations.length);
  });

  it('normalizes corrupt stores without retaining unlimited history', () => {
    const normalized = normalizeCoachProgramStore({
      active: 'bad',
      history: Array.from({ length: 30 }, (_, index) => ({ id: index })),
    });

    expect(normalized.active).toBeNull();
    expect(normalized.history).toHaveLength(20);
  });

  it('anchors a program to an explicitly selected repeated route', () => {
    const routeB = [
      trip({ id: 'r2-1', start: '2026-06-01T09:00:00.000Z', route: 'route-b', harsh: 6 }),
      trip({ id: 'r2-2', start: '2026-06-02T09:00:00.000Z', route: 'route-b', harsh: 4 }),
    ];
    const routes = buildCoachRouteOptions([...routeB, ...baselineTrips]);
    const selected = routes.find((route) => route.routeKey === 'route-b');
    const program = createCoachProgram({
      focusId: 'harsh_brakes',
      contextMode: 'comparable',
      routeKey: selected.routeKey,
      contextSignature: selected.signature,
      contextLabel: 'School run',
      trips: [...routeB, ...baselineTrips],
      now: new Date('2026-06-03T12:00:00.000Z'),
    });

    expect(program.context.routeKey).toBe('route-b');
    expect(program.context.label).toBe('School run');
    expect(program.baseline.tripIds).toEqual(['r2-2', 'r2-1']);
  });

  it('learns prompt restraint and recommendation context from coaching feedback', () => {
    const program = createCoachProgram({
      focusId: 'harsh_brakes',
      trips: baselineTrips,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });
    let store = normalizeCoachProgramStore({ active: program, history: [], feedback: [] });
    store = recordCoachFeedback(store, { program, tripId: 'x1', verdict: 'too_frequent' });
    store = recordCoachFeedback(store, { program, tripId: 'x2', verdict: 'not_relevant' });
    const effectiveness = buildCoachingEffectiveness(store);
    const adaptive = createCoachProgram({
      focusId: 'harsh_brakes',
      difficulty: 'adaptive',
      store,
      trips: baselineTrips,
      now: new Date('2026-06-04T12:00:00.000Z'),
    });
    const recommendation = buildCoachRecommendations({ focus_area: 'braking' }, baselineTrips, store)[0];

    expect(effectiveness.harsh_brakes.feedbackScore).toBeLessThan(0);
    expect(adaptive.difficulty).toBe('gentle');
    expect(adaptive.promptBudget).toBe(1);
    expect(recommendation.whyNow).toContain('feedback');
  });

  it('automatically graduates a completed target into history and preserves the result moment', () => {
    const program = createCoachProgram({
      focusId: 'consistency',
      difficulty: 'gentle',
      contextMode: 'all',
      targetTripCount: 3,
      trips: baselineTrips,
      now: new Date('2026-06-03T12:00:00.000Z'),
    });
    const improved = [
      trip({ id: 'g1', start: '2026-06-04T08:00:00.000Z', score: 86 }),
      trip({ id: 'g2', start: '2026-06-05T08:00:00.000Z', score: 88 }),
      trip({ id: 'g3', start: '2026-06-06T08:00:00.000Z', score: 90 }),
    ];
    const next = reconcileCoachProgramStore({ active: program, history: [] }, [...improved, ...baselineTrips]);

    expect(next.active).toBeNull();
    expect(next.lastResult.status).toBe('graduated');
    expect(next.lastResult.result.latestTripId).toBe('g3');
    expect(next.history[0].result.graduated).toBe(true);
  });

  it('finds repeated event sections only from positioned route evidence', () => {
    const detailed = [
      {
        ...trip({ id: 's1', start: '2026-06-04T08:00:00.000Z' }),
        route_points: Array.from({ length: 10 }, (_, index) => ({ lat: 43 + index / 1000, lng: -79 })),
        driving_events: [{ type: 'harsh_brake', route_point_index: 8 }],
      },
      {
        ...trip({ id: 's2', start: '2026-06-05T08:00:00.000Z' }),
        route_points: Array.from({ length: 10 }, (_, index) => ({ lat: 43 + index / 1000, lng: -79 })),
        driving_events: [{ type: 'harsh_brake', route_point_index: 7 }],
      },
    ];
    const segments = buildCoachSegmentInsights(detailed, 'route-a', 'harsh_brakes');

    expect(segments.strongestSection.id).toBe('late');
    expect(segments.strongestSection.repeatRate).toBe(100);
    expect(segments.evidenceLevel).toBe('developing');
  });
});

  it('answers Coach questions with trip citations and an explicit inference boundary', () => {
    const recommendations = buildCoachRecommendations({ focus_area: 'braking' }, baselineTrips);
    const answer = buildGroundedCoachAnswer('Why this focus?', { trips: baselineTrips, recommendations });
    const routeAnswer = buildGroundedCoachAnswer('Where do events repeat?', {
      trips: baselineTrips,
      recommendations,
    });

    expect(answer.answer).toContain('Progressive Braking');
    expect(answer.evidence.map((item) => item.tripId)).toEqual(['b2', 'b1']);
    expect(answer.inference).toBeTruthy();
    expect(answer.limitation).toContain('does not infer');
    expect(routeAnswer.answer).toContain('repeated route');
    expect(routeAnswer.evidence).toHaveLength(2);
  });



describe('coach evidence semantics', () => {
  it('excludes missing legacy event fields instead of converting them to zero', () => {
    const legacy = {
      id: 'legacy-missing',
      status: 'completed',
      start_time: '2026-06-01T08:00:00.000Z',
      distance_km: 20,
      route_key: 'route-a',
      dominant_road_type: 'urban',
    };
    const measuredZero = trip({
      id: 'measured-zero',
      start: '2026-06-02T08:00:00.000Z',
      harsh: 0,
    });
    const program = createCoachProgram({
      focusId: 'harsh_brakes',
      contextMode: 'all',
      trips: [measuredZero, legacy],
      now: new Date('2026-06-03T12:00:00.000Z'),
    });

    expect(program.baseline.metric).toBe(0);
    expect(program.baseline.tripCount).toBe(1);
    expect(program.baseline.tripIds).toEqual(['measured-zero']);
  });

  it('audits measured, missing, and excluded historical trips separately', () => {
    const measured = trip({ id: 'measured', start: '2026-06-02T08:00:00.000Z' });
    const missing = {
      id: 'missing',
      status: 'completed',
      start_time: '2026-06-01T08:00:00.000Z',
      distance_km: 12,
    };
    const excluded = { ...trip({ id: 'passenger', start: '2026-05-31T08:00:00.000Z' }), is_passenger: true };
    const audit = buildCoachEvidenceAudit([measured, missing, excluded], [measured, missing]);

    expect(audit).toMatchObject({
      totalCompleted: 3,
      driverEligible: 2,
      scoreReady: 1,
      eventReady: 1,
      excludedDriver: 1,
      missingCoachMeasurements: 1,
    });
  });

  it('does not invent a recommendation from trips with no Coach measurements', () => {
    const unmeasured = [
      { id: 'u1', status: 'completed', start_time: '2026-06-01T08:00:00.000Z', distance_km: 10 },
      { id: 'u2', status: 'completed', start_time: '2026-06-02T08:00:00.000Z', distance_km: 11 },
    ];

    expect(buildCoachRecommendations({ focus_area: 'braking' }, unmeasured)).toEqual([]);
  });

  it('repairs false-zero baselines in legacy active programs', () => {
    const legacyProgram = {
      id: 'legacy-program',
      version: 2,
      status: 'active',
      focusId: 'harsh_brakes',
      difficulty: 'standard',
      targetTripCount: 5,
      startedAt: '2026-06-03T12:00:00.000Z',
      context: { mode: 'all', label: 'All eligible drives' },
      baseline: { metric: 0, tripCount: 2, tripIds: ['u1', 'u2'] },
      targetMetric: 0,
    };
    const unmeasured = [
      { id: 'u1', status: 'completed', start_time: '2026-06-01T08:00:00.000Z', distance_km: 10 },
      { id: 'u2', status: 'completed', start_time: '2026-06-02T08:00:00.000Z', distance_km: 11 },
    ];
    const repaired = repairCoachProgramEvidence(legacyProgram, unmeasured);

    expect(repaired.version).toBe(3);
    expect(repaired.baseline).toMatchObject({ metric: null, tripCount: 0, tripIds: [] });
    expect(repaired.targetMetric).toBeNull();
  });

  it('migrates paused programs to active and ignores incomplete history for adaptive difficulty', () => {
    const normalized = normalizeCoachProgramStore({
      active: { id: 'paused', status: 'paused' },
      history: [{
        id: 'replaced',
        version: 3,
        status: 'replaced',
        focusId: 'harsh_brakes',
        targetTripCount: 5,
        result: { completedCount: 1, graduated: false },
      }],
    });

    expect(normalized.active.status).toBe('active');
    expect(recommendCoachDifficulty('harsh_brakes', normalized).difficulty).toBe('standard');
  });
});
