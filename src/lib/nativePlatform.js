import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';

const NATIVE_PLATFORM = Capacitor.isNativePlatform();
const PLATFORM = Capacitor.getPlatform();

export const isNativePlatform = () => NATIVE_PLATFORM;

export const isAndroid = () => PLATFORM === 'android';

export const openNativeSettings = async () => {
  if (!isNativePlatform()) return false;
  await App.openSettings();
  return true;
};
