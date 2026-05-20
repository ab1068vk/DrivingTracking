# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and stores trip history on the device.

Full documentation:

- [APP_DOCUMENTATION.md](APP_DOCUMENTATION.md) - complete app architecture, feature, storage, Android, and workflow reference.
- [CALCULATIONS.md](CALCULATIONS.md) - complete calculation and scoring reference.

## Current Status

The project is a Vite React app with a Capacitor Android shell. The local data model is currently `TRIP_SCHEMA_VERSION = 8`, which rescans older completed trips so advanced fields, OpenStreetMap/weather context, phone-use evidence, and recalculated scores stay aligned with the current trip engine.

Current source-of-truth modules:

- Web app entry: `src/App.jsx`, `src/main.jsx`
- Dashboard and tracking UI: `src/pages/Dashboard.jsx`
- Trip scoring and event engine: `src/lib/tripEngine.js`
- Trip insights, cost, maintenance, goals, and achievements: `src/lib/tripInsights.js`
- Local trip repository and rescoring: `src/lib/localTripRepository.js`
- Settings and active trip persistence: `src/lib/trackingStore.js`
- Android activity and native auto tracking bridge: `src/lib/activityRecognition.js`
- Android foreground service: `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- Native trip persistence: `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`
- Phone usage bridge: `android/app/src/main/java/com/drivesense/app/DriveSensePhoneUsageTracker.java`
- OpenStreetMap and OSRM context: `src/lib/openSourceTripContext.js`, `src/lib/speedLimitSource.js`, `src/lib/mapMatching.js`
- Sensor fusion and crash workflow: `src/lib/sensorFusionModel.js`
- Daily fatigue, pre-trip risk, danger zones, and route risk: `src/lib/dailyFatigueEngine.js`, `src/lib/preTripRisk.js`, `src/lib/dangerZoneEngine.js`, `src/lib/routeRiskIndex.js`, `src/lib/predictiveRouteRisk.js`
- Calibration, privacy zones, OBD, reports: `src/lib/thresholdCalibration.js`, `src/lib/privacyZones.js`, `src/lib/obdBluetooth.js`, `src/lib/ubiReport.js`, `src/lib/pdfExport.js`

## Local Setup

```bash
npm install
npm run dev
```

Build the web app:

```bash
npm run build
```

Run tests:

```bash
npm run test
```

Run lint and type checking:

```bash
npm run lint
npm run typecheck
```

## Android Setup

After changing web or native code, sync Capacitor:

```bash
npm run android:sync
```

Build the Android debug APK:

```bash
cd android
./gradlew assembleDebug
```

You can also open the `android` folder in Android Studio and run the app on a connected phone.

## Phone Permissions

For trip tracking to work properly on Android, allow:

- Location: `Allow all the time`
- Physical Activity
- Notifications

For reliable background tracking, also disable battery optimization for Road Sage in Android app settings.

First launch opens onboarding and starts the recommended permission setup on Android. It requests Location, Notifications, Motion/Activity, and background tracking permissions, then opens Android Usage Access because Android does not provide an in-app prompt for real phone-use detection.

## Tracking Modes

- Manual: start and stop a trip from the dashboard.
- Auto Detect: detects driving while the app is open.
- Background Auto: starts a native Android foreground service that can detect driving and record trips while the React app is asleep.

Background Auto does not run after Android force-stops the app. Open Road Sage again to re-arm the service.

## Core Tracking Calculations

JavaScript auto-start uses `src/lib/activityRecognition.js`:

- `AUTO_START_IN_VEHICLE_CONFIDENCE = 65`
- `AUTO_START_SPEED_KMH = 5`
- `AUTO_START_IN_VEHICLE_SECONDS = 2`
- `AUTO_START_GPS_FALLBACK_SECONDS = 2`
- `WALKING_SPEED_CUTOFF_KMH = 10`

Foreground auto-start returns true when either:

- activity is `in_vehicle`, confidence is at least `65`, current speed is at least `5 km/h`, and recent movement has lasted at least `2 seconds`; or
- activity is missing, unknown, or uncertain, current speed is at least `5 km/h`, and recent GPS movement has lasted at least `2 seconds`.

Native background auto-start uses the same high-level proof, then starts a hidden candidate trip instead of immediately saving it. A candidate confirms only when it has stable GPS, enough vehicle-like distance, and a vehicle-speed segment:

- normal candidate: at least `4` stable GPS points, at least `150 m`, and max speed at least `10 km/h`
- candidate near the last parked location within the 5-minute parking cooldown: at least `5` stable GPS points, at least `250 m`, and max speed at least `10 km/h`
- strong walking/running/cycling activity with speed at or below `10 km/h` discards the candidate as walking
- candidate review expires after `180 seconds` and discards the trip if proof is still insufficient

## Default Detection Thresholds

Default settings and trip thresholds are synchronized from `src/lib/trackingStore.js` and `src/lib/tripEngine.js`:

- Harsh braking: deceleration greater than `3.5 m/s2`, minimum speed `25 km/h`
- Rapid acceleration: acceleration greater than `3.0 m/s2`, minimum speed `5 km/h`
- Tailgate proxy deceleration: `2.5 m/s2`
- Sharp turn lateral-g bands: low `0.35 g`, medium `0.45 g`, high `0.60 g`
- Speed fallback when no speed limit is known: `100 km/h`
- Speed-over margin for known/inferred limits: `5 km/h`
- Idle event duration: `90 seconds`
- Long drive threshold: `120 minutes`
- GPS max accuracy in JavaScript engine: `50 m`
- Native GPS max accuracy: `75 m`
- Minimum point distance/noise floor: `8 m`
- Stationary speed: `5 km/h`
- Minimum trusted low-speed GPS reading: `18 km/h`
- Minimum saved trip: `30 seconds` and `0.1 km`

## Native Stop And Parking Logic

The Android service records `stoppedAnchorLat`, `stoppedAnchorLng`, and `maxDriftSinceStopM` while speed is below `5 km/h`.

Native stop paths:

- walking/running/cycling with confidence at least `75` and speed at or below `10 km/h`: stop after `10 seconds`
- STILL with speed below `5 km/h` and drift below `8 m`: stop after `90 seconds`
- STILL with speed below `5 km/h` and drift at or above `8 m`: stop after `150 seconds`
- IN_VEHICLE with speed below `2 km/h` and drift below `5 m`: stop after `90 seconds`
- IN_VEHICLE with speed below `2 km/h` and drift below `20 m`: stop after `300 seconds`
- IN_VEHICLE with speed below `5 km/h` and very stable drift below `5 m`: stop after `120 seconds`
- IN_VEHICLE with speed below `5 km/h`, speed below `2 km/h`, and drift below `20 m`: stop after `300 seconds`
- IN_VEHICLE with speed below `2 km/h`: absolute timeout after `420 seconds`
- UNKNOWN activity with speed below `5 km/h` and stable drift below `8 m`: stop after `180 seconds`
- stale location handling treats the trip as stopped if no location arrives for `30 seconds` while Android reports STILL or on-foot activity

When a native trip ends parked, the service trims likely walking/GPS-drift tail points after the last vehicle-speed segment, records a native tracking timeline, saves the final parked location, and emits a completed native trip for the React repository to import and rescore.

## Scoring And Reports

The main score calculation starts from `100`, applies weighted deductions for safety, smoothness, eco behavior, fatigue, night driving, phone use, and advanced safety signals, then floors major scores at `20`. Full formulas are in [CALCULATIONS.md](CALCULATIONS.md).

Notable report and risk calculations:

- UBI report weights: mileage `15%`, time of day `20%`, hard braking `25%`, acceleration `20%`, cornering `10%`, speed compliance `10%`
- Pre-trip risk weights: time of day `14%`, day of week `10%`, recent trend `18%`, daily fatigue `20%`, last trip outcome `12%`, weather `8%`, danger zones `6%`, route forecast `8%`, recent rest `4%`
- Daily fatigue score: `min(5, drivingMinutes / 60) + min(2, (tripCount - 1) * 0.5) - min(2, minutesSinceLastTrip / 30)`, clamped to `0..10`
- Route risk index: per-segment event rate times `20`, harsh-event rate times `40`, plus `10` when average speed is at least `100 km/h`, capped at `100`
- Predictive route risk: `(100 - avgRecentScore) * 0.45 + eventDensity * 18 + nearbyDangerZones * 10 + weatherRisk * 0.25 + timeRisk`
- Sensor fusion phone movement score: average linear acceleration times `5`, average rotation times `0.08`, plus harsh motion count times `2`, clamped to `0..100`
- Adaptive calibration requires at least `15` completed trips and `200 km`, or at least `3` reviewed event feedback items

## Open-Source Context And Live Coaching

- Trip Detail has a **Refresh OSM Context** action that reruns OpenStreetMap speed limits, OSRM map matching, and weather context for existing trips.
- Map also offers **Refresh OSM Context** for the selected trip when speed limits are missing.
- Trip Detail and Map can show an **OSM Speed Limits** layer when route points have matched `maxspeed` tags or OSM road-type defaults.
- Speeding is scored from OpenStreetMap `maxspeed` where available, using a `+5 km/h` warning margin. When `maxspeed` is missing, OSM `highway=*` tags provide road-type defaults before GPS-only fallback limits are used.
- Settings includes a **Test** button for live voice alerts; Android WebView falls back to native TextToSpeech when browser speech output is unavailable.
- Live coaching checks active trips every `15 seconds` and speaks the selected urgent alert as soon as the toast is shown.
- Voice priority is phone use, near miss, harsh brake, tailgating, speeding, rapid acceleration, then extended idling. One message is spoken at a time.
- The emergency workflow shows an active-trip check-in with "I'm OK" and "Call 911" actions after a possible incident.

## Native Background Tracking Files

Native background auto tracking lives in:

- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityReceiver.java`
- `android/app/src/main/java/com/drivesense/app/DriveSensePhoneUsageTracker.java`

Native trips are imported into the existing local trip repository and rescored with the JavaScript trip engine when the app reads trip history.
