# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and stores trip history on the device.

## Documentation

The main reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is source-first: it explains the app, includes actual code excerpts, and has a grouped complete calculation index for the whole tracked app.

## Current Status

- Package: `drivesense-app`
- Version: `0.0.0`
- Architecture: React/Vite single-page app plus Capacitor Android native shell and background services
- Data model: local-first storage through localStorage, Capacitor Preferences, and Android SharedPreferences
- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories

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

Build the Android debug APK from the `android` directory:

```bash
.\\gradlew.bat assembleDebug
```

Android tracking needs Location, Physical Activity, Notifications, and background tracking permissions. Disable battery optimization for best background reliability.
