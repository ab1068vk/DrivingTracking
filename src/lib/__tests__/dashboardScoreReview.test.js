import { describe, expect, it } from 'vitest';
import {
  buildDashboardScoreReviewFingerprint,
  isDashboardScoreReviewDismissed,
  normalizeDashboardScoreReviewFingerprint,
} from '@/lib/dashboardScoreReview';

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

  it('stays stable when a trip is saved again after dismissal', () => {
    const trip = { id: 'trip-1', updated_at: '2026-06-18T10:00:00.000Z' };
    const dismissed = buildDashboardScoreReviewFingerprint({ unavailableTrips: [trip] });

    expect(buildDashboardScoreReviewFingerprint({
      unavailableTrips: [{ ...trip, updated_at: '2026-06-18T12:00:00.000Z' }],
    })).toBe(dismissed);
    expect(isDashboardScoreReviewDismissed(dismissed, buildDashboardScoreReviewFingerprint({
      unavailableTrips: [{ ...trip, score_provenance: { computed_at: '2026-06-18T12:01:00.000Z' } }],
    }))).toBe(true);
  });

  it('changes when a new trip or issue appears', () => {
    const trip = { id: 'trip-1', updated_at: '2026-06-18T10:00:00.000Z' };
    const dismissed = buildDashboardScoreReviewFingerprint({ unavailableTrips: [trip] });

    expect(buildDashboardScoreReviewFingerprint({
      unavailableTrips: [trip, { id: 'trip-2', updated_at: '2026-06-18T12:00:00.000Z' }],
    })).not.toBe(dismissed);
    expect(buildDashboardScoreReviewFingerprint({
      mismatchTrips: [trip],
      unavailableTrips: [trip],
    })).not.toBe(dismissed);
  });

  it('normalizes legacy timestamp fingerprints and treats dismissed supersets as covered', () => {
    const current = buildDashboardScoreReviewFingerprint({
      unavailableTrips: [{ id: 'trip-1' }],
    });
    const legacy = 'trip-1:2026-06-18T10:00:00.000Z:score-unavailable';
    const legacySuperset = [
      legacy,
      'trip-2:2026-06-18T11:00:00.000Z:model-mismatch',
    ].join('|');

    expect(normalizeDashboardScoreReviewFingerprint(legacy)).toBe(current);
    expect(isDashboardScoreReviewDismissed(legacy, current)).toBe(true);
    expect(isDashboardScoreReviewDismissed(legacySuperset, current)).toBe(true);
    expect(isDashboardScoreReviewDismissed(legacy, `${current}|trip:trip-2:model-mismatch`)).toBe(false);
  });
});
