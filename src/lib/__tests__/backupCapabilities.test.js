import { describe, expect, it } from 'vitest';
import {
  BACKUP_AUTHORITY,
  BACKUP_EXPORT_FORMAT,
  BACKUP_IMPORT_FORMAT,
  resolveBackupCapabilities,
} from '@/lib/backupCapabilities';

describe('HPR-B2 backup authority capabilities', () => {
  it('keeps Android on browser JSON backup when browser storage is canonical', () => {
    const capabilities = resolveBackupCapabilities({
      platform: 'android',
      nativeAuthorityEnabled: false,
    });

    expect(capabilities).toMatchObject({
      authority: BACKUP_AUTHORITY.BROWSER,
      exportFormats: [BACKUP_EXPORT_FORMAT.ENCRYPTED_JSON, BACKUP_EXPORT_FORMAT.READABLE_JSON],
      importFormats: [BACKUP_IMPORT_FORMAT.ENCRYPTED_JSON, BACKUP_IMPORT_FORMAT.READABLE_JSON],
      readableExportAvailable: true,
      browserJsonExportAvailable: true,
      browserJsonRestoreAvailable: true,
      nativeStreamExportAvailable: false,
      nativeUriRestoreAvailable: false,
    });
  });

  it('offers only the bounded native archive pipeline under guarded native authority', () => {
    const capabilities = resolveBackupCapabilities({
      platform: 'android',
      nativeAuthorityEnabled: true,
    });

    expect(capabilities).toMatchObject({
      authority: BACKUP_AUTHORITY.NATIVE,
      exportFormats: [BACKUP_EXPORT_FORMAT.NATIVE_RSB2],
      importFormats: [BACKUP_IMPORT_FORMAT.NATIVE_RSB2],
      readableExportAvailable: false,
      browserJsonExportAvailable: false,
      browserJsonRestoreAvailable: false,
      nativeStreamExportAvailable: true,
      nativeUriRestoreAvailable: true,
    });
  });

  it('never enables native archive ownership on a non-Android platform', () => {
    expect(resolveBackupCapabilities({
      platform: 'web',
      nativeAuthorityEnabled: true,
    })).toMatchObject({
      authority: BACKUP_AUTHORITY.BROWSER,
      readableExportAvailable: true,
      nativeStreamExportAvailable: false,
      nativeUriRestoreAvailable: false,
    });
  });
});
