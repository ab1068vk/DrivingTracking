import { clearNativeCompletedTrips, stopNativeAutoTracking } from '@/lib/activityRecognition';
import {
  DISMISSED_TAG_SUGGESTIONS_KEY,
  FIRST_LAUNCH_PERMISSION_PROMPTED_KEY,
  SAVED_FILTERS_KEY,
} from '@/lib/appConstants';
import { invalidateDangerZoneCache } from '@/lib/dangerZoneEngine';
import { localCalibrationLabelRepository } from '@/lib/localCalibrationLabelRepository';
import { localTripRepository } from '@/lib/localTripRepository';
import { localVehicleRepository } from '@/lib/localVehicleRepository';
import { removeJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { clearCalibrationProfile } from '@/lib/thresholdCalibration';
import { DEFAULT_SETTINGS, activeTripStore, localSettings } from '@/lib/trackingStore';

const ROAD_SAGE_STORAGE_PREFIXES = Object.freeze([
  'road_sage_',
  'drivesense_',
]);

function clearPrefixedLocalStorage() {
  try {
    if (typeof localStorage === 'undefined') return 0;
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (ROAD_SAGE_STORAGE_PREFIXES.some((prefix) => key?.startsWith(prefix))) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
    return keys.length;
  } catch {
    return 0;
  }
}

async function clearEncryptedCapacitorStorage() {
  if (!isNativePlatform()) return;
  const { encryptedCapacitorStorage } = await import('@/lib/encryptedCapacitorStorage');
  await encryptedCapacitorStorage.clear();
}

async function wipeNativeSensitiveFiles() {
  if (!isNativePlatform()) return null;
  const { SecureKey } = await import('@/lib/nativeSecureKey');
  return SecureKey.wipeAllFiles();
}

export async function secureWipeAllData() {
  await Promise.allSettled([
    stopNativeAutoTracking(),
    localTripRepository.deleteAll(),
    localVehicleRepository.deleteAll(),
    localCalibrationLabelRepository.deleteAll(),
    clearCalibrationProfile(),
    invalidateDangerZoneCache(),
    invalidateRouteRiskIndex(),
    activeTripStore.clearAsync(),
    removeJson(SAVED_FILTERS_KEY),
    removeJson(DISMISSED_TAG_SUGGESTIONS_KEY),
    removeJson(FIRST_LAUNCH_PERMISSION_PROMPTED_KEY),
    clearNativeCompletedTrips(),
  ]);

  const localStorageKeysCleared = clearPrefixedLocalStorage();

  await Promise.allSettled([
    clearEncryptedCapacitorStorage(),
    wipeNativeSensitiveFiles(),
  ]);

  const resetSettings = {
    ...DEFAULT_SETTINGS,
    onboarding_completed: true,
    dark_mode: localSettings.get().dark_mode || DEFAULT_SETTINGS.dark_mode,
  };
  localSettings.set(resetSettings);

  return {
    success: true,
    localStorageKeysCleared,
  };
}
