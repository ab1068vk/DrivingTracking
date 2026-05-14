# DriveSense App Documentation

Last updated: 2026-05-14

DriveSense is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records driving trips, stores route points on the device, scores driving behavior, shows route maps, manages vehicles, exports backups, and supports Android background auto tracking.

This document describes the full current application: user features, code structure, runtime behavior, storage, data models, Android integration, setup, and maintenance notes.

## 1. Product Overview

DriveSense helps a driver understand and improve driving behavior.

Primary capabilities:

- Track trips manually from the dashboard.
- Auto-detect trips while the app is open.
- Use Android native background auto tracking to detect and record trips while the React app is asleep.
- Store trips, route points, driving events, vehicles, and settings locally.
- Calculate distance, duration, average speed, max speed, idle time, night driving, risky events, and driving scores.
- Show trip history, filters, tags, detail pages, route maps, and route playback.
- Provide reports, driving coach insights, achievements, weekly goals, fatigue risk, fuel cost, and CO2 estimates.
- Export trip CSV files and full JSON backups.
- Import full JSON backups.
- Manage permissions, notification preferences, tracking mode, units, theme, detection thresholds, goals, retention, and privacy controls.

The app is intentionally privacy-centered. By default, it uses local storage only. Cloud APIs are supported by the API client shape, but the app falls back to local repositories unless `VITE_API_URL` is configured and the app is not running on a native platform.

## 2. Technology Stack

Core frontend:

- React 18
- Vite 6
- React Router
- TanStack React Query
- Tailwind CSS
- Radix UI based shadcn-style UI components
- Lucide icons
- Framer Motion
- Recharts
- Leaflet and OpenStreetMap tiles loaded at runtime

Mobile/native:

- Capacitor 8
- Capacitor Android
- Capacitor Geolocation
- Capacitor Local Notifications
- Capacitor Preferences
- Capacitor Filesystem
- Capacitor App
- `@capacitor-community/background-geolocation`
- Android native Java plugin for activity recognition and native auto tracking
- Google Play Services Location and Activity Recognition

Development and quality:

- ESLint
- TypeScript tooling for JS project checks through `jsconfig.json`
- Vitest
- Android Gradle build

## 3. Repository Structure

Important root files:

- `package.json`: npm scripts and JavaScript dependencies.
- `vite.config.js`: Vite React setup and `@` alias to `src`.
- `capacitor.config.ts`: Capacitor app id, app name, web output directory, and plugin config.
- `tailwind.config.js`: theme tokens, fonts, Tailwind content paths, animations, and color aliases.
- `components.json`: shadcn-style component configuration.
- `README.md`: short setup and Android tracking summary.
- `scripts/patch-android-gradle.mjs`: postinstall helper for Android Gradle compatibility.

Main source folders:

- `src/pages`: route-level React pages.
- `src/components`: app-specific reusable components.
- `src/components/ui`: generated/shared UI primitives.
- `src/lib`: local storage, tracking, scoring, insights, permissions, notifications, platform helpers, and query client.
- `src/api`: service wrappers for trips, vehicles, auth, and HTTP client.
- `src/hooks`: shared React hooks.
- `android`: Capacitor Android project and native Java services/plugins.
- `dist`: Vite build output used by Capacitor.

## 4. App Entry And Routing

Entry files:

- `src/main.jsx` mounts the React app into `#root`.
- `src/App.jsx` composes `AuthProvider`, `QueryClientProvider`, `BrowserRouter`, app routes, notification channel setup, reminder sync, theme application, and Android background auto tracking startup.

App startup behavior:

1. Configure native local notification channels if running on native.
2. Read local settings.
3. Sync reminder notifications without forcing a permission request.
4. Apply light, dark, or system theme.
5. If running on Android and `tracking_mode` is `background_auto` and tracking is not paused, try to start native auto tracking.
6. Decide whether onboarding is complete.
7. Render onboarding or the main layout.

Route table:

| Path | Component | Purpose |
| --- | --- | --- |
| `/` | `Dashboard` | Start/stop trips, show current trip state, weekly stats, goals, event summary, score trends, and recent trips. |
| `/trips` | `TripHistory` | Search, filter, sort, tag, and browse completed trips. |
| `/trips/:id` | `TripDetail` | Inspect one trip, map, scores, stats, events, stops, economics, vehicle, and delete action. |
| `/map` | `MapScreen` | View all filtered routes, focus a route, show current location, and play back selected trips. |
| `/coach` | `DrivingCoach` | Show coaching focus, event rate, speed discipline, consistency, fatigue, and action items. |
| `/achievements` | `Achievements` | Show earned and locked driving badges. |
| `/reports` | `Report` | Show period reports, charts, event trends, tips, cost, CO2, and CSV export. |
| `/settings` | `Settings` | Manage tracking, permissions, notifications, goals, thresholds, data, export/import, theme, and units. |
| `/android` | `AndroidReference` | In-app Android Kotlin/Compose reference snippets. This is reference content, not the production native implementation. |
| `/vehicles` | `Vehicles` | Manage vehicles, fuel assumptions, odometer, maintenance, default vehicle, and per-vehicle stats. |
| `*` | `PageNotFound` or `Onboarding` | Not found route, or onboarding catch-all before onboarding is complete. |

## 5. User-Facing Features

### 5.1 Onboarding

File: `src/pages/Onboarding.jsx`

The onboarding flow introduces:

- Welcome and product purpose.
- Location access.
- Motion/activity explanation.
- Notifications.
- Tracking mode selection.

Tracking modes:

- `manual`: user starts and stops trips manually.
- `auto_detect`: app detects likely driving while open.
- `background_auto`: Android native service can detect and record trips in the background.

On completion, settings are saved:

- `onboarding_completed: true`
- `tracking_mode`
- `auto_tracking_enabled`
- `background_tracking_enabled`

### 5.2 Dashboard And Trip Recording

File: `src/pages/Dashboard.jsx`

Dashboard responsibilities:

- Resume an active trip from `activeTripStore` after refresh or crash.
- Start and stop manual trips.
- Run foreground or background GPS tracking.
- Run foreground auto detection when enabled.
- Coordinate Android activity recognition.
- Create completed trip records.
- Notify trip start and trip completion.
- Schedule and cancel long-trip reminders.
- Sync achievement notifications after a trip completes.
- Show dashboard summaries and recent trips.

Manual trip save rules:

- A manual trip is discarded if it has fewer than 2 cleaned points, duration below 5 seconds, or distance below 0.1 km.

Auto trip save rules:

- Auto trips are discarded if distance is below 0.1 km or duration is below 30 seconds.

Completed trip fields include:

- Time fields.
- Vehicle id for the default vehicle if available.
- Route points.
- Driving events.
- Trip statistics.
- Scores.
- Status.
- Background tracking flag.
- Start source.

### 5.3 Trip History

File: `src/pages/TripHistory.jsx`

Trip History provides:

- Search by address/date text.
- Date filters: this month, last 30 days, last 90 days, all time.
- Sort options: newest, oldest, best score, worst score, longest, shortest.
- Risk and score filters.
- Night trip filter.
- Harsh braking filter.
- Tags: work, personal, errands.
- Tag add/change/remove mutations.

### 5.4 Trip Detail

File: `src/pages/TripDetail.jsx`

Trip Detail provides:

- Route map with events.
- Overall, safety, smoothness, and eco scores.
- Distance, duration, average speed, max speed.
- Estimated fuel cost and CO2.
- Start/end times.
- Night driving indicator.
- Vehicle association.
- Stop detection summary.
- Fatigue risk.
- Driving event count and event list.
- Route point count.
- Trip deletion.

### 5.5 Map

File: `src/pages/MapScreen.jsx`

Map features:

- Show all filtered routes.
- Focus one selected trip.
- Filter routes by all, night, or harsh braking.
- Show current device location after permission.
- Show start/end markers.
- Show event markers when a trip is selected.
- Switch between static map and route playback.

Map implementation:

- `TripMap` loads Leaflet CSS and JS dynamically from `unpkg.com`.
- Tiles come from OpenStreetMap.
- Default center is Toronto.
- Routes are Leaflet polylines.

### 5.6 Reports

File: `src/pages/Report.jsx`

Reports provide period-based analysis:

- Periods: this week, this month, all time.
- Total trips.
- Distance.
- Drive time.
- Average score.
- Fuel cost.
- CO2 estimate.
- Improvement tips.
- Fatigue risk.
- Time-of-day chart.
- Day-of-week chart.
- Daily distance chart.
- Score trend chart.
- Six-month event trend.
- Risk event breakdown.
- Best and worst trip highlights.
- CSV export for the selected period.

### 5.7 Driving Coach

File: `src/pages/DrivingCoach.jsx`

Driving Coach provides:

- Current focus area based on dominant risk.
- Risk events per 100 km.
- Consistency score.
- Max recorded speed.
- Distance analyzed.
- Next driving actions.
- Speed discipline.
- Best driving window.
- Day pattern.

Main insight builder:

- `buildDrivingCoachInsights` in `src/lib/tripInsights.js`.

### 5.8 Achievements

File: `src/pages/Achievements.jsx`

Achievements calculate badge progress from completed trips.

Current badges include:

- First Drive.
- Getting Rolling.
- Road Regular.
- Perfect Trip.
- Clean Week.
- 100 km Club.
- 500 km Club.
- Smooth Driver.
- Steady Five.
- Gentle Brakes.
- Smooth Starts.
- Corner Control.
- Speed Sentinel.
- Daily Driver.
- Route Replay Ready.
- Clean Long Drive.
- Night Owl.

Achievement notifications are synced from earned badges.

### 5.9 Vehicles

File: `src/pages/Vehicles.jsx`

Vehicle management provides:

- Add, edit, delete vehicles.
- Set default vehicle.
- Vehicle nickname, make, model, year, color, plate, odometer.
- Fuel efficiency in L/100 km.
- Fuel price per liter.
- Per-vehicle trip count and average score.
- Fuel cost and CO2 estimates.
- Maintenance tracking for oil change, tire rotation, and inspection.
- Mark maintenance as done at current odometer.
- Vehicle comparison when at least two vehicles exist.

Trips without a `vehicle_id` are attributed to the default vehicle for per-vehicle stats.

### 5.10 Settings

File: `src/pages/Settings.jsx`

Settings provide:

- Tracking mode selection.
- Pause all tracking.
- Auto-tracking toggle.
- Background tracking toggle.
- Android native auto tracking status.
- Permission status and enable actions.
- Battery optimization settings shortcut.
- Theme: light, dark, system.
- Units: metric or imperial.
- Notification master switch and individual notification types.
- Weekly driving goals.
- Detection thresholds.
- Speed warning margin.
- Privacy policy message.
- Export all trips as CSV.
- Export full JSON backup.
- Import JSON backup.
- Data retention.
- Delete all trips.

## 6. API And Local Repository Layer

The `src/api` folder exposes service objects used by pages.

### 6.1 HTTP Client

File: `src/api/client.js`

The API client:

- Uses `VITE_API_URL` or defaults to `http://localhost:5000/api`.
- Adds `Authorization: Bearer <token>` if `token` or `access_token` exists in local storage.
- Sends and receives JSON.
- Throws `ApiError` for non-2xx responses.

### 6.2 Trip Service

File: `src/api/trips.js`

The trip service uses local storage when:

- Running on Capacitor native platform, or
- `VITE_API_URL` is not configured.

Methods:

- `list({ sort, limit })`
- `getById(id)`
- `create(trip)`
- `update(id, patch)`
- `delete(id)`
- `upsertMany(trips)`

If cloud mode is active, methods call REST endpoints under `/trips`.

### 6.3 Vehicle Service

File: `src/api/vehicles.js`

The vehicle service follows the same local/cloud selection as trips.

Methods:

- `list({ sort, limit })`
- `create(vehicle)`
- `update(id, patch)`
- `delete(id)`
- `upsertMany(vehicles)`

If cloud mode is active, methods call REST endpoints under `/vehicles`.

### 6.4 Auth Service

File: `src/api/auth.js`

Auth is scaffolded but not fully implemented.

Current behavior:

- `me()` calls `/auth/me`.
- `logout()` removes local tokens.
- `redirectToLogin()` sends the browser to `/login?returnTo=<current>`.

The file contains TODO notes for future backend auth.

## 7. Storage Architecture

DriveSense is local-first.

### 7.1 Settings

File: `src/lib/trackingStore.js`

Settings key:

- `drivesense_settings`

Storage:

- Browser `localStorage`.

Default settings include:

- Tracking mode and pause state.
- Units.
- Theme.
- Notification flags.
- Permission status flags.
- Data retention.
- Event detection thresholds.
- Weekly goals.
- Onboarding state.

### 7.2 Active Trip

File: `src/lib/trackingStore.js`

Active trip key:

- `drivesense_active_trip`

Storage:

- Browser `localStorage`.

Purpose:

- Crash/reload recovery while a trip is active.
- The dashboard can recover and reattach GPS tracking.

### 7.3 Trip Repository

File: `src/lib/localTripRepository.js`

Primary web storage:

- IndexedDB database: `drivesense_mobile`
- Object store: `trips`
- Key path: `id`
- Indexes: `start_time`, `status`

Fallback storage:

- `getJson`/`setJson` under key `drivesense_trips`.

Native completed trip import:

- On Android, `list()` and `getById()` call `importNativeCompletedTrips()`.
- Native completed trips are fetched through the Capacitor plugin.
- Imported trips are rescored by the JavaScript trip engine.
- Native completed trips are then cleared from the native store.

Retention:

- `pruneExpiredTrips()` deletes trips older than `data_retention_days`.
- `0` means keep forever.

### 7.4 Vehicle Repository

File: `src/lib/localVehicleRepository.js`

Storage key:

- `drivesense_vehicles`

Storage mechanism:

- `getJson`/`setJson`.
- On native, these helpers use Capacitor Preferences.
- On web, they use localStorage.
- If neither is available, they use an in-memory map.

Vehicle repository guarantees:

- Vehicle data is normalized.
- At least one vehicle is default when vehicles exist.
- Setting one default clears default status from others.

### 7.5 Capacitor Preferences Abstraction

File: `src/lib/mobileStorage.js`

Methods:

- `getJson(key, fallback)`
- `setJson(key, value)`
- `removeJson(key)`

Behavior:

- Native platform: Capacitor Preferences.
- Browser: localStorage.
- Last fallback: in-memory map.

### 7.6 Native Android Store

File: `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`

Android SharedPreferences:

- Preferences name: `drivesense_native_tracking`
- Completed trips key: `completed_trips`
- Service enabled key: `service_enabled`

The native service stores completed trips here before React imports them.

## 8. Data Models

The app uses plain JavaScript objects. These are the practical shapes used across the app.

### 8.1 Trip

Common trip fields:

```js
{
  id: "trip_...",
  start_time: "2026-05-14T12:00:00.000Z",
  end_time: "2026-05-14T12:30:00.000Z",
  duration_seconds: 1800,
  distance_km: 15.25,
  avg_speed_kmh: 30.5,
  max_speed_kmh: 82.4,
  idle_time_seconds: 120,
  night_driving: false,
  score_overall: 92,
  score_safety: 95,
  score_smoothness: 90,
  score_eco: 88,
  harsh_brakes_count: 0,
  rapid_accel_count: 1,
  sharp_turns_count: 0,
  speeding_events_count: 0,
  route_points: [],
  driving_events: [],
  status: "completed",
  vehicle_id: "vehicle_...",
  background_tracking: false,
  start_source: "manual",
  tag: "work",
  created_at: "...",
  updated_at: "..."
}
```

Trip `status` values:

- `active`
- `completed`

Trip `start_source` values observed:

- `manual`
- `auto`
- `native_auto`

### 8.2 Route Point

Route points are normalized through `normalizeLocationPoint`.

```js
{
  lat: 43.6532,
  lng: -79.3832,
  speed_kmh: 55.2,
  heading: 120,
  accuracy: 8,
  altitude: 100,
  altitude_accuracy: 5,
  timestamp: "2026-05-14T12:00:00.000Z"
}
```

### 8.3 Driving Event

```js
{
  type: "harsh_brake",
  severity: "low",
  lat: 43.6532,
  lng: -79.3832,
  timestamp: "2026-05-14T12:05:00.000Z",
  value: 4.8
}
```

Supported event types:

- `harsh_brake`
- `rapid_acceleration`
- `sharp_turn`
- `speeding`
- `idle`

Severity values:

- `low`
- `medium`
- `high`

### 8.4 Vehicle

```js
{
  id: "vehicle_...",
  name: "My Car",
  make: "Toyota",
  model: "Corolla",
  year: 2022,
  color: "#3b82f6",
  plate: "ABC 123",
  odometer_km: 42000,
  fuel_efficiency_l_per_100km: 8.5,
  fuel_price_per_liter: 1.65,
  maintenance_items: [],
  is_default: true,
  created_date: "...",
  updated_at: "..."
}
```

Default maintenance items:

- Oil change every 8000 km.
- Tire rotation every 10000 km.
- Inspection every 20000 km.

### 8.5 Settings

Important settings:

```js
{
  tracking_mode: "manual",
  units: "metric",
  dark_mode: "system",
  notifications_enabled: true,
  trip_start_notification: true,
  trip_end_notification: true,
  weekly_report_notification: true,
  achievement_notifications: true,
  safe_driving_reminder: false,
  background_tracking_enabled: false,
  auto_tracking_enabled: false,
  data_retention_days: 365,
  threshold_harsh_brake_ms2: 4.5,
  threshold_rapid_accel_ms2: 3.5,
  threshold_sharp_turn_degs: 45,
  threshold_speeding_kmh: 130,
  threshold_idle_seconds: 60,
  threshold_long_drive_minutes: 120,
  weekly_goal_harsh_brakes: 5,
  weekly_goal_speeding_events: 3,
  weekly_goal_min_avg_score: 80,
  weekly_goal_max_night_trips: 3,
  onboarding_completed: true,
  location_permission_granted: false,
  background_location_granted: false,
  activity_permission_granted: false,
  notification_permission_granted: false,
  tracking_paused: false
}
```

## 9. Tracking System

Tracking is split between JavaScript services and Android native services.

### 9.1 Location Service

File: `src/lib/trackingService.js`

Main exports:

- `getCurrentLocation()`
- `createDrivingTrackingService({ background })`

Behavior:

- Requests foreground or background permission depending on mode.
- On native, uses Capacitor Geolocation for current position and position watching.
- In browser, uses `navigator.geolocation`.
- In native background mode, uses `BackgroundGeolocation.addWatcher`.
- Normalizes all points through the trip engine.
- Filters bad/noisy points.
- Replaces unreliable low-speed reported speed with calculated segment speed where needed.
- Provides `start(onPoint, onError)`, `stop()`, and `isActive()`.

### 9.2 Auto Detection In React

Files:

- `src/pages/Dashboard.jsx`
- `src/lib/activityRecognition.js`

Foreground auto detection uses:

- Android activity recognition when Android is available.
- GPS speed and recent moving seconds.
- Current activity confidence.

Auto-start logic:

- Vehicle activity confidence must be at least 70.
- Current speed must be at least 12 km/h.
- Recent moving time must be at least 20 seconds.

Auto-stop logic:

- Current speed below 5 km/h.
- Still time at least 180 seconds.
- Activity is `still` with confidence at least 70, or non-vehicle with confidence at least 80.

On non-Android web, speed-only auto start can trigger when speed is at least 18 km/h for at least 20 seconds.

### 9.3 Android Native Auto Tracking

Files:

- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityReceiver.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`

Native auto tracking behavior:

1. React calls `startNativeAutoTracking()`.
2. The Capacitor plugin checks required native permissions.
3. `DriveSenseAutoTrackingService` starts as a foreground service.
4. The service requests activity updates every 15 seconds.
5. `DriveSenseActivityReceiver` receives activity updates.
6. In-vehicle activity with confidence at least 70 starts a native trip.
7. The service starts high-accuracy location updates every 5 seconds, with a 3 second minimum interval and 10 meter minimum distance.
8. Native route points are filtered for accuracy, noise, and impossible speed.
9. Still or non-vehicle activity plus stationary speed for about 180 seconds ends the trip.
10. Trips under 30 seconds, under 0.1 km, or with fewer than 2 points are discarded.
11. Completed native trips are saved to SharedPreferences.
12. React imports native trips on trip list/detail reads and rescoring happens in JavaScript.

Important native thresholds:

- Minimum vehicle confidence: 70.
- Minimum still confidence: 70.
- Auto-stop still duration: 180000 ms.
- Maximum GPS accuracy: 75 m.
- Minimum point distance: 8 m.
- Stationary speed: 5 km/h.
- Minimum trusted speed: 18 km/h.
- Maximum accepted speed: 220 km/h.

## 10. Trip Engine

File: `src/lib/tripEngine.js`

The trip engine owns:

- Distance calculation.
- Bearing calculation.
- Heading difference.
- Speed calculation.
- Acceleration calculation.
- Location normalization.
- GPS point filtering.
- Route cleaning.
- Event detection.
- Trip statistics.
- Trip scoring.
- Formatting helpers.
- Report summary.
- CSV export.

### 10.1 Default Thresholds

```js
{
  HARSH_BRAKE_MS2: 4.5,
  RAPID_ACCEL_MS2: 3.5,
  SHARP_TURN_DEG_PER_S: 45,
  SPEEDING_FALLBACK_KMH: 130,
  IDLE_SPEED_KMH: 5,
  IDLE_EVENT_SECONDS: 60,
  LONG_DRIVE_MINUTES: 120,
  NIGHT_START_HOUR: 22,
  NIGHT_END_HOUR: 6,
  MIN_TRIP_DISTANCE_KM: 0.1,
  MIN_TRIP_DURATION_SECONDS: 30,
  MAX_GPS_ACCURACY_M: 50,
  MIN_POINT_DISTANCE_M: 8,
  MIN_TRUSTED_SPEED_KMH: 18,
  STATIONARY_SPEED_KMH: 5
}
```

### 10.2 GPS Cleaning

Points are rejected when:

- Missing latitude or longitude.
- Accuracy is worse than the configured maximum.
- Timestamp is not increasing.
- The segment appears to be short-term GPS noise.
- Implied or reported speed exceeds 220 km/h.

Noise detection considers:

- Distance between points.
- GPS accuracy.
- Implied speed.
- Reported speed.
- Whether displacement suggests the device is stationary.

Core point normalization:

```js
function normalizeLocationPoint(input) {
  const coords = input.coords || input;
  const lat = coords.latitude ?? input.lat;
  const lng = coords.longitude ?? input.lng;

  return {
    lat,
    lng,
    speed_kmh: coords.speed != null ? Math.max(0, coords.speed * 3.6) : input.speed_kmh ?? null,
    heading: coords.heading ?? coords.bearing ?? coords.course ?? input.heading ?? null,
    accuracy: coords.accuracy ?? input.accuracy ?? null,
    altitude: coords.altitude ?? input.altitude ?? null,
    altitude_accuracy: coords.altitudeAccuracy ?? input.altitudeAccuracy ?? null,
    timestamp: new Date(input.timestamp ?? input.time ?? Date.now()).toISOString()
  };
}
```

Segment calculation formulas:

```txt
dt_seconds = (point.timestamp - previousPoint.timestamp) / 1000
distance_km = haversine(previousPoint.lat, previousPoint.lng, point.lat, point.lng)
distance_m = distance_km * 1000
implied_speed_kmh = distance_km / dt_seconds * 3600
reported_speed_kmh = point.speed_kmh, when available
```

Noise floor calculation:

```txt
best_accuracy_m = max(previousPoint.accuracy, point.accuracy)
noise_floor_m = max(MIN_POINT_DISTANCE_M, min(25, best_accuracy_m * 0.6))
```

Noise detection logic:

```js
const tinyMovement = distanceM < noiseFloorM;
const displacementSaysStill =
  impliedSpeedKmh < STATIONARY_SPEED_KMH &&
  distanceM < noiseFloorM * 1.5;
const reportedDisagreesWithDisplacement =
  reportedSpeedKmh != null &&
  reportedSpeedKmh < MIN_TRUSTED_SPEED_KMH &&
  displacementSaysStill;

const isNoise = tinyMovement || reportedDisagreesWithDisplacement;
```

Reliable speed selection:

```js
let reliableSpeedKmh = impliedSpeedKmh;

if (!isNoise && reportedSpeedKmh != null) {
  const reportedCloseToImplied =
    impliedSpeedKmh >= STATIONARY_SPEED_KMH ||
    reportedSpeedKmh >= MIN_TRUSTED_SPEED_KMH ||
    Math.abs(reportedSpeedKmh - impliedSpeedKmh) <= 12;

  reliableSpeedKmh = reportedCloseToImplied ? reportedSpeedKmh : impliedSpeedKmh;
}

reliableSpeedKmh = isNoise ? 0 : Math.max(0, reliableSpeedKmh);
```

Accepted point logic:

```js
function shouldAcceptLocationPoint(point, previousPoint) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return false;
  if (point.accuracy != null && point.accuracy > MAX_GPS_ACCURACY_M) return false;
  if (!previousPoint) return true;

  const dt = (new Date(point.timestamp) - new Date(previousPoint.timestamp)) / 1000;
  if (dt <= 0) return false;

  const segment = calculateSegmentMetrics(previousPoint, point);
  if (segment.isNoise && dt < 45) return false;

  const reportedSpeed = segment.reportedSpeedKmh ?? segment.impliedSpeedKmh;
  if (segment.impliedSpeedKmh > 220 || reportedSpeed > 220) return false;

  return true;
}
```

### 10.3 Statistics

`calculateTripStats(points, startTime, endTime)` returns:

- `distance_km`
- `avg_speed_kmh`
- `max_speed_kmh`
- `idle_time_seconds`
- `duration_seconds`
- `night_driving`

Night driving is true when any route point is between 22:00 and 06:00 local time.

Distance calculation uses the Haversine formula:

```txt
R = 6371 km
dLat = radians(lat2 - lat1)
dLng = radians(lng2 - lng1)
a = sin(dLat / 2)^2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(dLng / 2)^2
c = 2 * atan2(sqrt(a), sqrt(1 - a))
distance_km = R * c
```

Bearing calculation:

```txt
dLng = radians(lng2 - lng1)
y = sin(dLng) * cos(radians(lat2))
x = cos(radians(lat1)) * sin(radians(lat2)) -
    sin(radians(lat1)) * cos(radians(lat2)) * cos(dLng)
bearing_degrees = (degrees(atan2(y, x)) + 360) % 360
```

Heading difference:

```txt
raw_diff = abs(heading1 - heading2) % 360
heading_diff = raw_diff > 180 ? 360 - raw_diff : raw_diff
```

Speed and acceleration:

```txt
speed_kmh = distance_km / duration_seconds * 3600
v1_mps = speed1_kmh / 3.6
v2_mps = speed2_kmh / 3.6
acceleration_ms2 = (v2_mps - v1_mps) / duration_seconds
```

Trip stats calculation:

```js
let totalDistance = 0;
let maxSpeed = 0;
let movingSeconds = 0;
let idleTime = 0;

for (let i = 1; i < routePoints.length; i++) {
  const segment = calculateSegmentMetrics(routePoints[i - 1], routePoints[i]);
  if (segment.dt <= 0 || segment.dt > 120 || segment.isNoise) continue;

  totalDistance += segment.distanceKm;
  maxSpeed = Math.max(maxSpeed, segment.reliableSpeedKmh);

  if (segment.reliableSpeedKmh >= STATIONARY_SPEED_KMH) {
    movingSeconds += segment.dt;
  }

  if (segment.reliableSpeedKmh < IDLE_SPEED_KMH) {
    idleTime += segment.dt;
  }
}

const avgSpeed = durationSeconds > 0 && totalDistance > 0
  ? totalDistance / durationSeconds * 3600
  : 0;
```

Final rounding:

```txt
distance_km = round(totalDistance, 3)
avg_speed_kmh = movingSeconds > 0 ? round(avgSpeed, 1) : 0
max_speed_kmh = round(maxSpeed, 1)
idle_time_seconds = round(idleTime)
duration_seconds = round(endTime - startTime in seconds)
```

### 10.4 Event Detection

`detectDrivingEvents(points, thresholds)` returns driving events.

Harsh braking:

- Acceleration below `-HARSH_BRAKE_MS2`.
- Previous speed above 20 km/h.

Rapid acceleration:

- Acceleration above `RAPID_ACCEL_MS2`.
- Previous speed above 5 km/h.

Sharp turn:

- Current speed above 30 km/h.
- Heading change rate above `SHARP_TURN_DEG_PER_S`.

Speeding:

- Reliable speed above fallback speed threshold.
- No road speed-limit data is currently integrated.

Idle:

- Speed below `IDLE_SPEED_KMH`.
- Accumulated idle duration above `IDLE_EVENT_SECONDS`.

Event detection loop:

```js
for (let i = 1; i < points.length; i++) {
  const prev = points[i - 1];
  const curr = points[i];
  const dt = (new Date(curr.timestamp) - new Date(prev.timestamp)) / 1000;

  if (dt <= 0 || dt > 120) continue;

  const currSegment = calculateSegmentMetrics(prev, curr, thresholds);
  if (currSegment.isNoise) continue;

  const speed1 = previousReliableSpeedOrPointSpeed;
  const speed2 = currSegment.reliableSpeedKmh;
  const accel = calculateAcceleration(speed1, speed2, dt);

  // Individual event checks run here.
}
```

Harsh braking calculation:

```js
if (accel < -HARSH_BRAKE_MS2 && speed1 > 20) {
  const value = Math.abs(accel);
  const severity =
    value > 6 ? "high" :
    value > 5 ? "medium" :
    "low";
}
```

Rapid acceleration calculation:

```js
if (accel > RAPID_ACCEL_MS2 && speed1 > 5) {
  const severity =
    accel > 5 ? "high" :
    accel > 4 ? "medium" :
    "low";
}
```

Sharp turn calculation:

```js
if (speed2 > 30) {
  const h1 = previousHeading ?? calculatedPreviousBearing;
  const h2 = currentHeading ?? calculatedCurrentBearing;
  const turnRateDegPerSecond = headingDiff(h1, h2) / dt;

  if (turnRateDegPerSecond > SHARP_TURN_DEG_PER_S) {
    const severity =
      turnRateDegPerSecond > 90 ? "high" :
      turnRateDegPerSecond > 60 ? "medium" :
      "low";
  }
}
```

Speeding calculation:

```js
if (speed2 > SPEEDING_FALLBACK_KMH) {
  const severity =
    speed2 > 160 ? "high" :
    speed2 > 140 ? "medium" :
    "low";
}
```

Idle calculation:

```js
if (speed2 < IDLE_SPEED_KMH) {
  if (!idleStart) idleStart = curr.timestamp;
  idleAccum += dt;
} else {
  if (idleAccum >= IDLE_EVENT_SECONDS) {
    const severity =
      idleAccum > 300 ? "high" :
      idleAccum > 120 ? "medium" :
      "low";
  }

  idleStart = null;
  idleAccum = 0;
}
```

### 10.5 Scoring

`calculateTripScores(events, stats)` calculates:

- Overall score.
- Safety score.
- Smoothness score.
- Eco score.
- Event counts.

Score methodology:

- Start from 100.
- Apply severity-weighted penalties.
- Normalize penalties by distance so longer trips are not over-penalized.
- Add safety penalty for night driving.
- Add long-drive fatigue safety penalty above 120 minutes.
- Overall score weighting: 40 percent safety, 35 percent smoothness, 25 percent eco.

Penalty table:

| Event | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Harsh brake | 3 | 6 | 12 |
| Rapid acceleration | 2 | 5 | 10 |
| Sharp turn | 2 | 5 | 10 |
| Speeding | 5 | 10 | 20 |
| Idle | 1 | 3 | 5 |

Score dimensions:

- Safety: harsh brakes, speeding, sharp turns, night driving, long-drive fatigue.
- Smoothness: harsh brakes, rapid acceleration, sharp turns.
- Eco: speeding, rapid acceleration, idle.

Penalty accumulation:

```js
for (const event of events) {
  const penalty = penalties[event.type]?.[event.severity] ?? 0;

  if (["harsh_brake", "speeding", "sharp_turn"].includes(event.type)) {
    safetyPenalty += penalty;
  }

  if (["harsh_brake", "rapid_acceleration", "sharp_turn"].includes(event.type)) {
    smoothnessPenalty += penalty;
  }

  if (["speeding", "rapid_acceleration", "idle"].includes(event.type)) {
    ecoPenalty += penalty;
  }
}
```

Night-driving and long-drive penalties:

```txt
if night_driving:
  safetyPenalty += 5

drive_minutes = duration_seconds / 60
if drive_minutes > LONG_DRIVE_MINUTES:
  safetyPenalty += floor((drive_minutes - LONG_DRIVE_MINUTES) / 30) * 3
```

Distance-normalized score formula:

```txt
dist_factor = max(1, distance_km)
normalized_score = max(0, 100 - min(penalty * (5 / dist_factor), 80))

safety = round(normalize(safetyPenalty))
smoothness = round(normalize(smoothnessPenalty))
eco = round(normalize(ecoPenalty))
overall = round(safety * 0.40 + smoothness * 0.35 + eco * 0.25)
```

Complete scoring skeleton:

```js
const distFactor = Math.max(1, stats.distance_km || 1);
const normalize = (penalty) =>
  Math.max(0, 100 - Math.min(penalty * (5 / distFactor), 80));

const safety = Math.round(normalize(safetyPenalty));
const smoothness = Math.round(normalize(smoothnessPenalty));
const eco = Math.round(normalize(ecoPenalty));
const overall = Math.round(safety * 0.4 + smoothness * 0.35 + eco * 0.25);
```

## 11. Insights And Analytics

File: `src/lib/tripInsights.js`

Main responsibilities:

- Speed segment colors and labels.
- Stop detection.
- Vehicle trip distance and odometer calculations.
- Maintenance status.
- Fuel, cost, and CO2 estimates.
- Score tips.
- Weekly driving goals.
- No-harsh-brake streak.
- Time-of-day analysis.
- Day-of-week analysis.
- Fatigue risk.
- Risk event rate.
- Speed discipline.
- Driving consistency.
- Driving coach insight generation.
- Achievement badge calculation.

Defaults:

- Fuel price: 1.65 per liter.
- Fuel efficiency: 8.5 L/100 km.
- Gasoline CO2: 2.31 kg per liter.

### 11.1 Speed Segment Labels

Speed colors and labels are used in route analysis and playback.

```js
function getSpeedLabel(speedKmh = 0) {
  if (speedKmh >= 120) return "Risk";
  if (speedKmh >= 90) return "Fast";
  if (speedKmh >= 55) return "Cruise";
  if (speedKmh >= 15) return "City";
  return "Slow";
}
```

Color thresholds:

```txt
speed >= 120 km/h -> red
speed >= 90 km/h  -> orange
speed >= 55 km/h  -> green
speed >= 15 km/h  -> blue
else              -> slate
```

Speed segments are created between adjacent valid route points:

```js
for (let i = 1; i < cleanPoints.length; i++) {
  segments.push({
    from: cleanPoints[i - 1],
    to: cleanPoints[i],
    speed_kmh: currentPoint.speed_kmh ?? previousPoint.speed_kmh ?? 0,
    color: getSpeedColor(speed),
    label: getSpeedLabel(speed)
  });
}
```

### 11.2 Stop Detection

Stops are detected from route points when speed stays low for long enough.

Default stop settings:

```txt
min_stop_seconds = 90
max_stop_speed_kmh = 5
```

Stop calculation:

```js
if (speed <= maxSpeedKmh) {
  stopStart ??= point;
  lastStoppedPoint = point;
}

if (speed > maxSpeedKmh && stopStart && lastStoppedPoint) {
  const durationSeconds =
    (lastStoppedPoint.timestamp - stopStart.timestamp) / 1000;

  if (durationSeconds >= minStopSeconds) {
    stops.push({
      lat: stopStart.lat,
      lng: stopStart.lng,
      start_time: stopStart.timestamp,
      end_time: lastStoppedPoint.timestamp,
      duration_seconds: durationSeconds
    });
  }
}
```

### 11.3 Vehicle Odometer And Maintenance

Vehicle trip distance:

```txt
vehicle_trip_distance_km =
  sum(completed trip.distance_km where trip.vehicle_id == vehicle.id)
```

If a vehicle is the default vehicle, trips without a `vehicle_id` are counted for that vehicle.

Vehicle odometer:

```txt
vehicle_odometer_km = vehicle.odometer_km + vehicle_trip_distance_km
```

Maintenance item calculation:

```txt
next_due_km = last_service_km + interval_km
remaining_km = next_due_km - current_odometer_km
status = "due"  when remaining_km <= 0
status = "soon" when remaining_km <= 1000
status = "ok"   otherwise
```

### 11.4 Fuel Cost And CO2

Trip economics are estimated from trip distance and vehicle fuel assumptions.

```txt
distance_km = trip.distance_km
l_per_100km = vehicle.fuel_efficiency_l_per_100km or default 8.5
fuel_price_per_liter = vehicle.fuel_price_per_liter or default 1.65
liters = distance_km * l_per_100km / 100
cost = liters * fuel_price_per_liter
co2_kg = liters * 2.31
```

Implementation skeleton:

```js
function estimateTripEconomics(trip, vehicle = {}, settings = {}) {
  const distanceKm = Number(trip?.distance_km) || 0;
  const lPer100Km =
    Number(vehicle?.fuel_efficiency_l_per_100km) ||
    Number(settings.default_l_per_100km) ||
    8.5;
  const fuelPrice =
    Number(vehicle?.fuel_price_per_liter) ||
    Number(settings.default_fuel_price_per_liter) ||
    1.65;

  const liters = distanceKm * lPer100Km / 100;
  const cost = liters * fuelPrice;
  const co2Kg = liters * 2.31;

  return {
    liters: Math.round(liters * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    co2_kg: Math.round(co2Kg * 100) / 100
  };
}
```

### 11.5 Weekly Goals

Weekly goals use completed trips since the start of the current week.

```txt
week_start = local start of Sunday
week_trips = completed trips where trip.start_time >= week_start
```

Goal calculations:

```txt
harsh_brakes = sum(weekTrip.harsh_brakes_count)
speeding_events = sum(weekTrip.speeding_events_count)
night_trips = count(weekTrip.night_driving == true)
avg_score = round(sum(score_overall) / count(scored trips))
```

Goal pass/fail:

```txt
harsh_brakes goal met when harsh_brakes <= weekly_goal_harsh_brakes
speeding goal met when speeding_events <= weekly_goal_speeding_events
average score goal met when avg_score >= weekly_goal_min_avg_score
night trips goal met when night_trips <= weekly_goal_max_night_trips
```

### 11.6 Streaks

The no-harsh-brake streak groups completed trips by calendar day.

```txt
for each completed trip:
  day = local start of trip day
  day.harshBrakes += trip.harsh_brakes_count

start from today if today has trips, otherwise latest trip day
streak += 1 for each consecutive day where harshBrakes == 0
stop when a day is missing or harshBrakes > 0
```

### 11.7 Time And Day Analysis

Time-of-day buckets:

```txt
morning   = 05:00 through 11:59
afternoon = 12:00 through 16:59
evening   = 17:00 through 21:59
night     = 22:00 through 04:59
```

Each bucket calculates:

```txt
trips = count(completed trips in bucket)
avgScore = round(sum(score_overall) / count(scored trips in bucket))
events = sum(harsh_brakes + rapid_accel + sharp_turns + speeding)
```

Day-of-week analysis uses the same calculations grouped by `Date.getDay()`.

### 11.8 Fatigue Risk

Fatigue risk uses the configured long-drive threshold.

```txt
threshold_minutes = settings.threshold_long_drive_minutes or 120
long_trips = trips where duration_seconds / 60 >= threshold_minutes
total_long_minutes = sum(longTrip.duration_seconds / 60)
longest_trip_minutes = max(trip.duration_seconds / 60)
```

Risk level:

```txt
high   when long_trip_count >= 3 or longest_trip_minutes >= threshold_minutes * 1.5
medium when long_trip_count > 0
low    otherwise
```

### 11.9 Risk Event Rate

Risk event rate is used by Driving Coach.

```txt
distance_km = sum(completed trip.distance_km)
harsh_brakes = sum(completed trip.harsh_brakes_count)
rapid_accel = sum(completed trip.rapid_accel_count)
sharp_turns = sum(completed trip.sharp_turns_count)
speeding = sum(completed trip.speeding_events_count)
total_events = harsh_brakes + rapid_accel + sharp_turns + speeding
events_per_100km = distance_km > 0 ? round((total_events / distance_km) * 100, 1) : 0
worst_event = event type with the largest count
```

Implementation detail:

```js
const per100Km = distanceKm > 0
  ? Math.round((totalEvents / distanceKm) * 1000) / 10
  : 0;
```

The multiplication by `1000` and division by `10` is how the app rounds events per 100 km to one decimal place.

### 11.10 Speed Discipline

Speed discipline analyzes all sampled route point speeds from completed trips.

```txt
speed_limit = settings.threshold_speeding_kmh or 130
warn_limit = speed_limit + settings.threshold_speed_over_kmh or speed_limit + 10
points = all completed trip route points with finite speed_kmh
max_speed_kmh = round(max(points.speed_kmh))
avg_speed_kmh = round(sum(points.speed_kmh) / point_count)
over_limit_points = count(speed_kmh > speed_limit)
over_warn_points = count(speed_kmh > warn_limit)
over_limit_percent = round(over_limit_points / point_count * 100)
```

Level:

```txt
needs_attention when over_warn_points > 0 or over_limit_percent >= 10
watch           when over_limit_percent > 0
steady          otherwise
unknown         when there are no speed samples
```

### 11.11 Consistency Score

Driving consistency is based on variation in completed trip scores.

```txt
scores = completed trip score_overall values greater than 0
avg = sum(scores) / scores.length
variance = sum((score - avg)^2) / scores.length
deviation = sqrt(variance)
consistency_score = max(0, round(100 - deviation * 2))
```

Level:

```txt
steady       when consistency_score >= 85
mixed        when consistency_score >= 70
inconsistent otherwise
unknown      when there are no scored trips
```

### 11.12 Coaching Focus

The driving coach selects a focus area in priority order.

```js
const focusArea = riskRate.worst_event_count > 0
  ? eventLabels[riskRate.worst_event]
  : speed.level === "needs_attention"
    ? "speed control"
    : fatigue.level === "high"
      ? "fatigue breaks"
      : "consistency";
```

The coach then builds action text from:

- Worst event type.
- Speed discipline status.
- Fatigue level.
- Best time-of-day driving window.

### 11.13 Achievement Calculations

Achievement badges are calculated entirely from completed trips.

Representative badge rules:

```txt
First Drive       -> completed.length >= 1
Getting Rolling   -> completed.length >= 5
Road Regular      -> completed.length >= 10
100 km Club       -> total completed distance >= 100 km
500 km Club       -> total completed distance >= 500 km
Night Owl         -> night driving trip count >= 5
Daily Driver      -> completed trips in last 7 days >= 5
Route Replay Ready -> any completed trip has >= 20 route points and speed data
Clean Long Drive  -> any clean completed trip duration >= 60 minutes
```

Clean trip definition:

```txt
harsh_brakes_count == 0
rapid_accel_count == 0
sharp_turns_count == 0
speeding_events_count == 0
```

Perfect Trip:

```txt
score_overall >= 95 and clean trip
```

Smooth Driver:

```txt
completed.length >= 10 and average score >= 85
```

Steady Five:

```txt
last_five_completed_trips.length >= 5 and average(last five scores) >= 85
```

## 12. Permissions

File: `src/lib/permissions.js`

Permission categories:

- Foreground location.
- Background location.
- Physical activity recognition.
- Notifications.

Permission status is written back to local settings:

- `location_permission_granted`
- `notification_permission_granted`
- `activity_permission_granted`
- `background_location_granted`

Android background auto tracking requires:

- Fine location.
- Background location.
- Physical activity.
- Notifications on Android 13+.
- Foreground service capability from manifest.
- Battery optimization should be unrestricted for reliability.

## 13. Notifications

File: `src/lib/notificationService.js`

Native notification channels:

- `drivesense_tracking`: persistent trip tracking notifications.
- `drivesense_summary`: trip summaries and reminders.
- `drivesense_achievements`: achievement unlocks.

Notification types:

- Trip started.
- Trip completed.
- Long-trip reminder after 2 hours.
- Weekly driving report, Tuesday at 9:00.
- Safe driving tip, daily at 8:00.
- Achievement unlocked.

Notification IDs:

- Long-trip reminder: `2001`
- Trip completed: `2002`
- Trip started: `2003`
- Weekly report: `2101`
- Safe driving tip: `2102`
- Achievements: derived from base `3000` plus achievement id character codes.

Achievement notification state:

- Key: `drivesense_notified_achievements`
- Storage: localStorage.

## 14. Export, Import, And Backup

Files:

- `src/lib/tripEngine.js`
- `src/lib/dataBackup.js`
- `src/pages/Settings.jsx`
- `src/pages/Report.jsx`

### 14.1 CSV Export

`tripsToCSV(trips)` exports:

- ID.
- Start/end time.
- Duration.
- Distance.
- Average/max speed.
- Scores.
- Event counts.
- Night driving flag.
- GPS point count.
- Route points JSON.
- Driving events JSON.

`downloadCSV(content, filename)` writes:

- Native: Capacitor Filesystem Documents directory.
- Browser: Blob download.

### 14.2 Full JSON Backup

Backup shape:

```js
{
  app: "DriveSense",
  version: 1,
  exported_at: "...",
  settings: {},
  vehicles: [],
  trips: []
}
```

Full backup contains:

- Settings.
- Vehicles.
- Trips.
- Route points.
- Driving events.

Import behavior:

- Validates `app: "DriveSense"`.
- Upserts vehicles.
- Upserts trips.
- Optionally merges settings into current settings.

## 15. Android Project

### 15.1 Capacitor Config

File: `capacitor.config.ts`

Important values:

- App id: `com.drivesense.app`
- App name: `DriveSense`
- Web directory: `dist`
- Android legacy bridge enabled.
- Local notification small icon: `ic_stat_drivesense`
- Splash screen resource: `splash`

### 15.2 Android Manifest

File: `android/app/src/main/AndroidManifest.xml`

Main application components:

- `MainActivity`
- FileProvider
- `DriveSenseActivityReceiver`
- Capacitor background geolocation foreground service
- `DriveSenseAutoTrackingService`

Permissions:

- `INTERNET`
- `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION`
- `ACCESS_COARSE_LOCATION`
- `ACCESS_BACKGROUND_LOCATION`
- `ACTIVITY_RECOGNITION`
- `POST_NOTIFICATIONS`
- `FOREGROUND_SERVICE`
- `FOREGROUND_SERVICE_LOCATION`
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`

### 15.3 MainActivity

File: `android/app/src/main/java/com/drivesense/app/MainActivity.java`

MainActivity extends Capacitor `BridgeActivity` and registers:

- `DriveSenseActivityRecognitionPlugin`

### 15.4 Capacitor Native Plugin

File: `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`

Plugin name:

- `DriveSenseActivityRecognition`

Plugin methods:

- `checkPermissions`
- `requestPermissions`
- `requestBackgroundLocation`
- `start`
- `stop`
- `startNativeAutoTracking`
- `stopNativeAutoTracking`
- `openAppLocationSettings`
- `openBatteryOptimizationSettings`
- `batteryOptimizationStatus`
- `nativeAutoTrackingStatus`
- `getNativeCompletedTrips`
- `clearNativeCompletedTrips`

Plugin listener event:

- `activityChanged`

Activity type mapping:

- In vehicle -> `in_vehicle`
- On bicycle -> `cycling`
- On foot -> `on_foot`
- Running -> `running`
- Still -> `still`
- Walking -> `walking`
- Unknown/default -> `unknown`

### 15.5 Native Auto Tracking Service

File: `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`

The service:

- Runs as a foreground service.
- Keeps a persistent notification.
- Requests activity updates.
- Starts location updates when in-vehicle confidence is high.
- Stops trips after still/non-vehicle signals and stationary time.
- Stores completed native trips for React import.

Native service limitations:

- It calculates native trip summary stats and initially stores placeholder perfect scores.
- JavaScript import later recalculates stats, events, and scores with the main trip engine.
- Android force-stop still prevents background behavior until the user opens DriveSense again.

### 15.6 Gradle

Files:

- `android/build.gradle`
- `android/app/build.gradle`
- `android/variables.gradle`

Important dependencies:

- Android Gradle plugin.
- AppCompat.
- CoordinatorLayout.
- Core SplashScreen.
- Google Play Services Location.
- Capacitor Android.
- Capacitor Cordova Android plugins.

## 16. Build, Run, And Test

### 16.1 Install

```bash
npm install
```

`postinstall` runs:

```bash
node scripts/patch-android-gradle.mjs
```

### 16.2 Web Development

```bash
npm run dev
```

### 16.3 Web Build

```bash
npm run build
```

### 16.4 Preview Build

```bash
npm run preview
```

### 16.5 Tests

```bash
npm run test
```

The current explicit test file is:

- `src/lib/tripEngine.test.js`

It covers trip engine behavior.

### 16.6 Lint

```bash
npm run lint
```

Auto-fix:

```bash
npm run lint:fix
```

### 16.7 Typecheck

```bash
npm run typecheck
```

### 16.8 Capacitor Android Sync

```bash
npm run android:sync
```

Equivalent:

```bash
npm run build
npx cap sync android
```

### 16.9 Open Android Project

```bash
npm run android:open
```

### 16.10 Android Debug Build

From the `android` folder:

```bash
./gradlew assembleDebug
```

On Windows PowerShell:

```powershell
.\gradlew.bat assembleDebug
```

## 17. Environment Variables

`VITE_API_URL`

- Optional.
- When absent, web uses local repositories.
- When present and not native, trip and vehicle services call the configured backend API.
- Default API base inside the HTTP client is `http://localhost:5000/api`, but services only use the HTTP client when `VITE_API_URL` is set and the app is not native.

## 18. UI Components

Important app components:

- `Layout`: top navigation, mobile drawer, recording status.
- `TripCard`: compact trip summary card.
- `TripMap`: Leaflet route map.
- `TripPlayback`: animated trip route playback.
- `ScoreRing`: score visualization.
- `StatCard`: dashboard stat card.
- `EventBadge`: driving event label.
- `VehicleCompare`: vehicle comparison.
- `ProtectedRoute`: auth-related route wrapper.
- `UserNotRegisteredError`: auth error UI.

UI primitives:

- `src/components/ui` contains shadcn/Radix-style components such as buttons, cards, dialogs, forms, selects, sliders, switches, tabs, tables, tooltips, and toast components.

## 19. Styling

Main stylesheet:

- `src/index.css`

Tailwind config:

- `tailwind.config.js`

Styling system:

- CSS variables for colors.
- Tailwind utility classes.
- Dark mode via `.dark` class.
- Font families: Inter and Space Grotesk.
- App-specific color aliases under `ds`.
- Reusable gradients in CSS classes.

Theme mode:

- `light`: removes `.dark`.
- `dark`: adds `.dark`.
- `system`: follows `prefers-color-scheme`.

## 20. Privacy And Data Behavior

The settings privacy message states:

- DriveSense stores trip, route, score, vehicle, and settings data locally on this device.
- The app does not upload trips to a cloud service by default.
- The app does not sell data.
- The app does not use ads or analytics.
- Deleting trips in Settings removes local trip history from the device.

Data can still leave the device if:

- A backend is configured via `VITE_API_URL`.
- The user exports and shares CSV or JSON backup files.
- Map tiles and Leaflet assets are loaded from network sources.

## 21. Cloud API Expectations If Enabled

If `VITE_API_URL` is configured, the app expects a backend compatible with:

Trips:

- `GET /trips?sort=<sort>&limit=<limit>`
- `GET /trips/:id`
- `POST /trips`
- `PATCH /trips/:id`
- `DELETE /trips/:id`

Vehicles:

- `GET /vehicles?sort=<sort>&limit=<limit>`
- `POST /vehicles`
- `PATCH /vehicles/:id`
- `DELETE /vehicles/:id`

Auth:

- `GET /auth/me`

The client sends a bearer token from localStorage keys `token` or `access_token`.

## 22. Important Operational Notes

- Background auto tracking on Android depends on permissions, foreground service rules, activity recognition, and battery optimization settings.
- Android force-stop stops background behavior. The user must open DriveSense again to restart the service.
- Native background trips are imported and rescored when trip data is read by the React app.
- Web map rendering depends on runtime access to Leaflet assets from `unpkg.com` and map tiles from OpenStreetMap.
- Speeding detection currently uses a fallback speed threshold, not road-specific speed-limit data.
- Settings thresholds are applied when ending trips and importing native trips.
- Existing route points are stored in full inside trips and backups, so backup files can become large.

## 23. Advanced Scoring Roadmap Implemented

The May 2026 advanced scoring update is implemented as real trip calculations, not placeholder fields. New completed trips now receive these fields when a trip ends or when native Android trips are imported and rescored.

Core engine additions in `src/lib/tripEngine.js`:

- `classifyRoadType(cleanPoints)` classifies trips as `highway`, `urban`, `mixed`, or `residential` from speed distribution and applies context-aware fallback speeding thresholds.
- `calculateJerkScore(cleanPoints, distanceKm)` measures rate of acceleration change and blends `jerk_score` into smoothness.
- `detectLaneChanges(points)` emits `lane_change` events from high-speed heading-rate changes.
- `detectTailgateCycles(points)` emits `tailgate_cycle` events from highway cruise followed by short-cycle deceleration.
- `calculateEcoDrivingScore(points, stats)` computes continuous eco quality from speed stability, cruise-band ratio, and idle ratio.
- `detectErraticSpeedWindows(points)` emits `erratic_speed` events as a distraction-risk proxy.
- `analyzeIntersectionBehavior(points)` computes `intersection_score`, stop count, rolling stops, and smooth approaches.
- `analyzeFatigueProgression(points, start, end)` scores trip thirds and stores `fatigue_progression` plus `segment_scores`.

New persisted trip score fields include:

- `road_type`, `avg_highway_speed_kmh`, `avg_urban_speed_kmh`, `highway_fraction`
- `jerk_score`, `jerk_event_count`, `avg_jerk_ms3`
- `eco_driving_score`, `speed_stability`, `cruise_score`
- `lane_changes_count`, `lane_changes_per_10km`
- `tailgate_cycle_count`, `following_distance_score`
- `distraction_events_count`, `distraction_score`
- `intersection_score`, `stop_count`, `rolling_stop_count`, `smooth_approach_count`
- `fatigue_progression`, `segment_scores`, `degradation`

Insight additions in `src/lib/tripInsights.js`:

- `suggestTripTag(trip)` suggests `work`, `personal`, or `errands`; `src/api/trips.js` stores the suggestion without applying it as the user tag.
- `computePersonalBaseline(completedTrips)` calculates rolling 4-week baseline, this-week average, trend, percentile, and best scores.
- `calculateVehicleHealthImpact(vehicleTrips, vehicle)` converts risky events into stress units, extra wear kilometers, service interval adjustments, and a health grade.
- `estimateTripEconomics` now uses `eco_driving_score` to estimate actual L/100 km and fuel saved.

UI surfaces updated:

- `TripDetail.jsx` shows road type, advanced score cards, fuel saved, fatigue progression chart, lane/tailgate/distraction counts, and tag suggestions.
- `Dashboard.jsx` shows personal baseline and a real-time long-trip quality dip alert after 90 minutes.
- `DrivingCoach.jsx` includes lane discipline, following distance, distraction risk, and baseline context.
- `Report.jsx` includes baseline comparison, road type pie chart, and cumulative fuel saved.
- `Vehicles.jsx` shows driving impact, extra wear kilometers, adjusted service intervals, and health grade.
- `Settings.jsx` exposes `threshold_tailgate_decel_ms2`.

## 24. Advanced Feature Expansion Implemented

The second advanced driving-habit expansion is also implemented as real calculations in the scoring and insights pipeline.

Additional engine metrics in `src/lib/tripEngine.js`:

- `calculateAggressiveDrivingScore(events, stats)` returns `aggressive_driving_score`, `aggressive_grade`, and `aggression_penalty_raw`.
- `near_miss` events are emitted from combined braking and evasive heading movement, with `near_miss_count` and `near_miss_score`.
- `detectHighwayMergeBehavior(points)` returns `merge_event_count`, `poor_merge_count`, `harsh_merge_count`, and `merge_score`.
- `calculateHillDrivingScore(points)` returns climb/descent distance, hill infractions, and nullable `hill_driving_score`.
- `calculateSpeedVariabilityIndex(points)` returns `speed_variability_index`, `svi_score`, and `svi_label`.
- `calculateSmoothBrakingRatio(points, thresholds)` returns stop-normalized smooth braking fields.
- `calculateEngineStressScore(events, stats)` returns `engine_stress_score`, `engine_stress_grade`, and `high_speed_accel_count`.
- `calculateTireWearUnits(events)` returns `trip_tire_wear_units`.
- `detectDrowsyDrivingSignature(points, durationSeconds)` returns drowsy window count, risk score, and risk level.
- `detectDrowsyDriving(points, durationSeconds, thresholds)` is the threshold-aware wrapper used by tests and live alert wiring.
- `detectSpeedCreep(points)` returns straight-road speed creep count, max creep, and score.
- `calculateDefensiveDrivingScore(scores)` returns `defensive_driving_score` and `defensive_grade`.
- `detectPhoneUsageProxy(points, thresholds)` / `detectPhoneProxy(points, thresholds)` return `phone_proxy_count` and `phone_proxy_risk`.
- `detectNearMisses(points, thresholds)` is exported for direct unit coverage; `detectDrivingEvents` also emits `near_miss`.
- `analyzeParkingApproach(points, thresholds)` returns `parking_approach_score` and grade.
- `calculateFuelBandScore(points)` returns optimal cruise-band, high-speed, and city-crawl ratios.
- `detectAggressiveOvertakes(points, thresholds)` emits `aggressive_overtake` events and drives `overtake_event_count` / `overtake_score`.

Additional insight exports in `src/lib/tripInsights.js`:

- `calculatePeakHourStress(completedTrips)` compares peak vs off-peak event rates.
- `identifyCommutePatterns(completedTrips)` groups recurring routes by quantized start/end cells.
- `calculateCarbonImpact(completedTrips)` summarizes CO2 saved, tree-year equivalent, and carbon grade.
- `calculateTireWearUnits(events)` is also exported for insight-level wear calculations.
- `buildDrivingCoachInsights` returns `peak_stress`, `peak_hour_stress`, `commute_patterns`, and `carbon_impact`.

Storage and backup changes:

- `localTripRepository.js` defines `TRIP_SCHEMA_VERSION = 2`.
- Completed trips missing `defensive_driving_score`, marked `needs_rescore`, or from an older schema are rescored on read/write with the current thresholds.
- JSON backups now export version `2`; version `1` imports mark trips with `needs_rescore` before upsert.
- CSV export now includes aggressive, defensive, near-miss, smooth braking, SVI, fuel band, engine stress, tire wear, hill, merge, parking, overtake, phone proxy, drowsy, speed creep, and CO2-saved columns.

New advanced threshold settings:

- `threshold_near_miss_brake_ms2`
- `threshold_near_miss_turn_degs`
- `threshold_drowsy_heading_std`
- `threshold_phone_proxy_oscillations`
- `threshold_speed_creep_kmh`
- `threshold_overtake_accel_ms2`

Additional UI/documented behavior:

- `TripDetail.jsx` now surfaces near-miss, phone proxy, overtake warnings, aggressive/defensive score rings, SVI, fuel band, engine stress, parking, drowsy, hill control, and braking quality.
- `Dashboard.jsx` sends a native "Stay Alert" notification when the active trip shows highway heading drift and adds rush-hour behavior to the personal baseline card.
- `DrivingCoach.jsx` shows highway merge, SVI, peak-hour stress, commute pattern, phone, drowsy, and speed-creep context.
- `Report.jsx` includes efficiency bands, peak-vs-off-peak event rate, commute patterns, and carbon impact.
- `Vehicles.jsx` includes engine stress and tire wear impact.
- `TripHistory.jsx` adds filters for near-miss, aggressive driving, distraction risk, drowsy risk, and perfect eco trips.
- `calculateAchievementBadges` includes Feather Foot, Defensive Driver, Distraction-Free, Highway Diplomat, Tree Planter, Green Fleet, Climate Champion, Cruise Master, and Clear Path.

## 25. Known Maintenance Notes

- The Android Reference page contains Kotlin/Compose example snippets, while the production Android implementation is Capacitor plus Java native plugin/service code.
- Some source comments and UI strings appear to contain mojibake characters from encoding issues. Prefer plain ASCII or correctly encoded UTF-8 when editing those files.
- The Report page uses a best-trip highlight section that references an `Award` icon. Confirm imports when working in that area.
- Cloud auth is scaffolded but not implemented end to end.
- There is no road-speed-limit integration yet.
- Leaflet is dynamically loaded rather than installed as an npm dependency.

## 26. Main Files By Responsibility

Bootstrap and routing:

- `src/main.jsx`
- `src/App.jsx`
- `src/components/Layout.jsx`

Pages:

- `src/pages/Onboarding.jsx`
- `src/pages/Dashboard.jsx`
- `src/pages/TripHistory.jsx`
- `src/pages/TripDetail.jsx`
- `src/pages/MapScreen.jsx`
- `src/pages/DrivingCoach.jsx`
- `src/pages/Achievements.jsx`
- `src/pages/Report.jsx`
- `src/pages/Settings.jsx`
- `src/pages/Vehicles.jsx`
- `src/pages/AndroidReference.jsx`

Tracking and scoring:

- `src/lib/trackingService.js`
- `src/lib/trackingStore.js`
- `src/lib/tripEngine.js`
- `src/lib/activityRecognition.js`
- `src/lib/permissions.js`
- `src/lib/notificationService.js`

Data:

- `src/api/client.js`
- `src/api/trips.js`
- `src/api/vehicles.js`
- `src/api/auth.js`
- `src/lib/localTripRepository.js`
- `src/lib/localVehicleRepository.js`
- `src/lib/mobileStorage.js`
- `src/lib/dataBackup.js`

Insights:

- `src/lib/tripInsights.js`

Android native:

- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/java/com/drivesense/app/MainActivity.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityReceiver.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`

Build config:

- `package.json`
- `vite.config.js`
- `tailwind.config.js`
- `capacitor.config.ts`
- `android/build.gradle`
- `android/app/build.gradle`
