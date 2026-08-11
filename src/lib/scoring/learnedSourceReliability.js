/**
 * Per-user hit rates for speed-limit sources, learned from saved road knowledge.
 *
 * `SPEED_LIMIT_SOURCE_PROFILES` assigns each source a fixed confidence (0.35 to
 * 0.92). Those numbers are policy, not measurement: they never move, and they
 * describe no particular driver. Every cell in local speed knowledge already
 * carries an audit trail recording which source proposed a limit and which
 * limit the cell converged on, so the real hit rate is derivable.
 *
 * `confidenceForSource` now blends these rates into the confidence it returns,
 * so the measurement is what scoring, alert margins and the speech floor act on.
 * That was held back while there was no way to make the change visible —
 * substituting learned values would have silently restated historical scores.
 * SCORING_ALGORITHM_REVISION 5 is what closed that gap: bumping it regenerates
 * SCORING_VERSION, so the rescore-mismatch machinery flags every stored trip
 * instead of leaving old assumed-confidence scores sitting beside measured ones.
 *
 * Only a source's *profile default* is replaced. A cell carrying its own
 * accumulated confidence keeps it: that is a measurement too, and a more
 * specific one than a rate averaged across every cell.
 */

/** Below this, one lucky or unlucky run would dominate, so the fixed profile stands. */
export const MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE = 5;

/**
 * Pseudo-observations held at the reference rate. Shrinkage keeps a source with
 * 6 observations from swinging to 0.0 or 1.0 on a short streak, while a source
 * with hundreds converges on what actually happened.
 */
export const SMOOTHING_STRENGTH = 8;

/** Limits are discrete; anything under this is a rounding artefact, not disagreement. */
const LIMIT_MATCH_TOLERANCE_KMH = 1;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const auditEntries = (cell) => (Array.isArray(cell?.auditTrail) ? cell.auditTrail : []);

/**
 * Aggregate every cell's audit trail into per-source agreement counts.
 *
 * An observation counts only when the entry names the source that proposed a
 * limit *and* both the proposed and converged limits are present — otherwise
 * there is nothing to agree or disagree with.
 *
 * @param {Array} cells Saved speed-knowledge cells.
 * @returns {Object<string, {observations:number, agreements:number, hitRate:number}>}
 */
export function summarizeSourceReliability(cells = []) {
  const totals = {};
  (Array.isArray(cells) ? cells : []).forEach((cell) => {
    auditEntries(cell).forEach((entry) => {
      const source = entry?.pointSource;
      if (!source || typeof source !== 'string') return;
      const observed = finiteNumber(entry.observedLimitKmh);
      const converged = finiteNumber(entry.limitKmh);
      if (observed == null || converged == null) return;
      const bucket = totals[source] || { observations: 0, agreements: 0, hitRate: 0 };
      bucket.observations += 1;
      if (Math.abs(observed - converged) <= LIMIT_MATCH_TOLERANCE_KMH) bucket.agreements += 1;
      totals[source] = bucket;
    });
  });
  Object.values(totals).forEach((bucket) => {
    bucket.hitRate = bucket.observations
      ? Math.round((bucket.agreements / bucket.observations) * 1000) / 1000
      : 0;
  });
  return totals;
}

/**
 * Blend a source's learned hit rate with its fixed reference confidence.
 *
 * Below `MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE` the reference value is
 * returned unchanged rather than nudged, so a number labelled "reference" is
 * never quietly something else.
 *
 * @returns {{confidence:number, basis:'reference'|'learned', observations:number, hitRate:number|null}}
 */
export function learnedSourceConfidence(source, reliability = {}, referenceConfidence = 0) {
  const prior = Math.max(0, Math.min(1, Number(referenceConfidence) || 0));
  const stats = reliability?.[source];
  const observations = Math.max(0, Number(stats?.observations) || 0);
  if (observations < MIN_OBSERVATIONS_FOR_LEARNED_CONFIDENCE) {
    return { confidence: prior, basis: 'reference', observations, hitRate: null };
  }
  const agreements = Math.max(0, Number(stats.agreements) || 0);
  const blended = (agreements + (SMOOTHING_STRENGTH * prior)) / (observations + SMOOTHING_STRENGTH);
  return {
    confidence: Math.max(0, Math.min(1, Math.round(blended * 1000) / 1000)),
    basis: 'learned',
    observations,
    hitRate: Number(stats.hitRate) || 0,
  };
}

/**
 * One-line description for the UI. Returns null when there is nothing learned
 * yet, so callers render the reference wording rather than an empty claim.
 */
export function describeLearnedSourceConfidence(result) {
  if (!result || result.basis !== 'learned') return null;
  const percent = Math.round((result.hitRate ?? 0) * 100);
  return `Matched your confirmed limits ${percent}% of the time across ${result.observations} observations.`;
}
