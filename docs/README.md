# Road Sage Documentation

Documentation for Road Sage, a local-first driving tracker built with React, Vite, Capacitor and
Android native services. These documents describe the application as implemented.

## Where to start

| You are | Start here |
|---|---|
| Evaluating the product | [Product overview](product/PRODUCT_OVERVIEW.md) |
| Demonstrating or presenting it | [Capabilities and demo guide](product/CAPABILITIES_AND_DEMO.md) |
| A developer, new to the codebase | [Repository README](../README.md) → [Architecture overview](architecture/OVERVIEW.md) |
| Maintaining a subsystem | The architecture section below |
| Debugging | [Debugging guide](development/DEBUGGING.md) |
| Reviewing privacy | [Data handling notice](legal/DATA_HANDLING_NOTICE.md) → [Privacy and data handling](security/PRIVACY_AND_DATA_HANDLING.md) |
| Reviewing security | [Key lifecycle and secure bridge](security/KEY_LIFECYCLE_AND_SECURE_BRIDGE.md) → [SECURITY.md](../SECURITY.md) |
| A legal reviewer | [Legal documentation](legal/) |
| Preparing device testing | [Device qualification](operations/DEVICE_QUALIFICATION.md) |

## Product and overview

- [Product overview](product/PRODUCT_OVERVIEW.md) — what Road Sage is, intended use, capability summary, platform and maturity.
- [How Road Sage works](product/HOW_ROAD_SAGE_WORKS.md) — the trip lifecycle explained conceptually.
- [Capabilities and demo guide](product/CAPABILITIES_AND_DEMO.md) — feature catalogue with platform and permission requirements, plus an honest demonstration flow.
- [Limitations](product/LIMITATIONS.md) — what the product does not claim, and where its accuracy is bounded.
- [FAQ](product/FAQ.md) — direct answers to common questions.

## Architecture

- [Overview](architecture/OVERVIEW.md) — layers, trip authority, capture, bounded queries, durability and scaling posture.
- [Scoring engine](architecture/SCORING_ENGINE.md) — calculation flow, score domains, confidence, provenance, thresholds, versioning and rescoring.
- [Insights, coaching and progression](architecture/INSIGHTS_COACHING_AND_PROGRESSION.md) — the metric registry, analytics, coaching programs and the progression ledger.
- [Native tracking service](architecture/NATIVE_TRACKING_SERVICE.md) — the Android capture service: lifecycle, state machine, deliberate-stop semantics, durability and watchdog.
- [Detection pipeline](architecture/DETECTION_PIPELINE.md) — how GPS points become severity-classified events and how the JS and native detectors stay aligned.
- [Capture fidelity](architecture/CAPTURE_FIDELITY.md) — capture tiers, sampling and the fidelity budget.
- [Browser storage](architecture/BROWSER_STORAGE.md) — the IndexedDB trip authority, record categories, paging and snapshots.
- [Native archive](architecture/NATIVE_ARCHIVE.md) — SQLite archive, control rows, journal and control plane, migration ingress, ownership and unlink debt.
- [Data storage and lifecycle](architecture/DATA_STORAGE_AND_LIFECYCLE.md) — the upgrade contract, checkpointing and once-per-process recovery.
- [Query and projections](architecture/QUERY_AND_PROJECTIONS.md) — bounded pages, population counts, projection parity, detail identity and caching.
- [Derived state and background work](architecture/DERIVED_STATE_AND_BACKGROUND_WORK.md) — derived domains, readiness and the work coordinator's budgets and epochs.
- [Diagnostics](architecture/DIAGNOSTICS.md) — build identity, attribution, health scopes, window versus population, runtime authority and the privacy allowlist.

## Features

- [Road-speed knowledge](features/ROAD_SPEED_KNOWLEDGE.md) — source hierarchy, confidence, conflict, learning, enrichment and maintenance.
- [Speed-sign scanning](features/SPEED_SIGN_SCANNING.md) — the Android camera pipeline, visual gate, recognition and fusion.
- [Vehicles, parking and device integration](features/VEHICLES_PARKING_AND_DEVICE_INTEGRATION.md) — vehicle attribution, parking with photo expiry and widget, and Android integrations including phone-usage evidence.
- [3D trip replay](features/TRIP_3D_REPLAY.md) — replay rendering, data dependencies and playback.
- [Speed pipeline and voice alerts](features/SPEED_LIMITS_AND_FALLBACKS.md) — detailed June 2026 walkthrough of raw speed capture, segment reliability, GPS versus OBD, OpenStreetMap lookup and voice alerts; carries a currency note.
- [Advanced tracking mode](features/ADVANCED_TRACKING_MODE.md) — advanced tracking behaviour and validation coverage.

## Data

- [Backup and restore](data/BACKUP_AND_RESTORE.md) — format versioning, export leases, untrusted import, retention ordering and operational guidance.

## Reference

- [Data models](reference/DATA_MODELS.md) — trip, active trip, route point, evidence states, vehicle, score result, control rows, page and population contracts.
- [Routes and pages](reference/ROUTES_AND_PAGES.md) — the full route map, page purposes, data sources and data shapes.
- [Configuration](reference/CONFIGURATION.md) — every environment variable, Gradle property and guard, including internal triage flags.
- [Constants and policy](reference/CONSTANTS_AND_POLICY.md) — significant policy values, where they live and which are sensitive.
- [Error and failure model](reference/ERROR_AND_FAILURE_MODEL.md) — failure domains, retryable versus terminal, fail-open versus fail-closed, troubleshooting paths.

## Security and privacy

- [Privacy and data handling](security/PRIVACY_AND_DATA_HANDLING.md) — privacy dashboard, protection checks, audit chain, storage and encryption, retention and erasure.
- [Key lifecycle and secure bridge](security/KEY_LIFECYCLE_AND_SECURE_BRIDGE.md) — payload and envelope keys, fail-closed rotation, and the web-to-native trust boundary.
- [Certificate pin renewal](security/CERTIFICATE_PIN_RENEWAL.md) — TLS pin renewal procedure and cadence.
- [SECURITY.md](../SECURITY.md) — vulnerability reporting policy.

## Development

- [Testing](development/TESTING.md) — commands, the worker constraint, guards, layout and qualification evidence.
- [Debugging](development/DEBUGGING.md) — symptom map, web and Android debugging, triage flags and storage diagnosis.
- [Performance](development/PERFORMANCE.md) — the bounded-query performance model and measurement guidance.

## Operations

- [Release and versioning](operations/RELEASE_AND_VERSIONING.md) — protected identity, versions, build identity, release steps, variants and upgrade verification.
- [Device qualification](operations/DEVICE_QUALIFICATION.md) — outstanding physical-device obligations and why software suites cannot close them.

## Qualification

- [Software qualification status](ROAD_SAGE_SOFTWARE_QUALIFICATION_STATUS.md) — the current baseline, test evidence and remaining device obligations.

## Legal and trust

Drafts require legal review and are marked as such.

- [Legal notice system](architecture/LEGAL_NOTICE_SYSTEM.md) — the in-app versioned notice, first-launch gate, acknowledgement record and Settings review; the canonical disclosure ownership model.
- [Data handling notice](legal/DATA_HANDLING_NOTICE.md) — plain-language description of what is stored and what leaves the device.
- [Third-party services](legal/THIRD_PARTY_SERVICES.md) — external services contacted, data categories sent, and attribution status.
- [Privacy policy draft](legal/PRIVACY_POLICY_DRAFT.md) — **draft**, requires legal review.
- [Terms of use draft](legal/TERMS_OF_USE_DRAFT.md) — **draft**, requires legal review.
- [Product disclaimer](legal/PRODUCT_DISCLAIMER.md) — **draft**, scope and limits.
- [Legal decisions required](legal/LEGAL_DECISIONS_REQUIRED.md) — open items the repository cannot decide, including the absent licence.

## Historical reference

One-time records retained for context. They are **not** current architecture or release
documentation; each carries a notice.

- [Android in-place upgrade verification](historical/UPGRADE_VERIFICATION.md) (June 2026)
- [Android version code 2 verification](historical/VERSION_CODE_2_VERIFICATION.md) (June 2026)
- [Phase 0 incident triage results](historical/PHASE_0_INCIDENT_TRIAGE_RESULTS.md) (June 2026)
- [UI and loading performance playbook](historical/UI_LOADING_PERFORMANCE_PLAYBOOK.md) (June 2026)
- [Manual trip no-movement debug](historical/MANUAL_TRIP_NO_MOVEMENT_DEBUG.md)
- [Branch: page splits and audit fixes](historical/BRANCH_PAGE_SPLITS_AND_AUDIT_FIXES.md)
- [Advanced tracking mode phase prompts](historical/ADVANCED_TRACKING_MODE_PHASE_PROMPTS.md)

## Generated reference

`scripts/generate-technical-reference.mjs` produces a large repository reference at
`docs/TECHNICAL_REFERENCE.md` and a generated summary at `docs/PROJECT_README.md`. Both are
generated artefacts, superseded for day-to-day use by the maintained documents above.

Both paths are listed in `.gitignore`, but both are still tracked in Git history, and a tracked
file is never ignored. Re-running the generator therefore reproduces them as modifications to
tracked files rather than as ignored output. Regenerate locally only when needed, and do not stage
the result:

```bash
node scripts/generate-technical-reference.mjs
```

## Conventions

Project Markdown lives in `docs/`, indexed here. Root-level Markdown is limited to `README.md`,
`SECURITY.md` and `CLAUDE.md`.
