// A staged road window normally contains only a few points. Keep exact values
// for at most one small window at a time, in its encrypted window payload.
// Larger windows retain the bounded radix selector.
export const MAX_DIRECT_ROAD_WINDOW_POINTS = 256;

export const maySelectRoadWindowDirectly = (summary) => (
  Number.isInteger(Number(summary?.usableCount))
  && Number(summary.usableCount) >= 0
  && Number(summary.usableCount) <= MAX_DIRECT_ROAD_WINDOW_POINTS
);

const bitView = new DataView(new ArrayBuffer(8));
const positiveBitPattern = (value) => {
  bitView.setFloat64(0, Number(value), false);
  return bitView.getBigUint64(0, false);
};

// The old radix selector orders the raw IEEE-754 bits. Preserve that ordering
// exactly, including -0 versus +0, rather than relying on numeric Array.sort.
const exactRank = (values, rank) => values[rank]?.value;
const sortedByLegacyBits = (values) => values.map((value) => ({
  value,
  bits: positiveBitPattern(value),
})).sort((a, b) => (a.bits < b.bits ? -1 : a.bits > b.bits ? 1 : 0));

const percentile = (ordered, count, ratio) => {
  const index = (count - 1) * ratio;
  const floor = Math.floor(index);
  const lower = exactRank(ordered, floor);
  const upper = exactRank(ordered, Math.ceil(index));
  return lower + (upper - lower) * (index - floor);
};

export const exactRoadWindowStatistics = (summary, values) => {
  const speeds = sortedByLegacyBits(values.speeds || []);
  const accuracies = sortedByLegacyBits(values.accuracies || []);
  return {
    p85Kmh: percentile(speeds, Number(summary.speedCount), 0.85),
    medianKmh: percentile(speeds, Number(summary.speedCount), 0.5),
    medianAccuracyM: summary.accuracyCount
      ? percentile(accuracies, Number(summary.accuracyCount), 0.5)
      : null,
    explicitEstimatedLimit: Object.entries(summary.estimatedLimitCounts || {})
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] ?? null,
  };
};
