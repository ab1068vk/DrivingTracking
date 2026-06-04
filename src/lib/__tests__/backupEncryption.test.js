import { describe, expect, it } from 'vitest';
import {
  decryptBackup,
  encryptBackup,
  getBackupPasswordValidation,
  isEncryptedBackup,
} from '@/lib/backupEncryption';

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

  it('enforces strong passwords for new encrypted exports', async () => {
    expect(getBackupPasswordValidation('short').valid).toBe(false);
    expect(getBackupPasswordValidation('Correct123!').valid).toBe(false);
    expect(getBackupPasswordValidation('Correct123!Road').valid).toBe(true);
    expect(getBackupPasswordValidation('correct horse battery').valid).toBe(true);

    await expect(encryptBackup('private backup', 'alllowercase12')).rejects.toThrow('upper and lower case');
    await expect(encryptBackup('private backup', 'a'.repeat(129))).rejects.toThrow('12-128 characters');
  });

  it('keeps import validation compatible with older 12-character passwords', () => {
    expect(getBackupPasswordValidation('alllowercase12', { requireStrong: false }).valid).toBe(true);
    expect(getBackupPasswordValidation('too-short', { requireStrong: false }).valid).toBe(false);
  });
});
