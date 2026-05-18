# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, and stores trip history on the device.

For full app documentation, see [APP_DOCUMENTATION.md](APP_DOCUMENTATION.md).

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

## Android Setup

After changing web or native code, sync Capacitor:

```bash
npx cap sync android
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

First launch now opens onboarding with a one-tap recommended permission setup. It requests Location, Notifications, Motion/Activity, and Android background tracking permissions, and links to Phone Usage Access for real phone-use detection.

## Tracking Modes

- Manual: start and stop a trip from the dashboard.
- Auto Detect: detects driving while the app is open.
- Background Auto: starts a native Android foreground service that can detect driving and record trips while the React app is asleep.

Background Auto still will not run after Android force-stops the app. Open Road Sage again to restart the service.

## May 2026 Tracking Stabilization

- GPS capture now requests the first fix immediately and uses faster high-accuracy watch intervals on web, Capacitor, and native Android background auto.
- In-app and native auto-start trigger after 3 seconds above about 3 km/h with in-vehicle confidence, reducing missed trip starts.
- Lane-change and erratic-speed events use stricter GPS shape, heading, speed stability, and reversal checks to reduce false positives.
- Overtake quality is only calculated for aggressive overtake events or high-speed lane changes with a real speed-up pattern.
- Weather context uses historical Open-Meteo data for past trips and samples the trip time more tightly so a nearby rainy hour does not label a sunny drive as rainy.
- Trip cards automatically show a Night tag when `night_driving` is true, even if the user did not manually tag the trip.
- Local trip schema version 7 rescans older completed trips so advanced trip-page fields are recalculated with the current engine.

## Open-Source Context And Live Coaching

- Trip Detail has a **Refresh OSM Context** action that reruns OpenStreetMap speed limits, OSRM map matching, and weather context for existing trips.
- Map also offers **Refresh OSM Context** for the selected trip when speed limits are missing.
- Trip Detail and Map can show an **OSM Speed Limits** layer when matched speed-limit tags exist on route points.
- Speeding is scored from OpenStreetMap `maxspeed` where available, using a +5 km/h warning margin. When OSM speed limits are unavailable, fallback limits are road-context aware: 40 km/h residential, 60 km/h urban, and 100 km/h highway.
- Harsh braking defaults to 3.5 m/s2, rapid acceleration defaults to 3.0 m/s2, and speed-creep alerts default to a 5 km/h drift.
- Settings includes a **Test** button for live voice alerts; Android WebView falls back to native TextToSpeech when browser speech output is unavailable.
- Live coaching checks active trips every 15 seconds and can speak urgent speed, phone, braking, following-gap, fatigue, and near-miss alerts when voice alerts are enabled.

## Native Background Tracking

Native background auto tracking lives in:

- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`

Native trips are imported into the existing local trip repository and rescored with the JavaScript trip engine when the app reads trip history.
