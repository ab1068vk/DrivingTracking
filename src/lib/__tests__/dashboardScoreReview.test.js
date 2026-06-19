import { describe, expect, it } from 'vitest';
import { buildDashboardScoreReviewFingerprint } from '@/lib/dashboardScoreReview';

describe('dashboard score review dismissal', () => {
  it('returns no fingerprint when there are no score issues', () => {
    expect(buildDashboardScoreReviewFingerprint()).toBe('');
  });

  it('is stable when affected trips arrive in a different order', () => {
    const first = { id: 'trip-1', updated_at: '2026-06-18T10:00:00.000Z' };
    const second = { id: 'trip-2', updated_at: '2026-06-18T11:00:00.000Z' };

    expect(buildDashboardScoreReviewFingerprint({
      mismatchTrips: [first, second],
    })).toBe(buildDashboardScoreReviewFingerprint({
      mismatchTrips: [second, first],
    }));
  });

  it('changes when a trip is updated or a new issue appears', () => {
    const trip = { id: 'trip-1', updated_at: '2026-06-18T10:00:00.000Z' };
    const dismissed = buildDashboardScoreReviewFingerprint({ unavailableTrips: [trip] });

    expect(buildDashboardScoreReviewFingerprint({
      unavailableTrips: [{ ...trip, updated_at: '2026-06-18T12:00:00.000Z' }],
    })).not.toBe(dismissed);
    expect(buildDashboardScoreReviewFingerprint({
      mismatchTrips: [trip],
      unavailableTrips: [trip],
    })).not.toBe(dismissed);
  });
});
