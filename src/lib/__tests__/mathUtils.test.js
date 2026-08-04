import { describe, expect, it } from 'vitest';
import { clamp, eventRatePerDistance, pearsonCorrelation } from '@/lib/mathUtils';

describe('mathUtils clamp', () => {
  it('returns the minimum for NaN input', () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it('keeps inclusive boundary values', () => {
    expect(clamp(100, 0, 100)).toBe(100);
    expect(clamp(-1, 0, 100)).toBe(0);
  });
});

describe('mathUtils eventRatePerDistance', () => {
  it('uses real distance so short trips are not understated', () => {
    // A 1 km normalization floor would report this as 20 per 10 km.
    expect(eventRatePerDistance(2, 0.3)).toBeCloseTo(66.7, 1);
  });

  it('matches the plain rate for distances over a kilometre', () => {
    expect(eventRatePerDistance(4, 20)).toBe(2);
  });

  it('falls back to a one kilometre denominator when distance is missing or zero', () => {
    expect(eventRatePerDistance(3, 0)).toBe(30);
    expect(eventRatePerDistance(3, null)).toBe(30);
    expect(eventRatePerDistance(3, NaN)).toBe(30);
  });

  it('returns zero for a non-numeric count', () => {
    expect(eventRatePerDistance(undefined, 10)).toBe(0);
  });
});

describe('mathUtils pearsonCorrelation', () => {
  it('calculates correlation for paired finite samples', () => {
    expect(pearsonCorrelation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearsonCorrelation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1);
  });

  it('returns zero for insufficient or flat samples', () => {
    expect(pearsonCorrelation([1], [2])).toBe(0);
    expect(pearsonCorrelation([1, 1, 1], [2, 3, 4])).toBe(0);
  });
});
