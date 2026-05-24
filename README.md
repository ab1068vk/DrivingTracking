# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and keeps trip history on the device unless an optional backend is configured.

## Current App Surface

- Dashboard, trip history, trip detail, live map, driving coach, insights, achievements, reports, diagnostics, settings, and vehicles pages.
- Manual trip capture, foreground auto-detect, and Android native background auto tracking with activity recognition, GPS fallback, quick settings tile support, pause/resume controls, and native trip import.
- Trip scoring for safety, smoothness, eco driving, phone-use distraction, speed compliance, road-type segments, braking-onset timing, cornering, braking efficiency, overtake quality, stop-start/following-pattern, fatigue, GPS-heading drowsy, slippery-condition, estimated close-proximity, and route-risk proxies.
- Map playback with route simplification, stop handling, privacy-masked coordinate handling, HTML-escaped Leaflet popups, speed-limit coloring, fatigue overlays, event markers, and repeated-route comparison support.
- Vehicle profiles with fuel/electric economy, odometer estimates, maintenance reminders, renewal tracking, localized per-car cost, CO2 estimate metadata, and engine-health summaries, default vehicle handling, and vehicle comparison.
- Reports with CSV export, monthly PDF export, UBI score-card PDF export gated until 50 km of evidence, confidence-aware rolling baseline comparison, carbon impact, configurable-currency fuel cost, and vehicle-backed CO2 savings estimates.
- Full backup export/import for trips, GPS route points, events, vehicles, settings, privacy-zone metadata, saved filters, and reviewed event feedback, with confirmation required before importing truncated notes.
- Diagnostics capture unhandled app errors, handled critical operation failures, and isolated React section crashes with sanitized messages and stack previews.

## GPS-Derived Safety Proxy Limits

Road Sage observes the ego vehicle GPS speed and heading stream unless separate device evidence is explicitly identified. It has no hazard-stimulus timestamp, forward-ranging sensor, lane camera/HD-lane geometry, or driver-monitoring sensor. The following values are behavioral proxies, not confirmations of human reaction time, following gap, near misses, lane position, or drowsiness.

| Current field or display | What is observed | Current behavior and limitation |
| --- | --- | --- |
| `reaction_*`; UI/CSV reaction wording | Time between a GPS speed-drop precursor and a harsh-brake event. | Reports after three usable braking events and contributes 10% of Smoothness; it is a low-confidence braking-onset proxy, not neurological reaction time. |
| `following_distance_score` / `tailgate_cycle` | Repeated cruise then deceleration/speed-drop cycles, starting from 40 km/h. | Null below 0.5 km and otherwise contributes 10% of Safety; it cannot measure following distance and may reflect ordinary traffic flow. |
| `close_proximity`; legacy `near_miss_*` aliases | Coincident braking and heading change above 40 km/h; defaults are 3.5 m/s2 and 30 deg/s. | Labelled estimated; direct Safety/Smoothness penalties are zero, while compatibility aliases still affect route/weather risk. It does not establish object proximity or a near miss. |
| `drowsy_risk_*` | GPS heading dispersion in highway-speed windows when advanced safety detection is enabled. | Curves and GPS noise can trigger the pattern; it is not a drowsiness diagnosis. |
| `lane_change`; event label `possible lane change` | Counter-steering GPS-heading shape above 50 km/h with context suppression. | It remains on the Safety scoring surface, but without lane sensing it is only a heading-deviation event. |

## Recent Update Coverage

The markdown is regenerated from the current source tree and reflects the latest vehicle-health, tracking, scoring, privacy, storage, and documentation behavior.

- Documentation was converted into a source-generated technical reference with module inventory, imports/exports, function catalogue, calculation snippets, constants, storage, routes, error handling, tests, dependencies, and deployment notes.
- Shared application policy now lives in `src/lib/appConstants.js`: fallback night and rush-hour boundaries are consistent across habit, predictive-route, pre-trip, trip-tagging, trip-engine fallback, settings defaults, and Android fixed-hour classification. Android evaluates the fixed 22:00-04:59 night window in the device local timezone, matching JavaScript `Date#getHours()` when native trips are later rescored. Legacy sunset-mode defaults migrate from 06:00 to the shared 05:00 end; deliberately custom night hours remain configurable. Saved UI preference keys and initial display limits are named in one place.
- Calculation-heavy UI is isolated with `SectionErrorBoundary`: TripMap, TripPlayback, the Trip Detail score summary, the Trip Detail page shell, and the Dashboard readiness/risk panel now show a friendly reloadable fallback and log the caught error instead of blanking the whole app.
- Critical post-trip and persistence operations now log handled failures through `logError`: completed-trip notifications, phone-use pattern alerts, style-shift alerts, achievement notification sync, daily fatigue warnings, vehicle odometer sync, and driver-signature saves all write diagnostic events instead of being silently swallowed.
- Vehicle odometer sync still retries on the next vehicle/trip refresh, and repeated failures in a session show a non-blocking toast so stale odometer estimates are visible without blocking the Vehicles page.
- Numeric clamping is centralized in `src/lib/mathUtils.js`; score, route-risk, fatigue, weather, report, playback, calibration, and import sanitization paths now share the same NaN-safe boundary behavior.
- Daily fatigue readiness now uses break-corrected active driving minutes instead of a hard 60-minute day total. The default onset is 90 active minutes, learned habit-profile onset is honored by dashboard and post-trip warnings, and breaks over 30 minutes reduce accumulated fatigue on a 180-minute recovery curve.
- Scoring was stabilized around explicit defaults: noisy-signal filtering, rate-normalized scoring, traffic-stop grace periods, privacy-masked coordinate exclusion, stable phone-use merges, finite anomaly/sensor scores, and reviewed-event rescoring.
- Jerk scoring now returns `null` with `jerk_score_confidence: insufficient_data` for trips under 0.5 km or without usable movement samples. The 20-point noise floor applies only below 3 km; longer trips can score down to 0, and insufficient jerk evidence is neutral in the smoothness composite.
- Intersection scoring now recognizes traffic stops from continuous sub-10 km/h samples spanning at least four seconds, labels them separately from extended stopped periods, and discards privacy-masked windows. Unobserved/under-0.5 km routes expose no intersection score; late approaches carry stronger penalties, and observed unsafe stops can score down to 0 without the former 40-point floor.
- The legacy following score now identifies a GPS stop-start/deceleration pattern rather than claiming measured vehicle gap: it excludes privacy-masked evidence, weights higher-speed patterns more strongly, normalizes penalties by total route distance, and is unavailable below 0.5 km. The compatibility name `following_distance_score` remains in storage and exports.
- The legacy `reaction_*` component is documented as braking-onset timing derived from GPS speed changes, not driver reaction time. It requires at least three usable harsh-braking samples before reporting, can reach 0, and stays neutral in Smoothness when evidence is insufficient.
- Cornering lateral-G detection now ignores speeds below 25 km/h, smooths heading from route geometry over three points, and requires sustained lateral-G over consecutive GPS samples before creating sharp-turn events.
- GPS heading-deviation detection emits `possible lane change` events with medium confidence, requires a straight approach above 50 km/h, and suppresses detections near tagged intersections, ramps, roundabouts, or stop-context windows. It cannot verify a lane change without lane sensing, although legacy `lane_change` fields remain score-visible.
- GPS-only near-miss wording has been replaced for new detections with estimated `close_proximity` alerts. A detection requires simultaneous braking and heading change above 40 km/h; direct Safety/Smoothness penalties are zero. Legacy `near_miss` aliases remain for compatibility and are still consumed by predictive-route and weather risk paths.
- Drowsy-risk output is a GPS heading-drift proxy evaluated only in sustained highway-speed windows while advanced safety detection is enabled. It has no eye, steering-torque, lane-marker, or IMU confirmation and must not be treated as a drowsiness diagnosis.
- Multi-trip score summaries use distance-weighted averages for weekly summaries, goals, route/day/vehicle/report comparisons, predictive route risk, PDF summaries, and dashboard rollups. The personal baseline is intentionally different: it appears only after 10 completed recent trips and uses exponential recency weighting with a displayed confidence interval.
- Braking-efficiency grades are contextual: urban and highway driving use separate thresholds, and the displayed grade identifies its context. Flat or altitude-insufficient routes store hill driving as not applicable rather than turning missing terrain evidence into a penalty.
- Score and component confidence metadata now governs coaching visibility. Score tips require at least 2 km and confidence of at least 0.5; insufficient evidence displays a not-enough-data message rather than behavior advice.
- Driver signatures now treat missing braking-efficiency evidence as unavailable rather than perfect. Braking style stays blank until at least three scored braking trips exist, `braking_confidence` increases with observed evidence, and Driving Coach labels low-confidence or unavailable braking data instead of charting false certainty.
- Trip-stat hot paths now avoid repeated route rescans: sunset night windows are cached once per trip date, erratic-speed windows maintain sliding summaries, event-to-point lookup is binary-search based, and road-type scores partition full-trip detected events rather than rerunning detection per type.
- Eco driving scoring now resolves missing or malformed tuning through named `ECO_DEFAULTS`, clamps impossible parked-idle ratios, penalizes sustained parked idle instead of unavoidable traffic-stop idle, reports invalid zero-multiplier configurations as unavailable rather than a fixed score, and blends remaining eco evidence into the trip score.
- Speed variability scoring now ignores stopped traffic samples, requires sufficient moving evidence, scores city and highway variability separately through `SVI_DEFAULTS`, distance-weights mixed routes, and omits unavailable SVI from coaching/report trend comparisons.
- Phone-use Safety impact messaging uses the exported `PHONE_USE_SAFETY_WEIGHT` scorer constant, and Android OS usage evidence is merged with overlapping micro-steering detections within 30 seconds so the same phone-use episode is not double-penalized.
- Predictive route risk sorts completed trips newest-first, excludes tiny-trip event-density distortion, normalizes all weighted components to 0-100, and clamps weather/baseline input before scoring. Its current event-density path still double-weights legacy `near_miss_count` values representing estimated close-proximity alerts. Route-risk index cells are coarser and merge nearby segment midpoints within 15 m to reduce GPS fragmentation.
- UBI reports require at least 50 km before generating a score, use actual distance in per-100-km rates, score time-of-day exposure by night driving minutes, reduce noisy GPS-derived cornering to a 5% weight, and use a bell curve centered around 10,000 km/year for mileage.
- Vehicle engine-health summaries now average only finite stored engine stress scores. Trips without a usable score are excluded, and vehicles with no scored samples show `N/A` instead of a misleading maximum-stress fallback.
- Predictive maintenance no longer treats trips without braking evidence as perfectly gentle braking. Brake stress is averaged only from observed braking-efficiency scores and remains unavailable until at least five completed trips include three scored braking samples; unavailable braking evidence is neutral when adjusting service intervals.
- Currency and economics baselines are configurable in Settings, including cost symbol, average vehicle CO2 per 100 km, EV kWh per 100 km, grid CO2 intensity, and tree-year equivalents. Vehicle fuel type is used for trip CO2 estimates; ICE economy below 3 L/100km is rejected and unusually high values receive a confirmation warning.
- Fuel and CO2 estimates now cap eco-driving consumption adjustment to +/-8%. Missing eco-driving evidence applies no adjustment, Trip Detail marks values as estimates with confidence bands, fuel/CO2 savings show unavailable until a vehicle is assigned, and EV CO2 savings remain unavailable unless grid CO2 intensity is configured.
- Backup import is hardened and versioned: v1-v5 backups migrate before merge, files over 50 MB are rejected before reading, records are sanitized, trip notes allow 10,000 characters, and any truncation reports the affected trip count and requires explicit user acknowledgement before import completes.
- Native-safe UI preferences now use the mobile storage layer for saved trip filters, dismissed tag suggestions, and first-launch permission prompting. Backup export/import reads and writes saved filters through that same layer on Android.
- Local trip storage uses IndexedDB when available, with a migration runner and localStorage fallback. Trip schema versioning triggers rescoring for completed trips when scoring, confidence, phone-use merge, corrected duration, map, or privacy behavior changes.
- API behavior is local-first by default. Trips and vehicles use local repositories when `VITE_API_URL` is absent or the app is running natively; configured backends fail clearly instead of silently falling back to localhost.
- Auth tokens are session-scoped. Legacy `localStorage` tokens are migrated into `sessionStorage` and removed, and logout clears both token names from browser storage.
- Open road context is explicit and privacy-aware. OpenStreetMap speed limits and Open-Meteo weather are manual by default unless automatic context fetch is enabled. OSRM route snapping is opt-in, disabled without a configured endpoint, the public demo requires confirmation, and the custom endpoint field warns that raw sampled GPS coordinate pairs are sent to the configured OSRM server.
- Trip Detail and Map no longer silently hide additional route-risk stretches or risk hotspots: initial lists remain compact, and show-all controls report hidden counts. Drowsy risk color and fatigue critical markers now follow actual levels and exported thresholds, and compliance bars use the canonical score color tiers.
- Settings now explains tracking, Android permissions, privacy, notifications, speed warnings, currency/economics, advanced models, and data controls with searchable sections and safer validation.
- Android tracking updates include immediate native notification state, quick settings tile sync, clearer off/paused handling, named notification identifiers, device-local fixed-hour night classification aligned to the shared 22:00-04:59 window, deduplicated trip/safety notifications, battery optimization guidance, phone usage access support, and native diagnostics surfaced in the app. Android Gradle setup now removes obsolete AGP flags and reapplies clean AGP 9-compatible plugin DSL patches after install or sync.
- Privacy-zone and map fixes keep private locations masked, allow radius editing, hide private events, exclude masked null coordinates from distance/playback math, HTML-escape user/external values in Leaflet popups, and preserve original GPS geometry when route snapping or old map-matching data would collapse playback.
- Calculation fixes keep map-matching confidence and snapped coverage numeric even when OSRM sends invalid confidence, omit invalid speed limits from popups, preserve Android `ON_BICYCLE` as `on_bicycle` while retaining legacy `cycling`, and make native platform checks module-level constants.
- Route risk and fatigue are more graduated: route-risk speed contribution scales above 100 km/h instead of using a binary bonus, fatigue is normalized on a 0-100 scale, and heatmaps use documented 30-second segments with a 20-segment minimum for display.
- Recorded trip duration now excludes long background tracking gaps in both JavaScript and Android native statistics. Map playback progress is timestamp-based, with index-based progress retained only as a fallback when timestamps are unavailable.
- Commute matching uses the named `COMMUTE_MATCH_RADIUS_M` 150 m threshold exposed in Advanced settings, while weekly coaching avoids duplicate metric advice and only comments on score changes larger than 3 points.
- Achievement notifications display up to six labels and keep every earned achievement ID in notification extras when a larger batch is condensed.
- CO2 savings are treated as vehicle-backed estimates rather than exact facts. Carbon reports recalculate savings with assigned vehicle context when available, label fleet-average comparisons with a wide confidence band, and avoid positive EV savings claims without known grid carbon intensity.
- Score rings now use the canonical `getScoreColor()` metadata, including SVG stroke colors, so score labels, fills, and circular rings share one color policy.
- Vehicle fuel/energy price validation now uses a currency-neutral 100-per-unit cap instead of a narrow 20-per-litre cap.
- Android native tracking constants now name the 120-second stats gap, 2-minute Usage Access lookback, sustained-turn heading threshold, TTS speech rate, and 30-minute terminal idle cap; the stats loop uses one explicit duration guard and an else branch for moving vs idle time.
- Test coverage now includes backend fallback, auth migration, backup schema migration and note truncation disclosure, settings import security, IndexedDB migrations, notifications, currency formatting, vehicle economy validation and empty-score handling, shared time-risk boundaries, native/JS local-time night classification agreement, scoring consistency, privacy zones, route risk, tracking diagnostics, deterministic and opt-in live external service contract tests, core page render smoke tests, Playwright browser smoke navigation, Android native trip-store instrumentation, and release-blocker regressions.
- CI runs stable unit/component, Playwright browser smoke, and Android emulator instrumentation checks on pushes and pull requests. Live Overpass, Open-Meteo, and OSRM checks are manual or weekly because they depend on public external services.
- Repository hygiene now blocks machine-local Android SDK files from the tracked tree: `android/local.properties` remains ignored, is excluded from generated technical-reference scans, and is checked in CI with `npm run check:repo-hygiene`.

## Documentation

The production technical reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is generated from the repository by `scripts/generate-technical-reference.mjs` and includes:

- source/module inventory, import/export map, and function/method catalogue
- actual calculation snippets for scoring, trip physics, playback, route risk, predictions, reports, imports/exports, and Android native tracking
- grouped calculation index with file/line references
- named constants, hard-coded values, and literal rationale for scoring and integration review
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
- OSRM route snapping is disabled until the user enables it and provides or confirms an endpoint; the custom endpoint input warns that raw sampled GPS coordinate pairs go to that server.
- Automatic road/weather context fetch is off by default; manual Get Road Data prompts before sending route context to external services.
- Privacy zones mask route points and events around private places; backups do not restore private coordinates for privacy zones.
- Imported backups and settings are treated as untrusted input, migrated from supported legacy schemas, sanitized before merge, and require confirmation before any note-truncating import completes.
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

Run browser smoke e2e tests:

```bash
npm run test:e2e
```

Run live external contract tests (hits Overpass, Open-Meteo, and OSRM):

```bash
npm run test:contracts:live
```

### Test Strategy

- `npm run test` runs deterministic Vitest coverage for calculations, repositories, security safeguards, page rendering, and mocked Overpass/Open-Meteo/OSRM request-response contracts. The live external-service file is skipped in this fast default suite.
- `npm run test:e2e` builds the app, starts a local preview server, and drives Chromium through core Dashboard, Settings, and Trips navigation flows.
- `npm run test:contracts:live` makes real network requests to Open-Meteo forecast, Overpass interpreter, and the public OSRM matching endpoint to detect upstream response-contract changes.
- Android instrumentation tests exercise native trip-store persistence and malformed-storage recovery; compile them with `android/gradlew.bat assembleDebugAndroidTest` and execute them on an emulator or device with `connectedDebugAndroidTest`.
- CI runs deterministic tests, browser smoke e2e, and Android instrumentation on an emulator for pushes and pull requests. Live external checks run weekly or by manual dispatch because public service availability is outside the app release boundary.

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
