import { getJson, setJson } from '@/lib/mobileStorage';
import { isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import { secureCall } from '@/lib/secureBridge';

export const SIGNED_EXPORT_FORMAT = 'road-sage-signed-export';
export const SIGNED_EXPORT_FORMAT_VERSION = 1;
export const SIGNED_EXPORT_ALGORITHM = 'HMAC-SHA256';
export const SIGNING_KEY_ALIAS = 'ds_export_signing_key_v1';

const SIGNING_KEY_CONTEXT = 'backup-export-signing-key:v1';
const WEB_KEY_DB_NAME = 'drivesense_export_integrity';
const WEB_KEY_STORE_NAME = 'keys';
const WEB_KEY_RECORD_ID = SIGNING_KEY_ALIAS;
const BASE64_CHUNK_SIZE = 0x8000;

let signingKeyPromise = null;
let memoryWebSigningKeyPromise = null;

const cryptoProvider = () => {
  const provider = globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== 'function') {
    throw new Error('Export signing requires Web Crypto support.');
  }
  return provider;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_SIZE) {
    const chunk = bytes.slice(index, index + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const secureStoragePlugin = () => {
  const plugin = globalThis.Capacitor?.Plugins?.SecureStorage;
  return plugin && typeof plugin.get === 'function' && typeof plugin.set === 'function'
    ? plugin
    : null;
};

const readSecureStorageKey = async () => {
  const plugin = secureStoragePlugin();
  if (!plugin) return null;
  try {
    const stored = await plugin.get({ key: SIGNING_KEY_ALIAS });
    return stored?.value || null;
  } catch {
    return null;
  }
};

const writeSecureStorageKey = async (value) => {
  const plugin = secureStoragePlugin();
  if (!plugin) return false;
  await plugin.set({ key: SIGNING_KEY_ALIAS, value });
  return true;
};

const importRawSigningKey = (rawBytes) => cryptoProvider().subtle.importKey(
  'raw',
  rawBytes,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify']
);

const generateExtractableSigningKey = () => cryptoProvider().subtle.generateKey(
  { name: 'HMAC', hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);

const generateWebSigningKey = () => cryptoProvider().subtle.generateKey(
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign', 'verify']
);

const openWebKeyDb = () => new Promise((resolve, reject) => {
  if (typeof indexedDB === 'undefined') {
    resolve(null);
    return;
  }

  const request = indexedDB.open(WEB_KEY_DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(WEB_KEY_STORE_NAME)) {
      request.result.createObjectStore(WEB_KEY_STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const getWebSigningKey = async () => {
  const db = await openWebKeyDb();
  if (!db) {
    if (!memoryWebSigningKeyPromise) {
      memoryWebSigningKeyPromise = generateWebSigningKey();
    }
    return memoryWebSigningKeyPromise;
  }

  try {
    const store = db.transaction(WEB_KEY_STORE_NAME, 'readonly').objectStore(WEB_KEY_STORE_NAME);
    const existing = await idbRequest(store.get(WEB_KEY_RECORD_ID));
    if (existing?.key) return existing.key;

    const key = await generateWebSigningKey();
    await idbRequest(db.transaction(WEB_KEY_STORE_NAME, 'readwrite').objectStore(WEB_KEY_STORE_NAME).put({
      id: WEB_KEY_RECORD_ID,
      key,
      created_at: new Date().toISOString(),
    }));
    return key;
  } finally {
    db.close();
  }
};

const getAndroidSigningKey = async () => {
  const stored = await getJson(SIGNING_KEY_ALIAS, null);
  if (stored?.encrypted_key) {
    const decrypted = await secureCall('SecureBridge', 'decryptSensitivePayload', {
      ciphertext: stored.encrypted_key,
      context: SIGNING_KEY_CONTEXT,
    });
    return importRawSigningKey(base64ToBytes(decrypted.plaintext));
  }

  const key = await generateExtractableSigningKey();
  const raw = new Uint8Array(await cryptoProvider().subtle.exportKey('raw', key));
  const encrypted = await secureCall('SecureBridge', 'encryptSensitivePayload', {
    plaintext: bytesToBase64(raw),
    context: SIGNING_KEY_CONTEXT,
  });
  await setJson(SIGNING_KEY_ALIAS, {
    encrypted_key: encrypted.ciphertext,
    key_provider: 'android-keystore',
    version: 1,
  });
  return importRawSigningKey(raw);
};

const loadOrCreateSigningKey = async () => {
  const secureStored = await readSecureStorageKey();
  if (secureStored) {
    return importRawSigningKey(base64ToBytes(secureStored));
  }

  if (isAndroid()) {
    return getAndroidSigningKey();
  }

  if (isNativePlatform()) {
    const key = await generateExtractableSigningKey();
    const raw = new Uint8Array(await cryptoProvider().subtle.exportKey('raw', key));
    if (await writeSecureStorageKey(bytesToBase64(raw))) {
      return importRawSigningKey(raw);
    }
    throw new Error('Export signing requires secure device storage on this native platform.');
  }

  return getWebSigningKey();
};

export const getSigningKey = () => {
  if (!signingKeyPromise) {
    signingKeyPromise = loadOrCreateSigningKey().catch((error) => {
      signingKeyPromise = null;
      throw error;
    });
  }
  return signingKeyPromise;
};

const signatureBytesForPayload = (payload) => (
  new TextEncoder().encode(JSON.stringify(payload))
);

export function isSignedExportEnvelope(value) {
  try {
    const envelope = typeof value === 'string' ? JSON.parse(value) : value;
    return envelope?.format === SIGNED_EXPORT_FORMAT &&
      Number(envelope?.format_version) === SIGNED_EXPORT_FORMAT_VERSION &&
      envelope?.algorithm === SIGNED_EXPORT_ALGORITHM &&
      typeof envelope?.signature === 'string' &&
      envelope?.payload &&
      typeof envelope.payload === 'object';
  } catch {
    return false;
  }
}

export async function signExport(exportPayload) {
  const key = await getSigningKey();
  const signature = await cryptoProvider().subtle.sign(
    'HMAC',
    key,
    signatureBytesForPayload(exportPayload)
  );

  return {
    app: 'Road Sage',
    format: SIGNED_EXPORT_FORMAT,
    format_version: SIGNED_EXPORT_FORMAT_VERSION,
    payload: exportPayload,
    signature: bytesToBase64(new Uint8Array(signature)),
    algorithm: SIGNED_EXPORT_ALGORITHM,
    signed_at: new Date().toISOString(),
    version: 1,
  };
}

export async function verifyExport(signedExport) {
  if (!isSignedExportEnvelope(signedExport)) {
    return { valid: false, signedAt: null };
  }

  let signature;
  try {
    signature = base64ToBytes(signedExport.signature);
  } catch {
    return { valid: false, signedAt: signedExport.signed_at || null };
  }

  const key = await getSigningKey();
  const valid = await cryptoProvider().subtle.verify(
    'HMAC',
    key,
    signature,
    signatureBytesForPayload(signedExport.payload)
  );
  return { valid, signedAt: signedExport.signed_at || null };
}

export async function verifyAndUnwrapExport(signedExport) {
  const { valid, signedAt } = await verifyExport(signedExport);
  if (!valid) {
    throw new Error('Backup signature invalid. The file may have been modified or corrupted.');
  }
  return { payload: signedExport.payload, signedAt };
}
