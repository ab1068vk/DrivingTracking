/**
 * The remaining six Q10 reducers (Annex A §A3.1): UBI, the two progression
 * reducers, the Settings score-migration summary, the Dashboard activity block
 * and the filtered history totals.
 *
 * Same three laws as the report reducers: deterministic, associative across
 * page boundaries, and fixed in size with respect to N in both accumulator and
 * output.
 */

import { isLedgerCleanRow, localDayKey, rowNumber as n } from './populations.js';
import { MAX_MISMATCH_PREVIEW } from '@/lib/queryContracts/reducers';

const reducer = (identity, population, init, fold, finish) => Object.freeze({
  identity, population, init, fold, finish,
});

const scoreValue = (row) => (Number.isFinite(row?.score_overall) ? Number(row.score_overall) : null);

/**
 * p7.ubi.terms@1 — the eight UBI term inputs.
 *
 * Annex C **O26** keeps `ubiReport.js:53`'s math unchanged, so the eight
 * scalars are exactly the eight inputs that math consumes: trip count, total
 * distance, total driving minutes, night driving minutes, and the four event
 * counters it scores **separately** (`per100` is applied to each on its own).
 *
 * A merged harsh-event total or a night *distance* cannot reproduce those
 * category scores, so neither is carried. The 12-month mileage window and the
 * observed period bounds are different windows and belong to different bounded
 * reads, not to this accumulator.
 */
export const ubiTerms = reducer(
  'p7.ubi.terms@1', 'P-DRIVER',
  () => ({
    trip_count: 0, distance_km: 0, driving_minutes: 0, night_driving_minutes: 0,
    harsh_brakes: 0, rapid_accels: 0, sharp_turns: 0, speeding_events: 0,
  }),
  (acc, row) => {
    const minutes = n(row.duration_seconds) / 60;
    acc.trip_count += 1;
    acc.distance_km += n(row.distance_km);
    acc.driving_minutes += minutes;
    if (row.night_driving === true) acc.night_driving_minutes += minutes;
    acc.harsh_brakes += n(row.harsh_brakes_count);
    acc.rapid_accels += n(row.rapid_accel_count);
    acc.sharp_turns += n(row.sharp_turns_count);
    acc.speeding_events += n(row.speeding_events_count);
    return acc;
  },
  (acc) => ({ ...acc }),
);

const meanPair = (sum, count) => (count > 0 ? sum / count : null);

/**
 * p7.progression.lifetimeStats@1 — the **lifetime** `progressionStats`
 * population only. The mastery-40, recent-20, previous-20 and calendar windows
 * are bounded Q1 reads, not this reducer, and the XP/ledger facts keep their
 * existing owner. No second progression owner is created.
 */
export const progressionLifetimeStats = reducer(
  'p7.progression.lifetimeStats@1', 'P-PROGRESSION',
  () => ({
    tripCount: 0, distanceKm: 0,
    scoreDistanceProduct: 0, scoreDistanceWeight: 0,
    safetyProduct: 0, safetyWeight: 0, smoothnessProduct: 0, smoothnessWeight: 0,
    brakingSum: 0, brakingCount: 0, corneringSum: 0, corneringCount: 0,
    complianceSum: 0, complianceCount: 0,
    harshBrakes: 0, rapidAccels: 0, sharpTurns: 0, speedingEvents: 0,
    cleanTrips: 0, severeEvents: 0,
    scoreCount: 0, scoreSum: 0, scoreSumSquares: 0,
    phoneMeasured: 0, phoneClean: 0,
    specializedNight: 0, specializedLong: 0, specializedHighway: 0,
    specializedUrban: 0, specializedWet: 0, specializedReplay: 0,
  }),
  (acc, row) => {
    const distance = n(row.distance_km);
    const score = scoreValue(row);
    acc.tripCount += 1;
    acc.distanceKm += distance;
    if (score != null) {
      acc.scoreCount += 1;
      acc.scoreSum += score;
      // Sum of squares keeps the standard deviation computable in fixed space.
      acc.scoreSumSquares += score * score;
      if (distance > 0) {
        acc.scoreDistanceProduct += score * distance;
        acc.scoreDistanceWeight += distance;
      }
    }
    if (Number.isFinite(row.score_safety) && distance > 0) {
      acc.safetyProduct += Number(row.score_safety) * distance; acc.safetyWeight += distance;
    }
    if (Number.isFinite(row.score_smoothness) && distance > 0) {
      acc.smoothnessProduct += Number(row.score_smoothness) * distance; acc.smoothnessWeight += distance;
    }
    if (Number.isFinite(row.braking_efficiency_score)) {
      acc.brakingSum += Number(row.braking_efficiency_score); acc.brakingCount += 1;
    }
    if (Number.isFinite(row.cornering_consistency_score)) {
      acc.corneringSum += Number(row.cornering_consistency_score); acc.corneringCount += 1;
    }
    if (Number.isFinite(row.overall_compliance_score)) {
      acc.complianceSum += Number(row.overall_compliance_score); acc.complianceCount += 1;
    }
    acc.harshBrakes += n(row.harsh_brakes_count);
    acc.rapidAccels += n(row.rapid_accel_count);
    acc.sharpTurns += n(row.sharp_turns_count);
    acc.speedingEvents += n(row.speeding_events_count);
    acc.severeEvents += n(row.emergency_heavy_braking_count) + n(row.phone_use_high_confidence_count);
    if (isLedgerCleanRow(row)) acc.cleanTrips += 1;
    if (row.phone_use_score_available === true) {
      acc.phoneMeasured += 1;
      if (n(row.phone_use_high_confidence_count) === 0) acc.phoneClean += 1;
    }
    if (row.night_driving === true) acc.specializedNight += 1;
    if (n(row.duration_seconds) >= 3600) acc.specializedLong += 1;
    if (String(row.road_type) === 'highway') acc.specializedHighway += 1;
    if (String(row.road_type) === 'urban') acc.specializedUrban += 1;
    if (n(row.wet_signal_count) > 0) acc.specializedWet += 1;
    if (row.route_replay_available === true) acc.specializedReplay += 1;
    return acc;
  },
  (acc) => {
    const variance = acc.scoreCount > 0
      ? Math.max(0, (acc.scoreSumSquares / acc.scoreCount) - ((acc.scoreSum / acc.scoreCount) ** 2))
      : 0;
    const eventTotals = {
      harshBrakes: acc.harshBrakes, rapidAccels: acc.rapidAccels,
      sharpTurns: acc.sharpTurns, speedingEvents: acc.speedingEvents,
    };
    const per100 = (total) => (acc.distanceKm > 0 ? (total / acc.distanceKm) * 100 : null);
    return {
      tripCount: acc.tripCount,
      distanceKm: acc.distanceKm,
      avgScore: meanPair(acc.scoreDistanceProduct, acc.scoreDistanceWeight),
      safetyScore: meanPair(acc.safetyProduct, acc.safetyWeight),
      smoothnessScore: meanPair(acc.smoothnessProduct, acc.smoothnessWeight),
      brakingEfficiency: meanPair(acc.brakingSum, acc.brakingCount),
      corneringConsistency: meanPair(acc.corneringSum, acc.corneringCount),
      speedCompliance: meanPair(acc.complianceSum, acc.complianceCount),
      eventTotals,
      eventRates: {
        harshBrakes: per100(acc.harshBrakes), rapidAccels: per100(acc.rapidAccels),
        sharpTurns: per100(acc.sharpTurns), speedingEvents: per100(acc.speedingEvents),
      },
      cleanRate: acc.tripCount > 0 ? acc.cleanTrips / acc.tripCount : null,
      cleanTrips: acc.cleanTrips,
      severeEvents: acc.severeEvents,
      scoreStdDev: acc.scoreCount > 0 ? Math.sqrt(variance) : null,
      phoneMeasured: acc.phoneMeasured,
      phoneCoverage: acc.tripCount > 0 ? acc.phoneMeasured / acc.tripCount : null,
      phoneCleanRate: acc.phoneMeasured > 0 ? acc.phoneClean / acc.phoneMeasured : null,
      specializedCoverage: {
        night: acc.specializedNight, long: acc.specializedLong,
        highway: acc.specializedHighway, urban: acc.specializedUrban,
        wet: acc.specializedWet, replay: acc.specializedReplay,
      },
    };
  },
);

/** p7.progression.records@1 — lifetime extrema only, never the component means. */
export const progressionRecords = reducer(
  'p7.progression.records@1', 'P-PROGRESSION',
  () => ({
    best_score: null, best_score_id: null,
    longest_distance_km: null, longest_distance_id: null,
    longest_duration_seconds: null, longest_duration_id: null,
  }),
  (acc, row) => {
    const score = scoreValue(row);
    if (score != null && (acc.best_score === null || score > acc.best_score
      || (score === acc.best_score && String(row.id) < String(acc.best_score_id)))) {
      acc.best_score = score; acc.best_score_id = row.id;
    }
    const distance = n(row.distance_km);
    if (acc.longest_distance_km === null || distance > acc.longest_distance_km) {
      acc.longest_distance_km = distance; acc.longest_distance_id = row.id;
    }
    const duration = n(row.duration_seconds);
    if (acc.longest_duration_seconds === null || duration > acc.longest_duration_seconds) {
      acc.longest_duration_seconds = duration; acc.longest_duration_id = row.id;
    }
    return acc;
  },
  (acc) => ({ ...acc }),
);

/**
 * p7.settings.scoreMigrationSummary@1 — the B9 replacement.
 *
 * **Bounded output law** (Annex A §A3.8): the accumulator *and* the returned
 * payload are fixed in size. The current summary's unbounded
 * `trips: mismatched.map(...)` array is replaced by a total plus a
 * fixed-capacity preview, and the UI derives "+N more" from
 * `mismatch_count - preview.length`.
 */
export const scoreMigrationSummary = reducer(
  'p7.settings.scoreMigrationSummary@1', 'P-COMPLETED',
  (context = {}) => ({
    scoring_version: context.scoring_version ?? null,
    completed_count: 0, mismatch_count: 0,
    recent_window_days: Number(context.recent_window_days) || 30,
    recent_completed_count: 0, recent_mismatch_count: 0,
    auto_rescore_threshold_ratio: Number(context.auto_rescore_threshold_ratio) || 0,
    unavailable_score_count: 0,
    rescore_eligible_count: 0, rescore_ineligible_count: 0,
    mismatch_rescore_eligible_count: 0, mismatch_rescore_ineligible_count: 0,
    event_migration_version: context.event_migration_version ?? 0,
    has_unknown_legacy_unrescored: false,
    // A fixed four-slot buffer, filled in the reducer's deterministic
    // newest-first scan order. It never grows with the number of mismatches.
    mismatch_preview: [],
  }),
  (acc, row, context = {}) => {
    const current = String(acc.scoring_version ?? '');
    const rowVersion = row.score_version == null ? null : String(row.score_version);
    acc.completed_count += 1;

    const recentCutoff = Number(context.recentCutoffMs);
    const at = Date.parse(String(row.start_time ?? ''));
    const isRecent = Number.isFinite(recentCutoff) && Number.isFinite(at) && at >= recentCutoff;
    if (isRecent) acc.recent_completed_count += 1;

    if (!Number.isFinite(row.score_overall)) acc.unavailable_score_count += 1;

    const eligible = row.route_replay_available === true || row.route_data_expired_at == null;
    if (eligible) acc.rescore_eligible_count += 1; else acc.rescore_ineligible_count += 1;

    const mismatched = rowVersion !== current;
    if (!mismatched) return acc;

    acc.mismatch_count += 1;
    if (isRecent) acc.recent_mismatch_count += 1;
    if (eligible) acc.mismatch_rescore_eligible_count += 1;
    else acc.mismatch_rescore_ineligible_count += 1;
    if (rowVersion === null) acc.has_unknown_legacy_unrescored = true;
    if (acc.mismatch_preview.length < MAX_MISMATCH_PREVIEW) {
      acc.mismatch_preview.push({
        id: row.id,
        start_time: row.start_time ?? null,
        nickname: row.nickname ?? null,
        scoring_version: rowVersion,
      });
    }
    return acc;
  },
  (acc) => {
    const ratio = acc.recent_completed_count > 0
      ? acc.recent_mismatch_count / acc.recent_completed_count
      : 0;
    return {
      ...acc,
      recent_mismatch_ratio: ratio,
      auto_rescore_recommended: acc.auto_rescore_threshold_ratio > 0
        && ratio >= acc.auto_rescore_threshold_ratio,
    };
  },
);

/**
 * p7.dashboard.activityStats@1 — the terms no aggregate owner keys.
 *
 * `active_local_days` is counted **without a day set**: the scan is ordered by
 * `(start_time, id)`, so rows of the same local day are adjacent, and the
 * reducer keeps one last-seen key and increments when it changes. The
 * accumulator stays O(1) in N while the count stays exact.
 */
export const dashboardActivityStats = reducer(
  'p7.dashboard.activityStats@1', 'P-COMPLETED',
  () => ({
    trip_count: 0, distance_m: 0, driving_seconds: 0,
    active_local_days: 0, longest_trip_distance_m: 0,
    last_local_day: null,
  }),
  (acc, row) => {
    const distanceM = n(row.distance_km) * 1000;
    acc.trip_count += 1;
    acc.distance_m += distanceM;
    acc.driving_seconds += n(row.duration_seconds);
    if (distanceM > acc.longest_trip_distance_m) acc.longest_trip_distance_m = distanceM;
    const day = localDayKey(row);
    if (day && day !== acc.last_local_day) {
      acc.active_local_days += 1;
      acc.last_local_day = day;
    }
    return acc;
  },
  (acc) => ({
    trip_count: acc.trip_count,
    distance_m: acc.distance_m,
    driving_seconds: acc.driving_seconds,
    active_local_days: acc.active_local_days,
    longest_trip_distance_m: acc.longest_trip_distance_m,
  }),
);

/** p7.history.filteredTotals@1 — truthful totals for a filter no bucket serves. */
export const historyFilteredTotals = reducer(
  'p7.history.filteredTotals@1', 'P-COMPLETED',
  () => ({ count: 0, distance: 0, duration: 0, event_count: 0, route_retained_count: 0 }),
  (acc, row) => {
    acc.count += 1;
    acc.distance += n(row.distance_km);
    acc.duration += n(row.duration_seconds);
    acc.event_count += n(row.harsh_brakes_count) + n(row.rapid_accel_count)
      + n(row.sharp_turns_count) + n(row.speeding_events_count);
    if (n(row.route_points_map_count) > 0 && !row.route_data_expired_at) acc.route_retained_count += 1;
    return acc;
  },
  (acc) => ({ ...acc }),
);

export const DOMAIN_REDUCERS = Object.freeze([
  ubiTerms, progressionLifetimeStats, progressionRecords,
  scoreMigrationSummary, dashboardActivityStats, historyFilteredTotals,
]);
