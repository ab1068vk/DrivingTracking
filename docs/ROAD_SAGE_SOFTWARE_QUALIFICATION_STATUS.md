# Road Sage — Software Qualification Status

Project-level summary of where Road Sage stands. Detailed engineering chronology is kept
outside the repository as local working history; this document records only the final facts.

## Software baseline

- **P0–P7 and P3.5 landed.**
- **AUD-001 through AUD-008 closed.**
- **HPR-001 through HPR-019 and UA closed.**
- Baseline commit: `f087daf69dcefeadab3dedc28636181da3f75a54` (branch `LOADTIME_UX_UI_FIXS`).

That baseline was independently reconciled before landing, and no known software landing
blocker remained.

## Diagnostics qualification

A Diagnostics/Observability qualification batch was implemented after the baseline above.
It covers complete packaged-build identity, launch/session/build attribution, current-session
versus current-build versus historical health, bounded trip-window truth, collection and
replay evidence semantics, native runtime/authority semantics, a bounded campaign-state
snapshot, and privacy-preserving observability.

- Independent software review: **passed**.
- Closed-contract preservation audit: **passed, no regressions**. The Diagnostics work is
  additive and observational; it does not reopen or supersede the behavioral closure of
  P3.5, AUD-001–008, HPR-001–019 or UA.

## Software evidence

| Gate | Result |
|---|---|
| JavaScript product baseline | 4,973 tests — 4,969 passed — 0 failed — 4 skipped |
| Android JVM suite | 47 classes — 368 tests — 0 failures / 0 errors |
| Closed-contract preservation | 337 / 337 focused tests passed |
| Static gates | lint, typecheck, recovery guard, scoring-version guard, repo hygiene — all pass |

The 4 skipped tests are pre-existing opt-in harnesses (live external-contract and replay),
excluded from the default run by design.

These results are **software** evidence only. They do not imply any physical-device
validation.

## Remaining qualification

The remaining obligations are **physical-device qualifications, not known software
blockers**:

- P4 V24
- P5 V27
- P3.5 Physical H / device qualification
- P6 physical qualification
- Final A54 qualification
- Actual on-device runtime, watchdog, native bridge, process-death and scale behavior

No emulator, device, adb or instrumentation work has been performed.

## Status

Software qualification complete; Diagnostics qualification complete; physical-device
qualification remains.
