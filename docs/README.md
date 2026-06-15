# Road Sage Documentation

This folder is the home for project documentation beyond the root `README.md`.

## Current Docs

- [Technical reference](TECHNICAL_REFERENCE.md): generated repository reference covering source inventory, calculations, constants, storage, routes, security analysis, tests, dependencies, and deployment notes.
- [Speed and fallback behavior](speed-and-fallbacks.md): current speed capture, speed-limit fallback, OpenStreetMap enrichment, and voice-alert behavior.
- [Privacy Intelligence](PRIVACY_INTELLIGENCE.md): privacy dashboard behavior, protection checks, audit chain, transmission logging, storage/encryption notes, test coverage, and release-readiness limits.
- [Recovery plan](RECOVERY_PLAN.md): Android package identity, settings, backup, and upgrade compatibility guardrails.
- [Upgrade verification](UPGRADE_VERIFICATION.md): physical-device in-place upgrade verification notes.
- [Version code 2 verification](VERSION_CODE_2_VERIFICATION.md): version-code 2 upgrade verification notes.

## Regenerating Generated Docs

Run this after meaningful source or README changes:

```bash
node scripts/generate-technical-reference.mjs
```

The generator writes `docs/TECHNICAL_REFERENCE.md` and refreshes the root `README.md`.
