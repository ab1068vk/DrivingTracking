import { describe, expect, it } from 'vitest';

import {
  assessSpeedLimitEvidence,
  speedLimitConfidenceLabel,
} from '@/lib/speedLimitConfidence';
import {
  buildCorrectionImpactPreview,
  buildSpeedLimitRecommendation,
  sortSpeedLimitReviewItems,
  summarizeTripSpeedLimitIntelligence,
} from '@/lib/speedLimitIntelligence';

describe('speed-limit intelligence', () => {
  it('separates verified, estimated, stale, and conflicted evidence', () => {
    const now = new Date('2026-06-20T12:00:00.000Z').getTime();
    const verified = assessSpeedLimitEvidence({
      source: 'user_confirmed_posted_sign',
      verifiedAt: '2026-06-01T12:00:00.000Z',
    }, now);
    const stale = assessSpeedLimitEvidence({
      source: 'user_entered_estimate',
      appliedAt: '2025-01-01T12:00:00.000Z',
    }, now);
    const conflicted = assessSpeedLimitEvidence({
      source: 'openstreetmap',
      lastUpdatedAt: '2026-06-01T12:00:00.000Z',
      conflict: true,
    }, now);

    expect(verified.level).toBe('high');
    expect(speedLimitConfidenceLabel(verified)).toBe('High confidence');
    expect(stale.stale).toBe(true);
    expect(stale.needsReview).toBe(true);
    expect(conflicted.confidence).toBeLessThan(verified.confidence);
    expect(speedLimitConfidenceLabel(conflicted)).toBe('Conflicted');
  });

  it('ranks conflicts and missing posted data ahead of routine reviews', () => {
    const sorted = sortSpeedLimitReviewItems([
      { geohash: 'routine', source: 'user_entered_estimate', sampleCount: 1 },
      { geohash: 'missing', source: 'missing_posted_review', sampleCount: 1 },
      {
        geohash: 'conflict',
        source: 'openstreetmap',
        conflict: true,
        conflictDetails: { existingLimitKmh: 40, newLimitKmh: 70 },
      },
    ]);

    expect(sorted.map((item) => item.geohash)).toEqual(['conflict', 'missing', 'routine']);
  });

  it('previews affected trips and likely over-limit points for a traced correction', () => {
    const correction = {
      limitKmh: 40,
      sectionPoints: [
        { lat: 43.6500, lng: -79.3810 },
        { lat: 43.6500, lng: -79.3800 },
      ],
    };
    const preview = buildCorrectionImpactPreview([{
      id: 'trip-1',
      status: 'completed',
      route_points: [
        { lat: 43.6500, lng: -79.3807, speed_kmh: 52 },
        { lat: 43.6500, lng: -79.3804, speed_kmh: 65 },
      ],
    }], correction, 40);

    expect(preview.affectedTripCount).toBe(1);
    expect(preview.matchedPointCount).toBe(2);
    expect(preview.pointsOverLimit).toBe(2);
    expect(preview.severePointCount).toBe(1);
  });

  it('summarizes verified coverage separately from total coverage', () => {
    const summary = summarizeTripSpeedLimitIntelligence({
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 45, speed_limit_kmh: 50, speed_limit_source: 'openstreetmap' },
        { lat: 43.651, lng: -79.381, speed_kmh: 65, speed_limit_kmh: 50, speed_limit_source: 'region_default_estimate' },
        { lat: 43.652, lng: -79.382, speed_kmh: 35 },
      ],
    });

    expect(summary.coveragePercent).toBe(67);
    expect(summary.verifiedCoveragePercent).toBe(33);
    expect(summary.lowConfidencePointCount).toBe(1);
    expect(summary.overLimitPointCount).toBe(1);
    expect(summary.recommendations.length).toBeGreaterThan(0);
  });

  it('never presents inferred behavior as verified posted evidence', () => {
    const recommendation = buildSpeedLimitRecommendation({
      source: 'inferred',
      limitKmh: 50,
    });

    expect(recommendation.kind).toBe('low_confidence');
    expect(recommendation.text).toContain('estimated');
  });
});

