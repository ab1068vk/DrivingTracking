import { Capacitor } from '@capacitor/core';

export const isNativePlatform = () => Capacitor.isNativePlatform();

export const isAndroid = () => Capacitor.getPlatform() === 'android';

export const openNativeSettings = async () => {
  if (!isNativePlatform()) return false;
  const { App } = await import('@capacitor/app');
  await App.openSettings();
  return true;
};
