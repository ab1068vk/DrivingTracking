/**
 * The set of speed limits a road plausibly carries, and how to snap a measured
 * speed onto it.
 *
 * The learner previously snapped every observation onto a metric-only ladder
 * with an unconditional nearest-value reduce. That had three consequences on a
 * mph road: 35 mph (56.3 km/h) learned as 60, 55 mph (88.5) as 90, and anything
 * outside [30, 120] was silently pulled into range. It also broke ties downward
 * because the reduce used a strict `<` seeded at index 0.
 *
 * This module fixes all three by (a) selecting the ladder from the user's units
 * or region, and (b) refusing to answer rather than guessing. An observation
 * that sits between two rungs, or too far from every rung, comes back as
 * `{ limitKmh: null, ambiguous: true }`. Callers must not let an ambiguous
 * result vote — a wrong learned limit is worse than no learned limit, because
 * it drives both the voice alert and the compliance score.
 */
import { normalizeUnits } from '@/lib/unitFormatting';

/** 30-130 km/h in 10 km/h steps: the posted ladder across metric jurisdictions. */
export const METRIC_LIMIT_LADDER_KMH = Object.freeze([30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]);

/**
 * 25-75 mph in 5 mph steps, converted and rounded to whole km/h. These are the
 * values a mph-posted road actually carries; snapping to the metric ladder
 * instead is what produced the 35 mph -> 60 km/h error.
 */
export const IMPERIAL_LIMIT_LADDER_KMH = Object.freeze([40, 48, 56, 64, 72, 80, 89, 97, 105, 113, 121]);

/**
 * How close to a rung an observation must land, as a fraction of the gap it sits
 * in. Just under half, so a near-exact midpoint reads as ambiguous rather than
 * silently resolving to whichever side floating point favoured.
 */
const DEFAULT_TOLERANCE_RATIO = 0.45;

/** Two rungs this close to equidistant are a tie, and a tie must not vote. */
const TIE_EPSILON_KMH = 0.5;

/**
 * Which ladder to snap onto.
 *
 * **Metric (km/h) is the default and the only fallback.** This deliberately
 * follows the app's `units` setting and nothing else: no region sniffing, no
 * inference from `country_code` or the speed-limit lookup country. Those fields
 * exist for other purposes and default to values like 'global', and letting them
 * quietly flip a user onto mph rungs would change what the learner records
 * without the user ever choosing it.
 *
 * A driver in a mph jurisdiction gets mph rungs by setting units to imperial,
 * which is the same switch that already controls every speed display in the app.
 */
export function speedLimitLadderUnits(settings = {}) {
  const units = typeof settings === 'string' ? settings : settings?.units;
  if (units == null || units === '') return 'metric';
  return normalizeUnits(units);
}

export function speedLimitLadderForUnits(units) {
  return normalizeUnits(units) === 'imperial' ? IMPERIAL_LIMIT_LADDER_KMH : METRIC_LIMIT_LADDER_KMH;
}

export function speedLimitLadderForSettings(settings = {}) {
  return speedLimitLadderForUnits(speedLimitLadderUnits(settings));
}

/** The gap between the nearest rung and the neighbour on the side `value` lies. */
function localGapKmh(ladder, index, value) {
  const rung = ladder[index];
  const neighbourIndex = value >= rung ? index + 1 : index - 1;
  const neighbour = ladder[neighbourIndex];
  if (neighbour !== undefined) return Math.abs(neighbour - rung);
  // Past the end of the ladder there is no gap on that side, so borrow the
  // interior one. This is what keeps an out-of-range observation from being
  // clamped onto the end rung: it still has to land within tolerance.
  const interior = ladder[value >= rung ? index - 1 : index + 1];
  return interior === undefined ? Infinity : Math.abs(interior - rung);
}

/**
 * @param {number} speedKmh Measured speed (typically a p85 over a road section).
 * @param {{units?: string, ladder?: readonly number[], toleranceKmh?: number}} [options]
 * @returns {{limitKmh: number|null, ambiguous: boolean, reason: string,
 *   nearestKmh: number|null, deltaKmh: number|null, toleranceKmh: number|null}}
 */
export function snapToSpeedLimitLadder(speedKmh, options = {}) {
  const value = Number(speedKmh);
  const ladder = options.ladder ?? speedLimitLadderForUnits(options.units);
  const miss = (reason, extra = {}) => ({
    limitKmh: null,
    ambiguous: true,
    reason,
    nearestKmh: null,
    deltaKmh: null,
    toleranceKmh: null,
    ...extra,
  });

  if (!Number.isFinite(value) || value <= 0) return miss('not_a_speed');
  if (!Array.isArray(ladder) || !ladder.length) return miss('no_ladder');

  let nearestIndex = 0;
  let nearestDelta = Infinity;
  let secondDelta = Infinity;
  ladder.forEach((rung, index) => {
    const delta = Math.abs(rung - value);
    if (delta < nearestDelta) {
      secondDelta = nearestDelta;
      nearestDelta = delta;
      nearestIndex = index;
    } else if (delta < secondDelta) {
      secondDelta = delta;
    }
  });

  const nearestKmh = ladder[nearestIndex];
  const toleranceKmh = options.toleranceKmh != null && Number.isFinite(Number(options.toleranceKmh))
    ? Number(options.toleranceKmh)
    : localGapKmh(ladder, nearestIndex, value) * DEFAULT_TOLERANCE_RATIO;

  if (Number.isFinite(secondDelta) && Math.abs(secondDelta - nearestDelta) <= TIE_EPSILON_KMH) {
    return miss('between_rungs', { nearestKmh, deltaKmh: nearestDelta, toleranceKmh });
  }
  if (nearestDelta > toleranceKmh) {
    return miss('outside_ladder', { nearestKmh, deltaKmh: nearestDelta, toleranceKmh });
  }

  return {
    limitKmh: nearestKmh,
    ambiguous: false,
    reason: 'snapped',
    nearestKmh,
    deltaKmh: nearestDelta,
    toleranceKmh,
  };
}

/**
 * Convenience for callers that only want the limit. Returns null on ambiguity —
 * it never falls back to the nearest rung, which is the whole point.
 */
export function ladderLimitKmh(speedKmh, options = {}) {
  return snapToSpeedLimitLadder(speedKmh, options).limitKmh;
}

/** True when `limitKmh` is itself a rung of the given ladder. */
export function isLadderLimit(limitKmh, options = {}) {
  const ladder = options.ladder ?? speedLimitLadderForUnits(options.units);
  return ladder.includes(Number(limitKmh));
}
