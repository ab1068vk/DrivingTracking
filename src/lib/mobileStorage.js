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
      // Clear legacy PWA/WebView copies as well as the current native store.
      if (hasLocalStorage()) localStorage.removeItem(key);
      memoryFallback.delete(key);
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

/**
 * Three-valued presence for a stored document, without reading or parsing it.
 *
 * P4-C-F04/F05/F06: a lifecycle turn has to be able to *notice* a monolithic
 * legacy document so it can report the obligation, but it must never pay
 * O(document) to do so. The key enumeration APIs answer this at a cost that
 * scales with the number of storage keys — a fixed set for this app — and never
 * with the size of any one value.
 *
 * P4-C-F05: the answer is deliberately tri-state. Returning a plain boolean
 * meant a *failed* or unsupported enumeration was indistinguishable from a
 * proven absence, and a caller deciding whether an encryption key may be
 * destroyed would then treat "I could not look" as "there is nothing there".
 * `UNKNOWN` is its own value so every such caller has to handle uncertainty
 * explicitly; no caller may treat it as `ABSENT`.
 */
export const STORAGE_PRESENCE = Object.freeze({
  PRESENT: 'present',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

export async function probeStoredJson(key) {
  try {
    if (isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences');
      const { keys } = await Preferences.keys();
      // A malformed enumeration result is not a proof of absence.
      if (!Array.isArray(keys)) return STORAGE_PRESENCE.UNKNOWN;
      return keys.includes(key) ? STORAGE_PRESENCE.PRESENT : STORAGE_PRESENCE.ABSENT;
    }

    if (hasLocalStorage()) {
      if (typeof localStorage.key === 'function' && typeof localStorage.length === 'number') {
        for (let index = 0; index < localStorage.length; index += 1) {
          if (localStorage.key(index) === key) return STORAGE_PRESENCE.PRESENT;
        }
        return STORAGE_PRESENCE.ABSENT;
      }
      if (typeof localStorage.getItem === 'function') {
        return localStorage.getItem(key) != null
          ? STORAGE_PRESENCE.PRESENT
          : STORAGE_PRESENCE.ABSENT;
      }
      // A storage object that supports neither enumeration nor point reads
      // cannot answer the question at all.
      return STORAGE_PRESENCE.UNKNOWN;
    }

    if (memoryFallback.has(key)) return STORAGE_PRESENCE.PRESENT;
    // No platform storage and nothing in the in-memory fallback: this process
    // has no way to see a document a previous install may have written.
    return isNativePlatform() ? STORAGE_PRESENCE.UNKNOWN : STORAGE_PRESENCE.ABSENT;
  } catch (error) {
    // Enumeration threw (quota, a locked/again-unavailable store, a platform
    // bridge failure). The document may or may not exist; say so.
    logSystemFailure('storage_probe_presence', error, {
      key,
      native_platform: isNativePlatform(),
    });
    return STORAGE_PRESENCE.UNKNOWN;
  }
}
