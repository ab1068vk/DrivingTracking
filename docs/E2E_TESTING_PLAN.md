# Road Sage E2E Testing Plan

This document is the master checklist for building complete end-to-end coverage for Road Sage across the React web app, Capacitor Android shell, native bridges, local data, privacy controls, backups, and destructive flows.

## Goals

- Prove every user-facing route renders a usable screen with seeded and empty data.
- Prove all critical workflows can be completed, cancelled, and resumed without data loss.
- Prove privacy, permission, backup, import, export, and destructive controls are guarded.
- Prove Android native bridges and permissions match the app's expected contract.
- Catch blank screens, console errors, unhandled promise rejections, Android crashes, broken navigation, inaccessible controls, and storage regressions.

## Current Test Assets

- `npm run test:e2e` builds the Vite app and runs Playwright from `e2e/`.
- `e2e/app-smoke.spec.js` currently covers dashboard/settings navigation and empty trip history.
- `tests/android-uiautomator-full-app.mjs` already performs a broad Android WebView sweep with seeded trips, vehicles, privacy zones, settings, backups, native bridges, and logcat checks.
- `android/app/src/androidTest/java/com/roadsage/app/uitest/RoadSageFullSuite.kt` groups native UI tests `T01` through `T19`.
- Unit and integration coverage lives under `src/**/__tests__`, `src/lib/*.test.js`, `src/engine/**`, and `tests/full-suite.test.mjs`.

## Test Layers

1. **Playwright web E2E**
   - Runs against Vite preview at `http://127.0.0.1:4173`.
   - Best for route coverage, layout, forms, local storage, IndexedDB, responsive behavior, console errors, and cross-page workflows.

2. **Android UIAutomator and Espresso WebView E2E**
   - Runs against the installed debug APK.
   - Best for Capacitor shell launch, runtime permissions, native plugins, Android dialogs, rotation, background/foreground, logcat, and WebView bridge contracts.

3. **Static security and configuration checks**
   - Verifies Android manifest permissions, network security, backup rules, privacy-sensitive strings, and source inventory for high-risk controls.

4. **Unit/integration support tests**
   - Keep scoring, migration, privacy masking, backup encryption, route risk, settings validation, and repositories covered outside E2E so browser tests stay focused on user behavior.

## Required Fixtures

Create one shared seed module for Playwright, for example `e2e/fixtures/seedRoadSage.js`.

Seed data must include:

- Settings with `onboarding_completed: true`, manual tracking, metric units, notifications enabled, biometric lock disabled, and at least one privacy zone.
- Empty-state profile with no trips and no vehicles.
- Completed safe trip with route points, scores, events, tags, notes, favorite state, vehicle link, parking data, and phone-use permission status.
- High-risk trip with speeding, harsh braking, acceleration, cornering, heading/phone diagnostic events, low confidence, and score provenance.
- Active trip for recording banners, live tracking controls, and stale-trip prompts.
- Gas/hybrid vehicle and EV vehicle with maintenance, renewal, cost, odometer, fuel, and default-vehicle fields.
- Backup payloads: valid unencrypted JSON, valid encrypted `.rsbackup`, wrong-password payload, corrupted payload, oversized payload, and legacy payload.
- Privacy-zone payload with masked route/event data to prove coordinates are not leaked.

Every E2E test should reset browser storage and IndexedDB before seeding. Tests that mutate data must assert both the UI result and the stored record.

## Global Assertions

Apply these checks to every route and every major workflow:

- The app shell contains `Road Sage`.
- The intended heading or landmark is visible.
- `#root` is mounted and not blank.
- No `ReferenceError`, `TypeError`, `SyntaxError`, unhandled rejection, or React error appears in console logs.
- Buttons and inputs used by the test are accessible by role, label, placeholder, or stable test id.
- Loading states resolve within the configured timeout.
- Back navigation returns to a useful previous screen.
- Mobile and desktop viewports do not hide primary actions.
- Destructive controls require confirmation and can be cancelled.

## Route Coverage Matrix

| Route | Required E2E coverage |
| --- | --- |
| `/` Dashboard | Empty and seeded summaries, readiness card, permission warnings, start/stop trip controls, tracking banner, recent-trip links, stale-trip prompt, goal cards, no crash when permissions are unavailable. |
| `/trips` Trip History | Empty state, seeded cards, search, sort, filters, saved filters, tag filters, date/score filters, virtual scroll, map/list mode, open trip, favorite state, reset filters. |
| `/trips/:id` Trip Detail | Scores, score confidence, component evidence, map route, speed zones, events, feedback controls, phone-use notices, route risk, metadata edit/save/cancel, tags, notes, vehicle assignment, favorite, split flow, delete cancel/confirm. |
| `/survey/:tripId` Survey | Open from route and notification simulation, choose rating, choose context tags, skip, save feedback, persisted survey marker, return to trip/history. |
| `/map` Map | Empty and seeded map, layers/toggles, map markers, route privacy gaps, playback controls, no blank Leaflet container, no exact privacy-zone center exposure. |
| `/coach` Driving Coach | Empty/developing states, seeded insights, weekly plan, driver signature, adaptive baseline, speed discipline, best window, next actions. |
| `/insights` Driving Insights | Weekly summary, calendar navigation, commute detection, route comparison, goals, road-type breakdown, month changes, seeded/empty states. |
| `/achievements` Awards | Locked and earned badges, progress values, next-step text, seeded achievement progress, empty state. |
| `/reports` Reports | Weekly/monthly/yearly period controls, UBI/report sections, export actions guarded, PDF/CSV generation mocked, no browser popup/download leaks in tests. |
| `/vehicles` Vehicles | List, empty state, add/edit/cancel/delete, set default, gas/hybrid/EV validation, color swatch, numeric/date fields, maintenance done, renewal done, odometer sync, cost summaries. |
| `/settings` Settings | Search, group navigation, every settings section, persistence for toggles/selects/numeric fields, permission buttons, backup/import dialogs, privacy zones, OSRM trust, app lock, stealth mode, destructive cancel/confirm. |
| `/diagnostics` dev only | Local test data seed/remove, refresh, system health, OSRM status, motion sensor, decision log, latest parking timeline. Run only against dev builds. |
| `/android` dev only | Android reference page renders, expandable code blocks, copy controls. Run only against dev builds. |
| Unknown route | 404 page renders and offers a safe way back. |

## Playwright Suite Plan

Suggested files:

- `e2e/00-app-shell.spec.js`: launch, onboarding redirect, layout, desktop/mobile navigation, 404, console-error capture.
- `e2e/01-dashboard-tracking.spec.js`: dashboard summaries, readiness, permissions, start/stop controls, active trip, stale trip.
- `e2e/02-trip-history.spec.js`: empty state, seeded cards, search/sort/filter/saved filters, virtual scroll, open detail.
- `e2e/03-trip-detail.spec.js`: detail panels, map, events, feedback, edit/save/cancel, split/delete guards.
- `e2e/04-survey.spec.js`: survey rating/tag/skip/save paths and persisted calibration markers.
- `e2e/05-map-coach-insights-awards.spec.js`: secondary analysis pages with empty and seeded data.
- `e2e/06-reports-exports.spec.js`: periods, report content, CSV/PDF/export guards, no sensitive URL leakage.
- `e2e/07-vehicles.spec.js`: full vehicle CRUD and validation for gas/hybrid/EV records.
- `e2e/08-settings-core.spec.js`: search, tracking, permissions, notifications, appearance, economics, goals.
- `e2e/09-settings-privacy-security.spec.js`: privacy zones, app lock, stealth mode, data retention, backup/import, delete all, wipe all.
- `e2e/10-settings-scoring-advanced.spec.js`: scoring thresholds, calibration, voice alerts, phone use, speed warnings, OSRM, OBD, sensor fusion.
- `e2e/11-responsive-a11y.spec.js`: mobile viewport, keyboard navigation, labels, focus traps for dialogs, reduced-motion smoke.

## Android Suite Plan

Keep and extend the existing Android coverage around these areas:

- App launch, foreground package, WebView surface, splash/loading resolution.
- Manifest permissions: internet, fine/coarse/background location, activity recognition, notifications, foreground service location, usage stats.
- Runtime permission dialogs for location, background location, activity, notifications, battery optimization, usage access, and Bluetooth/OBD where available.
- Native bridge contract: activity recognition, settings bridge, local notifications, geolocation, encrypted storage, secure key, Play Integrity, biometric gate.
- Background/foreground behavior: app lock, auto-lock timeout, recording banner, auto tracking service, quick settings tile, notification actions.
- Android rotation and process recreation on core pages.
- Parked car widget and parked-location privacy behavior.
- Logcat must not contain app crash, fatal exception, JavaScript exception, or Capacitor plugin registration failure.

## Settings Coverage Checklist

- Tracking mode: manual, auto-detect, background auto, paused, delayed start, native auto status, battery optimization shortcut.
- Android permissions: foreground/background location, activity recognition, notifications, usage access, Bluetooth, motion sensor.
- Feature permissions: blocked/unavailable/granted labels for features that depend on missing permissions.
- Economics: currency symbol, fuel price, EV energy price, CO2, grid emissions, tree-year equivalents.
- Notifications: trip summaries, coaching, maintenance, safety alerts, quiet hours.
- Voice alerts: enable/disable, test voice, rate, volume, earcon, minimum severity, quiet hours.
- Driving goals: weekly score, harsh braking, speeding, night-driving targets.
- Detection thresholds: harsh braking, acceleration, speeding margin, idle, heading events, calibration/reset, rescore.
- Coaching calibration: progress, recent unrated trips, label balance, sharing opt-in, provisional status.
- Advanced models: weather/context fetch, route risk, OBD, sensor fusion, crash signals.
- OSRM/OpenStreetMap: HTTPS trust, health check, consent dialog, verified endpoint, insecure endpoint rejection.
- Phone use detection: usage access, scoring impact, map display, permission-required state.
- Speed warning: live warnings, OSM limit margin, default country.
- Privacy zones: create, validate radius, edit, delete, parked-location copy, masked route assertions.
- Privacy and data: legal notice, backup export/import, CSV export, saved filters export, data retention, app lock, stealth mode.
- Destructive actions: delete all trips and wipe all Road Sage data must be cancellable and must require explicit confirmation before mutation.

## Privacy And Security E2E Requirements

- Backup export requires a strong matching password before enabling export.
- Backup import rejects wrong passwords, corrupted files, oversized files, and unexpected schemas.
- Cancelled backup import must not write trips, vehicles, settings, privacy zones, or saved filters.
- Privacy-zone center coordinates must not appear in exported backup JSON, route URLs, map popups, logs, or reports.
- OSRM route snapping must not enable for insecure or unverified endpoints.
- Destructive controls must never run during broad "safe click" sweeps.
- App lock must unlock through the native biometric/device credential bridge on Android and disable safely if unavailable.
- Stealth trip mode must erase or avoid persisting private route/event data after the trip ends.

## Accessibility And Responsive Coverage

- Desktop Chrome and a mobile viewport should run at minimum.
- Navigation must work through desktop nav and mobile menu.
- Dialogs must trap focus and close with cancel/back where appropriate.
- Primary inputs must have labels, placeholders, or accessible names.
- Buttons with icons only need accessible labels.
- Long settings labels and vehicle/trip names must not overflow their containers.
- Map, chart, and score widgets must expose adjacent text values that can be asserted without relying only on pixels.

## CI Commands

Run the normal checks before merging E2E work:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Run Android checks when an emulator or device is available:

```powershell
cd android
.\gradlew.bat connectedDebugAndroidTest
cd ..
node tests/android-uiautomator-full-app.mjs
node tests/android-uiautomator-settings-full.mjs
node tests/android-uiautomator-backup-import.mjs
```

## Implementation Phases

1. **Stabilize fixtures**
   - Build shared seed/reset helpers for local storage, IndexedDB, trips, vehicles, privacy zones, settings, survey markers, and backup files.

2. **Expand Playwright from smoke to route coverage**
   - Add the route matrix tests first, with global console/error assertions and desktop/mobile coverage.

3. **Add workflow mutation tests**
   - Cover trip edit, saved filters, vehicle CRUD, survey persistence, settings persistence, and backup/import cancellation.

4. **Add privacy/security E2E**
   - Cover backup passwords, privacy masking, OSRM trust, app lock, stealth mode, retention, delete all, and wipe all guards.

5. **Harden Android native coverage**
   - Keep UIAutomator broad sweeps, add focused tests for notification deep links, process recreation, widget behavior, and native service state.

6. **Make coverage enforceable**
   - Add source-inventory tests that fail when new routes, settings sections, high-risk labels, or navigation items are added without E2E coverage.

## Definition Of Done

E2E coverage is complete when:

- Every route in `src/App.jsx` has at least one empty-state and one seeded-data E2E assertion where applicable.
- Every settings section in `src/features/settings/hooks/useSettingsSections.js` is reachable by search and directly exercised.
- Every high-risk control involving permissions, backup/import/export, privacy, OSRM, app lock, stealth mode, delete, or wipe has a guarded E2E scenario.
- Every data-mutating workflow verifies UI output and storage state.
- Playwright passes locally with no console/runtime errors.
- Android UIAutomator or instrumentation tests pass on a clean emulator/device with no logcat crash signatures.
- New app surfaces cannot be added without updating this plan and the source-inventory coverage.
