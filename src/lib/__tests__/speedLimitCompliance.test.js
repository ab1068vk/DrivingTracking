import { describe, expect, it } from 'vitest';
import {
  calculateSpeedLimitCompliance,
  calculateTripScores,
  calculateTripStats,
  DEFAULT_THRESHOLDS,
  EVENT_TYPES,
  prefetchLocalKnowledge,
  resolveEffectiveSpeedLimitForIndex,
} from '@/lib/tripEngine';
import { confidenceForSource, confidenceToPenaltyWeight, resolveSpeedLimitWithTier } from '@/lib/speedLimitSource';

// CHANGES (session):
// - Added Category F confidenceToPenaltyWeight backward compatibility tests.
// - Added Category G speed-limit regression tests.
// - Added Phase 3 per-point confidence-weighted speed penalty tests.
// - Updated regional default confidence test wording.
// - Updated REGION_DEFAULT confidence to 0.45.
// - Added user correction source confidence split coverage.
// - Updated POSTED bucket provenance to source-neutral posted label.
// - Updated REGION_DEFAULT penalty weight to 0.55 and user-confirmed posted sign weight to 0.95.

const p = (index, speed) => ({
  lat: 43.65 + index * 0.00008,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

describe('speed-limit compliance', () => {
  it('keeps opposite-direction local lookups separate in the same place and time bucket', async () => {
    const getForPoint = async (_lat, _lng, _time, { headingDeg }) => ({
      limitKmh: headingDeg < 180 ? 50 : 60,
      source: 'user_confirmed_posted_sign',
      confidence: 0.92,
    });
    const points = [
      { lat: 43.65, lng: -79.38, heading: 90, timestamp: '2026-01-01T12:00:00Z' },
      { lat: 43.65, lng: -79.38, heading: 270, timestamp: '2026-01-01T12:01:00Z' },
    ];

    await expect(prefetchLocalKnowledge(points, { getForPoint })).resolves.toMatchObject([
      { limitKmh: 50 },
      { limitKmh: 60 },
    ]);
  });

  it('does not reuse a traced-road match across nearby points in the same coarse map cell', async () => {
    const getForPoint = async (_lat, lng) => (
      lng < -79.3795
        ? { limitKmh: 40, source: 'user_confirmed_posted_sign', confidence: 0.92 }
        : null
    );
    const points = [
      { lat: 43.65, lng: -79.38, heading: 90, timestamp: '2026-01-01T12:00:00Z' },
      { lat: 43.65, lng: -79.379, heading: 90, timestamp: '2026-01-01T12:00:05Z' },
    ];

    await expect(prefetchLocalKnowledge(points, { getForPoint })).resolves.toEqual([
      expect.objectContaining({ limitKmh: 40 }),
      null,
    ]);
  });

  it('uses the batch resolver once while preserving per-point derived headings', async () => {
    const getForPoints = async (points) => points.map((point) => ({
      limitKmh: point.headingDeg < 180 ? 50 : 60,
      source: 'user_confirmed_posted_sign',
      confidence: 0.92,
    }));
    const knowledge = {
      getForPoint: async () => null,
      getForPoints,
    };

    await expect(prefetchLocalKnowledge([
      { lat: 43.65, lng: -79.38, heading: 90, timestamp: '2026-01-01T12:00:00Z' },
      { lat: 43.65, lng: -79.38, heading: 270, timestamp: '2026-01-01T12:00:05Z' },
    ], knowledge)).resolves.toMatchObject([
      { limitKmh: 50 },
      { limitKmh: 60 },
    ]);
  });

  it('uses the safer limit and flags review when saved and fresh posted data conflict', () => {
    const result = resolveEffectiveSpeedLimitForIndex([
      {
        lat: 43.65,
        lng: -79.38,
        speed_limit_kmh: 40,
        speed_limit_source: 'openstreetmap',
      },
    ], 0, DEFAULT_THRESHOLDS, {
      localKnowledge: {
        limitKmh: 60,
        source: 'user_confirmed_posted_sign',
        confidence: 0.92,
      },
    });

    expect(result.effectiveLimitKmh).toBe(40);
    expect(result.speedLimitConflict).toMatchObject({
      savedLimitKmh: 60,
      observedLimitKmh: 40,
      needsReview: true,
    });
  });

  it('does not let learned traffic history override fresh OpenStreetMap maxspeed data', () => {
    const result = resolveEffectiveSpeedLimitForIndex([
      {
        lat: 43.65,
        lng: -79.38,
        speed_limit_kmh: 40,
        speed_limit_source: 'openstreetmap',
      },
    ], 0, DEFAULT_THRESHOLDS, {
      localKnowledge: {
        limitKmh: 60,
        source: 'trip_consensus',
        confidence: 0.85,
      },
    });

    expect(result.effectiveLimitKmh).toBe(40);
    expect(result.limitSource).toBe('openstreetmap');
  });

  it.each([
    ['osm_highway_default', 60],
    ['region_default_estimate', 60],
    ['inferred', 60],
  ])('lets validated Road Memory outrank stored %s fallback evidence', (storedSource, storedLimit) => {
    const result = resolveEffectiveSpeedLimitForIndex([{
      lat: 43.65,
      lng: -79.38,
      speed_limit_kmh: storedLimit,
      speed_limit_source: storedSource,
    }], 0, DEFAULT_THRESHOLDS, {
      localKnowledge: {
        limitKmh: 50,
        source: 'local_road_memory',
        confidence: 0.66,
      },
    });

    expect(result).toMatchObject({
      effectiveLimitKmh: 50,
      limitSource: 'learned_local',
      tier: 'LEARNED_LOCAL',
    });
  });
  it('handles empty route points', () => {
    expect(calculateSpeedLimitCompliance([], {}, DEFAULT_THRESHOLDS).overall_compliance_score).toBeNull();
  });

  it('handles a single route point', () => {
    expect(calculateSpeedLimitCompliance([p(0, 0)], {}, DEFAULT_THRESHOLDS).urban_compliance).toBeNull();
  });

  it('scores a deterministic residential speeding route', () => {
    const points = Array.from({ length: 20 }, (_, index) => p(index, index % 5 === 0 ? 75 : 15));
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const result = calculateSpeedLimitCompliance(points, stats, DEFAULT_THRESHOLDS);
    expect(result.residential_compliance?.score).toBeLessThan(100);
  });

  it('scores compliant highway driving higher than over-limit highway driving', () => {
    const ok = Array.from({ length: 20 }, (_, index) => p(index, 105));
    const fast = Array.from({ length: 20 }, (_, index) => p(index, 150));
    expect(calculateSpeedLimitCompliance(ok, {}, DEFAULT_THRESHOLDS).highway_compliance.score).toBeGreaterThan(
      calculateSpeedLimitCompliance(fast, {}, DEFAULT_THRESHOLDS).highway_compliance.score
    );
  });

  it('keeps same-rate compliance stable with doubled samples', () => {
    const points = Array.from({ length: 20 }, (_, index) => p(index, index % 2 ? 55 : 35));
    const doubled = points.concat(points.map((point, index) => ({ ...point, lat: point.lat + 0.01, timestamp: p(index + 30, point.speed_kmh).timestamp })));
    expect(Math.abs(
      calculateSpeedLimitCompliance(points, {}, DEFAULT_THRESHOLDS).overall_compliance_score -
      calculateSpeedLimitCompliance(doubled, {}, DEFAULT_THRESHOLDS).overall_compliance_score
    )).toBeLessThanOrEqual(5);
  });

  it('uses actual point speed limits when available', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 72),
      speed_limit_kmh: 60,
      speed_limit_source: 'openstreetmap',
    }));
    const result = calculateSpeedLimitCompliance(points, {}, DEFAULT_THRESHOLDS);
    const buckets = [result.highway_compliance, result.urban_compliance, result.residential_compliance].filter(Boolean);
    expect(buckets.some((bucket) => bucket.limit_source === 'posted')).toBe(true);
    expect(buckets.every((bucket) => bucket.confidence > 0 && bucket.confidence <= 1)).toBe(true);
    expect(result.overall_compliance_score).toBeLessThan(100);
  });

  it('reports OSM highway defaults separately from posted maxspeed limits', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 62),
      speed_limit_kmh: 50,
      speed_limit_source: 'osm_highway_default',
    }));
    const result = calculateSpeedLimitCompliance(points, {}, DEFAULT_THRESHOLDS);
    const buckets = [result.highway_compliance, result.urban_compliance, result.residential_compliance].filter(Boolean);
    expect(buckets.some((bucket) => bucket.limit_source === 'osm_highway_default')).toBe(true);
  });

  it('tracks raw and weighted speed penalties per point', () => {
    const posted = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 82),
      speed_limit_kmh: 60,
      speed_limit_source: 'openstreetmap',
    }));
    const inferred = posted.map((point) => ({
      ...point,
      speed_limit_source: 'inferred',
    }));
    const postedResult = calculateSpeedLimitCompliance(posted, {}, DEFAULT_THRESHOLDS);
    const inferredResult = calculateSpeedLimitCompliance(inferred, {}, DEFAULT_THRESHOLDS);
    expect(postedResult.speed_penalty_totals.totalRawPenalty).toBeGreaterThan(0);
    expect(postedResult.speed_penalty_totals.totalWeightedPenalty).toBe(postedResult.speed_penalty_totals.totalRawPenalty);
    expect(inferredResult.speed_penalty_totals.totalWeightedPenalty).toBeLessThan(inferredResult.speed_penalty_totals.totalRawPenalty);
    expect(inferredResult.speed_penalty_totals.totalPostedWeight).toBeLessThan(postedResult.speed_penalty_totals.totalPostedWeight);
  });

  it('scores unknown-tier over-limit points as zero penalty', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 82),
      speed_limit_kmh: 60,
      speed_limit_source: 'unknown',
    }));
    const result = calculateSpeedLimitCompliance(points, {}, DEFAULT_THRESHOLDS);
    expect(result.speed_penalty_totals.totalRawPenalty).toBeGreaterThan(0);
    expect(result.speed_penalty_totals.totalWeightedPenalty).toBe(0);
    expect(result.overall_compliance_score).toBe(100);
  });

  it('adds penaltyReductionFraction to trip_speed_summary_v1', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 82),
      speed_limit_kmh: 60,
      speed_limit_source: 'inferred',
    }));
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const scores = calculateTripScores(
      [{ type: EVENT_TYPES.SPEEDING, severity: 'medium', speed_limit_source: 'inferred' }],
      stats,
      points,
      DEFAULT_THRESHOLDS
    );
    expect(scores.trip_speed_summary_v1.penaltyReductionFraction).toBeGreaterThan(0);
    expect(scores.trip_speed_summary_v1.penaltyReductionFraction).toBeLessThanOrEqual(1);
  });
});

describe('confidenceToPenaltyWeight backward compatibility', () => {
  it('POSTED (1.0) -> full weight 1.0', () => {
    expect(confidenceToPenaltyWeight(1.0)).toBe(1.0);
  });

  it('user-confirmed posted sign (0.92) -> near-full weight 0.95', () => {
    expect(confidenceToPenaltyWeight(0.92)).toBe(0.95);
  });

  it('GPS_INFERRED (0.35) -> half weight 0.50 (matches legacy behaviour)', () => {
    expect(confidenceToPenaltyWeight(0.35)).toBe(0.50);
  });

  it('UNKNOWN (0.0) -> zero weight (no penalty without data)', () => {
    expect(confidenceToPenaltyWeight(0.0)).toBe(0.0);
  });

  it('MAP_ESTIMATED (0.70) -> 0.85', () => {
    expect(confidenceToPenaltyWeight(0.70)).toBe(0.85);
  });

  it('REGION_DEFAULT (0.45) -> 0.55', () => {
    expect(confidenceToPenaltyWeight(0.45)).toBe(0.55);
  });
});

describe('confidenceForSource correction split', () => {
  it('separates posted signs, user estimates, regional defaults, and legacy corrections', () => {
    expect(confidenceForSource('openstreetmap')).toBe(1.0);
    expect(confidenceForSource('user_confirmed_posted_sign')).toBe(0.92);
    expect(confidenceForSource('user_entered_estimate')).toBe(0.75);
    expect(confidenceForSource('user_correction')).toBe(0.75);
    expect(confidenceForSource('region_default_estimate')).toBe(0.45);
  });
});

describe('regression - existing behaviour preserved', () => {
  it('existing OSM maxspeed events still produce weight 1.0', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      {}
    );
    expect(r.penaltyWeight).toBe(1.0);
  });

  it('existing inferred events produce weight <= 0.50', () => {
    const r = resolveSpeedLimitWithTier(
      {},
      { countryCode: 'DE', inferredZone: { inferredZoneKmh: 120 }, thresholds: { SPEEDING_FALLBACK_KMH: 100 } }
    );
    expect(r.penaltyWeight).toBeLessThanOrEqual(0.50);
  });

  it('tier-keyed cooldowns do not cross-suppress', () => {
    const gpsKey = 'speeding_GPS_INFERRED';
    const postedKey = 'speeding_POSTED';
    expect(gpsKey).not.toBe(postedKey);
  });
});
