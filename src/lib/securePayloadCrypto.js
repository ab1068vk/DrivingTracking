import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { getNativePlatform, isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import { secureCall } from '@/lib/secureBridge';

const ENCRYPTION_VERSION = 1;
const DEFAULT_KEY_VERSION = 1;
const LEGACY_ANDROID_KEY_VERSION = 0;
export const ENCRYPTION_KEY_META_KEY = 'drivesense_encryption_key_meta';
const KEY_DB_NAME = 'drivesense_secure_keys';
const KEY_STORE_NAME = 'keys';
const keyRecordId = (version) => `gps_payload_key_v${version}`;
const webKeyPromises = new Map();

const cryptoApi = () => {
  const api = globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== 'function') {
    throw new Error('Secure cryptography is unavailable on this device.');
  }
  return api;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const openKeyDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    resolve(null);
    return;
  }

  const request = indexedDB.open(KEY_DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(KEY_STORE_NAME)) {
      request.result.createObjectStore(KEY_STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const loadOrCreateWebKey = async (version) => {
  const api = cryptoApi();
  const db = await openKeyDb();
  if (!db) {
    return api.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  try {
    const recordId = keyRecordId(version);
    const existing = await idbRequest(db.transaction(KEY_STORE_NAME, 'readonly').objectStore(KEY_STORE_NAME).get(recordId));
    if (existing?.key) return existing.key;

    const key = await api.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbRequest(db.transaction(KEY_STORE_NAME, 'readwrite').objectStore(KEY_STORE_NAME).put({
      id: recordId,
      key,
      created_at: new Date().toISOString(),
    }));
    return key;
  } finally {
    db.close();
  }
};

const getWebKey = (version) => {
  if (!webKeyPromises.has(version)) {
    const promise = loadOrCreateWebKey(version).catch((error) => {
      webKeyPromises.delete(version);
      throw error;
    });
    webKeyPromises.set(version, promise);
  }
  return webKeyPromises.get(version);
};

const deleteWebKey = async (version) => {
  const db = await openKeyDb();
  webKeyPromises.delete(version);
  if (!db) return;
  try {
    await idbRequest(
      db.transaction(KEY_STORE_NAME, 'readwrite').objectStore(KEY_STORE_NAME).delete(keyRecordId(version))
    );
  } finally {
    db.close();
  }
};

export async function getActiveEncryptionKeyVersion() {
  const meta = await getJson(ENCRYPTION_KEY_META_KEY, null);
  return Math.max(
    DEFAULT_KEY_VERSION,
    Number(meta?.pendingVersion || meta?.version || DEFAULT_KEY_VERSION) || DEFAULT_KEY_VERSION
  );
}

const assertSupportedNativeCrypto = () => {
  if (!isNativePlatform() || isAndroid()) return;
  throw new Error(
    `Native secure payload encryption is not implemented for ${getNativePlatform()}. ` +
    'Add a platform-backed secure crypto plugin before storing sensitive GPS data.'
  );
};

export const isEncryptedPayload = (value) => (
  value?.encrypted === true &&
  Number(value?.version) === ENCRYPTION_VERSION &&
  typeof value?.ciphertext === 'string'
);

export async function ensureEncryptionKeyVersion(version) {
  const normalizedVersion = Math.max(DEFAULT_KEY_VERSION, Number(version) || DEFAULT_KEY_VERSION);
  if (isAndroid()) {
    await secureCall('SecureBridge', 'ensureSensitivePayloadKey', { keyVersion: normalizedVersion });
    return normalizedVersion;
  }
  assertSupportedNativeCrypto();
  await getWebKey(normalizedVersion);
  return normalizedVersion;
}

export async function deleteEncryptionKeyVersion(version) {
  const normalizedVersion = Number(version);
  if (!Number.isInteger(normalizedVersion) || normalizedVersion < DEFAULT_KEY_VERSION) return;
  if (isAndroid()) {
    await secureCall('SecureBridge', 'deleteSensitivePayloadKey', { keyVersion: normalizedVersion });
    return;
  }
  assertSupportedNativeCrypto();
  await deleteWebKey(normalizedVersion);
}

export async function encryptSensitiveValue(value, context = 'drivesense', options = {}) {
  const plaintext = JSON.stringify(value);
  const keyVersion = Math.max(
    DEFAULT_KEY_VERSION,
    Number(options.keyVersion || await getActiveEncryptionKeyVersion()) || DEFAULT_KEY_VERSION
  );
  if (isAndroid()) {
    const result = await secureCall('SecureBridge', 'encryptSensitivePayload', {
      plaintext,
      context,
      keyVersion,
    });
    return {
      encrypted: true,
      version: ENCRYPTION_VERSION,
      key_version: keyVersion,
      algorithm: 'AES-256-GCM',
      key_provider: 'android-keystore',
      ciphertext: result.ciphertext,
    };
  }
  assertSupportedNativeCrypto();

  const api = cryptoApi();
  const key = await getWebKey(keyVersion);
  const iv = api.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(context);
  const ciphertext = await api.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    encrypted: true,
    version: ENCRYPTION_VERSION,
    key_version: keyVersion,
    algorithm: 'AES-256-GCM',
    key_provider: 'webcrypto-nonextractable',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSensitiveValue(payload, context = 'drivesense') {
  if (!isEncryptedPayload(payload)) return payload;

  if (isAndroid()) {
    const keyVersion = Number.isInteger(Number(payload.key_version))
      ? Number(payload.key_version)
      : LEGACY_ANDROID_KEY_VERSION;
    const result = await secureCall('SecureBridge', 'decryptSensitivePayload', {
      ciphertext: payload.ciphertext,
      context,
      keyVersion,
    });
    return JSON.parse(result.plaintext);
  }
  assertSupportedNativeCrypto();

  const api = cryptoApi();
  const keyVersion = Math.max(DEFAULT_KEY_VERSION, Number(payload.key_version) || DEFAULT_KEY_VERSION);
  const key = await getWebKey(keyVersion);
  const plaintext = await api.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(payload.iv),
      additionalData: new TextEncoder().encode(context),
    },
    key,
    base64ToBytes(payload.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export async function getEncryptedJson(key, fallback) {
  const stored = await getJson(key, null);
  if (stored == null) return fallback;
  if (isEncryptedPayload(stored)) {
    return decryptSensitiveValue(stored, `storage:${key}`);
  }

  await setEncryptedJson(key, stored);
  return stored;
}

export async function setEncryptedJson(key, value, options = {}) {
  const encrypted = await encryptSensitiveValue(value, `storage:${key}`, options);
  await setJson(key, encrypted);
}

export async function removeEncryptedJson(key) {
  await removeJson(key);
}

export async function rotateEncryptedJsonKey(key, targetKeyVersion) {
  const stored = await getJson(key, null);
  if (stored == null) return false;
  const normalizedTarget = Math.max(DEFAULT_KEY_VERSION, Number(targetKeyVersion) || DEFAULT_KEY_VERSION);
  if (isEncryptedPayload(stored) && Number(stored.key_version) === normalizedTarget) return false;

  const value = isEncryptedPayload(stored)
    ? await decryptSensitiveValue(stored, `storage:${key}`)
    : stored;
  await setEncryptedJson(key, value, { keyVersion: normalizedTarget });
  return true;
}
