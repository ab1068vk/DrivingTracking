import { Capacitor } from '@capacitor/core';

const NATIVE_PLATFORM = Capacitor.isNativePlatform();
const PLATFORM = Capacitor.getPlatform();

export const isNativePlatform = () => NATIVE_PLATFORM;

export const isAndroid = () => PLATFORM === 'android';

export const openNativeSettings = async () => {
  if (!isNativePlatform()) return false;
  const { App } = await import('@capacitor/app');
  await App.openSettings();
  return true;
};
