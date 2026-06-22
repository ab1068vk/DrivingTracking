const DEFAULT_NOISE_BYTES = 4096;
const MAX_NOISE_BYTES = 1024 * 1024;

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const randomHex = (byteLength) => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Secure random generation is unavailable.');
  }

  const bytes = new Uint8Array(byteLength);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    cryptoApi.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, bytes.length)));
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const isSecureDeleteTombstone = (record) => (
  record?._secure_delete_tombstone === true
);

/**
 * Best-effort record deletion for IndexedDB.
 *
 * Browsers do not expose physical page placement, flash wear-leveling, or a
 * compaction API, so this cannot ensure media sanitization. Sensitive
 * records must remain encrypted at rest; the committed random tombstone only
 * reduces recoverable application data before the logical delete.
 */
export async function secureDelete(db, storeName, key, options = {}) {
  const keyPath = options.keyPath || 'id';

  const readTransaction = db.transaction(storeName, 'readonly');
  const existing = await requestResult(readTransaction.objectStore(storeName).get(key));
  if (existing == null) return false;

  const existingBytes = new TextEncoder().encode(JSON.stringify(existing)).byteLength;
  const noiseBytes = Math.min(
    MAX_NOISE_BYTES,
    Math.max(DEFAULT_NOISE_BYTES, existingBytes)
  );
  const tombstone = {
    [keyPath]: key,
    status: 'secure-delete-pending',
    _secure_delete_tombstone: true,
    _secure_delete_at: Date.now(),
    random_padding: randomHex(noiseBytes),
  };

  const overwriteTransaction = db.transaction(storeName, 'readwrite');
  overwriteTransaction.objectStore(storeName).put(tombstone);
  await transactionDone(overwriteTransaction);

  const deleteTransaction = db.transaction(storeName, 'readwrite');
  deleteTransaction.objectStore(storeName).delete(key);
  await transactionDone(deleteTransaction);

  if (typeof db.compact === 'function') {
    await db.compact();
  }
  return true;
}
