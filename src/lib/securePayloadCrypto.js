import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import {
  admitBrowserKeyWrite,
  finalizeBrowserKeyVersionDeletion,
  isBrowserKeyVersionDestroyed,
  markBrowserKeyVersionDestroyed,
  noteEncryptedDocumentKey,
} from '@/lib/browserKeyReferences';
import { getNativePlatform, isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import { secureCall, withSecureBulkAdmission, yieldSecureBulkTurn } from '@/lib/secureBridge';
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
export const SECURE_BATCH_VERSION = 1;
export const MAX_SECURE_BATCH_RECORDS = 8;
export const MAX_SECURE_BATCH_LOGICAL_BYTES = 245_760;
export const MAX_SECURE_BATCH_METHOD_JSON_BYTES = 524_288;
export const MAX_SECURE_BATCH_CONTEXT_BYTES = 512;
export const MAX_SECURE_BATCH_STRUCTURAL_BYTES = 6 * 1024 * 1024;
export const MAX_SECURE_BATCH_BRIDGE_CIPHERTEXT_BYTES = 524_304;
export const MAX_SECURE_BATCH_BRIDGE_BASE64_CHARS = 699_072;
const SECURE_BATCH_ERROR_CODES = new Set([
  'INVALID_INPUT',
  'AUTHENTICATION_FAILED',
  'KEY_UNAVAILABLE',
  'CRYPTO_FAILED',
]);
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

const utf8Length = (value) => new TextEncoder().encode(String(value)).byteLength;

const abortError = () => {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError();
};

const secureEntryContext = (entry) => {
  if (entry?.context === undefined) return 'drivesense';
  if (typeof entry.context !== 'string') throw new Error('Secure batch context is invalid.');
  return entry.context;
};

const decodedBase64Length = (value) => {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

const conservativeAndroidPlaintextBytes = (ciphertext) => {
  const decoded = decodedBase64Length(ciphertext);
  if (decoded == null || decoded < 29) return null;
  return decoded - 29;
};

const decryptBatchResponseUpperBound = (items) => {
  const fixedJsonBytes = utf8Length(JSON.stringify({
    batchVersion: SECURE_BATCH_VERSION,
    results: items.map((item) => ({ ordinal: item.ordinal, ok: true, plaintext: '' })),
  }));
  return fixedJsonBytes + items.reduce((sum, item) => sum + (2 * Math.max(0, item.__logicalBytes ?? 0)), 0);
};

const encryptedPlaintextUpperBound = (payload) => {
  const decoded = decodedBase64Length(payload?.ciphertext);
  if (decoded == null) return null;
  if (payload?.key_provider === 'webcrypto-nonextractable') return Math.max(0, decoded - 16);
  return decoded < 29 ? null : decoded - 29;
};

/**
 * Return a prefix that is guaranteed to fit one normal decrypt batch. It only
 * inspects at most eight ciphertext descriptors and never decrypts or prepares
 * aggregate plaintext. Oversized/invalid compatible records are isolated.
 */
export const secureDecryptBatchPrefixLength = (entries = []) => {
  const source = Array.isArray(entries) ? entries : [];
  if (!source.length) return 0;
  const first = source[0] || {};
  const firstKind = payloadKindForContext(secureEntryContext(first));
  const items = [];
  const logicalCharges = [];
  let logicalBytes = 0;
  for (let index = 0; index < source.length && index < MAX_SECURE_BATCH_RECORDS; index += 1) {
    const entry = source[index] || {};
    if (payloadKindForContext(secureEntryContext(entry)) !== firstKind) break;
    if (!isEncryptedPayload(entry.payload)) return items.length || 1;
    const context = secureEntryContext(entry);
    const contextBytes = utf8Length(context);
    const plaintextUpperBound = encryptedPlaintextUpperBound(entry.payload);
    if (
      items.length > 0 &&
      (contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
        plaintextUpperBound == null ||
        logicalBytes + plaintextUpperBound > MAX_SECURE_BATCH_LOGICAL_BYTES)
    ) break;
    items.push({
      ordinal: items.length,
      ciphertext: entry.payload.ciphertext,
      context,
      keyVersion: Number.isInteger(Number(entry.payload.key_version))
        ? Number(entry.payload.key_version)
        : LEGACY_ANDROID_KEY_VERSION,
    });
    logicalCharges.push(plaintextUpperBound);
    logicalBytes += Math.max(0, plaintextUpperBound ?? 0);
    if (
      contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
      plaintextUpperBound == null ||
      plaintextUpperBound > MAX_SECURE_BATCH_LOGICAL_BYTES
    ) return 1;
    const requestBytes = utf8Length(JSON.stringify({ batchVersion: SECURE_BATCH_VERSION, items }));
    const responseBytes = decryptBatchResponseUpperBound(items.map((item, itemIndex) => ({
      ...item,
      __logicalBytes: logicalCharges[itemIndex],
    })));
    if (requestBytes > MAX_SECURE_BATCH_METHOD_JSON_BYTES || responseBytes > MAX_SECURE_BATCH_METHOD_JSON_BYTES) {
      items.pop();
      logicalCharges.pop();
      return items.length || 1;
    }
  }
  return Math.max(1, items.length);
};

export class SecureBatchItemError extends Error {
  constructor(failures) {
    super('One or more secure batch items failed.');
    this.name = 'SecureBatchItemError';
    this.failures = failures.map(({ ordinal, errorCode }) => ({ ordinal, errorCode }));
  }
}

const validateBatchResults = (result, expectedCount, operation, expectedKeyVersions = []) => {
  if (
    result?.batchVersion !== SECURE_BATCH_VERSION ||
    !Array.isArray(result?.results) ||
    result.results.length !== expectedCount ||
    Object.keys(result).some((key) => key !== 'batchVersion' && key !== 'results')
  ) {
    throw new Error('Secure batch response is invalid.');
  }

  const failures = [];
  result.results.forEach((item, index) => {
    if (!item || !Number.isInteger(item.ordinal) || item.ordinal !== index || typeof item.ok !== 'boolean') {
      throw new Error('Secure batch response is invalid.');
    }
    if (!item.ok) {
      if (
        !SECURE_BATCH_ERROR_CODES.has(item.errorCode) ||
        Object.keys(item).some((key) => !['ordinal', 'ok', 'errorCode'].includes(key))
      ) {
        throw new Error('Secure batch response is invalid.');
      }
      failures.push({ ordinal: index, errorCode: item.errorCode });
      return;
    }
    if (operation === 'encrypt') {
      if (
        typeof item.ciphertext !== 'string' ||
        (decodedBase64Length(item.ciphertext) ?? -1) < 29 ||
        !Number.isInteger(item.keyVersion) ||
        item.keyVersion < DEFAULT_KEY_VERSION ||
        item.keyVersion !== expectedKeyVersions[index] ||
        Object.keys(item).some((key) => !['ordinal', 'ok', 'ciphertext', 'keyVersion'].includes(key))
      ) {
      throw new Error('Secure batch response is invalid.');
      }
    } else if (
      typeof item.plaintext !== 'string' ||
      Object.keys(item).some((key) => !['ordinal', 'ok', 'plaintext'].includes(key))
    ) {
        throw new Error('Secure batch response is invalid.');
    }
  });
  if (failures.length) throw new SecureBatchItemError(failures);
  return result.results;
};

const closeLogicalSpan = (span, outcome) => {
  if (span) closeP0Span(span, outcome);
};

const openBatchLogicalSpan = (payloadKind) => {
  const span = openP0Span('logical_payload');
  if (span) tagP0PayloadKind(span, payloadKind);
  return span;
};

const batchP0Meta = (span, payloadKind) => (
  span ? { parentOpId: span.call_id, payloadKind } : undefined
);

const wrapAndroidCiphertext = (ciphertext, keyVersion) => ({
  encrypted: true,
  version: ENCRYPTION_VERSION,
  key_version: keyVersion,
  algorithm: 'AES-256-GCM',
  key_provider: 'android-keystore',
  ciphertext,
});

const bytesToBase64 = (bytes) => {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(''));
};

const base64ToBytes = (value) => {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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

/**
 * AUD-007. A version that was deliberately destroyed must never come back as a
 * *different* random key under the same id. Without this the store silently reminted
 * `gps_payload_key_v1`, old ciphertext failed GCM authentication, and nothing
 * distinguished "this key was destroyed" from "this key never existed" — which is what
 * displaced the failure far from its cause.
 */
export class KeyVersionDestroyedError extends Error {
  constructor(version) {
    super(`KEY_VERSION_DESTROYED: encryption key version ${version} was destroyed and cannot be recreated.`);
    this.name = 'KeyVersionDestroyedError';
    this.code = 'KEY_VERSION_DESTROYED';
    this.keyVersion = version;
  }
}

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

    // A destroyed version is gone for good. Minting a replacement here would produce a
    // key that cannot decrypt anything, while making the store look healthy.
    if (await isBrowserKeyVersionDestroyed(version)) throw new KeyVersionDestroyedError(version);

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

/**
 * AUD-007 round 4. Deletion is now a FINALIZATION, not a bare delete.
 *
 * A zero-reference proof that has already returned proves nothing about the writer that
 * enters immediately afterwards. So this closes admission for the version, drains the
 * writers already holding it, re-proves, deletes while admission is still closed, and
 * only then reopens. A drain that does not complete, or a proof that does not come back
 * zero, leaves the key alive and says why.
 *
 * `options.finalized` is for the finalizer's own inner call — it performs the raw delete
 * that finalization has already authorised, and must not recurse into another one.
 *
 * @returns {Promise<{deleted: boolean, reason?: string}>}
 */
export async function deleteEncryptionKeyVersion(version, options = {}) {
  const normalizedVersion = Number(version);
  if (!Number.isInteger(normalizedVersion) || normalizedVersion < DEFAULT_KEY_VERSION) {
    return { deleted: false, reason: 'invalid_version' };
  }
  if (isAndroid()) {
    await secureCall('SecureBridge', 'deleteSensitivePayloadKey', { keyVersion: normalizedVersion });
    return { deleted: true };
  }
  assertSupportedNativeCrypto();

  const destroy = async (target) => {
    // The tombstone is durable BEFORE the key goes, so a destroyed version can never be
    // silently re-minted as a different random key under the same id.
    await markBrowserKeyVersionDestroyed(target);
    await deleteWebKey(target);
  };

  if (options.finalized === true) {
    await destroy(normalizedVersion);
    return { deleted: true };
  }
  return finalizeBrowserKeyVersionDeletion(normalizedVersion, destroy, options);
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

/**
 * Encrypt an ordered collection with bounded physical batches on Android.
 * @param {{value: any, context?: string}[]} entries
 * @param {{keyVersion?: number, signal?: AbortSignal, onProgress?: Function}} options
 */
export async function encryptSensitiveValues(entries = [], options = {}) {
  const source = Array.isArray(entries) ? entries : [];
  if (!source.length) return [];
  throwIfAborted(options.signal);

  if (!isAndroid()) {
    assertSupportedNativeCrypto();
    const values = [];
    for (let index = 0; index < source.length; index += 1) {
      throwIfAborted(options.signal);
      const entry = source[index] || {};
      values.push(await encryptSensitiveValue(entry.value, secureEntryContext(entry), options));
      options.onProgress?.({ completed: index + 1, total: source.length });
      if ((index + 1) % MAX_SECURE_BATCH_RECORDS === 0 && index + 1 < source.length) {
        await yieldSecureBulkTurn();
      }
    }
    return values;
  }

  const keyVersion = Math.max(
    DEFAULT_KEY_VERSION,
    Number(options.keyVersion || await getActiveEncryptionKeyVersion()) || DEFAULT_KEY_VERSION
  );
  const encryptedValues = [];
  let start = 0;

  while (start < source.length) {
    throwIfAborted(options.signal);
    const prepared = await withSecureBulkAdmission(async () => {
      throwIfAborted(options.signal);
      const payloadKind = payloadKindForContext(secureEntryContext(source[start]));
      const span = openBatchLogicalSpan(payloadKind);
      const mark = () => (span ? p0Now() : 0);
      let outcome = 'error';
      let consumed = 0;
      const stringifyStart = mark();
      let stringifyRecorded = false;
      const recordStringify = () => {
        if (span && !stringifyRecorded) {
          recordP0Phase(span, 'logical_stringify', stringifyStart, p0Now());
          stringifyRecorded = true;
        }
      };
      try {
        const items = [];
        let logicalBytes = 0;
        let cursor = start;
        while (cursor < source.length && items.length < MAX_SECURE_BATCH_RECORDS) {
          if (payloadKindForContext(secureEntryContext(source[cursor])) !== payloadKind) break;
          const entry = source[cursor] || {};
          const context = secureEntryContext(entry);
          const plaintext = JSON.stringify(entry.value);
          if (typeof plaintext !== 'string') throw new Error('Secure payload is not JSON serializable.');
          const plaintextBytes = utf8Length(plaintext);
          const contextBytes = utf8Length(context);
          if (
            items.length > 0 &&
            (contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
              logicalBytes + plaintextBytes > MAX_SECURE_BATCH_LOGICAL_BYTES)
          ) break;
          items.push({
            ordinal: items.length,
            plaintext,
            context,
            keyVersion,
            __logicalBytes: plaintextBytes,
            __contextBytes: contextBytes,
          });
          logicalBytes += plaintextBytes;
          cursor += 1;
          if (contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES || plaintextBytes > MAX_SECURE_BATCH_LOGICAL_BYTES) break;
        }
        const firstIsOversized = items.length === 1 && (
          items[0].__contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
          items[0].__logicalBytes > MAX_SECURE_BATCH_LOGICAL_BYTES
        );
        if (firstIsOversized) {
          const item = items[0];
          recordStringify();
          const result = await secureCall('SecureBridge', 'encryptSensitivePayload', {
            plaintext: item.plaintext,
            context: item.context,
            keyVersion,
          }, batchP0Meta(span, payloadKind));
          if (typeof result?.ciphertext !== 'string') throw new Error('Secure encrypt response is invalid.');
          if (span) span.at_rest_ciphertext_b64_chars = result.ciphertext.length;
          outcome = 'success';
          consumed = 1;
          return { consumed, values: [wrapAndroidCiphertext(result.ciphertext, keyVersion)] };
        }

        const requestItems = items.map(({ __logicalBytes, __contextBytes, ...item }) => item);
        while (requestItems.length > 1 && utf8Length(JSON.stringify({
          batchVersion: SECURE_BATCH_VERSION,
          items: requestItems,
        })) > MAX_SECURE_BATCH_METHOD_JSON_BYTES) {
          requestItems.pop();
          items.pop();
        }
        const request = { batchVersion: SECURE_BATCH_VERSION, items: requestItems };
        if (utf8Length(JSON.stringify(request)) > MAX_SECURE_BATCH_METHOD_JSON_BYTES) {
          const item = requestItems[0];
          recordStringify();
          const result = await secureCall('SecureBridge', 'encryptSensitivePayload', {
            plaintext: item.plaintext,
            context: item.context,
            keyVersion,
          }, batchP0Meta(span, payloadKind));
          if (typeof result?.ciphertext !== 'string') throw new Error('Secure encrypt response is invalid.');
          if (span) span.at_rest_ciphertext_b64_chars = result.ciphertext.length;
          outcome = 'success';
          consumed = 1;
          return { consumed, values: [wrapAndroidCiphertext(result.ciphertext, keyVersion)] };
        }

        recordStringify();
        const result = await secureCall(
          'SecureBridge',
          'encryptSensitivePayload',
          request,
          batchP0Meta(span, payloadKind)
        );
        const validated = validateBatchResults(
          result,
          requestItems.length,
          'encrypt',
          requestItems.map((item) => item.keyVersion)
        );
        if (span) {
          span.at_rest_ciphertext_b64_chars = validated.reduce(
            (sum, item) => sum + item.ciphertext.length,
            0
          );
        }
        outcome = 'success';
        consumed = requestItems.length;
        return {
          consumed,
          values: validated.map((item) => wrapAndroidCiphertext(item.ciphertext, Number(item.keyVersion))),
        };
      } catch (error) {
        // A JSON.stringify throw still owns the partial synchronous interval.
        recordStringify();
        throw error;
      } finally {
        closeLogicalSpan(span, outcome);
      }
    });

    throwIfAborted(options.signal);
    encryptedValues.push(...prepared.values);
    start += prepared.consumed;
    options.onProgress?.({ completed: start, total: source.length });
    if (start < source.length) await yieldSecureBulkTurn();
  }

  throwIfAborted(options.signal);
  return encryptedValues;
}

/**
 * Decrypt an ordered collection with bounded physical batches on Android.
 * @param {{payload: any, context?: string}[]} entries
 * @param {{signal?: AbortSignal, onProgress?: Function}} options
 */
export async function decryptSensitiveValues(entries = [], options = {}) {
  const source = Array.isArray(entries) ? entries : [];
  if (!source.length) return [];
  throwIfAborted(options.signal);

  if (!isAndroid()) {
    assertSupportedNativeCrypto();
    const values = [];
    for (let index = 0; index < source.length; index += 1) {
      throwIfAborted(options.signal);
      const entry = source[index] || {};
      values.push(await decryptSensitiveValue(entry.payload, secureEntryContext(entry)));
      options.onProgress?.({ completed: index + 1, total: source.length });
      if ((index + 1) % MAX_SECURE_BATCH_RECORDS === 0 && index + 1 < source.length) {
        await yieldSecureBulkTurn();
      }
    }
    return values;
  }

  const decryptedValues = [];
  let start = 0;

  while (start < source.length) {
    throwIfAborted(options.signal);
    const entryAtStart = source[start] || {};
    if (!isEncryptedPayload(entryAtStart.payload)) {
      decryptedValues.push(entryAtStart.payload);
      start += 1;
      options.onProgress?.({ completed: start, total: source.length });
      continue;
    }

    const prepared = await withSecureBulkAdmission(async () => {
      throwIfAborted(options.signal);
      const payloadKind = payloadKindForContext(secureEntryContext(source[start]));
      const span = openBatchLogicalSpan(payloadKind);
      const mark = () => (span ? p0Now() : 0);
      let outcome = 'error';
      try {
        const items = [];
        let logicalBytes = 0;
        let cursor = start;
        while (cursor < source.length && items.length < MAX_SECURE_BATCH_RECORDS) {
          if (payloadKindForContext(secureEntryContext(source[cursor])) !== payloadKind) break;
          const entry = source[cursor] || {};
          if (!isEncryptedPayload(entry.payload)) break;
          const context = secureEntryContext(entry);
          const contextBytes = utf8Length(context);
          const plaintextUpperBound = conservativeAndroidPlaintextBytes(entry.payload.ciphertext);
          if (
            items.length > 0 &&
            (contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
              plaintextUpperBound == null ||
              logicalBytes + plaintextUpperBound > MAX_SECURE_BATCH_LOGICAL_BYTES ||
              decryptBatchResponseUpperBound([
                ...items,
                { ordinal: items.length, __logicalBytes: plaintextUpperBound },
              ]) > MAX_SECURE_BATCH_METHOD_JSON_BYTES)
          ) break;
          items.push({
            ordinal: items.length,
            ciphertext: entry.payload.ciphertext,
            context,
            keyVersion: Number.isInteger(Number(entry.payload.key_version))
              ? Number(entry.payload.key_version)
              : LEGACY_ANDROID_KEY_VERSION,
            __logicalBytes: plaintextUpperBound,
            __contextBytes: contextBytes,
          });
          logicalBytes += Math.max(0, plaintextUpperBound ?? 0);
          cursor += 1;
          if (
            contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
            plaintextUpperBound == null ||
            plaintextUpperBound > MAX_SECURE_BATCH_LOGICAL_BYTES
          ) break;
        }

        const firstIsOversized = items.length === 1 && (
          items[0].__contextBytes > MAX_SECURE_BATCH_CONTEXT_BYTES ||
          items[0].__logicalBytes == null ||
          items[0].__logicalBytes > MAX_SECURE_BATCH_LOGICAL_BYTES
        );
        let plaintexts;
        let consumed;
        if (firstIsOversized) {
          const item = items[0];
          const result = await secureCall('SecureBridge', 'decryptSensitivePayload', {
            ciphertext: item.ciphertext,
            context: item.context,
            keyVersion: item.keyVersion,
          }, batchP0Meta(span, payloadKind));
          if (typeof result?.plaintext !== 'string') throw new Error('Secure decrypt response is invalid.');
          plaintexts = [result.plaintext];
          consumed = 1;
        } else {
          const packingStart = mark();
          let requestItems;
          let request;
          let requestBytes;
          try {
            requestItems = items.map(({ __logicalBytes, __contextBytes, ...item }) => item);
            request = { batchVersion: SECURE_BATCH_VERSION, items: requestItems };
            requestBytes = utf8Length(JSON.stringify(request));
            while (requestItems.length > 1 && requestBytes > MAX_SECURE_BATCH_METHOD_JSON_BYTES) {
              requestItems.pop();
              requestBytes = utf8Length(JSON.stringify(request));
            }
          } catch (error) {
            if (span) recordP0Phase(span, 'logical_stringify', packingStart, p0Now());
            throw error;
          }
          if (span) recordP0Phase(span, 'logical_stringify', packingStart, p0Now());
          if (requestBytes > MAX_SECURE_BATCH_METHOD_JSON_BYTES) {
            const item = requestItems[0];
            const result = await secureCall('SecureBridge', 'decryptSensitivePayload', {
              ciphertext: item.ciphertext,
              context: item.context,
              keyVersion: item.keyVersion,
            }, batchP0Meta(span, payloadKind));
            if (typeof result?.plaintext !== 'string') throw new Error('Secure decrypt response is invalid.');
            plaintexts = [result.plaintext];
            consumed = 1;
          } else {
            const result = await secureCall(
              'SecureBridge',
              'decryptSensitivePayload',
              request,
              batchP0Meta(span, payloadKind)
            );
            plaintexts = validateBatchResults(result, requestItems.length, 'decrypt')
              .map((item) => item.plaintext);
            consumed = requestItems.length;
          }
        }

        const parseStart = mark();
        let values;
        try {
          values = plaintexts.map((plaintext) => JSON.parse(plaintext));
        } catch (error) {
          if (span) recordP0Phase(span, 'logical_parse', parseStart, p0Now());
          throw error;
        }
        if (span) {
          recordP0Phase(span, 'logical_parse', parseStart, p0Now());
          span.at_rest_ciphertext_b64_chars = items
            .slice(0, consumed)
            .reduce((sum, item) => sum + item.ciphertext.length, 0);
        }
        outcome = 'success';
        return { consumed, values };
      } finally {
        closeLogicalSpan(span, outcome);
      }
    });

    throwIfAborted(options.signal);
    decryptedValues.push(...prepared.values);
    start += prepared.consumed;
    options.onProgress?.({ completed: start, total: source.length });
    if (start < source.length) await yieldSecureBulkTurn();
  }

  throwIfAborted(options.signal);
  return decryptedValues;
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
  // AUD-007 round 2. This is a REAL publication path: it captures the current key
  // version at encrypt time and publishes durably some time later. Rotation must not be
  // able to prove "zero references" in that window and then destroy the version this
  // writer is about to publish under. The fence is held across the whole publication,
  // not just the encrypt.
  // Round 4: ADMISSION, not just a counter. A writer arriving while a version is being
  // finalized now waits here and captures the surviving version when admission reopens,
  // instead of capturing a version that is about to be destroyed.
  const release = await admitBrowserKeyWrite();
  try {
    const encrypted = await encryptSensitiveValue(value, `storage:${key}`, options);
    await setJson(key, encrypted);
    // Recorded where it is written. Discovery no longer *depends* on this index: the
    // rotation sweep enumerates the durable store, so a failed index write can no longer
    // create an undiscoverable ciphertext. It is still reported rather than swallowed —
    // a degraded discoverability record is worth knowing about — but it must not fail a
    // publication whose ciphertext is already durable, which would leave the caller
    // believing nothing was written.
    try {
      await noteEncryptedDocumentKey(key);
    } catch (error) {
      const { logSystemFailure } = await import('@/lib/systemLog');
      logSystemFailure('encrypted_document_index_write', error, { document_key: key });
    }
  } finally {
    release();
  }
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
