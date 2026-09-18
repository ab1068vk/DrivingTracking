/**
 * P7 Stage 1 — populations, owner-capability law, browser<->native conversions,
 * window/boundary rules and completeness labels (Annex C §C1-§C4).
 *
 * Declaration only. Every Annex C output row names exactly one population code;
 * the blanket `status === 'completed'` default is not sufficient because several
 * current outputs filter further.
 */

/** §C1 — normative defaults. A deviation that is not written down does not exist. */
export const P7_OUTPUT_DEFAULTS = Object.freeze({
  eligibleStatuses: "completed only; status alone is not the population — every row names a §C1a code",
  privacy: "privacy_mode === 'summary_only' rows contribute summary metrics; their route/geometry never contributes; upstream masking is never reversed by a P7 read",
  expiredRoutes: 'a row with route_data_expired_at still contributes summary metrics and no geometry or route-derived metric',
  tombstones: 'a deleted trip contributes nothing in every window immediately after the mutation invalidation; no metric may be served from a cached value that still contains it',
  units: 'distance km at the UI / meters internally; duration ms internally; score 0-100',
  timezone: 'each output keeps the boundary it uses today; D1 browser buckets are UTC day/hour and a local-day output may not be silently re-based onto them',
  nightClassification: 'the persisted per-trip night_driving boolean from the fixed appConstants window; never re-derived under a different timezone basis',
  nullVsZero: 'no eligible trips renders the existing empty state, never 0; unavailable/partial/loading/repair renders its typed state, never 0, 0 km, $0 or an empty chart',
  vehicleReassignment: 'metrics follow the current vehicle_id; reassignment invalidates both vehicles plus the global aggregate',
  completeness: 'EXACT only per Annex A §A1.4; any other state is labelled truthfully per §C4',
});

/** §C1a — the six frozen eligible populations. */
export const P7_POPULATIONS = Object.freeze({
  'P-COMPLETED': Object.freeze({
    definition: "status === 'completed'",
    usedBy: 'outputs that today genuinely use all completed trips',
  }),
  'P-DRIVER': Object.freeze({
    definition: 'P-COMPLETED and isDriverMetricEligible(trip) — excluded_from_driver_score !== true and not a passenger trip',
    source: 'phoneUseSummary.js:107-124',
    usedBy: 'Dashboard analytics, Report body, DrivingCoach, Insights',
  }),
  'P-PROGRESSION': Object.freeze({
    definition: 'P-COMPLETED and distance_km >= progression_min_trip_km (2) and duration_seconds >= progression_min_trip_seconds (180) and finite score_overall',
    source: 'driverProgression.js:795-822',
    usedBy: 'every Achievements progression statistic',
  }),
  'P-SCORETIP': Object.freeze({
    definition: "the row report population and distance_km >= SCORE_TIP_MIN_TRIP_KM and score_confidence >= SCORE_TIP_MIN_CONFIDENCE",
    source: 'tripInsights.js:576-580',
    usedBy: 'Report coaching tips',
  }),
  'P-BASELINE': Object.freeze({
    definition: 'P-COMPLETED and finite score_overall, restricted to scoring-version-comparable trips unless the mixed-provenance rule applies',
    source: 'tripInsights.js:846-888',
    usedBy: 'personal baseline, weekly percentile',
  }),
  'P-PEAKSTRESS': Object.freeze({
    definition: 'P-COMPLETED and distance_km >= PEAK_STRESS_MIN_TRIP_KM',
    source: 'tripInsights.js:956',
    usedBy: 'peak-hour stress',
  }),
});

/**
 * §C1a.0 — owner-capability law. **No row may name a source that cannot express
 * its population.**
 */
export const P7_OWNER_CAPABILITY = Object.freeze({
  'B-D1': Object.freeze({
    what: 'browser P6 D1 buckets (browser:global:2, browser:utc-day:*, browser:utc-hour:*, browser:vehicle:<id>:2)',
    dimensions: 'contributions gated on status === completed; key carries UTC day/hour and vehicle',
    'P-COMPLETED': true, 'P-DRIVER': false,
  }),
  'N-TOT': Object.freeze({
    what: 'native trip_aggregate_totals — what unfiltered aggregates({}) reads',
    dimensions: 'live_count, total_distance (km), total_duration (seconds), score_sum, score_count — updated for EVERY committed record with no status gate',
    'P-COMPLETED': false, 'P-DRIVER': false,
    note: 'an all-live owner; never an exact P-COMPLETED source',
  }),
  'N-BKT': Object.freeze({
    what: 'native trip_aggregate_buckets',
    dimensions: 'keyed (day_start_ms, vehicle_id, status); chartBuckets filters on that status column',
    'P-COMPLETED': 'only when the query actually applies status = completed and visited rows stay bucket/output bounded',
    'P-DRIVER': false,
  }),
  'N-FILTERED': Object.freeze({
    what: 'native filtered aggregates({...}) — COUNT/SUM over trip_current',
    dimensions: 'time / vehicle_id / status, trip-count proportional',
    'P-COMPLETED': false, 'P-DRIVER': false,
    note: 'forbidden by §C6 regardless of population',
  }),
  Q1: Object.freeze({
    what: 'bounded page / date-range scan',
    dimensions: 'evaluates any row predicate on the fetched rows',
    'P-COMPLETED': true, 'P-DRIVER': true,
  }),
  Q10: Object.freeze({
    what: 'named reducers',
    dimensions: 'evaluate the predicate on the canonical record during the bounded scan',
    'P-COMPLETED': true, 'P-DRIVER': true,
  }),
});

/** Sources a P-DRIVER row may never name (§C1a.0 consequence 1). */
export const P7_FORBIDDEN_DRIVER_SOURCES = Object.freeze(['B-D1', 'N-TOT', 'N-BKT', 'N-FILTERED', 'Q4', 'Q5']);

/** Sources that may never be presented as an exact P-COMPLETED total (§C1a.0 consequence 2). */
export const P7_FORBIDDEN_COMPLETED_SOURCES = Object.freeze(['N-TOT', 'N-FILTERED']);

/**
 * §C1a.1 — the one projection addition P7 proposes, in full. An implementer may
 * add no other projection field anywhere in P7.
 *
 * NOTE FOR SEQUENCING: Stage 1 freezes this contract only. The physical
 * projection-schema mutation (TRIP_PROJECTION_VERSION 1 -> 2) belongs to the
 * later approved implementation point, because Stage 1 must honour
 * NO PRODUCTION BEHAVIOUR CHANGE.
 */
export const P7_DRIVER_ELIGIBILITY_CONTRACT = Object.freeze({
  field: 'driver_metric_eligible',
  type: 'boolean',
  sourceCanonicalFields: Object.freeze([
    'excluded_from_driver_score', 'was_driver', 'wasDriver', 'driver_role', 'trip_role',
    'passenger_trip', 'data_quality_flags',
  ]),
  derivation: 'exactly isDriverMetricEligible(trip) (phoneUseSummary.js:122-124), evaluated at projection-build time against the canonical record',
  whyDerivedBoolean: 'it is the only value any consumer reads; carrying the raw role/flag fields would widen the projection surface and let every consumer re-implement the predicate',
  privacy: 'one boolean with no location, address, note or free text; strictly less revealing than fields the projection already carries; no new key material and no new plaintext at rest beyond the existing envelope',
  consumers: Object.freeze(['Dashboard (#2)', 'Report (#8)', 'DrivingCoach (#4)', 'Insights (#5)', 'any Q10 reducer whose row names P-DRIVER']),
  schemaImpact: 'TRIP_PROJECTION_VERSION 1 -> 2, one BOOL entry, a bound class entry, a parity test and a maximal-envelope fixture update',
  migration: 'stale rows are repaired by the existing page-bounded projection repair path, exactly as any other projection version bump',
  isNot: Object.freeze(['a canonical field', 'a P3.5 change', 'a second eligibility authority', 'a new store or writer']),
  untilItExists: 'no migrated consumer may claim P-DRIVER semantics from a projection row; Q10 reducers are unaffected because they scan canonical records',
  physicalSchemaMutationStage: 'later approved implementation point, not Stage 1',
});

/**
 * §C2 — frozen browser <-> native conversions. Both authorities must present
 * equal outputs **after** these explicit normalizations, or a typed
 * unsupported/partial disposition.
 */
export const P7_AUTHORITY_CONVERSIONS = Object.freeze({
  distance: Object.freeze({
    browserOwner: 'D1 totalKm — kilometres',
    nativeOwner: 'total_distance / bucket total_distance — kilometres',
    commonInternalUnit: 'meters',
    rule: 'browser totalKm x 1000 -> m; native total_distance x 1000 -> m; convert back to km once, at the UI',
  }),
  duration: Object.freeze({
    browserOwner: 'not keyed by D1 — durationDistance@1.duration_ms or dashboard.activityStats@1.driving_seconds',
    nativeOwner: 'total_duration / bucket total_duration — seconds',
    commonInternalUnit: 'milliseconds',
    rule: 'native total_duration x 1000 -> ms; a reducer emitting driving_seconds likewise x 1000 -> ms',
  }),
  scoreMean: Object.freeze({
    browserOwner: 'D1 scoreDistanceProduct / scoreDistanceWeight (distance-weighted)',
    nativeOwner: 'score_sum / score_count (plain mean)',
    rule: 'different metrics, never interchanged; the page existing semantics win',
  }),
  dayGrouping: Object.freeze({ rule: 'identical UTC basis on both; a local-day output uses §C3 rule 3' }),
  eligibility: Object.freeze({ rule: 'identical; both exclude non-completed' }),
  statusPrivacy: Object.freeze({ rule: 'identical predicate set; any divergence is unavailable FILTER_UNSUPPORTED with no data (never a generic PARTIAL), never a silent difference' }),
  boundaryRows: Object.freeze({ rule: 'half-open ranges [from, to) on both authorities' }),
  standingRule: 'no row may assume a native aggregate value is already in the common internal unit; the x1000 conversions are applied in the facade, once, before any comparison',
});

/** §C3 — window / boundary rules, frozen per output (OQ-3). */
export const P7_WINDOW_RULES = Object.freeze([
  'a complete date-labelled window queries its complete date window — never the newest N trips — subject to the owner-capability law',
  'a trip-count window is labelled "latest N" (and "at least N" while a bounded scan has not reached its end); a user-visible window size is product semantics',
  'a local-day output is served by a reducer reading the stored per-trip local-offset evidence, or is explicitly declared UTC-grouped in the UI; silently serving a local-day label from a UTC bucket is forbidden',
  'lifetime / all-time remains EXACT and is never relabelled as a sample to make it bounded',
  'a blanket "last 200" relabel of a page is forbidden; semantics are frozen per output, not per page',
]);

/** §C4 — UI labels by completeness. */
export const P7_COMPLETENESS_LABELS = Object.freeze({
  exact_lifetime: 'the existing exact label ("All time", "Lifetime")',
  exact_date_window: 'the existing date label ("This month", "Last 30 days")',
  exact_trip_count_window: '"latest N"',
  partial: '"at least N — more available", plus the explicit continue/finish affordance',
  owner_not_ready: 'NOT generic PARTIAL — the verbatim p6Readiness plus unavailable OWNER_NOT_READY; readiness-driven wording ("Updating...", "Rebuilding...", "Data not ready"); never a zero, an empty result, an exact total, or a fabricated continuation',
  unavailable_other: 'the typed unavailable state — never a number, never an empty list, never a continuation',
  loading: 'a loading state visually distinct from empty',
});

/**
 * §C6 — native filtered Q4. Delegating a filtered aggregate to the
 * trip-count-proportional trip_current COUNT/SUM and calling it bounded is
 * forbidden.
 */
export const P7_NATIVE_FILTERED_AGGREGATE_RULE = Object.freeze({
  allowed: Object.freeze([
    'sum the existing pre-aggregated trip_aggregate_buckets rows so visited rows are bounded by the bucket/output range',
    'use another existing-owner indexed read whose visited rows are output-bounded',
    "return unavailable { code: 'FILTER_UNSUPPORTED' } with no data and no continuation, after which the page composition selects the Q10 reducer its matrix row names",
  ]),
  forbidden: 'a filtered COUNT/SUM over trip_current presented as a bounded Q4',
  genericPartialAllowed: false,
  proofObligation: 'EXPLAIN QUERY PLAN plus observed row visits must show filtered native aggregation never visits a trip-count-proportional row set',
  permittedAdditiveChange: 'expose a vehicleId filter parameter on queryHistoryPage over the already-existing trip_current_vehicle_status_idx, for Q1 row selection only — no schema change',
});
