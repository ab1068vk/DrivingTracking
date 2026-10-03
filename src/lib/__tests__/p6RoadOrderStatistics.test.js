import { describe, expect, it } from 'vitest';
import {
  exactRoadWindowStatistics,
  maySelectRoadWindowDirectly,
  MAX_DIRECT_ROAD_WINDOW_POINTS,
} from '@/lib/p6RoadOrderStatistics';

// Candidate #14's 64-bit selector, retained as an independent output oracle.
const bitsFor = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number(value), false);
  return view.getBigUint64(0, false).toString(2).padStart(64, '0');
};
const valueForBits = (bits) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0b${bits}`), false);
  return view.getFloat64(0, false);
};
const radixRank = (values, rank) => {
  let remainingRank = rank;
  let prefix = '';
  for (let bit = 0; bit < 64; bit += 1) {
    const zeroCount = values.filter((value) => {
      const bits = bitsFor(value);
      return bits.startsWith(prefix) && bits[bit] === '0';
    }).length;
    const chooseZero = remainingRank < zeroCount;
    prefix += chooseZero ? '0' : '1';
    if (!chooseZero) remainingRank -= zeroCount;
  }
  return valueForBits(prefix);
};
const oldPercentile = (values, count, ratio) => {
  const index = (count - 1) * ratio;
  const lower = radixRank(values, Math.floor(index));
  const upper = radixRank(values, Math.ceil(index));
  return lower + (upper - lower) * (index - Math.floor(index));
};
const oldStatistics = (summary, values) => ({
  p85Kmh: oldPercentile(values.speeds, summary.speedCount, 0.85),
  medianKmh: oldPercentile(values.speeds, summary.speedCount, 0.5),
  medianAccuracyM: summary.accuracyCount
    ? oldPercentile(values.accuracies, summary.accuracyCount, 0.5) : null,
  explicitEstimatedLimit: Object.entries(summary.estimatedLimitCounts || {})
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] ?? null,
});

const fixture = (seed, pointCount = 12) => {
  const speeds = Array.from({ length: pointCount }, (_, index) =>
    32 + ((seed * 17 + index * 23) % 67) + (index % 5) * 0.125);
  const accuracies = Array.from({ length: pointCount }, (_, index) =>
    ((seed * 3 + index * 7) % 15) + (index % 3) * 0.25);
  const summary = { speedCount: speeds.length, accuracyCount: accuracies.length,
    usableCount: pointCount, estimatedLimitCounts: { 50: 3, 60: 3, 70: 1 } };
  return { summary, values: { speeds, accuracies } };
};

describe('DPD-052 bounded exact road-window selection', () => {
  it('keeps candidate #14 order-statistic output over 10 to 1,000 windows', () => {
    for (const windowCount of [10, 50, 100, 250, 477, 1000]) {
      for (let ordinal = 0; ordinal < windowCount; ordinal += 1) {
        const { summary, values } = fixture(ordinal);
        expect(exactRoadWindowStatistics(summary, values)).toEqual(oldStatistics(summary, values));
      }
    }
  }, 180_000);

  it('preserves raw IEEE bit ordering, including signed zero accuracy', () => {
    const values = { speeds: [5, 7, 8, 9], accuracies: [-0, 0, 2, 4] };
    const summary = { speedCount: 4, accuracyCount: 4, usableCount: 4,
      estimatedLimitCounts: {} };
    expect(exactRoadWindowStatistics(summary, values)).toEqual(oldStatistics(summary, values));
  });

  it('keeps the per-window accumulator bounded', () => {
    expect(maySelectRoadWindowDirectly({ usableCount: MAX_DIRECT_ROAD_WINDOW_POINTS })).toBe(true);
    expect(maySelectRoadWindowDirectly({ usableCount: MAX_DIRECT_ROAD_WINDOW_POINTS + 1 })).toBe(false);
  });
});
