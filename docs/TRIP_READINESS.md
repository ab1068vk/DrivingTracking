# Road Sage Trip Readiness

Road Sage trip readiness is the Dashboard estimate shown before a trip starts. It combines personal driving history, learned schedule patterns, daily fatigue, recent rest, last-trip outcome, repeated-event context, historical context, and optional weather into a provisional readiness estimate.

It is advisory only. It is not a crash prediction, insurance rating, medical fatigue diagnosis, traffic model, or legal safety determination.

## Current Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| Dashboard card | `src/pages/Dashboard.jsx` | Loads calibration state, correlations, and fitted thresholds; computes the estimate; shows bootstrapping, developing, or calibrated readiness copy. |
| Readiness model | `src/lib/preTripRisk.js` | Computes signals, adaptive weights, composite risk, readiness score, risk level, interval, top signals, evidence tier, and data-quality metadata. |
| Habit profile | `src/lib/habitProfile.js` | Learns time bucket, day of week, hourly risk, trend, fatigue onset, and adaptive temporal half-life from completed scored trips. |
| Local calibration | `src/lib/readinessCalibration.js` | Stores `readiness_calibration_v1`, updates per-signal offsets after outcomes are paired, and activates offsets after 30 paired trips. |
| Signal history | `src/lib/calibration/readinessSignalCorrelation.js` | Stores `readiness_signal_history_v1`, pairs pre-trip snapshots with actual trip scores, computes per-signal and pairwise Pearson correlations. |
| Threshold fitting | `src/lib/calibration/readinessThresholdFit.js` | Stores `readiness_threshold_fit_v1` and fits moderate/high risk floors after at least 30 paired readiness records. |
| Daily fatigue | `src/lib/dailyFatigueEngine.js` | Computes same-day active-driving fatigue and break recovery; can warn before a manual trip. |
| Historical context | `src/lib/predictiveRouteRisk.js` | Supplies route/history context risk when enough completed-trip history exists. |
| Constants | `src/lib/scoringConstants.js` | Names readiness weights, gates, correlation thresholds, variance fallbacks, and evidence thresholds. |
| Survey feedback | `src/components/PostTripCalibrationSurvey.jsx`, `src/lib/calibrationLabeling.js` | Adds readiness-accuracy feedback when a scored trip has a captured pre-trip readiness context. |

## Current Behavior Summary

- The model no longer treats missing personal time or trend history as generic low risk.
- Readiness can display an early bootstrap estimate from fatigue/rest, a developing estimate from at least 2 actual-user signals, or a calibrated evidence state from at least 5 actual-user signals.
- Full local calibration is progressive: snapshots are captured before trips, paired with completed-trip scores, and then used for offsets, correlations, pairwise decorrelation, and fitted thresholds once enough records exist.
- The displayed readiness score is still an estimate and remains approximate even when evidence is "calibrated"; calibrated means enough local signal evidence for the app's readiness path, not external validation against crash or insurance outcomes.

## Signal Assembly

`computePreTripRisk()` builds these nullable risk signals. Null signals stay unavailable and are omitted from weighted blending.

| Signal key | Source |
| --- | --- |
| `timeOfDay` | Habit-profile time bucket risk when sufficient; otherwise legacy time-bucket history when the current bucket has at least 3 trips. |
| `dayOfWeek` | Habit-profile day risk when sufficient; otherwise legacy weekday history when the current weekday has at least 2 trips. |
| `recentTrend` | Habit-profile trend delta or personal-baseline delta; only declines become risk. |
| `dailyFatigue` | Current daily fatigue level: low 10, moderate 40, high 70, critical 90. |
| `lastTripOutcome` | `100 - last completed trip score`. |
| `weather` | Supplied weather-context risk, clamped 0-100. |
| `dangerZones` | Repeated-event-area count converted through the route-risk decay curve. |
| `routeForecast` | Historical-context risk when history is sufficient. |
| `recentRest` | Time since the last completed trip ended, scaled against the recommended break threshold. |

Recent-rest risk is no longer a fixed table. It uses the larger of:

- `PRE_TRIP_REST_MIN_THRESHOLD_MINUTES = 10`
- the current fatigue state's `recommendedBreakMinutes`
- `PRE_TRIP_REST_DEFAULT_BREAK_MINUTES = 30` when fatigue state is unavailable

The risk is `round((1 - breakMinutes / threshold) * 100)`, clamped to 0-100, and becomes 0 when the break meets the threshold.

## Base Weights

Readiness uses these provisional weights before adaptive changes:

| Signal | Weight |
| --- | ---: |
| `dailyFatigue` | `0.20` |
| `recentTrend` | `0.18` |
| `timeOfDay` | `0.14` |
| `lastTripOutcome` | `0.12` |
| `dayOfWeek` | `0.10` |
| `weather` | `0.08` |
| `routeForecast` | `0.08` |
| `dangerZones` | `0.06` |
| `recentRest` | `0.04` |

When a personalized time bucket or day bucket exists but is insufficient, half of that signal's weight is redistributed:

- 60% of freed weight to `recentTrend`
- 40% of freed weight to `dailyFatigue`

Weights are normalized after each adjustment.

## Adaptive Calibration Path

Readiness weight derivation applies adjustments in this order:

1. Start from the base weights, with bucket/day redistribution when the habit profile is sufficiently confident.
2. Apply per-signal calibration offsets from `readiness_calibration_v1` after at least 30 paired trips.
3. Apply signal/outcome correlation checks from `readiness_signal_history_v1` after at least 20 paired records. Signals with absolute Pearson r below `0.15` keep `60%` of their weight before re-normalization.
4. Apply pairwise decorrelation. If a pair such as `timeOfDay|dayOfWeek` has `abs(r) >= 0.65`, both members keep `70%` of their weight before re-normalization.

The pairwise decorrelation step prevents regular schedules, such as weekday morning commutes, from counting the same evidence twice through both time-of-day and day-of-week.

## Snapshot And Outcome Pairing

When a trip starts, Dashboard builds a readiness context and records a signal snapshot:

- signals
- composite risk, or bootstrap risk when full risk is unavailable
- effective weights
- calibration snapshot
- signal correlations
- pairwise signal correlations
- fitted thresholds
- evidence tier and data-quality metadata

The snapshot id is stored on the active trip as `readiness_signal_record_id` and in `pre_trip_readiness_context.signalHistoryRecordId`.

When the trip completes, local trip storage:

- updates per-signal calibration offsets with the pre-trip context and actual score
- pairs the readiness snapshot with the completed-trip score
- recomputes fitted thresholds when enough paired records exist

Storage keys:

| Key | Purpose |
| --- | --- |
| `readiness_calibration_v1` | Local per-signal weight offsets and paired-trip count. |
| `readiness_signal_history_v1` | Up to 200 pre-trip snapshots and paired actual scores. |
| `readiness_threshold_fit_v1` | Fitted moderate/high risk floors and validation metadata. |

## Evidence Tiers

Evidence is based on actual-user signals, not simply the number of non-null values.

| Tier | Condition | Dashboard behavior |
| --- | --- | --- |
| `bootstrapping` | Fewer than 2 actual-user signals. | Shows an early estimate only when fatigue/rest bootstrap risk exists, with "Limited data" copy. |
| `developing` | At least 2 actual-user signals. | Shows a developing estimate and confidence copy. |
| `calibrated` | At least 5 actual-user signals. | Shows an estimated readiness value with high evidence labeling. |

`dataQuality.readinessEvidence` maps these tiers to `bootstrapping`, `developing`, or `high`. If no bootstrap risk exists, it reports `unavailable`.

## Risk, Score, And Interval

The primary conversion is:

```text
readinessScore = 100 - compositeRisk
```

In bootstrapping mode:

```text
bootstrapReadinessScore = 100 - bootstrapRisk
```

`computePreTripRisk()` returns:

| Field | Meaning |
| --- | --- |
| `compositeRisk` | Full 0-100 risk score, or `null` while bootstrapping. |
| `readinessScore` | `100 - compositeRisk`, or `null` when full risk is unavailable. |
| `bootstrapRisk` | Fatigue/rest-only risk used for early display. |
| `bootstrapReadinessScore` | `100 - bootstrapRisk`. |
| `riskLevel` | `low`, `moderate`, `high`, or `unavailable`, using fitted thresholds when supplied. |
| `compositeStdDev` | Estimated risk standard deviation from weighted signal variance. |
| `readinessInterval` | Low/high readiness range derived from `compositeRisk +/- compositeStdDev`. |
| `evidenceTier` | `bootstrapping`, `developing`, or `calibrated`. |
| `signals` | Full signal map with unavailable signals as `null`. |
| `weights` | Effective normalized weights after all adaptations. |
| `dataQuality` | Provenance, evidence counts, correlation inputs, fitted floors, half-life, and personalization metadata. |

Fallback variances used for the interval are named in `scoringConstants.js`: time 64, day 64, trend 81, fatigue 36, last trip 100, weather 25, danger 81, route 64, and rest 36.

## Risk Floors And Fitted Thresholds

The default risk floors are:

| Risk level | Composite risk |
| --- | ---: |
| `high` | `>= 65` |
| `moderate` | `>= 40` and `< 65` |
| `low` | `< 40` |
| `unavailable` | `compositeRisk == null` |

If `readiness_threshold_fit_v1` is available, `computePreTripRisk()` uses its fitted `highRiskFloor` and `moderateRiskFloor` for risk-level classification.

Threshold fitting requires at least 30 paired records. It searches high floors from 55 to 80 and moderate floors from 25 up to the selected high floor, maximizing F1 for detecting trips with actual score below `GOOD_TRIP_SCORE_FLOOR = 72`.

Signal gates can still raise the composite risk floor so severe individual signals are not hidden inside an average:

| Gate | Default |
| --- | ---: |
| high time of day | `80` |
| high route forecast | `65` |
| high fatigue plus poor last trip | `dailyFatigue >= 90` and `lastTripOutcome >= 70` |
| moderate time of day | `60` |
| moderate route forecast | `40` |
| moderate daily fatigue | `70` |
| moderate recent rest | `80` |
| moderate weather | `60` |
| moderate danger zones | `70` |

With a confident habit profile, default floors are adjusted by the driver's all-time average score:

```text
adjustment = clamp((allTimeAvgScore - 70) / 10, -5, 5)
highFloor = 65 - adjustment
moderateFloor = 40 - adjustment
```

## Habit Profile And Half-Life

The Dashboard builds a habit profile after 5 completed trips. Profile confidence is:

```text
confidence = clamp(completedTripCount / 30, 0, 1)
```

The habit profile includes:

- time buckets: Morning, Afternoon, Evening, Night
- weekday risk
- hourly risk when an hour has at least 2 trips
- recent trend delta
- fatigue onset minutes
- adaptive `halfLifeDays`

Adaptive half-life uses score autocorrelation when at least 20 scored trips exist. It is bounded from 7 to 60 days and defaults to 21 days.

## Daily Fatigue Readiness

`computeDailyFatigue()` uses completed trips from the current local day. It uses active driving minutes:

```text
activeMinutes = max(0, duration_seconds - idle_time_seconds) / 60
```

Break recovery:

- breaks longer than 30 minutes reduce accumulated fatigue
- recovery scales linearly up to a 180-minute full recovery cap

Fatigue levels:

| Level | Score |
| --- | ---: |
| `critical` | `>= 7` |
| `high` | `>= 5` |
| `moderate` | `>= 3` |
| `low` | `< 3` |

Before a manual trip starts, Dashboard shows a fatigue dialog only when fatigue is `high` or `critical`.

## Historical Context And Privacy

Historical context is supplied by `estimatePredictiveRouteRisk()` when enough completed-trip history exists. If history is insufficient, route forecast risk is unavailable rather than treated as low risk.

The historical-context subsection is controlled by `predictive_route_risk_enabled`, but Dashboard can still compute context for readiness inputs.

Trip readiness avoids current-location repeated-event context when the current point is inside a privacy zone. Route-risk cells use coarse geohashes and privacy filtering. Weather and road-context requests follow the app-wide privacy rules: unavailable or privacy-skipped weather remains unavailable instead of becoming low risk.

## Post-Trip Readiness Feedback

The post-trip survey asks readiness-accuracy feedback only when the trip has a captured pre-trip readiness context and is not still bootstrapping. The answer is stored with the local calibration label and can supplement readiness calibration through a synthetic score adjustment:

| Response | Effect |
| --- | --- |
| `overestimated` | Treats the pre-trip estimate as too optimistic. |
| `accurate` | Leaves the paired signal close to the actual trip outcome. |
| `underestimated` | Treats the pre-trip estimate as too pessimistic. |

Calibration-label sharing remains opt-in. Shared payloads are summary-only and exclude raw GPS points, addresses, route polylines, personal identifiers, and free-text notes.

## Tracking Readiness Is Separate

Trip readiness asks, "is this a good moment to start?"

Tracking readiness asks, "can Road Sage track right now?"

Tracking readiness checks permissions, background-location state, notification availability, Android activity-recognition access, battery optimization, tracking pause state, and native service health. Those checks do not make the pre-trip readiness estimate safer or riskier.

## Limitations

- Readiness calibration is personal and local; it is not externally validated against crashes, claims, casualty outcomes, traffic volume, or medical fatigue.
- "Calibrated" means enough local readiness evidence for the app's own estimate path, not scientific validation.
- Weather, route context, phone-use evidence, motion signals, and fatigue remain proxies with their own limitations.
- Repeated-event areas reflect the user's recorded events, not objective road danger.
- A narrow readiness interval means the available signals are internally consistent, not that the future trip outcome is guaranteed.
- Fitted thresholds optimize against the app's own trip score outcome, not real-world collision or insurance outcomes.

## Tests

Direct readiness coverage includes:

- `src/lib/__tests__/preTripRisk.test.js`
- `src/lib/__tests__/readinessCalibration.test.js`
- `src/lib/__tests__/readinessSignalCorrelation.test.js`
- `src/lib/__tests__/readinessThresholdFit.test.js`
- `src/lib/__tests__/habitProfile.test.js`
- `src/lib/__tests__/dailyFatigueEngine.test.js`
- `src/lib/__tests__/calibrationLabeling.test.js`

Covered behavior includes:

- readiness score is `100 - compositeRisk`
- bootstrapping uses fatigue/rest only
- developing and calibrated evidence tiers depend on actual-user signals
- calibration offsets keep weights normalized
- non-predictive signals are discounted
- highly correlated signal pairs are damped and re-normalized
- fitted thresholds affect risk classification
- readiness intervals stay ordered and narrow when variance is low
- adaptive half-life is bounded and only activates with enough history
- snapshots pair with completed-trip outcomes
- readiness survey feedback is only requested when a captured context exists

## Maintenance Checklist

When changing trip readiness:

1. Keep thresholds and weights in `src/lib/scoringConstants.js` unless they are purely UI copy.
2. Update `scripts/generate-technical-reference.mjs` before regenerating `README.md` or `docs/TECHNICAL_REFERENCE.md`.
3. Keep unavailable evidence unavailable; do not convert missing context into low risk or perfect safety.
4. Preserve privacy-zone filtering before current-location context lookup.
5. Update readiness tests when score math, calibration, evidence tiers, or storage keys change.
6. Re-run `node scripts/generate-technical-reference.mjs` after source or README-template changes.
