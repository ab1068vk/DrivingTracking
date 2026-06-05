import { describe, expect, it } from 'vitest';
import { clamp, decayWeight, pearsonCorrelation } from '@/lib/mathUtils';

describe('mathUtils clamp', () => {
  it('returns the minimum for NaN input', () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it('keeps inclusive boundary values', () => {
    expect(clamp(100, 0, 100)).toBe(100);
    expect(clamp(-1, 0, 100)).toBe(0);
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

describe('mathUtils decayWeight', () => {
  it('returns 1.0 for age 0 and halves at each half-life interval', () => {
    expect(decayWeight(0)).toBeCloseTo(1.0);
    expect(decayWeight(21)).toBeCloseTo(0.5);
    expect(decayWeight(42)).toBeCloseTo(0.25);
  });
});
