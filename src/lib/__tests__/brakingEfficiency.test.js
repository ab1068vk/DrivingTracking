import { describe, expect, it } from 'vitest';
import { calculateBrakingEfficiency, extractBrakingSequences } from '@/lib/tripEngine';

const p = (index, speed) => ({
  lat: 43.65 + index * 0.00018,
  lng: -79.38,
  speed_kmh: speed,
  timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, index * 2)).toISOString(),
});

describe('braking efficiency', () => {
  it('handles empty route points', () => {
    expect(calculateBrakingEfficiency([], []).braking_efficiency_score).toBeNull();
  });

  it('handles a single route point', () => {
    expect(calculateBrakingEfficiency([p(0, 30)], []).braking_sequence_count).toBe(0);
  });

  it('extracts and scores a deterministic progressive stop', () => {
    const points = [p(0, 50), p(1, 40), p(2, 30), p(3, 20), p(4, 10), p(5, 4)];
    expect(extractBrakingSequences(points).length).toBe(1);
    expect(calculateBrakingEfficiency(points, []).braking_efficiency_score).toBeGreaterThan(50);
  });

  it('grades progressive braking above emergency-heavy braking', () => {
    const progressive = [p(0, 55), p(1, 45), p(2, 35), p(3, 25), p(4, 15), p(5, 4)];
    const abrupt = [p(0, 55), p(1, 54), p(2, 10), p(3, 4)];
    expect(calculateBrakingEfficiency(progressive, []).braking_efficiency_score).toBeGreaterThan(
      calculateBrakingEfficiency(abrupt, []).braking_efficiency_score
    );
  });

  it('keeps repeated stop quality stable when distance doubles', () => {
    const stop = [p(0, 50), p(1, 40), p(2, 30), p(3, 20), p(4, 10), p(5, 4)];
    const doubled = [...stop, ...stop.map((point, index) => ({ ...point, lat: point.lat + 0.01, timestamp: p(index + 10, point.speed_kmh).timestamp }))];
    expect(Math.abs(
      calculateBrakingEfficiency(stop, []).braking_efficiency_score -
      calculateBrakingEfficiency(doubled, []).braking_efficiency_score
    )).toBeLessThanOrEqual(5);
  });
});
