# Trip Readiness System

This document describes the full pre-trip readiness system used by Road Sage. The implementation lives in:

- `src/lib/preTripRisk.js`
- `src/lib/predictiveRouteRisk.js`
- `src/pages/Dashboard.jsx`
- Tests in `src/lib/__tests__/preTripRisk.test.js` and `src/lib/__tests__/advancedOpenSourceFeatures.test.js`

## Purpose

Trip readiness answers one question before a drive starts: "Is this a good moment to begin driving, based on my recent history and current risk context?"

It is not a legal or medical safety decision. It is a local, on-device risk estimate that helps the driver slow down, rest, wait for a better window, or start with extra caution.

## Dashboard Flow

The Dashboard builds readiness only when the app is not tracking and the driver has at least 5 completed trips:

```jsx
const completedTrips = recentTrips.filter((trip) => trip.status === 'completed');
const todayTrips = getTodayTrips(completedTrips);
const dailyFatigue = computeDailyFatigue(todayTrips, settings);

const predictiveRouteRisk = estimatePredictiveRouteRisk({
  trips: completedTrips,
  dangerZones,
  weatherRiskScore: 0,
  currentLocation,
});

const preTripRisk = computePreTripRisk(completedTrips, settings, dailyFatigue, {
  nearbyDangerZoneCount: predictiveRouteRisk.nearbyDangerZoneCount,
  predictiveRouteRisk,
});
```

The readiness card shows:

- Readiness score: `100 - compositeRisk`
- Risk level: `low`, `moderate`, or `high`
- Top contributing signals
- A recommendation before starting
- Predictive route risk, primary factor, and safer time window

## Pre-Trip Risk Inputs

`computePreTripRisk(trips, settings, dailyFatigueState, context)` uses completed trips from the last 90 days for personal baseline signals.

Signals are normalized to `0..100`, where higher means more risk:

- `timeOfDay`: personal score for the current time bucket, or a fallback clock risk
- `dayOfWeek`: personal score for the current weekday
- `recentTrend`: baseline trend from recent trips
- `dailyFatigue`: today's cumulative fatigue state
- `lastTripOutcome`: inverse of the most recent trip score
- `weather`: weather context risk when available
- `dangerZones`: nearby historical danger-zone count
- `routeForecast`: predictive route risk
- `recentRest`: time since the last completed trip

## Time Buckets

The current hour maps to:

```text
05:00-11:59 Morning
12:00-16:59 Afternoon
17:00-21:59 Evening
22:00-04:59 Night
```

If the driver has no personal data for the current bucket, fallback time risk is:

```text
22:00-04:59 = 60
07:00-09:59 = 35
16:00-18:59 = 40
otherwise = 20
```

The 12:45 AM case is in the `Night` bucket and falls back to `60` unless there is a personal night-driving average.

## Weighted Formula

The weighted composite risk is:

```text
weightedCompositeRisk =
  timeOfDay * 0.14 +
  dayOfWeek * 0.10 +
  recentTrend * 0.18 +
  dailyFatigue * 0.20 +
  lastTripOutcome * 0.12 +
  weather * 0.08 +
  dangerZones * 0.06 +
  routeForecast * 0.08 +
  recentRest * 0.04
```

Weights sum to `1.0`.

## Signal Gates

Some single risks should not be averaged away. After the weighted score is calculated, readiness applies a minimum risk floor:

```text
High floor: compositeRisk at least 65
- timeOfDay >= 80
- routeForecast >= 65
- dailyFatigue >= 90 and lastTripOutcome >= 70

Moderate floor: compositeRisk at least 40
- timeOfDay >= 60
- routeForecast >= 40
- dailyFatigue >= 70
- recentRest >= 80
- weather >= 60
- dangerZones >= 70
```

Final risk:

```text
compositeRisk = max(weightedCompositeRisk, signalGateFloor)
readinessScore = 100 - compositeRisk

high risk = compositeRisk >= 65
moderate risk = compositeRisk >= 40
low risk = compositeRisk < 40
```

This is why late night at 12:45 AM can no longer show as `Low Risk` just because the weighted average is otherwise calm.

## Predictive Route Risk

`estimatePredictiveRouteRisk()` estimates current route risk from recent driving and local context:

```text
riskScore = clamp(round(
  (100 - avgScoreOfRecent20Trips) * 0.45 +
  eventDensityPerKm * 18 +
  nearbyDangerZoneCountWithin2000m * 10 +
  weatherRiskScore * 0.25 +
  timeRisk
), 0, 100)
```

Time risk is:

```text
22:00-04:59 = 18
16:00-18:59 = 10
otherwise = 0
```

The safer-window text is:

```text
22:00-04:59 = "Late night is higher risk. Consider waiting until daylight or after a proper rest."
16:00-18:59 = "After 7 PM or before rush hour"
otherwise = "Current time looks acceptable"
```

## UI Rules

The readiness circle color now follows the risk level:

```text
low = green
moderate = yellow
high = red
```

This prevents a case like `74/100 moderate risk` from still looking like a green "all clear" state.

## Regression Example

At `2026-01-10 00:45`, with calm recent trips but `predictiveRouteRisk.riskScore = 42`:

```text
timeOfDay = 60
routeForecast = 42
signalGateFloor = 40
compositeRisk >= 40
readinessScore <= 60
riskLevel = moderate
```

The predictive route panel also says late night is higher risk instead of saying the current time is acceptable.
