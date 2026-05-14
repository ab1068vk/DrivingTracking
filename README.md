# DriveSense

DriveSense is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, and stores trip history on the device.

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

For reliable background tracking, also disable battery optimization for DriveSense in Android app settings.

## Tracking Modes

- Manual: start and stop a trip from the dashboard.
- Auto Detect: detects driving while the app is open.
- Background Auto: starts a native Android foreground service that can detect driving and record trips while the React app is asleep.

Background Auto still will not run after Android force-stops the app. Open DriveSense again to restart the service.

## Native Background Tracking

Native background auto tracking lives in:

- `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseNativeTripStore.java`
- `android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java`

Native trips are imported into the existing local trip repository and rescored with the JavaScript trip engine when the app reads trip history.
