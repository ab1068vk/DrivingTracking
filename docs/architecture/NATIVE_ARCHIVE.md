# Native Archive, Journal and Control Plane

Canonical sources under `android/app/src/main/java/com/drivesense/app/`:
`DriveSenseTripArchiveRepository`, `DriveSenseArchiveOpenHelper`, `DriveSenseStorageCoordinator`,
`DriveSenseArchiveRecovery`, `DriveSenseArchiveMigration`, `DriveSenseArchiveIntegrity`,
`DriveSenseArchiveUnlinkDebt`, `DriveSenseArchiveSentinelStore`, `DriveSenseTripChunkStore`,
`DriveSenseCompletedTripJournal`, `DriveSenseJournalControlPlane`, `DriveSenseActiveTripSpool`,
`DriveSenseArchivePlugin`.

This is the Android SQLite persistence model. It is the authority when
`VITE_P35_NATIVE_AUTHORITY` selects native authority, and it is always the durable landing place
for natively captured trips.

## Component responsibilities

| Component | Responsibility |
|---|---|
| Storage coordinator | Process-wide singleton owning the database and read/write/exclusive access; admits startup recovery once per process |
| Archive repository | Trip admission, commit of an operation-owned spool, paged reads |
| Open helper | Schema creation and upgrade |
| Chunk store | Chunked payload storage |
| Active trip spool | In-progress capture bytes |
| Completed trip journal | Durable handoff of finalised trips awaiting admission |
| Journal control plane | Journal state, pending pages and acknowledgement |
| Archive recovery | Startup reconciliation of interrupted operations |
| Archive migration | Chunked ingress for import and direct commit |
| Archive integrity | Interrupted-checkpoint reconciliation and integrity checks |
| Unlink debt | Deferred, fenced deletion of orphaned payload files |
| Sentinel store | Catalogue sentinel used to detect inconsistency |

## Access model

All database work goes through the coordinator, which distinguishes:

- `read` — read-lock access,
- `write` — serialised writer access,
- `exclusive` — exclusive access for authority-changing operations.

Diagnostics and status paths use `read` only.

## Control rows

The archive keeps control state alongside trip data. `archive_meta` (single row, id = 1) holds
`archive_generation`, `authority_state`, `recovery_state`, `last_committed_seq`, `live_count`,
`tip_chain_hash`, `pending_count`, `projection_required_seq` and `updated_at_ms`.

`open_operations` tracks in-flight operations with `operation_id`, `operation_type`, `state` and
`owner_token`. `migration_ingress` tracks chunked ingress including `next_chunk_index`,
`received_bytes`, `expected_bytes`, `source_hash` and `temp_path`. `p6_control` holds derived-domain
readiness per domain.

Because `archive_meta.live_count` is a maintained counter, a population total is a single
primary-key read rather than a scan.

## Trip admission

A completed trip is committed from an operation-owned disk spool. The commit canonicalises the
spool without loading the whole payload into memory, and the caller retains ownership of the
source spool until the commit returns verified. Admission advances the committed sequence and the
live count inside the same transaction.

## Migration ingress

Chunked ingress is used for imports and direct commits:

1. The chunk is appended to the spool and `fsync`-ed **before** any transaction opens.
2. A compare-and-swap advances `next_chunk_index` only if the expected index still matches and the
   operation is still `RECEIVING`, verified by a changed-row check.
3. Ownership is refreshed **inside the same transaction** that records progress.

The durable chunk index is therefore monotonic. Duplicate chunks and reset-to-zero attempts are
refused structurally. A resumed `finish` refreshes ownership even when it is the first operation
after a restart.

## Ownership and recovery

Startup recovery is admitted **once per process** by the coordinator's synchronized, lazily
initialised bootstrap: the initialised guard is checked, recovery runs, and only then is the
completion flag set — so a failed bootstrap remains retryable.

**Repository construction is not process startup.** A repository is constructed during ordinary
completed-trip admission; treating that as a process replacement would let live work be misread as
abandoned. Repositories delegate to the coordinator instead.

Ownership uses a per-incarnation token persisted on the operation row. Only an ingress explicitly
released by a *different* incarnation may be reclaimed. A missing operation row is staged
conservatively rather than deleted on that basis alone.

## Unlink debt

Deletion of orphaned payload files is deferred and fenced. Only an explicitly released ingress is
non-blocking; every other open operation and state blocks destructive cleanup. Failed unlinks
retain the obligation and retry, and the spool bytes are removed before the rows that describe
them.

## Journal and drain

Natively finalised trips are written to the completed-trip journal, then drained into the archive.
The control plane exposes bounded pending pages and requires explicit acknowledgement after
verified persistence, so an unacknowledged entry is retried rather than lost.

## Failure semantics

| Failure | Behaviour |
|---|---|
| Process death during ingress | Chunk index resumes from durable progress |
| Process death during admission | Journal entry remains unacknowledged and is retried |
| Interrupted checkpoint | Reconciled idempotently on next admission |
| Failed unlink | Debt retained and retried |
| Sentinel or catalogue mismatch | Recovery state reports the inconsistency |
| Failed bootstrap | Retryable within the same incarnation |

## Boundedness

Recovery is proportional to interrupted ingress and open operations plus migration spool entries —
not to trip history. Status reads are primary-key lookups. The archive plugin enforces request and
response byte ceilings.

## Testing

Covered by JVM/Robolectric suites for migration, active spool and spool fault matrices, checkpoint
faults, integrity, rotation faults, integrated erasure, large trips, scale, backup/restore ingress
and archive plugin argument contracts. Physical storage and real process-death behaviour are
device-qualification obligations.
