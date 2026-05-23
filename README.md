# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and keeps trip history on the device unless an optional backend is configured.

## Current App Surface

- Dashboard, trip history, trip detail, live map, driving coach, insights, achievements, reports, diagnostics, settings, and vehicles pages.
- Manual trip capture, foreground auto-detect, and Android native background auto tracking with activity recognition, GPS fallback, quick settings tile support, pause/resume controls, and native trip import.
- Trip scoring for safety, smoothness, eco driving, phone-use distraction, speed compliance, road-type segments, reaction proxy, cornering, braking efficiency, overtake quality, tailgating, fatigue, drowsy risk, slippery-condition proxy, and route risk.
- Map playback with route simplification, stop handling, privacy-masked coordinate handling, HTML-escaped Leaflet popups, speed-limit coloring, fatigue overlays, event markers, and repeated-route comparison support.
- Vehicle profiles with fuel/electric economy, odometer estimates, maintenance reminders, renewal tracking, localized per-car cost, CO2, and engine-health summaries, default vehicle handling, and vehicle comparison.
- Reports with CSV export, monthly PDF export, UBI score-card PDF export, rolling baseline comparison, carbon impact, configurable-currency fuel cost, and CO2 savings.
- Full backup export/import for trips, GPS route points, events, vehicles, settings, privacy-zone metadata, saved filters, and reviewed event feedback.
- Diagnostics capture unhandled app errors, handled critical operation failures, and isolated React section crashes with sanitized messages and stack previews.

## Recent Update Coverage

The markdown is regenerated from the current source tree and reflects the latest vehicle-health, tracking, scoring, privacy, storage, and documentation behavior.

- Documentation was converted into a source-generated technical reference with module inventory, imports/exports, function catalogue, calculation snippets, constants, storage, routes, error handling, tests, dependencies, and deployment notes.
- Calculation-heavy UI is isolated with `SectionErrorBoundary`: TripMap, TripPlayback, the Trip Detail score summary, the Trip Detail page shell, and the Dashboard readiness/risk panel now show a friendly reloadable fallback and log the caught error instead of blanking the whole app.
- Critical post-trip and persistence operations now log handled failures through `logError`: completed-trip notifications, phone-use pattern alerts, style-shift alerts, achievement notification sync, daily fatigue warnings, vehicle odometer sync, and driver-signature saves all write diagnostic events instead of being silently swallowed.
- Vehicle odometer sync still retries on the next vehicle/trip refresh, and repeated failures in a session show a non-blocking toast so stale odometer estimates are visible without blocking the Vehicles page.
- Numeric clamping is centralized in `src/lib/mathUtils.js`; score, route-risk, fatigue, weather, report, playback, calibration, and import sanitization paths now share the same NaN-safe boundary behavior.
- Scoring was stabilized around explicit defaults: noisy-signal filtering, rate-normalized scoring, traffic-stop grace periods, privacy-masked coordinate exclusion, stable phone-use merges, finite anomaly/sensor scores, and reviewed-event rescoring.
- Trip-stat hot paths now stay linear over route points: sunset night driving windows are cached once per trip date, speed-zone windows use sliding summaries, drowsy detection uses a moving window, and fatigue progression uses direct segment scoring instead of recursively rescoring three sub-trips.
- Eco driving scoring now exposes cruise-band, moving-speed floor, cruise-score multiplier, idle-penalty multiplier, and idle-penalty cap settings, and returns `idle_penalty_points` for diagnostics and tests.
- Phone-use Safety impact messaging now uses the exported `PHONE_USE_SAFETY_WEIGHT` scorer constant, so Trip Detail explanations stay aligned with the actual Safety score blend.
- Predictive route risk now sorts completed trips newest-first inside the estimator before applying the recent-trip window, so dashboard and map pre-trip risk stay based on fresh history even when callers pass unsorted trip arrays.
- Vehicle engine-health summaries now average only finite stored engine stress scores. Trips without a usable score are excluded, and vehicles with no scored samples show `N/A` instead of a misleading maximum-stress fallback.
- Currency and economics baselines are configurable in Settings, including cost symbol, average vehicle CO2 per 100 km, EV kWh per 100 km, grid CO2 intensity, and tree-year equivalents. Vehicle fuel type is used for trip CO2 and savings estimates, and vehicle fuel/energy price validation now allows values up to 20 per litre or kWh for high-price markets.
- Backup import is hardened: files larger than 50 MB are rejected from the Settings file picker before the JSON body is read, malformed or non-backup JSON gets clear errors, trips/settings are sanitized, unknown fields are stripped, prototype-pollution keys are ignored, route/event arrays are capped, unsafe thresholds are clamped, imported OSRM endpoints are stripped, and imported background auto tracking requires in-app consent.
- Local trip storage uses IndexedDB when available, with a migration runner and localStorage fallback. Trip schema versioning triggers rescoring for completed trips when scoring, phone-use, map, or privacy behavior changes.
- API behavior is local-first by default. Trips and vehicles use local repositories when `VITE_API_URL` is absent or the app is running natively; configured backends fail clearly instead of silently falling back to localhost.
- Auth tokens are session-scoped. Legacy `localStorage` tokens are migrated into `sessionStorage` and removed, and logout clears both token names from browser storage.
- Open road context is explicit and privacy-aware. OpenStreetMap speed limits and Open-Meteo weather are manual by default unless automatic context fetch is enabled. OSRM route snapping is opt-in, disabled without a configured endpoint, and the public demo requires confirmation because sampled GPS points leave the device.
- Settings now explains tracking, Android permissions, privacy, notifications, speed warnings, currency/economics, advanced models, and data controls with searchable sections and safer validation.
- Android tracking updates include immediate native notification state, quick settings tile sync, clearer off/paused handling, deduplicated trip/safety notifications, battery optimization guidance, phone usage access support, and native diagnostics surfaced in the app.
- Privacy-zone and map fixes keep private locations masked, allow radius editing, hide private events, exclude masked null coordinates from distance/playback math, HTML-escape user/external values in Leaflet popups, and preserve original GPS geometry when route snapping or old map-matching data would collapse playback.
- Test coverage now includes backend fallback, auth migration, backup import security, settings import security, IndexedDB migrations, UBI mileage windows, notifications, currency formatting, vehicle fuel-price validation, scoring consistency, privacy zones, OSRM opt-in behavior, route risk, tracking diagnostics, section error boundaries, and release-blocker regressions.
- Repository hygiene now blocks machine-local Android SDK files from the tracked tree: `android/local.properties` remains ignored, is excluded from generated technical-reference scans, and is checked in CI with `npm run check:repo-hygiene`.

## Documentation

The production technical reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is generated from the repository by `scripts/generate-technical-reference.mjs` and includes:

- source/module inventory, import/export map, and function/method catalogue
- actual calculation snippets for scoring, trip physics, playback, route risk, predictions, reports, imports/exports, and Android native tracking
- grouped calculation index with file/line references
- hard-coded values and a constants-registry draft
- routes, optional REST/external calls, storage surfaces, security analysis, performance notes, test coverage, dependencies, and deployment notes

Regenerate it after meaningful code or README changes:

```bash
node scripts/generate-technical-reference.mjs
```

## Architecture And Data

- Package: `drivesense-app`
- Version: `1.0.0`
- Web stack: React 18, Vite 6, React Router, TanStack Query, Tailwind, Radix UI, Leaflet, Recharts, jsPDF, Vitest, ESLint
- Native stack: Capacitor 8 Android shell plus custom Java services/plugins for activity recognition, background tracking, phone usage evidence, native downloads, notifications, quick settings tile, and SharedPreferences storage
- Primary storage: IndexedDB, localStorage, sessionStorage, Capacitor Preferences, Android SharedPreferences, and native download files
- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories
- Optional external services: OpenStreetMap Overpass for speed limits, Open-Meteo for weather context, and user-configured OSRM for route snapping

## Privacy And Security Defaults

- Trips, vehicles, settings, diagnostics, and reports stay local by default.
- No ads, analytics, or automatic trip upload are implemented in this repository.
- OSRM route snapping is disabled until the user enables it and provides or confirms an endpoint.
- Automatic road/weather context fetch is off by default; manual Get Road Data prompts before sending route context to external services.
- Privacy zones mask route points and events around private places; backups do not restore private coordinates for privacy zones.
- Imported backups and settings are treated as untrusted input and sanitized before merge.
- Leaflet popup values from trips, routes, events, danger zones, privacy zones, and parked locations are escaped before rendering as HTML.

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

Check repository hygiene before pushing machine-specific files:

```bash
npm run check:repo-hygiene
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

`android/local.properties` is generated locally by Android tooling and contains your Android SDK path. Keep it untracked; `android/.gitignore` ignores it and CI fails if it is ever committed.

Android tracking needs Location, Background Location, Physical Activity, Notifications, and background tracking permissions. Disable or relax battery optimization for best background reliability.
