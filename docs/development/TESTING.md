# Testing

## Commands

```bash
npm test                              # Vitest: vitest run --pool=forks --maxWorkers=1
npx vitest run path/to/file.test.js   # single file
npx vitest run -t "test name"         # single test by name
npm run lint                          # ESLint, --max-warnings 0
npm run typecheck                     # tsc -p ./jsconfig.json
npm run test:e2e                      # Playwright against a built preview
```

Android, from `android/`:

```bash
./gradlew.bat :app:testDebugUnitTest   # JVM and Robolectric suites
./gradlew.bat assembleDebugAndroidTest # instrumentation APK (device/emulator required)
```

## Worker constraint

`--pool=forks --maxWorkers=1` is a correctness requirement, not a performance preference.
Several suites share module-level state. Under parallel workers that state leaks between files
and produces failures that do not reproduce in isolation — for example a record from one suite
surviving into another suite that expects an empty result. Respect this when adding tests that
touch module-level state.

Running a large sweep in bounded serial chunks is an acceptable alternative to one long
invocation, provided each chunk keeps the mandated worker setting and writes to its own result
file.

## Repository guards

These run in `prebuild`/`pretest` or on demand and fail closed:

| Command | Enforces |
|---|---|
| `npm run recovery:guard` | Android package identity and upgrade-safety invariants |
| `npm run scoring:version:check` | The generated scoring version matches the constants |
| `npm run check:repo-hygiene` | Machine-local Android files stay untracked |
| `npm run check:cert-pins` | TLS pin renewal window |
| `npm run legal:version:check` | Legal notice content matches its acknowledgement version metadata |

After editing `src/lib/scoringConstants.js`, run `npm run scoring:version` rather than editing
the generated file by hand. The same applies to `src/lib/legalDisclaimers.js` and
`npm run legal:version`. Any change to canonical disclosure text — including a spelling
correction — requires raising `LEGAL_NOTICE_ACK_VERSION`; styling and layout changes do not. See
[../architecture/LEGAL_NOTICE_SYSTEM.md](../architecture/LEGAL_NOTICE_SYSTEM.md).

## Test layout

- Unit and component tests live in colocated `__tests__/` folders under `src/components/`,
  `src/pages/`, `src/api/` and `src/lib/`, plus `src/lib/__tests__/` and `src/tests/`.
- Fixtures live in `src/lib/__fixtures__/`.
- Deterministic mocked external-contract tests run by default; the live-network versions are
  excluded from `npm test` and run only via `npm run test:contracts:live`.
- Playwright specs live in `e2e/` and run against a built preview.
- Android instrumentation tests live in `android/app/src/androidTest/`.

Normal test discovery covers `src/**` only. Retained historical review probes are excluded from
discovery by configuration.

## Qualification evidence

The following are point-in-time qualification snapshots, not daily development commands:

| Suite | Result |
|---|---|
| JavaScript product baseline | 4,973 tests — 4,969 passed — 0 failed — 4 skipped |
| Android JVM | 47 classes — 368 tests — 0 failures / 0 errors |
| Closed-contract preservation | 337 / 337 passed |

The 4 skipped tests are pre-existing opt-in harnesses (live external contracts and replay),
excluded by design. These are software results and imply no physical-device validation.
