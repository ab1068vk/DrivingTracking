import { describe, expect, it } from 'vitest';
import { buildDriverSignature } from '@/lib/tripInsights';

const trip = (index, overrides = {}) => ({
  id: `trip-${index}`,
  status: 'completed',
  start_time: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  aggressive_driving_score: 90,
  score_smoothness: 85,
  score_eco: 80,
  avg_speed_kmh: 55,
  braking_efficiency_score: 85,
  score_overall: 85,
  ...overrides,
});

describe('driver signature', () => {
  it('returns null for no trips', () => {
    expect(buildDriverSignature([])).toBeNull();
  });

  it('returns null for fewer than five trips', () => {
    expect(buildDriverSignature([trip(0), trip(1), trip(2), trip(3)])).toBeNull();
  });

  it('builds a deterministic eco-conscious signature', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index)));
    expect(result.archetype).toBe('eco_conscious');
    expect(result.trip_count_used).toBe(6);
  });

  it('classifies aggressive commuter boundary patterns', () => {
    const result = buildDriverSignature(Array.from({ length: 6 }, (_, index) => trip(index, {
      aggressive_driving_score: 35,
      avg_speed_kmh: 95,
      score_smoothness: 60,
    })));
    expect(result.archetype).toBe('aggressive_commuter');
  });

  it('detects an increasing aggression style shift', () => {
    const trips = [
      ...Array.from({ length: 5 }, (_, index) => trip(index + 15, { aggressive_driving_score: 45 })),
      ...Array.from({ length: 15 }, (_, index) => trip(index, { aggressive_driving_score: 95 })),
    ];
    expect(buildDriverSignature(trips).style_shifts.some((shift) => shift.dimension === 'aggression')).toBe(true);
  });
});
