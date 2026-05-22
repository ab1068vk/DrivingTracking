import { afterEach, describe, expect, it, vi } from 'vitest';
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
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('scores mileage from the last 12 months instead of lifetime distance', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

    const report = computeUBIReport([
      trip(19500, {
        start_time: '2024-01-01T12:00:00.000Z',
        end_time: '2024-01-01T12:30:00.000Z',
      }),
      trip(500, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);

    expect(report.totalKm).toBe(20000);
    expect(report.categories.mileage.score).toBe(100);
    expect(report.categories.mileage.value).toBe('500.0 km');
  });

  it('scores lower recent annual mileage below very high recent annual mileage', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

    const moderateMileageReport = computeUBIReport([
      trip(2000, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);
    const highMileageReport = computeUBIReport([
      trip(20000, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);

    expect(moderateMileageReport.categories.mileage.score).toBe(95);
    expect(highMileageReport.categories.mileage.score).toBe(20);
    expect(moderateMileageReport.categories.mileage.score).toBeGreaterThan(highMileageReport.categories.mileage.score);
  });
});
