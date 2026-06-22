import { localSettings } from '@/lib/trackingStore';
import { checkIntegrity } from '@/lib/rasp';
import { isHeightenedPrivacyMode } from '@/lib/privacyMode';
import {
  selfTestAuditLog,
  selfTestBridgeEncryption,
  selfTestCertPinning,
  selfTestCommitmentScheme,
  selfTestCrashScrubbing,
  selfTestDifferentialPrivacy,
  selfTestExportSigning,
  selfTestKinematicNulling,
  selfTestMemoryZeroing,
  selfTestRequestObfuscation,
  selfTestScoreInputMasking,
  selfTestSecureDeletion,
  selfTestStorageEncryption,
  selfTestTimestampFuzzing,
} from '@/lib/controlSelfTests';

const getSetting = (key) => localSettings.get()?.[key];

export const checkStorageEncryption = selfTestStorageEncryption;
export const checkMemoryZeroing = selfTestMemoryZeroing;
export const checkSecureDeletion = selfTestSecureDeletion;
export const checkCertPinning = selfTestCertPinning;
export const checkBridgeEncryption = selfTestBridgeEncryption;
export const checkRequestObfuscation = selfTestRequestObfuscation;
export const checkTimestampFuzzing = selfTestTimestampFuzzing;
export const checkKinematicNulling = selfTestKinematicNulling;
export const checkScoreInputMasking = selfTestScoreInputMasking;
export const checkDifferentialPrivacy = selfTestDifferentialPrivacy;
export const checkCommitmentScheme = selfTestCommitmentScheme;
export const checkExportSigning = selfTestExportSigning;
export const checkCrashScrubbing = selfTestCrashScrubbing;
export const checkAuditLog = selfTestAuditLog;

export const isScreenSecureEnabled = () => getSetting('allow_screen_capture') !== true;
export const isBiometricGateEnabled = () => getSetting('app_lock_enabled') === true;
export const getBiometricType = () => 'Device authentication';
export const isOsrmEnabled = () => (
  !isHeightenedPrivacyMode(localSettings.get()) &&
  getSetting('map_matching_enabled') !== false &&
  Boolean(getSetting('osrm_map_matching_url'))
);
export const isOsrmConsentOutdated = () => (
  getSetting('osrm_consent_invalidated_reason') === 'privacy_zone_changed'
);
export const isOsrmEnabledWithoutZoneGuard = () => false;

export async function checkDeviceIntegrity() {
  try {
    const integrity = await checkIntegrity();
    if (integrity.secure) {
      return {
        status: integrity.native ? 'ok' : 'not_applicable',
        evidence: integrity.native
          ? 'Native integrity check passed with no threats detected'
          : 'Root and jailbreak checks do not apply to the web runtime',
        threats: [],
        source: 'device_integrity',
        lastCheckedAt: Date.now(),
      };
    }
    return {
      status: 'error',
      evidence: `Device integrity threats detected: ${integrity.threats.join(', ')}`,
      threats: integrity.threats,
      source: 'device_integrity',
      lastCheckedAt: Date.now(),
    };
  } catch (integrityError) {
    return {
      status: 'unknown',
      evidence: `Device integrity check unavailable: ${integrityError?.message || 'unknown error'}`,
      threats: [],
      source: 'device_integrity',
      lastCheckedAt: Date.now(),
    };
  }
}
