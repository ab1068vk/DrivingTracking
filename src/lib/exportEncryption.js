import { encryptBackup } from '@/lib/backupEncryption';

export function encryptedExportFilename(filename, extension = '.rsexport') {
  const base = String(filename || `road-sage-export-${new Date().toISOString().split('T')[0]}`)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\.[a-z0-9]+$/i, '');
  return `${base}${extension}`;
}

export async function buildEncryptedExport({ filename, mimeType, data, password, kind = 'generic' }) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Export password must be at least 12 characters.');
  }

  const payload = {
    app: 'Road Sage',
    version: 1,
    kind,
    filename,
    mimeType,
    createdAt: new Date().toISOString(),
    data,
  };

  return encryptBackup(JSON.stringify(payload), password);
}
