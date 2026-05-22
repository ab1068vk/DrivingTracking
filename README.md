# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and stores trip history on the device.

## Documentation

The main reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is an advanced calculation-focused reference: app details, exact formula snippets, thresholds, scoring logic, event detection, reports, and Android native tracking math without dumping entire source files.

## Current Status

- Package: `drivesense-app`
- Version: `1.0.0`
- Architecture: React/Vite single-page app plus Capacitor Android native shell and background services
- Data model: local-first storage through localStorage, Capacitor Preferences, and Android SharedPreferences
- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories

## 2026-05-22 Update

- Phone-use evidence now flows through trip detection, rescoring, dashboard completion, open-source context refresh, and scoring with a stable `{ events, phoneUse }` return shape.
- Distraction scoring now reflects high-risk phone use, includes tests for no-risk and persistent-risk cases, and keeps a documented deduction cap.
- Feedback rescoring removes reviewed-wrong detected events before scoring while preserving post-score merged phone-use evidence.
- Achievement notification IDs now use a persisted unique allocation map, and fuel-savings notifications use trip/user fuel price settings before falling back to the app default.
- Eco cruise scoring uses configurable cruise speed thresholds and documents the scoring constants behind speed stability, speed variability, reaction proxy floors, following-distance floors, fuel-band credit, and tree-equivalent CO2.
- Sidebar open/closed preference is stored in localStorage instead of a cookie so the cosmetic UI setting is not sent with HTTP requests.
- The technical reference has been refreshed with the release remediation history and this follow-up pass.
- Verified on 2026-05-22 with `npm.cmd test` and `npm.cmd run build`.

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
