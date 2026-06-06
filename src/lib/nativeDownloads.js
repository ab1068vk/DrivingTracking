import DriveSenseNative from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

const extensionOf = (filename = '') => {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
};

/**
 * @param {{filename:string,data:string,mimeType:string,base64?:boolean}} options
 */
export async function saveExportToDownloads({ filename, data, mimeType, base64 }) {
  try {
    const result = await DriveSenseNative.saveExportToDownloads({ filename, data, mimeType, base64 });
    recordSystemEvent('native_export_saved', {
      extension: extensionOf(filename),
      mime_type: mimeType,
      byte_count: String(data || '').length,
      base64: base64 === true,
      has_uri: Boolean(result?.uri),
    }, { category: 'storage', source: 'android', title: 'Native export saved' });
    return result;
  } catch (error) {
    logSystemFailure('native_export_save', error, {
      extension: extensionOf(filename),
      mime_type: mimeType,
      byte_count: String(data || '').length,
      base64: base64 === true,
    });
    throw error;
  }
}

export async function openExportLocation(/** @type {any} */ { uri, mimeType } = {}) {
  try {
    const result = await DriveSenseNative.openExportLocation({ uri, mimeType });
    recordSystemEvent('native_export_opened', {
      mime_type: mimeType,
      has_uri: Boolean(uri),
    }, { category: 'storage', source: 'android', title: 'Native export opened' });
    return result;
  } catch (error) {
    logSystemFailure('native_export_open', error, {
      mime_type: mimeType,
      has_uri: Boolean(uri),
    });
    throw error;
  }
}
