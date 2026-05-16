import { describe, expect, it } from 'vitest';
import { calculateCorneringConsistency } from '@/lib/tripEngine';

const p = (index, lat, lng, speed = 70) => ({
  lat,
  lng,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
});

const bend = (count, radius = 0.003) => Array.from({ length: count }, (_, index) => {
  const theta = index * 0.08;
  return p(index, 43.65 + Math.sin(theta) * radius, -79.38 + Math.cos(theta) * radius, 65);
});

describe('cornering consistency', () => {
  it('handles empty route points', () => {
    expect(calculateCorneringConsistency([]).cornering_consistency_score).toBeNull();
  });

  it('handles a single route point', () => {
    expect(calculateCorneringConsistency([p(0, 43.65, -79.38)]).corner_sample_count).toBe(0);
  });

  it('scores a deterministic smooth bend', () => {
    const result = calculateCorneringConsistency(bend(30));
    expect(result.cornering_consistency_score).toBeGreaterThan(50);
    expect(result.mean_lateral_g).toBeGreaterThan(0.05);
  });

  it('distinguishes controlled from erratic cornering', () => {
    const smooth = calculateCorneringConsistency(bend(30, 0.004));
    const erratic = calculateCorneringConsistency(bend(30, 0.0005).map((point, index) => ({
      ...point,
      speed_kmh: index % 2 ? 120 : 35,
    })));
    expect(smooth.cornering_consistency_score).toBeGreaterThan(erratic.cornering_consistency_score ?? 0);
  });

  it('keeps doubled smooth bends within a stable score range', () => {
    const first = bend(30);
    const second = [...first, ...bend(30).map((point, index) => ({
      ...point,
      lat: point.lat + 0.02,
      timestamp: new Date(Date.UTC(2026, 0, 1, 12, 1, index)).toISOString(),
    }))];
    expect(Math.abs(
      calculateCorneringConsistency(first).cornering_consistency_score -
      calculateCorneringConsistency(second).cornering_consistency_score
    )).toBeLessThanOrEqual(5);
  });
});
