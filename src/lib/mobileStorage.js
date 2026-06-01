import { isNativePlatform } from '@/lib/nativePlatform';
import { legacyStorageKeysFor, resolveStorageKey } from '@/lib/storageKeyMigration';

const memoryFallback = new Map();
const INSTALL_HASH_KEY = 'road_sage_install_hash_v1';

const hasLocalStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

export async function getJson(key, fallback) {
  const currentKey = resolveStorageKey(key);
  const legacyKeys = legacyStorageKeysFor(key);
  try {
    if (isNativePlatform()) {
      const { Preferences } = await import('@capacitor/preferences');
      let { value } = await Preferences.get({ key: currentKey });
      for (const legacyKey of legacyKeys) {
        if (value !== null) break;
        const legacy = await Preferences.get({ key: legacyKey });
        value = legacy.value;
        if (value !== null) await Preferences.set({ key: currentKey, value });
      }
      return value ? JSON.parse(value) : fallback;
    }

    if (hasLocalStorage()) {
      let value = localStorage.getItem(currentKey);
      for (const legacyKey of legacyKeys) {
        if (value !== null) break;
        value = localStorage.getItem(legacyKey);
        if (value !== null) localStorage.setItem(currentKey, value);
      }
      return value ? JSON.parse(value) : fallback;
    }

    return memoryFallback.has(currentKey) ? memoryFallback.get(currentKey) : fallback;
  } catch {
    return fallback;
  }
}

export async function setJson(key, value) {
  const currentKey = resolveStorageKey(key);
  const serialized = JSON.stringify(value);

  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({ key: currentKey, value: serialized });
    return;
  }

  if (hasLocalStorage()) {
    localStorage.setItem(currentKey, serialized);
    return;
  }

  memoryFallback.set(currentKey, value);
}

export async function removeJson(key) {
  const currentKey = resolveStorageKey(key);
  const keys = [currentKey, ...legacyStorageKeysFor(key)];
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    await Promise.all(keys.map((storageKey) => Preferences.remove({ key: storageKey })));
    return;
  }

  if (hasLocalStorage()) {
    keys.forEach((storageKey) => localStorage.removeItem(storageKey));
    return;
  }

  keys.forEach((storageKey) => memoryFallback.delete(storageKey));
}

const randomInstallSeed = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `install_${Date.now()}_${Math.random().toString(36).slice(2)}`;
};

const sha256Hex = async (value) => {
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') {
    throw new Error('Install hash requires Web Crypto support.');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export async function getOrCreateInstallHash() {
  const existing = await getJson(INSTALL_HASH_KEY, null);
  if (typeof existing === 'string' && existing) return existing;

  const installHash = await sha256Hex(`road-sage-install:${randomInstallSeed()}`);
  await setJson(INSTALL_HASH_KEY, installHash);
  return installHash;
}
