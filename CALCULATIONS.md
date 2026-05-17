# DriveSense App Calculations

This document explains where every in-app calculation is done and shows the main code formulas used by the app.

## Source Files

The calculation code is concentrated in these files:

- `src/lib/tripEngine.js`: GPS math, route cleaning, trip splitting, speed-zone inference, driving events, trip stats, trip scores, aggression, defensive driving, jerk, eco, fatigue, drowsy, parking, report export.
- `src/lib/tripInsights.js`: map speed colors, stops, fuel/cost/CO2, maintenance, weekly goals, coach insights, badges, consistency, baseline, commute patterns.
- `src/lib/activityRecognition.js`: JavaScript auto-start and auto-stop decisions.
- `src/lib/trackingStore.js`: default thresholds, settings, and last-parked storage helpers.
- `src/lib/localTripRepository.js`: rescoring imported/background trips and storing the last parked location for native trips.
- `src/lib/pdfExport.js`: monthly PDF report totals and table export formatting.
- `src/pages/Dashboard.jsx`: trip completion pipeline.
- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`: native Android background trip capture, GPS filtering, native stats, and native auto-stop.

## Trip Calculation Pipeline

When a trip ends, the app calculates the trip in this order:

```js
const thresholds = buildDrivingThresholds(settings);
const stats = calculateTripStats(routePoints, startTime, endTime, thresholds);
const detection = detectDrivingEvents(routePoints, thresholds);
const events = detection.events ?? detection;
const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds, detection.phoneUse ?? {});
const economics = estimateTripEconomics({ ...stats, ...scores }, vehicle, settings);
```

This flow is used in `src/pages/Dashboard.jsx` and in `src/lib/localTripRepository.js` when native Android trips are imported or old trips need rescoring.

When a user splits a trip, `splitTripAtStops(trip, minParkMinutes)` runs the same pipeline for each generated sub-trip. Each sub-trip gets fresh statistics, events, scores, and economics rather than copying the parent values.

## Weather Context

File: `src/lib/weatherContext.js`

Weather context comes from Open-Meteo. Past trips use the historical archive endpoint, while same-day/future trips use the forecast endpoint. The app samples only the actual trip window, falling back to the nearest hourly sample within one hour when a short trip does not cross an hourly bucket.

Rain is no longer inferred from a rain weather code alone. The trip needs measured rain/precipitation in the selected sample window, or a dominant rain-code window with non-zero precipitation. This avoids showing "rain" for a sunny drive just because a nearby hourly model bucket had rainy weather.

## OpenStreetMap Speed Limits And Context Refresh

Files:

- `src/lib/speedLimitSource.js`
- `src/lib/mapMatching.js`
- `src/pages/TripDetail.jsx`
- `src/components/TripMap.jsx`

When a trip ends, Dashboard runs OSRM map matching first, then annotates route points with OpenStreetMap `maxspeed` tags from Overpass. Trip Detail also exposes **Refresh OSM Context** so existing trips can rerun the same open-source context without recording a new drive.

The speed-limit matcher uses point-to-road-segment distance, not just nearby way vertices. Each matched point receives:

```js
speed_limit_kmh
speed_limit_source: 'openstreetmap'
speed_limit_way_id
speed_limit_road_name
```

After refresh, Trip Detail recalculates stats, events, speed compliance, scores, weather adjustment, map-matching status, and OSM coverage. Trip Detail and Map can draw an **OSM Speed Limits** layer:

- green segment: at or below matched limit
- orange segment: above matched limit
- red segment: more than 10 km/h over matched limit

If Overpass or OSRM is unavailable, the trip keeps inferred speed zones and records the context status/error instead of hiding the feature.

## Default Settings And Thresholds

Default user settings live in `src/lib/trackingStore.js`.

```js
threshold_harsh_brake_ms2: 4.5,
threshold_rapid_accel_ms2: 3.5,
threshold_tailgate_decel_ms2: 2.5,
threshold_sharp_turn_g_low: 0.30,
threshold_sharp_turn_g_medium: 0.45,
threshold_sharp_turn_g_high: 0.60,
threshold_speeding_kmh: 130,
threshold_speed_over_kmh: 10,
threshold_idle_seconds: 90,
threshold_long_drive_minutes: 120,
threshold_near_miss_brake_ms2: 3.5,
threshold_near_miss_turn_degs: 30,
threshold_drowsy_heading_std: 8,
threshold_phone_proxy_oscillations: 3,
phone_use_detection_enabled: true,
phone_use_live_alert_enabled: true,
phone_use_show_on_map: true,
phone_use_affects_score: true,
phone_use_sensitivity: 'medium',
threshold_speed_creep_kmh: 10,
threshold_overtake_accel_ms2: 3.0,
min_speed_rapid_accel_kmh: 5,
min_speed_harsh_brake_kmh: 25,
weekly_goal_harsh_brakes: 5,
weekly_goal_speeding_events: 3,
weekly_goal_min_avg_score: 80,
weekly_goal_max_night_trips: 3,
```

Runtime driving thresholds are built in `src/lib/tripEngine.js`:

```js
export function buildDrivingThresholds(settings = {}) {
  return {
    ...DEFAULT_THRESHOLDS,
    HARSH_BRAKE_MS2: settingNumber(settings.threshold_harsh_brake_ms2, DEFAULT_THRESHOLDS.HARSH_BRAKE_MS2),
    RAPID_ACCEL_MS2: settingNumber(settings.threshold_rapid_accel_ms2, DEFAULT_THRESHOLDS.RAPID_ACCEL_MS2),
    TAILGATE_DECEL_MS2: settingNumber(settings.threshold_tailgate_decel_ms2, DEFAULT_THRESHOLDS.TAILGATE_DECEL_MS2),
    SHARP_TURN_G_LOW: settingNumber(settings.threshold_sharp_turn_g_low, DEFAULT_THRESHOLDS.SHARP_TURN_G_LOW),
    SHARP_TURN_G_MEDIUM: settingNumber(settings.threshold_sharp_turn_g_medium, DEFAULT_THRESHOLDS.SHARP_TURN_G_MEDIUM),
    SHARP_TURN_G_HIGH: settingNumber(settings.threshold_sharp_turn_g_high, DEFAULT_THRESHOLDS.SHARP_TURN_G_HIGH),
    SPEEDING_FALLBACK_KMH: settingNumber(settings.threshold_speeding_kmh, DEFAULT_THRESHOLDS.SPEEDING_FALLBACK_KMH),
    IDLE_EVENT_SECONDS: settingNumber(settings.threshold_idle_seconds, DEFAULT_THRESHOLDS.IDLE_EVENT_SECONDS),
    LONG_DRIVE_MINUTES: settingNumber(settings.threshold_long_drive_minutes, DEFAULT_THRESHOLDS.LONG_DRIVE_MINUTES),
    ADVANCED_SAFETY_DETECTION_ENABLED: settings.advanced_safety_detection_enabled !== false,
  };
}
```

Phone-use thresholds added by `buildDrivingThresholds`:

```js
PHONE_MICRO_STEER_COUNT: 4,
PHONE_CREEP_RATE_KMH_S: 1.5,
PHONE_LANE_DRIFT_DEG: 8,
PHONE_COUPLING_THRESHOLD: 0.15,
PHONE_CONFIDENCE_THRESHOLD: low ? 0.60 : high ? 0.25 : 0.40,
PHONE_MIN_WINDOW_S: 4,
```

## GPS Distance

Function: `haversineDistance` in `src/lib/tripEngine.js`

Used for route distance, implied speed, route simplification, and trip stats.

```js
export function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R * c;
}
```

## Bearing And Heading Difference

Functions: `calculateBearing`, `headingDiff`, `headingStdDev`

Used for sharp turns, lane changes, near misses, drowsy signatures, phone proxy, and parking analysis.

```js
export function calculateBearing(lat1, lng1, lat2, lng2) {
  const dLng = toRad(lng2 - lng1);
  const rlat1 = toRad(lat1);
  const rlat2 = toRad(lat2);
  const y = Math.sin(dLng) * Math.cos(rlat2);
  const x = Math.cos(rlat1) * Math.sin(rlat2) - Math.sin(rlat1) * Math.cos(rlat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function headingDiff(h1, h2) {
  let diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}
```

## Speed

Function: `calculateSpeedKmh`

```js
export function calculateSpeedKmh(distKm, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  return (distKm / durationSeconds) * 3600;
}
```

## Acceleration

Function: `calculateAcceleration`

Speeds are converted from km/h to m/s first.

```js
export function calculateAcceleration(speed1Kmh, speed2Kmh, durationSeconds) {
  if (durationSeconds <= 0) return 0;
  const v1 = speed1Kmh / 3.6;
  const v2 = speed2Kmh / 3.6;
  return (v2 - v1) / durationSeconds;
}
```

## Segment Metrics And GPS Noise Filtering

Function: `calculateSegmentMetrics`

Each pair of GPS points produces:

- elapsed time
- distance
- implied speed from GPS displacement
- reported device speed
- reliable speed
- noise flag

Important logic:

```js
const distanceKm = haversineDistance(previousPoint.lat, previousPoint.lng, point.lat, point.lng);
const impliedSpeedKmh = calculateSpeedKmh(distanceKm, dt);
const reportedSpeedKmh = Number.isFinite(point.speed_kmh) ? Math.max(0, point.speed_kmh) : null;
const noiseFloorM = movementNoiseFloorMeters(point, previousPoint, thresholds);

const tinyMovement = distanceM < noiseFloorM;
const displacementSaysStill = impliedSpeedKmh < stationarySpeed && distanceM < noiseFloorM * 1.5;
const reportedDisagreesWithDisplacement =
  reportedSpeedKmh != null &&
  reportedSpeedKmh < trustedSpeed &&
  displacementSaysStill;
```

This prevents small GPS jumps from becoming fake speed or fake events.

## Route Cleaning

Functions:

- `normalizeLocationPoint`
- `shouldAcceptLocationPoint`
- `cleanRoutePoints`
- `simplifyRoute`

The app removes invalid points, inaccurate points, impossible jumps, and GPS drift before stats/events are calculated.

## Trip Stats

Function: `calculateTripStats`

Outputs:

- `distance_km`
- `avg_speed_kmh`
- `avg_running_speed_kmh`
- `max_speed_kmh`
- `idle_time_seconds`
- `traffic_idle_seconds`
- `sustained_idle_seconds`
- `gap_seconds`
- `duration_seconds`
- `night_driving`
- `fatigue_risk_score`
- road type fields
- intersection fields
- fatigue progression
- hill driving fields
- drowsy fields
- parking approach fields

Core calculation:

```js
const durationSeconds = Math.max(0, (end.getTime() - start.getTime()) / 1000);

for (let i = 1; i < routePoints.length; i++) {
  const segment = calculateSegmentMetrics(p, c, thresholds);
  if (segment.dt <= 0 || segment.dt > 120) {
    flushIdleRun();
    continue;
  }
  if (segment.isNoise) {
    gapSeconds += segment.dt;
    flushIdleRun();
    continue;
  }

  totalDistance += segment.distanceKm;

  const spd = segment.reliableSpeedKmh;
  if (spd > maxSpeed) maxSpeed = spd;
  if (spd >= thresholds.STATIONARY_SPEED_KMH) {
    movingSeconds += segment.dt;
    flushIdleRun();
  }
  if (spd < thresholds.IDLE_SPEED_KMH) idleRunDuration += segment.dt;
}

const idleTime = trafficIdleSeconds + sustainedIdleSeconds;
const avgSpeed = durationSeconds > 0 && totalDistance > 0
  ? calculateSpeedKmh(totalDistance, durationSeconds)
  : 0;

const avgRunningSpeed = movingSeconds > 0 && totalDistance > 0
  ? calculateSpeedKmh(totalDistance, movingSeconds)
  : 0;
```

Idle runs below `5 km/h` are classified when the run ends:

- less than `300 seconds`: `traffic_idle_seconds`
- `300 seconds` or more: `sustained_idle_seconds`
- `idle_time_seconds`: sum of both buckets for backward compatibility

`gap_seconds` is short noise-filtered time (`dt <= 120`) excluded from both moving and idle buckets. It is retained for debugging and does not affect scores.

The separate idle event threshold remains configurable and defaults to `90 seconds`. That means a long traffic light can still be shown as an idle event while the trip timer keeps it in the traffic-stop bucket instead of treating it like parked/avoidable idle.

## Road Type

Function: `classifyRoadType`

```js
const highwaySpeeds = speeds.filter((speed) => speed >= 80);
const urbanSpeeds = speeds.filter((speed) => speed >= 20 && speed < 80);
const residentialSpeeds = speeds.filter((speed) => speed < 20);

if (fHighway >= 0.60) roadType = 'highway';
else if (fHighway >= 0.30 && fUrban >= 0.30) roadType = 'mixed';
else if (fResidential >= 0.50 && avgSpeed < 30) roadType = 'residential';
```

## Speed Zone Inference

Function: `inferSpeedZones`

DriveSense does not call an external road-speed database. Instead, it estimates contextual speed zones from the observed traffic flow in sliding 60-second windows.

For each window:

```js
const medianSpeed = percentileValue(speeds, 0.5);
const p85Speed = percentileValue(speeds, 0.85);
const spread = speedStdDev(speeds);
```

Zone assignment:

```js
if (p85 < 30) inferredZoneKmh = 30;
else if (p85 < 55) inferredZoneKmh = 50;
else if (p85 < 80) inferredZoneKmh = 70;
else if (p85 < 110) inferredZoneKmh = 100;
else inferredZoneKmh = 120;
```

Confidence:

- `high`: speed standard deviation below `8 km/h`.
- `medium`: speed standard deviation below `18 km/h`.
- `low`: wider spread.

Each zone includes `startIndex`, `endIndex`, `inferredZoneKmh`, `confidence`, road type, and window summary fields. `detectDrivingEvents()` uses the inferred zone plus `threshold_speed_over_kmh` as the contextual speeding threshold and stores `inferred_zone_kmh` and `zone_confidence` on speeding events.

## Event Detection

Function: `detectDrivingEvents`

Detected event types:

```js
harsh_brake
rapid_acceleration
sharp_turn
speeding
idle
lane_change
tailgate_cycle
erratic_speed
near_miss
aggressive_overtake
```

Lane-change detection is intentionally conservative because it is inferred from GPS/heading, not a camera. A candidate now needs a 6-second usable GPS window, speed of at least `50 km/h`, counter-steer, bounded heading excursion, low net heading change, stable speed, and point accuracy no worse than about `35 m`.

Erratic-speed windows now require a 25-second window, high speed variance, at least `18 km/h` of speed range, and repeated speed-direction reversals. Normal cruise, traffic flow, or small GPS speed wobble should not create a distraction event.

Overtake quality is scored only when an aggressive-overtake event exists or when a high-speed lane-change event also has an overtake-like speed-up. A steady highway lane change no longer creates an overtake count by itself.

### Harsh Braking

```js
if (accel != null && accel < -thresholds.HARSH_BRAKE_MS2 && speed1 >= minHarshBrakeSpeed) {
  type: EVENT_TYPES.HARSH_BRAKE
}
```

Default threshold: `-4.5 m/s2`, minimum speed `25 km/h`.

### Rapid Acceleration

```js
if (accel != null && accel > thresholds.RAPID_ACCEL_MS2 && speed1 >= minRapidAccelSpeed) {
  type: EVENT_TYPES.RAPID_ACCELERATION
}
```

Default threshold: `3.5 m/s2`, minimum speed `5 km/h` so hard launches from a stop are counted once the car is actually moving.

### Sharp Turn

Sharp turn is based on GPS geometry across 3 points, not just phone heading.

```js
const rawHeadingChange = headingDiff(h1, h2);
const effectiveDt = Math.max(1.5, (prevSegment.dt + dt) / 2);
const omegaRadPerSec = (rawHeadingChange * Math.PI / 180) / effectiveDt;
const vMps = speed2 / 3.6;
const lateralG = (vMps * omegaRadPerSec) / 9.81;

if (rawHeadingChange >= 25 && lateralG >= lowG) {
  type: EVENT_TYPES.SHARP_TURN
}
```

Severity:

```js
lateralG >= highG ? 'high' : lateralG >= mediumG ? 'medium' : 'low'
```

Defaults:

- low: `0.30 g`
- medium: `0.45 g`
- high: `0.60 g`

### Speeding

Speeding uses the lower of the configured fallback threshold and the inferred zone threshold:

```js
const contextualSpeedingThreshold = Math.min(
  thresholds.SPEEDING_FALLBACK_KMH,
  inferredZoneKmh + thresholds.SPEED_OVER_KMH
);

if (speed2 > contextualSpeedingThreshold) {
  speedingAccumSeconds += dt;
}
```

Default fallback threshold: `130 km/h`.
Default inferred-zone buffer: `10 km/h`.

### Idle

```js
if (speed2 < thresholds.IDLE_SPEED_KMH) {
  idleAccum += dt;
}

if (idleAccum >= thresholds.IDLE_EVENT_SECONDS) {
  type: EVENT_TYPES.IDLE
}
```

Default idle speed: `< 5 km/h`.
Default idle event duration: `90 seconds`.

### Near Miss

Near miss requires hard braking and fast heading change.

```js
if (advancedSafetyEnabled && accel != null && dt <= 2.0 && speed2 > 40 && accel < -nearMissBrakeThreshold) {
  const headingRate = headingDiff(h1, h2) / dt;
  if (headingRate > nearMissTurnThreshold) {
    type: EVENT_TYPES.NEAR_MISS
  }
}
```

Defaults:

- braking threshold: `3.5 m/s2`
- turn threshold: `30 deg/s`

## Lane Changes

Function: `detectLaneChanges`

Only considered at highway speeds.

```js
if (finiteSpeed(prev) <= 80 || finiteSpeed(curr) <= 80) continue;

const turnRate = headingDiff(h1, h2) / dt;
if (turnRate > 2 && turnRate < 20) candidates.push({ point: curr, turnRate });
```

Severity is based on lane-change rate per 10 km:

```js
const ratePer10Km = (merged.length / distanceKm) * 10;
const severity = ratePer10Km >= 4 ? 'high' : ratePer10Km >= 2 ? 'medium' : 'low';
```

## Tailgating Proxy

Function: `detectTailgateCycles`

This does not measure actual following distance because there is no radar/camera. It is a proxy based on repeated highway deceleration cycles.

The result feeds:

- `tailgate_cycle_count`
- `following_distance_score`
- defensive score

## Erratic Speed Windows

Function: `detectErraticSpeedWindows`

Looks for unstable speed behavior across sliding windows. Feeds:

- `distraction_events_count`
- `distraction_score`
- phone/distraction coaching

## Phone Use Detection

Primary function: `detectPhoneUseWindows`

This is a GPS-only proxy. It detects likely phone-use windows from micro-steering oscillation, speed creep with correction, attention gaps, lane drift with recovery, and speed-heading decoupling. It returns first-class `phone_use` events and aggregate score fields:

- `phone_use_events`
- `phone_use_window_count`
- `phone_use_total_seconds`
- `phone_use_high_confidence_count`
- `phone_use_risk`
- `phone_use_score`
- `phone_use_pct_of_trip`

Compatibility functions: `detectPhoneUsageProxy` and `detectPhoneProxy`

These return the legacy fields:

- `phone_proxy_count`
- `phone_proxy_risk`

## Speed Creep

Functions:

- `detectSpeedCreep`
- `detectSpeedCreepWithThresholds`

Detects gradual drifting above expected speed bands. Feeds eco and coaching.

## Jerk Score

Function: `calculateJerkScore`

Jerk is the change in acceleration over time.

```js
const v0 = finiteSpeed(prev) / 3.6;
const v1 = finiteSpeed(curr) / 3.6;
const v2 = finiteSpeed(next) / 3.6;
const a1 = (v1 - v0) / dt1;
const a2 = (v2 - v1) / dt2;
const jerk = (a2 - a1) / ((dt1 + dt2) / 2);
const absJerk = Math.abs(jerk);

if (absJerk > 6) totalJerkPenalty += 4;
else if (absJerk > 3) totalJerkPenalty += 2;
else if (absJerk > 1.5) totalJerkPenalty += 1;

const jerkScore = Math.max(0, 100 - Math.min(totalJerkPenalty * (4 / distFactor), 80));
```

Outputs:

- `jerk_score`
- `jerk_event_count`
- `avg_jerk_ms3`

## Eco Driving Score

Function: `calculateEcoDrivingScore`

```js
const mean = average(movingSpeeds);
const variance = average(movingSpeeds.map((speed) => (speed - mean) ** 2));
const cv = Math.sqrt(variance) / Math.max(1, mean);
const speedStability = Math.max(0, 100 - cv * 150);

const cruiseRatio = movingSpeeds.filter((speed) => speed >= 55 && speed <= 90).length / movingSpeeds.length;
const cruiseScore = Math.min(100, cruiseRatio * 130);

const avoidableIdleSeconds = stats.sustained_idle_seconds ?? stats.idle_time_seconds ?? 0;
const idleRatio = avoidableIdleSeconds / Math.max(1, stats.duration_seconds || 0);
const idlePenalty = Math.min(25, idleRatio * 150);

const ecoDrivingScore = Math.round(
  speedStability * 0.40 +
  cruiseScore * 0.35 +
  Math.max(0, 100 - idlePenalty) * 0.25
);
```

## Speed Variability Index

Function: `calculateSpeedVariabilityIndex`

```js
const mean = average(samples);
const variance = average(samples.map((speed) => (speed - mean) ** 2));
const svi = round1(Math.sqrt(variance));
const sviScore = Math.max(0, Math.round(100 - svi * 1.5));
```

Labels:

```js
svi < 10  -> very smooth
svi < 20  -> smooth
svi < 35  -> variable
svi < 50  -> erratic
else      -> very erratic
```

## Fuel Band Score

Function: `calculateFuelBandScore`

The optimal efficiency band is steady travel from `60` to `90 km/h`.

```js
if (speed > 5) totalMovingSeconds += segment.dt;
if (speed >= 60 && speed <= 90 && accelMs2 >= -0.5 && accelMs2 <= 0.5) {
  optimalBandSeconds += segment.dt;
}

const optimalBandRatio = totalMovingSeconds > 0
  ? Math.round((optimalBandSeconds / totalMovingSeconds) * 100)
  : 0;

const fuelBandScore = Math.min(100, Math.round(optimalBandRatio * 1.4));
```

## Hill Driving Score

Function: `calculateHillDrivingScore`

Requires altitude on at least half the points.

```js
const gradient = ((curr.altitude - prev.altitude) / distanceM) * 100;
const isClimb = gradient >= 5;
const isDescent = gradient <= -5;

if (isClimb && accelMs2 > 2.5) infractionCount++;
if (isDescent && accelMs2 < -harshBrakeThreshold) infractionCount++;

hill_driving_score: Math.max(0, 100 - infractionCount * 10)
```

## Intersection Behavior

Function: `analyzeIntersectionBehavior`

This examines low-speed stop/approach behavior and returns:

- `intersection_score`
- `stop_count`
- `rolling_stop_count`
- `smooth_approach_count`
- `intersection_events`

The score is used directly in the final overall score.

## Smooth Braking Ratio

Function: `calculateSmoothBrakingRatio`

Used by the defensive score. It measures how often braking is smooth instead of harsh.

Output:

- `smooth_braking_ratio`
- braking-related counts

## Parking Approach

Function: `analyzeParkingApproach`

Looks at the final low-speed approach before the trip ends. Outputs:

- `parking_approach_score`
- `parking_approach_grade`

## Fatigue Score

Function: `calculateFatigueScore`

```js
const durationMinutes = (durationSeconds || 0) / 60;
const durationScore = Math.min(5, durationMinutes / 30);

let timeScore = 0;
if (startHour >= 2 && startHour < 5) timeScore = 5;
else if (startHour >= 5 && startHour < 7) timeScore = 3;
else if (startHour >= 13 && startHour < 15) timeScore = 2;
else if (startHour >= 22 || startHour < 2) timeScore = 3;

return Math.min(10, Math.round((durationScore + timeScore) * 10) / 10);
```

## Night Driving

Functions:

- `isNightDrivingTime`
- `calculateNightPenalty`

Night can be based on sunset/sunrise or fixed clock times.

```js
if (!routePoints || routePoints.length === 0) return 0;
const n = routePoints.length;
const normalNightPoints = nightPoints - deepNightPoints;
return (normalNightPoints / n) * 8 + (deepNightPoints / n) * 12;
```

Deep-night points are counted as a subset of night points, so the formula separates them first. Normal night has weight `8`; deep night has exclusive weight `12`.

## Drowsy Driving Signature

Functions:

- `analyzeFatigueProgression`
- `detectDrowsyDrivingSignature`
- `detectDrowsyDriving`

Looks for fatigue-like patterns such as heading drift, erratic windows, and late-trip degradation.

Outputs:

- `drowsy_window_count`
- `drowsy_risk_score`
- `drowsy_risk_level`
- `fatigue_progression`
- `segment_scores`

## Engine Stress Score

Function: `calculateEngineStressScore`

Only rapid acceleration events increase engine stress. Higher speed acceleration counts more.

```js
const speedMultiplier = (speedKmh) => (
  speedKmh >= 100 ? 3.0 : speedKmh >= 70 ? 2.0 : speedKmh >= 40 ? 1.3 : 1.0
);

engineStressRaw += basePenalty[event.severity] * speedMultiplier(speed);

const distFactor = Math.max(1, stats.distance_km || 1);
const score = Math.max(0, Math.round(100 - Math.min(engineStressRaw * (5 / distFactor), 100)));
```

## Tire Wear Units

Function: `calculateTireWearUnits`

Harsh braking and sharp turns create tire wear. Speed increases wear quadratically.

```js
if (event.type === EVENT_TYPES.HARSH_BRAKE) {
  units += severityBase[event.severity] * ((event.speed_kmh ?? 50) / 50) ** 2;
}

if (event.type === EVENT_TYPES.SHARP_TURN) {
  units += severityBase[event.severity] * ((event.speed_kmh ?? 40) / 40) ** 2;
}
```

## Aggressive Driving Score

Function: `calculateAggressiveDrivingScore`

Weights:

```js
harsh_brake: { low: 3, medium: 7, high: 15 }
rapid_acceleration: { low: 2, medium: 5, high: 10 }
sharp_turn: { low: 2, medium: 5, high: 10 }
speeding: { low: 5, medium: 10, high: 20 }
near_miss: { low: 8, medium: 18, high: 35 }
aggressive_overtake: { low: 12, medium: 25, high: 45 }
```

Formula:

```js
const rawPenalty = events.reduce((sum, event) => sum + (weights[event.type]?.[event.severity] || 0), 0);
const jerkPenalty = Math.min(Math.max((avgJerkMs3 - 0.3) * 20, 0), 25);
const combinedPenalty = rawPenalty + jerkPenalty;
const distFactor = Math.max(1, stats.distance_km || 1);
const normalizedPenalty = Math.min(combinedPenalty * (5 / distFactor), 100);
const score = Math.max(0, Math.round(100 - normalizedPenalty));
```

Grades:

```js
score >= 90 -> calm
score >= 75 -> moderate
score >= 55 -> assertive
else        -> aggressive
```

## Defensive Driving Score

Function: `calculateDefensiveDrivingScore`

```js
const defensiveScore = Math.round(
  (scores.smooth_braking_ratio ?? 100) * 0.25 +
  (scores.intersection_score ?? 100) * 0.20 +
  (scores.svi_score ?? 100) * 0.20 +
  (scores.following_distance_score ?? 100) * 0.20 +
  (scores.near_miss_score ?? 100) * 0.15
);
```

Grades:

```js
defensiveScore >= 90 -> exemplary
defensiveScore >= 75 -> defensive
defensiveScore >= 55 -> average
else                 -> reactive
```

## Main Trip Scores

Function: `calculateTripScores`

First, events are converted into penalties:

```js
harsh_brake: { low: 3, medium: 6, high: 12 }
rapid_acceleration: { low: 2, medium: 5, high: 10 }
sharp_turn: { low: 2, medium: 5, high: 10 }
speeding: { low: 5, medium: 10, high: 20 }
idle: { low: 1, medium: 3, high: 5 }
lane_change: { low: 2, medium: 5, high: 10 }
tailgate_cycle: { low: 3, medium: 8, high: 15 }
erratic_speed: { low: 2, medium: 5, high: 10 }
near_miss: { low: 8, medium: 18, high: 35 }
aggressive_overtake: { low: 12, medium: 25, high: 45 }
```

Harsh brakes and sharp turns at higher speed get a multiplier:

```js
const speedFactor = 1 + Math.max(0, Math.min(1.5, (evt.speed_kmh - 30) / 60));
p *= speedFactor;
```

Penalty normalization:

```js
const distKm = Math.max(1, stats.distance_km || 1);
const SCORE_FLOOR = 20;
const MAX_DEDUCTION = 80;
const SCALE_FACTOR = 40.0;

const normalize = (totalPenalty) => {
  const penaltyRate = totalPenalty / distKm;
  const deduction = Math.min(penaltyRate * SCALE_FACTOR, MAX_DEDUCTION);
  return Math.max(SCORE_FLOOR, Math.round(100 - deduction));
};
```

Phone-use detection:

`detectPhoneUseWindows(routePoints, thresholds)` emits first-class `phone_use` events and aggregate scoring fields. It fuses five GPS behaviour signals: micro-steering oscillation, speed creep with correction, attention-gap windows, lane drift with recovery, and speed-heading decoupling. Votes are smoothed, merged across brief gaps, and converted to windows with confidence, severity, midpoint location, speed, duration, and triggered signal names.

Aggregate outputs include:

- `phone_use_window_count`
- `phone_use_total_seconds`
- `phone_use_high_confidence_count`
- `phone_use_risk`
- `phone_use_score`
- `phone_use_pct_of_trip`

Final component scores:

```js
const safetyBase =
  baseSafety * 0.60 +
  followingDistanceScore * 0.10 +
  (braking_efficiency_score ?? 100) * 0.15 +
  overall_compliance_score * 0.10 +
  (phoneUse.phone_use_score ?? 100) * 0.05;
const safety = Math.min(100, Math.round(
  overtake_count > 0
    ? safetyBase * 0.95 + overtake_quality_score * 0.05
    : safetyBase
) + safety_condition_bonus);
const smoothness = Math.round(
  baseSmoothness * 0.45 +
  jerk.jerk_score * 0.25 +
  svi.svi_score * 0.10 +
  reaction_score * 0.10 +
  (cornering_consistency_score ?? 100) * 0.10
);
const eco = Math.round(baseEco * 0.40 + ecoDriving.eco_driving_score * 0.40 + fuelBand.fuel_band_score * 0.20);
const overall = Math.min(100, Math.round(
  safety * 0.35 + smoothness * 0.30 + eco * 0.20 + intersectionScore * 0.15
));
```

## Score Colors

Function: `getScoreColor`

```js
score >= 85 -> Excellent
score >= 70 -> Good
score >= 55 -> Fair
score >= 40 -> Poor
else        -> Risky
```

## Map Speed Colors

Functions:

- `getSpeedColor`
- `getSpeedLabel`
- `buildSpeedSegments`

```js
if (speedKmh >= 120) return '#ef4444'; // Risk
if (speedKmh >= 90) return '#f97316';  // Fast
if (speedKmh >= 55) return '#22c55e';  // Cruise
if (speedKmh >= 15) return '#3b82f6';  // City
return '#94a3b8';                      // Slow
```

Route segments are generated from point pairs:

```js
segments.push({
  from: prev,
  to: curr,
  speed_kmh: speed,
  color: getSpeedColor(speed),
  label: getSpeedLabel(speed),
});
```

## Trip Stops

Function: `detectTripStops`

Default stopped definition:

```js
minStopSeconds = 90
maxSpeedKmh = 5
```

Any continuous section at or below `5 km/h` for at least `90 seconds` becomes a stop.

## Trip Splitting

Function: `splitTripAtStops`

Trip splitting uses `detectTripStops()` and treats stops of `minParkMinutes` or longer as separators. The default UI path uses `5 minutes`.

For each generated driving segment:

```js
const stats = calculateTripStats(segmentPoints, segmentStart, segmentEnd, thresholds);
const events = detectDrivingEvents(segmentPoints, thresholds);
const scores = calculateTripScores(events, stats, segmentPoints, thresholds, stats.duration_seconds);
const economics = estimateTripEconomics({ ...stats, ...scores });
```

Each sub-trip receives a new id, recalculated start/end time, route points, driving events, scores, statistics, economics, `split_parent_id`, and `split_segment_index`. Vehicle id, tag, background-tracking flag, and start source are inherited from the parent. The original trip is not deleted by the engine; the Trip Detail confirmation flow deletes it after saving all sub-trips.

## Fuel, Cost, And CO2

Function: `estimateTripEconomics`

Defaults:

```js
DEFAULT_FUEL_PRICE_PER_LITER = 1.65
DEFAULT_L_PER_100KM = 8.5
GASOLINE_CO2_KG_PER_LITER = 2.31
```

Formula:

```js
const efficiencyMultiplier = Math.max(0.7, 1 + (ecoDrivingScore - 50) / 200);
const actualLPer100Km = lPer100Km / efficiencyMultiplier;
const baselineLiters = distanceKm * lPer100Km / 100;
const adjustedLiters = distanceKm * actualLPer100Km / 100;
const cost = adjustedLiters * fuelPrice;
const baselineCost = baselineLiters * fuelPrice;
const co2Kg = adjustedLiters * GASOLINE_CO2_KG_PER_LITER;
const fuelSavedLiters = Math.max(0, baselineLiters - adjustedLiters);
```

## Vehicle Odometer And Maintenance

Functions:

- `getVehicleTripDistanceKm`
- `getVehicleOdometerKm`
- `getMaintenanceItems`
- `getMaintenanceStatus`

Default maintenance:

```js
oil change: 8000 km
tire rotation: 10000 km
inspection: 20000 km
```

Status:

```js
remainingKm <= 0    -> due
remainingKm <= 1000 -> soon
else                -> ok
```

## Vehicle Health Impact

Function: `calculateVehicleHealthImpact`

Stress units:

```js
harsh_brake: { low: 1.5, medium: 4, high: 8 }
rapid_acceleration: { low: 1, medium: 3, high: 6 }
sharp_turn: { low: 0.5, medium: 2, high: 4 }
tailgate_cycle: { low: 1, medium: 3, high: 5 }
lane_change: { low: 0.5, medium: 1.5, high: 3 }
```

Extra wear:

```js
extra_wear_km = totalStressUnits * 8
adjusted_oil_change_km = aggressiveRatio > 0.3 ? oilBase * 0.85 : oilBase
adjusted_tire_rotation_km = aggressiveRatio > 0.3 ? tireBase * 0.80 : tireBase
```

## Carbon Impact

Function: `calculateCarbonImpact`

```js
const totalCo2SavedKg = sum(trip.co2_saved_kg);
const treesEquivalent = totalCo2SavedKg / 21.0;
```

Grades:

```js
>= 100 kg -> Climate Champion
>= 50 kg  -> Green Driver
>= 20 kg  -> Eco Aware
>= 5 kg   -> Getting There
else      -> Starting Out
```

## Weekly Goals

Function: `calculateWeeklyDrivingGoals`

Uses current week completed trips and checks:

- harsh brakes under target
- speeding events under target
- average score over target
- night trips under target

Defaults:

```js
weekly_goal_harsh_brakes = 5
weekly_goal_speeding_events = 3
weekly_goal_min_avg_score = 80
weekly_goal_max_night_trips = 3
```

## No Harsh Brake Streak

Function: `calculateNoHarshBrakeStreak`

Groups completed trips by day, then counts backward from the latest driving day until it finds a day with harsh brakes.

## Time Of Day Analysis

Function: `analyzeTimeOfDay`

Buckets:

```js
morning:   5a-12p
afternoon: 12p-5p
evening:   5p-10p
night:     10p-5a
```

For each bucket it calculates:

- trip count
- average score
- total risky events

## Day Of Week Analysis

Function: `analyzeDayOfWeek`

For each day, it calculates:

- trip count
- average score
- total risky events

## Fatigue Risk Summary

Function: `calculateFatigueRisk`

```js
const thresholdMinutes = Number(settings.threshold_long_drive_minutes || 120);
const longTrips = trips.filter((trip) => (trip.duration_seconds || 0) / 60 >= thresholdMinutes);

level =
  longTrips.length >= 3 || longestTripMinutes >= thresholdMinutes * 1.5
    ? 'high'
    : longTrips.length > 0
      ? 'medium'
      : 'low'
```

## Risk Event Rate

Function: `calculateRiskEventRate`

Counts all risk events and normalizes per 100 km.

```js
const per100Km = distanceKm > 0 ? Math.round((totalEvents / distanceKm) * 1000) / 10 : 0;
```

## Personal Baseline

Function: `computePersonalBaseline`

Calculates:

- 4-week baseline average
- current week average
- delta
- trend
- percentile
- personal best week
- personal best trip

Trend:

```js
delta >= 5  -> improving
delta <= -5 -> declining
else        -> steady
```

## Peak Hour Stress

Function: `calculatePeakHourStress`

Peak hours:

```js
7, 8, 16, 17, 18
```

Formula:

```js
const eventsPerKm = eventCount / Math.max(1, trip.distance_km || 0);
const stressRatio = Math.min(5, offPeakAvg > 0.01 ? peakAvg / offPeakAvg : 1.0);
const peakStressScore = Math.max(0, Math.round(100 - (stressRatio - 1) * 40));
```

## Commute Patterns

Function: `identifyCommutePatterns`

Trips are grouped by rounded start and end cells:

```js
const cell = (point) => `${Math.round(point.lat * 200) / 200},${Math.round(point.lng * 200) / 200}`;
const routeKey = `${cell(points[0])}|${cell(points[points.length - 1])}`;
```

Routes need at least 3 trips to count as a commute pattern.

## Speed Discipline

Function: `calculateSpeedDiscipline`

```js
const speedLimit = Number(settings.threshold_speeding_kmh ?? 130);
const warnLimit = speedLimit + Number(settings.threshold_speed_over_kmh ?? 10);
const overLimitPercent = Math.round((overLimit / speeds.length) * 100);
const p85Speed = percentile(speeds, 85);
```

Level:

```js
overWarn > 0 || overLimitPercent >= 10 -> needs_attention
overLimitPercent > 0 || p85Speed > speedLimit * 0.85 -> watch
else -> steady
```

## Driving Consistency

Function: `calculateDrivingConsistency`

Uses score interquartile range.

```js
const q1 = percentile(scores, 25);
const q3 = percentile(scores, 75);
const iqr = q3 - q1;
const consistencyScore = Math.max(0, Math.round(100 - iqr * 1.8));
```

Level:

```js
consistencyScore >= 85 -> steady
consistencyScore >= 70 -> mixed
else                   -> inconsistent
```

## Driving Coach Insights

Function: `buildDrivingCoachInsights`

Combines:

- risk event rate
- speed discipline
- consistency
- fatigue
- personal baseline
- peak hour stress
- commute patterns
- carbon impact
- time of day

It then picks a `focus_area` and up to 4 suggested actions.

## Live Coach Overlay

Component: `LiveCoachOverlay`

During an active trip, the overlay recalculates partial-trip stats and events every `60 seconds`:

```js
const stats = calculateTripStats(currentRoutePoints, tripStartTime, new Date(), thresholds);
const events = detectDrivingEvents(currentRoutePoints, thresholds);
```

Only one message is shown at a time. Priority is:

1. Near miss in the last 120 seconds.
2. New harsh brake count since the last check.
3. Current speed above the contextual speed threshold.
4. New rapid acceleration count since the last check.
5. More than 5 minutes of idle time.

The setting `live_coaching_enabled` disables this feature completely.

Live coaching evaluates active trips every `15 seconds`. Voice alerts use the device/browser `speechSynthesis` API when `voice_alerts_enabled` is true. Settings includes a test button that speaks a short Road Sage phrase and reports when speech output is unavailable in the current browser or Android WebView.

## Achievement Badges

Function: `calculateAchievementBadges`

Uses completed trips to check milestones like:

- total kilometers
- clean trips
- no harsh brake streak
- no rapid acceleration trips
- no sharp turn trips
- no speeding trips
- route replay trips
- smooth braking trips
- distraction-free trips
- defensive driving streaks

## Auto Start And Auto Stop

JavaScript function: `shouldAutoStartTracking` in `src/lib/activityRecognition.js`

```js
export function shouldAutoStartTracking({ activity, currentSpeedKmh = 0, recentMovingSeconds = 0 }) {
  const vehicleConfidence = activity?.type === ACTIVITY_TYPES.IN_VEHICLE ? activity.confidence || 0 : 0;
  return vehicleConfidence >= 70 && currentSpeedKmh >= 5 && recentMovingSeconds >= 10;
}
```

JavaScript function: `shouldAutoStopTracking`

```js
export function shouldAutoStopTracking({
  activity,
  currentSpeedKmh = 0,
  stillSeconds = 0,
  gpsPositionDriftM = Number.POSITIVE_INFINITY,
  lastMovingSpeedKmh = 0,
}) {
  // Fast path: WALKING/RUNNING/CYCLING with confidence >= 75 and speed < 5 stops after 15s.
  // STILL + stable GPS (< 8m drift) stops after 90s.
  // STILL + drift (>= 8m) waits 150s.
  // IN_VEHICLE + stopped has three paths:
  // 240s with very stable GPS (< 5m drift).
  // 360s with relaxed urban GPS drift (< 20m).
  // 420s at current speed < 2 km/h with parked-like drift (< 20m).
  // 600s at current speed < 2 km/h and last moving speed < 5 km/h as a final parked safety net.
  // Missing or UNKNOWN activity waits 300s and requires stable GPS (< 8m drift).
}
```

`computeGpsPositionDrift(stoppedLat, stoppedLng, recentPoints)` measures the maximum haversine displacement in meters from the point where speed first dropped below `5 km/h`. This gives auto-stop the context needed to separate a stable parked car from GPS drift or crawling traffic.

## Native Android Background Tracking

File: `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`

Constants:

```java
private static final int MIN_VEHICLE_CONFIDENCE = 70;
private static final int MIN_STILL_CONFIDENCE = 70;
private static final long AUTO_STOP_FOOT_MS = 15_000L;
private static final long AUTO_STOP_STILL_STABLE_MS = 90_000L;
private static final long AUTO_STOP_STILL_DRIFT_MS = 150_000L;
private static final long AUTO_STOP_IN_VEHICLE_MS = 240_000L;
private static final long AUTO_STOP_IN_VEHICLE_EXTENDED_MS = 360_000L;
private static final long AUTO_STOP_IN_VEHICLE_ABSOLUTE_MS = 420_000L;
private static final long AUTO_STOP_NO_ACTIVITY_MS = 300_000L;
private static final long STALE_LOCATION_STOP_MS = 30_000L;
private static final double GPS_STILL_DRIFT_M = 8.0d;
private static final double GPS_VEHICLE_DRIFT_M = 5.0d;
private static final double GPS_VEHICLE_DRIFT_RELAXED_M = 20.0d;
private static final double STATIONARY_SPEED_KMH = 5d;
private static final double MIN_TRUSTED_SPEED_KMH = 18d;
private static final double MAX_SPEED_KMH = 220d;
```

Native start:

```java
if (type == DetectedActivity.IN_VEHICLE && confidence >= MIN_VEHICLE_CONFIDENCE) {
    stillSinceMs = 0L;
    nonVehicleSinceMs = 0L;
    startTripIfNeeded();
    return;
}
```

Native stop:

```java
boolean speedStopped = lastKnownSpeedKmh < STATIONARY_SPEED_KMH;
boolean gpsStable = maxDriftSinceStopM < GPS_STILL_DRIFT_M && !Double.isNaN(stoppedAnchorLat);
boolean gpsVeryStable = maxDriftSinceStopM < GPS_VEHICLE_DRIFT_M && !Double.isNaN(stoppedAnchorLat);

// WALKING/RUNNING/ON_BICYCLE + stopped: finish after 15s.
// STILL + stopped: finish after 90s when GPS is stable, otherwise wait 150s.
// IN_VEHICLE + stopped: finish after 240s when GPS drift is under 5m.
// IN_VEHICLE + stopped: finish after 360s when GPS drift is under 20m.
// IN_VEHICLE + stopped: finish after 420s when speed is under 2 km/h and drift is under 20m.
// IN_VEHICLE + stopped: finish after 600s when near-zero speed persists as a safety net.
// UNKNOWN + stopped: finish after 300s only when GPS drift is under 8m.
```

Native `recordLocation()` maintains `stoppedAnchorLat`, `stoppedAnchorLng`, and `maxDriftSinceStopM`. Moving at or above `5 km/h` resets the anchor, max GPS drift, and stop timers; dropping below `5 km/h` anchors the stop position and tracks maximum drift from that point.

Native stats:

```java
double distance = haversineKm(prevLat, prevLng, currLat, currLng);
long dt = Math.max(0L, (currMs - prevMs) / 1000L);
if (dt == 0L) continue;
double impliedSpeed = distance / (dt / 3600d);
double reportedSpeed = curr.optDouble("speed_kmh", impliedSpeed);
double speed = reliableSpeed(impliedSpeed, reportedSpeed);

stats.distanceKm += distance;
stats.maxSpeedKmh = Math.max(stats.maxSpeedKmh, speed);
if (speed >= STATIONARY_SPEED_KMH) stats.movingSeconds += dt;
if (speed < STATIONARY_SPEED_KMH) stats.idleSeconds += dt;
```

Native average speed:

```java
stats.avgSpeedKmh = stats.durationSeconds > 0L && stats.distanceKm > 0d
    ? stats.distanceKm / (stats.durationSeconds / 3600d)
    : 0d;

stats.avgRunningSpeedKmh = stats.movingSeconds > 0L && stats.distanceKm > 0d
    ? stats.distanceKm / (stats.movingSeconds / 3600d)
    : 0d;
```

The native completed-trip JSON emits both `avg_speed_kmh` for total-duration average and `avg_running_speed_kmh` for moving-time average.

## Native GPS Noise Filter

```java
private double noiseFloor(double previousAccuracy, double currentAccuracy) {
    double bestAccuracy = (previousAccuracy > 0d && currentAccuracy > 0d)
        ? Math.min(previousAccuracy, currentAccuracy)
        : Math.max(previousAccuracy, currentAccuracy);
    return Math.max(MIN_POINT_DISTANCE_M, Math.min(25d, bestAccuracy * 0.6d));
}

private boolean isNoise(double distanceM, double impliedSpeedKmh, double reportedSpeedKmh, double previousAccuracy, double currentAccuracy) {
    double floor = noiseFloor(previousAccuracy, currentAccuracy);
    boolean tinyMovement = distanceM < floor;
    boolean displacementSaysStill = impliedSpeedKmh < STATIONARY_SPEED_KMH && distanceM < floor * 1.5d;
    boolean reportedDisagrees = reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH && displacementSaysStill;
    return tinyMovement || reportedDisagrees;
}
```

## Formatting And Export Calculations

Functions in `src/lib/tripEngine.js`:

- `formatDuration`
- `formatDistance`
- `formatSpeed`
- `formatDate`
- `formatTime`
- `formatDateTime`
- `generateReportSummary`
- `tripsToCSV`

These do not change score values. They only format values for UI, reports, and CSV export.

Trip Detail and Reports use `avg_running_speed_kmh` as the primary displayed average speed. Trip Detail shows `avg_speed_kmh` as "Overall avg (incl. stops)" only when stopped time is above `60 seconds`.

`tripsToCSV` exports both speed averages: `Avg Speed (km/h)` for total-duration average and `Avg Moving Speed (km/h)` for `avg_running_speed_kmh`.

Function in `src/lib/pdfExport.js`:

- `exportMonthlyReportPDF`

The monthly PDF export computes period totals from the supplied trip list:

```js
const tripList = Array.isArray(trips) ? trips : [];
const summary = generateReportSummary(tripList);
const sortedByDistance = [...tripList].sort((a, b) => (b.distance_km ?? 0) - (a.distance_km ?? 0));
```

It reuses `generateReportSummary`, `calculateNoHarshBrakeStreak`, and `estimateTripEconomics` for best/worst/longest trip, streak, cost, and CO2 summaries. PDF charts are intentionally omitted in v1; charts remain in the Reports page.

Reports now shows an in-app toast for CSV, monthly PDF, and score-card PDF exports on both browser and Android. Android exports also schedule an `export_saved` local notification with the saved content URI and MIME type; tapping it asks the native plugin to open the saved file or Downloads location.

## Full Function Index

### `src/lib/tripEngine.js`

```text
buildDrivingThresholds
haversineDistance
calculateBearing
headingDiff
headingStdDev
speedStdDev
calculateSpeedKmh
calculateAcceleration
calculateSegmentMetrics
computeSmoothedAccelerations
normalizeLocationPoint
shouldAcceptLocationPoint
cleanRoutePoints
simplifyRoute
calculateRouteSummary
classifyRoadType
inferSpeedZones
splitTripAtStops
calculateJerkScore
calculateHillDrivingScore
calculateEcoDrivingScore
calculateSpeedVariabilityIndex
calculateFuelBandScore
detectLaneChanges
detectHighwayMergeBehavior
detectTailgateCycles
calculateWindowStats
calculateAngularStdDev
detectErraticSpeedWindows
detectSpeedCreep
detectSpeedCreepWithThresholds
detectPhoneUsageProxy
detectPhoneProxy
analyzeIntersectionBehavior
calculateSmoothBrakingRatio
analyzeParkingApproach
scoreSegmentPoints
analyzeFatigueProgression
detectDrowsyDrivingSignature
detectDrowsyDriving
detectAggressiveOvertakes
detectDrivingEvents
detectNearMisses
calculateFatigueScore
isNightDrivingTime
calculateNightPenalty
calculateTripStats
calculateEngineStressScore
calculateTireWearUnits
calculateAggressiveDrivingScore
calculateDefensiveDrivingScore
calculateTripScores
getScoreColor
getScoreGradient
formatDuration
formatDistance
formatSpeed
formatDate
formatTime
formatDateTime
generateReportSummary
tripsToCSV
```

### `src/lib/pdfExport.js`

```text
exportMonthlyReportPDF
```

### `src/lib/tripInsights.js`

```text
percentile
getSpeedColor
getSpeedLabel
buildSpeedSegments
detectTripStops
getVehicleTripDistanceKm
getVehicleOdometerKm
getMaintenanceItems
getMaintenanceStatus
estimateTripEconomics
suggestTripTag
buildScoreTips
calculateWeeklyDrivingGoals
calculateNoHarshBrakeStreak
analyzeTimeOfDay
analyzeDayOfWeek
calculateFatigueRisk
calculateRiskEventRate
computePersonalBaseline
calculatePeakHourStress
identifyCommutePatterns
calculateTireWearUnits
calculateCarbonImpact
calculateVehicleHealthImpact
calculateSpeedDiscipline
calculateDrivingConsistency
buildDrivingCoachInsights
calculateAchievementBadges
```

### `src/lib/activityRecognition.js`

```text
computeGpsPositionDrift
shouldAutoStartTracking
shouldAutoStopTracking
```

### `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`

```text
handleActivity
recordLocation
finishTrip
calculateStats
noiseFloor
isNoise
reliableSpeed
haversineKm
round
```
## Advanced Driving Analysis Additions

DriveSense now writes the following advanced analysis fields during the scoring pipeline:

1. `calculateTripStats` stores inferred `speed_zones` alongside the existing road-type and fatigue stats.
2. `calculateTripScores` writes reaction timing, cornering consistency, braking efficiency, speed-limit compliance, overtake quality, slippery-condition proxy, road-type segmented scores, and explicit `near_miss_score` fields onto the returned score object.
3. `near_miss_score` is explicitly calculated before `defensive_driving_score`:

```js
near_miss_score = nearMissCount === 0
  ? 100
  : Math.max(0, Math.round(100 * Math.pow(0.60, nearMissCount)));
```

4. Smoothness now blends base smoothness, jerk, SVI, reaction score, and cornering consistency:

```js
score_smoothness = round(
  baseSmoothness * 0.45 +
  jerk_score * 0.25 +
  svi_score * 0.10 +
  reaction_score * 0.10 +
  (cornering_consistency_score ?? 100) * 0.10
);
```

5. Safety now blends base safety, following distance, braking efficiency, road-type speed compliance, optional phone-use penalty, optional overtake quality, and road-condition bonus.
6. `extractBrakingSequences(routePoints, thresholds, options)` is the shared helper for full-stop braking analysis and slippery-condition proxy detection.
7. `detectPhoneUseWindows(routePoints, thresholds)` is the primary phone-use path used by `detectDrivingEvents`; legacy phone proxy helpers remain for backward compatibility.
8. `tripInsights.js` adds display/history-level helpers: `buildFatigueHeatmapData`, `buildDriverSignature`, and `calculatePredictiveMaintenance`.

## May 2026 Advanced Safety And Reporting Engines

DriveSense now includes six local-only analysis engines that derive additional driver context from completed trips:

- `src/lib/dangerZoneEngine.js`
  - `buildDangerZones(trips, options)` clusters historical `harsh_brake`, `near_miss`, `sharp_turn`, and `aggressive_overtake` events into quantized GPS cells.
  - Each zone stores center coordinates, radius, event count, severity score, risk level, dominant event type, type breakdown, and last-seen timestamp.
  - Risk levels use severity score bands: `critical >= 15`, `high >= 8`, `medium >= 4`, otherwise `low`.
  - `checkDangerZoneProximity(lat, lng, zones, radiusM)` returns nearby zones sorted by Haversine distance.
  - Cached in `drivesense_danger_zones` and invalidated when completed trips are created/imported.

- `src/lib/thresholdCalibration.js`
  - `computeCalibrationProfile(trips, thresholds)` requires at least `15` completed trips and `200 km`.
  - It computes braking, acceleration, and turn distributions from route points/events and suggests personalized thresholds.
  - Harsh braking suggestions are clamped to `[3.0, 7.0]`; rapid acceleration suggestions are clamped to `[2.0, 6.0]`.
  - Confidence is `high` at `40 trips / 500 km`, `medium` at `20 trips / 250 km`, and `low` otherwise.
  - Cached in `drivesense_calibration_profile`.

- `src/lib/dailyFatigueEngine.js`
  - `getTodayTrips(trips)` filters completed trips by the local current day.
  - `computeDailyFatigue(todayTrips, settings)` sums moving drive minutes, trip count, rest time, and break duration into a `0-10` cumulative fatigue score.
  - Fatigue levels are `critical >= 7`, `high >= 5`, `moderate >= 3`, otherwise `low`.
  - Recommended breaks are `30`, `20`, `10`, or `0` minutes for critical/high/moderate/low.

- `src/lib/ubiReport.js`
  - `computeUBIReport(trips, settings, vehicles)` produces a usage-based-insurance style score card.
  - Categories are mileage, time of day, hard braking, rapid acceleration, cornering, and speed compliance.
  - Composite weights are `0.15`, `0.20`, `0.25`, `0.20`, `0.10`, and `0.10`.
  - Tiers are `Preferred >= 85`, `Standard >= 70`, otherwise `Non-preferred`.
  - `exportUBIReportPDF(report, settings)` writes a one-page driver score card.

- `src/lib/preTripRisk.js`
  - `computePreTripRisk(trips, settings, dailyFatigueState)` combines time-of-day risk, day-of-week risk, recent trend, daily fatigue, and last-trip outcome.
  - Signal weights are `0.20`, `0.15`, `0.25`, `0.25`, and `0.15`.
  - Readiness score is `100 - compositeRisk`; risk is `high >= 65`, `moderate >= 40`, otherwise `low`.

- `src/lib/routeRiskIndex.js`
  - `buildRouteRiskIndex(trips)` builds a local `Map<segmentKey, SegmentRisk>` from cleaned route-point pairs and nearest event locations.
  - Segment risk score is `eventRate * 20 + harshRate * 40 + 10` when average speed is at least `100 km/h`, capped at `100`.
  - Segment risk is `high >= 60`, `moderate >= 30`, otherwise `low`.
  - Cached in `drivesense_route_risk_index`; storage is trimmed to the top `5000` most-driven segments if serialized size exceeds `2 MB`.
