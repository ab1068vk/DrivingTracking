# Diagnostics

Diagnostics produces a bounded, privacy-preserving observability report. It is an **observer**:
it reads existing owners and never mutates application, storage or lifecycle state.

## Build identity

A complete build identity is derived at build time from the packaged inputs — `src`, `public`,
project configuration, `android/app/src` and the Gradle files — as a deterministic SHA-256, then
combined into:

```
artifactId = <sourceId>:<buildType>:<flavor>:vc<versionCode>
```

Properties:

- Generated Android assets (the synced web bundle and generated Capacitor configs) are excluded,
  so the identity never fingerprints its own output.
- Two builds that differ in native source, Gradle configuration, build type, flavour or version
  code produce different identities.
- The build fails closed if the generated identity is malformed.
- The web bundle hash remains a separate field, so a web-only change is still distinguishable.

When only part of the identity is available the report says so explicitly, reporting
`complete_packaged_inputs`, `source_inputs_only` or `web_bundle_only` rather than implying a
complete identity.

## Session and build attribution

Each launch has an anonymous session identifier, and the Android process has its own anonymous
process session identifier. Neither is a user or device identity, and neither persists as a
stable identifier across installs.

Retained evidence is scoped as:

| Scope | Meaning |
|---|---|
| `current_session` | Produced by this launch |
| `current_build` | Produced by this build, an earlier launch |
| `older_build` | Produced by a different build |
| `unattributed_history` | No attribution recorded |

Evidence imported from a previous process — including Android process-exit records — is marked
historical and is never stamped as the current launch.

## Health scopes

Health is classified by severity and category, not by event name. An informational event whose
name contains "error", "freeze" or "ANR" does not count as a failure. Android process exits are
classified by the authoritative exit reason, so crashes, ANRs, native crashes, low-memory kills
and initialization failures are counted as failures while recovered stalls and pressure signals
are not.

The report separates current-session health from current-build and retained history. Older
evidence stays visible in its own scope rather than being discarded or folded into current
status.

## Trip window and population

The trip section is explicitly scoped as a bounded window. It reports the window limit, returned
row count, continuation state, page completeness and the source authority, generation and
revision.

Population totals are a **separate** structure and are reported only when an owner supplies
them: a scalar archive counter under native authority, or an indexed store count in the browser.
The snapshot is re-read before and after counting; if generation or revision moved, the report
declines the count rather than publishing a torn total. A window is never presented as the
population.

## Collection and replay categories

Collection mode is resolved from categorical evidence recorded on the trip, then from tracking
mode, and otherwise reported as unknown. A generic "native" source does not imply automatic
capture.

Replay evidence uses six states with deliberate precedence: privacy-excluded is evaluated first,
then expired, then unavailable representation, before absent is considered. An unavailable
projection is not reported as absent, and a privacy summary-only trip is not reported as having
no evidence.

## Native runtime authority

Runtime state distinguishes platform, native bridge availability, probe outcome and reason,
tracking service state, watchdog availability and configured trip authority as separate fields.
A legacy availability boolean remains but is explicitly qualified by what it measures. Build
identity is served independently of watchdog probing, so it survives a probe failure.

## Subsystem snapshot

A bounded snapshot observes canonical storage authority, archive recovery, migration, active
capture, key rotation, derived readiness, the work coordinator, road-speed state, projection
detail and background enrichment.

Each subsystem reports an explicit state. Absence of evidence is never rendered as success: a
failed status call reports `unavailable`, not `idle`. Where no bounded owner exposes a status,
the report says so — for example live backup/restore status and browser road-speed maintenance
are reported as not exposed by a bounded owner rather than guessed.

Reads are structurally bounded: fixed-cardinality primary-key lookups, single-row reads and a
capped rotation log. No status read enumerates history, decrypts routes or opens a cursor whose
cost grows with the archive.

## Privacy

The export passes a strict allowlist that admits only scalar values, scrubs strings to a safe
character set and clamps numbers. Nested objects cannot traverse it.

The report contains no coordinates, route geometry, trip identifiers, vehicle identity, trip
dates, notes, raw error text, stack traces, payloads, key material or stable user/device
identity. Trip shapes are reduced to rounded distance, duration and point counts plus
categorical states; timestamps are consumed only to derive a duration.

## Limitations

Diagnostics reports software-observable state. Actual on-device runtime, bridge, watchdog,
process-death and scale behaviour is a physical-device obligation; see
[../operations/DEVICE_QUALIFICATION.md](../operations/DEVICE_QUALIFICATION.md).
