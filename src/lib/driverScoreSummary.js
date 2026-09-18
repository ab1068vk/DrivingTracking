/**
 * Fold a bounded row set into Road Sage's distance-weighted score shape.
 *
 * Population and window ownership stay with the caller. `includeTrip` lets a
 * projection consumer apply its authoritative population marker without
 * materialising a filtered copy. `limit` counts included rows, matching the
 * Dashboard's existing latest-window semantics. The optional trend retains at
 * most `trendLimit` entries, so resident work does not grow with the row set.
 *
 * A zero total scored distance is unavailable. This helper never substitutes
 * the distinct plain-mean metric.
 *
 * @param {Array} trips
 * @param {(trip: object) => {value: number|null, evidence?: string}} componentScore
 * @param {{includeTrip?: (trip: object) => boolean, limit?: number, trendLimit?: number}} options
 * @returns {{avgScore:number|null, avgScoreEvidence:string, basis:'distance_weighted'|'unavailable', scoredTripCount:number, scoreTrend?:number[]}}
 */
export function summarizeDistanceWeightedScore(
  trips = [],
  componentScore,
  { includeTrip = () => true, limit = Number.POSITIVE_INFINITY, trendLimit = 0 } = {},
) {
  const safeTrips = Array.isArray(trips) ? trips : [];
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  const safeTrendLimit = Number.isFinite(trendLimit) ? Math.max(0, Math.floor(trendLimit)) : 0;
  const trend = [];
  let includedCount = 0;
  let scoredTripCount = 0;
  let scoreDistanceProduct = 0;
  let scoreDistanceWeight = 0;
  let hasLowEvidence = false;
  let hasDevelopingEvidence = false;

  for (let index = 0; index < safeTrips.length; index += 1) {
    const trip = safeTrips[index];
    if (!includeTrip(trip)) continue;
    if (includedCount >= safeLimit) break;
    includedCount += 1;

    const component = componentScore(trip);
    const score = Number(component?.value);
    if (component?.value == null || !Number.isFinite(score)) continue;

    scoredTripCount += 1;
    const distance = Number(trip?.distance_km) || 0;
    scoreDistanceProduct += score * distance;
    scoreDistanceWeight += distance;
    if (component?.evidence === 'low') hasLowEvidence = true;
    else if (component?.evidence === 'developing') hasDevelopingEvidence = true;

    if (safeTrendLimit > 0) {
      const parsedTime = new Date(trip?.start_time).getTime();
      const order = Number.isFinite(parsedTime) ? parsedTime : index;
      const entry = { index, order, score };
      const insertAt = trend.findIndex((candidate) => (
        candidate.order > order || (candidate.order === order && candidate.index > index)
      ));
      if (insertAt === -1) trend.push(entry);
      else trend.splice(insertAt, 0, entry);
      if (trend.length > safeTrendLimit) trend.shift();
    }
  }

  const avgScore = scoredTripCount > 0 && scoreDistanceWeight > 0
    ? Math.round(scoreDistanceProduct / scoreDistanceWeight)
    : null;
  const avgScoreEvidence = scoredTripCount === 0
    ? 'unavailable'
    : hasLowEvidence
      ? 'low'
      : hasDevelopingEvidence
        ? 'developing'
        : 'high';

  const result = {
    avgScore,
    avgScoreEvidence,
    basis: avgScore == null ? 'unavailable' : 'distance_weighted',
    scoredTripCount,
  };
  if (safeTrendLimit > 0) result.scoreTrend = trend.map((entry) => entry.score);
  return result;
}
