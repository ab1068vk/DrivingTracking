import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { getNativePlatform, isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import { secureCall } from '@/lib/secureBridge';
import { closeP0Span, openP0Span, recordP0Phase, tagP0PayloadKind } from '@/lib/p0Probe';
import { payloadKindForContext } from '@/lib/p0Schema';

const p0Now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

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
  // P0: the logical payload span. `payload_kind` is derived from the context and
  // the raw context is then discarded — contexts embed trip ids and storage keys
  // and must never reach a trace.
  const p0Span = openP0Span('logical_payload');
  const payloadKind = p0Span ? payloadKindForContext(context) : '';
  if (p0Span) tagP0PayloadKind(p0Span, payloadKind);
  const p0Mark = () => (p0Span ? p0Now() : 0);
  const p0Meta = p0Span ? { parentOpId: p0Span.call_id, payloadKind } : undefined;
  let p0Outcome = 'error';

  try {
    const stringifyStart = p0Mark();
    let plaintext;
    try {
      plaintext = JSON.stringify(value);
    } catch (error) {
      // A failed stringify still consumed synchronous main-thread time — on a
      // large cyclic or getter-bearing value, potentially a lot of it. Keep the
      // partial interval rather than dropping the measurement with the error.
      if (p0Span) recordP0Phase(p0Span, 'logical_stringify', stringifyStart, p0Now());
      throw error;
    }
    if (p0Span) recordP0Phase(p0Span, 'logical_stringify', stringifyStart, p0Now());

    const keyVersion = Math.max(
      DEFAULT_KEY_VERSION,
      Number(options.keyVersion || await getActiveEncryptionKeyVersion()) || DEFAULT_KEY_VERSION
    );
    if (isAndroid()) {
      const result = await secureCall('SecureBridge', 'encryptSensitivePayload', {
        plaintext,
        context,
        keyVersion,
      }, p0Meta);
      if (p0Span && typeof result?.ciphertext === 'string') {
        // Only the base64 character count is free here. `at_rest_plaintext_bytes`
        // and `at_rest_ciphertext_bytes` stay unavailable (exported as `null`)
        // on the Android path: obtaining them would mean adding a payload pass
        // purely to produce a number, which the contract forbids.
        p0Span.at_rest_ciphertext_b64_chars = result.ciphertext.length;
      }
      p0Outcome = 'success';
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
    const encodedPlaintext = new TextEncoder().encode(plaintext);
    const ciphertext = await api.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      key,
      encodedPlaintext
    );
    // IV is encoded before the ciphertext, matching the original property
    // evaluation order in the returned object. Both helpers are pure today, but
    // the order-equivalence rule is absolute: instrumentation does not get to
    // reorder observable work.
    const ivBase64 = bytesToBase64(iv);
    const ciphertextBase64 = bytesToBase64(new Uint8Array(ciphertext));
    if (p0Span) {
      // All three are free: the encoder result, the ciphertext buffer and the
      // base64 string already exist. No extra pass is added.
      p0Span.at_rest_plaintext_bytes = encodedPlaintext.byteLength;
      p0Span.at_rest_ciphertext_bytes = ciphertext.byteLength;
      p0Span.at_rest_ciphertext_b64_chars = ciphertextBase64.length;
    }
    p0Outcome = 'success';
    return {
      encrypted: true,
      version: ENCRYPTION_VERSION,
      key_version: keyVersion,
      algorithm: 'AES-256-GCM',
      key_provider: 'webcrypto-nonextractable',
      iv: ivBase64,
      ciphertext: ciphertextBase64,
    };
  } finally {
    // A key lookup, secure-call or WebCrypto failure closes the span as `error`.
    // Closing everything as `success` would have made the error path invisible
    // in exactly the measurements meant to explain slow paths.
    if (p0Span) closeP0Span(p0Span, p0Outcome);
  }
}

export async function decryptSensitiveValue(payload, context = 'drivesense') {
  if (!isEncryptedPayload(payload)) return payload;

  const p0Span = openP0Span('logical_payload');
  const payloadKind = p0Span ? payloadKindForContext(context) : '';
  if (p0Span) {
    tagP0PayloadKind(p0Span, payloadKind);
    if (typeof payload?.ciphertext === 'string') {
      p0Span.at_rest_ciphertext_b64_chars = payload.ciphertext.length;
    }
  }
  const p0Mark = () => (p0Span ? p0Now() : 0);
  const p0Meta = p0Span ? { parentOpId: p0Span.call_id, payloadKind } : undefined;
  let p0Outcome = 'error';

  try {
    if (isAndroid()) {
      const keyVersion = Number.isInteger(Number(payload.key_version))
        ? Number(payload.key_version)
        : LEGACY_ANDROID_KEY_VERSION;
      const result = await secureCall('SecureBridge', 'decryptSensitivePayload', {
        ciphertext: payload.ciphertext,
        context,
        keyVersion,
      }, p0Meta);
      const parseStart = p0Mark();
      let parsed;
      try {
        parsed = JSON.parse(result.plaintext);
      } catch (error) {
        // A parse that throws on a multi-megabyte plaintext is precisely the
        // kind of long synchronous block P0 exists to find. Keep the interval.
        if (p0Span) recordP0Phase(p0Span, 'logical_parse', parseStart, p0Now());
        throw error;
      }
      if (p0Span) recordP0Phase(p0Span, 'logical_parse', parseStart, p0Now());
      p0Outcome = 'success';
      return parsed;
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
    const decoded = new TextDecoder().decode(plaintext);
    const parseStart = p0Mark();
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      if (p0Span) {
        recordP0Phase(p0Span, 'logical_parse', parseStart, p0Now());
        p0Span.at_rest_plaintext_bytes = plaintext.byteLength;
      }
      throw error;
    }
    if (p0Span) {
      recordP0Phase(p0Span, 'logical_parse', parseStart, p0Now());
      p0Span.at_rest_plaintext_bytes = plaintext.byteLength;
    }
    p0Outcome = 'success';
    return parsed;
  } finally {
    if (p0Span) closeP0Span(p0Span, p0Outcome);
  }
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

const deleteWebKeyDatabase = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    resolve(false);
    return;
  }
  const request = indexedDB.deleteDatabase(KEY_DB_NAME);
  request.onsuccess = () => resolve(true);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error('Secure key database deletion was blocked.'));
});

export async function eraseEncryptionKeysForDataRights() {
  const meta = await getJson(ENCRYPTION_KEY_META_KEY, null).catch(() => null);
  const versions = Array.from(new Set([
    LEGACY_ANDROID_KEY_VERSION,
    DEFAULT_KEY_VERSION,
    Number(meta?.version),
    Number(meta?.pendingVersion),
  ].filter((version) => Number.isInteger(version) && version >= 0)));

  webKeyPromises.clear();
  if (isAndroid()) {
    for (const keyVersion of versions) {
      await secureCall('SecureBridge', 'deleteSensitivePayloadKey', { keyVersion });
    }
    return { provider: 'android-keystore', versionsDeleted: versions };
  }

  assertSupportedNativeCrypto();
  const databaseDeleted = await deleteWebKeyDatabase();
  return { provider: 'webcrypto-indexeddb', databaseDeleted };
}
