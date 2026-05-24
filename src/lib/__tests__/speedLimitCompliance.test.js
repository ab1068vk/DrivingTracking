import { describe, expect, it } from 'vitest';
import { calculateSpeedLimitCompliance, calculateTripStats, DEFAULT_THRESHOLDS } from '@/lib/tripEngine';

const p = (index, speed) => ({
  lat: 43.65 + index * 0.00008,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

describe('speed-limit compliance', () => {
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
    expect(buckets.some((bucket) => bucket.limit_source === 'openstreetmap')).toBe(true);
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
});
