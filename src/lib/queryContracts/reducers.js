/**
 * P7 Stage 1 — Q10 named, versioned, deterministic reducer registry and the
 * continuation contract (Annex A §A3).
 *
 * Declaration only. Q10 accepts **no** arbitrary executable predicate or field
 * list: an opaque continuation cannot encode, validate or version a callback.
 * Stage 2 implements exactly these sixteen identities and no others.
 *
 * Every reducer is deterministic (same rows in the same order produce the same
 * accumulator), associative across page boundaries, and **fixed in size with
 * respect to N in both its accumulator and its returned payload** (§A3.8). No
 * reducer may accumulate or return a per-trip list, an unbounded per-day map, or
 * an id set that grows with history. A reducer whose definition changes takes a
 * new version suffix; the old version is refused with REDUCER_VERSION_MISMATCH
 * rather than silently reinterpreted.
 *
 * Existing exact rollups are always preferred: where P6 D1 defines the requested
 * metric exactly for the requested scope, the page uses Q4/Q5 and Q10 is not
 * invoked. P7 does not extend, write to, or reopen P6 D1 (OQ-1, §A3.7).
 */

/** Frozen preview capacity for the B9 summary (§A3.8, from `Settings.jsx` `.slice(0, 4)`). */
export const MAX_MISMATCH_PREVIEW = 4;

const reducer = (id, version, serves, accumulator, output) => Object.freeze({
  id, version, identity: `${id}@${version}`, serves,
  accumulator: Object.freeze(accumulator),
  output: Object.freeze(output),
});

export const P7_REDUCER_REGISTRY = Object.freeze([
  reducer('p7.report.eventTotals', 1,
    'Report / Insights / Achievements event and clean-trip facts no rollup keys on the requesting authority',
    { scalars: 17, note: '17 integer counters + the bound range' },
    ['harsh_brakes', 'rapid_accels', 'sharp_turns', 'speeding_events', 'heading_deviations',
      'stop_start_patterns', 'distraction_events', 'severe_events', 'completed_count',
      'no_harsh_trips', 'no_rapid_trips', 'no_sharp_trips', 'no_speeding_trips',
      'clean_trip_count', 'report_clean_trip_count', 'scored_trip_count', 'most_common_risk']),

  reducer('p7.report.durationDistance', 1,
    'Report / UBI / Dashboard totals where the authority rollup lacks the duration+distance+score triple, plus the per-component Report score means',
    { scalars: 15 },
    ['duration_ms', 'distance_m', 'score_sum', 'score_count', 'score_distance_product',
      'score_distance_weight', 'trip_count',
      'safety_score_distance_product', 'safety_score_distance_weight', 'safety_score_sum', 'safety_score_count',
      'smoothness_score_distance_product', 'smoothness_score_distance_weight', 'smoothness_score_sum', 'smoothness_score_count']),

  reducer('p7.report.nightExposure', 1,
    'Night trips and night duration over a date range, using the persisted night_driving field',
    { scalars: 3 },
    ['night_trip_count', 'night_duration_ms', 'night_distance_m']),

  reducer('p7.report.economics', 1,
    'Report economics and carbon inputs (fuel / cost / CO2 terms) that no ledger keys exactly',
    { scalars: 6, note: '6 numeric accumulators + the economics-constants version' },
    ['cost', 'liters', 'co2_kg', 'fuel_saved_liters', 'fuel_saved_trip_count',
      'co2_saved_kg', 'co2_eligible_trip_count']),

  reducer('p7.report.bucketProfiles', 1,
    'Every fixed-bucket Report/Insights profile plus the window-level moving-speed mean',
    {
      buckets: 27,
      profiles: Object.freeze({
        time_of_day: 4, day_of_week: 7, road_type: 4, road_type_compliance: 3,
        efficiency_bands: 3, peak_off_peak: 2, score_distribution: 4,
      }),
      perBucket: Object.freeze(['trips', 'distance_sum', 'score_distance_product',
        'score_distance_weight', 'event_sum', 'ratio_sums']),
      windowScalars: Object.freeze(['moving_speed_sum_kmh', 'moving_speed_trip_count']),
    },
    ['profiles{trips,distance_weighted_score,events,ratio_means} for each of the seven declared profiles',
      'moving_speed_sum_kmh', 'moving_speed_trip_count']),

  reducer('p7.report.fatigue', 1,
    'Report fatigue risk over a date range, parameterized by threshold_long_drive_minutes bound into the continuation',
    { scalars: 3 },
    ['long_trip_count', 'total_long_minutes', 'longest_trip_minutes']),

  reducer('p7.report.dailySeries', 1,
    'Report daily chart series over a declared, capped day window (<= 31 local days)',
    { buckets: 31, perBucket: Object.freeze(['distance', 'trips', 'score_distance', 'score_distance_weight', 'svi_sum', 'svi_count']) },
    ['per-day {date, distance, trips, avgScore, avgSviScore}']),

  reducer('p7.report.monthlyEventTrend', 1,
    'Report 6-month event trend',
    { buckets: 6, perBucket: Object.freeze(['harshBrakes', 'rapidAccels']) },
    ['per-month {month, harshBrakes, rapidAccels}']),

  reducer('p7.report.summaryExtrema', 1,
    'Report best/worst scored trip',
    { scalars: 2, note: '2 extrema slots + tie-break ids' },
    ['best_trip{id,nickname,start_time,score_overall}', 'worst_trip{id,nickname,start_time,score_overall}']),

  reducer('p7.report.scoreTipTotals', 1,
    'Report coaching tips, whose eligible population is narrower than the report body (P-SCORETIP)',
    { scalars: 5 },
    ['eligible_trip_count', 'harsh_brake', 'rapid_acceleration', 'sharp_turn', 'speeding']),

  reducer('p7.ubi.terms', 1,
    'UBI term inputs (ubiReport.js:53)',
    { scalars: 8 },
    ['ubi term totals (8 declared numeric terms)']),

  reducer('p7.progression.lifetimeStats', 1,
    'The lifetime progressionStats population for Achievements — the terms neither the XP ledger nor D1 keys. Bounded windows are Q1 reads, not this reducer',
    { scalars: 26 },
    ['tripCount', 'distanceKm', 'avgScore', 'safetyScore', 'smoothnessScore', 'brakingEfficiency',
      'corneringConsistency', 'speedCompliance', 'eventTotals', 'eventRates', 'cleanRate',
      'cleanTrips', 'severeEvents', 'scoreStdDev', 'phoneMeasured', 'phoneCoverage',
      'phoneCleanRate', 'specializedCoverage']),

  reducer('p7.progression.records', 1,
    'Lifetime record/extrema facts neither the XP ledger nor D1 keys (extrema only)',
    { scalars: 6, note: '6 scalar extrema + tie-break ids' },
    ['record facts (best score, longest trip, personal-best trip score, with tie-break ids)']),

  reducer('p7.settings.scoreMigrationSummary', 1,
    'Replaces B9 — the routine Settings score-migration summary',
    { scalars: 16, note: '15 integer/numeric counters + 1 boolean + a fixed 4-slot mismatch-preview buffer' },
    ['scoring_version', 'completed_count', 'mismatch_count', 'recent_window_days',
      'recent_completed_count', 'recent_mismatch_count', 'recent_mismatch_ratio',
      'auto_rescore_threshold_ratio', 'auto_rescore_recommended', 'unavailable_score_count',
      'rescore_eligible_count', 'rescore_ineligible_count', 'mismatch_rescore_eligible_count',
      'mismatch_rescore_ineligible_count', 'event_migration_version',
      'has_unknown_legacy_unrescored', 'mismatch_preview', 'completeness']),

  reducer('p7.dashboard.activityStats', 1,
    'The Dashboard activity-stats block terms no aggregate owner keys: driving seconds, distinct local active days, longest trip',
    { scalars: 5, note: '5 numeric accumulators + one last-seen local-day key' },
    ['trip_count', 'distance_m', 'driving_seconds', 'active_local_days', 'longest_trip_distance_m']),

  reducer('p7.history.filteredTotals', 1,
    'Truthful totals for a filter/window no bucket or index serves exactly',
    { scalars: 5 },
    ['count', 'distance', 'duration', 'event_count', 'route_retained_count']),
]);

/** Registry lookup by `id@version`. */
export const P7_REDUCER_BY_IDENTITY = Object.freeze(Object.fromEntries(
  P7_REDUCER_REGISTRY.map((entry) => [entry.identity, entry])
));

export const P7_REDUCER_IDENTITIES = Object.freeze(P7_REDUCER_REGISTRY.map((e) => e.identity));

/**
 * §A3.8 — the frozen B9 result shape. Every field is fixed in size; the scalar
 * fields are exactly today's, unchanged. `status`, `reason` and
 * `changed_constants` are dropped because no renderer consumes them.
 */
export const P7_SCORE_MIGRATION_SUMMARY_SHAPE = Object.freeze({
  scalars: Object.freeze([
    'scoring_version', 'completed_count', 'mismatch_count', 'recent_window_days',
    'recent_completed_count', 'recent_mismatch_count', 'recent_mismatch_ratio',
    'auto_rescore_threshold_ratio', 'auto_rescore_recommended', 'unavailable_score_count',
    'rescore_eligible_count', 'rescore_ineligible_count', 'mismatch_rescore_eligible_count',
    'mismatch_rescore_ineligible_count', 'event_migration_version',
  ]),
  hasUnknownLegacyUnrescored: 'boolean — replaces trips.some(status === "unknown_legacy_unrescored")',
  previewField: 'mismatch_preview',
  previewCapacity: MAX_MISMATCH_PREVIEW,
  previewItemFields: Object.freeze(['id', 'start_time', 'nickname', 'scoring_version']),
  previewOrder: 'the reducer deterministic newest-first (start_time, id) scan order',
  moreCountDerivedFrom: 'mismatch_count - mismatch_preview.length',
  nativeParity: 'the native authority answers this same frozen shape or a typed unavailable — never an aggregate row shaped like a summary',
});

/** §A3.2 — continuation schema. Binding fields are validated before any turn. */
export const P7_Q10_CONTINUATION_SHAPE = Object.freeze({
  v: 1,
  reducer: Object.freeze({ id: 'registry identity', version: 'int' }),
  bind: Object.freeze({ range: '{fromMs,toMs}', filterId: 'sha-256 hex', status: 'token', sort: 'token' }),
  src: Object.freeze({ authority: 'browser|native', generation: 'id', revision: 'browser revision | native canonical sequence' }),
  last: 'cursor v2 keyset position (A2.1 `key`), original types preserved',
  acc: 'fixed-size reducer accumulator',
  meta: Object.freeze({ turns: 'int', rowsVisited: 'int', v: 1, mac: 'integrity tag' }),
});

/** §A3.3 — one declared bounded scan turn per invocation, under the Q1 page bounds. */
export const P7_Q10_TURN_BUDGET = Object.freeze({
  turnsPerInvocation: 1,
  sourceRowsVisited: 'k + 1',
  projectionDecrypts: 'k',
  fullTripDecrypts: 0,
  historySorts: 0,
  wholeStoreGetAlls: 0,
  exactOnlyAt: 'terminal EOF for the bound snapshot',
});

/**
 * §A3.4 — the ephemerality law. The zero counts (P7 lifecycle jobs 0,
 * coordinator registrations 0, explicit operations 0) are valid **only** under
 * this contract.
 */
export const P7_Q10_EPHEMERALITY_LAW = Object.freeze({
  pageOwned: true,
  retainedOnlyWhilePageActive: true,
  durable: false,
  persisted: false,
  background: false,
  scheduled: false,
  p4CoordinatorJob: false,
  p7ExplicitOperation: false,
  autoDrainedByRenderEffectFocusResumeOrInvalidation: false,
  turnsPerRender: 1,
});

/**
 * §A3.5 — reaching EXACT. The user must be able to deliberately continue and
 * finish an incomplete analysis; a PARTIAL accumulator may never be labelled,
 * exported or rendered as an exact or lifetime total.
 */
export const P7_Q10_CONTINUE_TO_EXACT = Object.freeze({
  truthfulPartialState: true,
  explicitContinueAffordance: true,
  drivenByExistingExplicitUserAction: true,
  cancellable: true,
  residentPages: 1,
  createsNewDurableOperation: false,
});

/** §A3.6 — accumulators from different source snapshots are never merged. */
export const P7_Q10_SNAPSHOT_MISMATCH_LAW = Object.freeze({
  onMismatch: 'discard the accumulator; return ACCUMULATOR_SNAPSHOT_MISMATCH (or the matching cursor code) with zero contribution; the analysis restarts',
  mergeAcrossSnapshots: false,
  carryAcrossGenerationRevisionImportRestoreErasure: false,
});

/**
 * Definitional notes that must never be collapsed (§A3.1).
 * These are the substitutions a later stage would otherwise make by accident.
 */
export const P7_REDUCER_TERM_LAWS = Object.freeze({
  completed_count: 'the reducer own folded-row count over its bound population and window; equals durationDistance@1.trip_count by construction — a row names one of them, never both',
  clean_trip_count: 'D1/Achievements definition — isCleanTrip: riskEventCount === 0 && severeEventCount === 0',
  report_clean_trip_count: 'Report definition — harsh_brakes_count, rapid_accel_count, sharp_turns_count and speeding_events_count all zero',
  cleanTripSubstitution: 'forbidden — the two clean predicates are different and are never interchanged',
  scored_trip_count: 'rows whose overall component score is non-null',
  scoreMeanDiscipline: 'score_sum/score_count (plain mean) and score_distance_product/score_distance_weight (distance-weighted) are separate accumulators and are never substituted for one another',
  active_local_days: 'counted without a day set: the scan is ordered by (start_time,id), so same-local-day rows are adjacent; the reducer keeps one last-seen local-day key and increments on change — O(1) in N, exact',
});
