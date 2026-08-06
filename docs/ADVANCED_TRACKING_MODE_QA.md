# Advanced Tracking Mode QA

Last reviewed: 2026-07-09

## Release Hardening Summary

- Coaching Mode remains the default `experience_mode`; invalid or missing mode values migrate to `coaching`.
- Advanced Tracking Mode is a presentation layer over shared local trip data, shared active trip state, shared privacy masking, shared speed knowledge, and shared voice alert delivery.
- Tracking console pages use full-width workspaces, split panes, dense tables, inspectors, timelines, and compact status strips. The primary tracking pages do not use the repeated `rounded-3xl bg-card` metric-card pattern.
- Wording was audited for judgment phrasing. Tracking-mode UI uses neutral telemetry language such as "event recorded", "threshold exceeded", "source unavailable", "privacy masked", and "confidence low".
- Privacy-zone display rows redact geometry. Technical exports strip coordinate columns and mark privacy placeholders rather than exporting raw private coordinates.
- Mobile and desktop tracking-mode layout is covered by Playwright overflow checks.

## Verification Commands

Run during the 2026-07-09 hardening pass:

- `npm.cmd test -- src/lib/__tests__/trackingReplayPro.test.js src/pages/__tests__/corePages.render.test.jsx src/components/__tests__/LayoutAccessibility.test.jsx`
- `npm.cmd test`
- `npm.cmd run build`
- `npm.cmd run typecheck`
- `npx.cmd playwright test e2e/ux-layout.spec.js`
- `npx.cmd playwright test e2e/trip-3d-replay-upgrade.spec.js`
- `node ./node_modules/playwright/cli.js test e2e/app-smoke.spec.js`
- `npm.cmd run test:e2e` rebuilt successfully and ran Playwright with 41 passed and 1 skipped. The skipped case is the existing mobile settings-controls skip.

## Known Limitations

- Advanced Tracking Mode does not create a new tracking engine, storage backend, score engine, map engine, or voice engine. Any limitations in the shared local tracking pipeline remain shared by Coaching Mode and Tracking Mode.
- The tracking cockpit now embeds the shared Leaflet `TripMap` (Map tab) and a provisional in-drive score panel. Both reuse the shared engines; the SVG `LiveRoutePlot` stays as the tile-free/offline path and as the map-failure fallback. The provisional score is rendered through `scoreDisplay`'s approximate (`~`) path, is never persisted, and must not be compared with completed-trip scores.
- Capture fidelity is **not** governed by `experience_mode`. `capture_fidelity` is a separate setting (`docs/CAPTURE_FIDELITY.md`) precisely so that switching presentation mode never changes what lands on disk — trips recorded in either mode stay comparable.
- Technical export quality depends on retained local trip detail. Summary-only private trips and expired route data intentionally block raw replay and coordinate export workflows.
- Optional road-data integrations remain governed by existing local settings and consent/privacy gates; the tracking consoles report unavailable or blocked evidence rather than calling third-party services directly.
- The 3D compare/replay workflow uses the existing 3D availability and retained-route checks. It does not synthesize route geometry for trips with expired or summary-only route data.
