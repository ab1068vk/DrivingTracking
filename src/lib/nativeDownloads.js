import DriveSenseNative from '@/lib/driveSenseNativePlugin';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { Capacitor } from '@capacitor/core';

const extensionOf = (filename = '') => {
  const match = String(filename || '').match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
};

const NATIVE_EXPORT_CHUNK_CHARS = 192 * 1024;
const NATIVE_EXPORT_CHUNK_THRESHOLD = 1024 * 1024;

export async function startBackupExportProgressNotification({ label = 'Preparing backup', progress = 0 } = {}) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  try {
    return await DriveSenseNative.startBackupExportTask({ label, progress });
  } catch (error) {
    logSystemFailure('backup_export_foreground_start', error);
    return null;
  }
}

export async function updateBackupExportProgressNotification({ taskId, label, progress }) {
  if (!taskId) return { cancelled: false };
  return DriveSenseNative.updateBackupExportTask({ taskId, label, progress });
}

export async function finishBackupExportProgressNotification({ taskId, status, filename = null, message = null }) {
  if (!taskId) return;
  try {
    await DriveSenseNative.finishBackupExportTask({ taskId, status, filename, message });
  } catch (error) {
    logSystemFailure('backup_export_foreground_finish', error, { status });
  }
}

export async function addBackupExportCancelListener(listener) {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return null;
  return DriveSenseNative.addListener('backupExportCancelled', listener);
}

const abortError = () => {
  const error = new Error('Backup export cancelled.');
  error.name = 'AbortError';
  return error;
};

const nextUnicodeSafeChunkEnd = (value, start) => {
  let end = Math.min(value.length, start + NATIVE_EXPORT_CHUNK_CHARS);
  if (end < value.length) {
    const finalCodeUnit = value.charCodeAt(end - 1);
    const nextCodeUnit = value.charCodeAt(end);
    if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
      end += 1;
    }
  }
  return end;
};

const saveExportToDownloadsChunked = async ({ filename, data, mimeType, signal, onProgress }) => {
  let exportId = null;
  try {
    if (signal?.aborted) throw abortError();
    const started = await DriveSenseNative.beginExportToDownloads({ filename, mimeType });
    exportId = started?.exportId;
    if (!exportId) throw new Error('Native export session could not be started.');

    for (let start = 0; start < data.length;) {
      if (signal?.aborted) throw abortError();
      const end = nextUnicodeSafeChunkEnd(data, start);
      await DriveSenseNative.appendExportToDownloads({
        exportId,
        data: data.slice(start, end),
      });
      start = end;
      onProgress?.({ completed: start, total: data.length });
    }

    if (signal?.aborted) throw abortError();
    const result = await DriveSenseNative.finishExportToDownloads({ exportId });
    exportId = null;
    return result;
  } catch (error) {
    if (exportId) {
      await DriveSenseNative.cancelExportToDownloads({ exportId }).catch(() => {});
    }
    throw error;
  }
};

/**
 * @param {{filename:string,data:string,mimeType:string,base64?:boolean,signal?:AbortSignal,onProgress?:(progress:{completed:number,total:number})=>void}} options
 */
export async function saveExportToDownloads({ filename, data, mimeType, base64, signal, onProgress }) {
  try {
    if (signal?.aborted) throw abortError();
    const shouldChunk = base64 !== true && String(data || '').length >= NATIVE_EXPORT_CHUNK_THRESHOLD;
    const result = shouldChunk
      ? await saveExportToDownloadsChunked({ filename, data: String(data), mimeType, signal, onProgress })
      : await DriveSenseNative.saveExportToDownloads({ filename, data, mimeType, base64 });
    recordSystemEvent('native_export_saved', {
      extension: extensionOf(filename),
      mime_type: mimeType,
      byte_count: String(data || '').length,
      base64: base64 === true,
      has_uri: Boolean(result?.uri),
    }, { category: 'storage', source: 'android', title: 'Native export saved' });
    return result;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
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
