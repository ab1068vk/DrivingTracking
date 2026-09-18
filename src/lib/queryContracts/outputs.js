/**
 * P7 Stage 1 — per-output semantic/source contract references (Annex C §C5).
 *
 * Declaration only. Each row is the machine-readable reference to the frozen
 * Annex C row of the same key: surface, window class, population code, the
 * browser and native exact sources, the Q graph, the reducer identities it
 * binds, and its EXACT/PARTIAL behaviour. The prose row in
 * `P7_OUTPUT_SEMANTICS_MATRIX.md` remains the full contract; this index exists
 * so the §C5.4 sweeps (owner capability, reducer-term declaration) execute
 * against source rather than against prose.
 *
 * Row keys are matrix bookkeeping, not requirement IDs.
 *
 * TRANSCRIPTION NOTE (O08): Annex C's O08 native cell predates the fourth
 * correction and lists `N-TOT` among its alternatives. §C1a.0 consequence 2 and
 * the §C5.4 sweep 4 are absolute — `N-TOT` is an all-live owner and is never an
 * exact `P-COMPLETED` source — so the governing law is applied here and `N-TOT`
 * is not carried as a legal O08 source. The population, window, Q graph and
 * reducer are unchanged.
 */

/** @param {string} id @param {string} surface @param {string} window @param {string} population */
const o = (id, surface, window, population, browserSource, nativeSource, qGraph, reducers, completeness) => Object.freeze({
  id, surface, window, population, browserSource, nativeSource,
  qGraph: Object.freeze(qGraph),
  reducers: Object.freeze(reducers),
  completeness,
});

const EOF_ELSE_AT_LEAST = 'EXACT at terminal EOF; else "at least N"';
const EXACT = 'EXACT';

/** Totals and core metrics (O01-O10). */
export const P7_OUTPUTS_TOTALS = Object.freeze([
  o('O01', 'Dashboard · activity trips', 'lifetime or the 7-day selection', 'P-COMPLETED',
    'lifetime: B-D1 completedCount; 7-day: R:p7.dashboard.activityStats@1',
    'lifetime: R:p7.dashboard.activityStats@1 trip_count (never N-TOT live_count); 7-day: N-BKT with status=completed, or the same reducer',
    ['Q4', 'Q10'], ['p7.dashboard.activityStats@1'],
    'browser lifetime EXACT; native lifetime EXACT at terminal EOF, else "at least N"'),
  o('O02', 'Dashboard · activity distance', 'as O01', 'P-COMPLETED',
    'lifetime: B-D1 totalKm (km x1000 -> m); 7-day: R:p7.dashboard.activityStats@1 distance_m',
    'lifetime: R:p7.dashboard.activityStats@1 distance_m (never N-TOT total_distance); 7-day: N-BKT status=completed (km x1000 -> m)',
    ['Q4', 'Q10'], ['p7.dashboard.activityStats@1'], 'as O01'),
  o('O03', 'Dashboard · activity driving time', 'as O01', 'P-COMPLETED',
    'R:p7.dashboard.activityStats@1 driving_seconds',
    'R:p7.dashboard.activityStats@1 driving_seconds (never N-TOT total_duration); a status=completed N-BKT range may serve a windowed case (s x1000 -> ms)',
    ['Q10', 'Q4'], ['p7.dashboard.activityStats@1'], EOF_ELSE_AT_LEAST),
  o('O04', 'Dashboard · average score', 'trip-count window: the latest 10 P-DRIVER trips that have an overall component score', 'P-DRIVER',
    'Q1: one bounded newest-first page, first 10 scored P-DRIVER rows, distance-weighted mean computed in the page exactly as today',
    'identical Q1 composition', ['Q1'], [],
    'EXACT for the "latest 10" contract — never Q4, never D1'),
  o('O05', "Dashboard · today's trips", 'the complete local day [startOfLocalDay, +24h)', 'P-COMPLETED',
    'one bounded Q1 date-range scan of that local day, then the existing in-page filter',
    'identical Q1 composition', ['Q1'], [],
    'EXACT when the day range is fully read; PARTIAL + Q1 continuation otherwise'),
  o('O06', 'Dashboard · activeDays / averageTripKm / longestTripKm / tripsPerActiveDay', 'as O01', 'P-COMPLETED',
    'R:p7.dashboard.activityStats@1 (active_local_days, longest_trip_distance_m; means derived in the UI as today)',
    'the same reducer', ['Q10'], ['p7.dashboard.activityStats@1'], EOF_ELSE_AT_LEAST),
  o('O07', 'TrackingOverview · totals', 'complete date window', 'P-COMPLETED',
    'B-D1 range', 'N-BKT range', ['Q4'], [], EXACT),
  o('O08', 'TrackingTripHistory · footer totals', 'matches the active filter', 'P-COMPLETED',
    'B-D1 where the filter is bucket-expressible; else R:p7.history.filteredTotals@1',
    'N-BKT with status=completed where expressible; else R:p7.history.filteredTotals@1',
    ['Q4', 'Q10'], ['p7.history.filteredTotals@1'], 'EXACT or "at least N" — never a recompute over a fetched 200-row page'),
  o('O09', 'Vehicles · per-vehicle totals', 'lifetime per vehicle', 'P-COMPLETED',
    'B-D1 browser:vehicle:<id>:2', 'filtered aggregate, bucket-bounded only (§C6)', ['Q4'], [], EXACT),
  o('O10', 'Vehicles · fleet comparison', 'lifetime per vehicle', 'P-COMPLETED',
    'as O09', 'as O09', ['Q4'], [], EXACT),
]);

/** Event-class metrics (O11-O15). */
export const P7_OUTPUTS_EVENTS = Object.freeze([
  o('O11', 'Report / Insights · harsh brakes', 'complete date window', 'P-DRIVER',
    'R:p7.report.eventTotals@1 only — the D1 harshBrakesCount bucket is P-COMPLETED and cannot express this population',
    'R:p7.report.eventTotals@1', ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  o('O12', 'Report / Insights · rapid accelerations', 'complete date window', 'P-DRIVER',
    'R:p7.report.eventTotals@1', 'R:p7.report.eventTotals@1', ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  o('O13', 'Report / Insights · sharp turns', 'complete date window', 'P-DRIVER',
    'R:p7.report.eventTotals@1', 'R:p7.report.eventTotals@1', ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  o('O14', 'Report / Insights · speeding events', 'complete date window', 'P-DRIVER',
    'R:p7.report.eventTotals@1', 'R:p7.report.eventTotals@1', ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  o('O15', 'Achievements · clean / no-event trip counts', 'lifetime', 'P-COMPLETED',
    'B-D1 noHarshTrips, noRapidTrips, noSharpTrips, noSpeedingTrips, cleanTripCount',
    'R:p7.report.eventTotals@1 (no_harsh_trips, no_rapid_trips, no_sharp_trips, no_speeding_trips, clean_trip_count)',
    ['Q4', 'Q10'], ['p7.report.eventTotals@1'], 'EXACT from D1 on browser; EXACT at terminal EOF on native'),
]);

/** Night, rolling and comparison windows (O16-O21). */
export const P7_OUTPUTS_WINDOWS = Object.freeze([
  o('O16', 'Achievements / Report · night trips', 'lifetime', 'P-COMPLETED',
    'B-D1 nightCount', 'R:p7.report.nightExposure@1', ['Q9', 'Q4', 'Q10'], ['p7.report.nightExposure@1'], EXACT),
  o('O17', 'Report · night duration', 'complete date window', 'P-DRIVER',
    'R:p7.report.nightExposure@1', 'R:p7.report.nightExposure@1', ['Q10'], ['p7.report.nightExposure@1'], EOF_ELSE_AT_LEAST),
  o('O18', 'Achievements · week window', 'rolling 7-day, complete', 'P-COMPLETED',
    'B-D1 <=168 hourly buckets + bounded boundary contributions', 'N-BKT hour range', ['Q9'], [], EXACT),
  o('O19', 'Dashboard / Coach · "recent" window', 'trip-count window', 'P-DRIVER',
    'Q1 bounded page', 'Q1 bounded page', ['Q1'], [], 'EXACT for the window; labelled "latest N"'),
  o('O20', 'Coach / Insights · previous-window comparison', 'same class as its current window', 'P-DRIVER',
    'the same source as its current window, shifted — Q1 or Q10, never Q4/Q5',
    'same', ['Q1', 'Q10'], [], 'matches its current window state'),
  o('O21', 'Coach · "all drives" / historical evidence', 'lifetime', 'P-DRIVER',
    'R: the named reducer its term requires (eventTotals@1 / durationDistance@1 / nightExposure@1) — no Q4',
    'the same reducers', ['Q10'],
    ['p7.report.eventTotals@1', 'p7.report.durationDistance@1', 'p7.report.nightExposure@1'],
    EOF_ELSE_AT_LEAST),
]);

/** Charts, report scope, economics, UBI, export (O22-O27). */
export const P7_OUTPUTS_CHARTS = Object.freeze([
  o('O22', 'Trend charts — P-COMPLETED surfaces only', 'complete date window', 'P-COMPLETED',
    'B-D1 browser:utc-day:*', 'N-BKT GROUP BY + LIMIT', ['Q5'], [],
    'EXACT, or PARTIAL + next-bucket-range continuation when the output limit truncates the range'),
  o('O23', 'Report · 6-month event trend', '6 complete calendar months, local month buckets', 'P-DRIVER',
    'R:p7.report.monthlyEventTrend@1', 'same reducer', ['Q10'], ['p7.report.monthlyEventTrend@1'], EOF_ELSE_AT_LEAST),
  o('O24', 'Report · period selector scope', '7d/30d/90d complete date window, or lifetime for "all"', 'P-DRIVER',
    'the window every O42-O56 row is evaluated over', 'same', [], [],
    'the report body is EXACT only when every one of its rows is EXACT; otherwise the report is labelled PARTIAL as a whole'),
  o('O25', 'Report · economics', 'the O24 window', 'P-DRIVER',
    'R:p7.report.economics@1', 'same reducer', ['Q10'], ['p7.report.economics@1'], EOF_ELSE_AT_LEAST),
  o('O26', 'Report · UBI terms', 'the O24 window', 'P-DRIVER',
    'R:p7.ubi.terms@1', 'same reducer', ['Q10'], ['p7.ubi.terms@1'], EOF_ELSE_AT_LEAST),
  o('O27', 'ReportsLab · export payload', 'user-selected range', 'P-DRIVER',
    'bounded id/payload stream, one resident', 'bounded id/payload stream, one resident',
    ['Q1', 'Q2'], [], 'EXACT at terminal EOF only — exports never emit a PARTIAL body labelled exact'),
]);

/** Achievements, progression, calibration, milestones (O28-O34). */
export const P7_OUTPUTS_PROGRESSION = Object.freeze([
  o('O28', 'Achievements · badges', 'lifetime', 'P-COMPLETED',
    'Q9 only — readAchievementSurfaces; never readAchievementBadges', 'same facade', ['Q9'], [],
    'EXACT when D1 VERIFIED && complete; else the typed OWNER_NOT_READY state'),
  o('O29', 'Achievements · calibration progress', 'lifetime', 'P-COMPLETED',
    'Q9 only — the calibration field of readAchievementSurfaces; never readCalibrationProgressFromAggregates',
    'same', ['Q9'], [], 'as O28'),
  o('O30', 'Dashboard / Achievements · readiness', 'lifetime', 'P-COMPLETED', 'Q9', 'Q9', ['Q9'], [], 'as O28'),
  o('O31', 'Achievements · progression / mastery / missions / current form', 'composed — see §C5.2', 'P-PROGRESSION',
    'per §C5.2', 'per §C5.2', ['Q9', 'Q1', 'Q10', 'Q4'],
    ['p7.progression.lifetimeStats@1', 'p7.progression.records@1'], 'per §C5.2, per term'),
  o('O32', 'Achievements · records / personal bests', 'lifetime', 'P-PROGRESSION',
    'R:p7.progression.records@1 — extrema only', 'same', ['Q10'], ['p7.progression.records@1'], EOF_ELSE_AT_LEAST),
  o('O33', 'Achievements / Dashboard · streaks', 'calendar window (week bounds)', 'P-PROGRESSION',
    'existing XP/progression ledger facts + a bounded Q1 date-range scan of the calendar window',
    'identical composition', ['Q1'], [],
    'EXACT when the calendar window is fully read; PARTIAL + Q1 continuation otherwise'),
  o('O34', 'Milestones / notifications', 'lifetime', 'P-COMPLETED',
    'existing milestone owner, reading Q4/Q9 values', 'same', ['Q4', 'Q9'], [],
    'matches its source state — a milestone must never fire from a PARTIAL value'),
]);

/** Geometry-derived and per-trip outputs (O35-O38). */
export const P7_OUTPUTS_GEOMETRY = Object.freeze([
  o('O35', 'SpeedLimits / MapScreen · routes shown', 'bounded chronological page', 'P-COMPLETED + privacy/expiry',
    'P6 D2 by-id batch for a fixed Q1 page', 'same', ['Q8'], [],
    'PARTIAL until the relevant scan reaches its end'),
  o('O36', 'SpeedLimits · "available routes" count', 'bounded', 'P-COMPLETED + privacy/expiry',
    '"at least N — more available"', 'same', ['Q8'], [],
    'never EXACT unless the scan reached its end — replaces the synthesized totalAvailable'),
  o('O37', 'SpeedIntelligenceConsole · speed coverage', 'bounded candidate set', 'P-COMPLETED',
    'D2 by-id batch coverage answers', 'same', ['Q1', 'Q8'], [],
    'PARTIAL until the candidate scan ends — a candidate without D2 coverage is unknown, never zero'),
  o('O38', 'TripDetail / SpeedAnalysis · per-trip metrics', 'single trip', 'per-page existing status eligibility',
    'Q2', 'Q2', ['Q2'], [], EXACT),
]);

/** Null / zero and grouping conformance rules (O39-O41) — rules, not source rows. */
export const P7_OUTPUT_CONFORMANCE_RULES = Object.freeze([
  Object.freeze({ id: 'O39', rule: 'no eligible trips => the surface existing empty state, never a 0 presented as a measurement', appliesTo: 'every row' }),
  Object.freeze({ id: 'O40', rule: 'loading / unavailable / repair-needed / PARTIAL => the typed state, never 0, 0 km, $0, empty history or empty chart', appliesTo: 'every row' }),
  Object.freeze({
    id: 'O41',
    rule: 'every day-grouped output states its grouping basis (UTC bucket vs local day) and is validated at local midnight and across a DST transition',
    appliesTo: Object.freeze(['O05', 'O06', 'O07', 'O22', 'O23', 'O33', 'O48', 'O49', 'O57']),
  }),
]);
