import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';
import { APP_LOCK_SETTING_EVENT } from '@/lib/appConstants';

const BiometricAuth = registerPlugin('BiometricAuth');

export { APP_LOCK_SETTING_EVENT };

export async function getDeviceAuthenticationAvailability() {
  if (!isAndroid()) {
    return { available: false, deviceSecure: false, native: false };
  }
  const result = await BiometricAuth.checkAvailability();
  return { ...result, native: true };
}

export async function authenticateDevice(reason = 'Verify your identity') {
  // Fail closed where no device authenticator exists, so a future caller that forgets its own
  // platform guard cannot be waved through. Callers that legitimately proceed without device
  // auth (web/dev builds) must opt in by checking `unsupported`, never by trusting `verified`.
  if (!isAndroid()) return { verified: false, native: false, unsupported: true };
  const result = await BiometricAuth.authenticate({
    title: 'Unlock Road Sage',
    subtitle: reason,
  });
  return { ...result, native: true };
}
