import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';

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
    logSystemFailure('storage_get_json', new Error('Stored JSON could not be read or parsed.'), {
      key,
      native_platform: isNativePlatform(),
    });
    return fallback;
  }
}

export async function setJson(key, value) {
  const serialized = JSON.stringify(value);

  try {
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
  } catch (error) {
    logSystemFailure('storage_set_json', error, {
      key,
      native_platform: isNativePlatform(),
      byte_count: serialized.length,
    });
    throw error;
  }
}

export async function removeJson(key) {
  try {
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
  } catch (error) {
    logSystemFailure('storage_remove_json', error, {
      key,
      native_platform: isNativePlatform(),
    });
    throw error;
  }
}
