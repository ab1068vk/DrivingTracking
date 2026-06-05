const KEY_STORAGE_KEY = 'road_sage_db_enc_key_v1';
const FIELDS_TO_ENCRYPT = ['route_points', 'driving_events', 'notes'];
const ENCRYPTION_ALGORITHM = 'AES-GCM';
const IV_LENGTH_BYTES = 12;

const hasWebCrypto = () => (
  typeof crypto !== 'undefined' &&
  crypto?.subtle &&
  typeof crypto.getRandomValues === 'function' &&
  typeof TextEncoder !== 'undefined' &&
  typeof TextDecoder !== 'undefined'
);

const keyStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const bytesToBase64 = (bytes) => {
  const chunkSize = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const canEncryptAtRest = () => hasWebCrypto() && keyStorage() && typeof btoa === 'function' && typeof atob === 'function';

const isEncryptedValue = (value) => (
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  value._enc === true &&
  typeof value.iv === 'string' &&
  typeof value.ct === 'string'
);

async function getOrCreateDbKey() {
  const storage = keyStorage();
  if (!storage) throw new Error('Trip field encryption key storage unavailable.');

  const stored = storage.getItem(KEY_STORAGE_KEY);
  if (stored) {
    return crypto.subtle.importKey(
      'raw',
      base64ToBytes(stored),
      { name: ENCRYPTION_ALGORITHM },
      false,
      ['encrypt', 'decrypt']
    );
  }

  const key = await crypto.subtle.generateKey(
    { name: ENCRYPTION_ALGORITHM, length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const exported = await crypto.subtle.exportKey('raw', key);
  storage.setItem(KEY_STORAGE_KEY, bytesToBase64(new Uint8Array(exported)));
  return key;
}

export async function encryptTripFields(trip) {
  if (!trip || typeof trip !== 'object' || !canEncryptAtRest()) return trip;

  const key = await getOrCreateDbKey();
  const result = { ...trip };

  for (const field of FIELDS_TO_ENCRYPT) {
    if (result[field] == null || isEncryptedValue(result[field])) continue;

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
    const plaintext = new TextEncoder().encode(JSON.stringify(result[field]));
    const ciphertext = await crypto.subtle.encrypt({ name: ENCRYPTION_ALGORITHM, iv }, key, plaintext);
    result[field] = {
      _enc: true,
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext)),
    };
  }

  return result;
}

export async function decryptTripFields(trip) {
  if (!trip || typeof trip !== 'object') return trip;

  const encryptedFields = FIELDS_TO_ENCRYPT.filter((field) => isEncryptedValue(trip[field]));
  if (!encryptedFields.length) return trip;

  const result = { ...trip };
  if (!canEncryptAtRest()) {
    encryptedFields.forEach((field) => {
      result[field] = null;
    });
    return result;
  }

  let key;
  try {
    key = await getOrCreateDbKey();
  } catch {
    encryptedFields.forEach((field) => {
      result[field] = null;
    });
    return result;
  }

  for (const field of encryptedFields) {
    const value = result[field];
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: ENCRYPTION_ALGORITHM, iv: base64ToBytes(value.iv) },
        key,
        base64ToBytes(value.ct)
      );
      result[field] = JSON.parse(new TextDecoder().decode(plaintext));
    } catch {
      result[field] = null;
    }
  }

  return result;
}
