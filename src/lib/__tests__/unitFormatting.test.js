import { describe, expect, it } from 'vitest';
import {
  convertDistanceKm,
  convertPerDistanceRate,
  convertSpeedKmh,
  distanceUnitLabel,
  formatDistanceMeters,
  formatDistanceScope,
  formatPerDistanceRate,
  speedUnitLabel,
} from '@/lib/unitFormatting';

describe('unitFormatting', () => {
  it('keeps metric values unchanged and labels them explicitly', () => {
    expect(convertDistanceKm(295.2, 'metric')).toBe(295.2);
    expect(convertSpeedKmh(100, 'metric')).toBe(100);
    expect(distanceUnitLabel('metric')).toBe('km');
    expect(speedUnitLabel('metric')).toBe('km/h');
    expect(formatDistanceScope(295.2, 'metric')).toBe('295.2 km');
  });

  it('converts imperial distance and speed from canonical metric storage', () => {
    expect(convertDistanceKm(10, 'imperial')).toBeCloseTo(6.21371, 5);
    expect(convertSpeedKmh(100, 'imperial')).toBeCloseTo(62.1371, 4);
    expect(distanceUnitLabel('imperial')).toBe('mi');
    expect(speedUnitLabel('imperial')).toBe('mph');
    expect(formatDistanceScope(295.2, 'imperial')).toBe('183.4 mi');
  });

  it('formats short meter-based map distances in the selected units', () => {
    expect(formatDistanceMeters(150, 'metric')).toBe('150 m');
    expect(formatDistanceMeters(150, 'imperial')).toBe('492 ft');
    expect(formatDistanceMeters(1609.344, 'imperial')).toBe('1.0 mi');
  });

  it('converts normalized rates without changing their meaning', () => {
    expect(convertPerDistanceRate(2, 'imperial')).toBeCloseTo(3.218689, 6);
    expect(formatPerDistanceRate(2, 'metric')).toBe('2.0 / 100 km');
    expect(formatPerDistanceRate(2, 'imperial')).toBe('3.2 / 100 mi');
    expect(formatPerDistanceRate(0.5, 'metric', {
      baseDistance: 10,
      suffix: 'events',
    })).toBe('0.5 events / 10 km');
  });

  it('does not turn missing values into zero', () => {
    expect(convertDistanceKm(null, 'metric')).toBeNull();
    expect(formatPerDistanceRate(undefined, 'metric')).toBe('Unavailable');
  });
});
