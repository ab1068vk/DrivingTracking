# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Road Sage (package name `drivesense-app`) is a local-first driving tracker: React 18 + Vite web app packaged with Capacitor 8 into an Android app, backed by custom Java native services (background tracking, activity recognition, phone-usage evidence, IMU sampling, notifications, quick-settings tile, SharedPreferences storage). It records trips, scores driving behavior, maps routes, and generates reports, keeping data on-device unless an optional backend is configured.

Read `docs/PROJECT_README.md` first for the full current feature surface, GPS-derived-safety-proxy limitation table, and privacy/security defaults — it is kept up to date and is more authoritative than any summary here. `docs/TECHNICAL_REFERENCE.md` is a large generated file (source inventory, calculation snippets, routes, dependencies); don't read it in full, grep it for specific symbols instead. Regenerate both with `node scripts/generate-technical-reference.mjs` after meaningful source changes.

## Commands

```bash
npm install
npm run dev                    # Vite dev server

npm run build                  # prebuild runs recovery:guard + scoring:version, then vite build
npm test                       # vitest run --pool=forks --maxWorkers=1 (pretest verifies scoring version)
npx vitest run path/to/file.test.js            # run a single test file
npx vitest run -t "test name"                  # run a single test by name

npm run lint                   # eslint . --quiet
npm run lint:fix
npm run typecheck              # tsc -p ./jsconfig.json (checkJs-based, no emit)

npm run test:e2e               # builds, then runs Playwright against the preview server
npx playwright test e2e/app-smoke.spec.js      # run a single e2e spec

npm run test:contracts:live    # hits real Overpass/Open-Meteo/OSRM — manual/weekly only, not in fast loop

npm run check:repo-hygiene     # blocks machine-local Android files (e.g. android/local.properties) from being tracked
npm run check:cert-pins        # Android TLS pin renewal window check
npm run recovery:guard         # enforces Android package identity / upgrade-safety invariants (see below)
npm run scoring:version        # regenerates src/lib/scoringVersion.generated.js from scoringConstants.js
npm run scoring:version:check  # verifies the generated version matches (run automatically by pretest)

npm run android:sync           # build + npx cap sync android + reapply Gradle patch
npm run android:open           # open the Android project in Android Studio
```

Android debug build (from `android/`): `.\gradlew.bat assembleDebug`. Android instrumentation tests: `android/gradlew.bat assembleDebugAndroidTest`, run with `connectedDebugAndroidTest` on an emulator/device.

`android/local.properties` is machine-generated and must stay untracked (enforced by `check:repo-hygiene` and CI).

## Architecture

**Local-first data.** `src/api/trips.js` hardcodes `shouldUseLocalStore = () => true` — trip records (which can contain precise GPS traces) always go through `localTripRepository` (IndexedDB via `src/lib/mobileStorage.js` / `localTripRepository.js`), never a remote API, even when `VITE_API_URL` is configured for other resources. `src/api/client.js` is a thin fetch wrapper used only for non-trip, backend-optional resources; it throws if `VITE_API_URL` is unset rather than silently falling back to localhost. Auth tokens live in `sessionStorage` only (not `localStorage`), so an XSS can't lift a long-lived credential.

**Path alias.** `@/` maps to `src/` (see `vite.config.js` and `jsconfig.json`). Use it instead of relative `../../..` paths.

**Scoring pipeline is centralized and versioned.** `src/lib/scoringConstants.js` holds every provisional threshold/blend/risk-weight constant, each documented with its calibration status. `src/lib/scoring/scoreExplainer.js` and `src/lib/tripEngine.js` are the calculation core. `scripts/generate-scoring-version.mjs` derives a content hash (`SCORING_VERSION`) from the constants into `src/lib/scoringVersion.generated.js`; the build and test pipelines fail closed if that generated file is stale (`recovery:guard`/`scoring:version:check`), so **always run `npm run scoring:version` after editing `scoringConstants.js`** rather than hand-editing the generated file. Score display formatting (the `~` approximate-score prefix, evidence-level labels, color tiers) is centralized in `src/lib/scoreDisplay.js` — don't reimplement score formatting in components.

**Numeric safety.** Clamping/NaN-safe math is centralized in `src/lib/mathUtils.js` and shared across scoring, fatigue, weather, reports, playback, calibration, and import sanitization — use it rather than ad hoc `Math.max/min` when touching those paths.

**Shared policy constants.** `src/lib/appConstants.js` holds cross-cutting policy (night/rush-hour boundaries, storage keys, provisional base-score/fatigue-penalty scales) shared between the JS app and Android's native scoring so both sides agree, e.g. on the fixed 22:00–04:59 night window.

**Error handling conventions.** Calculation-heavy UI sections (TripMap, TripPlayback, Trip Detail score summary/page shell, Dashboard readiness panel) are wrapped in `SectionErrorBoundary` so a crash in one section doesn't blank the whole app. Critical post-trip/persistence operations (notifications, phone-use alerts, achievement sync, odometer sync, signature saves) log through `logError`/`src/lib/systemLog.js` instead of failing silently — follow this pattern for new critical-path code rather than swallowing errors.

**Native bridge (Android).** Custom Capacitor plugins and services live in `android/app/src/main/java/com/drivesense/app/`. JS-side counterparts live in `src/lib/driveSenseNativePlugin.js`, `activityRecognition.js`, `nativePlatform.js` (has `isAndroid()`), and related `native*.js` files. `src/lib/nativePlatform.js` constants are module-level so platform checks aren't recomputed per call.

**Android upgrade-safety guardrails.** `scripts/check-recovery-contract.mjs` (run via `npm run recovery:guard`, part of `prebuild`) asserts the Capacitor `appId`, Gradle `namespace`/`applicationId` stay `com.drivesense.app` and enforces `versionCode` invariants — changing the Android package identity breaks in-place upgrades and is guarded deliberately. See `docs/RECOVERY_PLAN.md` before touching package identity, backup format, or settings migration.

**Privacy/security-sensitive code paths** (treat changes here carefully and check `docs/PRIVACY_INTELLIGENCE.md`):
- `src/lib/privacyZones.js`, `privacyMode.js`, `privateTripMode.js` — mask routes/events near private places; backups never restore private coordinates.
- `src/lib/mapPopupHtml.js` / Leaflet popup rendering — user/external values must stay HTML-escaped.
- `src/lib/dataBackup.js` + `dataBackupConstants.js` — versioned backup migration (v1–v9), treats imported data as untrusted, requires explicit confirmation before any note-truncating import.
- `src/lib/osrmPrivacy.js`, `roadContextQueue.js` — OSRM route snapping requires a trusted user-configured endpoint (public demo endpoint rejected) plus explicit consent; automatic weather/road context fetch is off by default.
- `src/lib/screenSecurity.js`, `biometricGate.js`, `rasp.js` — Android app-lock, screen-capture blocking, integrity checks.
- `scripts/check-certificate-pins.mjs` — Android TLS pin renewal cadence (`docs/CERTIFICATE_PIN_RENEWAL.md`).

**Test layout:**
- Unit/component tests: colocated `__tests__/` folders under `src/components/`, `src/pages/`, `src/api/`, `src/lib/`, plus `src/lib/__tests__/` and `src/tests/`. Fixtures in `src/lib/__fixtures__/`. Run with Vitest (`--pool=forks --maxWorkers=1` — respect this when adding tests that share module-level state).
- `src/lib/__tests__` includes deterministic *mocked* Overpass/Open-Meteo/OSRM contract tests; the *live* network version (`scripts/run-live-contracts.mjs`) is excluded from the default `npm test` run and only runs via `test:contracts:live` or CI's weekly/manual schedule.
- Playwright specs in `e2e/` run against a built + previewed app (`playwright.config.js`), covering Dashboard/Settings/Trips navigation smoke.
- Android instrumentation tests live under `android/app/src/androidTest/`.
- `npm run generate-scoring-version -- --check`-style golden/parity tests exist for JS/Android scoring consistency (night-window classification, trip-stat math) — when changing scoring constants shared with Android, check both sides agree.

**Lint scope.** `eslint.config.js` applies React-specific rules only to `src/components/**`, `src/pages/**`, and `src/Layout.jsx` (explicitly excluding `src/lib/**` and `src/components/ui/**`); `src/lib/**` gets only the base `no-dupe-keys` rule. `unused-imports/no-unused-imports` is an error; prefix intentionally-unused vars with `_`.

**Typecheck scope.** `jsconfig.json` only type-checks `src/App.jsx`, `src/main.jsx`, `src/components/**/*.{js,jsx}`, and `src/pages/**/*.jsx` (excludes `src/components/ui`, tests, fixtures). `checkJs` is off globally, so this is opt-in via the `include` list, not automatic per-file.

**Documentation policy.** All project Markdown lives in `docs/`, indexed by `docs/README.md`. If a generator or workflow ever drops a root-level `.md` file, move it into `docs/` and update the index — don't leave stray root docs.
