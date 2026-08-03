import { Capacitor } from '@capacitor/core';

const NATIVE_PLATFORM = Capacitor.isNativePlatform();
const PLATFORM = Capacitor.getPlatform();

export const isNativePlatform = () => NATIVE_PLATFORM;

export const getNativePlatform = () => PLATFORM;

export const isAndroid = () => PLATFORM === 'android';

export const isIos = () => PLATFORM === 'ios';

export const openNativeSettings = async () => {
  if (!isAndroid()) return false;
  const { default: ActivityRecognition } = await import('@/lib/driveSenseNativePlugin');
  await ActivityRecognition.openAppLocationSettings();
  return true;
};
