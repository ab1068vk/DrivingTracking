import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map();
const ensureEncryptionKeyVersion = vi.fn();
const deleteEncryptionKeyVersion = vi.fn();
const rotateEncryptedJsonKey = vi.fn(async () => true);
const rotateTripEncryptionKey = vi.fn(async () => ({
  indexedDbRecordsRotated: 3,
  fallbackStoreRotated: true,
}));
// P4-C-F05: the browser rotation is driven one bounded window at a time. Two
// windows with records, then the exhausted window that rotates the fallback
// blob and reports the sweep finished.
const stepTripEncryptionKeyRotationBatch = vi.fn()
  .mockResolvedValueOnce({ indexedDbRecordsRotated: 2, fallbackStoreRotated: false, processed: 2, hasMore: true })
  .mockResolvedValueOnce({ indexedDbRecordsRotated: 1, fallbackStoreRotated: false, processed: 1, hasMore: true })
  .mockResolvedValue({ indexedDbRecordsRotated: 0, fallbackStoreRotated: true, processed: 0, hasMore: false });
const recordSystemEvent = vi.fn();
const encryptedStorage = new Map();
const getActiveEncryptionKeyVersion = vi.fn(async () => 1);
const inspectStoredTripKeyVersions = vi.fn(async () => []);
// P4-C-F05: with no fallback archive present, nothing still needs the old key.
const fallbackTripDocumentReleasesKey = vi.fn(async () => true);

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => storage.has(key) ? storage.get(key) : fallback),
  setJson: vi.fn(async (key, value) => storage.set(key, value)),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  ENCRYPTION_KEY_META_KEY: 'drivesense_encryption_key_meta',
  ensureEncryptionKeyVersion,
  deleteEncryptionKeyVersion,
  rotateEncryptedJsonKey,
  getActiveEncryptionKeyVersion,
  getEncryptedJson: vi.fn(async (key, fallback) => encryptedStorage.has(key) ? encryptedStorage.get(key) : fallback),
  setEncryptedJson: vi.fn(async (key, value) => encryptedStorage.set(key, value)),
}));

vi.mock('@/lib/localTripRepository', () => ({
  rotateTripEncryptionKey,
  stepTripEncryptionKeyRotationBatch,
  inspectStoredTripKeyVersions,
  // P4-C-F05: the fallback archive's reference proof. `false` is the fail-safe
  // answer - the retiring key is retained, never destroyed on an unknown.
  fallbackTripDocumentReleasesKey,
}));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent,
}));

describe('keyRotationManager', () => {
  beforeEach(() => {
    storage.clear();
    encryptedStorage.clear();
    vi.clearAllMocks();
    getActiveEncryptionKeyVersion.mockResolvedValue(1);
    inspectStoredTripKeyVersions.mockResolvedValue([]);
    fallbackTripDocumentReleasesKey.mockResolvedValue(true);
  });

  it('initializes rotation metadata without rewriting records', async () => {
    const { checkAndRotateEncryptionKey } = await import('@/lib/keyRotationManager');
    const result = await checkAndRotateEncryptionKey({ now: 1000 });

    expect(result).toMatchObject({ initialized: true, rotated: false, version: 1 });
    expect(ensureEncryptionKeyVersion).toHaveBeenCalledWith(1);
    expect(stepTripEncryptionKeyRotationBatch).not.toHaveBeenCalled();
  });

  it('resumes and completes a due rotation before deleting the retired key', async () => {
    storage.set('drivesense_encryption_key_meta', {
      version: 1,
      lastRotated: 1000,
    });
    const now = 1000 + (31 * 24 * 60 * 60 * 1000);
    const {
      checkAndRotateEncryptionKey,
      ROTATING_ENCRYPTED_JSON_KEYS,
    } = await import('@/lib/keyRotationManager');
    const result = await checkAndRotateEncryptionKey({ now });

    expect(ensureEncryptionKeyVersion).toHaveBeenCalledWith(2);
    // Bounded windows, all against the same target version, and finalization
    // only after the last one reported the sweep complete.
    expect(stepTripEncryptionKeyRotationBatch).toHaveBeenCalledTimes(3);
    for (const call of stepTripEncryptionKeyRotationBatch.mock.calls) expect(call[0]).toBe(2);
    expect(rotateEncryptedJsonKey).toHaveBeenCalledTimes(ROTATING_ENCRYPTED_JSON_KEYS.length);
    expect(deleteEncryptionKeyVersion).toHaveBeenCalledWith(1);
    expect(storage.get('drivesense_encryption_key_meta')).toEqual({
      version: 2,
      lastRotated: now,
    });
    expect(result).toMatchObject({
      rotated: true,
      previousVersion: 1,
      version: 2,
      encryptedJsonValuesRotated: ROTATING_ENCRYPTED_JSON_KEYS.length,
    });
    expect(recordSystemEvent).toHaveBeenCalledWith(
      'encryption_key_rotated',
      expect.objectContaining({ indexeddb_record_count: 3 }),
      expect.any(Object)
    );
  });

  /**
   * P4-C-F05 — the retained-key contract, end to end.
   *
   * A rotation that finishes while the monolithic fallback archive is still on
   * the retiring key records that version instead of destroying it. It stays
   * retained across a further rotation, and is released only once the explicit
   * compatibility owner has rewritten the archive and the reference proves it.
   */
  const rotateOnce = async (from, to, { at }) => {
    const { checkAndRotateEncryptionKey } = await import('@/lib/keyRotationManager');
    storage.set('drivesense_encryption_key_meta', {
      ...(storage.get('drivesense_encryption_key_meta') || {}),
      version: from,
      lastRotated: at - (31 * 24 * 60 * 60 * 1000),
    });
    getActiveEncryptionKeyVersion.mockResolvedValue(from);
    stepTripEncryptionKeyRotationBatch.mockReset();
    stepTripEncryptionKeyRotationBatch.mockResolvedValue({
      indexedDbRecordsRotated: 0, fallbackStoreRotated: false, processed: 0, hasMore: false,
    });
    const result = await checkAndRotateEncryptionKey({ now: at });
    expect(result.version).toBe(to);
    return result;
  };

  it('retains V1 through V2 and V3 while the fallback archive still needs it', async () => {
    // The archive is on V1 and has not been converted: nothing releases V1.
    fallbackTripDocumentReleasesKey.mockResolvedValue(false);

    await rotateOnce(1, 2, { at: 5_000_000_000 });
    expect(storage.get('drivesense_encryption_key_meta')).toMatchObject({
      version: 2,
      retainedKeyVersions: [1],
      retainedFor: 'explicit-compatibility-maintenance',
    });
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();

    // A second rotation before any conversion still may not destroy V1.
    await rotateOnce(2, 3, { at: 6_000_000_000 });
    expect(storage.get('drivesense_encryption_key_meta')).toMatchObject({
      version: 3,
      retainedKeyVersions: [1, 2],
    });
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();
  });

  it('releases retained versions once the compatibility owner proves the archive moved', async () => {
    fallbackTripDocumentReleasesKey.mockResolvedValue(false);
    await rotateOnce(1, 2, { at: 5_000_000_000 });
    expect(storage.get('drivesense_encryption_key_meta').retainedKeyVersions).toEqual([1]);

    const { releaseRetainedKeyVersions } = await import('@/lib/keyRotationManager');

    // Still unproven: the release is a no-op rather than a destruction.
    await expect(releaseRetainedKeyVersions()).resolves.toEqual({ released: [], retained: [1] });
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();

    // The explicit owner rewrote the archive; the reference now proves it.
    fallbackTripDocumentReleasesKey.mockResolvedValue(true);
    await expect(releaseRetainedKeyVersions()).resolves.toEqual({ released: [1], retained: [] });

    expect(deleteEncryptionKeyVersion).toHaveBeenCalledWith(1);
    // The debt is gone from the metadata, not merely emptied in place.
    expect(storage.get('drivesense_encryption_key_meta')).toEqual({
      version: 2,
      lastRotated: expect.any(Number),
    });
  });

  it('never releases the version the store is currently on', async () => {
    storage.set('drivesense_encryption_key_meta', {
      version: 2, lastRotated: 1, retainedKeyVersions: [2, 3],
      retainedFor: 'explicit-compatibility-maintenance',
    });
    fallbackTripDocumentReleasesKey.mockResolvedValue(true);
    const { releaseRetainedKeyVersions } = await import('@/lib/keyRotationManager');

    await expect(releaseRetainedKeyVersions()).resolves.toEqual({ released: [], retained: [2, 3] });
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();
  });

  it('reports unknown with no encrypted records and warns for pending versions', async () => {
    const { getKeyRotationStatus } = await import('@/lib/keyRotationManager');
    await expect(getKeyRotationStatus()).resolves.toMatchObject({
      status: 'unknown',
      activeKeyVersion: 1,
    });

    getActiveEncryptionKeyVersion.mockResolvedValue(2);
    inspectStoredTripKeyVersions.mockResolvedValue([1, 2]);
    await expect(getKeyRotationStatus()).resolves.toMatchObject({
      status: 'warn',
      payloadsPendingRotation: 1,
    });
  });

  it('caps the encrypted rotation log at 20 entries', async () => {
    encryptedStorage.set(
      'drivesense_key_rotation_log_v1',
      Array.from({ length: 25 }, (_, index) => ({ status: 'ok', completedAt: index }))
    );
    const { loadRotationLog } = await import('@/lib/keyRotationManager');
    const log = await loadRotationLog();
    expect(log).toHaveLength(20);
    expect(log[0].completedAt).toBe(5);
  });
});
