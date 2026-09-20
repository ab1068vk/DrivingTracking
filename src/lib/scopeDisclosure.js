/**
 * DPD-017 / DPD-018 — what a surface is allowed to CALL the population it has.
 *
 * The 500-trip numerical truth audit found no arithmetic error anywhere in the
 * app. Every figure was exactly right for the rows it actually folded. What was
 * wrong was the heading above it: while `D1_ANALYTICS:all` is unconverged the
 * Dashboard serves the most-recent-200 window, and it went on calling that
 * window "All-time totals" and "Everything recorded on this device" — a 5x
 * understatement presented to the driver as the complete record of their own
 * driving. Vehicles did the same with per-vehicle totals, as bare fact.
 *
 * The product already had the right pattern: Report renders the *same* bounded
 * numbers as "at least 2892.6 km", "200 trips counted so far", "Still counting
 * this period". This module is that vocabulary, lifted out of
 * `reportPresentation.js` (which stays the Report's own AUD-003 gating) so the
 * Dashboard and Vehicles can share one wording rather than invent a third.
 *
 * Two rules decide the copy, and they are not the same rule:
 *
 *  - An **additive** total over a partial population is a FLOOR. More rows can
 *    only raise it, so "at least X" is true and stays true.
 *  - A **mean** over a partial population is NOT a floor. More rows can move it
 *    either way, so it is never prefixed "at least"; its denominator is
 *    disclosed instead.
 */

/** @typedef {'VERIFIED'|'PARTIAL'|'UNAVAILABLE'} ScopeState */

export const SCOPE_STATE = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * @param {{exact?: boolean, unavailable?: unknown}} [input]
 * @returns {ScopeState}
 */
export function scopeStateOf({ exact = false, unavailable = null } = {}) {
  // A refusal is its own state and wins over exactness: a number nobody could
  // obtain is not a complete number, and it is not a partial one either.
  if (unavailable) return SCOPE_STATE.UNAVAILABLE;
  return exact ? SCOPE_STATE.VERIFIED : SCOPE_STATE.PARTIAL;
}

export const isPartialScope = (state) => state === SCOPE_STATE.PARTIAL;

/** An additive total over a partial population, stated as the floor it is. */
export function atLeastTotal(text, state) {
  const value = String(text ?? '');
  return isPartialScope(state) ? `at least ${value}` : value;
}

/** A sublabel for a mean, which a partial population makes an estimate rather than a floor. */
export function meanScopeSublabel(text, state) {
  return isPartialScope(state) ? 'over trips counted so far' : String(text ?? '');
}

/** The lifetime-totals heading. Never claims "all time" over a bounded window. */
export function allTimeHeading(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) return 'Totals unavailable';
  return isPartialScope(state) ? 'Totals so far' : 'All-time totals';
}

/** The caption under that heading. */
export function allTimeCaption(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) {
    return 'Your totals could not be read. Your saved trips were not changed.';
  }
  return isPartialScope(state)
    ? 'Still counting everything recorded on this device'
    : 'Everything recorded on this device';
}

/** The "all time" sublabel a single metric carries under the heading. */
export function allTimeMetricScope(state) {
  return isPartialScope(state) ? 'counted so far' : 'all time';
}

/**
 * The note a per-vehicle figure carries while the fleet ledger is unconverged.
 * `null` when the figures are complete, so a verified page stays uncluttered.
 */
export function vehicleScopeNote(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) {
    return 'Per-vehicle totals could not be read. Your saved trips were not changed.';
  }
  return isPartialScope(state)
    ? 'Counted from the drives read so far — history beyond the recent list has not been added yet.'
    : null;
}
