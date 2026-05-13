import { isNativePlatform } from '@/lib/nativePlatform';

const memoryFallback = new Map();

const hasLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

export async function getJson(key, fallback) {
  try {
    if (isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences');
      const { value } = await Preferences.get({ key });
      return value ? JSON.parse(value) : fallback;
    }

    if (hasLocalStorage()) {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    }

    return memoryFallback.has(key) ? memoryFallback.get(key) : fallback;
  } catch {
    return fallback;
  }
}

export async function setJson(key, value) {
  const serialized = JSON.stringify(value);

  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key, value: serialized });
    return;
  }

  if (hasLocalStorage()) {
    localStorage.setItem(key, serialized);
    return;
  }

  memoryFallback.set(key, value);
}

export async function removeJson(key) {
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key });
    return;
  }

  if (hasLocalStorage()) {
    localStorage.removeItem(key);
    return;
  }

  memoryFallback.delete(key);
}
