# Insights, Coaching and Progression

The derived-analytics layer that sits above scoring. These are distinct systems that share a
dependency on trip data and derived state.

Canonical sources: `src/lib/tripInsights.js`, `src/lib/metricRegistry.js`,
`src/lib/coachPrograms.js`, `src/lib/driverProgression.js`, `src/lib/driverProgressionLedger.js`,
`src/lib/driverProgressionStore.js`, `src/lib/driverProgressionMigration.js`,
`src/lib/driverScoreSummary.js`, `src/lib/achievementAggregates.js`,
`src/lib/postDriveAdvancedAnalysis.js`, `src/lib/mapPlaybackInsights.js`.

## Raw versus derived

A distinction that must not blur:

| Kind | Example | Property |
|---|---|---|
| Recorded | Route points, event occurrences, timestamps | Immutable fact of a trip |
| Derived | Metrics, trends, coaching state, progression | Recomputable; carries readiness and provenance |

Derived values are never presented as recorded facts. If a derived value cannot be produced, the
surface reports that rather than showing a stale or fabricated number.

## Metric registry

`metricRegistry.js` is the central declaration of computable metrics. A registry entry defines a
metric's identity, how it is derived, what evidence it needs, and its eligibility rules.

The registry exists so that metrics are declared in one place rather than recomputed ad hoc in
components. Adding a metric means registering it, not writing a bespoke calculation inside a page.

Eligibility matters: `driver_metric_eligible` on a trip governs whether it may contribute to
driver-level metrics at all, so excluded trips do not silently skew aggregates.

## Insights

`tripInsights.js` produces the analytics presented on the Insights surface: trends, comparisons
and per-trip observations. Its inputs are trip summaries and projections — not full route payloads
— so analytics cost stays bounded.

`postDriveAdvancedAnalysis.js` produces the deeper post-trip analysis shown after a drive, and
`mapPlaybackInsights.js` derives insight overlays for playback.

Provenance and confidence flow through: an insight computed from low-confidence scoring inherits
that uncertainty rather than presenting a confident conclusion.

## Coaching

`coachPrograms.js` owns coaching programs: structured guidance with progression through a program
rather than one-off tips. A program defines its focus area, its steps, and the evidence that
advances it.

Coaching is **informational**. It reflects what was recorded and scored; it does not claim to
predict or prevent outcomes.

## Progression and achievements

`driverProgression.js` with its ledger, store and migration modules maintains long-running driver
progression; `achievementAggregates.js` derives achievement state.

The ledger is the durable record. Because it accumulates over time, it has its own migration path
(`driverProgressionMigration.js`) so historical progression survives format changes rather than
being reset.

`driverScoreSummary.js` produces the driver-level score summary, distinguishing current form from
longer-run track record — these are different questions and are not presented as the same number.

## Readiness and invalidation

These systems consume derived state domains (notably analytics). When underlying data changes,
required versions advance and background turns recompute. Consumers check readiness rather than
assuming freshness. See
[DERIVED_STATE_AND_BACKGROUND_WORK.md](DERIVED_STATE_AND_BACKGROUND_WORK.md).

## UI consumers

| Surface | Primary hook |
|---|---|
| Insights | `useInsightsData` |
| Driving coach | `useDrivingCoachData` |
| Achievements | `useAchievementsData` |
| Dashboard summary | `useDashboardData` |
| Reports | `useReportData` |

## Scale

Analytics read projections and derived aggregates, not whole trips. Recomputation happens in
bounded background turns. A large history increases the amount of *recorded* data but not the cost
of a single analytics read.

## Limitations

Metrics are only as good as the evidence behind them. Sparse history yields `developing` or
`unavailable` states rather than confident trends. Coaching and progression are motivational and
informational constructs, not assessments of driver competence.

## Testing

`tripInsights`, `driverProgression`, `coachPrograms`, `milestoneNotificationCoordinator`,
`reportTruthfulness` and the P6 analytics suites.
