/**
 * Clamp a numeric value to an inclusive range.
 * Invalid numeric input returns the inclusive minimum so callers never receive NaN.
 * @param {number} value - Value to constrain.
 * @param {number} min - Inclusive minimum.
 * @param {number} max - Inclusive maximum.
 * @returns {number} The constrained value.
 * @example clamp(120, 0, 100)
 */
export function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

/**
 * Convert an event count into a displayed "per N km" rate.
 * Uses the trip's real distance rather than a normalization floor, so short trips are not
 * reported at a fraction of their true rate. Non-positive distance falls back to 1 km because
 * a rate is undefined without distance travelled.
 * @param {number} count - Number of events observed.
 * @param {number} distanceKm - Distance actually travelled, in kilometres.
 * @param {number} [per=10] - Rate denominator in kilometres.
 * @returns {number} Rate rounded to one decimal place.
 * @example eventRatePerDistance(2, 0.3) // 66.7
 */
export function eventRatePerDistance(count, distanceKm, per = 10) {
  const events = Number(count);
  if (!Number.isFinite(events)) return 0;
  const distance = Number(distanceKm);
  const effectiveDistance = Number.isFinite(distance) && distance > 0 ? distance : 1;
  return Math.round((events / effectiveDistance) * per * 10) / 10;
}

/**
 * Calculate Pearson correlation for paired numeric samples.
 * Invalid pairs are discarded so callers can pass raw sensor-derived arrays.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number} Correlation in [-1, 1], or 0 when insufficient/flat.
 */
export function pearsonCorrelation(xs = [], ys = []) {
  const pairs = [];
  const count = Math.min(xs.length, ys.length);
  for (let i = 0; i < count; i++) {
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  if (pairs.length < 2) return 0;

  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  pairs.forEach(([x, y]) => {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  });
  const denominator = Math.sqrt(denomX * denomY);
  return denominator > 0 ? numerator / denominator : 0;
}
