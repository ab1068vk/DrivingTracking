import { registerPlugin } from '@capacitor/core';

/** @type {any} */
const DriveSenseNative = registerPlugin('DriveSenseActivityRecognition');

/**
 * @param {{filename:string,data:string,mimeType:string,base64?:boolean}} options
 */
export async function saveExportToDownloads({ filename, data, mimeType, base64 }) {
  return DriveSenseNative.saveExportToDownloads({ filename, data, mimeType, base64 });
}

export async function openExportLocation(/** @type {any} */ { uri, mimeType } = {}) {
  return DriveSenseNative.openExportLocation({ uri, mimeType });
}
