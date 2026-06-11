import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';

const BiometricAuth = registerPlugin('BiometricAuth');

export const APP_LOCK_SETTING_EVENT = 'roadsage-app-lock-setting-changed';

export async function getDeviceAuthenticationAvailability() {
  if (!isAndroid()) {
    return { available: false, deviceSecure: false, native: false };
  }
  const result = await BiometricAuth.checkAvailability();
  return { ...result, native: true };
}

export async function authenticateDevice(reason = 'Verify your identity') {
  if (!isAndroid()) return { verified: true, native: false };
  const result = await BiometricAuth.authenticate({
    title: 'Unlock Road Sage',
    subtitle: reason,
  });
  return { ...result, native: true };
}
