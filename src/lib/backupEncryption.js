export const BACKUP_ENC_VERSION = 1;

const PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const HEADER_SIZE = 1 + SALT_BYTES + IV_BYTES;
const BASE64_CHUNK_SIZE = 0x8000;

const subtleCrypto = () => {
  const api = globalThis.crypto?.subtle;
  if (!api || typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Encrypted backups require Web Crypto support.');
  }
  return api;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.slice(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToBytes = (value) => (
  Uint8Array.from(atob(String(value || '').trim()), (char) => char.charCodeAt(0))
);

async function deriveKey(password, salt) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Backup password must be at least 12 characters.');
  }

  const cryptoApi = subtleCrypto();
  const encodedPassword = new TextEncoder().encode(password);
  const baseKey = await cryptoApi.importKey(
    'raw',
    encodedPassword,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return cryptoApi.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBackup(plaintext, password) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ciphertext = await subtleCrypto().encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext)
  );

  const output = new Uint8Array(HEADER_SIZE + ciphertext.byteLength);
  output[0] = BACKUP_ENC_VERSION;
  output.set(salt, 1);
  output.set(iv, 1 + SALT_BYTES);
  output.set(new Uint8Array(ciphertext), HEADER_SIZE);
  return bytesToBase64(output);
}

export async function decryptBackup(encryptedB64, password) {
  const bytes = base64ToBytes(encryptedB64);
  const version = bytes[0];
  if (version !== BACKUP_ENC_VERSION) {
    throw new Error(`Unrecognised backup encryption version: ${version}. Update Road Sage to open this backup.`);
  }
  if (bytes.length <= HEADER_SIZE + 16) {
    throw new Error('Encrypted backup file is incomplete.');
  }

  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const iv = bytes.slice(1 + SALT_BYTES, HEADER_SIZE);
  const ciphertext = bytes.slice(HEADER_SIZE);
  const key = await deriveKey(password, salt);
  const plaintext = await subtleCrypto().decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

export function isEncryptedBackup(value) {
  try {
    const bytes = base64ToBytes(value);
    return bytes[0] === BACKUP_ENC_VERSION && bytes.length > HEADER_SIZE + 16;
  } catch {
    return false;
  }
}
