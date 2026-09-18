# Architecture Overview

This document describes the system as implemented. It replaces earlier roadmap-phase framing:
the mechanisms below are in the product, not planned.

## Layers

| Layer | Responsibility |
|---|---|
| React/Vite web app | User interface, scoring pipeline, report generation |
| Capacitor bridge | Typed plugin calls between the web app and Android |
| Android native services | Background capture, activity recognition, durable archive, observability |

## Trip authority

Trip records never resolve through a remote API. `src/api/trips.js` exposes
`shouldUseLocalStore()`, which returns `true` unconditionally, and selects one of two local
repositories:

- **Browser authority** — `src/lib/localTripRepository.js`, backed by IndexedDB. This is the
  configuration that ships.
- **Native archive authority** — `src/lib/nativeTripRepository.js` over the Android SQLite
  archive, gated behind `VITE_P35_NATIVE_AUTHORITY`.

`src/api/client.js` is a thin fetch wrapper used only for non-trip, backend-optional resources.
It throws when `VITE_API_URL` is unset rather than silently falling back to a local host.
Authentication tokens live in `sessionStorage` only, so cross-site scripting cannot lift a
long-lived credential.

## Capture

Capture runs in one of three modes, recorded categorically on each trip rather than inferred:

- manual (browser or native),
- foreground auto-detect,
- Android native background auto tracking.

The native service combines activity recognition with a GPS fallback, maintains a foreground
notification, and supports pause/resume and a quick-settings tile. Active capture is
checkpointed so an interrupted session can resume rather than being discarded.

## Storage and query model

Completed trips are held in a durable archive. Reads are **bounded pages**, never whole-history
scans. Every page carries:

- the returned row count and the requested limit,
- a continuation indicator,
- completeness (exact or partial),
- the source authority, generation and revision the page was taken from.

Population totals are reported separately from the page and only when an owner can supply them
cheaply — a scalar archive counter or an indexed store count. A page is never presented as the
total population.

Detail and analytics surfaces resolve an explicitly requested trip identity directly rather than
scanning a page window for it.

## Durability and recovery

See [DATA_STORAGE_AND_LIFECYCLE.md](DATA_STORAGE_AND_LIFECYCLE.md). In summary:

- Archive startup recovery is admitted **once per process** through the storage coordinator.
- Ordinary repository construction is not process startup and does not re-run recovery.
- A failed bootstrap remains retryable.
- Interrupted checkpoint reconciliation is independently idempotent.

## Key and payload lifecycle

Trip payloads are encrypted at rest. Key rotation and key-encryption-key rotation are bounded,
resumable operations with explicit state; rotation fails closed rather than retiring a key whose
references cannot be proven resolved.

## Privacy boundaries

Privacy zones and private-trip mode mask routes and events near protected places. Backups never
restore private coordinates. Retention limits and data-rights erasure remove both records and
derived residue. A privacy audit chain records protection-relevant operations.

## Observability

Diagnostics observes the owners above without becoming one. All Diagnostics reads are read-only
and structurally bounded. See [DIAGNOSTICS.md](DIAGNOSTICS.md).

## Scaling posture

The bounded-page model, scalar population counts and fixed-cardinality status reads are intended
to keep cost flat as history grows. Structural boundedness is covered by retained JavaScript and
JVM regression suites. Behaviour on physical hardware at scale remains a device-qualification
obligation.
