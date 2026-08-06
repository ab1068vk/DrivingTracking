import { describe, expect, it } from 'vitest';
import {
  buildRoadMemoryObservations,
  consolidateRoadMemoryCandidates,
  findRoadMemoryCandidateMatch,
  mergeRoadMemoryObservation,
  roadMemoryCandidateOperationalState,
  roadMemoryEffectiveLimit,
  roadMemoryTimeBucket,
} from '@/lib/localRoadMemory';
import { buildRoadMemoryActivity } from '@/lib/roadMemoryIntelligence';
import { LocalSpeedKnowledge, STORAGE_KEY } from '@/lib/localSpeedKnowledge';

const routeTrip = (id, {
  speedKmh = 49,
  lat = 43.65,
  startLng = -79.39,
  pointCount = 38,
} = {}) => ({
  id,
  status: 'completed',
  start_time: `2026-07-${String(id).padStart(2, '0')}T12:00:00.000Z`,
  end_time: `2026-07-${String(id).padStart(2, '0')}T12:01:00.000Z`,
  route_points: Array.from({ length: pointCount }, (_, index) => ({
    lat,
    lng: startLng + index * 0.0001,
    speed_kmh: speedKmh,
    accuracy: 6,
    heading: 90,
    timestamp: `2026-07-${String(id).padStart(2, '0')}T12:00:${String(index).padStart(2, '0')}.000Z`,
  })),
});

const memoryStore = () => {
  let value = null;
  return {
    get: async (key) => key === STORAGE_KEY ? value : null,
    set: async (key, next) => {
      if (key === STORAGE_KEY) value = structuredClone(next);
    },
  };
};

describe('local Road Memory', () => {
  it('turns Road Memory decisions into a visible, truthful activity history', () => {
    expect(buildRoadMemoryActivity([
      {
        id: 'dismissed-change',
        roadName: 'King Street',
        reviewState: 'kept_existing',
        reviewedAt: '2026-08-02T12:00:00.000Z',
      },
      {
        id: 'confirmed-road',
        roadName: 'Queen Street',
        reviewState: 'confirmed',
        reviewedAt: '2026-08-02T13:00:00.000Z',
      },
    ])).toEqual([
      expect.objectContaining({ id: 'confirmed-road', title: 'Posted speed confirmed' }),
      expect.objectContaining({ id: 'dismissed-change', title: 'Possible change dismissed' }),
    ]);
  });
  it('stages repeated drives before making a lower-confidence corridor operational', () => {
    const first = buildRoadMemoryObservations(routeTrip(1));
    const second = buildRoadMemoryObservations(routeTrip(2));
    const third = buildRoadMemoryObservations(routeTrip(3));

    expect(first.length).toBeGreaterThan(0);
    expect(first[0].limitKmh).toBe(50);
    const once = mergeRoadMemoryObservation(null, first[0], 'candidate-1');
    expect(once.active).toBe(false);
    expect(findRoadMemoryCandidateMatch(second[0], [once])?.id).toBe('candidate-1');

    const twice = mergeRoadMemoryObservation(once, second[0], 'candidate-1');
    expect(twice.active).toBe(false);
    expect(twice.stage).toBe('suggested');
    expect(twice.tripCount).toBe(2);
    expect(twice.agreement).toBe(1);
    expect(twice.confidence).toBeGreaterThanOrEqual(0.58);

    const operational = mergeRoadMemoryObservation(twice, third[0], 'candidate-1');
    expect(operational.active).toBe(true);
    expect(operational.stage).toBe('operational');
    expect(twice.source).toBe('local_road_memory');
    expect(twice.verificationStatus).toBe('local_candidate');
  });

  it('does not create candidates from heavily stopped traffic', () => {
    const trip = routeTrip(3);
    trip.route_points = trip.route_points.map((point, index) => ({
      ...point,
      speed_kmh: index % 3 === 0 ? 18 : 0,
    }));
    expect(buildRoadMemoryObservations(trip)).toEqual([]);
  });

  it('rejects queue-like speeds and repeated parking-style turns', () => {
    const queueTrip = routeTrip(12);
    queueTrip.route_points = queueTrip.route_points.map((point, index) => ({
      ...point,
      speed_kmh: index % 2 === 0 ? 8 : 42,
    }));
    expect(buildRoadMemoryObservations(queueTrip)).toEqual([]);

    const turningTrip = routeTrip(13);
    turningTrip.route_points = turningTrip.route_points.map((point, index) => ({
      ...point,
      lat: 43.65 + (index % 2 === 0 ? 0 : 0.00018),
      lng: -79.39 + index * 0.00008,
      speed_kmh: 28,
    }));
    expect(buildRoadMemoryObservations(turningTrip)).toEqual([]);
  });

  it('keeps mature candidates in shadow mode while user-confirmed rules stay authoritative', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(4), routeTrip(5), routeTrip(6)]);

    const point = routeTrip(7).route_points[15];
    const unresolved = await knowledge.getForPoint(
      point.lat,
      point.lng,
      new Date(point.timestamp).getTime(),
      { headingDeg: 90 }
    );
    expect(unresolved).toBeNull();
    const [candidate] = await knowledge.listRoadMemoryCandidates();
    expect(candidate).toMatchObject({
      baseStage: 'operational',
      usageStage: 'shadow',
      canAffectScoreAndAlerts: false,
    });

    await knowledge.saveUserCorrection(
      point.lat,
      point.lng,
      40,
      'Confirmed after the drive',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        sectionPoints: candidate.sectionPoints,
        directionMode: 'forward',
        directionBearing: 90,
      }
    );
    const confirmed = await knowledge.getForPoint(
      point.lat,
      point.lng,
      new Date(point.timestamp).getTime(),
      { headingDeg: 90 }
    );
    expect(confirmed?.source).toBe('user_confirmed_posted_sign');
    expect(confirmed?.limitKmh).toBe(40);
  });

  it('never suggests Road Memory again for a user-confirmed corridor', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(4), routeTrip(5)]);
    const [candidate] = await knowledge.listRoadMemoryCandidates();

    await knowledge.saveUserCorrection(
      candidate.lat,
      candidate.lng,
      40,
      'Confirmed posted sign',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        sectionPoints: candidate.sectionPoints,
        directionMode: 'forward',
        directionBearing: 90,
      }
    );

    let candidates = await knowledge.listRoadMemoryCandidates({ activeOnly: false });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reviewState).toBe('confirmed');
    await knowledge.learnRoadMemoryFromTrips([routeTrip(6)]);
    candidates = await knowledge.listRoadMemoryCandidates({ activeOnly: false });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ reviewState: 'confirmed', tripCount: 2 });
  });

  it('keeps two- and three-drive suggestions out of scoring and alerts before validation', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(4), routeTrip(5)]);
    const point = routeTrip(6).route_points[15];

    expect(await knowledge.getForPoint(
      point.lat,
      point.lng,
      new Date(point.timestamp).getTime(),
      { headingDeg: 90 }
    )).toBeNull();
    const [suggestion] = await knowledge.listRoadMemoryCandidates();
    expect(suggestion).toMatchObject({
      active: false,
      stage: 'suggested',
      tripCount: 2,
    });
    await knowledge.learnRoadMemoryFromTrips([routeTrip(6)]);
    expect(await knowledge.getForPoint(
      point.lat,
      point.lng,
      new Date(point.timestamp).getTime(),
      { headingDeg: 90 }
    )).toBeNull();
    const [mature] = await knowledge.listRoadMemoryCandidates();
    expect(mature).toMatchObject({
      baseStage: 'operational',
      usageStage: 'shadow',
      active: false,
    });
  });

  it('pauses an operational candidate when two recent comparable drives suggest a change', () => {
    const observations = [1, 2, 3].map((id) => buildRoadMemoryObservations(routeTrip(id))[0]);
    let candidate = observations.reduce((current, observation) => (
      mergeRoadMemoryObservation(current, observation, 'change-candidate')
    ), null);
    expect(candidate.stage).toBe('operational');

    const changedTrip = (id) => {
      const trip = routeTrip(id, { speedKmh: 61 });
      trip.route_points = trip.route_points.map((point, index) => ({
        ...point,
        timestamp: `2026-07-06T12:00:${String(index).padStart(2, '0')}.000Z`,
      }));
      return buildRoadMemoryObservations(trip)[0];
    };
    const changedFirst = changedTrip(4);
    const changedSecond = changedTrip(5);
    candidate = mergeRoadMemoryObservation(candidate, changedFirst, candidate.id);
    expect(candidate.stage).toBe('operational');
    candidate = mergeRoadMemoryObservation(candidate, changedSecond, candidate.id);

    expect(candidate.stage).toBe('change_review');
    expect(candidate.active).toBe(false);
    expect(candidate.limitKmh).toBe(50);
    expect(candidate.changeDetection).toMatchObject({
      status: 'possible_change',
      previousLimitKmh: 50,
      proposedLimitKmh: 60,
      evidenceCount: 2,
    });
  });

  it('keeps a higher-evidence time pattern out of legal-speed use until parked acceptance', () => {
    expect(roadMemoryTimeBucket('2026-07-06T12:00:00.000Z', -240)).toBe('weekday_morning');
    const atHour = (id, hour, speedKmh) => {
      const trip = routeTrip(id, { speedKmh });
      trip.route_points = trip.route_points.map((point, index) => ({
        ...point,
        timestamp: `2026-07-06T${String(hour).padStart(2, '0')}:00:${String(index).padStart(2, '0')}.000`,
      }));
      return buildRoadMemoryObservations(trip)[0];
    };
    let candidate = null;
    [
      atHour(1, 8, 49),
      atHour(2, 8, 49),
      atHour(3, 8, 49),
      atHour(4, 16, 39),
      atHour(5, 16, 39),
      atHour(6, 16, 39),
    ].forEach((observation) => {
      candidate = mergeRoadMemoryObservation(candidate, observation, 'time-candidate');
    });

    expect(candidate.stage).toBe('operational');
    expect(candidate.timeProfiles.some((profile) => profile.eligible)).toBe(true);
    const pending = roadMemoryEffectiveLimit(candidate, '2026-07-07T08:00:00');
    expect(pending.limitKmh).toBe(40);
    expect(pending.timeProfile).toBeNull();
    expect(pending.pendingTimeProfile?.limitKmh).toBe(50);

    const accepted = roadMemoryEffectiveLimit({
      ...candidate,
      reviewState: 'time_profiles_accepted',
      timeProfilesAcceptedAt: '2026-07-07T17:00:00.000Z',
    }, '2026-07-07T08:00:00');
    expect(accepted.limitKmh).toBe(50);
    expect(accepted.timeProfile?.limitKmh).toBe(50);
  });

  it('ignores implausible imported base limits and accepted time profiles', () => {
    const effective = roadMemoryEffectiveLimit({
      limitKmh: 40,
      reviewState: 'time_profiles_accepted',
      timeProfilesAcceptedAt: '2026-07-07T17:00:00.000Z',
      timeProfiles: [
        { bucket: 'weekday_morning', limitKmh: 250, eligible: true },
      ],
    }, '2026-07-07T08:00:00');

    expect(effective.limitKmh).toBe(40);
    expect(effective.timeProfile).toBeNull();
    expect(roadMemoryEffectiveLimit({ limitKmh: 250 }).limitKmh).toBeNull();
  });

  it('decays old candidates and removes stale candidates from operational use', () => {
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    const candidate = {
      active: true,
      confidence: 0.72,
      agreement: 1,
      tripCount: 5,
      lastObservedAt: '2026-02-01T12:00:00.000Z',
    };
    const state = roadMemoryCandidateOperationalState(candidate, now);
    expect(state.stale).toBe(true);
    expect(state.active).toBe(false);
    expect(state.stage).toBe('stale');
    expect(state.effectiveConfidence).toBeLessThan(candidate.confidence);
  });

  it('keeps different adjacent limits split while consolidating duplicate same-limit geometry', () => {
    const first = mergeRoadMemoryObservation(
      null,
      buildRoadMemoryObservations(routeTrip(1))[0],
      'first'
    );
    const duplicate = { ...first, id: 'duplicate', sectionKey: 'duplicate' };
    expect(consolidateRoadMemoryCandidates([first, duplicate])).toHaveLength(1);

    const differentObservation = {
      ...buildRoadMemoryObservations(routeTrip(2, { speedKmh: 61 }))[0],
      sectionPoints: first.sectionPoints.map((point, index) => ({
        lat: point.lat,
        lng: first.sectionPoints.at(-1).lng + (index + 1) * 0.0001,
      })),
    };
    expect(findRoadMemoryCandidateMatch(differentObservation, [first])).toBeNull();
  });

  it('does not stitch merely adjacent same-limit fragments without repeated trip continuity', () => {
    const first = mergeRoadMemoryObservation(
      null,
      buildRoadMemoryObservations(routeTrip(1))[0],
      'first-fragment'
    );
    const shifted = {
      ...first,
      id: 'nearby-fragment',
      sectionKey: 'nearby-fragment',
      tripIds: ['different-trip'],
      tripVotes: { 'different-trip': first.limitKmh },
      sectionPoints: first.sectionPoints.map((point) => ({
        lat: point.lat + 0.00055,
        lng: point.lng,
      })),
    };

    expect(consolidateRoadMemoryCandidates([first, shifted])).toHaveLength(2);
  });

  it('does not match a nearby side street from endpoint proximity alone', () => {
    const candidate = {
      id: 'main-road',
      limitKmh: 50,
      directionBearing: 90,
      sectionPoints: [
        { lat: 43.65, lng: -79.39 },
        { lat: 43.65, lng: -79.38 },
      ],
    };
    const sideStreet = {
      tripId: 'side-street-trip',
      limitKmh: 50,
      directionBearing: 0,
      sectionPoints: [
        { lat: 43.651, lng: -79.38 },
        { lat: 43.653, lng: -79.38 },
      ],
    };

    expect(findRoadMemoryCandidateMatch(sideStreet, [candidate])).toBeNull();
  });

  it('keeps opposite travel directions as independent evidence', () => {
    const forwardObservation = buildRoadMemoryObservations(routeTrip(1))[0];
    const forwardCandidate = mergeRoadMemoryObservation(null, forwardObservation, 'forward');
    const reverseObservation = {
      ...forwardObservation,
      tripId: 'reverse-trip',
      sectionPoints: [...forwardObservation.sectionPoints].reverse(),
      directionBearing: (Number(forwardObservation.directionBearing) + 180) % 360,
    };

    expect(findRoadMemoryCandidateMatch(reverseObservation, [forwardCandidate])).toBeNull();
  });

  it('does not apply direction-specific Road Memory when heading is unavailable', async () => {
    const store = memoryStore();
    const target = {
      id: 'direction-target',
      sectionKey: 'direction-target',
      geohash: 'dpz83f',
      source: 'local_road_memory',
      limitKmh: 50,
      confidence: 0.72,
      evidenceConfidence: 0.72,
      agreement: 1,
      tripCount: 4,
      evidenceCount: 4,
      tripIds: ['target-1', 'target-2', 'target-3', 'target-4'],
      limitVotes: { 50: 4 },
      lastObservedAt: new Date().toISOString(),
      sectionPoints: [
        { lat: 43.65, lng: -79.39 },
        { lat: 43.65, lng: -79.38 },
      ],
      directionMode: 'forward',
      directionBearing: 90,
      quality: { congestionSpreadKmh: 5 },
    };
    const feedback = Array.from({ length: 8 }, (_, index) => ({
      ...target,
      id: `feedback-${index}`,
      sectionKey: `feedback-${index}`,
      geohash: `feedback-${index}`,
      tripIds: Array.from({ length: 4 }, (_item, tripIndex) => `feedback-${index}-${tripIndex}`),
      reviewState: 'confirmed',
      reviewedAt: new Date().toISOString(),
      limitAtReviewKmh: 50,
      reviewedLimitKmh: 50,
      feedbackOutcome: 'exact',
      sectionPoints: [
        { lat: 44 + index * 0.01, lng: -80 },
        { lat: 44 + index * 0.01, lng: -79.99 },
      ],
    }));
    await store.set(STORAGE_KEY, {
      cells: {},
      corrections: [],
      roadMemory: {
        version: 3,
        chronologyVersion: 1,
        candidates: [target, ...feedback],
        processedTrips: {},
      },
    });
    const knowledge = new LocalSpeedKnowledge(store);

    await expect(knowledge.getForPoint(43.65, -79.385, Date.now(), { headingDeg: 90 }))
      .resolves.toMatchObject({ limitKmh: 50, source: 'local_road_memory' });
    await expect(knowledge.getForPoint(43.65, -79.385, Date.now()))
      .resolves.toBeNull();
  });

  it('processes each stored trip only once', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const trip = routeTrip(7);
    const first = await knowledge.learnRoadMemoryFromTrips([trip]);
    const second = await knowledge.learnRoadMemoryFromTrips([trip]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect((await knowledge.listRoadMemoryCandidates()).every((candidate) => candidate.tripCount === 1)).toBe(true);
  });

  it('learns newest-first repository history in real chronological order', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);

    await knowledge.learnRoadMemoryFromTrips([
      routeTrip(3),
      routeTrip(1),
      routeTrip(2),
    ]);

    const [candidate] = await knowledge.listRoadMemoryCandidates();
    expect(candidate.firstObservedAt).toBe('2026-07-01T12:00:28.000Z');
    expect(candidate.lastObservedAt).toBe('2026-07-03T12:00:28.000Z');
    expect(candidate.recentObservations.map((item) => item.tripId)).toEqual(['1', '2', '3']);
  });

  it('does not mark a legacy inverted observation range as stale', () => {
    const state = roadMemoryCandidateOperationalState({
      confidence: 0.72,
      agreement: 1,
      tripCount: 5,
      firstObservedAt: '2026-07-29T12:00:00.000Z',
      lastObservedAt: '2026-02-01T12:00:00.000Z',
    }, Date.parse('2026-07-30T12:00:00.000Z'));

    expect(state.ageDays).toBe(1);
    expect(state.stale).toBe(false);
    expect(state.stage).toBe('operational');
  });

  it('supports parked defer and one-tap confirmation without losing the learned evidence', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(8), routeTrip(9), routeTrip(10)]);
    const [candidate] = await knowledge.listRoadMemoryCandidates({ activeOnly: false });

    const deferred = await knowledge.reviewRoadMemoryCandidate(candidate.id, { action: 'defer' });
    expect(deferred.reviewState).toBe('deferred');
    const confirmed = await knowledge.reviewRoadMemoryCandidate(candidate.id, {
      action: 'confirm_posted',
      limitKmh: 50,
    });
    expect(confirmed.reviewState).toBe('confirmed');

    const point = routeTrip(11).route_points[15];
    const resolved = await knowledge.getForPoint(
      point.lat,
      point.lng,
      new Date(point.timestamp).getTime(),
      { headingDeg: 90 }
    );
    expect(resolved).toMatchObject({
      source: 'user_confirmed_posted_sign',
      limitKmh: 50,
    });
    const [reviewed] = await knowledge.listRoadMemoryCandidates();
    expect(reviewed.reviewState).toBe('confirmed');
    expect(reviewed.tripCount).toBe(3);
  });

  it('versions a confirmed Road Memory change from its effective date so old trips keep the old rule', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    const sectionPoints = [
      { lat: 43.65, lng: -79.386 },
      { lat: 43.65, lng: -79.384 },
    ];
    await knowledge.replaceData({
      cells: {},
      corrections: [{
        id: 'old-confirmed-rule',
        geohash: 'dpz83d',
        lat: 43.65,
        lng: -79.385,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        validFrom: '2026-01-01T00:00:00.000Z',
        roadMemoryCandidateId: 'candidate-change',
        directionMode: 'both',
        sectionPoints,
      }],
      roadMemory: {
        version: 3,
        processedTrips: {},
        candidates: [{
          id: 'candidate-change',
          geohash: 'dpz83d',
          lat: 43.65,
          lng: -79.385,
          limitKmh: 50,
          source: 'local_road_memory',
          roadName: 'Changed Road',
          directionMode: 'both',
          sectionPoints,
          tripCount: 8,
          agreement: 0.9,
          confidence: 0.8,
          firstObservedAt: '2026-01-01T00:00:00.000Z',
          lastObservedAt: '2026-07-20T00:00:00.000Z',
          changeDetection: {
            status: 'possible_change',
            previousLimitKmh: 50,
            proposedLimitKmh: 70,
            detectedAt: '2026-07-15T12:00:00.000Z',
          },
        }],
      },
    });

    const reviewed = await knowledge.reviewRoadMemoryCandidate('candidate-change', {
      action: 'confirm_posted',
      limitKmh: 70,
      effectiveFrom: '2026-07-15T00:00:00.000Z',
      effectiveFromDate: '2026-07-15',
    });
    const corrections = await knowledge.listUserCorrections();
    const historical = corrections.find((item) => item.historicalVersion);
    const current = corrections.find((item) => !item.historicalVersion);

    expect(reviewed.reviewState).toBe('confirmed');
    expect(historical).toMatchObject({
      id: 'old-confirmed-rule',
      limitKmh: 50,
      expiresAt: '2026-07-15T00:00:00.000Z',
      supersededByCorrectionId: current.id,
    });
    expect(current).toMatchObject({
      limitKmh: 70,
      validFrom: '2026-07-15T00:00:00.000Z',
      validFromDate: '2026-07-15',
      supersedesCorrectionId: 'old-confirmed-rule',
    });
    await expect(knowledge.getForPoint(
      43.65, -79.385, Date.parse('2026-07-10T12:00:00.000Z')
    )).resolves.toMatchObject({ limitKmh: 50 });
    await expect(knowledge.getForPoint(
      43.65, -79.385, Date.parse('2026-07-20T12:00:00.000Z')
    )).resolves.toMatchObject({ limitKmh: 70 });
  });

  it('learns from a normal saved posted-speed confirmation without requiring a special prompt', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(12), routeTrip(13), routeTrip(14), routeTrip(15)]);
    const [candidate] = await knowledge.listRoadMemoryCandidates();

    const saved = await knowledge.saveUserCorrection(
      candidate.lat,
      candidate.lng,
      40,
      'Confirmed through the normal map editor',
      null,
      [],
      'user_confirmed_posted_sign',
      {
        sectionPoints: candidate.sectionPoints,
        directionMode: candidate.directionMode,
        directionBearing: candidate.directionBearing,
      }
    );

    expect(saved.roadMemoryFeedbackRecorded).toBe(true);
    const [reviewed] = await knowledge.listRoadMemoryCandidates();
    expect(reviewed).toMatchObject({
      reviewState: 'confirmed',
      feedbackOutcome: 'adjusted',
      limitAtReviewKmh: 50,
      reviewedLimitKmh: 40,
      canAffectScoreAndAlerts: false,
    });
  });

  it('records an explicitly linked map estimate as Road Memory feedback', async () => {
    const store = memoryStore();
    const knowledge = new LocalSpeedKnowledge(store);
    await knowledge.learnRoadMemoryFromTrips([routeTrip(12), routeTrip(13), routeTrip(14), routeTrip(15)]);
    const [candidate] = await knowledge.listRoadMemoryCandidates();

    const saved = await knowledge.saveUserCorrection(
      candidate.lat,
      candidate.lng,
      40,
      'Adjusted through the map editor',
      null,
      [],
      'user_entered_estimate',
      {
        sectionPoints: candidate.sectionPoints,
        directionMode: candidate.directionMode,
        directionBearing: candidate.directionBearing,
        provenance: 'road_memory_map_edit',
        roadMemoryCandidateId: candidate.id,
      }
    );

    expect(saved.roadMemoryFeedbackRecorded).toBe(true);
    const [reviewed] = await knowledge.listRoadMemoryCandidates();
    expect(reviewed).toMatchObject({
      reviewState: 'adjusted',
      feedbackOutcome: 'adjusted',
      limitAtReviewKmh: 50,
      reviewedLimitKmh: 40,
    });
  });
});

describe('trip vote retention', () => {
  const observation = (tripId, limitKmh = 50) => ({
    tripId: String(tripId),
    limitKmh,
    sectionPoints: [
      { lat: 43.65, lng: -79.39 },
      { lat: 43.65, lng: -79.388 },
    ],
    lat: 43.65,
    lng: -79.39,
    directionBearing: 90,
  });

  it('keeps the newest votes, not the highest-numbered trip ids', () => {
    // Trip ids are frequently integer-like, and integer-like object keys
    // enumerate numerically regardless of insertion order. Trimming with
    // Object.entries(...).slice(-50) therefore kept the 50 *highest* ids, so a
    // long-running install silently froze its evidence at whatever ids happened
    // to sort last.
    let candidate = null;
    const ids = [];
    for (let i = 200; i > 0; i -= 1) {
      ids.push(String(i));
      candidate = mergeRoadMemoryObservation(candidate, observation(i), 'candidate-1');
    }

    const kept = Object.keys(candidate.tripVotes);
    expect(kept).toHaveLength(50);
    // The last 50 observations recorded were ids 50 down to 1.
    expect(new Set(kept)).toEqual(new Set(ids.slice(-50)));
    expect(kept).not.toContain('200');
  });

  it('never drops the observation it just recorded', () => {
    let candidate = null;
    for (let i = 500; i > 400; i -= 1) {
      candidate = mergeRoadMemoryObservation(candidate, observation(i), 'candidate-1');
    }
    candidate = mergeRoadMemoryObservation(candidate, observation(1), 'candidate-1');

    expect(candidate.tripVotes).toHaveProperty('1');
    expect(candidate.tripVoteOrder.at(-1)).toBe('1');
  });

  it('preserves order across a merge that carries no explicit order', () => {
    // A candidate persisted before tripVoteOrder existed still trims sanely.
    const legacy = {
      tripVotes: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(i + 1), 50])),
      limitKmh: 50,
    };
    const merged = mergeRoadMemoryObservation(legacy, observation(9001), 'candidate-1');
    expect(Object.keys(merged.tripVotes)).toHaveLength(50);
    expect(merged.tripVotes).toHaveProperty('9001');
  });
});

describe('learned limit provenance', () => {
  const tripAt = (speedKmh, pointOverrides = {}) => ({
    ...routeTrip(11, { speedKmh }),
    route_points: routeTrip(11, { speedKmh }).route_points.map((point) => ({
      ...point,
      ...pointOverrides,
    })),
  });

  it('learns the measured p85 rather than a low-confidence estimate on the points', () => {
    // The points carry an `inferred` estimate of 80, which is 0.35 confidence.
    // It used to override the measured p85 outright, and the result then accrued
    // votes up to 0.72 confidence as though it had been measured.
    const observations = buildRoadMemoryObservations(tripAt(49, {
      speed_limit_kmh: 80,
      speed_limit_source: 'inferred',
    }));

    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0].limitKmh).toBe(50);
    expect(observations[0].inferenceBasis).toBe('driving_behavior_p85');
  });

  it('falls back to the estimate only when the p85 cannot be resolved', () => {
    // 55 km/h sits exactly between the 50 and 60 rungs, so the ladder refuses to
    // answer and the estimate is consulted as a tie-break.
    const observations = buildRoadMemoryObservations(tripAt(55, {
      speed_limit_kmh: 60,
      speed_limit_source: 'region_default_estimate',
    }));

    expect(observations.length).toBeGreaterThan(0);
    expect(observations[0].limitKmh).toBe(60);
    expect(observations[0].inferenceBasis).toBe('trip_estimate_consensus');
  });

  it('learns a mph road on mph rungs when the ladder is imperial', () => {
    // 56.3 km/h is 35 mph. On the metric ladder it snaps to 60.
    const metric = buildRoadMemoryObservations(tripAt(56.3));
    const imperial = buildRoadMemoryObservations(tripAt(56.3), { units: 'imperial' });

    expect(metric[0].limitKmh).toBe(60);
    expect(imperial[0].limitKmh).toBe(56);
  });
});
