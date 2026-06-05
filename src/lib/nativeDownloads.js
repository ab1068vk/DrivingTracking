import DriveSenseNative from '@/lib/driveSenseNativePlugin';

const SECURE_DOWNLOAD_MIME_TYPE = 'application/octet-stream';
const ENCRYPTED_ROAD_SAGE_EXPORT_EXTENSION = /\.(rsexport|rsbackup)$/i;
const BACKUP_ENC_VERSION = 1;
const BACKUP_ENC_SALT_BYTES = 32;
const BACKUP_ENC_IV_BYTES = 12;
const BACKUP_ENC_HEADER_BYTES = 1 + BACKUP_ENC_SALT_BYTES + BACKUP_ENC_IV_BYTES;
const MIN_ENCRYPTED_EXPORT_BYTES = BACKUP_ENC_HEADER_BYTES + 16;

const decodeBase64Bytes = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const trimmed = value.trim();
    if (typeof atob === 'function') {
      return Uint8Array.from(atob(trimmed), (char) => char.charCodeAt(0));
    }
    const bufferCtor = globalThis.Buffer;
    if (typeof bufferCtor?.from === 'function') {
      return Uint8Array.from(bufferCtor.from(trimmed, 'base64'));
    }
  } catch {
    return null;
  }
  return null;
};

export function isEncryptedRoadSageDownload({ filename, data, mimeType } = {}) {
  if (!ENCRYPTED_ROAD_SAGE_EXPORT_EXTENSION.test(String(filename || '').trim())) return false;
  if (String(mimeType || '').trim().toLowerCase() !== SECURE_DOWNLOAD_MIME_TYPE) return false;
  const bytes = decodeBase64Bytes(data);
  return bytes?.[0] === BACKUP_ENC_VERSION && bytes.length > MIN_ENCRYPTED_EXPORT_BYTES;
}

/**
 * @param {{filename:string,data:string,mimeType:string,base64?:boolean}} options
 */
export async function saveExportToDownloads({ filename, data, mimeType, base64 }) {
  if (!isEncryptedRoadSageDownload({ filename, data, mimeType })) {
    throw new Error('Only encrypted Road Sage export files can be saved to Downloads.');
  }
  return DriveSenseNative.saveExportToDownloads({ filename, data, mimeType, base64 });
}

export async function openExportLocation(/** @type {any} */ { uri, mimeType } = {}) {
  return DriveSenseNative.openExportLocation({ uri, mimeType });
}
