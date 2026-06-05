const BACKUP_ENC_VERSION = 1;
const BACKUP_PASSWORD_MIN_LENGTH = 12;
const BACKUP_PASSWORD_MAX_LENGTH = 128;
const BACKUP_PBKDF2_ITERATIONS = 600000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const HEADER_SIZE = 1 + SALT_BYTES + IV_BYTES;

self.onmessage = async (event) => {
  const { type, requestId, payload, password } = event.data || {};
  if (type !== 'decrypt') return;

  try {
    const plaintext = await decryptBackupPayload(payload, password);
    self.postMessage({ type: 'result', requestId, plaintext });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, code: classifyDecryptError(error) });
  }
};

async function decryptBackupPayload(encryptedB64, password) {
  assertImportPassword(password);

  const bytes = base64ToBytes(encryptedB64);
  const version = bytes[0];
  if (version !== BACKUP_ENC_VERSION || bytes.length <= HEADER_SIZE + 16) {
    throw Object.assign(new Error('Unsupported or incomplete encrypted backup.'), { code: 'invalid_format' });
  }

  const salt = bytes.slice(1, 1 + SALT_BYTES);
  const iv = bytes.slice(1 + SALT_BYTES, HEADER_SIZE);
  const ciphertext = bytes.slice(HEADER_SIZE);
  const key = await deriveKey(password, salt);

  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw Object.assign(new Error('Wrong backup password.'), { code: 'wrong_password' });
  }
}

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: BACKUP_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

function assertImportPassword(password) {
  const value = typeof password === 'string' ? password : '';
  if (value.length < BACKUP_PASSWORD_MIN_LENGTH || value.length > BACKUP_PASSWORD_MAX_LENGTH) {
    throw Object.assign(new Error('Backup password does not meet import requirements.'), { code: 'invalid_format' });
  }
}

function classifyDecryptError(error) {
  if (error?.code === 'wrong_password') return 'wrong_password';
  if (error?.code === 'invalid_format') return 'invalid_format';
  return 'decrypt_failed';
}

function base64ToBytes(value) {
  try {
    const binary = atob(String(value || '').trim());
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw Object.assign(new Error('Encrypted backup is not valid base64.'), { code: 'invalid_format' });
  }
}
