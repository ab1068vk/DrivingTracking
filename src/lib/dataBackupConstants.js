/**
 * The backup envelope version, mirrored here for display surfaces.
 *
 * `dataBackup.js` remains the declaring owner: `scripts/check-recovery-contract.mjs`
 * pins the literal `export const BACKUP_VERSION = 10;` there as an upgrade-safety
 * tripwire, so that declaration must not move. This dependency-free mirror lets
 * Diagnostics state the real version without statically importing the whole
 * backup implementation into its chunk, and
 * `p6AuthorityDispatch.test.js` fails if the two ever disagree — which is how
 * the hardcoded "v9" label silently drifted a version behind for three months.
 */
export const BACKUP_VERSION = 10;

export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
export const BACKUP_TOO_LARGE_MESSAGE = 'Backup file is too large. Please choose a Road Sage backup that is 128 MB or smaller.';
export const BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE = 'Backup expands beyond the safe 256 MB import limit.';
export const BACKUP_SIGNATURE_INVALID_CODE = 'BACKUP_SIGNATURE_INVALID';
