# Road Sage

Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and keeps trip history on the device unless an optional backend is configured.

## Current App Surface

- Dashboard, trip history, trip detail, live map, driving coach, insights, achievements, reports, diagnostics, system logs, Privacy Intelligence, settings, and vehicles pages. The Android reference page is debug-only via development mode or `VITE_SHOW_DEBUG_ROUTES=true`.
- Manual trip capture, foreground auto-detect, and Android native background auto tracking with activity recognition, GPS fallback, quick settings tile support, pause/resume controls, and native trip import.
- Trip scoring for safety, GPS/OBD motion smoothness, eco driving estimates, confirmed Android Usage Access phone-use evidence, speed compliance with posted-or-inferred limit provenance, road-type segments, brake onset smoothness, cornering, braking efficiency, optional IMU-assisted lane-changing, contextual urban/highway stop-start patterns, fatigue exposure, heading drift Beta, source-attributed weather context, estimated brake-turn manoeuvre alerts, historical context signals, and diagnostic-only GPS phone/overtake pattern counts.
- Map playback with route simplification, stop handling, privacy-masked coordinate handling, HTML-escaped Leaflet popups, speed-limit coloring, fatigue overlays, event markers, repeated-route comparison support, persisted fallback map centers, last-parked context, and deployment-configurable default coordinates.
- Vehicle profiles with fuel/electric economy, odometer estimates, maintenance reminders, renewal tracking, localized per-car cost, CO2 estimate metadata, and engine-health summaries, default vehicle handling, and vehicle comparison.
- Reports with CSV export carrying metric provenance metadata, monthly and UBI PDF metric-reference pages, estimated-score notation, UBI score-card PDF export gated until 50 km of evidence and visibly marked not an insurance rating, confidence-aware rolling baseline comparison, carbon impact, configurable-currency estimated fuel cost, and vehicle-backed CO2/fuel savings estimates that stay unavailable without an assigned vehicle baseline.
- Full backup export/import for trips, GPS route points, events, vehicles, settings, privacy-zone metadata, saved filters, reviewed event feedback, fallback speed-limit provenance, and legacy heading-event migration, with confirmation required before importing truncated notes. Raw GPS route retention can be shortened separately from trip summaries.
- Diagnostics capture unhandled app errors, handled critical operation failures, isolated React section crashes, OBD/Web Bluetooth readiness, motion-sensor readiness, possible incident-signal readiness, and native sensor evidence with sanitized messages and stack previews; development builds can seed and remove local synthetic trips only behind the explicit synthetic-test-data guard.

## GPS-Derived Safety Proxy Limits

Road Sage observes the ego vehicle GPS speed and heading stream, optionally enriched by Android Usage Access, OBD-II Bluetooth, and device-motion samples when those permissions or adapters are available. It still has no hazard-stimulus timestamp, forward-ranging sensor, lane camera/HD-lane geometry, turn-signal state, or driver-monitoring sensor. The following values are behavioral proxies, not confirmations of human reaction time, following gap, near misses, lane position, phone distraction, overtaking safety, crashes, or physiological fatigue.

| Current field or display | What is observed | Current behavior and limitation |
| --- | --- | --- |
| `brake_onset_smoothness_*` | Ramp duration and peak GPS-derived deceleration during detected harsh braking. | Hidden until five sequences exist, is always low confidence, and contributes 10% of Smoothness. The UI disclaimer states it is not neurological reaction time. |
| `stop_start_pattern_*` | Repeated cruise then deceleration/speed-drop cycles in GPS speed data. | Contextual urban/highway estimates are hidden until enough evidence exists: 2 km city-speed evidence for urban mode or 5 km highway evidence for highway mode. It contributes 5% of Safety when present and cannot measure following distance. |
| `close_proximity` manoeuvre alert | At least 1.5 s of coincident braking and heading change at 30+ km/h; defaults are 4.0 m/s2 and 25 deg/s. | Always low confidence and advisory-only; excluded from Safety, weather score adjustment, historical-context risk weighting, repeated-event areas, and repeated-event route layers. It does not establish object proximity or a near miss. |
| `heading_drift_beta_*` | Sustained five-minute GPS heading-drift windows at highway speed. | Always low confidence, labelled Beta, and presented as a GPS-only attention pattern signal rather than a fatigue measurement; the 02:00-05:00 window increases proxy risk by 2.5x. |
| `heading_deviation` / Heading Event (Beta); `heading_deviation_legacy` | Counter-steering GPS-heading shape above 50 km/h with context suppression; migrated legacy lane-change records. | Collected as diagnostic evidence even when Advanced Safety scoring is off, and removed from Safety scoring because it cannot verify a lane change. Retired `lane_change` backups/local records migrate to `heading_deviation_legacy` and remain diagnostic only. |
| `lane_changing_score` / Lane Changing | Highway-speed GPS heading pattern plus calibrated IMU yaw when motion samples are available. | Requires at least 5 km and two detected manoeuvres, contributes a provisional 5% Safety blend weight when enabled, downweights GPS-only confidence, and cannot verify turn signals, lane markings, following gap, or slow-traffic lane changes. |
| `aggressive_overtake` / Overtake Pattern (Beta) | Straight-highway baseline, acceleration, and bilateral heading-return pattern in GPS speed/heading. | Diagnostic only, always Beta/low confidence, excluded from Safety, Aggression, route risk, coaching, achievements, and headline trip risk. It cannot prove a lane crossing or actual overtake from GPS alone. |
| `phone_proxy_*` / GPS phone-use proxy | Repetitive GPS heading oscillations at driving speed. | Diagnostic only. Requires at least six oscillations in 15 seconds and acceptable GPS accuracy; no phone-use score is shown unless Android Usage Access evidence is available. |
| `possible_crash` / Possible Incident Signal | Impact-like device-motion samples followed by low movement or still activity. | Emergency workflow cue only; unavailable without motion samples and never a crash diagnosis. |

## Recent Update Coverage

The markdown is regenerated from the current source tree and reflects the latest vehicle-health, tracking, scoring, privacy, storage, and documentation behavior.

- Documentation was converted into a source-generated technical reference with module inventory, imports/exports, function catalogue, calculation snippets, constants, storage, routes, error handling, tests, dependencies, and deployment notes.
- Shared application policy now lives in `src/lib/appConstants.js`: fallback night and rush-hour boundaries are consistent across habit, predictive-route, pre-trip, trip-tagging, trip-engine fallback, settings defaults, and Android fixed-hour classification. Android evaluates the fixed 22:00-04:59 night window in the device local timezone, matching JavaScript `Date#getHours()` when native trips are later rescored. Legacy sunset-mode defaults migrate from 06:00 to the shared 05:00 end; deliberately custom night hours remain configurable. Saved UI preference keys, initial display limits, and provisional base-score and fatigue-to-Safety penalty scales are named in one place.
- Calculation-heavy UI is isolated with `SectionErrorBoundary`: TripMap, TripPlayback, the Trip Detail score summary, the Trip Detail page shell, and the Dashboard readiness/context panel now show a friendly reloadable fallback and log the caught error instead of blanking the whole app.
- Critical post-trip and persistence operations now log handled failures through `logError`: completed-trip notifications, confirmed phone-use alerts, style-shift alerts, achievement notification sync, daily fatigue warnings, vehicle odometer sync, and driver-signature saves all write diagnostic events instead of being silently swallowed.
- Vehicle odometer sync still retries on the next vehicle/trip refresh, and repeated failures in a session show a non-blocking toast so stale odometer estimates are visible without blocking the Vehicles page.
- Numeric clamping is centralized in `src/lib/mathUtils.js`; score, historical-context risk, repeated-event route layers, fatigue, weather, report, playback, calibration, and import sanitization paths now share the same NaN-safe boundary behavior.
- Daily fatigue readiness now uses break-corrected active driving minutes instead of a hard 60-minute day total. The default onset is 90 active minutes, learned habit-profile onset is honored by dashboard and post-trip warnings, and breaks over 30 minutes reduce accumulated fatigue on a 180-minute recovery curve.
- Scoring was stabilized around explicit defaults: noisy-signal filtering, rate-normalized scoring, traffic-stop grace periods, privacy-masked coordinate exclusion, Android phone-use source gating, diagnostic proxy separation, finite anomaly/sensor scores, reviewed-event rescoring, and weighted evidence blends that omit unavailable components instead of filling them with 100.
- Score display is centralized in `src/lib/scoreDisplay.js`: approximate score surfaces use a leading `~`, monthly PDFs state that scores are estimates not validated against crash data, and UBI score-card UI/PDF output is visibly labelled `NOT AN INSURANCE RATING`.
- Scoring and calibration policy is centralized in `src/lib/scoringConstants.js`: provisional thresholds, blends, risk assumptions, UBI assumptions, and `PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS` declare affected metrics, labeled-dataset requirements, fitting steps, and promotion criteria. New score records carry a generated content-hash `SCORING_VERSION`, `component_scores` evidence envelopes, and `score_provenance`; Trip Detail and Settings expose provenance and approximate calibration status instead of presenting provisional output as validated.
- Trip Detail includes a dismissible post-trip calibration survey for optional 1-5 drive ratings, score-accuracy feedback, driver/passenger confirmation, difficulty, and context tags. Feedback stays local in this local-only app, is preserved in backups, appears in System Logs, and is used by Settings as a calibration signal; it does not upload anywhere, automatically change scores, or automatically tune thresholds. Passenger, short, low-quality GPS, heavily privacy-masked, test/debug, incomplete, or crash-recovered trips are excluded from calibration.
- Base score penalty normalization now uses named `PENALTY_SCALE_FACTOR = 40`: under the current provisional calibration, 2.5 severity-weighted penalty points per km reaches the score floor. This factor must be recalibrated against a labeled driving dataset before being treated as validated.
- Fatigue contribution to Safety now uses named `FATIGUE_SAFETY_PENALTY_SCALE = 0.15` and `FATIGUE_SAFETY_MAX_PENALTY = 15`: maximum normalized fatigue adds a capped 15-point Safety deduction after event-rate normalization. This cited coefficient maps the maximum fatigue proxy to a conservative 0.05% BAC-equivalent impairment assumption from Williamson & Feyer (Occupational and Environmental Medicine, 2000); it is not crash-outcome calibrated.
- Optional OBD-II Bluetooth support parses RPM, throttle, engine load, vehicle speed, coolant temperature, and mass-air-flow PID responses. OBD speed can replace weak GPS speed for calculations, OBD RPM/throttle refine eco and engine-stress evidence, and score provenance displays `OBD-II Bluetooth` as a source when those samples are present.
- Sensor fusion now records browser or Android native motion samples, summarizes IMU quality, calibrates phone orientation from harsh-brake evidence, enriches event confirmation, and supports possible incident signals. Diagnostics exposes motion permission/readiness; possible incident signals are not crash diagnoses.
- Lane-changing scoring is now a first-class provisional metric. It uses calibrated IMU yaw with GPS validation when available, falls back to lower-confidence GPS heading at highway speed, requires 5 km and two manoeuvres before scoring, and can be disabled in Detection Features. It is limited to a provisional 5% Safety blend weight.
- Jerk scoring now returns `null` with `jerk_score_confidence: insufficient_data` for trips under 0.5 km or without usable movement samples. Trips from 0.5 km to under 3 km keep the real 0-100 jerk score with low confidence, and low-confidence jerk evidence is suppressed from Smoothness blending.
- Intersection scoring now recognizes traffic stops from continuous sub-10 km/h samples spanning at least four seconds, labels them separately from extended stopped periods, and discards privacy-masked windows. Unobserved/under-0.5 km routes expose no intersection score, and Overall score renormalizes the remaining observed components instead of awarding a perfect intersection score.
- `stop_start_pattern_score` replaces following-distance claims for new scored trips. It is low confidence, blends contextual urban/highway estimates when evidence exists, is hidden below 2 km of city-speed evidence or 5 km of highway evidence, contributes 5% of Safety only when present, and is the only Defensive proxy in that slot because GPS speed cannot measure vehicle gap.
- `brake_onset_smoothness_*` replaces public reaction-time output in the UI and CSV. It uses peak deceleration divided by ramp duration, requires five detected braking sequences, is always low confidence, and is hidden until evidence exists. The UI disclaimer states that it is not neurological reaction time.
- Cornering lateral-G detection now ignores speeds below 25 km/h, smooths heading from route geometry over three points, and requires sustained lateral-G over consecutive GPS samples before creating sharp-turn events.
- GPS heading-deviation detection emits low-confidence `heading_deviation` / Heading Event (Beta) records as diagnostic evidence even when Advanced Safety scoring is off. It requires a straight approach above 50 km/h, suppresses common context windows, and no longer affects Safety scoring.
- Estimated brake-turn manoeuvre alerts require at least 1.5 seconds of concurrent braking and heading change at 30+ km/h with default thresholds of 4.0 m/s2 and 25 deg/s. They remain low-confidence advisory signals and are excluded from Safety, weather score adjustment, historical-context risk weighting, repeated-event areas, and repeated-event route layers.
- Heading drift Beta evaluates GPS-only drift patterns over sustained five-minute highway-speed windows, remains low confidence, and applies circadian weighting between 02:00 and 05:00. Public wording presents it as an attention pattern signal rather than a fatigue measurement, and it no longer feeds the trip fatigue Safety penalty.
- Monthly PDF exports include estimated-score and GPS-only proxy limitations alongside Safety and Smoothness results; GPS phone, heading-event, and overtake patterns are described as diagnostics only, while Heading Drift Beta is shown only when advanced detection was enabled for the rescored trip. The central metric registry now supplies evidence/source/calibration metadata to CSV exports and metric-reference pages in monthly and UBI PDFs.
- Multi-trip score summaries use distance-weighted averages for weekly summaries, goals, route/day/vehicle/report comparisons, historical context estimates, PDF summaries, and dashboard rollups. The personal baseline is intentionally different: it appears only after 10 completed recent trips and uses exponential recency weighting with a displayed confidence interval. Personal percentile is labelled as percentile among your recorded weeks and is hidden until at least four recorded weeks exist.
- Braking-efficiency grades are contextual: urban and highway driving use separate thresholds, and the displayed grade identifies its context. Hill control now names its provisional GPS/altitude-derived threshold and rate penalty assumptions (`2.5 m/s2` and `8` points per inferred infraction per hill-driving km), stores flat or altitude-insufficient routes as not applicable, and displays its GPS-only limitation in Trip Detail.
- Score confidence is evidence-aware rather than distance-only. Safety, Smoothness, Eco, and Distraction still store internal `high`, `developing`, `low`, or `unavailable` evidence based on contributing signals; the UI renders `developing` as "limited evidence", hides redundant `high evidence` badges, and repeats badges only for low or unavailable component evidence. Unavailable phone-use or intersection evidence prevents a long trip from appearing fully evidenced, and coaching remains suppressed when overall evidence is low.
- Driver signatures now treat missing braking-efficiency evidence as unavailable rather than perfect. Braking style stays blank until at least three scored braking trips exist, `braking_confidence` increases with observed evidence, speed-tolerance uses actual speeding-event rate rather than average route speed, and Driving Coach labels low-confidence or unavailable braking data instead of charting false certainty.
- Trip-stat hot paths now avoid repeated route rescans: sunset night windows are cached once per trip date, erratic-speed windows maintain sliding summaries, event-to-point lookup is binary-search based, and road-type scores partition full-trip detected events rather than rerunning detection per type.
- Eco driving scoring now resolves missing or malformed tuning through named `ECO_DEFAULTS`, clamps impossible parked-idle ratios, penalizes sustained parked idle instead of unavoidable traffic-stop idle, reports invalid zero-multiplier configurations as unavailable rather than a fixed score, blocks Settings changes that would disable both eco multipliers, and blends remaining eco evidence into the trip score.
- Speed variability scoring now ignores stopped traffic samples, requires sufficient moving evidence, scores city and highway variability separately through `SVI_DEFAULTS`, distance-weights mixed routes, and omits unavailable SVI from coaching/report trend comparisons.
- Phone-use scoring now requires Android Usage Access evidence. Confirmed phone use is weighted as a major Safety signal, with stronger low/medium/high Usage Access deductions and centralized trip-summary helpers for user-facing phone-use totals. Without Usage Access, `phone_use_score` is unavailable, Trip Card and Trip Detail show a permission-required state, and the UI asks for permission instead of showing a proxy score. GPS micro-steering detections are stored as `phone_proxy_*` diagnostics only, require at least six oscillations in a 15-second window with acceptable GPS accuracy, and do not affect Safety, coaching, live warnings, route risk, or ordinary trip-event lists.
- Overtake detection is marked Beta and diagnostic-only. It now requires at least 1 km of prior straight highway driving above 80 km/h, a minimum 3.0 m/s2 acceleration threshold, and a bilateral out-and-back heading signature within 15 seconds. Overtake quality/counts are exported and displayed as diagnostics but excluded from Safety, Aggression, route risk, coaching, achievements, and UBI-style scoring.
- Historical context wording replaces route-prediction/risk wording unless a real planned route is supplied. It requires observed completed-trip distance and a scored-distance baseline; without either, the dashboard shows Not enough driving history / Not enough scored driving history and no context number. Once evidence exists, it sorts completed trips newest-first, excludes unscored trips and tiny-trip event-density distortion, normalizes all weighted components to 0-100, and clamps available weather/baseline input before scoring. Its named saturation assumptions remain provisional: five eligible verified driving events per km or five nearby repeated driving-event areas each saturate their respective signal without a collision-outcome calibration claim. Low-confidence proxy events such as current brake-turn alerts and ambiguous legacy `near_miss` counts are excluded from context weighting. The dashboard labels the value as estimated and exposes weighted signal contributions. Repeated-event route index cells are coarser, merge nearby segment midpoints within 15 m to reduce GPS fragmentation, and exclude proxy events.
- UBI reports require at least 50 km before generating a score, use actual distance in per-100-km rates, score time-of-day exposure by night driving minutes, reduce noisy GPS-derived cornering to a 5% weight, and use configurable mileage assumptions that default to an optimal 10,000 km/year with an 8,000 km spread. The named night-exposure and category-rate penalty constants remain internal, uncalibrated approximations rather than insurer-validated rates; the score-card UI/PDF now presents that limitation and states that it is not an insurance rating alongside any displayed score.
- Vehicle engine-health summaries now average only finite stored engine stress scores. Trips without a usable score are excluded, and vehicles with no scored samples show `N/A` instead of a misleading maximum-stress fallback.
- Predictive maintenance no longer treats trips without braking evidence as perfectly gentle braking. Brake stress is averaged only from observed braking-efficiency scores and remains unavailable until at least five completed trips include three scored braking samples; unavailable braking evidence is neutral when adjusting service intervals. Tire-wear events without recorded speed use a neutral factor and are flagged in maintenance and vehicle health summaries rather than silently treated as fully measured.
- Currency and economics baselines are configurable in Settings, including cost symbol, average vehicle CO2 per 100 km, EV kWh per 100 km, grid CO2 intensity, and tree-year equivalents. Vehicle fuel type is used for trip CO2 estimates; ICE economy below 3 L/100km is rejected and unusually high values receive a confirmation warning.
- Fuel and CO2 estimates now cap eco-driving consumption adjustment to +/-8%. Missing eco-driving evidence applies no adjustment, Trip Detail marks values as estimates with confidence bands, fuel/CO2 savings show unavailable until a vehicle is assigned, and EV CO2 savings remain unavailable unless grid CO2 intensity is configured.
- Backup import is hardened and versioned: v1-v9 backups migrate before merge, retired `lane_change` events become diagnostic `heading_deviation_legacy` events, local calibration survey labels are preserved in full backups, deterministic privacy-zone cell hashes are omitted from exports, v9 exports include coordinate-free privacy-zone commitments, files over 50 MB are rejected before reading, records are sanitized, trip notes allow 10,000 characters, and any truncation reports the affected trip count and requires explicit user acknowledgement before import completes.
- Native-safe UI preferences now use the mobile storage layer for saved trip filters, dismissed tag suggestions, and first-launch permission prompting. Backup export/import reads and writes saved filters through that same layer on Android.
- Local trip storage uses IndexedDB when available, with a migration runner and localStorage fallback. `VITE_DB_NAME` can rename the local database with a copy/count-verify/delete migration. Legacy/schema-upgrade refreshes populate current component evidence and score provenance; Settings identifies current scoring-input/version mismatches, auto-re-scores recent trips when more than 20% of the 28-day window is stale, and lets the user deliberately queue affected completed trips for re-score.
- API behavior is local-first by default. Trips and vehicles use local repositories when `VITE_API_URL` is absent or the app is running natively; configured backends fail clearly instead of silently falling back to localhost.
- Auth tokens are session-scoped. Legacy `localStorage` tokens are migrated into `sessionStorage` and removed, and logout clears both token names from browser storage.
- Open road context is explicit and privacy-aware. OpenStreetMap speed limits and Open-Meteo weather are manual by default unless automatic context fetch is enabled. When weather is disabled, unavailable, privacy-skipped, or has no matching hourly sample, the app stores weather risk as null with source attribution and displays it as unavailable instead of defaulting to low risk; GPS stopping-distance context can be shown separately as a weather-context fallback. When a posted map speed limit is absent, Settings can choose Global, Canada, United States, United Kingdom, Germany, Australia, or France approximate road-type defaults, with the chosen fallback provenance preserved in reports, backups, Trip Detail, and context metadata. OSRM route snapping requires a trusted custom endpoint, explicit raw-coordinate data-sharing consent, endpoint health metadata, and a manual Get Road Data action; the public demo endpoint is rejected for saved settings.
- Trip Detail and Map no longer silently hide additional repeated-event route stretches or repeated driving-event areas: initial lists remain compact, and show-all controls report hidden counts. Trip Detail separates scored driving events from diagnostic-only events, shows feedback-adjusted event counts, shows inferred speed-limit scoring notes, and displays a Usage Access banner when phone-use evidence is unavailable. Heading drift Beta color and fatigue critical markers now follow actual levels and exported thresholds, and compliance bars use the canonical score color tiers.
- Settings now explains tracking, Android permissions, privacy, notifications, speed warnings, detection features, currency/economics, advanced models, and data controls with searchable sections, safer validation, OSRM endpoint health checks, OBD connection actions, motion-sensor permission actions, app lock, screen-capture protection, raw GPS retention controls, and rescore progress.
- Android tracking updates include immediate native notification state, quick settings tile sync, clearer off/paused handling, named notification identifiers, device-local fixed-hour night classification aligned to the shared 22:00-04:59 window, deduplicated trip/safety notifications, battery optimization guidance, phone usage access support, native IMU motion samples capped at 5,000 per trip, and native diagnostics surfaced in the app. Android Gradle setup now removes obsolete AGP flags and reapplies clean AGP 9-compatible plugin DSL patches after install or sync.
- Privacy-zone and map fixes keep private locations masked, allow radius editing, hide private events, exclude masked null coordinates from distance/playback math, HTML-escape user/external values in Leaflet popups, and preserve original GPS geometry when route snapping or old map-matching data would collapse playback.
- Calculation fixes keep map-matching confidence and snapped coverage numeric even when OSRM sends invalid confidence, omit invalid speed limits from popups, preserve Android `ON_BICYCLE` as `on_bicycle` while retaining legacy `cycling`, and make native platform checks module-level constants.
- Repeated-event route layers and fatigue are more graduated: repeated-route speed contribution scales above 100 km/h instead of using a binary bonus, and route segment event-rate weights are now named internal approximations (`20` for any observed event and an additional `40` for a harsh classification), not collision-outcome calibrated coefficients. Fatigue is normalized on a 0-100 scale, its Safety conversion is explicitly provisional, and heatmaps use documented 30-second segments with a 20-segment minimum for display.
- Recorded trip duration now excludes long background tracking gaps in both JavaScript and Android native statistics. Map playback progress is timestamp-based, with index-based progress retained only as a fallback when timestamps are unavailable. Empty playback maps no longer default to London; they use last map center, last parked location, privacy-zone context, device location, or deployment-configured coordinates.
- Commute matching uses the named `COMMUTE_MATCH_RADIUS_M` 225 m threshold exposed in Advanced settings. Weekly coaching is a local rules-based summary, stays unavailable without valid scored distance, avoids duplicate metric advice, and only comments on score changes larger than 3 points. Best-window coaching requires at least three trips in a time bucket and shows the sample size.
- Achievement notifications display up to six labels and keep every earned achievement ID in notification extras when a larger batch is condensed.
- CO2 and fuel savings are treated as vehicle-backed estimates rather than exact facts. Carbon reports and achievements recalculate savings through the same assigned-vehicle economics source, label comparisons with confidence bands, show unavailable without assigned vehicle context, and avoid positive EV savings claims without known grid carbon intensity.
- Score rings and aggregate score surfaces now use canonical score color and estimated-score formatting policy, including SVG stroke colors and score provenance, so score labels, fills, circular rings, reports, notifications, vehicle comparisons, maps, insights, and coaching surfaces share one display contract. They render developing internal evidence as "limited evidence" and omit high-evidence labels to reduce repetitive confidence copy.
- Vehicle fuel/energy price validation now uses a currency-neutral 100-per-unit cap instead of a narrow 20-per-litre cap.
- Android native tracking constants now name the 120-second stats gap, sustained-turn heading threshold, TTS speech rate, and 30-minute terminal idle cap; live Usage Access checks query from the active trip window so ongoing foreground app use is not missed. The stats loop uses one explicit duration guard and an else branch for moving vs idle time.
- Test coverage now includes backend fallback, auth migration, backup schema migration and note truncation disclosure, settings import security, IndexedDB rename/provenance migrations, notifications, currency formatting, vehicle economy validation and empty-score handling, generated scoring-version checks, score-provenance and metric-registry behavior, human-verified scoring golden fixtures, local synthetic test-trip fixtures, OBD parsing, sensor fusion, lane-change scoring, shared JavaScript/Android trip-stat and noise-floor parity, shared time-risk boundaries, native/JS local-time night classification agreement, scoring consistency, privacy zones, route risk, tracking diagnostics, deterministic and opt-in live external service contract tests, core page render smoke tests, Playwright browser smoke navigation, Android native trip-store instrumentation, and release-blocker regressions.
- CI runs stable unit/component, Playwright browser smoke, and Android emulator instrumentation checks on pushes and pull requests. Live Overpass, Open-Meteo, and OSRM checks are manual or weekly because they depend on public external services.
- Repository hygiene now blocks machine-local Android SDK files from the tracked tree: `android/local.properties` remains ignored, is excluded from generated technical-reference scans, and is checked in CI with `npm run check:repo-hygiene`.

## Documentation

The production technical reference is [docs/TECHNICAL_REFERENCE.md](docs/TECHNICAL_REFERENCE.md). It is generated from the repository by `scripts/generate-technical-reference.mjs` and includes:

- source/module inventory, import/export map, and function/method catalogue
- actual calculation snippets for scoring, trip physics, playback, route risk, predictions, reports, imports/exports, and Android native tracking
- grouped calculation index with file/line references
- named constants, hard-coded values, and literal rationale for scoring and integration review
- routes, optional REST/external calls, storage surfaces, security analysis, performance notes, test coverage, dependencies, and deployment notes

Other project documentation lives in [docs/](docs/):

- [Privacy Intelligence](docs/PRIVACY_INTELLIGENCE.md) covers the privacy dashboard, score model, protection checks, transmission logging, audit chain, storage/encryption behavior, test gaps, and release-readiness limits.
- [Speed and fallback behavior](docs/speed-and-fallbacks.md) covers speed capture, limit inference, OpenStreetMap enrichment, and live voice alerts.
- [Recovery plan](docs/RECOVERY_PLAN.md), [upgrade verification](docs/UPGRADE_VERIFICATION.md), and [version code 2 verification](docs/VERSION_CODE_2_VERIFICATION.md) record Android in-place upgrade safety work.

Regenerate it after meaningful code or README changes:

```bash
node scripts/generate-technical-reference.mjs
```

## Architecture And Data

- Package: `drivesense-app`
- Version: `1.0.0`
- Web stack: React 18, Vite 6, React Router, TanStack Query, Tailwind, Radix UI, Leaflet, Recharts, jsPDF, Vitest, ESLint
- Native stack: Capacitor 8 Android shell plus custom Java services/plugins for activity recognition, background tracking, phone usage evidence, native IMU motion sampling, native downloads, notifications, quick settings tile, and SharedPreferences storage
- Optional device evidence: Android Usage Access for confirmed phone use, Web Bluetooth OBD-II for speed/RPM/throttle/engine-load evidence where available, and browser/native motion sensors for IMU summaries, lane-changing confidence, and possible incident signals.
- Primary storage: IndexedDB, localStorage, sessionStorage, Capacitor Preferences, Android SharedPreferences, native motion samples on trips, and native download files
- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories
- Local trip database: set `VITE_DB_NAME` to override the IndexedDB name. The default is `drivesense_mobile`; when the configured name changes, startup copies trips from the previously recorded database name and then removes the old database after count verification.
- Optional external services: OpenStreetMap Overpass for speed limits, Open-Meteo for weather context, and trusted user-configured OSRM for route snapping after explicit consent. Set `VITE_OSRM_TIMEOUT_MS` to tune the build default OSRM timeout; users can override it in Settings from 5 to 30 seconds.

## Privacy And Security Defaults

- Trips, vehicles, settings, diagnostics, privacy intelligence records, system logs, and reports stay local by default.
- Android can require device authentication for app entry, blocks screen capture by default unless the user allows it, and re-locks after the app returns from the background for more than five minutes.
- No ads are implemented. Calibration-label sharing is opt-in only; without that setting, survey feedback stays local and raw GPS, exact addresses, route polylines, personal identifiers, and trip notes are never included in calibration payloads.
- OSRM route snapping is disabled until the user saves a trusted endpoint, consents to raw sampled GPS coordinate sharing, and requests road data. The public demo endpoint is rejected for saved settings.
- Automatic road/weather context fetch is off by default; manual Get Road Data prompts before sending route context to external services.
- Privacy zones mask route points and events around private places; backups do not restore private coordinates for privacy zones, and secure-device guards can block adding new zones on compromised Android/debug setups.
- Raw GPS retention can be reduced independently from trip history; expired route points are removed while trip summaries, scores, distance, and duration remain.
- Imported backups and settings are treated as untrusted input, migrated from supported legacy schemas, sanitized before merge, and require confirmation before any note-truncating import completes.
- Leaflet popup values from trips, routes, events, repeated driving-event areas, privacy zones, and parked locations are escaped before rendering as HTML.

## Local Setup

Optional environment configuration is documented in `.env.example`; local-first defaults work without a `.env` file.

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

`npm run build` regenerates `src/lib/scoringVersion.generated.js`; `npm run test` checks that the generated scoring version matches the scoring constants before running Vitest.

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
