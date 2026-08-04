export const ENCRYPTED_BACKUP_FORMAT = 'road-sage-encrypted-backup';
export const ENCRYPTED_BACKUP_FORMAT_VERSION = 1;
export const ENCRYPTED_BACKUP_KDF = 'PBKDF2-SHA-256';
export const ENCRYPTED_BACKUP_CIPHER = 'AES-256-GCM';
export const ENCRYPTED_BACKUP_COMPRESSION = 'gzip';
export const ENCRYPTED_BACKUP_EXTENSION = '.drivesensebackup';
export const ENCRYPTED_BACKUP_MIME_TYPE = 'application/vnd.road-sage.encrypted-backup+json';
export const BACKUP_PASSPHRASE_MIN_LENGTH = 12;
export const BACKUP_KDF_ITERATIONS = 210_000;
// Backup files are shared (support requests, cloud drives, new-phone restore), so the
// iteration count is untrusted input. An unbounded value would stall PBKDF2 for minutes
// before the app could even report a wrong passphrase. Keep headroom above the current
// default so backups written by future versions still restore.
export const BACKUP_KDF_MIN_ITERATIONS = 1_000;
export const BACKUP_KDF_MAX_ITERATIONS = 1_000_000;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const BASE64_CHUNK_SIZE = 0x8000;

const throwIfAborted = (signal) => {
  if (!signal?.aborted) return;
  const error = new Error('Backup export cancelled.');
  error.name = 'AbortError';
  throw error;
};

export const BACKUP_PASSWORD_REQUIRED_CODE = 'backup_password_required';
export const BACKUP_WRONG_PASSWORD_CODE = 'backup_wrong_password';
export const BACKUP_UNSUPPORTED_ENCRYPTION_CODE = 'backup_unsupported_encryption';
export const BACKUP_DECOMPRESSED_TOO_LARGE_CODE = 'backup_decompressed_too_large';

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
const makeBackupCryptoError = (message, code) => {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
};

const cryptoProvider = () => {
  const provider = globalThis.crypto;
  if (!provider?.subtle || typeof provider.getRandomValues !== 'function') {
    throw new Error('Encrypted backups require Web Crypto support.');
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
  try {
    const binary = atob(String(value || ''));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw makeBackupCryptoError(
      'Encrypted backup data is not valid base64.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }
};

const validatePassphrase = (passphrase) => {
  if (typeof passphrase !== 'string' || passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw makeBackupCryptoError(
      `Backup password must be at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters.`,
      BACKUP_PASSWORD_REQUIRED_CODE
    );
  }
};

async function deriveBackupKey(passphrase, salt, iterations) {
  validatePassphrase(passphrase);
  const crypto = cryptoProvider();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

const transformBackupBytes = async (bytes, mode) => {
  const Transform = mode === 'compress'
    ? globalThis.CompressionStream
    : globalThis.DecompressionStream;
  if (typeof Transform !== 'function') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new Transform(ENCRYPTED_BACKUP_COMPRESSION));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const compressBackupBytes = async (bytes) => {
  const compressed = await transformBackupBytes(bytes, 'compress').catch(() => null);
  return compressed && compressed.length < bytes.length
    ? { bytes: compressed, compression: ENCRYPTED_BACKUP_COMPRESSION }
    : { bytes, compression: null };
};

const decompressBackupText = async (
  bytes,
  compression,
  { maxBytes = MAX_BACKUP_DECOMPRESSED_BYTES, signal, onProgress } = {}
) => {
  throwIfAborted(signal);
  if (!compression) {
    if (bytes.length > maxBytes) {
      throw makeBackupCryptoError(
        BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
        BACKUP_DECOMPRESSED_TOO_LARGE_CODE
      );
    }
    onProgress?.({ phase: 'decompressing', completed: bytes.length, total: bytes.length });
    return new TextDecoder().decode(bytes);
  }
  if (compression !== ENCRYPTED_BACKUP_COMPRESSION) {
    throw makeBackupCryptoError(
      'Encrypted backup compression is not supported.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw makeBackupCryptoError(
      'This device cannot decompress the encrypted backup.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }

  let reader;
  try {
    reader = new Blob([bytes])
      .stream()
      .pipeThrough(new globalThis.DecompressionStream(ENCRYPTED_BACKUP_COMPRESSION))
      .getReader();
    const decoder = new TextDecoder();
    const textChunks = [];
    let totalBytes = 0;
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw makeBackupCryptoError(
          BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
          BACKUP_DECOMPRESSED_TOO_LARGE_CODE
        );
      }
      textChunks.push(decoder.decode(value, { stream: true }));
      onProgress?.({ phase: 'decompressing', completed: totalBytes, total: maxBytes });
    }
    textChunks.push(decoder.decode());
    return textChunks.join('');
  } catch (error) {
    if (
      error?.name === 'AbortError' ||
      error?.code === BACKUP_DECOMPRESSED_TOO_LARGE_CODE ||
      error?.code === BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    ) {
      throw error;
    }
    throw makeBackupCryptoError(
      'This device cannot decompress the encrypted backup.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  } finally {
    reader?.releaseLock?.();
  }
};

const isSupportedIterationCount = (value) => {
  const iterations = Number(value);
  return Number.isInteger(iterations) &&
    iterations >= BACKUP_KDF_MIN_ITERATIONS &&
    iterations <= BACKUP_KDF_MAX_ITERATIONS;
};

const validateEnvelope = (envelope) => {
  if (
    !envelope ||
    envelope.app !== 'Road Sage' ||
    envelope.format !== ENCRYPTED_BACKUP_FORMAT ||
    envelope.format_version !== ENCRYPTED_BACKUP_FORMAT_VERSION
  ) {
    throw makeBackupCryptoError(
      'This encrypted backup format is not supported by this version of Road Sage.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }
  if (
    envelope.kdf !== ENCRYPTED_BACKUP_KDF ||
    envelope.cipher !== ENCRYPTED_BACKUP_CIPHER ||
    (envelope.compression != null && envelope.compression !== ENCRYPTED_BACKUP_COMPRESSION) ||
    !isSupportedIterationCount(envelope.iterations) ||
    typeof envelope.salt !== 'string' ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.ciphertext !== 'string'
  ) {
    throw makeBackupCryptoError(
      'Encrypted backup metadata is incomplete.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }
};

export function isEncryptedBackupEnvelope(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed?.app === 'Road Sage' &&
      parsed?.format === ENCRYPTED_BACKUP_FORMAT &&
      parsed?.format_version === ENCRYPTED_BACKUP_FORMAT_VERSION;
  } catch {
    return false;
  }
}

export async function encryptBackupText(
  plaintext,
  passphrase,
  { exportedAt = new Date().toISOString(), signal, onProgress } = {}
) {
  throwIfAborted(signal);
  const crypto = cryptoProvider();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintextBytes = new TextEncoder().encode(String(plaintext));
  onProgress?.({ phase: 'compressing', completed: 0, total: plaintextBytes.length });
  const [key, compressed] = await Promise.all([
    deriveBackupKey(passphrase, salt, BACKUP_KDF_ITERATIONS),
    compressBackupBytes(plaintextBytes),
  ]);
  throwIfAborted(signal);
  onProgress?.({ phase: 'encrypting', completed: 0, total: compressed.bytes.length });
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    compressed.bytes
  );
  throwIfAborted(signal);
  onProgress?.({ phase: 'encrypting', completed: compressed.bytes.length, total: compressed.bytes.length });

  return JSON.stringify({
    app: 'Road Sage',
    format: ENCRYPTED_BACKUP_FORMAT,
    format_version: ENCRYPTED_BACKUP_FORMAT_VERSION,
    exported_at: exportedAt,
    kdf: ENCRYPTED_BACKUP_KDF,
    cipher: ENCRYPTED_BACKUP_CIPHER,
    ...(compressed.compression ? { compression: compressed.compression } : {}),
    iterations: BACKUP_KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptBackupText(
  encryptedText,
  passphrase,
  { maxDecompressedBytes = MAX_BACKUP_DECOMPRESSED_BYTES, signal, onProgress } = {}
) {
  throwIfAborted(signal);
  validatePassphrase(passphrase);

  let envelope;
  try {
    envelope = typeof encryptedText === 'string' ? JSON.parse(encryptedText) : encryptedText;
  } catch {
    throw makeBackupCryptoError(
      'Encrypted backup file is not valid JSON.',
      BACKUP_UNSUPPORTED_ENCRYPTION_CODE
    );
  }
  validateEnvelope(envelope);

  try {
    const salt = base64ToBytes(envelope.salt);
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);
    onProgress?.({ phase: 'decrypting', completed: 0, total: ciphertext.length });
    const key = await deriveBackupKey(passphrase, salt, Number(envelope.iterations));
    throwIfAborted(signal);
    const plaintext = await cryptoProvider().subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
    throwIfAborted(signal);
    onProgress?.({ phase: 'decrypting', completed: ciphertext.length, total: ciphertext.length });
    return decompressBackupText(new Uint8Array(plaintext), envelope.compression, {
      maxBytes: maxDecompressedBytes,
      signal,
      onProgress,
    });
  } catch (error) {
    if (
      error?.name === 'AbortError' ||
      error?.code === BACKUP_PASSWORD_REQUIRED_CODE ||
      error?.code === BACKUP_UNSUPPORTED_ENCRYPTION_CODE ||
      error?.code === BACKUP_DECOMPRESSED_TOO_LARGE_CODE
    ) {
      throw error;
    }
    throw makeBackupCryptoError(
      'Backup password is incorrect or the encrypted backup is damaged.',
      BACKUP_WRONG_PASSWORD_CODE
    );
  }
}
import {
  BACKUP_DECOMPRESSED_TOO_LARGE_MESSAGE,
  MAX_BACKUP_DECOMPRESSED_BYTES,
} from '@/lib/dataBackupConstants';
