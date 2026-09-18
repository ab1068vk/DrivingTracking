/**
 * The ten `p7.report.*` Q10 reducers (Annex A §A3.1), implemented.
 *
 * Every reducer here is **deterministic** (the same rows in the same order
 * produce the same accumulator), **associative across page boundaries**, and
 * **fixed in size with respect to N** in both its accumulator and its returned
 * output. None accumulates a per-trip list, an unbounded per-day map, or an id
 * set that grows with history.
 *
 * Score-mean discipline: `score_sum`/`score_count` (plain mean) and
 * `score_distance_product`/`score_distance_weight` (distance-weighted) are
 * separate accumulators and are never substituted for one another.
 */

import { isReportCleanRow, isLedgerCleanRow, rowNumber as n } from './populations.js';
import { PEAK_STRESS_MIN_TRIP_KM } from '@/lib/tripInsights';
import { EVENT_TYPES } from '@/lib/scoring/eventTypes';

/**
 * The frozen argmax order for `most_common_risk`, as accumulator term names
 * paired with the **canonical event identity** each one reports.
 *
 * `most_common_risk` is compared against `EVENT_TYPES` values downstream — the
 * Report's risk rows and its next-action ladder both switch on `harsh_brake`,
 * `speeding` and so on — so the reducer must publish that vocabulary, not its
 * own plural counter names.
 */
export const EVENT_TERM_ORDER = Object.freeze([
  ['harsh_brakes', EVENT_TYPES.HARSH_BRAKE],
  ['rapid_accels', EVENT_TYPES.RAPID_ACCELERATION],
  ['sharp_turns', EVENT_TYPES.SHARP_TURN],
  ['speeding_events', EVENT_TYPES.SPEEDING],
  ['heading_deviations', EVENT_TYPES.HEADING_DEVIATION],
  ['stop_start_patterns', EVENT_TYPES.STOP_START_PATTERN],
  ['distraction_events', EVENT_TYPES.ERRATIC_SPEED],
]);

const reducer = (identity, population, init, fold, finish) => Object.freeze({
  identity, population, init, fold, finish,
});

const scoreValue = (row) => (Number.isFinite(row?.score_overall) ? Number(row.score_overall) : null);

/** p7.report.eventTotals@1 */
export const eventTotals = reducer(
  'p7.report.eventTotals@1', 'P-DRIVER',
  () => ({
    harsh_brakes: 0, rapid_accels: 0, sharp_turns: 0, speeding_events: 0,
    heading_deviations: 0, stop_start_patterns: 0, distraction_events: 0,
    severe_events: 0, completed_count: 0,
    no_harsh_trips: 0, no_rapid_trips: 0, no_sharp_trips: 0, no_speeding_trips: 0,
    clean_trip_count: 0, report_clean_trip_count: 0, scored_trip_count: 0,
  }),
  (acc, row) => {
    acc.harsh_brakes += n(row.harsh_brakes_count);
    acc.rapid_accels += n(row.rapid_accel_count);
    acc.sharp_turns += n(row.sharp_turns_count);
    acc.speeding_events += n(row.speeding_events_count);
    acc.heading_deviations += n(row.heading_deviation_count);
    acc.stop_start_patterns += n(row.stop_start_pattern_count ?? row.tailgate_cycle_count);
    acc.distraction_events += n(row.distraction_events_count);
    acc.severe_events += n(row.severe_event_count)
      + n(row.emergency_heavy_braking_count) + n(row.phone_use_high_confidence_count);
    // The reducer's own folded-row count: exactly what a per-row percentage
    // denominator needs, because the population code already fixed the predicate.
    acc.completed_count += 1;
    if (n(row.harsh_brakes_count) === 0) acc.no_harsh_trips += 1;
    if (n(row.rapid_accel_count) === 0) acc.no_rapid_trips += 1;
    if (n(row.sharp_turns_count) === 0) acc.no_sharp_trips += 1;
    if (n(row.speeding_events_count) === 0) acc.no_speeding_trips += 1;
    if (isLedgerCleanRow(row)) acc.clean_trip_count += 1;
    if (isReportCleanRow(row)) acc.report_clean_trip_count += 1;
    if (scoreValue(row) != null) acc.scored_trip_count += 1;
    return acc;
  },
  (acc) => {
    const counts = {
      harsh_brakes: acc.harsh_brakes, rapid_accels: acc.rapid_accels,
      sharp_turns: acc.sharp_turns, speeding_events: acc.speeding_events,
      heading_deviations: acc.heading_deviations,
      stop_start_patterns: acc.stop_start_patterns,
      distraction_events: acc.distraction_events,
    };
    // argmax in the frozen order, so a tie resolves the same way every time.
    let most = null;
    for (const [term, identity] of EVENT_TERM_ORDER) {
      if (counts[term] > 0 && (most === null || counts[term] > counts[most[0]])) most = [term, identity];
    }
    return { ...acc, most_common_risk: most ? most[1] : null };
  },
);

const componentPair = (acc, prefix, score, distance) => {
  if (score == null) return;
  acc[`${prefix}_score_sum`] += score;
  acc[`${prefix}_score_count`] += 1;
  if (distance > 0) {
    acc[`${prefix}_score_distance_product`] += score * distance;
    acc[`${prefix}_score_distance_weight`] += distance;
  }
};

/** p7.report.durationDistance@1 */
export const durationDistance = reducer(
  'p7.report.durationDistance@1', 'P-DRIVER',
  () => ({
    duration_ms: 0, distance_m: 0, score_sum: 0, score_count: 0,
    score_distance_product: 0, score_distance_weight: 0, trip_count: 0,
    safety_score_distance_product: 0, safety_score_distance_weight: 0,
    safety_score_sum: 0, safety_score_count: 0,
    smoothness_score_distance_product: 0, smoothness_score_distance_weight: 0,
    smoothness_score_sum: 0, smoothness_score_count: 0,
  }),
  (acc, row) => {
    const distance = n(row.distance_km);
    acc.trip_count += 1;
    acc.duration_ms += n(row.duration_seconds) * 1000;
    acc.distance_m += distance * 1000;
    const overall = scoreValue(row);
    if (overall != null) {
      acc.score_sum += overall;
      acc.score_count += 1;
      if (distance > 0) {
        acc.score_distance_product += overall * distance;
        acc.score_distance_weight += distance;
      }
    }
    componentPair(acc, 'safety', Number.isFinite(row.score_safety) ? Number(row.score_safety) : null, distance);
    componentPair(acc, 'smoothness', Number.isFinite(row.score_smoothness) ? Number(row.score_smoothness) : null, distance);
    return acc;
  },
  (acc) => ({ ...acc }),
);

/** p7.report.nightExposure@1 — uses the persisted `night_driving` field. */
export const nightExposure = reducer(
  'p7.report.nightExposure@1', 'P-DRIVER',
  () => ({ night_trip_count: 0, night_duration_ms: 0, night_distance_m: 0 }),
  (acc, row) => {
    // The stored classification, never re-derived under a different timezone
    // basis (Annex C §C1).
    if (row.night_driving !== true) return acc;
    acc.night_trip_count += 1;
    acc.night_duration_ms += n(row.duration_seconds) * 1000;
    acc.night_distance_m += n(row.distance_km) * 1000;
    return acc;
  },
  (acc) => ({ ...acc }),
);

/** p7.report.economics@1 */
export const economics = reducer(
  'p7.report.economics@1', 'P-DRIVER',
  () => ({
    cost: 0, liters: 0, co2_kg: 0,
    fuel_saved_liters: 0, fuel_saved_trip_count: 0,
    co2_saved_kg: 0, co2_eligible_trip_count: 0,
  }),
  (acc, row, context = {}) => {
    const perTrip = context.estimate ? context.estimate(row) : null;
    if (perTrip) {
      acc.cost += n(perTrip.cost);
      acc.liters += n(perTrip.liters);
      acc.co2_kg += n(perTrip.co2_kg);
      // O25: availability, not amount. `estimateTripEconomics` sets
      // `fuel_saved_available` from whether a vehicle profile exists, and the
      // page counted that flag. An assigned vehicle whose estimated saving is
      // exactly zero is an available `0.00 L`, not "Unavailable".
      acc.fuel_saved_liters += n(perTrip.fuel_saved_liters);
      if (perTrip.fuel_saved_available === true) acc.fuel_saved_trip_count += 1;
    }
    // O53 is `calculateCarbonImpact`'s ladder, which is not simply the stored
    // field: with a vehicle list present the page estimates per trip and skips
    // rows with no matching vehicle. The caller supplies that decision, so the
    // reducer reproduces the number on screen instead of a different one.
    const saved = context.co2Saved
      ? context.co2Saved(row)
      : (Number.isFinite(row.co2_saved_kg) ? Number(row.co2_saved_kg) : null);
    if (Number.isFinite(saved)) {
      acc.co2_saved_kg += Number(saved);
      acc.co2_eligible_trip_count += 1;
    }
    return acc;
  },
  (acc) => ({ ...acc }),
);

const BUCKET_PROFILES = Object.freeze({
  time_of_day: 4, day_of_week: 7, road_type: 4, road_type_compliance: 3,
  efficiency_bands: 3, peak_off_peak: 2, score_distribution: 4,
});

const emptyBucket = () => ({
  trips: 0, distance_sum: 0, score_distance_product: 0, score_distance_weight: 0,
  event_sum: 0, ratio_sum: 0, ratio_count: 0,
});

const timeOfDayIndex = (hour) => {
  if (hour >= 5 && hour < 12) return 0;      // morning
  if (hour >= 12 && hour < 17) return 1;     // afternoon
  if (hour >= 17 && hour < 22) return 2;     // evening
  return 3;                                   // night
};

const ROAD_TYPES = Object.freeze(['highway', 'urban', 'mixed', 'residential']);
const PEAK_HOURS = Object.freeze([7, 8, 16, 17, 18]);

const scoreBand = (score) => {
  if (score >= 90) return 0;
  if (score >= 80) return 1;
  if (score >= 70) return 2;
  return 3;
};

/** p7.report.bucketProfiles@1 — 27 fixed buckets plus two window scalars. */
export const bucketProfiles = reducer(
  'p7.report.bucketProfiles@1', 'P-DRIVER',
  () => {
    const acc = { moving_speed_sum_kmh: 0, moving_speed_trip_count: 0, profiles: {} };
    for (const [profile, size] of Object.entries(BUCKET_PROFILES)) {
      acc.profiles[profile] = Array.from({ length: size }, emptyBucket);
    }
    return acc;
  },
  (acc, row) => {
    const at = new Date(Date.parse(String(row.start_time ?? '')));
    const valid = !Number.isNaN(at.getTime());
    const distance = n(row.distance_km);
    const score = scoreValue(row);
    const events = n(row.harsh_brakes_count) + n(row.rapid_accel_count)
      + n(row.sharp_turns_count) + n(row.speeding_events_count);

    const charge = (profile, index, ratio) => {
      const bucket = acc.profiles[profile]?.[index];
      if (!bucket) return;
      bucket.trips += 1;
      bucket.distance_sum += distance;
      bucket.event_sum += events;
      if (score != null && distance > 0) {
        bucket.score_distance_product += score * distance;
        bucket.score_distance_weight += distance;
      }
      if (Number.isFinite(ratio)) { bucket.ratio_sum += Number(ratio); bucket.ratio_count += 1; }
    };

    if (valid) {
      charge('time_of_day', timeOfDayIndex(at.getHours()));
      charge('day_of_week', at.getDay());
      // O54 is the only profile whose population narrows further: peak-hour
      // stress is `P-PEAKSTRESS` (`tripInsights.js:956`), and the figure is the
      // **mean of per-trip events-per-km**, not events over total distance.
      // Charging every driver row here, with no ratio, would report a
      // different number from the one the page has always shown.
      if (distance >= PEAK_STRESS_MIN_TRIP_KM) {
        charge('peak_off_peak', PEAK_HOURS.includes(at.getHours()) ? 0 : 1, events / distance);
      }
    }
    const roadIndex = ROAD_TYPES.indexOf(String(row.road_type ?? ''));
    if (roadIndex >= 0) charge('road_type', roadIndex);
    charge('efficiency_bands', 0, row.city_crawl_ratio);
    charge('efficiency_bands', 1, row.optimal_band_ratio);
    charge('efficiency_bands', 2, row.high_speed_ratio);
    if (score != null) charge('score_distribution', scoreBand(score));

    // The window-level moving-speed mean: the denominator is EVERY trip in the
    // window, so a row with neither speed field finite contributes 0 and still
    // counts — exactly today's `reduce(...) / trips.length`.
    const speed = Number.isFinite(row.avg_running_speed_kmh)
      ? Number(row.avg_running_speed_kmh)
      : (Number.isFinite(row.avg_speed_kmh) ? Number(row.avg_speed_kmh) : 0);
    acc.moving_speed_sum_kmh += speed;
    acc.moving_speed_trip_count += 1;
    return acc;
  },
  (acc) => {
    const profiles = {};
    for (const [profile, buckets] of Object.entries(acc.profiles)) {
      profiles[profile] = buckets.map((bucket) => ({
        trips: bucket.trips,
        distance_weighted_score: bucket.score_distance_weight > 0
          ? bucket.score_distance_product / bucket.score_distance_weight
          : null,
        events: bucket.event_sum,
        // Both forms of the declared `ratio_sums` term are published, because
        // the two consumers need different denominators: O54's peak stress is
        // the mean over the rows that carried a ratio, while O56's efficiency
        // bands divide by every trip in the window (a row with no ratio
        // contributed 0 to the page's numerator and 1 to its denominator).
        ratio_sum: bucket.ratio_sum,
        ratio_count: bucket.ratio_count,
        ratio_means: bucket.ratio_count > 0 ? bucket.ratio_sum / bucket.ratio_count : null,
      }));
    }
    return {
      profiles,
      moving_speed_sum_kmh: acc.moving_speed_sum_kmh,
      moving_speed_trip_count: acc.moving_speed_trip_count,
    };
  },
);

/** p7.report.fatigue@1 — threshold bound into the continuation, not re-read. */
export const fatigue = reducer(
  'p7.report.fatigue@1', 'P-DRIVER',
  () => ({ long_trip_count: 0, total_long_minutes: 0, longest_trip_minutes: 0 }),
  (acc, row, context = {}) => {
    const threshold = Number(context.threshold_long_drive_minutes) || 120;
    const minutes = n(row.duration_seconds) / 60;
    if (minutes >= threshold) {
      acc.long_trip_count += 1;
      acc.total_long_minutes += minutes;
    }
    if (minutes > acc.longest_trip_minutes) acc.longest_trip_minutes = minutes;
    return acc;
  },
  (acc) => ({ ...acc }),
);

/** p7.report.dailySeries@1 — a declared, capped day window (<= 31 local days). */
export const dailySeries = reducer(
  'p7.report.dailySeries@1', 'P-DRIVER',
  (context = {}) => ({
    // One bucket per day in the DECLARED window, so the accumulator is fixed in
    // size before a single row is read — never a map that grows with history.
    days: (context.days ?? []).slice(0, 31).map((date) => ({
      date, distance: 0, trips: 0, score_distance: 0, score_distance_weight: 0, svi_sum: 0, svi_count: 0,
    })),
  }),
  (acc, row, context = {}) => {
    const key = context.localDayKey ? context.localDayKey(row) : null;
    const bucket = acc.days.find((day) => day.date === key);
    if (!bucket) return acc;
    const distance = n(row.distance_km);
    const score = scoreValue(row);
    bucket.trips += 1;
    bucket.distance += distance;
    if (score != null && distance > 0) {
      bucket.score_distance += score * distance;
      bucket.score_distance_weight += distance;
    }
    if (Number.isFinite(row.svi_score)) { bucket.svi_sum += Number(row.svi_score); bucket.svi_count += 1; }
    return acc;
  },
  (acc) => acc.days.map((day) => ({
    date: day.date,
    distance: day.distance,
    trips: day.trips,
    avgScore: day.score_distance_weight > 0 ? day.score_distance / day.score_distance_weight : null,
    avgSviScore: day.svi_count > 0 ? day.svi_sum / day.svi_count : null,
  })),
);

/** p7.report.monthlyEventTrend@1 — 6 month buckets x 2 counters. */
export const monthlyEventTrend = reducer(
  'p7.report.monthlyEventTrend@1', 'P-DRIVER',
  (context = {}) => ({
    months: (context.months ?? []).slice(0, 6).map((month) => ({ month, harshBrakes: 0, rapidAccels: 0 })),
  }),
  (acc, row) => {
    const at = new Date(Date.parse(String(row.start_time ?? '')));
    if (Number.isNaN(at.getTime())) return acc;
    // Local month basis, matching `getFullYear()/getMonth()` in current source.
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;
    const bucket = acc.months.find((month) => month.month === key);
    if (!bucket) return acc;
    bucket.harshBrakes += n(row.harsh_brakes_count);
    bucket.rapidAccels += n(row.rapid_accel_count);
    return acc;
  },
  (acc) => acc.months.map((month) => ({ ...month })),
);

const betterExtreme = (current, candidate, compare) => {
  if (!candidate) return current;
  if (!current) return candidate;
  if (compare(candidate.score_overall, current.score_overall)) return candidate;
  // Deterministic tie-break by id, so two orders of the same rows agree.
  if (candidate.score_overall === current.score_overall) {
    return String(candidate.id) < String(current.id) ? candidate : current;
  }
  return current;
};

/** p7.report.summaryExtrema@1 — two extrema slots plus tie-break ids. */
export const summaryExtrema = reducer(
  'p7.report.summaryExtrema@1', 'P-DRIVER',
  () => ({ best_trip: null, worst_trip: null }),
  (acc, row) => {
    const score = scoreValue(row);
    if (score == null) return acc;
    const candidate = {
      id: row.id, nickname: row.nickname ?? null,
      start_time: row.start_time ?? null, score_overall: score,
    };
    acc.best_trip = betterExtreme(acc.best_trip, candidate, (a, b) => a > b);
    acc.worst_trip = betterExtreme(acc.worst_trip, candidate, (a, b) => a < b);
    return acc;
  },
  (acc) => ({ ...acc }),
);

/** p7.report.scoreTipTotals@1 — a narrower population than the report body. */
export const scoreTipTotals = reducer(
  'p7.report.scoreTipTotals@1', 'P-SCORETIP',
  () => ({
    eligible_trip_count: 0, harsh_brake: 0, rapid_acceleration: 0, sharp_turn: 0, speeding: 0,
  }),
  (acc, row) => {
    acc.eligible_trip_count += 1;
    acc.harsh_brake += n(row.harsh_brakes_count);
    acc.rapid_acceleration += n(row.rapid_accel_count);
    acc.sharp_turn += n(row.sharp_turns_count);
    acc.speeding += n(row.speeding_events_count);
    return acc;
  },
  (acc) => ({ ...acc }),
);

export const REPORT_REDUCERS = Object.freeze([
  eventTotals, durationDistance, nightExposure, economics, bucketProfiles,
  fatigue, dailySeries, monthlyEventTrend, summaryExtrema, scoreTipTotals,
]);
