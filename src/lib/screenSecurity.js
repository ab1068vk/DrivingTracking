import { registerPlugin } from '@capacitor/core';
import { isAndroid } from '@/lib/nativePlatform';

const ScreenSecurity = registerPlugin('ScreenSecurity');

export async function setScreenCaptureAllowed(allowed) {
  if (!isAndroid()) return { secure: false, native: false };
  const result = await ScreenSecurity.setSecure({ secure: allowed !== true });
  return { ...result, native: true };
}
