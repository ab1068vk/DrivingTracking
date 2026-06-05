# Road Sage Version History

This file records closeout-level release history. Keep it updated when a version is considered done, before starting the next version.

## 1.0.1 - In progress

### Focus

- Started the fixes and improvements cycle after the 1.0.0 closeout.

### Current State

- App package: `drivesense-app`
- App version: `1.0.1`
- Android versionName: `1.0.1`
- Android versionCode: `2`
- Settings defaults version: `12`
- Canonical trip schema: `v23`
- Backup schema: `v6`

## 1.0.0 - 2026-06-04

### Closeout Scope

- Completed the generated README and technical reference refresh for the current source tree.
- Aligned standalone `.mjs` coverage with the TypeScript scoring modules and current Android settings defaults.
- Added connected-device UIAutomator coverage notes for onboarding, full app, settings, and backup/import checks.
- Verified release-gate commands should include repo hygiene, lint, typecheck, Vitest, standalone `.mjs`, production build, Playwright e2e, Android debug build, Android unit tests, connected-device UIAutomator `.mjs`, and Android instrumentation.

### Baseline State

- App package: `drivesense-app`
- App version: `1.0.0`
- Android versionName: `1.0.0`
- Android versionCode: `1`
- Settings defaults version: `12`
- Canonical trip schema: `v23`
- Backup schema: `v6`

### Closeout Notes

- The app remains local-first by default.
- Android release hardening remains part of the closeout gate: certificate pin expiry check, release log stripping, secure WebView defaults, no debug-route bundle leakage, and instrumentation coverage.
- The standalone Node `.mjs` suite intentionally reports coverage skips for modules that require Vite alias resolution or TypeScript loading outside plain Node; those areas are covered by Vitest, typecheck, and build checks.
