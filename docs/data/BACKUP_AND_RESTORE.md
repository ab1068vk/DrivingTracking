# Backup, Restore and Data Portability

Canonical sources: `src/lib/dataBackup.js` (one of the largest modules),
`src/lib/dataBackupConstants.js`, `src/lib/dataBackupPresentation.js`,
`src/lib/nativeBackupRestore.js`, and on Android `DriveSenseStreamBackupManager`,
`DriveSenseStreamBackupRestore`, `DriveSenseStreamBackupMimeContract`,
`DriveSenseBackupExportService`.

## Purpose

Let a user move their data to a new device or keep an off-device copy, without weakening the
local-first privacy model.

## Format and versioning

Backups are **versioned and encrypted**. `dataBackupConstants.js` declares the supported format
versions and import limits; the implementation carries migration paths across historical versions
so an older backup remains importable.

A backup records its format version and provenance. Import dispatches on that version rather than
assuming the current shape.

## Export

Export streams rather than materialising the whole archive in memory. On Android, streaming export
is owned by the stream backup manager with an export **lease**: the lease is held for the duration
of the operation and is only reported closed after release is committed and a direct owner read
proves the lease row is gone. A cancellation request is not itself a close event.

Payloads are encrypted. A passphrase-protected portable backup uses a memory-hard key-derivation
function so the archive is not trivially brute-forced offline.

## Import

Imported data is treated as **untrusted**:

- structure and integrity are validated before anything is written,
- unknown or malformed content is refused rather than partially applied,
- an import that would truncate existing notes requires **explicit user confirmation**,
- private coordinates are never restored.

That last point is a deliberate privacy property: a backup does not become a mechanism for
resurrecting location detail the user chose to protect.

## Native restore ownership

Under native authority, restore runs through a bounded native owner with its own operation type
(`BACKUP_V2_RESTORE`) in the open-operations table. That operation blocks destructive cleanup
while it is live, so a restore in progress cannot be undercut by deletion work. See
[../architecture/NATIVE_ARCHIVE.md](../architecture/NATIVE_ARCHIVE.md).

## Restore and retention ordering

Restore interacts with retention. The ordering is explicit so that restored rows are not
immediately reaped, and retention does not perform repeated whole-history scans while a restore is
being applied. Retention is a bounded, ordered operation.

## Key interaction

Restoring encrypted payloads requires the corresponding key material to be derivable. Key rotation
and backup interact: a backup is bound to the key state that produced it. Rotation is fail-closed
and will not retire a key whose references cannot be proven resolved. See
[../security/KEY_LIFECYCLE_AND_SECURE_BRIDGE.md](../security/KEY_LIFECYCLE_AND_SECURE_BRIDGE.md).

## Failure semantics

| Failure | Behaviour |
|---|---|
| Interrupted export | Lease not reported closed; operation retried or reported failed |
| Interrupted restore | Operation remains open and blocking; resumed or reconciled |
| Integrity validation failure | Refused; nothing written |
| Unknown format version | Refused rather than guessed |
| Wrong passphrase | Reported as a password requirement, not as corruption |
| Note-truncating import | Requires explicit confirmation before proceeding |

## Scale

Export and restore stream and are frame-bounded. Neither accumulates the full archive in memory.
Restore batches interact with retention in bounded turns.

## Operational guidance

- Take a backup before an upgrade that changes storage or settings behaviour.
- Verify a restore on the target device before relying on it; an exported file that has never been
  restored is an untested backup.
- Keep the passphrase with the backup owner — there is no recovery path for a lost passphrase.
- Backups contain personal driving data. Treat the exported file with the same care as the device.

## Testing

`dataBackupImportSecurity`, `dataBackupPresentation`, `hprB1RestoreRetention`,
`hprB2DataBackupAuthority`, `p6RestoreBinding`, and the Android backup lifecycle, backup/restore
and restore-ingress suites.
