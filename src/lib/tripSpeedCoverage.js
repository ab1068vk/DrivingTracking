/**
 * One tier-aware answer to "where did this trip's speed limits come from".
 *
 * Trip Detail used to compute this inline against three hard-coded legacy source
 * strings ('openstreetmap', 'osm_highway_default', 'inferred'). The resolver
 * emits seven, so a point resolved from local road memory or a driver-confirmed
 * sign counted as covered but landed in no bucket: the shares under-reported,
 * they did not sum to coverage, and mapDerivedPct could read 0% on a fully
 * covered route and trip the low-coverage banner.
 *
 * Every consumer of coverage now derives it here, so Trip Detail, the speed
 * analysis page, and the telemetry summary cannot disagree about the same trip.
 *
 * Percentages are rounded once from raw counts and the largest share absorbs
 * the rounding remainder, so the tiles always sum to the coverage figure rather
 * than to 99% or 101%.
 */
import { canonicalSpeedSource, tierForSource } from '@/lib/speed/speedTierNames';

export const pointLimitKmh = (point = {}) => {
  const value = Number(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);
  return Number.isFinite(value) && value > 0 ? value : null;
};

export const pointSpeedKmh = (point = {}) => {
  const value = Number(point.speed_kmh ?? point.speedKmh);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const pointLimitSource = (point = {}) => (
  point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? 'unknown'
);

/**
 * A point that may be reasoned about. Privacy-masked points keep their slot in
 * the route array so indexes stay aligned with the local-knowledge results, but
 * they carry no usable position and must not reach a coverage denominator.
 */
export const isPublicRoutePoint = (point = {}) => (
  Number.isFinite(Number(point.lat)) &&
  Number.isFinite(Number(point.lng)) &&
  point.privacy_export_placeholder !== true &&
  point.masked_for_privacy !== true &&
  point.privacy_gap !== true &&
  point.privacy_live_redacted !== true
);

/** Display order, most authoritative first. Also the tie-break for the remainder. */
export const SPEED_COVERAGE_TIER_ORDER = Object.freeze([
  'POSTED',
  'LEARNED_LOCAL',
  'MAP_ESTIMATED',
  'REGION_DEFAULT',
  'GPS_INFERRED',
]);

export const SPEED_COVERAGE_TIER_LABELS = Object.freeze({
  POSTED: 'posted limits',
  LEARNED_LOCAL: 'limits learned on your own routes',
  MAP_ESTIMATED: 'road-type estimates',
  REGION_DEFAULT: 'regional default estimates',
  GPS_INFERRED: 'GPS-inferred limits',
});

const emptyCounts = () => SPEED_COVERAGE_TIER_ORDER.reduce((acc, tier) => {
  acc[tier] = 0;
  return acc;
}, {});

/**
 * @param {any} trip
 * @param {{localKnowledgeResults?: Array<any>}} [options]
 *   localKnowledgeResults is indexed by position in trip.route_points, matching
 *   how the resolver returns it.
 */
export function summarizeTripSpeedCoverage(trip = {}, options = {}) {
  const { localKnowledgeResults = [] } = options;
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const counts = emptyCounts();
  let sampleCount = 0;
  let coveredCount = 0;
  let unknownTierCount = 0;

  routePoints.forEach((point, index) => {
    if (!isPublicRoutePoint(point)) return;
    sampleCount += 1;

    const local = localKnowledgeResults[index] || null;
    const localLimit = local ? pointLimitKmh(local) : null;
    const localSource = local ? canonicalSpeedSource(pointLimitSource(local)) : 'unknown';
    // A driver-confirmed sign or a driver-entered estimate outranks whatever the
    // map said, so it wins even when the stored point already carries a limit.
    const preferLocal = localLimit != null
      && (localSource === 'user_confirmed_posted_sign' || localSource === 'user_entered_estimate');

    const limitKmh = preferLocal ? localLimit : (pointLimitKmh(point) ?? localLimit);
    if (limitKmh == null) return;
    coveredCount += 1;

    const storedSource = canonicalSpeedSource(pointLimitSource(point));
    const source = preferLocal
      ? localSource
      : (storedSource !== 'unknown' ? storedSource : localSource);
    const tier = tierForSource(source);
    if (tier === 'UNKNOWN') {
      // Covered by a source this build does not recognise — counted so the
      // shares still reconcile against coverage instead of silently vanishing.
      unknownTierCount += 1;
      return;
    }
    counts[tier] += 1;
  });

  const pct = (count) => (sampleCount ? Math.round((count / sampleCount) * 100) : 0);
  const percentages = SPEED_COVERAGE_TIER_ORDER.reduce((acc, tier) => {
    acc[tier] = pct(counts[tier]);
    return acc;
  }, {});
  const coveragePercent = pct(coveredCount);

  // Push the rounding remainder onto the largest tier so the parts reconcile
  // with the whole. Only the largest share can absorb it without changing rank.
  const summedShares = SPEED_COVERAGE_TIER_ORDER.reduce((sum, tier) => sum + percentages[tier], 0)
    + pct(unknownTierCount);
  const remainder = coveragePercent - summedShares;
  if (remainder !== 0) {
    const largest = SPEED_COVERAGE_TIER_ORDER.reduce(
      (best, tier) => (counts[tier] > counts[best] ? tier : best),
      SPEED_COVERAGE_TIER_ORDER[0]
    );
    if (counts[largest] > 0) {
      percentages[largest] = Math.max(0, percentages[largest] + remainder);
    }
  }

  return {
    sampleCount,
    coveredCount,
    coveragePercent,
    counts,
    percentages,
    unknownTierCount,
    /** Anything a map supplied, whether tagged or defaulted by road type. */
    mapDerivedPercent: percentages.POSTED + percentages.MAP_ESTIMATED,
    /** What the app worked out itself, with no map involved. */
    locallyDerivedPercent: percentages.LEARNED_LOCAL + percentages.GPS_INFERRED,
  };
}

/**
 * Prose for the provenance line. Tiers with no samples are omitted rather than
 * printed as 0%, so a fully posted route reads as one clause.
 */
export function describeTripSpeedCoverage(coverage, options = {}) {
  const { regionLabel = null } = options;
  if (!coverage || !coverage.sampleCount) return 'No speed limit coverage recorded for this route.';
  if (!coverage.coveredCount) return `No speed limit was resolved for this route (${coverage.sampleCount} samples).`;

  const clauses = SPEED_COVERAGE_TIER_ORDER
    .filter((tier) => coverage.counts[tier] > 0)
    .map((tier) => {
      const label = tier === 'REGION_DEFAULT' && regionLabel
        ? `${regionLabel} regional default estimates`
        : SPEED_COVERAGE_TIER_LABELS[tier];
      return `${coverage.percentages[tier]}% used ${label}`;
    });

  return `${clauses.join('; ')} (${coverage.sampleCount} samples).`;
}
