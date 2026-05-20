# Road Sage App Calculations

This document explains where every in-app calculation is done and shows the main code formulas used by the app.

## Source Files

The calculation code is concentrated in these files:

- `src/lib/tripEngine.js`: GPS math, route cleaning, trip splitting, speed-zone inference, driving events, trip stats, trip scores, aggression, defensive driving, jerk, eco, fatigue, drowsy, parking, report export.
- `src/lib/tripInsights.js`: map speed colors, stops, fuel/cost/CO2, maintenance, weekly goals, coach insights, badges, consistency, baseline, commute patterns.
- `src/lib/activityRecognition.js`: JavaScript auto-start and auto-stop decisions.
- `src/lib/trackingStore.js`: default thresholds, settings, and last-parked storage helpers.
- `src/lib/localTripRepository.js`: rescoring imported/background trips and storing the last parked location for native trips.
- `src/lib/pdfExport.js`: monthly PDF report totals and table export formatting.
- `src/lib/speedLimitSource.js`: OpenStreetMap `maxspeed` parsing, road-type speed defaults, Overpass cache, and route-point speed-limit annotation.
- `src/lib/weatherContext.js`: Open-Meteo weather sampling and weather-risk score inputs.
- `src/lib/phoneUsageAccess.js`: Android Usage Access phone-use evidence, GPS proxy merge, and phone-use score/risk.
- `src/lib/dailyFatigueEngine.js`: same-day fatigue accumulation and pre-trip break recommendation.
- `src/lib/preTripRisk.js`: pre-trip composite risk and readiness score.
- `src/lib/predictiveRouteRisk.js`: predictive route risk from recent trip baseline, danger zones, weather, and time of day.
- `src/lib/dangerZoneEngine.js`: repeated event clustering into alertable danger zones.
- `src/lib/routeRiskIndex.js`: historical segment risk index.
- `src/lib/sensorFusionModel.js`: motion sensor normalization, harsh-motion summary, event confirmation, and crash incident proxy.
- `src/lib/thresholdCalibration.js`: adaptive threshold suggestions from historical trips and reviewed event feedback.
- `src/lib/privacyZones.js`: privacy-zone masking for route points, events, and addresses.
- `src/lib/driverAnomaly.js`: on-device driver baseline and anomaly score.
- `src/lib/ubiReport.js`: usage-based-insurance-style score card.
- `src/lib/obdBluetooth.js`: OBD-II PID parsing and Web Bluetooth support checks.
- `src/pages/Dashboard.jsx`: trip completion pipeline.
- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`: native Android background trip capture, GPS filtering, native stats, and native auto-stop.

## Current Calculation Sync - May 20, 2026

This section is the short source-of-truth summary for the latest code. The detailed sections below expand each calculation.

### Auto-start and candidate validation

JavaScript foreground auto-start in `src/lib/activityRecognition.js` uses:

```js
AUTO_START_IN_VEHICLE_CONFIDENCE = 65
AUTO_START_SPEED_KMH = 5
AUTO_START_IN_VEHICLE_SECONDS = 2
AUTO_START_GPS_FALLBACK_SECONDS = 2
WALKING_SPEED_CUTOFF_KMH = 10
```

`shouldAutoStartTracking({ activity, currentSpeedKmh, recentMovingSeconds })` returns true when:

```text
(activity.type == in_vehicle AND activity.confidence >= 65 AND speed >= 5 AND movingSeconds >= 2)
OR
(activity missing/unknown/uncertain AND speed >= 5 AND movingSeconds >= 2)
```

Native background auto tracking in `DriveSenseAutoTrackingService.java` first creates a hidden candidate trip. A candidate becomes a real native trip only after vehicle-like proof:

```text
normal candidate:
  stable GPS points >= 4
  distance >= 150 m
  max speed >= 10 km/h

candidate near last parked location within 5 minutes and 75 m:
  stable GPS points >= 5
  distance >= 250 m
  max speed >= 10 km/h

walking/running/cycling confidence >= 75 AND max speed <= 10 km/h:
  discard as movement_looked_like_walking

candidate age >= 180 seconds without proof:
  discard as no_vehicle_speed_segment, unstable_gps_drift, or gps_movement_too_short
```

### Native stop timers

Current native stop constants:

```java
MIN_VEHICLE_CONFIDENCE = 65;
MIN_STILL_CONFIDENCE = 70;
AUTO_STOP_FOOT_MS = 10_000L;
AUTO_STOP_STILL_STABLE_MS = 90_000L;
AUTO_STOP_STILL_DRIFT_MS = 150_000L;
AUTO_STOP_PARKED_GPS_STABLE_MS = 90_000L;
AUTO_STOP_PARKED_GPS_RELAXED_MS = 300_000L;
AUTO_STOP_IN_VEHICLE_MS = 120_000L;
AUTO_STOP_IN_VEHICLE_EXTENDED_MS = 300_000L;
AUTO_STOP_IN_VEHICLE_ABSOLUTE_MS = 420_000L;
AUTO_STOP_NO_ACTIVITY_MS = 180_000L;
STALE_LOCATION_STOP_MS = 30_000L;
GPS_STILL_DRIFT_M = 8.0d;
GPS_VEHICLE_DRIFT_M = 5.0d;
GPS_VEHICLE_DRIFT_RELAXED_M = 20.0d;
AUTO_START_SPEED_KMH = 5.0d;
AUTO_START_MOVING_MS = 2_000L;
PARKING_COOLDOWN_MS = 300_000L;
PARKING_COOLDOWN_RADIUS_M = 75.0d;
CANDIDATE_CONFIRM_DISTANCE_M = 150.0d;
CANDIDATE_CONFIRM_DISTANCE_COOLDOWN_M = 250.0d;
CANDIDATE_CONFIRM_SPEED_KMH = 10.0d;
WALKING_SPEED_CUTOFF_KMH = 10.0d;
```

### Newer risk, calibration, and report formulas

Daily fatigue in `computeDailyFatigue()`:

```text
totalDrivingMinutes = sum(max(0, duration_seconds - idle_time_seconds) / 60)
durationFatigue = min(5, totalDrivingMinutes / 60)
tripCountFatigue = min(2, max(0, tripCount - 1) * 0.5)
recoveryCredit = minutesSinceLastTrip == null ? 2 : min(2, minutesSinceLastTrip / 30)
cumulativeFatigueScore = clamp(round1(durationFatigue + tripCountFatigue - recoveryCredit), 0, 10)
level = critical >= 7, high >= 5, moderate >= 3, else low
```

Pre-trip risk in `computePreTripRisk()`:

```text
compositeRisk =
  timeOfDay * 0.14 +
  dayOfWeek * 0.10 +
  recentTrend * 0.18 +
  dailyFatigue * 0.20 +
  lastTripOutcome * 0.12 +
  weather * 0.08 +
  dangerZones * 0.06 +
  routeForecast * 0.08 +
  recentRest * 0.04

readinessScore = 100 - compositeRisk
riskLevel = high when compositeRisk >= 65, or when dailyFatigue >= 90 and lastTripOutcome >= 70
riskLevel = moderate when compositeRisk >= 40
```

Predictive route risk in `estimatePredictiveRouteRisk()`:

```text
riskScore = clamp(round(
  (100 - avgScoreOfRecent20Trips) * 0.45 +
  eventDensityPerKm * 18 +
  nearbyDangerZoneCountWithin2000m * 10 +
  weatherRiskScore * 0.25 +
  timeRisk
), 0, 100)

timeRisk = 18 at 22:00-04:59, 10 at 16:00-18:59, otherwise 0
```

Route risk index in `buildRouteRiskIndex()`:

```text
segment key = endpoints rounded to 4 decimals, ordered so both directions share one key
eventRate = totalEvents / max(1, tripCount)
harshRate = harshCount / max(1, tripCount)
riskScore = min(100, round(eventRate * 20 + harshRate * 40 + (avgSpeed >= 100 ? 10 : 0)))
riskLevel = high >= 60, moderate >= 30, else low
```

Danger zones in `buildDangerZones()`:

```text
cellSizeM default = 80
minEvents default = 3
severity points: high = 3, medium = 2, low = 1
riskLevel = critical >= 15, high >= 8, medium >= 4, else low
radiusM = cellSizeM * 1.2
```

Adaptive calibration in `computeCalibrationProfile()`:

```text
requires:
  completed trips >= 15 and km >= 200
  OR reviewed event feedback count >= 3

harsh brake suggestion = clamp(percentile(abs(deceleration), 90%), 3.0, 7.0)
rapid accel suggestion = clamp(percentile(acceleration, 88%), 2.0, 6.0)
sharp turn low/medium/high = percentile(lateralG, 70%/85%/95%) when at least 20 lateral-g samples exist
feedback can raise a threshold when at least 2 reviewed events of that type are marked wrong
```

UBI report in `computeUBIReport()`:

```text
weights:
  mileage = 0.15
  timeOfDay = 0.20
  hardBraking = 0.25
  acceleration = 0.20
  cornering = 0.10
  speedCompliance = 0.10

mileageScore = clamp(round(100 - max(0, (totalKm - 1000) / 1000) * 5), 20, 100)
timeOfDayScore = round(max(0, 100 - nightTripRatio * 150))
brakingScore = max(0, round(100 - harshBrakesPer100Km * 8))
accelScore = max(0, round(100 - rapidAccelPer100Km * 8))
corneringScore = max(0, round(100 - sharpTurnsPer100Km * 6))
speedScore = max(0, round(100 - speedingPer100Km * 10))
ubiScore = weighted sum of the six category scores
grade = A+ >= 90, A >= 80, B >= 70, C >= 60, else D
tier = Preferred >= 85, Standard >= 70, else Non-preferred
```

OpenStreetMap speed-limit defaults in `defaultSpeedLimitKmhForOsmHighway()`:

```text
living_street = 20 km/h
service = 30 km/h
residential = 40 km/h
tertiary, tertiary_link, unclassified, road = 50 km/h
primary, primary_link, secondary, secondary_link = 60 km/h
trunk_link, motorway_link = 80 km/h
motorway, trunk = 100 km/h
```

Phone-use scoring in `phoneUsageAccess.js`:

```text
Android Usage Access sessions are accepted only when:
  package is not passive/system/navigation/music
  duration >= 5 seconds
  midpoint is within 20 seconds of a route point
  nearest route speed >= 15 km/h

event severity:
  high when duration >= 90 seconds or speed >= 100 km/h
  medium when duration >= 20 seconds or speed >= 50 km/h
  low otherwise

phone_use_risk:
  high when total seconds >= 60 or event count >= 3
  medium when total seconds >= 10
  low when at least one accepted event exists
  none when there are no accepted events

phone_use_score = max(0, 100 - sum(high 20, medium 10, low 4))
phone_use_pct_of_trip = round2(totalSeconds / tripDurationSeconds * 100)
```

Sensor fusion in `sensorFusionModel.js`:

```text
magnitude_ms2 = sqrt(ax^2 + ay^2 + az^2)
linear_magnitude_ms2 = abs(magnitude_ms2 - 9.80665)
rotation_magnitude_deg_s = sqrt(alpha^2 + beta^2 + gamma^2)

harsh_motion_count = samples where linear_magnitude_ms2 >= 5.5
impact_like_count = samples where linear_magnitude_ms2 >= 14 and rotation_magnitude_deg_s >= 120
phone_movement_score = clamp(round(avg(linear) * 5 + avg(rotation) * 0.08 + harshMotionCount * 2), 0, 100)
quality = good when valid sample count >= min(120, max(20, routePointCount * 2)), else partial

possible crash requires:
  recent max speed >= 20 km/h
  peak linear acceleration >= 18 m/s2
  peak rotation >= 90 deg/s
  stoppedSeconds >= 8 or STILL activity confidence >= 60
severity = high when peak linear >= 28, else medium
confidence = 0.9 when peak linear >= 28 and stoppedSeconds >= 15, else 0.72
```

Driver anomaly score in `driverAnomaly.js`:

```text
feature vector:
  score
  harsh_per_10km
  accel_per_10km
  turn_per_10km
  speed_per_10km
  avg_speed
  phone_pct
  smoothness

baseline model requires at least 8 completed trips from the most recent 60 completed trips
each feature stores mean and std, with minimum std = 1
anomaly_score = clamp(round(mean(min(abs(z), 4)) * 25), 0, 100)
anomaly_level = high >= 70, moderate >= 45, else normal
reasons = up to 3 features with abs(z) >= 1.8
```

OBD-II PID parsing in `obdBluetooth.js`:

```text
PID 0C RPM = ((A * 256) + B) / 4
PID 11 throttle percent = round(A * 100 / 255)
PID 04 engine load percent = round(A * 100 / 255)
PID 0D vehicle speed = A km/h
PID 05 coolant temperature = A - 40 C
```

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

When a trip ends, Dashboard runs OSRM map matching first, then annotates route points with OpenStreetMap `maxspeed` tags from Overpass. If a matched OSM road has no `maxspeed`, the app uses the road's `highway=*` tag to assign an urban road-type default before falling back to GPS-only context. Trip Detail also exposes **Refresh OSM Context** so existing trips can rerun the same open-source context without recording a new drive.

The speed-limit matcher uses point-to-road-segment distance, not just nearby way vertices. Each matched point receives:

```js
speed_limit_kmh
speed_limit_source: 'openstreetmap' | 'osm_highway_default'
speed_limit_way_id
speed_limit_road_name
speed_limit_highway
```

After refresh, Trip Detail recalculates stats, events, speed compliance, scores, weather adjustment, map-matching status, and OSM coverage. Trip Detail and Map can draw an **OSM Speed Limits** layer:

- green segment: at or below matched limit
- orange segment: above matched limit
- red segment: more than 5 km/h over matched limit

If Overpass or OSRM is unavailable, the trip keeps inferred speed zones and records the context status/error instead of hiding the feature.

## Default Settings And Thresholds

Default user settings live in `src/lib/trackingStore.js`.

```js
threshold_harsh_brake_ms2: 3.5,
threshold_rapid_accel_ms2: 3.0,
threshold_tailgate_decel_ms2: 2.5,
threshold_sharp_turn_g_low: 0.35,
threshold_sharp_turn_g_medium: 0.45,
threshold_sharp_turn_g_high: 0.60,
threshold_speeding_kmh: 100,
threshold_speed_over_kmh: 5,
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
threshold_speed_creep_kmh: 5,
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

Default threshold: `-3.5 m/s2`, minimum speed `25 km/h`.

### Rapid Acceleration

```js
if (accel != null && accel > thresholds.RAPID_ACCEL_MS2 && speed1 >= minRapidAccelSpeed) {
  type: EVENT_TYPES.RAPID_ACCELERATION
}
```

Default threshold: `3.0 m/s2`, minimum speed `5 km/h` so hard launches from a stop are counted once the car is actually moving.

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

- low: `0.35 g`
- medium: `0.45 g`
- high: `0.60 g`

### Speeding

Speeding uses OpenStreetMap `maxspeed` when route points have matched OSM limits. If `maxspeed` is missing but the OSM road type is available, the app uses urban defaults such as residential 40 km/h, unclassified/tertiary 50 km/h, primary/secondary 60 km/h, and motorway/trunk 100 km/h. Only when no usable OSM road match exists does it use GPS road-context fallback limits:

```js
const fallbackLimit =
  roadType === 'residential' ? 40 :
  roadType === 'highway' ? thresholds.SPEEDING_FALLBACK_KMH :
  60;
const inferredOrRoadLimit = Math.min(inferredZoneKmh ?? fallbackLimit, fallbackLimit);
const contextualSpeedingThreshold = actualOsmLimit
  ? actualOsmLimit + thresholds.SPEED_OVER_KMH
  : inferredOrRoadLimit + thresholds.SPEED_OVER_KMH;

if (speed2 > contextualSpeedingThreshold) {
  speedingAccumSeconds += dt;
}
```

Default highway fallback threshold: `100 km/h`.
Default urban fallback limit: `60 km/h`.
Default residential fallback limit: `40 km/h`.
Default OSM/inferred-zone buffer: `5 km/h`.

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
const speedLimit = Number(settings.threshold_speeding_kmh ?? 100);
const warnLimit = speedLimit + Number(settings.threshold_speed_over_kmh ?? 5);
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

During an active trip, the overlay recalculates partial-trip stats and events every `15 seconds`:

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

Live coaching evaluates active trips every `15 seconds`. When a toast is queued, the voice message is spoken immediately as the toast is shown. Android native builds use native TextToSpeech first, then browser `speechSynthesis` only as a fallback. Live phone-use alerts merge GPS behavior with Android Usage Access sessions when that permission is enabled.

Voice alert priority is:

1. Phone use / distracted-driving window.
2. Near miss.
3. New harsh brake.
4. Tailgate/following-gap cycle.
5. Speeding above the active OSM or fallback threshold plus the configured margin.
6. New rapid acceleration.
7. Extended idling over the configured idle window.

Only one voice message is spoken at a time. The next alert waits until the current toast finishes.

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
  const activityMissingOrUncertain = !activity ||
    activity.type === ACTIVITY_TYPES.UNKNOWN ||
    (activity.type === ACTIVITY_TYPES.IN_VEHICLE && vehicleConfidence < 65);
  return (
    vehicleConfidence >= 65 && currentSpeedKmh >= 5 && recentMovingSeconds >= 2
  ) || (
    activityMissingOrUncertain && currentSpeedKmh >= 5 && recentMovingSeconds >= 2
  );
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
  // Fast path: WALKING/RUNNING/CYCLING with confidence >= 75 and speed <= 10 stops after 10s.
  // STILL + stable GPS (< 8m drift) stops after 90s.
  // STILL + drift (>= 8m) waits 150s.
  // IN_VEHICLE + speed < 2 has parked paths:
  // 90s with very stable GPS (< 5m drift).
  // 300s with relaxed urban GPS drift (< 20m).
  // IN_VEHICLE + speed < 5 has additional paths:
  // 120s with very stable GPS (< 5m drift).
  // 300s with speed < 2 and relaxed urban GPS drift (< 20m).
  // 420s with speed < 2 as a final near-zero-speed timeout.
  // Missing or UNKNOWN activity waits 180s and requires stable GPS (< 8m drift).
}
```

`computeGpsPositionDrift(stoppedLat, stoppedLng, recentPoints)` measures the maximum haversine displacement in meters from the point where speed first dropped below `5 km/h`. This gives auto-stop the context needed to separate a stable parked car from GPS drift or crawling traffic.

## Native Android Background Tracking

File: `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`

Constants:

```java
private static final int MIN_VEHICLE_CONFIDENCE = 65;
private static final int MIN_STILL_CONFIDENCE = 70;
private static final long AUTO_STOP_FOOT_MS = 10_000L;
private static final long AUTO_STOP_STILL_STABLE_MS = 90_000L;
private static final long AUTO_STOP_STILL_DRIFT_MS = 150_000L;
private static final long AUTO_STOP_PARKED_GPS_STABLE_MS = 90_000L;
private static final long AUTO_STOP_PARKED_GPS_RELAXED_MS = 300_000L;
private static final long AUTO_STOP_IN_VEHICLE_MS = 120_000L;
private static final long AUTO_STOP_IN_VEHICLE_EXTENDED_MS = 300_000L;
private static final long AUTO_STOP_IN_VEHICLE_ABSOLUTE_MS = 420_000L;
private static final long AUTO_STOP_NO_ACTIVITY_MS = 180_000L;
private static final long STALE_LOCATION_STOP_MS = 30_000L;
private static final double GPS_STILL_DRIFT_M = 8.0d;
private static final double GPS_VEHICLE_DRIFT_M = 5.0d;
private static final double GPS_VEHICLE_DRIFT_RELAXED_M = 20.0d;
private static final double STATIONARY_SPEED_KMH = 5d;
private static final double MIN_TRUSTED_SPEED_KMH = 18d;
private static final double MAX_SPEED_KMH = 220d;
private static final double AUTO_START_SPEED_KMH = 5d;
private static final long AUTO_START_MOVING_MS = 2_000L;
```

Native start now creates a candidate trip after in-vehicle or armed-GPS movement proof, then confirms it only after stable GPS, distance, and speed checks:

```java
if (!isTripActive() && inVehicle &&
    lastKnownSpeedKmh >= AUTO_START_SPEED_KMH &&
    armedMovingSinceMs > 0L &&
    now - armedMovingSinceMs >= AUTO_START_MOVING_MS) {
    startCandidateTrip("activity_in_vehicle_moving", armedPreviousLocation);
    return;
}
```

Native stop:

```java
boolean speedStopped = lastKnownSpeedKmh < STATIONARY_SPEED_KMH;
boolean gpsStable = maxDriftSinceStopM < GPS_STILL_DRIFT_M && !Double.isNaN(stoppedAnchorLat);
boolean gpsVeryStable = maxDriftSinceStopM < GPS_VEHICLE_DRIFT_M && !Double.isNaN(stoppedAnchorLat);

// WALKING/RUNNING/ON_BICYCLE + speed <= 10: finish after 10s.
// STILL + stopped: finish after 90s when GPS is stable, otherwise wait 150s.
// IN_VEHICLE + speed < 2: finish after 90s under 5m drift or 300s under 20m drift.
// IN_VEHICLE + speed < 5: finish after 120s under 5m drift, 300s under 20m drift when speed < 2,
// or 420s when speed remains under 2.
// UNKNOWN + stopped: finish after 180s only when GPS drift is under 8m.
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
