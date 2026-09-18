/**
 * The authoritative P7 consumer ledger, and the P3 bounded-consumer manifest it
 * evolved from.
 *
 * `BOUNDED_CONSUMER_MANIFEST` is retained **verbatim** as the projection
 * subrecord for the 11 consumers it already models, so no existing branch-parity
 * or mutation-testing coverage is lost. `P7_CONSUMER_LEDGER` below is the single
 * authoritative ledger of all **30** production consumers (Annex B); it is an
 * evolution of the manifest, never a parallel document, and it references the
 * manifest rather than copying it.
 *
 * Frozen at exactly 30 unique consumers (25 pages + 5 non-page). No entry may be
 * added, merged or removed without a new review decision.
 */

/**
 * Literal bounded-consumer manifest (P3).
 *
 * Every entry is an exact production symbol, not a descriptive label. These are
 * the call sites that operate on the **limited** query result before their
 * full-history companion query settles, so they must behave identically whether
 * they receive a `TripProjection` v1, a legacy summary, or a full trip.
 *
 * A loaded-module set is deliberately **not** used as the completeness oracle:
 * a static ESM import loads a module whose branch never runs, and a new field
 * read inside an already-imported module changes no loaded set. Completeness is
 * proved by branch-complete parity plus mutation testing instead.
 */

export const BOUNDED_CONSUMER_MANIFEST = Object.freeze([
  {
    page: 'src/pages/Dashboard.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: [
      'usePendingPostDriveReview', 'speedLimitReviewNeededForTrip', 'getScoreProvenanceStatus',
      'getTripComponentScore', 'buildOnDeviceDriverModel', 'buildDriverSignature',
      'getTodayTrips', 'dispatchTripCompletedNotification', 'checkAndNotifyPhoneUsePattern',
      'DashboardRiskPanel', 'buildAlertDangerZones', 'processDriverProgressionAfterTrip',
    ],
    requiredFields: [
      'aggressive_driving_score', 'aggressive_grade', 'avg_running_speed_kmh', 'avg_speed_kmh',
      'braking_efficiency_score', 'close_proximity_count', 'component_scores',
      'cornering_consistency_score', 'created_at', 'distance_km', 'duration_seconds',
      'emergency_heavy_braking_count', 'end_time', 'engine_stress_score', 'harsh_brakes_count',
      'harsh_merge_count', 'heading_drift_beta_level', 'id', 'merge_event_count',
      'night_driving', 'obd_powertrain_sample_count', 'overall_compliance_score',
      'phone_use_high_confidence_count', 'phone_use_pct_of_trip', 'phone_use_risk',
      'phone_use_score_available', 'phone_use_total_seconds', 'poor_merge_count',
      'rapid_accel_count', 'safety_condition_bonus', 'score_overall', 'score_provenance',
      'score_smoothness', 'score_version', 'sharp_turns_count', 'speed_limit_review_required',
      'speed_limit_review_resolved_at', 'speeding_events_count', 'start_time', 'status',
      'stop_start_pattern_count', 'stop_start_pattern_score', 'trip_utc_offset_minutes',
    ],
  },
  {
    page: 'src/pages/TripHistory.jsx',
    query: 'limitedTripSummaryQueryOptions(100)',
    entryPoints: [
      'buildTripSearchText', 'getEffectiveTripTags', 'inferTripTags', 'buildTripTagCounts',
      'calculateRecentBrakingImprovement', 'TripCard', 'PremiumTripCard',
    ],
    requiredFields: [
      'avg_running_speed_kmh', 'avg_speed_kmh', 'braking_efficiency_score', 'created_at',
      'distance_km', 'dominant_road_type', 'duration_seconds', 'end_address',
      'harsh_brakes_count', 'id', 'is_favorite', 'nickname', 'night_classification',
      'night_driving', 'notes', 'phone_use_window_count', 'privacy_mode', 'rapid_accel_count',
      'road_type', 'route_key', 'score_overall', 'score_safety', 'score_smoothness',
      'sharp_turns_count', 'slippery_proxy', 'speeding_events_count', 'start_address',
      'start_time', 'status', 'tag', 'tag_sources', 'tags', 'vehicle_id', 'weather_context',
    ],
  },
  {
    page: 'src/pages/Insights.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: ['buildAdvancedInsights', 'buildAdvancedInsightIntelligence', 'answerDriveQuestion'],
    requiredFields: [
      'aggressive_driving_score', 'avg_running_speed_kmh', 'avg_speed_kmh',
      'brake_onset_smoothness_grade', 'braking_efficiency_grade', 'braking_efficiency_score',
      'component_scores', 'created_at', 'distance_km', 'dominant_road_type',
      'duration_seconds', 'end_time', 'engine_stress_score', 'harsh_brakes_count', 'id',
      'night_driving', 'obd_powertrain_sample_count', 'parking_approach_grade',
      'parking_stop_duration_seconds', 'phone_use_high_confidence_count',
      'phone_use_pct_of_trip', 'phone_use_risk', 'phone_use_score',
      'phone_use_score_available', 'phone_use_score_status', 'phone_use_summary',
      'phone_use_total_seconds', 'phone_use_window_count', 'rapid_accel_count', 'road_type',
      'route_key', 'route_points_map_count', 'route_replay_available', 'score_overall',
      'score_provenance', 'score_smoothness', 'score_version', 'sharp_turns_count',
      'speeding_events_count', 'start_time', 'status', 'stop_count', 'svi_label', 'vehicle_id',
      'wall_clock_duration_seconds', 'weather_context',
    ],
  },
  {
    page: 'src/pages/DrivingCoach.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: [
      'buildDrivingCoachInsights', 'buildCoachRecommendations', 'buildCoachEvidenceAudit',
      'buildCoachProgramProgress', 'buildDriverSignature', 'buildOnDeviceDriverModel',
      'scoreTripAnomaly', 'buildHabitProfile', 'buildRouteComparisons', 'buildCoachRouteOptions',
      'buildCoachSegmentInsights', 'buildPreTripBriefing',
    ],
    requiredFields: [
      'aggressive_driving_score', 'avg_running_speed_kmh', 'avg_speed_kmh',
      'brake_onset_smoothness_grade', 'braking_efficiency_grade', 'braking_efficiency_score',
      'created_at', 'distance_km', 'dominant_road_type', 'duration_seconds', 'end_time',
      'engine_stress_score', 'harsh_brakes_count', 'id', 'obd_powertrain_sample_count',
      'phone_use_pct_of_trip', 'phone_use_risk', 'phone_use_score_available',
      'phone_use_summary', 'rapid_accel_count', 'route_key', 'score_overall',
      'score_provenance', 'score_smoothness', 'score_version', 'sharp_turns_count',
      'speeding_events_count', 'start_time', 'status', 'svi_label',
    ],
  },
  {
    page: 'src/pages/Achievements.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: ['buildDriverProgression', 'processDriverProgressionAfterTrip'],
    requiredFields: [
      'braking_efficiency_score', 'component_scores', 'cornering_consistency_score',
      'created_at', 'distance_km', 'dominant_road_type', 'duration_seconds',
      'emergency_heavy_braking_count', 'end_time', 'harsh_brakes_count', 'id', 'night_driving',
      'overall_compliance_score', 'phone_use_high_confidence_count', 'phone_use_risk',
      'phone_use_score_available', 'rapid_accel_count', 'road_type', 'route_key',
      // HPR-009 (Wave 2). Progression labels a form score by how it was produced,
      // so the provenance travels with the rows it summarizes; without it the
      // page would read `undefined` and silently present every score as exact.
      'score_overall', 'score_provenance', 'score_smoothness', 'sharp_turns_count',
      'speeding_events_count', 'start_time', 'status',
    ],
  },
  {
    page: 'src/pages/Vehicles.jsx',
    query: 'limitedTripSummaryQueryOptions(100)',
    entryPoints: [
      'getUnassignedCompletedTrips', 'getTripsNeedingVehicleReview',
      'buildFleetIntelligence', 'suggestVehicleForTrip', 'VehicleCompare',
    ],
    requiredFields: [
      'distance_km', 'end_time', 'id', 'route_key', 'score_overall', 'start_time', 'status',
      'vehicle_assignment_status', 'vehicle_id',
    ],
  },
  {
    page: 'src/pages/TrackingEvents.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: ['formatTripLabel', 'FilterSelect'],
    requiredFields: [
      'distance_km', 'id', 'start_time',
    ],
  },
  {
    page: 'src/pages/TrackingEvidenceConsole.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    // Picker only. Evidence and session construction are detail-required: the
    // compact projection omits `score_provenance.components` and
    // `constants_snapshot`, so feeding it in would render a false "unavailable".
    entryPoints: ['formatTripLabel'],
    requiredFields: [
      'distance_km', 'id', 'start_time', 'status',
    ],
    detailRequired: ['buildTrackingEvidenceConsoleData', 'buildSessionEvidenceRows'],
  },
  {
    page: 'src/pages/TrackingMapWorkspace.jsx',
    query: 'limitedTripSummaryQueryOptions(50)',
    entryPoints: ['filteredSummaries', 'PaneHeader', 'loadDangerZones'],
    // The saved-filter predicate reads the event counters and the night flag
    // directly, so the compact projection must carry them for this page.
    requiredFields: [
      'harsh_brakes_count', 'id', 'night_driving', 'privacy_mode', 'rapid_accel_count',
      'route_data_expired_at', 'route_replay_available', 'sharp_turns_count',
      'speeding_events_count', 'start_time', 'status',
    ],
  },
  {
    page: 'src/pages/Trip3DReplay.jsx',
    query: 'limitedTripSummaryQueryOptions(PICKER_LIMIT)',
    entryPoints: ['getTripDisplayName', 'formatDate', 'replayableSummary'],
    requiredFields: [
      'end_address', 'id', 'nickname', 'privacy_mode', 'route_data_expired_at',
      'route_replay_available', 'start_address', 'start_time',
    ],
  },
  {
    page: 'src/pages/Diagnostics.jsx',
    query: 'tripService.listSummaries({ limit: 20 })',
    entryPoints: ['latestTripSummary', 'tripDetailQueryOptions'],
    requiredFields: [
      'id', 'start_time', 'status',
    ],
  },
]);

/** Shared components that must accept projection, legacy summary and full trip. */
export const DUAL_SHAPE_COMPONENTS = Object.freeze([
  'asTripListModel', 'TripCard', 'PremiumTripCard', 'PremiumMapTripCard',
  'getTripDisplayName', 'getTripWeatherBadge', 'normalizeTripTags',
  'getTripComponentScore', 'formatScoreWithProvenance',
]);

/** Branch values every load-bearing field must be exercised with. */
export const REQUIRED_BRANCH_VALUES = Object.freeze([
  'missing', 'null', 'zero', 'false', 'empty-string', 'valid', 'fallback', 'malformed', 'alternate',
]);

/** Every field any bounded consumer requires, deduplicated. */
export const requiredProjectionFields = () => Array.from(new Set(
  BOUNDED_CONSUMER_MANIFEST.flatMap((entry) => entry.requiredFields)
));

// ---------------------------------------------------------------------------
// P7 authoritative consumer ledger (Annex B). Frozen at exactly 30 entries.
// ---------------------------------------------------------------------------

/** Projection subrecord that defers to the retained P3 manifest entry. */
const fromManifest = (page) => Object.freeze({ source: 'BOUNDED_CONSUMER_MANIFEST', page });
/** Projection subrecord frozen in Annex B section B6 for a consumer the manifest never modelled. */
const b6 = (section, requiredFields, note) => Object.freeze({
  source: section, requiredFields: Object.freeze(requiredFields), note,
});
/** A consumer whose data is one trip fetched by id: the full Q2 record, no projection set. */
const detailOnly = (section, note) => Object.freeze({
  source: section, detailOnly: true, requiredFields: Object.freeze([]), note,
});

const entry = (n, consumer, compositionKey, inputs, qGraph, projection, caps, semantics, invalidation, legacy) => Object.freeze({
  n,
  consumer,
  compositionKey,
  inputs: Object.freeze(inputs),
  qGraph: Object.freeze(qGraph),
  projection,
  caps: Object.freeze(caps),
  semantics,
  invalidation: Object.freeze(invalidation),
  authority: 'both',
  legacy,
});

/**
 * Caps are **per composition** and every one of them is fixed by UX, never by N.
 * `detail` = full Q2 records; `overview` = Q3 tracks; `d2` = Q8 by-id batches;
 * `secondary` = the declared maximum secondary lookups; `cold` / `refetch` are
 * the cold-cache and refetch budgets.
 */
export const P7_CONSUMER_LEDGER = Object.freeze([
  entry(1, 'src/pages/Achievements.jsx', "['p7','page','achievements',<params>,<srcB>]",
    ['settings hash', 'vehicle scope'],
    ['Q9', 'progression/XP ledger facts', 'Q4', 'Q1', 'Q10:p7.progression.records@1'],
    fromManifest('src/pages/Achievements.jsx'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q9 1 + Q4 <=2 + Q10 <=1 turn', cold: '1 composition', refetch: 'on achv/aggregate/history events' },
    'lifetime EXACT; recent window labelled; records PARTIAL until EOF',
    ['page', 'achievements', 'aggregate', 'reduce'],
    '(50)+(200) pair -> retire'),

  // Transcription correction, applied under the governing law rather than by
  // re-planning. This row was first transcribed with `Q4 (single-day today)`
  // and no Q10 term. Annex C O05 says **Q1 only** for "today" and records the
  // reason — "not a UTC bucket read (C3.3): the surface is local-day" — and
  // O03/O06 (driving time, active local days, longest trip) are Q10 terms no
  // aggregate owner keys. A UTC day bucket cannot express a local day, so the
  // substitution would change the number on screen. The graph below is the one
  // Annex C's own rows declare; the acquisition count is unchanged.
  entry(2, 'src/pages/Dashboard.jsx', "['p7','page','dashboard',<params>,<srcB>]",
    ['period selection', 'today local-day'],
    ['Q1', 'Q1 (single local day)', 'Q4 (lifetime totals)', 'Q10:p7.dashboard.activityStats@1'],
    fromManifest('src/pages/Dashboard.jsx'),
    { detail: 2, overview: 0, d2: 0, secondary: 'Q1 2 + Q4 1 + Q10 <=1 turn', cold: '1 composition', refetch: 'focus/resume: 1' },
    'lifetime EXACT; "today" exact single local day; Q10 terms EXACT at EOF else at-least-N',
    ['page', 'history', 'aggregate', 'detail'],
    '(50)+(200) + ad-hoc listSummaries -> retire'),

  entry(3, 'src/pages/Diagnostics.jsx', "['p7','page','diagnostics',<params>,<srcB>]",
    [],
    ['Q1', 'Q2 (1 selected trip)'],
    fromManifest('src/pages/Diagnostics.jsx'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q1 1 + Q2 1', cold: '1 composition', refetch: 'manual only' },
    'window labelled',
    ['page', 'history', 'detail'],
    'duplicate (20)+(20) -> retire'),

  // Transcription refinement under §C1a.0, of the same class as entries #2 and
  // #5. The Q4 cell stands for the `P-COMPLETED` half of O21's evidence audit
  // (`totalCompleted`), which the D1 owner can express exactly. The `P-DRIVER`
  // half (`driverEligible`) cannot come from any aggregate owner, so the Q10
  // reducer O21 names is added explicitly rather than left implicit in prose.
  entry(4, 'src/pages/DrivingCoach.jsx', "['p7','page','driving-coach',<params>,<srcB>]",
    ['window horizon (declared)', 'program filters'],
    ['Q1', 'Q4 (P-COMPLETED lifetime)', 'Q10:p7.report.durationDistance@1 (P-DRIVER lifetime)', 'Q2 x<=5'],
    fromManifest('src/pages/DrivingCoach.jsx'),
    { detail: 5, overview: 0, d2: 0, secondary: 'Q1 1 + Q4 1 + Q10 <=1 turn + Q2 <=5', cold: '1 composition', refetch: 'on mutation' },
    'per-output: all-drives/historical counts exact via Q4/Q10; recent analyses labelled "latest N"',
    ['page', 'history', 'aggregate', 'detail'],
    '(50)+(200) -> retire'),

  // Transcription correction, applied under the governing law rather than by
  // re-planning, and of the same class as entry #2's. This row was first
  // transcribed with `Q4` and `Q5` cells. Every windowed Insights output is
  // `P-DRIVER` (`advancedInsights.js:181`, `advancedInsightIntelligence.js:295,
  // 348`), and Annex C §C1a.0 forbids sourcing that population from Q4 or Q5 --
  // the plan applies the same law when it strikes O20/O21's Q4/Q5 alternatives.
  // The calendar is `P-COMPLETED` but keys **local** days
  // (`mediumInsights.js:196`), which a UTC bucket cannot express (§C3.3). So
  // every window here is a bounded Q1 range scan. The acquisition count is
  // unchanged: three bounded Q1 reads in place of `Q1 1 + Q4 <=2 + Q5 1`.
  entry(5, 'src/pages/Insights.jsx', "['p7','page','insights',<params>,<srcB>]",
    ['date window', 'granularity'],
    ['Q1 (analysis window)', 'Q1 (calendar grid)', 'Q1 (newest row)', 'Q2 x<=12'],
    fromManifest('src/pages/Insights.jsx'),
    { detail: 12, overview: 0, d2: 0, secondary: 'Q1 3 + Q2 <=12', cold: '1 composition', refetch: 'on mutation' },
    'date-window outputs query the complete date window; a window read short of its end is PARTIAL and says so',
    ['page', 'history', 'aggregate', 'buckets', 'detail'],
    '(50)+(200) -> retire'),

  entry(6, 'src/pages/MapScreen.jsx', "['p7','page','map-screen',<params>,<srcB>]",
    ['filter', 'cursor'],
    ['Q8', 'Q3 (selected)', 'Q2 (selected, full fidelity only)'],
    b6('B6.1', [
      'id', 'status', 'start_time', 'end_time', 'distance_km', 'route_data_expired_at',
      'route_replay_available', 'route_points_map_count', 'night_driving',
      'harsh_brakes_count', 'route_key', 'nickname', 'tag', 'score_provenance',
    ], 'route_points / route_points_raw_count / driving_events are NOT list fields: selected trip only (Q2/Q3, cap 1) and Q8 previews'),
    { detail: 1, overview: 1, d2: '1 page <=80 trips', secondary: 'Q8 1 + Q3 1 + Q2 <=1', cold: '1 composition', refetch: 'on geometry/history events' },
    'viewport PARTIAL / more available until scan end',
    ['page', 'geometry', 'detail'],
    '(200) + x8 detail fan-out -> retire'),

  entry(7, 'src/pages/PrivacyIntelligence.jsx', 'one loadPrivacyIntelligence composition held in page state (B7.1)',
    [],
    ['existing runBoundedTripJob archive scan (retained, filters before the bound)'],
    Object.freeze({ source: 'B7.1', streamed: true, requiredFields: Object.freeze([]) }),
    {
      detail: '0 (streamed, 1 resident)', overview: 0, d2: 0,
      secondary: 'BOUNDED_JOB_PAGE_SIZE 50; pages per run ceil(completedN/50); exactly one trip resident; resume:false',
      cold: '1 composition = 1 full pass',
      refetch: '<=1 pass per 30 s (PRIVACY_INTELLIGENCE_CACHE_MS), shared with #16',
    },
    'scan totals are EXACT when the pass completes; a cancelled pass is reported, never rendered as 0',
    ['page'],
    'none - P7 changes nothing here'),

  // Transcription correction, the same class as entries #2, #4 and #5. The Q4
  // and Q5 cells cannot serve this page: every Annex C Report row (O42-O75) is
  // **P-DRIVER**, which §C1a.0 forbids sourcing from an aggregate owner, and
  // the row table assigns each one a named Q10 reducer. Q1 was missing and is
  // added: O52's two calendar baseline windows, O60's export scan, and the two
  // bounded edge rows that give the period its observed bounds. The reducer
  // cap below is one bounded turn per named reducer per window, which is what
  // this row's own reducer list already implies.
  entry(8, 'src/pages/Report.jsx', "['p7','page','report',<params>,<srcB>]",
    ['period', 'vehicle', 'units'],
    ['Q1 (O52 baseline, O60 export, period bounds)', 'Q10 (eventTotals, durationDistance, nightExposure, economics, bucketProfiles, fatigue, dailySeries, monthlyEventTrend, summaryExtrema, scoreTipTotals, ubi.terms, dashboard.activityStats, progression.records)'],
    b6('B6.2', [
      'status', 'driver_metric_eligible', 'start_time', 'distance_km', 'duration_seconds',
      'score_overall', 'score_confidence', 'score_version', 'score_provenance',
      'harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count', 'speeding_events_count',
      'heading_deviation_count', 'stop_start_pattern_count', 'distraction_events_count',
      'avg_running_speed_kmh', 'avg_speed_kmh', 'svi_score', 'road_type', 'city_crawl_ratio',
      'optimal_band_ratio', 'high_speed_ratio', 'co2_saved_kg', 'vehicle_id', 'nickname', 'id',
    ], 'reducer input fields, not Q1 list rows: after migration Report holds no trip array. highway/urban/residential compliance and route_points are unavailable on the bounded path - O58/O59 stay frozen in their current empty state'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q1 <=3 + Q10 <=15 (1 bounded turn each: 10 current window, 2 prior window, 6-month trend, 12-month mileage, lifetime records)', cold: '1 composition', refetch: 'on mutation' },
    'All time EXACT only from terminal Q10 on every row; otherwise PARTIAL, and an export refuses a scan short of EOF',
    ['page', 'history', 'reduce'],
    '(200) all-time sample -> retire'),

  entry(9, 'src/pages/Settings.jsx', "['p7','page','settings',<section>,<srcB>]",
    ['active settings section'],
    ['Q10:p7.settings.scoreMigrationSummary@1', 'Q1', 'Q3 (corridor, capped)', 'explicit B7 export', 'explicit B10 rescore'],
    b6('B6.3', ['id', 'start_time', 'status'],
      'corridor Q1 rows only; corridor geometry is Q3 getOverview(id, PRIVACY_CORRIDOR_MAX_WAYPOINTS) under the fixed cap, stopping as soon as a trip yields >=2 finite points. B9 reads no trip rows at all'),
    { detail: 0, overview: '<=PRIVACY_CORRIDOR cap (fixed)', d2: 0, secondary: 'Q10 1 turn + Q1 1 + Q3 <=cap', cold: '1 composition per section', refetch: 'on section change' },
    'migration summary PARTIAL until EOF; corridor stops at its cap',
    ['page', 'reduce', 'analyticsSettings'],
    'B9 getScoreMigrationSummary -> retire; B5 list({limit:20}) -> retire; B7/B10 explicit only'),

  entry(10, 'src/pages/SpeedAnalysis.jsx', "['p7','page','speed-analysis',<id>,<srcB>]",
    ['trip id'],
    ['Q2'],
    detailOnly('B6.4', 'one Q2 record for the routed trip id; route_points, driving_events and per-trip speed fields come from that record'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q2 1', cold: '1 composition', refetch: 'on detail edit' },
    'per-trip exact',
    ['page', 'detail'],
    'none'),

  entry(11, 'src/pages/SpeedLimits.jsx', "['p7','page','speed-limits',<params>,<srcB>]",
    ['filter', 'cursor', 'viewport'],
    ['Q8', 'Q2 (selected)', 'scoped D4 reads (unchanged)'],
    b6('B6.5', ['id', 'start_time', 'status', 'privacy_mode', 'route_data_expired_at'],
      'exactly the eligibility filter listForSpeedMap applies today; geometry comes from the Q8 D2 by-id batch'),
    { detail: 1, overview: 0, d2: '1 page <=80 trips', secondary: 'Q8 1 + Q2 <=1', cold: '1 composition', refetch: 'focus (existing)' },
    'at least N, more available - never a synthesized total',
    ['page', 'geometry', 'detail'],
    'B6 routine listForSpeedMap -> retire'),

  entry(12, 'src/pages/TrackingEvents.jsx', "['p7','page','tracking-events',<params>,<srcB>]",
    ['window'],
    ['Q1', 'Q2 (selected only)'],
    fromManifest('src/pages/TrackingEvents.jsx'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q1 1 + Q2 <=1', cold: '1 composition', refetch: 'on mutation' },
    'window labelled',
    ['page', 'history', 'detail'],
    '(50) -> migrate'),

  entry(13, 'src/pages/TrackingEvidenceConsole.jsx', "['p7','page','evidence-console',<params>,<srcB>]",
    ['window'],
    ['Q1', 'Q2 (selected only)'],
    fromManifest('src/pages/TrackingEvidenceConsole.jsx'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q1 1 + Q2 <=1', cold: '1 composition', refetch: 'on mutation' },
    'window labelled',
    ['page', 'history', 'detail'],
    '(50) -> migrate'),

  entry(14, 'src/pages/TrackingMapWorkspace.jsx', "['p7','page','map-workspace',<params>,<srcB>]",
    ['filter', 'cursor'],
    ['Q8', 'Q3 (selected)'],
    fromManifest('src/pages/TrackingMapWorkspace.jsx'),
    { detail: 0, overview: 1, d2: '1 page <=80 trips', secondary: 'Q8 1 + Q3 <=1', cold: '1 composition', refetch: 'on geometry events' },
    'viewport PARTIAL',
    ['page', 'geometry'],
    '(50) + x6 detail fan-out -> retire'),

  entry(15, 'src/pages/TrackingOverview.jsx', "['p7','page','tracking-overview',<params>,<srcB>]",
    ['window'],
    ['Q1', 'Q4 (totals)'],
    b6('B6.6', [
      'id', 'status', 'start_time', 'nickname', 'tag', 'distance_km', 'duration_seconds',
      'score_overall', 'harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count',
      'speeding_events_count', 'privacy_mode', 'route_data_expired_at', 'route_points_map_count',
      'phone_use_window_count', 'score_confidence_label', 'score_safety_confidence', 'score_provenance',
    ], 'driving_events / route_points are NOT list fields; week totals come from Q4, not a second row read'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q1 1 + Q4 <=2', cold: '1 composition', refetch: 'existing focus/interval, de-duplicated' },
    'totals EXACT from Q4; list labelled',
    ['page', 'history', 'aggregate'],
    '(200) + double compute -> retire'),

  entry(16, 'src/pages/TrackingPrivacyConsole.jsx', "['tracking-privacy-console']",
    [],
    ['the same retained bounded job, sharing the #7 30 s module cache'],
    Object.freeze({ source: 'B7.2', streamed: true, requiredFields: Object.freeze([]) }),
    {
      detail: '0 (streamed, 1 resident)', overview: 0, d2: 0,
      secondary: 'identical to B7.1',
      cold: '1 composition = at most 1 pass (or a cache hit)',
      refetch: '<=1 pass per 30 s, shared with #7 - two open privacy surfaces still produce ONE archive pass',
    },
    'as #7',
    ['page'],
    'none'),

  entry(17, 'src/pages/TrackingReplayPro.jsx', "['p7','page','replay-pro',<params>,<srcB>]",
    ['picker window', 'selected pair'],
    ['Q1 (picker projections)', 'Q2 x<=2 (selected pair only)'],
    b6('B6.7', [
      'id', 'status', 'nickname', 'tag', 'start_time', 'distance_km',
      'privacy_mode', 'route_data_expired_at', 'route_points_map_count', 'route_replay_available',
    ], 'availability and point count use route_points_map_count (+ route_replay_available), the substitution MapScreen and tripSummary already make; the picker performs ZERO full-trip decrypts, and exact point fidelity resolves on the <=2 selected Q2 fetches'),
    { detail: 2, overview: 0, d2: 0, secondary: 'Q1 1 + Q2 <=2', cold: '1 composition', refetch: 'on mutation' },
    'picker labelled "latest N"',
    ['page', 'history', 'detail'],
    'B4 list({limit:120}) -> retire'),

  entry(18, 'src/pages/TrackingReportsLab.jsx', "['p7','page','reports-lab',<params>,<srcB>]",
    ['period', 'filters'],
    ['Q4', 'Q5', 'Q10', 'export = explicit bounded id/payload stream'],
    b6('B6.8', [], 'no projection row contract: page metrics come from Q4/Q5/Q10 (same reducer inputs as B6.2 for shared terms); the export streams ids -> Q2, one resident. NO render-time trip array at any size'),
    { detail: '0 at render', overview: 0, d2: 0, secondary: 'Q4 <=3 + Q5 1 + Q10 <=4; export streams ids, 1 resident', cold: '1 composition', refetch: 'on mutation' },
    'report metrics exact/partial per output; export exact at terminal EOF',
    ['page', 'aggregate', 'buckets', 'reduce'],
    'B3 list({limit:250}) -> retire'),

  entry(19, 'src/pages/TrackingTripDetail.jsx', "['p7','page','tracking-trip-detail',<id>,<srcB>]",
    ['trip id', 'comparison id'],
    ['Q2 (1)', 'Q6 (comparison candidates)', 'Q2 (1 comparison)'],
    b6('B6.9', ['id', 'start_time', 'nickname', 'tag'],
      'the detail itself is a full Q2 record; the comparison select needs only these four, supplied by Q6 adjacency candidates under the <=2 cap - never a 100-row summary read'),
    { detail: 2, overview: 1, d2: 0, secondary: 'Q2 <=2 + Q6 <=1', cold: '1 composition', refetch: 'on detail edit' },
    'per-trip exact',
    ['page', 'detail'],
    '(100) summary read for a select -> retire'),

  entry(20, 'src/pages/TrackingTripHistory.jsx', "['p7','page','tracking-trip-history',<params>,<srcB>]",
    ['sort', 'status', 'range', 'filter', 'cursor'],
    ['Q1', 'Q4 (footer totals)', 'Q10:p7.history.filteredTotals@1 when unsupported'],
    b6('B6.10', [
      'id', 'status', 'start_time', 'nickname', 'tag', 'distance_km', 'duration_seconds',
      'harsh_brakes_count', 'rapid_accel_count', 'sharp_turns_count', 'speeding_events_count',
      'privacy_mode', 'route_data_expired_at', 'route_points_map_count',
    ], 'vehicle_name resolves from the page existing bounded vehicle list joined on vehicle_id (a non-trip read it already performs); privacy_zone_touched is not a projection field, so the private filter is served by the existing privacy_mode evidence exactly as today'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q1 1 + Q4 <=1 + Q10 <=1 turn', cold: '1 composition', refetch: 'on mutation' },
    'footer totals EXACT via Q4, else truthful PARTIAL - never a 200-row recompute',
    ['page', 'history', 'aggregate', 'reduce'],
    '(200) + footer recompute -> retire'),

  entry(21, 'src/pages/Trip3DReplay.jsx', "['p7','page','trip-3d-replay',<params>,<srcB>]",
    ['picker window', 'selected id'],
    ['Q1 (picker)', 'Q2 (selected only)'],
    fromManifest('src/pages/Trip3DReplay.jsx'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q1 1 + Q2 <=1', cold: '1 composition', refetch: 'on mutation' },
    'picker labelled',
    ['page', 'history', 'detail'],
    '(80) picker -> migrate'),

  entry(22, 'src/pages/TripDetail.jsx', "['p7','page','trip-detail',<id>,<srcB>]",
    ['trip id'],
    ['Q2 (1)', 'Q7 (tag context)', 'Q6 (prev/next)', 'Q3 (map)'],
    b6('B6.11', ['id', 'tag', 'tags', 'tag_sources', 'start_time'],
      'detail-only for its own data (one full Q2 record). The listed fields are the Q7 tag-context page that replaces the 100-row summary read; Q6 prev/next needs id + start_time; Q3 serves the map track'),
    { detail: 1, overview: 1, d2: 0, secondary: 'Q2 1 + Q7 1 + Q6 <=2 + Q3 <=1', cold: '1 composition', refetch: 'on detail edit' },
    'per-trip exact',
    ['page', 'detail', 'tagContext'],
    '(100) tag-inference read -> retire'),

  entry(23, 'src/pages/TripDrive3DPage.jsx', "['p7','page','trip-drive-3d',<id>,<srcB>]",
    ['trip id'],
    ['Q2'],
    detailOnly('B6.12', 'one Q2 record supplies route_points, driving_events, distance_km, duration_seconds, max_speed_kmh, privacy_mode, route_data_expired_at, start_time and created_at'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q2 1', cold: '1 composition', refetch: 'on detail edit' },
    'per-trip exact',
    ['page', 'detail'],
    'none'),

  entry(24, 'src/pages/TripHistory.jsx', "['p7','page','trip-history',<params>,<srcB>]",
    ['sort', 'status', 'range', 'filter', 'cursor'],
    ['Q1 (cursor-paged)', 'Q4 (totals)'],
    fromManifest('src/pages/TripHistory.jsx'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q1 1 + Q4 <=1', cold: '1 composition', refetch: 'on mutation' },
    'page EXACT or filtered PARTIAL + continuation',
    ['page', 'history', 'aggregate'],
    '(100)+(200) -> retire'),

  entry(25, 'src/pages/Vehicles.jsx', "['p7','page','vehicles',<params>,<srcB>]",
    ['vehicle set'],
    ['Q4 per vehicle', 'Q1 (recent rows)'],
    fromManifest('src/pages/Vehicles.jsx'),
    { detail: 0, overview: 0, d2: 0, secondary: 'Q1 1 + Q4 <= vehicle count (fixed by fleet, not N)', cold: '1 composition', refetch: 'on vehicle/mutation' },
    'per-vehicle totals EXACT from browser:vehicle:<id>:2',
    ['page', 'aggregate', 'history'],
    '(100)+(200) -> retire'),

  entry(26, 'src/components/speedLimits/SpeedIntelligenceConsole.jsx', "['p7','page','speed-intel-console',<params>,<srcB>]",
    ['candidate window'],
    ['Q1 (candidate ids/projections)', 'Q8 D2 by-id batch'],
    b6('B6.13', [
      'id', 'nickname', 'tag', 'start_time', 'status', 'privacy_mode', 'route_data_expired_at',
      'trip_speed_summary_v1.tierCoverage',
    ], 'coverage terms come from the Q8 D2 by-id batch for the bounded candidate id set (one call); a candidate the batch cannot cover is reported as UNKNOWN coverage, never zero. ZERO full-trip decrypts, and never Q2 per candidate'),
    { detail: 0, overview: 0, d2: '1 page, ids <= the declared candidate cap', secondary: 'Q1 1 + Q8 1', cold: '1 composition', refetch: 'route nav' },
    'coverage PARTIAL until candidate scan end',
    ['page', 'history', 'geometry'],
    'B2 list({limit:100}) -> retire'),

  entry(27, 'src/components/tracking/LiveTrackingMapPanel.jsx', "['p7','page','live-map-panel',<params>,<srcB>]",
    ['risk-history horizon'],
    ['Q1 (ids)', 'Q8 D2 by-id batch'],
    b6('B6.14', ['id', 'status', 'start_time'],
      'at most RISK_HISTORY_TRIP_LIMIT rows; the per-id tripDetailQueryOptions fan-out is replaced by ONE Q8 D2 by-id batch, and buildRouteRiskIndex consumes the bounded previews. ZERO full-trip decrypts'),
    { detail: 0, overview: 0, d2: '1 page <= RISK_HISTORY_TRIP_LIMIT', secondary: 'Q1 1 + Q8 1', cold: '1 composition', refetch: 'only on semantically affected families' },
    'risk overlay labelled',
    ['page', 'geometry'],
    'x4 detail fan-out -> retire'),

  entry(28, 'src/components/SpeedSignEvidenceReview.jsx', 'shares the host page composition',
    ['trip id'],
    ['Q2 (1, explicit user action)'],
    detailOnly('B6.15', 'one Q2 record fetched on an explicit user action, shared by its four host surfaces'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q2 1', cold: 'host page', refetch: 'explicit action' },
    'per-trip exact',
    ['detail'],
    'none'),

  entry(29, 'src/hooks/usePendingPostDriveReview.js', "['p7','page','post-drive-review',<id>,<srcB>]",
    ['pending trip id'],
    ['Q2 (1)'],
    detailOnly('B6.16', 'consumes the post-drive entry own trip snapshot and hydrates by id with one Q2 when the snapshot is missing or stale'),
    { detail: 1, overview: 0, d2: 0, secondary: 'Q2 1', cold: '1', refetch: 'event-driven (existing)' },
    'per-trip exact',
    ['detail'],
    'none'),

  entry(30, 'src/App.jsx native import + milestone sync', 'not a page composition - lifecycle edge (App.jsx:80-90)',
    ['import result'],
    ['existing bounded syncNativeCompletedTripsAndMilestones({lifecycleBounded:true})'],
    Object.freeze({ source: 'B3 row 30', requiredFields: Object.freeze([]), note: 'no page rows' }),
    {
      detail: 0, overview: 0, d2: 0, secondary: '0 page reads',
      cold: 'MILESTONE_RECONCILIATION_MAX_SLICE_ITEMS per slice = 1 + PROGRESSION_MAX_PAGES(20) x PROGRESSION_PAGE(100) + MILESTONE_VEHICLE_PAGE(500) + ACHIEVEMENT_WEEK_WINDOW_MAX_ROWS + MILESTONE_NOTIFICATION_CANDIDATE_PAGE + MILESTONE_ACHIEVEMENT_BADGE_CEILING - independent of N',
      refetch: '1 sync per trigger; invalidation is emitted once, to the affected families only, and only when the import or reconciliation actually changed something',
    },
    'targeted invalidation per Annex A section A4.3 - no bare prefix reset',
    ['targeted families only'],
    'prefix-wide invalidation -> narrowed'),
]);

/** The four laws the caps table must satisfy (Annex B section B3). */
export const P7_LEDGER_CAP_LAWS = Object.freeze([
  'list/picker render: fullTripDecrypts = 0 - no consumer may decrypt a full trip payload to render a list, picker, table or candidate set',
  'selected-detail count is fixed by UX, not N',
  'reports/exports hold no full-history full-payload array - #18 renders with 0 full trips and exports with one trip resident at a time',
  'speed/map/risk surfaces never issue Nx Q2 - #6, #11, #14, #26, #27 read geometry through the bounded Q8 composition only',
]);

/** Ledger lookup by production path. */
export const p7ConsumerByPath = (path) => P7_CONSUMER_LEDGER.find((e) => e.consumer.startsWith(path)) ?? null;

/** Every consumer path in the ledger, deduplicated. */
export const p7ConsumerPaths = () => Array.from(new Set(P7_CONSUMER_LEDGER.map((e) => e.consumer)));
