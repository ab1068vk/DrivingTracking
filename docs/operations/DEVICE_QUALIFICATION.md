# Device Qualification

Software qualification is complete. Physical-device qualification is outstanding. This document
records what remains and why it cannot be closed by the automated suites.

## Status

| Track | State |
|---|---|
| Software qualification | Complete |
| Diagnostics software qualification | Complete |
| Physical-device qualification | **Pending** |

No release or device qualification claim is made.

## Why software suites are not sufficient

The JavaScript and JVM suites run against simulated storage, mocked bridges and Robolectric
shadows. They establish structure, ordering, boundedness and refusal behaviour. They cannot
establish real operating-system behaviour: actual process death and restart timing, real
background execution limits, genuine sensor and GPS behaviour, real thermal and memory
pressure, or true storage performance at scale.

## Outstanding obligations

- In-place upgrade verification on a physical device, per
  [RELEASE_AND_VERSIONING.md](RELEASE_AND_VERSIONING.md).
- Durability and recovery behaviour under real process death and low-memory kills.
- Background auto-tracking behaviour under real activity recognition and OS scheduling.
- Native bridge, watchdog probing and process-exit attribution on device.
- Capture fidelity and detection behaviour on real drives.
- Performance and boundedness at realistic history sizes on device hardware.

## Diagnostics role

The Diagnostics report is the intended instrument for this qualification. It reports build
identity, launch and build attribution, health scopes, bounded window and population metadata,
collection and replay categories, native runtime authority state and a bounded subsystem
snapshot — without exporting personal data.

Diagnostics output describes software-observable state only. A green Diagnostics report is not
by itself evidence of device qualification.

## Constraints

Device work is a separate, explicitly authorised activity. It is not started implicitly by
software changes, and installed builds on any device should not be assumed to match the current
working tree.
