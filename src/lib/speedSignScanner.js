import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';

const SpeedSignScanner = registerPlugin('SpeedSignScanner');

const unavailableStatus = Object.freeze({
  scannerEnabled: false,
  cameraPermission: 'unavailable',
  scannerActive: false,
  tripActive: false,
  safeToStart: false,
  pendingEvidenceCount: 0,
  mode: 'unavailable',
  focusMode: 'unavailable',
  fusionRequiredFrames: 2,
  lastScanSummary: null,
  offline: true,
  storesFrames: false,
  storesFullFrames: false,
  storesTemporaryReviewCrop: false,
  reviewImageTtlHours: 24,
  requiresParkedConfirmation: true,
  mountedModeEnabled: false,
  armedForNextTrip: false,
  armTimeoutMinutes: 15,
  backgroundNotificationActionAvailable: false,
  manualStartAvailable: false,
  preparedManualStartAvailable: false,
  safeLaunchMode: 'parked_pretrip_auto_or_manual',
});

export async function getSpeedSignScannerStatus() {
  if (!isAndroid()) return unavailableStatus;
  try {
    return await SpeedSignScanner.getStatus();
  } catch (error) {
    logSystemFailure('speed_sign_scanner_status', error);
    return unavailableStatus;
  }
}

export async function requestSpeedSignCameraPermission() {
  if (!isAndroid()) return unavailableStatus;
  try {
    return await SpeedSignScanner.requestCameraPermission();
  } catch (error) {
    logSystemFailure('speed_sign_camera_permission', error);
    throw error;
  }
}

export async function armMountedSpeedSignScanner({ units = 'metric' } = {}) {
  if (!isAndroid()) throw new Error('Mounted speed-sign scanning is available on Android only.');
  try {
    return await SpeedSignScanner.armMountedScanner({
      units: units === 'imperial' ? 'imperial' : 'metric',
      userInitiated: true,
    });
  } catch (error) {
    logSystemFailure('speed_sign_scanner_arm', error);
    throw error;
  }
}

/**
 * @param {{ tripId: string, units?: string }} options
 */
export async function startPreparedManualSpeedSignScanner(options) {
  const { tripId, units = 'metric' } = options;
  if (!isAndroid()) throw new Error('Manual-trip speed-sign scanning is available on Android only.');
  const normalizedTripId = String(tripId || '').trim();
  if (!normalizedTripId) throw new Error('The manual trip must be prepared before its camera can start.');
  try {
    return await SpeedSignScanner.startPreparedManualScanner({
      tripId: normalizedTripId.slice(0, 120),
      units: units === 'imperial' ? 'imperial' : 'metric',
      userInitiated: true,
    });
  } catch (error) {
    logSystemFailure('speed_sign_scanner_prepared_manual_start', error);
    throw error;
  }
}

export async function drainNativeSpeedSignEvidence() {
  if (!isAndroid()) return [];
  try {
    const result = await SpeedSignScanner.drainEvidence();
    return Array.isArray(result?.evidence) ? result.evidence : [];
  } catch (error) {
    logSystemFailure('speed_sign_evidence_drain', error);
    return [];
  }
}

export async function eraseNativeSpeedSignEvidence() {
  if (!isAndroid()) return false;
  await SpeedSignScanner.eraseEvidence();
  return true;
}

export async function getSpeedSignEvidenceImage(evidenceId) {
  if (!isAndroid() || !String(evidenceId || '').startsWith('sign_')) return null;
  try {
    const result = await SpeedSignScanner.getEvidenceImage({
      evidenceId: String(evidenceId).slice(0, 100),
    });
    const dataUrl = String(result?.dataUrl || '');
    return result?.available === true && /^data:image\/jpeg;base64,/i.test(dataUrl)
      ? dataUrl
      : null;
  } catch (error) {
    logSystemFailure('speed_sign_evidence_image_read', error);
    return null;
  }
}

export async function deleteSpeedSignEvidenceImage(evidenceId) {
  if (!isAndroid() || !String(evidenceId || '').startsWith('sign_')) return false;
  try {
    await SpeedSignScanner.deleteEvidenceImage({
      evidenceId: String(evidenceId).slice(0, 100),
    });
    return true;
  } catch (error) {
    logSystemFailure('speed_sign_evidence_image_delete', error);
    return false;
  }
}
