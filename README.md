# Road Sage

Road Sage is a local-first driving tracker for Android. It records trips, maps routes, identifies
driving events, produces a driving score, and keeps the resulting data on the device.

It is built as a React web application packaged with Capacitor, backed by Android native services
written in Java for background capture, durable storage and device integration.

> Software qualification is complete for this branch. **Physical-device qualification has not been
> performed.** No release or device qualification claim is made.

## What it does

| Area | Capability |
|---|---|
| **Trip capture** | Manual trips, foreground auto-detect, and Android native background tracking with activity recognition, GPS fallback, a quick-settings tile and pause/resume |
| **History and detail** | Trip browsing and per-trip review of route, events, speed and context |
| **Map and replay** | Route display, playback and 3D replay where route evidence is available |
| **Events and evidence** | Recorded driving events, with an explicit evidence state per trip — present, absent, expired, privacy-excluded, unavailable or legacy-unknown |
| **Scoring** | Component and overall scores, each carrying a confidence level and provenance |
| **Insights, coaching, progression** | Trends and analytics, structured coaching programs, milestones and achievements |
| **Road-speed knowledge** | Speed limits resolved from map data, learned observation and user confirmation — each with a source and confidence |
| **Speed-sign scanning** | Android camera feature reading posted signs on demand, via a heuristic visual gate and on-device text recognition |
| **Vehicles** | Vehicle profiles, reference data and trip attribution |
| **Parking** | Parked-location recording, photos with scheduled expiry, and a home-screen widget |
| **Phone-usage evidence** | Optional Android distraction evidence behind a special-access permission |
| **Reports and exports** | Report generation, data export and evidence export |
| **Privacy** | Privacy zones, private-trip mode, retention, data-rights erasure and a privacy audit chain |
| **Backup and restore** | Versioned, encrypted, passphrase-protectable portable backups |
| **Diagnostics** | A bounded, privacy-preserving self-report used for qualification |

An advanced `/tracking` workspace provides deeper operator-facing surfaces for recorder, map,
events, alerts, evidence, speed, privacy, reports and replay.

## Architecture in brief

- **Trip authority is local.** `src/api/trips.js` never routes trips to a network API. The
  shipping configuration uses the browser/IndexedDB repository; an Android SQLite archive
  authority is available behind `VITE_P35_NATIVE_AUTHORITY`.
- **Reads are bounded pages.** History, detail and analytics request pages with explicit
  continuation and completeness. Population totals come from scalar counts, separately, and only
  when an owner can supply them.
- **Capture is durable.** In-progress trips are checkpointed; an interrupted session resumes
  rather than being lost.
- **Recovery is once per process.** Archive startup recovery is admitted by the storage
  coordinator; repository construction is not treated as process startup.
- **Uncertainty is reported, not hidden.** Unavailable, expired and low-confidence states are
  distinct from zero or empty throughout the system.

Full detail: [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md).

## Technology

| Layer | Technology |
|---|---|
| UI | React 18, Vite, Tailwind CSS |
| Storage | IndexedDB (browser authority), SQLite (Android archive) |
| Packaging | Capacitor 8 |
| Native | Java Android services, Capacitor plugins, ML Kit text recognition |
| Testing | Vitest, Playwright, JUnit/Robolectric |

## Repository layout

```
src/            Web application: pages, components, hooks, libraries
src/lib/        Core libraries: scoring, storage, road knowledge, privacy, native bridges
android/        Android project and native Java services
e2e/            Playwright end-to-end specs
scripts/        Build, guard and maintenance tooling
docs/           Documentation
```

## Prerequisites

- Node.js 20 or newer, and npm
- JDK 17 for the Android build
- Android Studio with the Android SDK, for Android work

## Setup and development

```bash
npm install
npm run dev          # Vite dev server
npm run lint         # ESLint, zero-warning policy
npm run typecheck    # TypeScript checkJs pass
```

## Android

```bash
npm run android:sync   # build web assets, sync Capacitor, apply the Gradle patch
npm run android:open   # open in Android Studio
```

From `android/`: `./gradlew.bat assembleDebug` builds a debug APK, and
`./gradlew.bat :app:testDebugUnitTest` runs the JVM/Robolectric suites.

## Build

```bash
npm run build
```

`prebuild` runs the recovery-contract guard and regenerates the scoring version, so the build fails
closed if either invariant is stale.

## Testing

```bash
npm test                              # Vitest, --pool=forks --maxWorkers=1
npx vitest run path/to/file.test.js   # single file
npm run test:e2e                      # Playwright against a built preview
```

`--pool=forks --maxWorkers=1` is required: several suites share module-level state and interfere
under parallel workers. See [docs/development/TESTING.md](docs/development/TESTING.md).

## Documentation

| Audience | Start here |
|---|---|
| Evaluating the product | [Product overview](docs/product/PRODUCT_OVERVIEW.md) |
| Developer or maintainer | [Architecture overview](docs/architecture/OVERVIEW.md) |
| Debugging a problem | [Debugging guide](docs/development/DEBUGGING.md) |
| Privacy or security review | [Data handling](docs/legal/DATA_HANDLING_NOTICE.md) · [SECURITY.md](SECURITY.md) |
| Everything | [Documentation portal](docs/README.md) |

## Status and limitations

Software qualification is complete; Diagnostics qualification is complete; physical-device
qualification remains. Known limitations — detection uncertainty, speed-limit coverage, platform
dependence and unmeasured device performance — are documented in
[docs/product/LIMITATIONS.md](docs/product/LIMITATIONS.md).

## Licence

**No licence file is present in this repository.** Until one is added, no rights to use, modify or
distribute the code are granted. See
[docs/legal/LEGAL_DECISIONS_REQUIRED.md](docs/legal/LEGAL_DECISIONS_REQUIRED.md).
