import { describe, expect, it } from 'vitest';
import { clamp } from '@/lib/mathUtils';

describe('mathUtils clamp', () => {
  it('returns the minimum for NaN input', () => {
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it('keeps inclusive boundary values', () => {
    expect(clamp(100, 0, 100)).toBe(100);
    expect(clamp(-1, 0, 100)).toBe(0);
  });
});
