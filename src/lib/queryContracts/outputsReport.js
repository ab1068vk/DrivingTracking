/**
 * P7 Stage 1 — the Report body, the Report comparison/insight/distribution/
 * takeaway block, and the Settings score-migration summary (Annex C §C5,
 * rows O42-O61 and O62-O75).
 *
 * Declaration only. Together with `outputs.js` these cover every currently
 * rendered Report output. Every row is evaluated over the O24 window unless its
 * own horizon says otherwise, and over P-DRIVER unless its population narrows
 * further.
 */

const r = (id, output, horizon, population, source, qGraph, reducers, completeness) => Object.freeze({
  id, output, horizon, population, source,
  qGraph: Object.freeze(qGraph),
  reducers: Object.freeze(reducers),
  completeness,
  // Both authorities use the identical reducer, population and window unless the
  // row says otherwise, so equality holds after the §C2 conversions.
});

const EOF_ELSE_AT_LEAST = 'EXACT at terminal EOF; else "at least N"';
const O24 = 'the O24 window';
const DRIVER = 'P-DRIVER';

/** Report body — every currently rendered output (O42-O60). */
export const P7_OUTPUTS_REPORT_BODY = Object.freeze([
  r('O42', 'summary.total_trips / total_distance_km / total_duration_seconds', O24, DRIVER,
    'R:p7.report.durationDistance@1 (trip_count, distance_m, duration_ms)', ['Q10'], ['p7.report.durationDistance@1'], EOF_ELSE_AT_LEAST),
  r('O43', 'summary.avg_score (+ avg_score_trip_count, avg_score_basis)', O24, 'P-DRIVER, scored subset',
    'R:p7.report.durationDistance@1 (score_distance_product / score_distance_weight) — distance-weighted', ['Q10'], ['p7.report.durationDistance@1'], EOF_ELSE_AT_LEAST),
  r('O44', 'summary.best_trip / worst_trip', O24, 'P-DRIVER, finite score_overall',
    'R:p7.report.summaryExtrema@1', ['Q10'], ['p7.report.summaryExtrema@1'], EOF_ELSE_AT_LEAST),
  r('O45', 'summary event totals (harsh brakes, rapid accels, sharp turns, speeding, heading deviations, stop-start patterns, distraction events)', O24, DRIVER,
    'R:p7.report.eventTotals@1', ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  r('O46', 'summary.most_common_risk', O24, DRIVER,
    'R:p7.report.eventTotals@1 most_common_risk (argmax in the frozen EVENT_TYPES order)', ['Q10'], ['p7.report.eventTotals@1'],
    'EXACT at EOF only — an argmax over a PARTIAL tally is never labelled exact'),
  r('O47', 'tips (buildScoreTips) · coaching tips', O24, 'P-SCORETIP',
    'R:p7.report.scoreTipTotals@1', ['Q10'], ['p7.report.scoreTipTotals@1'],
    'EXACT at EOF; while PARTIAL the surface keeps its existing "not enough data yet" copy rather than ranking a partial tally'),
  r('O48', 'timeOfDayData · morning / afternoon / evening / night (local hour buckets)', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 (time-of-day, 4 buckets)', ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O49', 'dayOfWeekData · Sun-Sat (local weekday)', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 (day-of-week, 7 buckets)', ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O50', 'fatigueRisk · long-drive risk', O24, DRIVER,
    'R:p7.report.fatigue@1 (threshold_long_drive_minutes bound into the continuation)', ['Q10'], ['p7.report.fatigue@1'],
    'EXACT at EOF; the level band is derived only from an EXACT tally'),
  r('O51', 'avgMovingSpeedKmh · "Average moving speed"', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 moving_speed_sum_kmh / moving_speed_trip_count — plain mean whose denominator is EVERY trip in the window (a row with neither speed field finite contributes 0 and still counts)',
    ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O52', 'baseline / baselineText · personal baseline, weekly percentile, personal bests',
    'calendar windows, NOT the O24 window: 4 weeks (baseline), current week, 12 weeks (percentile)', 'P-BASELINE',
    'bounded Q1 date-range scans over the complete 4-week and 12-week windows, computed in the page exactly as today; personal_best_trip_score is a lifetime extremum from R:p7.progression.records@1',
    ['Q1', 'Q10'], ['p7.progression.records@1'],
    'EXACT when both windows are fully read; PARTIAL + Q1 continuation while a window scan is unfinished'),
  r('O53', 'carbonImpact · CO2 saved, trees equivalent', O24, DRIVER,
    'R:p7.report.economics@1 (co2_saved_kg, co2_eligible_trip_count)', ['Q10'], ['p7.report.economics@1'], EOF_ELSE_AT_LEAST),
  r('O54', 'peakHourStress + peakComparisonData · peak vs off-peak (local hour, peak = {7,8,16,17,18})', O24, 'P-PEAKSTRESS',
    'R:p7.report.bucketProfiles@1 (peak/off-peak, 2 buckets)', ['Q10'], ['p7.report.bucketProfiles@1'],
    'EXACT at EOF; insufficient_data keeps its existing copy and is never rendered as 0'),
  r('O55', 'roadTypeData · road-type distribution', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 (road-type, 4 buckets)', ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O56', 'efficiencyBandsData · city-crawl / cruise / high-speed / city', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 (efficiency, 3 buckets)', ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O57', 'dailyData · daily distance / trips / avg score / avg SVI',
    "a capped day window: period === 'all' -> the last 30 days (reducer cap 31), else periodDays", DRIVER,
    'R:p7.report.dailySeries@1 over the declared day window (local day label, distance-weighted day score, plain SVI mean)',
    ['Q10'], ['p7.report.dailySeries@1'], EOF_ELSE_AT_LEAST),
  r('O58', 'complianceChartData · per-road-type compliance rate', O24, DRIVER,
    'FROZEN AS-IS: currently renders empty on the shipping path because the *_compliance objects are not in the trip projection; P7 preserves today behaviour and must not silently populate it',
    [], [], 'no Q assignment — the output keeps its existing empty state'),
  r('O59', 'commutePatterns · recurring routes', O24, DRIVER,
    'FROZEN AS-IS: currently renders empty on the shipping path because route_points is not in the projection, and the grouping is unbounded in distinct routes so no fixed-size reducer can reproduce a populated version',
    [], [], 'no Q assignment — the output keeps its existing empty state; P7 neither populates it nor issues Nx Q2 to try'),
  r('O60', 'CSV export (tripsToCSV)', O24, DRIVER,
    'explicit bounded id/payload stream, one trip resident, cancellable', ['Q1', 'Q2'], [],
    'EXACT at terminal EOF only; a PARTIAL scan may not be exported as a complete period export'),
]);

/** Settings score-migration summary (O61) — the B9 replacement. */
export const P7_OUTPUT_SETTINGS_MIGRATION = Object.freeze(
  r('O61', 'Settings · score-migration summary (B9)', O24.replace('the O24 window', 'lifetime eligible population'), 'P-COMPLETED',
    'R:p7.settings.scoreMigrationSummary@1 on both authorities (Annex A §A3.8); counts, recent-mismatch ratio, eligibility tallies, has_unknown_legacy_unrescored and a <=4-item mismatch_preview; "+N more" is mismatch_count - preview.length',
    ['Q10'], ['p7.settings.scoreMigrationSummary@1'],
    'EXACT at terminal EOF; while PARTIAL the counts read "at least N" and no "+N more" is presented as exact. Preview order is the reducer newest-first (start_time, id) scan order')
);

/** Report comparison, insight, distribution and takeaway outputs (O62-O75). */
export const P7_OUTPUTS_REPORT_INSIGHTS = Object.freeze([
  r('O62', 'previousTrips / previousSummary · the prior-period baseline behind every "vs prior" value',
    "the immediately preceding window of equal length [cutoff - periodDays, cutoff); EMPTY when period === 'all'", DRIVER,
    'the same reducers as O42-O46, invoked a second time bound to the previous window', ['Q10'],
    ['p7.report.durationDistance@1', 'p7.report.eventTotals@1', 'p7.report.summaryExtrema@1'],
    "EXACT when both windows reach terminal EOF; if either is PARTIAL every derived delta is PARTIAL. When period === 'all' the comparison is absent by design and the UI keeps its existing \"Need prior period\" copy — never a 0 delta"),
  r('O63', 'reportInsights.scoreDelta · "vs prior" on the Avg-score tile', 'current vs O62', DRIVER,
    'derived from O43 x2 windows', ['Q10'], ['p7.report.durationDistance@1'],
    'as O62; null renders "Need prior period", never 0'),
  r('O64', 'reportInsights.distanceDelta + distanceDeltaLabel · "vs prior" on the Distance tile', 'current vs O62', DRIVER,
    'derived from O42 x2 windows', ['Q10'], ['p7.report.durationDistance@1'], 'as O62'),
  r('O65', 'reportInsights.eventRate and eventRateDelta · "Events / 100 km"', 'current; delta vs O62', DRIVER,
    'derived from O42 + O45 x2 windows', ['Q10'], ['p7.report.durationDistance@1', 'p7.report.eventTotals@1'],
    'as O62; a null rate renders "-" / "unlocks" copy, never 0'),
  r('O66', 'reportInsights.cleanTripPercent · "Clean trips" tile', O24, DRIVER,
    'R:p7.report.eventTotals@1 ONLY — report_clean_trip_count / completed_count x 100; both declared by that one reducer; 0 when the window has no rows',
    ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  r('O67', 'reportInsights.scoredTrips · "N/M scored"', O24, DRIVER,
    "R:p7.report.eventTotals@1 scored_trip_count; the denominator is O42's total_trips", ['Q10'], ['p7.report.eventTotals@1'], EOF_ELSE_AT_LEAST),
  r('O68', 'reportInsights.confidence · confidence word (High / Medium / Early)', O24, DRIVER,
    'derived from O42 + O67', ['Q10'], ['p7.report.durationDistance@1', 'p7.report.eventTotals@1'],
    'the label may only be shown for an EXACT tally; while PARTIAL the surface shows its partial label rather than a confidence word computed from an incomplete count'),
  r('O69', 'reportInsights.activeDays and coveragePercent · "Active days" tile', O24, DRIVER,
    'R:p7.dashboard.activityStats@1 active_local_days (ordered-scan distinct-day counter), invoked with this population and window',
    ['Q10'], ['p7.dashboard.activityStats@1'],
    'EXACT at EOF; else "at least N". Local-day identity, never a UTC bucket'),
  r('O70', 'reportInsights.bestWindow · "Best window" tile', O24, DRIVER,
    'derived from O48 / R:p7.report.bucketProfiles@1 — argmax of avgScore over the 4 time-of-day buckets', ['Q10'], ['p7.report.bucketProfiles@1'],
    'argmax only over an EXACT profile; while PARTIAL the tile keeps its existing "TBD" / "Add more trips" copy'),
  r('O71', 'reportInsights.hardestDay · computed, not currently rendered', O24, DRIVER,
    'derived from O49 / R:p7.report.bucketProfiles@1 — argmax of events over the 7 weekday buckets', ['Q10'], ['p7.report.bucketProfiles@1'],
    'recorded so the migration preserves it; it acquires a UI contract only if a future change renders it'),
  r('O72', 'reportInsights.nextAction · "Next action" sentence', O24, DRIVER,
    'derived from O46 + O54 — the frozen branch ladder: a non-zero topRisk selects by key; else stress_ratio > 1.25 selects the peak-hour message; else the neutral message',
    ['Q10'], ['p7.report.eventTotals@1', 'p7.report.bucketProfiles@1'],
    'shown only for EXACT inputs; a PARTIAL tally could name the wrong dominant risk, so the surface shows its partial state instead'),
  r('O73', 'scoreDistribution · the two distribution bars (4 fixed bands 90+, 80-89, 70-79, <70)', O24, DRIVER,
    'R:p7.report.bucketProfiles@1 score-distribution profile (4 bands); percent = count / sum x 100, 0 when the total is 0',
    ['Q10'], ['p7.report.bucketProfiles@1'], EOF_ELSE_AT_LEAST),
  r('O74', 'componentScores · the Safety and Smoothness tiles', O24, DRIVER,
    'R:p7.report.durationDistance@1 per-component pairs; distance-weighted mean when total distance > 0, otherwise the plain mean of scored rows, otherwise null',
    ['Q10'], ['p7.report.durationDistance@1'],
    'EXACT at EOF; else "at least N"; null renders the existing unavailable state, never 0'),
  r('O75', 'reportTakeaways · the takeaway list (three frozen sentences)', `${O24}; sentence 2 uses O62`, DRIVER,
    'derived from O42, O46, O62, O63', ['Q10'], ['p7.report.durationDistance@1', 'p7.report.eventTotals@1'],
    'text may only assert a comparison or a dominant risk from EXACT inputs; otherwise the existing fallback sentences are used'),
]);
