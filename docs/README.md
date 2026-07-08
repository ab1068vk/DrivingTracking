# Road Sage Documentation

Last updated: 2026-06-24

This folder is the home for all project Markdown documentation.

## Current Docs

- [Project README](PROJECT_README.md): broad app overview, local setup, Android setup, privacy defaults, architecture notes, and current feature surface.
- [Technical reference](TECHNICAL_REFERENCE.md): generated repository reference covering source inventory, calculations, constants, storage, routes, security analysis, tests, dependencies, and deployment notes.
- [UI and loading performance guide](UI_LOADING_PERFORMANCE.md): app-wide lag incident playbook, Saved road speeds analysis, UI loading rules, measurement plan, AI handoff prompt, and implementation snippets.
- [Speed and fallback behavior](speed-and-fallbacks.md): current speed capture, speed-limit fallback, OpenStreetMap enrichment, and voice-alert behavior.
- [Privacy Intelligence](PRIVACY_INTELLIGENCE.md): privacy dashboard behavior, protection checks, audit chain, transmission logging, storage/encryption notes, test coverage, and release-readiness limits.
- [3D Replay](TRIP_3D_REPLAY.md): complete 3D replay implementation guide covering routes, data contracts, Three.js rendering, privacy masking, playback controls, diagnostics, snippets, tests, and troubleshooting.
- [Manual trip no-movement debug](MANUAL_TRIP_NO_MOVEMENT_DEBUG.md): incident documentation for manual Start Trip sessions being discarded as "no real movement", including code paths, snippets, diagnostics, likely failure points, and acceptance criteria.
- [Recovery plan](RECOVERY_PLAN.md): Android package identity, settings, backup, and upgrade compatibility guardrails.
- [Upgrade verification](UPGRADE_VERIFICATION.md): physical-device in-place upgrade verification notes.
- [Version code 2 verification](VERSION_CODE_2_VERIFICATION.md): version-code 2 upgrade verification notes.

## Regenerating Generated Docs

Run this after meaningful source or README changes:

```bash
node scripts/generate-technical-reference.mjs
```

The generator writes `docs/TECHNICAL_REFERENCE.md` and refreshes `docs/PROJECT_README.md`.

All Markdown files are intentionally kept in `docs/`. If the generator or a new workflow creates a root-level Markdown file, move it back here and update this index.
