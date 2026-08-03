import { describe, expect, it } from 'vitest';
import { buildCoachingEffectiveness, emptyCoachProgramStore } from '@/lib/coachPrograms';
import {
  buildPostDriveCoachStore,
  buildPostDriveFeedbackStore,
} from '@/lib/postDriveActions';

const trip = {
  id: 'trip-new',
  status: 'completed',
  start_time: '2026-07-30T12:00:00.000Z',
  end_time: '2026-07-30T12:20:00.000Z',
  distance_km: 12,
  route_key: 'home|work',
  speeding_events_count: 2,
  score_overall: 82,
};

describe('post-drive actions', () => {
  it('activates a real three-drive coaching program from the review', () => {
    const result = buildPostDriveCoachStore({
      store: emptyCoachProgramStore(),
      trip,
      trips: [
        { ...trip, id: 'trip-old-1', start_time: '2026-07-28T12:00:00.000Z' },
        { ...trip, id: 'trip-old-2', start_time: '2026-07-27T12:00:00.000Z' },
      ],
      focusId: 'speeding',
      now: new Date('2026-07-30T13:00:00.000Z'),
    });

    expect(result.replaced).toBe(false);
    expect(result.store.active).toMatchObject({
      focusId: 'speeding',
      source: 'post_drive_review',
      sourceTripId: 'trip-new',
      status: 'active',
      targetTripCount: 3,
    });
    expect(result.store.active.context.routeKey).toBe('home|work');
  });

  it('records recommendation feedback in the coaching learning system', () => {
    const store = buildPostDriveFeedbackStore({
      store: emptyCoachProgramStore(),
      tripId: trip.id,
      focusId: 'speeding',
      verdict: 'not_relevant',
      now: new Date('2026-07-30T13:00:00.000Z'),
    });

    expect(store.feedback[0]).toMatchObject({
      programId: 'post_drive_review:trip-new',
      tripId: 'trip-new',
      focusId: 'speeding',
      verdict: 'not_relevant',
    });
    expect(buildCoachingEffectiveness(store).speeding.feedbackScore).toBeLessThan(0);
  });
});
