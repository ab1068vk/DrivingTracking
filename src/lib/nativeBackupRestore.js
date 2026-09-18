import { BACKUP_PASSPHRASE_MIN_LENGTH } from '@/lib/backupEnvelopeEncryption';
import { nativeTripArchive } from '@/lib/nativeTripArchive';

export const NATIVE_BACKUP_RESTORE_ERROR = Object.freeze({
  PASSWORD_REQUIRED: 'backup_password_required',
  WRONG_PASSWORD: 'backup_wrong_password',
  INVALID_OR_CORRUPT: 'native_backup_invalid_or_corrupt',
  LOW_SPACE: 'LOW_SPACE_BLOCKED',
  EMPTY_TARGET_REQUIRED: 'RESTORE_REQUIRES_EMPTY_CANONICAL_TARGET',
  CANCELLED: 'native_backup_restore_cancelled',
  INVALID_CONTENT_URI: 'RESTORE_REQUIRES_REVIEWED_CONTENT_URI',
  UNVERIFIED: 'native_backup_restore_unverified',
  OPERATION_FAILED: 'native_backup_restore_failed',
});

export class NativeBackupRestoreError extends Error {
  constructor(code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NativeBackupRestoreError';
    this.code = code;
  }
}

const defaultWait = () => new Promise((resolve) => setTimeout(resolve, 250));

const classifyTerminalFailure = (status = {}) => {
  const text = String(status?.error || status?.phase || 'Native backup restore failed.');
  if (String(status?.phase || '').toUpperCase() === 'CANCELLED') {
    return new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.CANCELLED,
      'Native backup restore was cancelled.'
    );
  }
  if (text.includes('RESTORE_REQUIRES_EMPTY_CANONICAL_TARGET')) {
    return new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.EMPTY_TARGET_REQUIRED,
      'Native restore requires an empty Road Sage trip archive. Erase local trip data first, then retry the restore.'
    );
  }
  if (text.includes('LOW_SPACE')) {
    return new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.LOW_SPACE,
      'There is not enough free storage to restore this backup safely.'
    );
  }
  if (/AEADBadTag|Tag mismatch|AUTHENTICATION_FAILED|authentication failed/i.test(text)) {
    return new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.WRONG_PASSWORD,
      'The backup password was not accepted, or the encrypted backup is damaged.'
    );
  }
  if (/magic|header|trailer|hash mismatch|corrupt|truncat|unexpected end|EOF/i.test(text)) {
    return new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.INVALID_OR_CORRUPT,
      'This is not a complete, valid Road Sage native backup.'
    );
  }
  return new NativeBackupRestoreError(
    NATIVE_BACKUP_RESTORE_ERROR.OPERATION_FAILED,
    text,
  );
};

const defaultCoordinateRollover = async (operation) => {
  const { runCanonicalGenerationRollover } = await import('@/lib/nativeProjectionBarrier');
  return runCanonicalGenerationRollover(operation, { reason: 'native_backup_restore_cutover' });
};

const defaultOnVerifiedRestore = async (result) => {
  const { publishVerifiedNativeRestore } = await import('@/api/trips');
  return publishVerifiedNativeRestore(result);
};

const throwCancelled = () => {
  throw new NativeBackupRestoreError(
    NATIVE_BACKUP_RESTORE_ERROR.CANCELLED,
    'Native backup restore was cancelled.'
  );
};

/**
 * Select and restore an RSB2 archive without admitting a browser File or any
 * artifact bytes into JavaScript. The projection barrier spans the native
 * mutation; source publication happens only after terminal native proof and
 * the barrier's post-cutover projection discard.
 */
export async function restoreNativeBackupFromDocument({
  passphrase,
  signal,
  onProgress,
  archive = nativeTripArchive,
  wait = defaultWait,
  coordinateRollover = defaultCoordinateRollover,
  onVerifiedRestore = defaultOnVerifiedRestore,
} = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.PASSWORD_REQUIRED,
      `Backup password must be at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`
    );
  }
  if (signal?.aborted) throwCancelled();

  const selected = await archive.pickStreamBackupRestoreFile();
  if (selected?.cancelled === true) throwCancelled();
  const uri = String(selected?.uri || '');
  if (!uri.toLowerCase().startsWith('content://')) {
    throw new NativeBackupRestoreError(
      NATIVE_BACKUP_RESTORE_ERROR.INVALID_CONTENT_URI,
      'Road Sage did not receive a reviewed Android document URI for this backup.'
    );
  }
  if (signal?.aborted) throwCancelled();

  let operationId = '';
  const cancel = () => {
    if (operationId) void archive.cancelStreamBackup(operationId).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await coordinateRollover(async () => {
      let status = await archive.beginStreamBackupRestoreFromUri(uri, passphrase);
      operationId = String(status?.operationId || '');
      if (!operationId) {
        throw new NativeBackupRestoreError(
          NATIVE_BACKUP_RESTORE_ERROR.OPERATION_FAILED,
          'Native backup restore did not return an operation identifier.'
        );
      }
      while (status?.done !== true) {
        if (signal?.aborted) {
          cancel();
          throwCancelled();
        }
        onProgress?.({
          phase: String(status?.phase || 'restoring').toLowerCase(),
          completed: Number(status?.completedBytes) || 0,
          total: 0,
        });
        await wait();
        if (signal?.aborted) {
          cancel();
          throwCancelled();
        }
        status = await archive.streamBackupStatus(operationId);
      }

      if (status?.verified !== true) {
        if (String(status?.phase || '').toUpperCase() === 'COMPLETE' && !status?.error) {
          throw new NativeBackupRestoreError(
            NATIVE_BACKUP_RESTORE_ERROR.UNVERIFIED,
            'Native backup restore reached completion without verification proof.'
          );
        }
        throw classifyTerminalFailure(status);
      }
      const verified = status?.result;
      if (verified?.verified !== true || verified?.authorityState !== 'NATIVE') {
        throw new NativeBackupRestoreError(
          NATIVE_BACKUP_RESTORE_ERROR.UNVERIFIED,
          'Native backup restore finished without verified canonical cutover proof.'
        );
      }
      return verified;
    });

    await onVerifiedRestore(result);
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
