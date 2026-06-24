import { describe, expect, it } from 'vitest';

import {
  buildDashboardSpeedLimitReviewFingerprint,
  buildTripSpeedLimitReviewCells,
  isDashboardSpeedLimitReviewDismissed,
  normalizeDashboardSpeedLimitReviewFingerprint,
  speedLimitReviewNeededForTrip,
} from '@/lib/speedLimitReview';

const point = (patch = {}) => ({
  lat: 43.65,
  lng: -79.38,
  speed_kmh: 42,
  timestamp: '2026-01-01T12:00:00Z',
  ...patch,
});

describe('speed-limit parked review', () => {
  it('does not require review for posted OSM maxspeed cells', () => {
    const trip = {
      route_points: [
        point({ speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' }),
      ],
    };

    expect(speedLimitReviewNeededForTrip(trip)).toBe(false);
    expect(buildTripSpeedLimitReviewCells(trip)).toHaveLength(0);
  });

  it('queues estimated trip cells for parked review', () => {
    const trip = {
      route_points: [
        point({ speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' }),
        point({ lat: 43.6501, speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' }),
      ],
    };

    const cells = buildTripSpeedLimitReviewCells(trip);
    expect(speedLimitReviewNeededForTrip(trip)).toBe(true);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      lat: 43.65,
      lng: -79.38,
      coordinateSource: 'driven_route_sample',
      limitKmh: 50,
      tripReview: true,
      source: 'region_default_estimate',
      limits: [50],
      sources: ['region_default_estimate'],
    });
  });

  it('can return every reviewable cell for a full trip review', () => {
    const trip = {
      route_points: Array.from({ length: 12 }, (_, index) => point({
        lat: 43.65 + index * 0.01,
        lng: -79.38,
        speed_limit_kmh: 50,
        speed_limit_source: 'region_default_estimate',
      })),
    };

    expect(buildTripSpeedLimitReviewCells(trip)).toHaveLength(8);
    expect(buildTripSpeedLimitReviewCells(trip, { maxCells: Infinity })).toHaveLength(12);
  });

  it('queues native background trips even when route points have no speed-limit fields', () => {
    const trip = {
      start_source: 'native_auto',
      speed_limit_review_required: true,
      route_points: [
        point(),
        point({ lat: 43.6501 }),
      ],
    };

    const cells = buildTripSpeedLimitReviewCells(trip);
    expect(cells).toHaveLength(1);
    expect(cells[0].source).toBe('missing_posted_review');
    expect(cells[0].reviewReason).toContain('Background tracking cannot confirm posted signs');
  });

  it('ignores null-island route samples when building parked-review cells', () => {
    const trip = {
      start_source: 'native_auto',
      speed_limit_review_required: true,
      route_points: [
        point({ lat: 0, lng: 0 }),
        point({ lat: 43.6501, lng: -79.3801 }),
      ],
    };

    const cells = buildTripSpeedLimitReviewCells(trip);

    expect(cells).toHaveLength(1);
    expect(cells[0].lat).toBeCloseTo(43.6501);
    expect(cells[0].lng).toBeCloseTo(-79.3801);
  });

  it('recognizes summary records flagged for speed-limit review', () => {
    expect(speedLimitReviewNeededForTrip({
      id: 'summary-native',
      speed_limit_review_required: true,
    })).toBe(true);
  });

  it('builds a stable dashboard dismissal fingerprint for parked-review work', () => {
    const trip = {
      id: 'trip-1',
      updated_at: '2026-06-20T12:00:00.000Z',
      speed_limit_review_required: true,
    };
    const firstCell = {
      geohash: 'dpz83x',
      limitKmh: 50,
      lastUpdatedAt: '2026-06-20T11:00:00.000Z',
      conflictDetails: { existingLimitKmh: 50, newLimitKmh: 60 },
    };
    const secondCell = {
      geohash: 'dpz83y',
      limitKmh: 40,
      lastUpdatedAt: '2026-06-20T11:30:00.000Z',
      conflictDetails: { existingLimitKmh: 40, newLimitKmh: 50 },
    };

    expect(buildDashboardSpeedLimitReviewFingerprint({
      conflictedCells: [firstCell, secondCell],
      reviewTrip: trip,
      reviewCellCount: 3,
    })).toBe(buildDashboardSpeedLimitReviewFingerprint({
      conflictedCells: [secondCell, firstCell],
      reviewTrip: trip,
      reviewCellCount: 3,
    }));
  });

  it('keeps a dismissed trip review hidden when review-cell detail changes after reload', () => {
    const dismissed = buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    });

    expect(buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 2,
    })).toBe(dismissed);
    expect(isDashboardSpeedLimitReviewDismissed(dismissed, buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 2,
    }))).toBe(true);
  });

  it('changes the dashboard dismissal fingerprint when new speed-review work appears', () => {
    const dismissed = buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    });

    expect(buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-2',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    })).not.toBe(dismissed);
    expect(buildDashboardSpeedLimitReviewFingerprint({
      conflictedCells: [{
        geohash: 'dpz83x',
        limitKmh: 50,
        lastUpdatedAt: '2026-06-20T11:00:00.000Z',
        conflictDetails: { existingLimitKmh: 50, newLimitKmh: 60 },
      }],
    })).not.toBe(dismissed);
  });

  it('keeps a dismissed trip review warning hidden when saved trip timestamps change after reload', () => {
    const dismissed = buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    });

    expect(buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        updated_at: '2026-06-20T13:00:00.000Z',
        score_provenance: { computed_at: '2026-06-20T12:58:00.000Z' },
        end_time: '2026-06-20T12:55:00.000Z',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    })).toBe(dismissed);
  });

  it('normalizes legacy parked-review fingerprints and treats dismissed supersets as covered', () => {
    const currentTripReview = buildDashboardSpeedLimitReviewFingerprint({
      reviewTrip: {
        id: 'trip-1',
        speed_limit_review_required: true,
      },
      reviewCellCount: 1,
    });
    const legacyTripReview = 'trip:trip-1:required:7';
    const currentConflict = buildDashboardSpeedLimitReviewFingerprint({
      conflictedCells: [{
        geohash: 'dpz83x',
        limitKmh: 50,
        conflictDetails: { existingLimitKmh: 50, newLimitKmh: 60 },
      }],
    });
    const legacyConflict = 'cell:dpz83x:2026-06-20T11:00:00.000Z:50:50:60';
    const legacySuperset = `${legacyTripReview}|${legacyConflict}`;

    expect(normalizeDashboardSpeedLimitReviewFingerprint(legacyTripReview)).toBe(currentTripReview);
    expect(normalizeDashboardSpeedLimitReviewFingerprint(legacyConflict)).toBe(currentConflict);
    expect(isDashboardSpeedLimitReviewDismissed(legacySuperset, currentTripReview)).toBe(true);
    expect(isDashboardSpeedLimitReviewDismissed(legacySuperset, currentConflict)).toBe(true);
    expect(isDashboardSpeedLimitReviewDismissed(legacyTripReview, `${currentTripReview}|${currentConflict}`)).toBe(false);
  });
});
