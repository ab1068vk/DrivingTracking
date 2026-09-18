# Data Storage, Durability and Recovery

This document supersedes the earlier `RECOVERY_PLAN.md`, which described recovery as future
work. Recovery, migration and checkpointed capture are implemented. This describes the
behaviour as built, and retains the compatibility contract that still governs the Android
package.

## Upgrade compatibility contract

These constraints are enforced by `npm run recovery:guard`, which runs as part of `prebuild`
and `pretest`. Changing them breaks in-place upgrades for existing installations.

- Android `applicationId`, Gradle `namespace` and Java package remain `com.drivesense.app`.
- The Capacitor `appId` remains `com.drivesense.app`.
- Web settings and the Android quick-settings tile share the `drivesense_settings` key.
- Android `versionCode` may only increase.
- Existing settings, trips, vehicles, permissions and tile state must survive an APK upgrade.

Current Android identity: `versionCode = 3`, `versionName = "1.1.0"`.

## Active capture durability

An in-progress trip is checkpointed to durable storage as it is captured, rather than held only
in memory. If the process is replaced mid-trip, the checkpoint is reconciled on the next start
and the session resumes instead of being lost. Checkpoint reconciliation is independently
idempotent: running it more than once produces the same result and never reclaims migration
ingress.

## Completed-trip archive

Completed trips are committed to a durable archive. A commit canonicalises an
operation-owned disk spool without loading the whole payload into memory, and the caller retains
ownership of the source spool until the commit returns verified.

The archive maintains generation and revision markers so a reader can tell whether a page and a
population count were taken from the same consistent state.

## Migration ingress

Import and direct-commit ingress is chunked and durable:

1. The chunk is written to the spool and `fsync`-ed **before** any transaction opens.
2. A compare-and-swap advances the durable chunk index only if the expected index still matches
   and the operation is still receiving, verified through a changed-row check.
3. Ownership is refreshed **inside the same transaction** that records progress.

Consequently the durable chunk index is monotonic. Duplicate chunks and reset-to-zero attempts
are structurally refused rather than tolerated. A resumed ingress that completes its final chunk
refreshes ownership even when the finish is the first operation after a restart.

## Process-lifetime recovery

Archive startup recovery is admitted **once per process** by the storage coordinator, which is a
process-wide singleton with a synchronized, lazily initialised bootstrap:

- the initialised guard is checked first,
- recovery runs,
- the completion flag is set only after recovery succeeds, so a failed bootstrap stays
  retryable.

**Ordinary repository construction is not process startup.** Repositories delegate to the
coordinator's bootstrap; they do not run recovery themselves. This matters because a repository
is constructed during routine completed-trip admission, and treating that as a process
replacement would let live work be misread as abandoned.

Ownership uses a per-incarnation token persisted with the operation row. Only an ingress that
was explicitly released by a *different* process incarnation may be reclaimed. A missing
operation row is staged conservatively, never deleted outright on that basis alone.

## Unlink debt and erasure fences

Deferred unlink work is retryable and fenced: only an explicitly released ingress is
non-blocking. Every other open operation and state still blocks destructive cleanup. Erasure
removes derived residue as well as records, and cannot be bypassed by an observational read.

## Backup and restore

Portable backups are versioned and encrypted, treat imported data as untrusted, and require
explicit confirmation before any import that would truncate existing notes. Private coordinates
are never restored. Restore and retention interact through a bounded, ordered path rather than
repeated whole-history scans.

## Verification

These contracts are covered by retained JVM/Robolectric suites for the native archive,
migration, checkpoint and recovery behaviour, and by JavaScript regression suites for the
repository, backup and erasure paths. Physical-device upgrade and durability behaviour remains
a device-qualification obligation; see
[../operations/DEVICE_QUALIFICATION.md](../operations/DEVICE_QUALIFICATION.md).
