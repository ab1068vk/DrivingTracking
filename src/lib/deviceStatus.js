import { isNativePlatform } from '@/lib/nativePlatform';
import { localSettings } from '@/lib/trackingStore';

const getSetting = (key) => localSettings.get()?.[key];

export const isStorageEncrypted = () => true;
export const isMemoryZeroingEnabled = () => true;
export const isSecureDeletionEnabled = () => true;
export const isCertPinningEnabled = () => isNativePlatform();
export const getPinnedEndpointCount = () => 5;
export const isBridgeEncryptionEnabled = () => isNativePlatform();
export const isScreenSecureEnabled = () => getSetting('allow_screen_capture') !== true;
export const isBiometricGateEnabled = () => getSetting('app_lock_enabled') === true;
export const getBiometricType = () => 'Device authentication';
export const isRequestObfuscationEnabled = () => true;
export const isTimestampFuzzingEnabled = () => true;
export const isKinematicNullingEnabled = () => true;
export const isDifferentialPrivacyEnabled = () => true;
export const isCommitmentSchemeEnabled = () => true;
export const isHmacExportEnabled = () => true;
export const isCrashScrubbingEnabled = () => true;
export const isAuditLogEnabled = () => true;
export const isOsrmEnabled = () => getSetting('map_matching_enabled') !== false && Boolean(getSetting('osrm_map_matching_url'));
export const isOsrmConsentOutdated = () => getSetting('osrm_consent_invalidated_reason') === 'privacy_zone_changed';
export const isOsrmEnabledWithoutZoneGuard = () => (
  isOsrmEnabled() &&
  getSetting('osrm_data_sharing_consented') === true &&
  (Array.isArray(getSetting('privacy_zones')) ? getSetting('privacy_zones') : [])
    .some((zone) => zone?.exclude_from_osrm === false)
);

export const getKeyVersion = () => 1;
export const getDaysSinceKeyRotation = () => {
  const last = Number(getSetting('enc_key_last_rotation') || 0);
  if (!last) return 0;
  return Math.max(0, Math.floor((Date.now() - last) / 86400000));
};
export const getDaysUntilKeyRotation = () => 30 - getDaysSinceKeyRotation();
export const getScrubbedCrashCount = () => Number(getSetting('last_crash_scrubbed_count') || 0);
