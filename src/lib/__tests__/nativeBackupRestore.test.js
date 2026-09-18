import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_BACKUP_RESTORE_ERROR,
  restoreNativeBackupFromDocument,
} from '@/lib/nativeBackupRestore';

const successfulResult = Object.freeze({
  verified: true,
  operationId: 'restore-1',
  tripCount: 17,
  speedBucketCount: 4,
  portableDomainCount: 2,
  authorityState: 'NATIVE',
});

const createArchive = (statuses = []) => ({
  pickStreamBackupRestoreFile: vi.fn(async () => ({
    uri: 'content://com.android.providers.downloads.documents/document/road-sage.rsb2',
    name: 'road-sage.rsb2',
  })),
  beginStreamBackupRestoreFromUri: vi.fn(async () => ({
    operationId: 'restore-1',
    phase: 'STAGING_INPUT',
    done: false,
    verified: false,
  })),
  streamBackupStatus: vi.fn(async () => statuses.shift()),
  cancelStreamBackup: vi.fn(async () => ({ cancelled: true })),
});

describe('HPR-B2 native URI restore lifecycle', () => {
  it('uses a content URI and waits for verified terminal completion before cutover publication', async () => {
    const archive = createArchive([
      { operationId: 'restore-1', phase: 'VERIFYING', done: false, verified: false, completedBytes: 512 },
      { operationId: 'restore-1', phase: 'COMPLETE', done: true, verified: true, result: successfulResult },
    ]);
    const events = [];
    const coordinateRollover = vi.fn(async (operation) => {
      events.push('rollover-start');
      const result = await operation();
      events.push('rollover-verified');
      return result;
    });
    const onVerifiedRestore = vi.fn(async () => events.push('published'));

    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive,
      wait: vi.fn(async () => {}),
      coordinateRollover,
      onVerifiedRestore,
    })).resolves.toMatchObject(successfulResult);

    expect(archive.pickStreamBackupRestoreFile).toHaveBeenCalledOnce();
    expect(archive.beginStreamBackupRestoreFromUri).toHaveBeenCalledWith(
      'content://com.android.providers.downloads.documents/document/road-sage.rsb2',
      'Correct!Password'
    );
    expect(archive.streamBackupStatus).toHaveBeenCalledTimes(2);
    expect(onVerifiedRestore).toHaveBeenCalledWith(successfulResult);
    expect(events).toEqual(['rollover-start', 'rollover-verified', 'published']);
  });

  it('does not treat a started or pending operation as success', async () => {
    const archive = createArchive([
      { operationId: 'restore-1', phase: 'STAGING_INPUT', done: false, verified: false },
      { operationId: 'restore-1', phase: 'IMPORTING', done: false, verified: false },
      { operationId: 'restore-1', phase: 'COMPLETE', done: true, verified: true, result: successfulResult },
    ]);
    const onVerifiedRestore = vi.fn();

    await restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive,
      wait: vi.fn(async () => {}),
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore,
    });

    expect(archive.streamBackupStatus).toHaveBeenCalledTimes(3);
    expect(onVerifiedRestore).toHaveBeenCalledOnce();
  });

  it.each([
    ['wrong password', 'SecurityException: RESTORE_AUTHENTICATION_FAILED', NATIVE_BACKUP_RESTORE_ERROR.WRONG_PASSWORD],
    ['corrupt header', 'IllegalArgumentException: BACKUP_MAGIC_INVALID', NATIVE_BACKUP_RESTORE_ERROR.INVALID_OR_CORRUPT],
    ['low storage', 'IllegalStateException: LOW_SPACE_BLOCKED', NATIVE_BACKUP_RESTORE_ERROR.LOW_SPACE],
    ['non-empty target', 'IllegalStateException: RESTORE_REQUIRES_EMPTY_CANONICAL_TARGET', NATIVE_BACKUP_RESTORE_ERROR.EMPTY_TARGET_REQUIRED],
    ['operation failure', 'IllegalStateException: unexpected restore failure', NATIVE_BACKUP_RESTORE_ERROR.OPERATION_FAILED],
  ])('keeps %s terminal state failed and never publishes a source refresh', async (_label, error, code) => {
    const archive = createArchive([
      { operationId: 'restore-1', phase: 'FAILED', done: true, verified: false, error },
    ]);
    const onVerifiedRestore = vi.fn();

    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive,
      wait: vi.fn(async () => {}),
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore,
    })).rejects.toMatchObject({ code });

    expect(onVerifiedRestore).not.toHaveBeenCalled();
  });

  it('treats picker and native-operation cancellation as cancellation, never success', async () => {
    const pickerCancelled = createArchive();
    pickerCancelled.pickStreamBackupRestoreFile.mockResolvedValue({ cancelled: true });
    const onVerifiedRestore = vi.fn();

    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive: pickerCancelled,
      wait: vi.fn(async () => {}),
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore,
    })).rejects.toMatchObject({ code: NATIVE_BACKUP_RESTORE_ERROR.CANCELLED });

    const operationCancelled = createArchive([
      { operationId: 'restore-1', phase: 'CANCELLED', done: true, verified: false },
    ]);
    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive: operationCancelled,
      wait: vi.fn(async () => {}),
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore,
    })).rejects.toMatchObject({ code: NATIVE_BACKUP_RESTORE_ERROR.CANCELLED });

    expect(onVerifiedRestore).not.toHaveBeenCalled();
  });

  it('cancels the admitted native operation when the caller aborts', async () => {
    const controller = new AbortController();
    const archive = createArchive([
      { operationId: 'restore-1', phase: 'IMPORTING', done: false, verified: false },
    ]);
    const wait = vi.fn(async () => controller.abort());

    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive,
      signal: controller.signal,
      wait,
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore: vi.fn(),
    })).rejects.toMatchObject({ code: NATIVE_BACKUP_RESTORE_ERROR.CANCELLED });

    expect(archive.cancelStreamBackup).toHaveBeenCalledWith('restore-1');
  });

  it('rejects terminal done without native verification or native authority proof', async () => {
    const archive = createArchive([
      { operationId: 'restore-1', phase: 'COMPLETE', done: true, verified: false, result: successfulResult },
    ]);
    await expect(restoreNativeBackupFromDocument({
      passphrase: 'Correct!Password',
      archive,
      wait: vi.fn(async () => {}),
      coordinateRollover: (operation) => operation(),
      onVerifiedRestore: vi.fn(),
    })).rejects.toMatchObject({ code: NATIVE_BACKUP_RESTORE_ERROR.UNVERIFIED });
  });
});
