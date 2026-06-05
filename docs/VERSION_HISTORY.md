# Road Sage Version History

This file records closeout-level release history. Keep it updated when a version is considered done, before starting the next version.

## 1.0.1 - 2026-06-05

### Focus

- Started the fixes and improvements cycle after the 1.0.0 closeout.
- Refreshed current-app documentation for onboarding timing, Dashboard tracking readiness, App lock behavior, settings contract results, and E2E backup fixtures.
- Added generated technical-reference check mode, Markdown link/npm-command validation, and package scripts for deterministic documentation, standalone, and settings-contract checks.
- Tightened the Dashboard Playwright smoke assertion so current tracking-readiness copy is tested without ambiguous text matches.
- Updated React Router to `6.30.4`, resolving the protocol-relative redirect advisory reported by `npm audit`.

### Current State

- App package: `drivesense-app`
- App version: `1.0.1`
- Android versionName: `1.0.1`
- Android versionCode: `2`
- Settings defaults version: `12`
- Canonical trip schema: `v23`
- Backup schema: `v6`

### Closeout Verification

- Repository hygiene, generated documentation checks, lint, TypeScript, settings contracts, Vitest, standalone Node contracts, production build, and Playwright browser E2E passed.
- Vitest: 97 files passed, 1 skipped; 849 tests passed, 3 skipped.
- Settings contract: 277 passed.
- Playwright: 13 passed.
- Android debug APK, debug unit tests, and debug instrumentation APK compiled successfully.
- Certificate pin expiry, calibration promotion-blocker JSDoc, production diagnostics-route exclusion, localhost API fallback exclusion, and dependency audit checks passed.
- Connected Android UIAutomator and instrumentation execution were not run because no device or emulator was attached during closeout.

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
