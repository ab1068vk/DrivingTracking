# Debugging Guide

Practical guidance for diagnosing Road Sage during development.

## Start with Diagnostics

The Diagnostics page is the fastest way to establish *what state the application believes it is
in*. It reports build identity, whether evidence belongs to this launch or an older build, health
scopes, the bounded trip window and population separately, collection and replay categories,
native runtime authority, and a read-only subsystem snapshot.

Read it before forming a hypothesis. It distinguishes "unavailable" from "zero", which is usually
the question you actually have. See
[../architecture/DIAGNOSTICS.md](../architecture/DIAGNOSTICS.md).

## Symptom map

| Symptom | First checks |
|---|---|
| Trips not appearing after a drive | Journal/admission state and archive recovery state in Diagnostics; was the trip finalised? |
| Capture never starts | Durable enabled flag, location and activity permissions, battery optimisation |
| Capture stops early | Stillness/non-vehicle timers, OS background limits, process death in the watchdog record |
| Score missing or shown as approximate | Component confidence level and provenance — likely `developing`/`unavailable`, not a bug |
| Totals missing or blank | Population availability and its reason (`indexeddb_unavailable`, `snapshot_changed_during_count`, `not_status_partitioned`) |
| History shows fewer trips than expected | Page continuation state — a window is not the population |
| Replay unavailable | Replay evidence state: `expired` vs `privacy_excluded` vs `unavailable` vs `absent` |
| Derived values stale | Domain readiness: `required_version` vs `applied_version` |
| Speed limit wrong or missing | Source and refusal reason; confidence gate; enrichment consent |
| Native feature silently absent | Native bridge state — unimplemented (`false`) vs probe failure (unknown) |

## Web debugging

`npm run dev` for the dev server. React Query devtools reflect cache identity and invalidation.
`src/lib/systemLog.js` records critical-path failures; the System Logs page surfaces them in-app.

## Android debugging

Build and install a debug APK from `android/`:

```bash
./gradlew.bat assembleDebug
```

Inspect native logs with `logcat`, filtering on the `DriveSense` classes. The WebView can be
inspected with Chrome DevTools remote debugging when a debug build is running.

Useful native signals: the live capture notification reflects service state; the quick-settings
tile reflects the durable enabled flag; `AppExperienceWatchdog` records stalls, low-memory events
and process-exit reasons that later appear in Diagnostics.

## Triage flags

Internal build-time flags for isolating performance problems. They change behaviour — never use
them to produce product or performance claims.

| Flag | Effect |
|---|---|
| `VITE_PERF_TRIAGE_LOGS` | Performance-triage logging |
| `VITE_TRIAGE_DISABLE_MAPS` | Disable map components to isolate map cost |
| `VITE_TRIAGE_DASHBOARD_LIMITED_SUMMARIES` | Limit dashboard summary work |
| `VITE_TRIAGE_P0_ARM` | Arm the P0 probe instrumentation (`src/lib/p0Probe.js`) |
| `VITE_SHOW_DEBUG_ROUTES` | Expose the debug-only Android reference route |

See [../reference/CONFIGURATION.md](../reference/CONFIGURATION.md).

## Data and recovery symptoms

If storage state looks wrong, check in this order:

1. Which authority is active — browser or native (`VITE_P35_NATIVE_AUTHORITY`).
2. Archive recovery state and authority state.
3. Open operations — is something still `RECEIVING`?
4. Unlink debt — is destructive cleanup fenced by a live operation?
5. Derived-domain readiness.

Do not "fix" state by deleting rows. The recovery model is designed to converge; bypassing it
usually destroys the evidence needed to understand the fault.

## Avoiding shared-state test mistakes

Vitest must run with `--pool=forks --maxWorkers=1`. Several suites share module-level state, and
under parallel workers that state leaks between files, producing failures that do not reproduce in
isolation — a record from one suite surviving into another that expects an empty result is the
classic signature.

If a test fails only in a large run, re-run it isolated before assuming a product defect. See
[TESTING.md](TESTING.md).

## Where generated artifacts go

| Path | Contents |
|---|---|
| `dist/` | Web build output |
| `android/app/build/` | Gradle build and test results |
| `test-results/` | Playwright and qualification run artifacts |
| `docs/TECHNICAL_REFERENCE.md`, `docs/PROJECT_README.md` | Generated reference output |

`dist/`, `android/app/build/` and `test-results/` are gitignored. The two generated reference
paths are listed in `.gitignore` but remain tracked in Git history, and a tracked file is never
ignored — regenerating them shows up as tracked-file modifications, so do not stage them.
Regenerate with `node scripts/generate-technical-reference.mjs`.

## Safe experimentation

Take a backup before testing destructive paths (erasure, restore, migration). Prefer a debug build
with representative data over editing production storage by hand.
