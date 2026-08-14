/**
 * "You have braked hard here before" — and the evidence that earns saying it.
 *
 * The evidence is the driver's own route-risk segment, which already records
 * what is needed: `tripCount` (de-duplicated per trip when the index is built,
 * so it really is passes through the cell, not samples), `avgSpeed` (their
 * typical speed there), `harshCount`, and the `eventTypes` breakdown.
 *
 * The alert key is `late_braking_pattern`, not `curve_entry`. Nothing in this
 * pipeline detects curvature: the observation is repeated hard braking at a
 * location, and calling that a curve would be an unverified claim of exactly the
 * kind the old "N m ahead" wording was. The copy states the counts it is built
 * from so the driver can judge it.
 *
 * Gate 3 is what makes this advice rather than nagging. It fires only when the
 * approach is faster than the driver's *own* recorded typical entry, so someone
 * who has learned the corner stops hearing about it without any decay logic.
 *
 * `limitKmh` is accepted and carried into the evidence, but is not yet a gate:
 * a posted limit is only available with the corridor graph, which is deferred.
 */
import { clamp } from '@/lib/mathUtils';
import {
  HAZARD_CURVE_MIN_CONFIDENCE,
  HAZARD_CURVE_MIN_EVENT_RATE,
  HAZARD_CURVE_MIN_PASSES,
  HAZARD_CURVE_SPEED_MARGIN_KMH,
} from '@/lib/appConstants';

/**
 * Note that the confidence gate, not the pass/rate floors, is what usually
 * decides. A segment sitting exactly on both floors (5 passes, 40%) scores 0.33
 * and stays quiet; the floors are necessary, confidence is sufficient. That is
 * deliberate — the first thing this feature says about a specific corner should
 * be something the driver recognises.
 */

/** Rate at which confidence saturates: twice the qualifying rate is as sure as this gets. */
const FULL_CONFIDENCE_EVENT_RATE = HAZARD_CURVE_MIN_EVENT_RATE * 1.5;
/** Passes at which sample size stops adding confidence. */
const FULL_CONFIDENCE_PASSES = HAZARD_CURVE_MIN_PASSES * 2;

const finiteOr = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * Number(null) and Number('') are both 0, so a missing posted limit would read
 * as a limit of zero. Same trap the speed alert gate documents.
 */
const numericOrNull = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const ineligible = (reason, extra = {}) => ({
  eligible: false,
  reason,
  confidence: 0,
  passes: 0,
  brakingPasses: 0,
  harshRate: 0,
  typicalEntryKmh: 0,
  overTypicalKmh: 0,
  dominantType: null,
  limitKmh: null,
  ...extra,
});

/**
 * @param {{segment: any, approachSpeedKmh: number, limitKmh?: number|null}} input
 * @returns {{eligible: boolean, reason: string, confidence: number, passes: number,
 *            brakingPasses: number, harshRate: number, typicalEntryKmh: number,
 *            overTypicalKmh: number, dominantType: string|null, limitKmh: number|null}}
 */
export function buildCurveEntryAdvisory({ segment, approachSpeedKmh, limitKmh = null } = {}) {
  if (!segment) return ineligible('no_segment');

  const passes = Math.round(finiteOr(segment.tripCount));
  if (passes < HAZARD_CURVE_MIN_PASSES) return ineligible('insufficient_passes', { passes });

  const eventTypes = segment.eventTypes || {};
  // `harshCount` on a route-risk segment counts harsh braking only. Sharp turns
  // at the same cell are the same story told by a different detector.
  const brakingPasses = Math.min(
    passes,
    Math.round(finiteOr(segment.harshCount) + finiteOr(eventTypes.sharp_turn))
  );
  const harshRate = brakingPasses / passes;
  if (harshRate < HAZARD_CURVE_MIN_EVENT_RATE) {
    return ineligible('event_rate_below_floor', { passes, brakingPasses, harshRate });
  }

  const typicalEntryKmh = finiteOr(segment.avgSpeed);
  const approach = finiteOr(approachSpeedKmh);
  const overTypicalKmh = approach - typicalEntryKmh;
  if (overTypicalKmh < HAZARD_CURVE_SPEED_MARGIN_KMH) {
    return ineligible('not_faster_than_typical', {
      passes, brakingPasses, harshRate, typicalEntryKmh, overTypicalKmh,
    });
  }

  const confidence = clamp(passes / FULL_CONFIDENCE_PASSES, 0, 1) *
    clamp(harshRate / FULL_CONFIDENCE_EVENT_RATE, 0, 1);
  const evidence = {
    passes,
    brakingPasses,
    harshRate,
    typicalEntryKmh,
    overTypicalKmh,
    dominantType: finiteOr(eventTypes.sharp_turn) > finiteOr(segment.harshCount)
      ? 'sharp_turn'
      : 'harsh_brake',
    limitKmh: numericOrNull(limitKmh),
  };
  if (confidence < HAZARD_CURVE_MIN_CONFIDENCE) {
    return ineligible('low_confidence', { ...evidence, confidence });
  }

  return { eligible: true, reason: 'eligible', confidence, ...evidence };
}
