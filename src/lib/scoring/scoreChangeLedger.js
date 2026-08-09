/**
 * Per-trip record of how a re-score moved the numbers.
 *
 * `score_provenance_change` already records *why* a re-score ran and which
 * constants changed, but never the before/after values — so confirming a speed
 * limit or marking an event wrong gave the user no evidence that their input
 * did anything. This ledger closes that loop.
 *
 * Deltas are derived from `component_scores`, which is the one keyed structure
 * carrying every component (including overall/safety/smoothness). Only changed
 * components are stored, and the ledger is capped, because trips live in
 * IndexedDB and an uncapped history would grow without bound.
 */

export const SCORE_CHANGE_LEDGER_VERSION = 1;

/** Keeps the stored history bounded; the UI only ever shows the newest few. */
export const MAX_SCORE_CHANGE_ENTRIES = 10;

/** Below this, a delta is rounding noise rather than a change worth claiming. */
const MIN_REPORTABLE_DELTA = 0.5;

const finiteScore = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const componentValue = (componentScores, key) => {
  const component = componentScores?.[key];
  if (component == null) return null;
  // Components are `{value, evidence, ...}` but legacy rows stored a bare number.
  return finiteScore(typeof component === 'object' ? component.value : component);
};

const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Compare two `component_scores` maps.
 *
 * A component that gained or lost a value (null -> number) is a real change and
 * is reported with a null on the missing side rather than being silently
 * dropped or coerced to zero.
 *
 * @returns {Array<{key:string, from:number|null, to:number|null, delta:number|null}>}
 */
export function diffComponentScores(previousScores = {}, nextScores = {}) {
  const keys = new Set([
    ...Object.keys(previousScores && typeof previousScores === 'object' ? previousScores : {}),
    ...Object.keys(nextScores && typeof nextScores === 'object' ? nextScores : {}),
  ]);
  const changes = [];
  keys.forEach((key) => {
    const from = componentValue(previousScores, key);
    const to = componentValue(nextScores, key);
    if (from == null && to == null) return;
    if (from != null && to != null) {
      const delta = to - from;
      if (Math.abs(delta) < MIN_REPORTABLE_DELTA) return;
      changes.push({ key, from: round1(from), to: round1(to), delta: round1(delta) });
      return;
    }
    changes.push({
      key,
      from: from == null ? null : round1(from),
      to: to == null ? null : round1(to),
      delta: null,
    });
  });
  // Largest movement first; appearing/disappearing components sort last since
  // they have no magnitude to rank by.
  return changes.sort((a, b) => {
    if (a.delta == null && b.delta == null) return a.key.localeCompare(b.key);
    if (a.delta == null) return 1;
    if (b.delta == null) return -1;
    return Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key);
  });
}

/**
 * Build one ledger entry, or null when nothing moved.
 *
 * @param {Object} args
 * @param {Object} args.previousTrip Trip as stored before re-scoring.
 * @param {Object} args.nextTrip Trip after re-scoring.
 * @param {string} args.reason Matches `score_provenance_change.reason`.
 * @param {Array<string>} args.changedConstants Constants that moved, if any.
 * @param {string} args.at ISO timestamp; pass the score's own `computed_at`.
 */
export function buildScoreChangeEntry({
  previousTrip = {},
  nextTrip = {},
  reason = 'user_requested_rescore',
  changedConstants = [],
  at = new Date().toISOString(),
} = {}) {
  const changes = diffComponentScores(previousTrip.component_scores, nextTrip.component_scores);
  if (!changes.length) return null;
  const overall = changes.find((change) => change.key === 'overall') || null;
  return {
    at,
    reason,
    changed_constants: Array.isArray(changedConstants) ? changedConstants.slice(0, 12) : [],
    overall_delta: overall?.delta ?? null,
    // Cap the stored breakdown: a trip has ~30 components and the UI shows a
    // handful, so persisting every one of them per re-score is dead weight.
    changes: changes.slice(0, 8),
  };
}

/**
 * Append an entry, newest first, keeping the history bounded.
 */
export function appendScoreChangeEntry(ledger, entry, { limit = MAX_SCORE_CHANGE_ENTRIES } = {}) {
  const existing = Array.isArray(ledger) ? ledger : [];
  if (!entry) return existing.slice(0, limit);
  return [entry, ...existing].slice(0, limit);
}
