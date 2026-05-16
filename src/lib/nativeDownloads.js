import { registerPlugin } from '@capacitor/core';

const DriveSenseNative = registerPlugin('DriveSenseActivityRecognition');

/**
 * @param {{filename:string,data:string,mimeType:string,base64?:boolean}} options
 */
export async function saveExportToDownloads({ filename, data, mimeType, base64 }) {
  return DriveSenseNative.saveExportToDownloads({ filename, data, mimeType, base64 });
}
