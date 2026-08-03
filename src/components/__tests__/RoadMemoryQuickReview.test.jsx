import { describe, expect, it } from 'vitest';
import { roadMemoryCandidateReviewableForTrip } from '@/components/RoadMemoryQuickReview';

describe('RoadMemoryQuickReview', () => {
  const candidate = {
    id: 'candidate-1',
    stage: 'suggested',
    tripIds: ['trip-1', 'trip-2'],
    tripCount: 2,
  };

  it('offers a parked review for suggestions learned from the completed trip', () => {
    expect(roadMemoryCandidateReviewableForTrip(candidate, 'trip-2')).toBe(true);
    expect(roadMemoryCandidateReviewableForTrip(candidate, 'other-trip')).toBe(false);
  });

  it('does not repeat a deferred prompt until new independent evidence arrives', () => {
    expect(roadMemoryCandidateReviewableForTrip({
      ...candidate,
      reviewState: 'deferred',
      lastPromptedTripCount: 2,
    }, 'trip-2')).toBe(false);
    expect(roadMemoryCandidateReviewableForTrip({
      ...candidate,
      tripIds: [...candidate.tripIds, 'trip-3'],
      tripCount: 3,
      stage: 'operational',
      reviewState: 'deferred',
      lastPromptedTripCount: 2,
    }, 'trip-3')).toBe(true);
  });

  it('hides candidates already resolved by the user', () => {
    expect(roadMemoryCandidateReviewableForTrip({
      ...candidate,
      reviewState: 'confirmed',
    }, 'trip-2')).toBe(false);
  });
});
