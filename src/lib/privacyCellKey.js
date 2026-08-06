import { getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { hmacSha256, toHex, utf8Bytes } from '@/lib/sha256';

// Cell hashes used to be an unsalted 32-bit string hash of "cellSize:y:x". That
// is reversible by brute force: the grid is public, the coarse display region
// narrows the search to about 16k candidates, and each candidate costs one cheap
// hash. Keying the hash with a device-local secret removes that shortcut - the
// hash list on its own no longer locates anything.
//
// Legacy `pzc_` hashes are still matched (see privacyZones.js) so an existing
// zone keeps protecting its area until migration re-keys it.
export const PRIVACY_CELL_KEY_SECURE_KEY = 'drivesense_privacy_cell_key_v1';
export const KEYED_CELL_HASH_PREFIX = 'pzc2_';
const KEY_BYTES = 32;
const HASH_BYTES = 8;
const MEMO_LIMIT = 60000;

let cellKeyBytes = null;
let cellKeyBase64 = '';
let memo = new Map();

const encodeBase64 = (bytes) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const decodeBase64 = (value) => {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

function applyKey(base64) {
  const text = String(base64 || '');
  if (text === cellKeyBase64) return cellKeyBytes;
  const bytes = text ? decodeBase64(text) : null;
  if (bytes && bytes.length < 16) throw new Error('Privacy cell key is too short to be usable.');
  cellKeyBytes = bytes;
  cellKeyBase64 = bytes ? text : '';
  memo = new Map();
  return cellKeyBytes;
}

/** True when keyed cell hashes can be evaluated right now. */
export function hasPrivacyCellKey() {
  return cellKeyBytes != null;
}

export function privacyCellKeyBase64() {
  return cellKeyBase64;
}

/** Read the key if one exists. Never creates one, so key-less devices stay key-less. */
export async function loadPrivacyCellKey() {
  if (cellKeyBytes) return cellKeyBytes;
  return applyKey(await getEncryptedJson(PRIVACY_CELL_KEY_SECURE_KEY, ''));
}

/** Read the key, creating it on first use. Call before writing zones. */
export async function ensurePrivacyCellKey() {
  const existing = await loadPrivacyCellKey();
  if (existing) return existing;

  const bytes = new Uint8Array(KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  const base64 = encodeBase64(bytes);
  await setEncryptedJson(PRIVACY_CELL_KEY_SECURE_KEY, base64);
  return applyKey(base64);
}

/** Used by the native sync path and by tests to adopt a specific key. */
export function adoptPrivacyCellKey(base64) {
  return applyKey(base64);
}

/**
 * Keyed cell hash, or null when no key is loaded. Callers must treat null as
 * "cannot decide" and fail closed rather than as "not in a zone".
 * @param {number} y
 * @param {number} x
 * @param {number} cellSizeM
 */
export function keyedPrivacyCellHash(y, x, cellSizeM) {
  if (!cellKeyBytes) return null;
  const label = `${Math.round(cellSizeM)}:${y}:${x}`;
  const cached = memo.get(label);
  if (cached) return cached;

  const hash = KEYED_CELL_HASH_PREFIX + toHex(hmacSha256(cellKeyBytes, utf8Bytes(label)), HASH_BYTES);
  // The ring search rehashes neighbouring cells for every point of a route, and
  // consecutive points share almost all of them, so memoizing by cell is what
  // keeps a full-route mask cheap. The cap stops a long import from growing it
  // without bound.
  if (memo.size >= MEMO_LIMIT) memo.clear();
  memo.set(label, hash);
  return hash;
}

export function isKeyedCellHash(hash) {
  return typeof hash === 'string' && hash.startsWith(KEYED_CELL_HASH_PREFIX);
}
