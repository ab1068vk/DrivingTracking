import { scoringValue } from '@/lib/scoringConstants';

/**
 * Severity classification for detected driving events.
 *
 * Every magnitude-style event (harsh brake, rapid acceleration, idle, stop-start,
 * close-proximity manoeuvre) is classified against MULTIPLES of the trigger threshold
 * that actually produced it, rather than against absolute literals. That keeps the
 * severity mix responsive to user calibration: raising the harsh-braking threshold
 * raises the medium/high boundaries with it instead of promoting every surviving
 * event to "high".
 *
 * Sharp turns are not handled here — they already classify against their own
 * SHARP_TURN_G_MEDIUM / SHARP_TURN_G_HIGH settings.
 */

export const SEVERITY_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const SEVERITY_ORDER = Object.freeze([
  SEVERITY_LEVELS.LOW,
  SEVERITY_LEVELS.MEDIUM,
  SEVERITY_LEVELS.HIGH,
]);

const finiteOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Resolve the medium/high multipliers registered for an event type.
 * @param {string} eventType
 * @returns {{medium: number, high: number}|null}
 */
export function severityBandsForEvent(eventType) {
  const bands = scoringValue('EVENT_SEVERITY_BAND_MULTIPLIERS')?.[eventType];
  const medium = finiteOrNull(bands?.medium);
  const high = finiteOrNull(bands?.high);
  if (medium == null || high == null || medium <= 0 || high <= 0) return null;
  // A misconfigured pair where high <= medium would make "medium" unreachable.
  return { medium, high: Math.max(high, medium) };
}

/**
 * Classify a magnitude against its own trigger threshold.
 *
 * @param {number} value Observed magnitude, in the same unit as the threshold.
 *   Callers pass an absolute value; sign is ignored so deceleration and
 *   acceleration share one code path.
 * @param {number} triggerThreshold The threshold that caused this event to fire.
 * @param {string} eventType Key into EVENT_SEVERITY_BAND_MULTIPLIERS.
 * @returns {'low'|'medium'|'high'}
 */
export function classifyMagnitudeSeverity(value, triggerThreshold, eventType) {
  const magnitude = Math.abs(finiteOrNull(value) ?? 0);
  const threshold = finiteOrNull(triggerThreshold);
  const bands = severityBandsForEvent(eventType);

  // A non-positive threshold means detection itself is degenerate (everything
  // fires). Reporting "high" for all of it would be actively misleading, so the
  // event is kept at the floor and the caller's own gating decides visibility.
  if (bands == null || threshold == null || threshold <= 0) return SEVERITY_LEVELS.LOW;

  if (magnitude >= threshold * bands.high) return SEVERITY_LEVELS.HIGH;
  if (magnitude >= threshold * bands.medium) return SEVERITY_LEVELS.MEDIUM;
  return SEVERITY_LEVELS.LOW;
}

/**
 * Classify a speeding event.
 *
 * With a known limit the bands are absolute km/h margins above it. Without one the
 * bands are multiples of the configured fallback speeding threshold, so a user who
 * raises that threshold also raises the point at which unlimited-road speeding is
 * called severe.
 *
 * @param {number} speedKmh Peak speed observed in the speeding window.
 * @param {number|null} limitKmh Applicable posted or inferred limit, if any.
 * @param {object} thresholds Resolved driving thresholds.
 * @returns {'low'|'medium'|'high'}
 */
export function classifySpeedingSeverity(speedKmh, limitKmh = null, thresholds = {}) {
  const speed = finiteOrNull(speedKmh);
  if (speed == null) return SEVERITY_LEVELS.LOW;

  const limit = finiteOrNull(limitKmh);
  if (limit != null && limit > 0) {
    const highOver = finiteOrNull(scoringValue('SPEEDING_SEVERITY_HIGH_OVER_KMH')) ?? 30;
    const mediumOver = finiteOrNull(scoringValue('SPEEDING_SEVERITY_MEDIUM_OVER_KMH')) ?? 20;
    if (speed > limit + highOver) return SEVERITY_LEVELS.HIGH;
    if (speed > limit + mediumOver) return SEVERITY_LEVELS.MEDIUM;
    return SEVERITY_LEVELS.LOW;
  }

  const fallbackKmh = finiteOrNull(thresholds?.SPEEDING_FALLBACK_KMH)
    ?? finiteOrNull(scoringValue('SPEEDING_FALLBACK_KMH'))
    ?? 100;
  if (fallbackKmh <= 0) return SEVERITY_LEVELS.LOW;
  const highMultiplier = finiteOrNull(scoringValue('SPEEDING_SEVERITY_NO_LIMIT_HIGH_MULTIPLIER')) ?? 1.6;
  const mediumMultiplier = finiteOrNull(scoringValue('SPEEDING_SEVERITY_NO_LIMIT_MEDIUM_MULTIPLIER')) ?? 1.4;
  if (speed > fallbackKmh * highMultiplier) return SEVERITY_LEVELS.HIGH;
  if (speed > fallbackKmh * mediumMultiplier) return SEVERITY_LEVELS.MEDIUM;
  return SEVERITY_LEVELS.LOW;
}

/**
 * Shift a severity by whole bands, clamped to the low/high ends.
 * Used by the IMU refinement pass to downgrade GPS events the motion data contradicts.
 * @param {string} severity
 * @param {number} steps Negative to downgrade, positive to upgrade.
 * @returns {'low'|'medium'|'high'}
 */
export function shiftSeverity(severity, steps) {
  const index = SEVERITY_ORDER.indexOf(severity);
  if (index < 0) return SEVERITY_LEVELS.LOW;
  const shift = Number.isFinite(Number(steps)) ? Math.trunc(Number(steps)) : 0;
  const next = Math.min(SEVERITY_ORDER.length - 1, Math.max(0, index + shift));
  return SEVERITY_ORDER[next];
}
