# Advanced Tracking Mode Phase Prompts

Last reviewed: 2026-07-09

## Codebase Audit Summary

This plan is based on a repository pass across the React/Capacitor app, local storage layer, tracking engine, map/playback components, privacy modules, voice alert modules, Android native services, docs, and tests.

Important existing files and responsibilities:

- `src/App.jsx`: app bootstrap, lazy routes, settings hydration, native completed-trip sync, privacy-zone sweep, app lock, legal notice, route registration.
- `src/components/Layout.jsx`: global shell, grouped navigation, command palette, recording indicator, centered `container max-w-6xl` main content.
- `src/lib/trackingStore.js`: local settings defaults/migration, active trip state, native settings sync, theme mode, tracking/privacy/speed/voice/OBD defaults.
- `src/pages/Dashboard.jsx`: current live trip orchestration, manual/native tracking, active trip updates, speed alerts, phone-use merge, sensor fusion, private trip mode, scoring, trip save/discard.
- `src/lib/trackingService.js`: foreground/background GPS watcher and point acceptance.
- `src/lib/localTripRepository.js`: encrypted local trip/detail/summary IndexedDB storage, native completed-trip import, rescoring, raw GPS retention.
- `src/lib/tripEngine.js`: trip stats, event detection, scoring, thresholds, speed-limit resolution, metric export.
- `src/lib/metricRegistry.js`: metric labels, data sources, calibration notes, CSV/PDF metric metadata.
- `src/pages/MapScreen.jsx`, `src/components/TripMap.jsx`, `src/components/TripPlayback.jsx`: route maps, playback, overlays, route gaps, privacy masking, speed layers, danger zones, route risk.
- `src/pages/SpeedLimits.jsx`, `src/pages/SpeedAnalysis.jsx`, `src/lib/localSpeedKnowledge.js`, `src/lib/speedKnowledgeRepository.js`: user-labeled speeds, learned/local speed rules, speed-source audit, voice speed markers.
- `src/lib/privacyZones.js`, `src/pages/PrivacyIntelligence.jsx`, `src/lib/privacyIntelligence.js`, `src/lib/privateTripMode.js`: privacy zones, privacy stats, export masking, privacy audit, private summary-only trips.
- `src/lib/voiceAlerts.js`, `src/lib/voiceAlertMessages.js`, `android/.../DriveSenseAutoTrackingService.java`, `android/.../DriveSenseSpeedVoiceController.java`: shared voice alert delivery, native Android speech, cooldowns, speed marker capture.
- `src/pages/Report.jsx`, `src/lib/pdfExport.js`, `src/lib/ubiReport.js`, `src/lib/dataBackup.js`, `src/lib/dataRights.js`: exports, reports, backup, portability.
- `e2e/app-smoke.spec.js`, `e2e/ux-layout.spec.js`, `e2e/trip-3d-replay-upgrade.spec.js`, and `src/**/__tests__`: smoke, layout, privacy, speed, trip engine, settings, native parity, and render coverage.

## Non-Negotiable Product Rules

- Default experience remains the current app.
- Do not replace the current tracking engine, scoring engine, trip storage, privacy system, speed knowledge system, or voice alert system.
- Advanced Tracking Mode is a different presentation layer over the same shared trip/tracking data.
- No duplicated trip records, no second tracking service, no forked voice alert engine.
- No judgment language in Advanced Tracking Mode. Use neutral telemetry language: "event recorded", "threshold exceeded", "source unavailable", "privacy masked", "confidence low".
- Avoid the current "card wall" pattern in Advanced Tracking Mode. Use full-width workspaces, split panes, map surfaces, tables, timelines, inspectors, toolbars, drawers, and compact status strips.
- Keep privacy zones app-wide, not tracking-mode-only. Tracking mode may expose them more prominently.
- Use existing local-only privacy-safe data flows. Do not add third-party calls without existing consent/privacy gates.

## Phase 1 Prompt: Add Experience Mode Foundation

Prompt:

Implement the foundation for an app-wide `experience_mode` setting with two values: `coaching` and `tracking`. Default must be `coaching` so the current app remains unchanged for existing and new users.

Use the existing settings system in `src/lib/trackingStore.js`. Add constants/helpers for the mode, bump `CURRENT_SETTINGS_DEFAULTS_VERSION`, migrate invalid/missing values to `coaching`, and expose small helpers such as `isTrackingExperienceMode(settings)` if useful. Use existing `localSettings`, `SETTINGS_CHANGED_EVENT`, and `useLocalSettings` patterns.

Add a Settings control in `src/pages/Settings.jsx`. Put it somewhere visible but not disruptive, likely Appearance or Tracking. The control copy should explain that Coaching Mode keeps the current app, while Advanced Tracking Mode changes presentation to neutral telemetry views. Do not change tracking behavior when toggled.

Acceptance criteria:

- Existing app defaults to current Coaching Mode.
- Toggling mode persists through `localSettings.update`.
- No existing route UI changes unless mode is `tracking`.
- Add/update tests for settings defaults and migration, likely `src/lib/__tests__/trackingStoreDefaults.test.js` or a new targeted test.
- Run `npm.cmd test -- --runInBand` if compatible with the repo, otherwise the relevant Vitest file(s), then `npm.cmd run build`.

## Phase 2 Prompt: Mode-Aware Shell Without Card Wall

Prompt:

Make `src/components/Layout.jsx` mode-aware. When `experience_mode` is `coaching`, preserve the current shell, nav groups, max-width content, and command palette behavior. When `experience_mode` is `tracking`, use a new tracking shell layout that supports full-width console pages.

The tracking shell should keep Road Sage identity and app-level safety notices, but it should not use the centered `container max-w-6xl` main layout. Use a full-width main region suitable for map/timeline/table workspaces. Navigation should be compact and technical:

- Tracking
- Trips
- Map
- Events
- Speed
- Privacy
- Reports
- Settings

Use existing routes first where possible. Add new routes only where needed in later phases. Do not remove the current nav. Add command palette entries for tracking-mode destinations, but preserve existing entries in Coaching Mode.

Design rules:

- No decorative card wall.
- Prefer fixed toolbar, left rail, inspector pane, bottom timeline region.
- Use existing Tailwind tokens, but the tracking shell may have its own CSS classes in `src/index.css`.
- Avoid one-note neon/cyber styling even though `.cyber-lab` exists. This mode should feel like a clear technical console, not a theme gimmick.

Acceptance criteria:

- Coaching Mode screenshots/layout remain functionally unchanged.
- Tracking Mode has full-width content and compact technical nav.
- No horizontal overflow on mobile/desktop.
- Update or add Playwright layout coverage in `e2e/ux-layout.spec.js`.

## Phase 3 Prompt: Tracking Overview / Control Center

Prompt:

Add a new Advanced Tracking overview page, likely `src/pages/TrackingOverview.jsx`, routed at `/tracking`. This is the first screen in Advanced Tracking Mode.

The page should reuse existing data and APIs:

- `activeTripStore` for active trip state.
- `localSettings` / `useLocalSettings` for tracking mode, permissions, speed/voice/privacy settings.
- `getPermissionStatus`, Android native status helpers from `src/lib/activityRecognition.js`.
- `getTrackingDiagnostics` and `buildDashboardTrackingExplanation` from `src/lib/trackingDiagnostics.js`.
- `limitedTripSummaryQueryOptions` / `tripSummaryQueryOptions` for recent completed trip summaries.

UI pattern:

- Top status strip: tracking state, GPS/permission state, native auto/manual state, voice alert delivery, privacy-zone sync.
- Main layout: left recent trips table, center live/last route summary, right inspector/status details.
- Use tables, rows, segmented controls, icon buttons, and compact status chips.
- Avoid score hero cards. If score appears, label it neutrally as "Score estimate" or "Index estimate" and include evidence/confidence.

Include neutral language only:

- "Recording active"
- "Background auto tracking armed"
- "GPS permission unavailable"
- "Route points retained"
- "Native privacy-zone sync failed"

Acceptance criteria:

- Page works with no trips, with active trip, and with completed trip summaries.
- No mutation of trip data from this page.
- Route is lazy-loaded in `src/App.jsx`.
- Tracking Mode nav points to `/tracking` as the primary page.
- Add render/smoke tests for empty state and basic loaded state.

## Phase 4 Prompt: Map Workspace

Prompt:

Create an Advanced Tracking map workspace, likely `src/pages/TrackingMapWorkspace.jsx` at `/tracking/map`, reusing `TripMap`, `TripPlayback`, `MapScreen` logic, and existing route queries. This should not be a card page. It should be a split-pane workspace:

- Left rail: trip selector, saved filters, event type filters.
- Center: map/playback surface.
- Right inspector: selected trip/event/layer details.
- Bottom: timeline tracks for speed, events, route gaps, privacy gaps, speed-limit changes.

Reuse existing map capabilities:

- route points and route gaps from `mapPlaybackInsights.js`
- driving event markers
- speed bands
- speed-limit overlays
- local/user speed knowledge
- route risk segments
- danger zones
- privacy zone display circles and masking
- phone-use map filtering

Do not create a new map engine. If existing components need props to support a less-carded workspace or selection callbacks, add small, backward-compatible props.

Acceptance criteria:

- Existing `/map` still works in Coaching Mode.
- New `/tracking/map` uses full-width console layout.
- Selecting an event shows neutral details in inspector.
- Privacy-masked points/events are represented as gaps or redacted rows, never raw coordinates.
- Add Playwright coverage for map workspace rendering and no horizontal overflow.

## Phase 5 Prompt: Event Timeline and Inspector

Prompt:

Add an event-centric workspace, likely `src/pages/TrackingEvents.jsx` at `/tracking/events`. It should present trip events as a dense, filterable technical log, not coaching cards.

Data sources:

- trip detail `driving_events`
- route points for speed/time context
- phone-use merged events where available
- voice speed markers
- possible crash/incident events
- route gaps and privacy gaps
- metric/evidence labels from `metricRegistry.js`

Features:

- Filter by trip, date, event type, severity/confidence, source, privacy redaction.
- Table columns: time, event type, value, speed, limit/source, confidence, source, privacy status.
- Inspector pane: why it was detected, thresholds involved, data source, calibration/evidence note, related route point if available.
- Use neutral labels: "Hard braking event", "Acceleration threshold exceeded", "Phone-use window detected", "GPS heading pattern recorded".

Acceptance criteria:

- Works for trips with no events.
- Diagnostic-only events are labeled as diagnostic, not scored.
- GPS proxy phone-use events remain clearly distinguished from Android Usage Access evidence.
- Add unit tests for event row normalization and wording.

## Phase 6 Prompt: Speed Intelligence Console

Prompt:

Add or adapt a tracking-mode speed console, likely `/tracking/speed`, by reusing `SpeedLimits.jsx`, `SpeedAnalysis.jsx`, local speed knowledge modules, and speed-limit display/intelligence helpers.

It should expose:

- posted vs estimated vs learned/user-entered sources
- user-confirmed posted signs
- voice speed markers
- local speed rules needing review
- temporary/expiring speed rules
- speed-limit coverage by trip
- speed source confidence and fallback reason
- "posted signs override app estimates" safe wording

Do not duplicate `SpeedLimits.jsx`. Either add a mode-aware layout to it or build a thin tracking console page that imports the same helpers.

Acceptance criteria:

- No judgmental "speeding bad" language. Use "threshold exceeded" and "source confidence".
- Existing `/speed-limits` remains unchanged in Coaching Mode.
- Tracking page can jump to/edit existing speed rules through existing flows.
- Tests cover source labeling and mode-neutral wording.

## Phase 7 Prompt: Privacy Tracking Console

Prompt:

Create a tracking-mode privacy console, likely `/tracking/privacy`, that reuses existing Privacy Intelligence and privacy zone modules without weakening them.

Expose:

- configured privacy zones
- hidden route samples
- suppressed events
- privacy-zone native sync status
- route/export masking status
- private-trip summary-only mode explanation
- outbound road-data status
- OSRM/weather/Overpass consent and blocking status
- privacy audit summaries

Important constraints:

- Privacy zones remain app-wide.
- Do not show exact private-zone geometry in exports or backup-style views.
- Respect page-level authentication patterns from `PrivacyIntelligence.jsx` if showing sensitive privacy/audit details.
- Keep wording precise: this is app-recorded privacy evidence, not an external security audit.

Acceptance criteria:

- Existing `/privacy-intelligence` remains unchanged.
- Tracking privacy page reuses safe functions from `privacyIntelligence.js`, `privacyZones.js`, and `dataRights.js`.
- No raw private coordinates leak in UI, tests, exports, or logs.
- Add tests for privacy-safe display rows.

## Phase 8 Prompt: Voice Alert Lab With Shared Engine

Prompt:

Add a tracking-mode voice/alert lab, probably within `/tracking/events` or as `/tracking/alerts`, using the existing shared voice alert system. Do not fork `voiceAlerts.js` or Android native speech.

Add mode-aware alert wording support:

- Coaching Mode: keep existing messages.
- Advanced Tracking Mode: technical/neutral variants.

Implement this with a small setting such as `voice_alert_style: 'mode_default' | 'coaching' | 'technical'`, or derive technical wording from `experience_mode` unless overridden. Update `voiceAlertMessages.js` so alert message builders can receive style/context. Preserve existing cooldowns and native ownership behavior.

Technical wording examples:

- "Hard braking event recorded."
- "Speed threshold exceeded: 74 km/h in posted 60 km/h zone."
- "Phone-use window detected from Android Usage Access."
- "Route speed source is estimated; check posted signs."

Surface in UI:

- current delivery status from `getVoiceAlertDeliveryStatus`
- native/webview owner
- speed tier cooldowns
- test alert
- voice speed marker listener status
- recent alert log if available from system/native diagnostics

Acceptance criteria:

- Existing voice alerts still work and sound the same in Coaching Mode.
- Tracking Mode uses neutral technical wording by default.
- Android native and WebView ownership rules are preserved.
- Tests update `voiceAlertMessages.test.js` and `voiceAlerts.test.js`.

## Phase 9 Prompt: Data Quality and Evidence Console

Prompt:

Add a tracking evidence page or inspector tab that uses `metricRegistry.js`, `component_scores`, score provenance, route point metadata, speed-limit context, map-matching context, phone-use provenance, and sensor/OBD summaries.

Expose:

- data source per metric
- sample counts
- confidence/evidence level
- route point count vs raw count vs map/playback count
- GPS gaps
- map matching status
- OSM/weather/speed lookup status
- Android Usage Access state
- OBD powertrain sample count
- sensor fusion availability
- scoring version/provenance

Do not present this as "you are good/bad." Present it as "what data exists and how reliable it is."

Acceptance criteria:

- Missing evidence is shown as unavailable, not zero.
- Provisional/calibration notes are visible for approximate metrics.
- Existing report/score pages remain unchanged.
- Add tests for evidence row building.

## Phase 10 Prompt: Reports and Export Lab

Prompt:

Add tracking-mode export/report presentation that reuses existing export functions:

- `tripsToCSV`, `downloadCSV`
- `pdfExport.js`
- `ubiReport.js`
- `dataBackup.js`
- `dataRights.js`
- `exportIntegrity.js`

Add neutral technical export options:

- trip event CSV
- route point quality summary
- speed-source audit CSV
- privacy-safe technical PDF
- voice alert log export if available

Constraints:

- Exports must respect existing privacy masking and privacy-zone export placeholders.
- Do not add raw private coordinate exports.
- Keep existing coaching reports untouched.
- Label score outputs as estimates/provisional where the existing code does.

Acceptance criteria:

- Technical exports reuse existing privacy-safe export paths.
- Export UI is table/tool based, not score-card based.
- Tests cover privacy-safe export payload shape where new builders are added.

## Phase 11 Prompt: Compare and Replay Pro Mode

Prompt:

Add a compare/replay pro workflow using existing `TripPlayback`, `TripDrive3D`, `Trip3DReplay`, `mapPlaybackInsights.js`, and route comparison helpers.

Features:

- compare two trips on same/similar route
- speed timeline overlay
- event timeline overlay
- route gap comparison
- speed-limit source changes
- privacy gap indicators
- 3D replay event chapters
- playback mode: real-time, normalized, event-to-event

Constraints:

- Do not break existing `/3d-replay` or `/trips/:id/3d`.
- Summary-only private trips and expired route data must remain blocked.
- Reuse existing 3D availability checks and route expiry logic.

Acceptance criteria:

- Existing 3D replay tests still pass.
- Add one focused e2e test for compare/replay pro page if practical.
- Canvas/map nonblank checks remain valid.

## Phase 12 Prompt: QA, Wording Audit, and Release Hardening

Prompt:

Perform a full QA pass for Advanced Tracking Mode.

Checklist:

- Coaching Mode remains default and visually unchanged.
- Tracking Mode has no card wall: no primary pages dominated by repeated `rounded-3xl bg-card` metric cards.
- Tracking Mode uses neutral wording. Search for judgment words in new tracking files: bad, poor, unsafe, risky driver, needs improvement, failed as user feedback.
- Existing tracking, scoring, privacy zones, voice alerts, native tracking, and trip storage are shared.
- No duplicated trip storage or duplicate tracking engine.
- No raw privacy-zone coordinates leak.
- Mobile has no horizontal overflow.
- Build and tests pass.

Recommended commands:

- `npm.cmd test`
- `npm.cmd run build`
- `npm.cmd run test:e2e` if time and environment allow
- `npm.cmd run typecheck` if the current codebase supports it cleanly

Acceptance criteria:

- All changed code has focused unit/render tests.
- At least one Playwright smoke path covers Tracking Mode.
- Existing smoke/layout tests still pass.
- Document any known limitations in `docs/`.

## Suggested Implementation Order

1. Phase 1: setting foundation.
2. Phase 2: mode-aware shell and nav.
3. Phase 3: tracking overview.
4. Phase 4: map workspace.
5. Phase 5: event timeline.
6. Phase 8: voice alert lab, because shared wording affects live behavior.
7. Phase 6: speed console.
8. Phase 7: privacy console.
9. Phase 9: evidence console.
10. Phase 10: export lab.
11. Phase 11: compare/replay pro mode.
12. Phase 12: QA and hardening.

The first release can stop after Phases 1-5 plus Phase 8 if needed. That would deliver the core user promise: switch modes, no judgment, no card wall, shared tracking data, technical map/timeline/event UI, and neutral voice alerts.
