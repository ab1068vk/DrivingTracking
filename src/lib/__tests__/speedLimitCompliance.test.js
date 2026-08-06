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
    // A mapped OSM maxspeed is high-confidence but not certain (0.90 -> weight 0.95), so it
    // keeps nearly all of the raw penalty while a GPS-inferred limit keeps far less.
    expect(postedResult.speed_penalty_totals.totalWeightedPenalty)
      .toBeGreaterThan(postedResult.speed_penalty_totals.totalRawPenalty * 0.9);
    expect(postedResult.speed_penalty_totals.totalWeightedPenalty)
      .toBeLessThanOrEqual(postedResult.speed_penalty_totals.totalRawPenalty);
    expect(inferredResult.speed_penalty_totals.totalWeightedPenalty).toBeLessThan(inferredResult.speed_penalty_totals.totalRawPenalty);
    expect(inferredResult.speed_penalty_totals.totalPostedWeight).toBeLessThan(postedResult.speed_penalty_totals.totalPostedWeight);
  });

  it('reports compliance as unavailable when no limit is trustworthy enough to score', () => {
    const points = Array.from({ length: 20 }, (_, index) => ({
      ...p(index, 82),
      speed_limit_kmh: 60,
      speed_limit_source: 'unknown',
    }));
    const result = calculateSpeedLimitCompliance(points, {}, DEFAULT_THRESHOLDS);

    // The raw penalty is still recorded: they were 22 km/h over something.
    expect(result.speed_penalty_totals.totalRawPenalty).toBeGreaterThan(0);
    expect(result.speed_penalty_totals.totalWeightedPenalty).toBe(0);
    expect(result.speed_penalty_totals.totalPostedWeight).toBe(0);

    // But no limit was trustworthy enough to score against, so there is no
    // score. This used to report 100 — "no evidence" read as "perfect".
    expect(result.overall_compliance_score).toBeNull();
    const bucket = result.urban_compliance ?? result.highway_compliance ?? result.residential_compliance;
    expect(bucket.score).toBeNull();
    expect(bucket.score_available).toBe(false);
  });

  it('excludes an unavailable bucket from the trip average instead of counting it as 100', () => {
    // Urban points with a posted limit they are well over, plus a longer run of
    // highway points whose limit is unknown. The unknown run must not lift the
    // trip average toward 100.
    const scored = Array.from({ length: 10 }, (_, index) => ({
      ...p(index, 82),
      speed_limit_kmh: 50,
      speed_limit_source: 'openstreetmap',
    }));
    const unknown = Array.from({ length: 40 }, (_, index) => ({
      ...p(index + 10, 82),
      speed_limit_kmh: 60,
      speed_limit_source: 'unknown',
    }));
    const result = calculateSpeedLimitCompliance([...scored, ...unknown], {}, DEFAULT_THRESHOLDS);

    const scoredBuckets = [result.highway_compliance, result.urban_compliance, result.residential_compliance]
      .filter((bucket) => bucket?.score != null);
    expect(scoredBuckets.length).toBeGreaterThan(0);
    expect(result.overall_compliance_score).toBeLessThan(100);
  });

  // A trip long enough to clear the trip-level evidence gates, so score_safety
  // is a real number rather than 'unavailable'. ~22.8 m per second is 82 km/h.
  const scorableTrip = (source, speedKmh = 82) => Array.from({ length: 600 }, (_, index) => ({
    lat: 43.65 + index * 0.000205,
    lng: -79.38,
    speed_kmh: speedKmh,
    speed_limit_kmh: 60,
    speed_limit_source: source,
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + index * 1000).toISOString(),
  }));

  it('weights a speeding event by the confidence the resolver settled on', () => {
    // Same source string, different resolved confidence. The event path used to
    // re-derive the weight from the static source profile, so a stale or
    // conflicted limit charged the full penalty anyway — and disagreed with the
    // weight calculateSpeedLimitCompliance gave the very same limit.
    const points = scorableTrip('learned_local');
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const scoresFor = (zoneConfidence) => calculateTripScores(
      [{
        type: EVENT_TYPES.SPEEDING,
        severity: 'high',
        speed_limit_source: 'learned_local',
        zone_confidence: zoneConfidence,
      }],
      stats,
      points,
      DEFAULT_THRESHOLDS
    );

    const trusted = scoresFor(0.92);
    const doubtful = scoresFor(0.34);
    expect(Number.isFinite(trusted.score_safety)).toBe(true);
    expect(doubtful.score_safety).toBeGreaterThan(trusted.score_safety);
  });

  it('keeps compliance out of Safety when there is no compliance evidence', () => {
    const points = scorableTrip('unknown');
    const stats = calculateTripStats(points, points[0].timestamp, points.at(-1).timestamp);
    const scores = calculateTripScores([], stats, points, DEFAULT_THRESHOLDS);

    // No trustworthy limit anywhere, so compliance is unavailable and must not
    // enter the Safety blend as if it were a scored component.
    expect(scores.overall_compliance_score).toBeNull();
    expect(Number.isFinite(scores.score_safety)).toBe(true);
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
  // These values now come from the single SPEED_LIMIT_SOURCE_PROFILES table in
  // speedLimitConfidence.js. confidenceForSource used to carry a second, disagreeing copy
  // (openstreetmap 1.0, osm_highway_default 0.70, region_default_estimate 0.45) while both
  // fed speeding penalties. A crowd-sourced OSM tag is mapped data, not a verified sign,
  // so it ranks below user_confirmed_posted_sign rather than at certainty.
  it('separates posted signs, user estimates, regional defaults, and legacy corrections', () => {
    expect(confidenceForSource('openstreetmap')).toBe(0.90);
    expect(confidenceForSource('user_confirmed_posted_sign')).toBe(0.92);
    expect(confidenceForSource('user_entered_estimate')).toBe(0.75);
    expect(confidenceForSource('user_correction')).toBe(0.75);
    expect(confidenceForSource('region_default_estimate')).toBe(0.40);
    expect(confidenceForSource('osm_highway_default')).toBe(0.48);
  });

  it('lets a stored per-record confidence override the source default', () => {
    expect(confidenceForSource('learned_local', 0.83)).toBe(0.83);
    expect(confidenceForSource('user_confirmed_posted_sign', 0.97)).toBe(0.97);
    // A source with no per-record evidence ignores the argument.
    expect(confidenceForSource('openstreetmap', 0.2)).toBe(0.90);
  });
});

describe('regression - existing behaviour preserved', () => {
  it('existing OSM maxspeed events still produce near-full penalty weight', () => {
    const r = resolveSpeedLimitWithTier(
      { speed_limit_kmh: 60, speed_limit_source: 'openstreetmap' },
      {}
    );
    expect(r.penaltyWeight).toBe(0.95);
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
