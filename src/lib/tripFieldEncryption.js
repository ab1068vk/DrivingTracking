import { registerPlugin } from '@capacitor/core';
import { isNativePlatform } from '@/lib/nativePlatform';

const FIELDS_TO_ENCRYPT = ['route_points', 'driving_events', 'notes'];
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const IV_LENGTH_BYTES = 12;

const SecureKey = registerPlugin('SecureKey');

const hasWebCrypto = () => (
  typeof crypto !== 'undefined' &&
  crypto?.subtle &&
  typeof crypto.getRandomValues === 'function' &&
  typeof TextEncoder !== 'undefined' &&
  typeof TextDecoder !== 'undefined'
);

let webSessionKeyPromise = null;

const bytesToBase64 = (bytes) => {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const canEncode = () => typeof btoa === 'function' && typeof atob === 'function';

const isEncryptedValue = (value) => (
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  value._enc === true &&
  typeof value.iv === 'string' &&
  typeof value.ct === 'string'
);

async function getWebSessionKey() {
  if (!hasWebCrypto() || !canEncode()) throw new Error('WebCrypto unavailable.');
  if (!webSessionKeyPromise) {
    webSessionKeyPromise = crypto.subtle.generateKey(
      { name: ENCRYPTION_ALGORITHM, length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  return webSessionKeyPromise;
}

async function encryptWithWebSessionKey(bytes) {
  const key = await getWebSessionKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: ENCRYPTION_ALGORITHM, iv }, key, bytes);
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ciphertext)),
    _key: 'web-session',
  };
}

async function decryptWithWebSessionKey(value) {
  const key = await getWebSessionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: ENCRYPTION_ALGORITHM, iv: base64ToBytes(value.iv) },
    key,
    base64ToBytes(value.ct)
  );
  return new Uint8Array(plaintext);
}

async function encryptBytes(bytes) {
  if (canEncode()) {
    try {
      const { iv, ct, backing } = await SecureKey.encrypt({ data: bytesToBase64(bytes) });
      return { iv, ct, _key: backing || 'android-keystore' };
    } catch (error) {
      if (isNativePlatform()) {
        throw new Error(`Native trip encryption key unavailable: ${error?.message || 'SecureKey failed'}`);
      }
    }
  }
  return encryptWithWebSessionKey(bytes);
}

async function decryptBytes(value) {
  if (isNativePlatform() && value._key === 'web-session') {
    throw new Error('Web-session encrypted trip data is not readable on native Android.');
  }

  if (value._key !== 'web-session' && canEncode()) {
    try {
      const { data } = await SecureKey.decrypt({ iv: value.iv, ct: value.ct });
      return base64ToBytes(data);
    } catch (error) {
      if (isNativePlatform()) {
        throw new Error(`Native trip decryption key unavailable: ${error?.message || 'SecureKey failed'}`);
      }
    }
  }
  return decryptWithWebSessionKey(value);
}

export async function encryptTripFields(trip) {
  if (!trip || typeof trip !== 'object' || !canEncode()) return trip;

  const result = { ...trip };
  for (const field of FIELDS_TO_ENCRYPT) {
    if (result[field] == null || isEncryptedValue(result[field])) continue;

    const plaintext = new TextEncoder().encode(JSON.stringify(result[field]));
    const encrypted = await encryptBytes(plaintext);
    result[field] = {
      _enc: true,
      iv: encrypted.iv,
      ct: encrypted.ct,
      _key: encrypted._key,
    };
  }

  return result;
}

export async function decryptTripFields(trip) {
  if (!trip || typeof trip !== 'object') return trip;

  const encryptedFields = FIELDS_TO_ENCRYPT.filter((field) => isEncryptedValue(trip[field]));
  if (!encryptedFields.length) return trip;

  const result = { ...trip };
  for (const field of encryptedFields) {
    try {
      const bytes = await decryptBytes(result[field]);
      result[field] = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      result[field] = null;
    }
  }

  return result;
}
