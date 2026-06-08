import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { getNativePlatform, isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import nativeCrypto from '@/lib/driveSenseNativePlugin';

const ENCRYPTION_VERSION = 1;
const KEY_DB_NAME = 'drivesense_secure_keys';
const KEY_STORE_NAME = 'keys';
const KEY_RECORD_ID = 'gps_payload_key_v1';
let webKeyPromise = null;

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

const loadOrCreateWebKey = async () => {
  const api = cryptoApi();
  const db = await openKeyDb();
  if (!db) {
    return api.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  try {
    const existing = await idbRequest(db.transaction(KEY_STORE_NAME, 'readonly').objectStore(KEY_STORE_NAME).get(KEY_RECORD_ID));
    if (existing?.key) return existing.key;

    const key = await api.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idbRequest(db.transaction(KEY_STORE_NAME, 'readwrite').objectStore(KEY_STORE_NAME).put({
      id: KEY_RECORD_ID,
      key,
      created_at: new Date().toISOString(),
    }));
    return key;
  } finally {
    db.close();
  }
};

const getWebKey = () => {
  if (!webKeyPromise) {
    webKeyPromise = loadOrCreateWebKey().catch((error) => {
      webKeyPromise = null;
      throw error;
    });
  }
  return webKeyPromise;
};

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

export async function encryptSensitiveValue(value, context = 'drivesense') {
  const plaintext = JSON.stringify(value);
  if (isAndroid()) {
    const result = await nativeCrypto.encryptSensitivePayload({ plaintext, context });
    return {
      encrypted: true,
      version: ENCRYPTION_VERSION,
      algorithm: 'AES-256-GCM',
      key_provider: 'android-keystore',
      ciphertext: result.ciphertext,
    };
  }
  assertSupportedNativeCrypto();

  const api = cryptoApi();
  const key = await getWebKey();
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
    algorithm: 'AES-256-GCM',
    key_provider: 'webcrypto-nonextractable',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSensitiveValue(payload, context = 'drivesense') {
  if (!isEncryptedPayload(payload)) return payload;

  if (isAndroid()) {
    const result = await nativeCrypto.decryptSensitivePayload({
      ciphertext: payload.ciphertext,
      context,
    });
    return JSON.parse(result.plaintext);
  }
  assertSupportedNativeCrypto();

  const api = cryptoApi();
  const key = await getWebKey();
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

export async function setEncryptedJson(key, value) {
  const encrypted = await encryptSensitiveValue(value, `storage:${key}`);
  await setJson(key, encrypted);
}

export async function removeEncryptedJson(key) {
  await removeJson(key);
}
