# Road Sage Trip Readiness

Road Sage trip readiness is the Dashboard estimate shown before a trip starts. It combines the driver's own recent history, learned time patterns, daily fatigue exposure, last-trip outcome, repeated-event areas, and historical context into a provisional "Trip readiness estimate." It is advisory only. It is not a crash prediction, insurance rating, medical fatigue diagnosis, traffic model, or legal safety determination.

## Current Architecture

| Layer | File | Responsibility |
| --- | --- | --- |
| Dashboard card | `src/pages/Dashboard.jsx` | Shows the trip readiness estimate, recommended pre-start action, top signals, and historical context breakdown. |
| Readiness model | `src/lib/preTripRisk.js` | Computes composite pre-trip risk, readiness score, risk level, primary concern, tips, evidence quality, and signal provenance. |
| Daily fatigue | `src/lib/dailyFatigueEngine.js` | Computes same-day active-driving fatigue exposure and break recovery. Also blocks manual trip start with a fatigue dialog when high or critical. |
| Habit profile | `src/lib/habitProfile.js` | Learns time-bucket, day-of-week, hourly, trend, and fatigue-onset patterns from completed scored trips. |
| Historical context | `src/lib/predictiveRouteRisk.js` | Estimates current context risk from recent scored driving, event density, repeated-event areas, weather input, and time of day. |
| Repeated-event areas | `src/lib/dangerZoneEngine.js` | Builds stored repeated driving-event areas from completed trip events. |
| Route-risk index | `src/lib/routeRiskIndex.js`, `src/hooks/useRouteRiskIndexMigration.js` | Builds and loads privacy-filtered route-risk cells used before falling back to stored repeated-event areas. |
| Settings/defaults | `src/lib/trackingStore.js`, `src/settings/sections/AdvancedSettings.jsx` | Stores `predictive_route_risk_enabled`, disclaimer count, and the Advanced Settings toggle for historical context display. |
| Constants | `src/lib/scoringConstants.js` | Names all readiness, fatigue, and historical-context weights and gates for auditability. |
| Tests | `src/lib/__tests__/preTripRisk.test.js`, `src/lib/__tests__/dailyFatigueEngine.test.js`, `src/lib/__tests__/advancedOpenSourceFeatures.test.js` | Cover evidence gates, score math, fatigue recovery, historical context, repeated-event areas, and calibration limitations. |

## Important Code Snippets

These excerpts show the current implementation shape. Keep them synchronized when changing readiness scoring, fatigue recovery, or Dashboard gates.

### Readiness Signal Assembly

From `src/lib/preTripRisk.js`, `computePreTripRisk()` builds a nullable signal map. Missing evidence stays `null`; it is not treated as safe driving.

```javascript
const signals = {
  timeOfDay: timeOfDayRisk,
  dayOfWeek: dayOfWeekRisk,
  recentTrend: recentTrendRisk,
  dailyFatigue: fatigueRisk,
  lastTripOutcome: lastTripScore == null ? null : 100 - lastTripScore,
  weather: weatherRisk,
  dangerZones: dangerZoneRisk,
  routeForecast: routeForecastRisk,
  recentRest: restRisk,
};

const clampedSignals = Object.fromEntries(Object.entries(signals).map(([key, value]) => [
  key,
  value == null || value === '' || !Number.isFinite(Number(value)) ? null : clamp(Number(value), 0, 100),
]));
```

### Evidence Gate And Score Conversion

The score is blocked unless the core personal signals exist and fallback evidence stays limited. The displayed readiness score is the inverse of composite risk.

```javascript
const missingCoreSignals = [
  clampedSignals.timeOfDay == null ? 'timeOfDay' : null,
  clampedSignals.recentTrend == null ? 'recentTrend' : null,
].filter(Boolean);

const fallbackGateTriggered = fallbackSignalKeys.length > 1;
const hasCoreReadinessEvidence = missingCoreSignals.length === 0 && !fallbackGateTriggered;
const weightedCompositeRisk = hasCoreReadinessEvidence ? weightedRisk(clampedSignals, weights) : null;
const gateFloor = hasCoreReadinessEvidence ? riskFloorFromSignalGates(clampedSignals, habitProfile) : 0;

const compositeRisk = weightedCompositeRisk == null && gateFloor <= 0
  ? null
  : clamp(Math.round(Math.max(weightedCompositeRisk ?? 0, gateFloor)), 0, 100);

return {
  compositeRisk,
  readinessScore: compositeRisk == null ? null : 100 - compositeRisk,
  riskLevel,
  topSignals,
  signals: clampedSignals,
  dataQuality: {
    readinessEvidence: compositeRisk == null
      ? 'unavailable'
      : availableSignals.length >= 6
        ? 'high'
        : availableSignals.length >= 3
          ? 'developing'
          : 'low',
    missingCoreSignals,
    fallbackGateTriggered,
  },
};
```

### Adaptive Weight Redistribution

When the learned profile is confident enough but the current bucket is thin, part of that bucket's weight moves to broader trend and fatigue evidence.

```javascript
export function deriveWeights(profile = null, now = new Date()) {
  if (!profile || Number(profile.confidence) < 0.3) {
    return DEFAULT_WEIGHTS;
  }

  const adjusted = { ...DEFAULT_WEIGHTS };
  const currentBucket = getTimeBucket(now.getHours());

  if (profile.timeBuckets?.[currentBucket]?.insufficient) {
    const freed = adjusted.timeOfDay * PRE_TRIP_WEIGHT_REDISTRIBUTION_RATIO;
    adjusted.timeOfDay -= freed;
    adjusted.recentTrend += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.recentTrend;
    adjusted.dailyFatigue += freed * PRE_TRIP_WEIGHT_REDISTRIBUTION_TARGETS.dailyFatigue;
  }

  return normalizeWeights(adjusted);
}
```

### Daily Fatigue Recovery

From `src/lib/dailyFatigueEngine.js`, active driving minutes accumulate fatigue, and breaks longer than the recovery threshold reduce accumulated fatigue.

```javascript
const getActiveDrivingMinutes = (trip) => {
  const movingSeconds = Math.max(
    0,
    (Number(trip?.duration_seconds) || 0) - (Number(trip?.idle_time_seconds) || 0)
  );
  return movingSeconds / 60;
};

const applyBreakRecovery = (fatigueMinutes, breakMinutes) => {
  if (!(breakMinutes > DAILY_FATIGUE_DEFAULTS.RECOVERY_BREAK_MINUTES)) return fatigueMinutes;
  return fatigueMinutes * Math.max(
    0,
    1 - breakMinutes / DAILY_FATIGUE_DEFAULTS.FULL_RECOVERY_BREAK_MINUTES
  );
};
```

### Manual Start Warning Gate

The warning dialog before starting a manual trip comes from this returned flag.

```javascript
const fatigueLevel = cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.CRITICAL
  ? 'critical'
  : cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.HIGH
    ? 'high'
    : cumulativeFatigueScore >= DAILY_FATIGUE_THRESHOLDS.MODERATE
      ? 'moderate'
      : 'low';

return {
  cumulativeFatigueScore,
  fatigueLevel,
  recommendedBreakMinutes,
  shouldWarnBeforeTrip: fatigueLevel === 'high' || fatigueLevel === 'critical',
};
```

## Dashboard Behavior

The trip readiness card is rendered only when:

- the user is not actively tracking a trip
- there are at least 5 completed trips
- the card has not been dismissed for the current latest-trip state

The card is wrapped in `SectionErrorBoundary` with context `dashboard_risk_panel`, so failures show a local "Trip readiness unavailable" fallback instead of blanking the Dashboard.

The visible readiness number is intentionally hidden unless the model reports high evidence:

- `readinessEvidence === "high"` and `readinessScore != null`: show the numeric estimate
- score exists but evidence is lower than high: show "Limited-data readiness estimate"
- score is unavailable: show "Not enough data yet"

The card also displays:

- risk color: green for low, yellow for moderate, red for high, muted for unavailable
- `CalibrationStatusTag` when `pre_trip_readiness_score` is still approximate
- primary concern and tip when risk is not low
- a "Recommended before starting" action
- up to three top signals with values
- an optional historical-context section when `predictive_route_risk_enabled !== false`

## Readiness Score Output

`computePreTripRisk()` returns:

| Field | Meaning |
| --- | --- |
| `compositeRisk` | 0-100 risk score, or `null` when evidence is insufficient. |
| `readinessScore` | `100 - compositeRisk`, or `null` when risk is unavailable. |
| `riskLevel` | `low`, `moderate`, `high`, or `unavailable`. |
| `primaryConcern` | Human-readable label for the highest available risk signal. |
| `tipText` | Short action-oriented driving/pre-start suggestion. |
| `topSignals` | Up to three available signals with value >= 25, sorted descending. |
| `signals` | Full clamped signal map, with unavailable signals set to `null`. |
| `dataQuality` | Evidence count, fallback status, provenance, missing core signals, confidence, and personalization state. |

Risk levels use the named pre-trip policy:

| Risk level | Composite risk |
| --- | ---: |
| `high` | `>= 65` |
| `moderate` | `>= 40` and `< 65` |
| `low` | `< 40` |
| `unavailable` | `compositeRisk == null` |

## Readiness Inputs

The model uses only completed trips for history. It looks at completed trips from the last 90 days for legacy time/day analysis and sorts all completed trips newest-first for last-trip and trend inputs.

| Signal | Key | Value calculation |
| --- | --- | --- |
| Time of day | `timeOfDay` | Habit-profile time bucket risk when sufficient; otherwise legacy time bucket risk when the current bucket has at least 3 trips; otherwise unavailable. |
| Day of week | `dayOfWeek` | Habit-profile day risk when sufficient; otherwise legacy day risk when the current weekday has at least 2 trips; otherwise unavailable. |
| Recent trend | `recentTrend` | Declining profile trend or personal-baseline delta. Only negative deltas become risk. |
| Daily fatigue | `dailyFatigue` | `low = 10`, `moderate = 40`, `high = 70`, `critical = 90`. |
| Last trip outcome | `lastTripOutcome` | `100 - last completed trip score`. |
| Weather | `weather` | `context.weatherRiskScore` or `context.weather_context.riskScore`, clamped 0-100. |
| Repeated-event areas | `dangerZones` | `nearbyDangerZoneCount * 35`, clamped 0-100. |
| Route forecast | `routeForecast` | Historical-context `riskScore`, unless historical context is marked insufficient. |
| Recent rest | `recentRest` | Risk from time since the last trip ended. |

Recent rest risk:

| Time since last trip | Risk |
| --- | ---: |
| `< 15 min` | `80` |
| `< 30 min` | `60` |
| `< 60 min` | `35` |
| `>= 60 min` | `5` |

## Signal Weights

Readiness uses a provisional weighted blend. Null signals are omitted by `weightedBlend`; unavailable evidence does not become a perfect score.

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

- 60% of the freed weight goes to `recentTrend`
- 40% of the freed weight goes to `dailyFatigue`

Weights are normalized after redistribution.

## Evidence Gates

Road Sage hides the readiness score when core personal evidence is missing or too much of the signal set would be fallback data.

The core personal signals are:

- `timeOfDay`
- `recentTrend`

The readiness score is unavailable when:

- either core signal is missing
- more than one signal has fallback provenance

Evidence quality is reported as:

| Evidence label | Condition |
| --- | --- |
| `high` | Score exists and at least 6 signals are available. |
| `developing` | Score exists and at least 3 signals are available. |
| `low` | Score exists and fewer than 3 signals are available. |
| `unavailable` | Composite risk is unavailable. |

The Dashboard shows the precise number only for `high` evidence.

## Risk Floors And Signal Gates

After weighted risk is computed, Road Sage may apply a risk floor if an individual signal crosses a named gate. This prevents a severe single concern from disappearing inside the blended average.

High-risk floor candidates:

- `timeOfDay >= 80`
- `routeForecast >= 65`
- `dailyFatigue >= 90` and `lastTripOutcome >= 70`

Moderate-risk floor candidates:

- `timeOfDay >= 60`
- `routeForecast >= 40`
- `dailyFatigue >= 70`
- `recentRest >= 80`
- `weather >= 60`
- `dangerZones >= 70`

Default floors:

- high floor: `65`
- moderate floor: `40`

If a habit profile has confidence >= 0.3, the floors are adjusted by the driver's all-time average score:

```text
adjustment = clamp((allTimeAvgScore - 70) / 10, -5, 5)
highFloor = 65 - adjustment
moderateFloor = 40 - adjustment
```

That means a consistently high-scoring driver can trigger a concern at a slightly lower composite risk, while a lower-scoring baseline slightly raises the concern floor.

## Habit Profile

The Dashboard builds a habit profile after at least 5 completed trips. The profile itself reports confidence as:

```text
confidence = clamp(completedTripCount / 30, 0, 1)
```

Profile data includes:

- `timeBuckets`: Morning, Afternoon, Evening, Night
- `dayOfWeek`: risk per local weekday
- `hourlyRisk`: per-hour risk when an hour has at least 2 trips
- `trendDelta`: recent average score minus all-time average score
- `fatigueOnsetMinutes`: learned fatigue onset when enough multi-trip days show a score drop, otherwise 90 minutes

Time buckets:

| Bucket | Local hours |
| --- | --- |
| Morning | `05:00-11:59` |
| Afternoon | `12:00-16:59` |
| Evening | `17:00-21:59` |
| Night | `22:00-04:59` |

Minimum profile evidence:

- time bucket: 3 trips
- day of week: 2 trips
- hour: 2 trips
- full confidence: 30 trips
- learned fatigue onset: at least 10 multi-trip days

## Daily Fatigue Readiness

`computeDailyFatigue()` uses completed trips from the current local day. It ignores incomplete trips and trips with invalid start/end timestamps.

The model uses active driving minutes:

```text
activeMinutes = max(0, duration_seconds - idle_time_seconds) / 60
```

Break recovery:

- breaks must be longer than 30 minutes to reduce accumulated fatigue
- recovery scales linearly up to a 180-minute full-recovery cap

```text
fatigueMinutesAfterBreak = fatigueMinutes * max(0, 1 - breakMinutes / 180)
```

Fatigue score:

```text
fatigueRatio = clamp(accumulatedFatigueMinutes / fatigueOnsetMinutes, 0, 2)
cumulativeFatigueScore = clamp(round((fatigueRatio * 5) * 10) / 10, 0, 10)
```

Fatigue levels:

| Level | Score |
| --- | ---: |
| `critical` | `>= 7` |
| `high` | `>= 5` |
| `moderate` | `>= 3` |
| `low` | `< 3` |

Recommended break minutes:

| Level | Break |
| --- | ---: |
| `critical` | `30 min` |
| `high` | `20 min` |
| `moderate` | `10 min` |
| `low` | `0 min` |

Before a manual trip starts, Dashboard shows a fatigue dialog when `dailyFatigue.shouldWarnBeforeTrip` is true, which means fatigue is `high` or `critical`. The dialog offers "Take a break" or "Continue anyway."

## Historical Context Estimate

The historical-context section is computed by `estimatePredictiveRouteRisk()` and displayed inside the readiness card when `predictive_route_risk_enabled !== false`.

Important current behavior: the Advanced Settings toggle controls display of the historical-context subsection. The Dashboard still computes historical context and passes it into `computePreTripRisk()`.

Historical context requires:

- at least one completed trip with recorded distance
- at least one scored completed trip with recorded distance

If not enough history exists, it returns `status: "insufficient_history"` and does not produce a risk score.

The estimate uses the 20 newest completed trips. It computes:

- distance-weighted recent average score
- driving-event density from eligible trips at least 0.5 km long
- nearby route-risk cells or repeated-event areas within 2 km
- weather risk, when supplied
- time-of-day risk

Historical-context risk weights:

| Component | Weight |
| --- | ---: |
| Recent driving baseline | `0.35` |
| Driving-event density | `0.25` |
| Repeated-event areas | `0.15` |
| Weather | `0.15` |
| Time of day | `0.10` |

Event-density risk saturates at 5 events/km. Repeated-event-area risk saturates at 5 nearby areas.

Risk levels:

| Level | Historical-context risk |
| --- | ---: |
| `high` | `>= 65` |
| `moderate` | `>= 40` |
| `low` | `< 40` |

Historical context wording uses "estimated historical context" because no planned route is known. It is based on current location and driving history, not a route preview or collision model.

## Repeated-Event Areas

`buildDangerZones()` creates personal repeated-event areas from completed trip events.

Inputs:

- completed trips only
- `driving_events`
- default event types: `harsh_brake`, `sharp_turn`, `speeding`
- default cell size: 80 m
- minimum events per area: 3

Excluded:

- diagnostic-only events
- proxy event types: `near_miss`, `close_proximity`, `tailgate_cycle`, `stop_start_pattern`
- events without finite coordinates

Severity points:

| Severity | Points |
| --- | ---: |
| `high` | `3` |
| `medium` | `2` |
| `low` | `1` |

Area risk level:

| Severity score | Risk level |
| --- | --- |
| `>= 15` | `critical` |
| `>= 8` | `high` |
| `>= 4` | `medium` |
| `< 4` | `low` |

For readiness, nearby repeated-event count is converted to signal risk as `count * 35`, clamped to 100. For historical context, nearby count is normalized against the 5-area saturation count and contributes through the historical-context weighted blend.

## Privacy Behavior

Trip readiness avoids using the current location for repeated-event-area context when the current point is inside a privacy zone. Dashboard sets the current location passed to the readiness panel to `null` in that case.

The route-risk index migration also receives privacy zones. The route-risk system filters stored risk cells inside privacy-zone guards, so private locations should not become repeated route-risk cells.

Weather context and external road-context behavior follow the app-wide privacy rules documented elsewhere: unavailable weather remains unavailable instead of becoming low risk, and private route points are skipped before external context is requested.

## Tracking Readiness Is Separate

Dashboard also shows a tracking readiness panel. That panel answers "can Road Sage track right now?" rather than "is this a good moment to start?"

Tracking readiness checks:

- tracking mode is not paused
- location permission
- Android Physical Activity permission when relevant
- background location for Android background-auto mode
- notification permission for Android background-auto mode
- unrestricted battery for Android background-auto mode
- native service armed for Android background-auto mode

Trip readiness uses historical and context signals. Tracking readiness uses setup and permission signals.

## Settings

| Setting key | Default | Effect |
| --- | ---: | --- |
| `predictive_route_risk_enabled` | `true` | Shows or hides the historical-context subsection in the readiness card. |
| `route_risk_disclaimer_seen_count` | `0` | Tracks how many times the full route-risk disclaimer has been shown; after 3 views the UI uses an info tooltip. |

Related settings and learned values:

- `threshold_long_drive_minutes` affects trip-level fatigue scoring, while daily readiness fatigue uses `DAILY_FATIGUE_ONSET_MINUTES` or learned `habitProfile.fatigueOnsetMinutes`.
- privacy zones affect current-location context and route-risk cells.
- weather context availability affects readiness only when weather risk is supplied to `computePreTripRisk()`.

## User-Facing Wording

Primary concerns and tips are defined in `src/lib/preTripRisk.js`.

| Signal | Concern | Tip |
| --- | --- | --- |
| `timeOfDay` | Higher-risk time of day for you | Drive the first few minutes deliberately and leave extra following room. |
| `dayOfWeek` | This day of week trends lower for you | Start smooth and treat this route like a fresh baseline. |
| `recentTrend` | Your scores have been declining recently | Pick one behaviour to protect this trip instead of fixing everything. |
| `dailyFatigue` | High daily fatigue accumulation | A short break before starting will improve alertness. |
| `lastTripOutcome` | Low score on your last trip | Ease into this drive and avoid repeating the last trip pattern. |
| `weather` | Weather may raise trip risk | Leave more space ahead and brake earlier than usual. |
| `dangerZones` | Your repeated driving-event areas are nearby | Start slowly and watch for the familiar repeated-event area. |
| `routeForecast` | Historical context estimate looks elevated | Consider the calmer window or start with a wider safety margin. |
| `recentRest` | Short recovery since your last trip | Pause briefly before driving again, especially after a demanding trip. |

Low-risk recommendation:

```text
Conditions look steady. Start when your phone is mounted and GPS has a clear signal.
```

Fallback recommendation:

```text
Take a short reset before driving, then start when you feel focused.
```

## Limitations

- The readiness score is approximate and product-heuristic driven.
- Readiness weights are not calibrated to crashes, claims, casualty outcomes, traffic volume, or medical fatigue.
- Historical context is not a planned-route risk model unless a future route is explicitly supplied.
- Repeated-event areas reflect the user's recorded event history, not objective road danger.
- Weather can be unavailable and should not be treated as low risk.
- Phone distraction, fatigue, heading drift, and incident signals elsewhere in the app remain proxies with separate limitations.
- The readiness number is hidden until evidence is high because early history can be misleading.

## Tests

Direct readiness coverage:

- `src/lib/__tests__/preTripRisk.test.js`
- `src/lib/__tests__/dailyFatigueEngine.test.js`
- `src/lib/__tests__/advancedOpenSourceFeatures.test.js`

Covered behavior includes:

- readiness does not use generic clock-risk fallback when personal core evidence is missing
- overnight/rush-hour boundaries use shared app constants
- signal weights sum to 1
- `readinessScore` is `100 - compositeRisk`
- missing core signals suppress the score
- too many fallback signals suppress the score
- daily fatigue can drive high composite risk
- historical context risk becomes a readiness signal
- insufficient historical context is treated as unavailable route evidence
- recent rest can become the primary concern
- personalized time buckets and day buckets are used only when sufficient
- insufficient bucket weight redistribution is normalized
- daily fatigue excludes invalid timestamps, credits long breaks, caps score at 10, and warns before trips only for high/critical fatigue
- historical context includes repeated-event areas, clamps weather risk, marks unavailable weather separately, and excludes low-confidence proxy events

## Maintenance Checklist

When changing trip readiness:

1. Keep every threshold or weight in `src/lib/scoringConstants.js` unless it is purely local UI copy.
2. Preserve the evidence gates unless the UI wording and tests are updated together.
3. Treat unavailable evidence as unavailable, not low risk and not perfect safety.
4. Keep privacy-zone filtering before current-location repeated-area or route-risk lookups.
5. Keep low-confidence proxy events out of repeated-event-area and historical-context risk unless their limitations are re-reviewed.
6. Update `preTripRisk.test.js` for score, gate, or provenance changes.
7. Update `dailyFatigueEngine.test.js` for fatigue/recovery changes.
8. Update README and `TECHNICAL_REFERENCE.md` generation when user-facing behavior changes.
