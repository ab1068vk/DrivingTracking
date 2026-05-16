import { describe, expect, it } from 'vitest';
import { computeUBIReport, UBI_CATEGORY_WEIGHTS } from '@/lib/ubiReport';

const trip = (distanceKm, overrides = {}) => ({
  status: 'completed',
  distance_km: distanceKm,
  duration_seconds: 1800,
  start_time: '2026-01-01T12:00:00.000Z',
  end_time: '2026-01-01T12:30:00.000Z',
  harsh_brakes_count: 0,
  rapid_accel_count: 0,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  night_driving: false,
  ...overrides,
});

describe('ubiReport', () => {
  it('handles empty trips without NaN', () => {
    const report = computeUBIReport([]);
    expect(report.ubiScore).toBe(0);
    expect(Number.isNaN(report.ubiScore)).toBe(false);
  });

  it('zero night trips gives timeOfDay score 100', () => {
    expect(computeUBIReport([trip(10)]).categories.timeOfDay.score).toBe(100);
  });

  it('category weights sum to exactly 1.0', () => {
    const total = Object.values(UBI_CATEGORY_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('ubiTier is Preferred when ubiScore >= 85', () => {
    expect(computeUBIReport([trip(10), trip(20)]).ubiTier).toBe('Preferred');
  });

  it('totalKm sums all trip distances', () => {
    expect(computeUBIReport([trip(10.2), trip(20.3)]).totalKm).toBe(30.5);
  });
});
