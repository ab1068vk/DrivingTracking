import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEncryptedExport, encryptedExportFilename } from '@/lib/exportEncryption';
import { assertPlayIntegrityForSensitiveAction } from '@/lib/nativePlayIntegrity';
import { encryptBackup } from '@/lib/backupEncryption';

vi.mock('@/lib/nativePlayIntegrity', () => ({
  assertPlayIntegrityForSensitiveAction: vi.fn(),
}));

vi.mock('@/lib/backupEncryption', () => ({
  encryptBackup: vi.fn(async (plaintext, password) => `encrypted:${password}:${plaintext}`),
}));

describe('encrypted export wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes export filenames to the encrypted wrapper extension', () => {
    expect(encryptedExportFilename('road:sage/report.csv')).toBe('road-sage-report.rsexport');
  });

  it('requires Play Integrity attestation for exports without blocking on backend verification', async () => {
    const encrypted = await buildEncryptedExport({
      filename: 'trip-report.csv',
      mimeType: 'text/csv',
      data: 'score,route',
      password: 'correct horse battery',
      kind: 'csv',
    });

    expect(assertPlayIntegrityForSensitiveAction).toHaveBeenCalledWith('export:csv', {
      requireServerVerification: false,
    });
    expect(encryptBackup).toHaveBeenCalledWith(expect.stringContaining('"kind":"csv"'), 'correct horse battery');
    expect(encrypted).toContain('trip-report.csv');
  });

  it('rejects weak export passwords before preparing export content', async () => {
    await expect(buildEncryptedExport({
      filename: 'trip-report.csv',
      mimeType: 'text/csv',
      data: 'score,route',
      password: 'short',
      kind: 'csv',
    })).rejects.toThrow('Export password must be at least 12 characters.');

    expect(assertPlayIntegrityForSensitiveAction).not.toHaveBeenCalled();
    expect(encryptBackup).not.toHaveBeenCalled();
  });
});
