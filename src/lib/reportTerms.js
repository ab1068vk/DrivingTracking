import { NIGHT_END_HOUR, NIGHT_START_HOUR } from '@/lib/appConstants';

/**
 * P7 Stage 6.7 — the Report's existing arithmetic, expressed over reducer
 * terms instead of over a fetched row array (Annex C **O42-O75**).
 *
 * Nothing here is new arithmetic. Each function reproduces exactly what the
 * page computed from `trips`, reading the terms the named reducer already
 * declares. That is the whole point: the Report used to fold a 200-row page and
 * present the result as the selected period, so any period holding more than
 * 200 drives silently described a truncation. The formulas are unchanged so the
 * numbers on screen are unchanged; only their **source** and their
 * **completeness** change.
 *
 * Every function is total: given `null` terms it returns the same empty shape
 * the builders return for an empty array, so a not-ready owner renders the
 * page's existing empty state rather than a zero presented as a fact.
 */

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round1 = (value) => Math.round(value * 10) / 10;

/** The empty summary, byte-identical to `generateReportSummary([])`. */
export const EMPTY_REPORT_SUMMARY = Object.freeze({
  total_trips: 0,
  total_distance_km: 0,
  total_duration_seconds: 0,
  avg_score: null,
  avg_score_trip_count: 0,
  avg_score_basis: 'unavailable',
  best_trip: null,
  worst_trip: null,
  total_harsh_brakes: 0,
  total_rapid_accels: 0,
  total_sharp_turns: 0,
  total_speeding_events: 0,
  total_heading_deviations: 0,
  total_stop_start_patterns: 0,
  total_distraction_events: 0,
  most_common_risk: null,
  score_trend: Object.freeze([]),
});

/**
 * **O42 / O43 / O44 / O45 / O46** — the report summary.
 *
 * `avg_score` is the distance-weighted mean the page has always shown, falling
 * back to the plain mean of scored rows when no scored row carries distance —
 * which is exactly `distanceWeightedTripScore`'s ladder, and why the reducer
 * carries both the product/weight pair and the sum/count pair.
 */
export function reportSummaryFromTerms({ durationDistance, eventTotals, extrema } = {}) {
  if (!durationDistance && !eventTotals) return { ...EMPTY_REPORT_SUMMARY, score_trend: [] };

  const dd = durationDistance ?? {};
  const ev = eventTotals ?? {};

  const weight = num(dd.score_distance_weight);
  const product = num(dd.score_distance_product);
  const scoreCount = num(dd.score_count);
  const scoreSum = num(dd.score_sum);
  const weighted = weight > 0 ? product / weight : null;
  const plain = scoreCount > 0 ? scoreSum / scoreCount : null;
  const avg = weighted ?? plain;

  const totals = {
    total_harsh_brakes: num(ev.harsh_brakes),
    total_rapid_accels: num(ev.rapid_accels),
    total_sharp_turns: num(ev.sharp_turns),
    total_speeding_events: num(ev.speeding_events),
    total_heading_deviations: num(ev.heading_deviations),
    total_stop_start_patterns: num(ev.stop_start_patterns),
    total_distraction_events: num(ev.distraction_events),
  };

  return {
    total_trips: num(dd.trip_count),
    total_distance_km: round1(num(dd.distance_m) / 1000),
    total_duration_seconds: Math.round(num(dd.duration_ms) / 1000),
    avg_score: avg == null ? null : Math.round(avg),
    // `score_count` is every scored row. It equals the weighted basis's own
    // count except where a scored row carries no distance, which the weighted
    // pair excludes; neither field is rendered, and both keep their names.
    avg_score_trip_count: scoreCount,
    avg_score_basis: weight > 0
      ? 'distance_weighted'
      : (scoreCount > 0 ? 'unweighted_mean' : 'unavailable'),
    best_trip: extrema?.best_trip ?? null,
    worst_trip: extrema?.worst_trip ?? null,
    ...totals,
    // O46: the argmax lives in the reducer, in the frozen EVENT_TYPES order.
    most_common_risk: ev.most_common_risk ?? null,
    // The page does not read `score_trend`; carrying every scored value would
    // be an array unbounded in N, which no reducer may hold.
    score_trend: [],
  };
}

const TIME_OF_DAY_BUCKETS = Object.freeze([
  { id: 'morning', label: 'Morning', range: '5a-12p', from: 5, to: 12 },
  { id: 'afternoon', label: 'Afternoon', range: '12p-5p', from: 12, to: 17 },
  { id: 'evening', label: 'Evening', range: '5p-10p', from: 17, to: 22 },
  { id: 'night', label: 'Night', range: '10p-5a', from: NIGHT_START_HOUR, to: NIGHT_END_HOUR + 24 },
]);

const bucketRow = (bucket) => ({
  trips: num(bucket?.trips),
  avgScore: bucket?.distance_weighted_score == null ? null : Math.round(bucket.distance_weighted_score),
  events: num(bucket?.events),
});

/** **O48** — the four local-hour buckets, in `analyzeTimeOfDay`'s shape. */
export function timeOfDayFromProfile(profiles) {
  const buckets = profiles?.time_of_day ?? [];
  return TIME_OF_DAY_BUCKETS.map((bucket, index) => ({ ...bucket, ...bucketRow(buckets[index]) }));
}

const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

/** **O49** — the seven local-weekday buckets, in `analyzeDayOfWeek`'s shape. */
export function dayOfWeekFromProfile(profiles) {
  const buckets = profiles?.day_of_week ?? [];
  return WEEKDAYS.map((day, index) => ({ day, ...bucketRow(buckets[index]) }));
}

const ROAD_TYPES = Object.freeze(['highway', 'urban', 'mixed', 'residential']);

/** **O55** — the road-type distribution, filtered to non-empty as today. */
export function roadTypeFromProfile(profiles) {
  const buckets = profiles?.road_type ?? [];
  return ROAD_TYPES
    .map((type, index) => ({
      name: type[0].toUpperCase() + type.slice(1),
      value: num(buckets[index]?.trips),
    }))
    .filter((item) => item.value > 0);
}

/**
 * **O56** — the efficiency bands.
 *
 * The page computed `sum(ratio || 0) / trips.length`: a row missing the field
 * contributed 0 to the numerator and still counted in the denominator. So the
 * numerator is the bucket's declared `ratio_sum` and the denominator is every
 * trip in the window — not the bucket's own `ratio_means`, whose denominator is
 * only the rows that carried a ratio.
 */
export function efficiencyBandsFromProfile(profiles, windowTrips) {
  const buckets = profiles?.efficiency_bands ?? [];
  const trips = num(windowTrips);
  // `sum(ratio || 0) / trips.length`, exactly as the page computed it.
  const mean = (index) => (trips ? Math.round(num(buckets[index]?.ratio_sum) / trips) : 0);
  const row = {
    name: 'Selected',
    cityCrawl: mean(0),
    cruise: mean(1),
    highSpeed: mean(2),
  };
  row.city = Math.max(0, 100 - row.cityCrawl - row.cruise - row.highSpeed);
  return [row];
}

/** **O73** — the four fixed score bands. */
export function scoreDistributionFromProfile(profiles) {
  const buckets = profiles?.score_distribution ?? [];
  const bands = [
    { label: '90+', shortLabel: '90+', color: 'bg-emerald-500' },
    { label: '80-89', shortLabel: '80s', color: 'bg-sky-500' },
    { label: '70-79', shortLabel: '70s', color: 'bg-amber-500' },
    { label: '<70', shortLabel: '<70', color: 'bg-red-500' },
  ].map((band, index) => ({ ...band, count: num(buckets[index]?.trips) }));
  const total = bands.reduce((sum, band) => sum + band.count, 0);
  return bands.map((band) => ({ ...band, percent: total > 0 ? (band.count / total) * 100 : 0 }));
}

/**
 * **O54** — peak vs off-peak, in `calculatePeakHourStress`'s shape.
 *
 * The reducer's `ratio_means` for these two buckets is the mean of per-trip
 * events-per-km over `P-PEAKSTRESS`, which is the figure the page computes.
 */
export function peakStressFromProfile(profiles) {
  const peak = profiles?.peak_off_peak?.[0];
  const offPeak = profiles?.peak_off_peak?.[1];
  const peakCount = num(peak?.trips);
  const offPeakCount = num(offPeak?.trips);
  const peakAvg = peak?.ratio_means == null ? 0 : num(peak.ratio_means);
  const offPeakAvg = offPeak?.ratio_means == null ? 0 : num(offPeak.ratio_means);

  const insufficientData = peakCount === 0 || offPeakCount === 0 || offPeakAvg <= 0.01;
  const stressRatio = insufficientData ? null : Math.min(5, peakAvg / offPeakAvg);
  const peakStressScore = stressRatio == null ? null : Math.max(0, Math.round(100 - (stressRatio - 1) * 40));

  return {
    peak_trips_event_rate: insufficientData ? null : Math.round(peakAvg * 100) / 100,
    off_peak_trips_event_rate: insufficientData ? null : Math.round(offPeakAvg * 100) / 100,
    stress_ratio: stressRatio == null ? null : Math.round(stressRatio * 10) / 10,
    peak_stress_score: peakStressScore,
    peak_stress_label: insufficientData
      ? 'insufficient off-peak data'
      : peakStressScore >= 85
        ? 'consistent'
        : peakStressScore >= 65
          ? 'slightly stressed'
          : peakStressScore >= 40
            ? 'traffic-affected'
            : 'significantly stressed',
    peak_trip_count: peakCount,
    off_peak_trip_count: offPeakCount,
    insufficient_data: insufficientData,
  };
}

/** **O51** — the window-level moving-speed mean. */
export function movingSpeedFromTerms(bucketProfiles) {
  const count = num(bucketProfiles?.moving_speed_trip_count);
  return count > 0 ? num(bucketProfiles.moving_speed_sum_kmh) / count : 0;
}

/**
 * **O74** — the Safety and Smoothness component means.
 *
 * Distance-weighted when the scored rows carry distance, otherwise the plain
 * mean of scored rows, otherwise `null` — `averageComponentScore`'s ladder.
 */
export function componentScoreFromTerms(durationDistance, component) {
  if (!durationDistance) return null;
  const weight = num(durationDistance[`${component}_score_distance_weight`]);
  const product = num(durationDistance[`${component}_score_distance_product`]);
  if (weight > 0) return Math.round(product / weight);
  const count = num(durationDistance[`${component}_score_count`]);
  if (count > 0) return Math.round(num(durationDistance[`${component}_score_sum`]) / count);
  return null;
}

/** **O50** — fatigue risk, in `calculateFatigueRisk`'s shape. */
export function fatigueFromTerms(terms, thresholdMinutes) {
  const longTripCount = num(terms?.long_trip_count);
  const longestTripMinutes = num(terms?.longest_trip_minutes);
  return {
    threshold_minutes: thresholdMinutes,
    long_trip_count: longTripCount,
    total_long_minutes: Math.round(num(terms?.total_long_minutes)),
    longest_trip_minutes: Math.round(longestTripMinutes),
    level: longTripCount >= 3 || longestTripMinutes >= thresholdMinutes * 1.5
      ? 'high'
      : longTripCount > 0 ? 'medium' : 'low',
  };
}

/** **O25** — the economics totals, in the page's accumulator shape. */
export function economicsFromTerms(terms) {
  return {
    cost: num(terms?.cost),
    liters: num(terms?.liters),
    co2: num(terms?.co2_kg),
    saved: num(terms?.fuel_saved_liters),
    savedTripCount: num(terms?.fuel_saved_trip_count),
  };
}

/** **O53** — carbon impact, in `calculateCarbonImpact`'s shape. */
export function carbonFromTerms(terms, treeCo2KgPerYear) {
  const totalCo2SavedKg = round1(num(terms?.co2_saved_kg));
  const eligibleTripCount = num(terms?.co2_eligible_trip_count);
  const perYear = Number.isFinite(Number(treeCo2KgPerYear)) && Number(treeCo2KgPerYear) > 0
    ? Number(treeCo2KgPerYear)
    : 21;
  return {
    total_co2_saved_kg: totalCo2SavedKg,
    eligible_trip_count: eligibleTripCount,
    savings_available: eligibleTripCount > 0,
    trees_equivalent: round1(totalCo2SavedKg / perYear),
    // The frozen `calculateCarbonImpact` labels. The two lower bands are
    // `Getting There` and `Starting Out`; substituting different words at the
    // same thresholds changes what the driver reads.
    carbon_grade: totalCo2SavedKg >= 100
      ? 'Climate Champion'
      : totalCo2SavedKg >= 50
        ? 'Green Driver'
        : totalCo2SavedKg >= 20
          ? 'Efficiency Aware'
          : totalCo2SavedKg >= 5
            ? 'Getting There'
            : 'Starting Out',
  };
}

const TIP_EVENT_KEYS = Object.freeze(['harsh_brake', 'rapid_acceleration', 'sharp_turn', 'speeding']);

/** O47's night-share threshold, exactly as `buildScoreTips` applies it. */
export const SCORE_TIP_NIGHT_SHARE = 0.35;

/** O47's two score thresholds. */
export const SCORE_TIP_HIGH_SCORE = 85;
export const SCORE_TIP_LOW_SCORE = 70;

/** O47's output cap. */
export const SCORE_TIP_MAX = 3;

/**
 * **O47** — coaching tips over `P-SCORETIP`.
 *
 * This reproduces `buildScoreTips` branch for branch, in its order, with its
 * thresholds and its three-tip cap. Nothing is dropped:
 *
 * 1. the dominant-event tip, argmax over the four counters, only when > 0;
 * 2. the night-share tip at `night / eligible >= 0.35`;
 * 3. the score tip: `>= 85` praises, `< 70` coaches consistency, and a window
 *    with no weighted score behaves as `0` — which is `< 70` — exactly as the
 *    oracle's `?? 0` does.
 *
 * The terms come from three reducers, all bound to the **same** `P-SCORETIP`
 * population, so no branch is evaluated over a wider set of drives than the
 * others:
 *
 * | Term | Source |
 * |---|---|
 * | eligible count, four event counters | `p7.report.scoreTipTotals@1` |
 * | night trip count | `p7.report.nightExposure@1`, narrowed to `P-SCORETIP` |
 * | distance-weighted score | `p7.report.durationDistance@1`, narrowed to `P-SCORETIP` |
 *
 * **Ranking requires terminal EOF** (P7-IMPL-F01). Every branch here is a
 * comparison — an argmax, a share against `0.35`, a mean against `85`/`70` —
 * and a comparison over a running tally is a claim about the whole window made
 * from whichever drives happened to be read first. A `PARTIAL` tally therefore
 * keeps the frozen not-enough-data presentation instead of ranking: the caller
 * passes `exact: false` until all three reducers reach EOF, and the explicit
 * finish action is what turns the tips on.
 *
 * @param {object|null} terms `scoreTipTotals@1`
 * @param {{night?: object|null, weighted?: object|null, windowTrips?: number|null,
 *          exact?: boolean, messages: object, emptyCopy: string,
 *          ineligibleCopy: string, nightCopy: string, highScoreCopy: string,
 *          lowScoreCopy: string}} options
 */
export function tipsFromTerms(terms, options = {}) {
  const {
    night = null, weighted = null, windowTrips = null, exact = true, messages,
    emptyCopy, ineligibleCopy, nightCopy, highScoreCopy, lowScoreCopy,
  } = options;

  // A nonterminal tally is never ranked. This is checked before anything else,
  // so no partial accumulator can reach a threshold comparison at all.
  if (exact === false) return [emptyCopy].filter(Boolean);

  // The two empty states are different facts and keep their own copy: no
  // completed drives at all, versus drives that exist but none clearing the
  // eligibility bar. Telling them apart needs the window count as well as the
  // eligible count, which is why the report body's trip count is passed in.
  if (!terms) return [emptyCopy].filter(Boolean);
  if (windowTrips != null && num(windowTrips) === 0) return [emptyCopy].filter(Boolean);
  const eligible = num(terms.eligible_trip_count);
  if (eligible === 0) return [windowTrips == null ? emptyCopy : ineligibleCopy].filter(Boolean);

  const tips = [];

  const ranked = TIP_EVENT_KEYS
    .map((key) => [key, num(terms[key])])
    .sort((left, right) => right[1] - left[1])[0];
  if (ranked && ranked[1] > 0 && messages?.[ranked[0]]) tips.push(messages[ranked[0]]);

  const nightTrips = num(night?.night_trip_count);
  if (nightTrips / eligible >= SCORE_TIP_NIGHT_SHARE) tips.push(nightCopy);

  // `distanceWeightedScore(eligible) ?? 0`: a window whose scored rows carry no
  // distance has no weighted mean, and the oracle then treats it as 0.
  const weight = num(weighted?.score_distance_weight);
  const avgScore = weight > 0 ? num(weighted.score_distance_product) / weight : 0;
  if (avgScore >= SCORE_TIP_HIGH_SCORE) tips.push(highScoreCopy);
  else if (avgScore < SCORE_TIP_LOW_SCORE) tips.push(lowScoreCopy);

  return tips.filter(Boolean).slice(0, SCORE_TIP_MAX);
}

/**
 * **O63 - O72, O75** — the insight block, from terms rather than rows.
 *
 * Same arithmetic as `buildReportInsights`, with three inputs now owner-backed:
 * `activeDays` is the reducer's distinct **local**-day count, `cleanTrips` is
 * the Report four-counter predicate the event reducer declares, and
 * `scoredTrips` is its scored-row count.
 */
export function reportInsightsFromTerms({
  period, periodDays, summary, previousSummary, hasPrevious,
  activeLocalDays, cleanTripCount, scoredTripCount,
  timeOfDayData, dayOfWeekData, peakHourStress, riskRowsOf, nextActionFor,
}) {
  const totalEvents = riskRowsOf(summary).reduce((sum, item) => sum + item.count, 0);
  const totalKm = num(summary.total_distance_km);
  const activeDays = num(activeLocalDays);
  const possibleDays = period === 'all' ? activeDays : periodDays;
  const scoredTrips = num(scoredTripCount);
  const windowTrips = num(summary.total_trips);

  const bestWindow = [...timeOfDayData]
    .filter((item) => Number.isFinite(Number(item.avgScore)))
    .sort((a, b) => b.avgScore - a.avgScore)[0];
  const hardestDay = [...dayOfWeekData]
    .filter((item) => Number.isFinite(Number(item.events)))
    .sort((a, b) => b.events - a.events)[0];

  const eventRate = totalKm > 0 ? (totalEvents / totalKm) * 100 : null;
  const previousEventCount = riskRowsOf(previousSummary).reduce((sum, item) => sum + item.count, 0);
  const previousKm = num(previousSummary.total_distance_km);
  const previousEventRate = previousKm > 0 ? (previousEventCount / previousKm) * 100 : null;

  return {
    activeDays,
    cleanTripPercent: windowTrips ? (num(cleanTripCount) / windowTrips) * 100 : 0,
    confidence: totalKm >= 100 && scoredTrips >= 10
      ? 'High'
      : totalKm >= 25 && scoredTrips >= 3 ? 'Medium' : 'Early',
    coveragePercent: possibleDays > 0 ? (activeDays / possibleDays) * 100 : 0,
    distanceDelta: hasPrevious ? totalKm - previousKm : null,
    eventRate,
    eventRateDelta: eventRate != null && previousEventRate != null ? eventRate - previousEventRate : null,
    hardestDay,
    nextAction: nextActionFor(totalEvents, peakHourStress),
    scoreDelta: summary.avg_score != null && previousSummary.avg_score != null
      ? summary.avg_score - previousSummary.avg_score
      : null,
    scoredTrips,
    bestWindow,
  };
}
