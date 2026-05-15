import { registerPlugin } from '@capacitor/core';

const DriveSenseNative = registerPlugin('DriveSenseActivityRecognition');

export async function saveExportToDownloads({ filename, data, mimeType }) {
  return DriveSenseNative.saveExportToDownloads({ filename, data, mimeType });
}
