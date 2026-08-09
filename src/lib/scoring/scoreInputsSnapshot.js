/**
 * Frozen record of the inputs a trip was actually scored from.
 *
 * Trip Detail used to re-resolve every route point at render time against the
 * *current* settings, so changing a Settings dropdown silently rewrote panels
 * that claimed to describe the stored score. This snapshot is built once, at
 * scoring time, from the same per-point resolution the score itself consumed,
 * and is persisted on the trip.
 *
 * Design rules:
 * - Store raw counts, never percentages or user-facing labels. Percentages are
 *   presentation and are derived in the UI from these counts, so copy changes
 *   and unit switches never require a rescore, while the underlying facts stay
 *   frozen.
 * - Store the denominator scoring actually used. Compliance evaluates points
 *   whose reliable speed is above STATIONARY_SPEED_KMH — not "all valid points"
 *   and not "speed_kmh > 1". Recording it is what lets every panel agree.
 */

export const SCORE_INPUTS_VERSION = 1;

/** The denominator `calculateSpeedLimitCompliance` evaluates against. */
export const SCORED_SAMPLE_BASIS = 'moving_above_stationary_threshold';

/**
 * `Number(null)` is 0 and `Number('')` is 0, both finite — coercing blindly
 * turns a missing value into a real one. Reject the empty forms first.
 */
const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const isPlacedPoint = (point) => (
  finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null
);

/**
 * Region-derived sources are bucketed per country because "UK fallback estimate"
 * and "France fallback estimate" are different claims the UI renders as separate
 * rows.
 */
const REGION_SCOPED_SOURCES = new Set(['osm_highway_default', 'region_default_estimate']);

const bucketKey = (source, countryKey) => (
  REGION_SCOPED_SOURCES.has(source) ? `${source}:${countryKey}` : source
);

/**
 * @param {Object} args
 * @param {Array} args.points Route points, index-aligned with the arrays below.
 * @param {Array} args.speedLimitContexts Per-point output of resolveEffectiveSpeedLimitForIndex.
 * @param {Array<number>} args.scoredPointIndexes Indexes compliance actually scored.
 * @param {Array<string>} args.roadTypesByPoint Per-point road classification.
 * @param {number} args.stationarySpeedKmh Recorded for display; the cutoff compliance applied.
 * @param {string} args.fallbackCountry Region profile in force when scoring ran.
 * @param {string} args.computedAt ISO timestamp; pass the score's own timestamp.
 */
export function buildScoreInputsSnapshot({
  points = [],
  speedLimitContexts = [],
  scoredPointIndexes = [],
  roadTypesByPoint = [],
  stationarySpeedKmh = 5,
  fallbackCountry = 'global',
  computedAt = new Date().toISOString(),
} = {}) {
  const list = Array.isArray(points) ? points : [];
  const buckets = new Map();
  const roadTypeCounts = {};
  let scoredSampleCount = 0;
  let placedPointCount = 0;
  let limitResolvedCount = 0;

  list.forEach((point) => {
    if (isPlacedPoint(point)) placedPointCount += 1;
  });

  // Taking the indexes compliance reported, rather than re-deriving them, is
  // what makes this snapshot's denominator identical to the score's by
  // construction instead of by matching predicates in two places.
  (Array.isArray(scoredPointIndexes) ? scoredPointIndexes : []).forEach((index) => {
    const point = list[index];
    if (!point) return;
    scoredSampleCount += 1;

    const roadType = roadTypesByPoint[index] || 'urban';
    roadTypeCounts[roadType] = (roadTypeCounts[roadType] || 0) + 1;

    const context = speedLimitContexts[index] || {};
    const source = context.limitSource || 'unknown';
    const countryKey = String(
      context.speedLimitDefaultCountry ||
      point?.speed_limit_default_country ||
      point?.fallback_country ||
      fallbackCountry ||
      'global'
    ).toLowerCase();
    const key = bucketKey(source, countryKey);
    const bucket = buckets.get(key) || {
      key,
      source,
      country_key: countryKey,
      count: 0,
      limits: new Set(),
      confidence_sum: 0,
    };
    bucket.count += 1;
    bucket.confidence_sum += finiteNumber(context.confidence) ?? 0;
    const limit = finiteNumber(context.effectiveLimitKmh ?? context.limitKmh);
    if (limit != null) bucket.limits.add(Math.round(limit));
    if (finiteNumber(context.actualLimitKmh) != null) limitResolvedCount += 1;
    buckets.set(key, bucket);
  });

  const sources = [...buckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      source: bucket.source,
      country_key: bucket.country_key,
      count: bucket.count,
      limits: [...bucket.limits].sort((a, b) => a - b),
      confidence_sum: Math.round(bucket.confidence_sum * 1000) / 1000,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    version: SCORE_INPUTS_VERSION,
    computed_at: computedAt,
    sample_basis: SCORED_SAMPLE_BASIS,
    stationary_speed_kmh: stationarySpeedKmh,
    // The one denominator every speed-limit panel must divide by.
    scored_sample_count: scoredSampleCount,
    placed_point_count: placedPointCount,
    total_point_count: list.length,
    limit_resolved_count: limitResolvedCount,
    fallback_country: String(fallbackCountry || 'global').toLowerCase(),
    speed_limit_sources: sources,
    road_type_counts: roadTypeCounts,
  };
}

/** True when the snapshot describes the same scoring pass that produced the trip. */
export function isScoreInputsSnapshotUsable(snapshot) {
  return Boolean(
    snapshot &&
    typeof snapshot === 'object' &&
    snapshot.version === SCORE_INPUTS_VERSION &&
    Number.isFinite(Number(snapshot.scored_sample_count)) &&
    Array.isArray(snapshot.speed_limit_sources)
  );
}
