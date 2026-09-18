import { getNativePlatform } from '@/lib/nativePlatform';

export const BACKUP_AUTHORITY = Object.freeze({
  BROWSER: 'browser',
  NATIVE: 'native',
});

export const BACKUP_EXPORT_FORMAT = Object.freeze({
  ENCRYPTED_JSON: 'encrypted-json',
  READABLE_JSON: 'readable-json',
  NATIVE_RSB2: 'native-rsb2',
});

export const BACKUP_IMPORT_FORMAT = Object.freeze({
  ENCRYPTED_JSON: 'encrypted-json',
  READABLE_JSON: 'readable-json',
  NATIVE_RSB2: 'native-rsb2',
});

// This is the same guarded release selection used by the canonical trip
// repository. In a guarded build the native archive is the only permitted
// backup owner; a health/migration refusal must fail closed rather than turning
// disposable IndexedDB into a backup authority.
export const P35_NATIVE_BACKUP_AUTHORITY_ENABLED = (
  import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true'
);

const browserCapabilities = () => Object.freeze({
  authority: BACKUP_AUTHORITY.BROWSER,
  exportFormats: Object.freeze([
    BACKUP_EXPORT_FORMAT.ENCRYPTED_JSON,
    BACKUP_EXPORT_FORMAT.READABLE_JSON,
  ]),
  importFormats: Object.freeze([
    BACKUP_IMPORT_FORMAT.ENCRYPTED_JSON,
    BACKUP_IMPORT_FORMAT.READABLE_JSON,
  ]),
  readableExportAvailable: true,
  browserJsonExportAvailable: true,
  browserJsonRestoreAvailable: true,
  nativeStreamExportAvailable: false,
  nativeUriRestoreAvailable: false,
  importAccept: 'application/json,application/vnd.road-sage.backup+json,application/octet-stream,text/plain,.json,.drivesensebackup,*/*',
});

const nativeCapabilities = () => Object.freeze({
  authority: BACKUP_AUTHORITY.NATIVE,
  exportFormats: Object.freeze([BACKUP_EXPORT_FORMAT.NATIVE_RSB2]),
  importFormats: Object.freeze([BACKUP_IMPORT_FORMAT.NATIVE_RSB2]),
  readableExportAvailable: false,
  browserJsonExportAvailable: false,
  browserJsonRestoreAvailable: false,
  nativeStreamExportAvailable: true,
  nativeUriRestoreAvailable: true,
  importAccept: null,
});

/**
 * One authority-derived capability truth for every backup surface and entry
 * point. Platform identity is only one input: Android without the guarded
 * native-authority release flag remains browser-authoritative.
 */
export function resolveBackupCapabilities({
  platform = getNativePlatform(),
  nativeAuthorityEnabled = P35_NATIVE_BACKUP_AUTHORITY_ENABLED,
} = {}) {
  return platform === 'android' && nativeAuthorityEnabled === true
    ? nativeCapabilities()
    : browserCapabilities();
}
