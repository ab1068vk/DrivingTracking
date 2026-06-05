export const round = (value, digits = 3) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const finiteNumber = (value, fallback = null) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function mean(values = []) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

export function percentile(values = [], pct, fallback = null) {
  const usable = values
    .map((value) => finiteNumber(value))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (!usable.length) return fallback;

  const index = clamp((usable.length - 1) * pct, 0, usable.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return usable[lower];
  return usable[lower] + (usable[upper] - usable[lower]) * (index - lower);
}

export function pearsonCorrelation(pairs = []) {
  if (pairs.length < 2) return null;

  const xs = pairs.map((pair) => pair.x);
  const ys = pairs.map((pair) => pair.y);
  const xMean = mean(xs);
  const yMean = mean(ys);
  if (xMean == null || yMean == null) return null;

  const numerator = pairs.reduce((sum, pair) => sum + ((pair.x - xMean) * (pair.y - yMean)), 0);
  const xVariance = pairs.reduce((sum, pair) => sum + ((pair.x - xMean) ** 2), 0);
  const yVariance = pairs.reduce((sum, pair) => sum + ((pair.y - yMean) ** 2), 0);
  const denominator = Math.sqrt(xVariance * yVariance);

  return denominator > 0 ? numerator / denominator : null;
}
