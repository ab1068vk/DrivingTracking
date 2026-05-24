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
    expect(computeUBIReport([trip(50)]).categories.timeOfDay.score).toBe(100);
  });

  it('scores time-of-day exposure by night driving minutes instead of trip count', () => {
    const shortNightReport = computeUBIReport([
      trip(2, { duration_seconds: 5 * 60, night_driving: true }),
      trip(100, { duration_seconds: 120 * 60, night_driving: false }),
    ]);
    const longNightReport = computeUBIReport([
      trip(2, { duration_seconds: 5 * 60, night_driving: false }),
      trip(100, { duration_seconds: 120 * 60, night_driving: true }),
    ]);

    expect(shortNightReport.categories.timeOfDay.score).toBe(94);
    expect(longNightReport.categories.timeOfDay.score).toBe(0);
    expect(shortNightReport.categories.timeOfDay.score).toBeGreaterThan(longNightReport.categories.timeOfDay.score);
  });

  it('category weights sum to exactly 1.0', () => {
    const total = Object.values(UBI_CATEGORY_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('ubiTier is Preferred when ubiScore >= 85', () => {
    expect(computeUBIReport([trip(30), trip(30)]).ubiTier).toBe('Preferred');
  });

  it('withholds rate-based scoring until at least 50 km are observed', () => {
    const report = computeUBIReport([trip(4, { harsh_brakes_count: 1 })]);
    expect(report.insufficientData).toBe(true);
    expect(report.ubiScore).toBeNull();
    expect(report.ubiTier).toBe('Insufficient data');
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
    expect(report.categories.mileage.score).toBe(49);
    expect(report.categories.mileage.value).toBe('500.0 km');
  });

  it('peaks mileage scoring around moderate annual mileage and decays at both extremes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));

    const lowMileageReport = computeUBIReport([
      trip(500, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);
    const moderateMileageReport = computeUBIReport([
      trip(10000, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);
    const highMileageReport = computeUBIReport([
      trip(50000, {
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:30:00.000Z',
      }),
    ]);

    expect(lowMileageReport.categories.mileage.score).toBe(49);
    expect(moderateMileageReport.categories.mileage.score).toBe(100);
    expect(highMileageReport.categories.mileage.score).toBe(0);
    expect(moderateMileageReport.categories.mileage.score).toBeGreaterThan(lowMileageReport.categories.mileage.score);
    expect(moderateMileageReport.categories.mileage.score).toBeGreaterThan(highMileageReport.categories.mileage.score);
  });
});
