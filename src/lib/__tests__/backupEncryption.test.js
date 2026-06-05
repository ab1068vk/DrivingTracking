import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '@/lib/backupEncryption';

describe('backup encryption', () => {
  it('round-trips plaintext with AES-GCM password encryption', async () => {
    const encrypted = await encryptBackup('{"app":"Road Sage","trips":[]}', 'correct horse battery');

    expect(isEncryptedBackup(encrypted)).toBe(true);
    await expect(decryptBackup(encrypted, 'correct horse battery')).resolves.toBe('{"app":"Road Sage","trips":[]}');
  });

  it('rejects the wrong password', async () => {
    const encrypted = await encryptBackup('private backup', 'correct horse battery');

    await expect(decryptBackup(encrypted, 'incorrect horse battery')).rejects.toMatchObject({
      name: 'OperationError',
    });
  });
});
