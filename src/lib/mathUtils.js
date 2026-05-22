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
