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
 *
 * ---
 *
 * **UNKNOWN is not ZERO.** A first correction of DPD-017 added a carve-out: if
 * `tripCount === 0` the population must be genuinely empty, because the most
 * recent N of a non-empty history is never empty, so state it plainly rather
 * than hedging "at least 0". That reasoning was wrong, and the failure was
 * reachable on every cold launch. `dashboardActivity` always returns an object;
 * while its queries are pending every field folds through
 * `Number(undefined) || 0` to `0`, and there is no loading gate. The card
 * therefore rendered "All-time totals / Everything recorded on this device"
 * over `0` trips on a device holding 500 - a 100% understatement asserted as
 * complete.
 *
 * The premise conflated *the source answered, and the answer is none* with
 * *the source has not answered*. A pending query, a refused query and a
 * genuinely empty history are three different facts that all arrive as `0`.
 *
 * So emptiness is never inferred from a count. Completeness is a claim a
 * surface may make ONLY when an authoritative signal says the population was
 * both **answered** and **complete**, and the four states are distinguished:
 *
 *  - `UNKNOWN`     - not answered yet. Claims nothing. Values, if shown at all,
 *                    are floors, which are never false.
 *  - `PARTIAL`     - answered, incomplete. Hedged.
 *  - `VERIFIED`    - answered and complete. Complete wording allowed, and a
 *                    genuine zero may be stated plainly as the whole truth.
 *  - `UNAVAILABLE` - refused. Says so, and claims nothing about the driving.
 *
 * Every helper below is written so that **only `VERIFIED` unlocks a complete
 * claim**. A state added later therefore defaults to the cautious branch rather
 * than silently inheriting the confident one, which is precisely how the
 * carve-out went wrong.
 */

/** @typedef {'VERIFIED'|'PARTIAL'|'UNKNOWN'|'UNAVAILABLE'} ScopeState */

export const SCOPE_STATE = Object.freeze({
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  UNKNOWN: 'UNKNOWN',
  UNAVAILABLE: 'UNAVAILABLE',
});

/**
 * @param {{answered?: boolean, exact?: boolean, unavailable?: unknown}} [input]
 * @returns {ScopeState}
 *
 * `answered` defaults to `true` so callers whose source cannot be pending keep
 * their existing two-state behaviour; a surface whose source can be absent must
 * pass it explicitly, from the raw signal rather than from a collapsed count.
 */
export function scopeStateOf({ answered = true, exact = false, unavailable = null } = {}) {
  // A refusal is its own state and wins over everything else: a number nobody
  // could obtain is not a complete number, and it is not a partial one either.
  if (unavailable) return SCOPE_STATE.UNAVAILABLE;
  // Absence outranks exactness. An `exact` flag computed over a source that has
  // not answered describes nothing.
  if (answered !== true) return SCOPE_STATE.UNKNOWN;
  return exact ? SCOPE_STATE.VERIFIED : SCOPE_STATE.PARTIAL;
}

/** The ONE gate for any complete-population claim. */
export const isCompleteScope = (state) => state === SCOPE_STATE.VERIFIED;

export const isPartialScope = (state) => state === SCOPE_STATE.PARTIAL;

export const isUnknownScope = (state) => state === SCOPE_STATE.UNKNOWN;

/**
 * Combine the scopes of several populations shown under one heading, taking the
 * most cautious. A card that folds an exact lifetime count together with a
 * bounded window may not describe the pair as complete.
 */
export function weakestScope(...states) {
  const rank = {
    [SCOPE_STATE.UNAVAILABLE]: 0,
    [SCOPE_STATE.UNKNOWN]: 1,
    [SCOPE_STATE.PARTIAL]: 2,
    [SCOPE_STATE.VERIFIED]: 3,
  };
  const flat = states.flat().filter(Boolean);
  if (!flat.length) return SCOPE_STATE.UNKNOWN;
  return flat.reduce((worst, state) => (
    (rank[state] ?? 1) < (rank[worst] ?? 1) ? state : worst
  ));
}

/**
 * An additive total over an incomplete or unanswered population, stated as the
 * floor it is. A floor is never false, which is the whole reason it is the
 * default for everything except a verified population and an outright refusal,
 * where there is no floor to state.
 */
export function atLeastTotal(text, state) {
  const value = String(text ?? '');
  if (isCompleteScope(state) || state === SCOPE_STATE.UNAVAILABLE) return value;
  return `at least ${value}`;
}

/** A sublabel for a mean, which an incomplete population makes an estimate rather than a floor. */
export function meanScopeSublabel(text, state) {
  if (isUnknownScope(state)) return 'not counted yet';
  if (isPartialScope(state)) return 'over trips counted so far';
  return String(text ?? '');
}

/**
 * The lifetime-totals heading. Never claims "all time" over a bounded window,
 * and never over a source that has not answered.
 */
export function allTimeHeading(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) return 'Totals unavailable';
  if (isUnknownScope(state)) return 'Preparing totals';
  return isCompleteScope(state) ? 'All-time totals' : 'Totals so far';
}

/** The caption under that heading. */
export function allTimeCaption(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) {
    return 'Your totals could not be read. Your saved trips were not changed.';
  }
  if (isUnknownScope(state)) return 'Your lifetime totals are still being prepared';
  return isCompleteScope(state)
    ? 'Everything recorded on this device'
    : 'Still counting everything recorded on this device';
}

/** The "all time" sublabel a single metric carries under the heading. */
export function allTimeMetricScope(state) {
  if (isUnknownScope(state)) return 'not counted yet';
  return isCompleteScope(state) ? 'all time' : 'counted so far';
}

/**
 * The note a per-vehicle figure carries while the fleet ledger is unconverged.
 * `null` when the figures are complete, so a verified page stays uncluttered.
 */
export function vehicleScopeNote(state) {
  if (state === SCOPE_STATE.UNAVAILABLE) {
    return 'Per-vehicle totals could not be read. Your saved trips were not changed.';
  }
  if (isCompleteScope(state)) return null;
  return 'Counted from the drives read so far - history beyond the recent list has not been added yet.';
}
