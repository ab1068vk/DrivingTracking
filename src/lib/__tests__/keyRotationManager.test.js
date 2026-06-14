import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map();
const ensureEncryptionKeyVersion = vi.fn();
const deleteEncryptionKeyVersion = vi.fn();
const rotateEncryptedJsonKey = vi.fn(async () => true);
const rotateTripEncryptionKey = vi.fn(async () => ({
  indexedDbRecordsRotated: 3,
  fallbackStoreRotated: true,
}));
const recordSystemEvent = vi.fn();
const encryptedStorage = new Map();
const getActiveEncryptionKeyVersion = vi.fn(async () => 1);
const inspectStoredTripKeyVersions = vi.fn(async () => []);

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
  inspectStoredTripKeyVersions,
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
  });

  it('initializes rotation metadata without rewriting records', async () => {
    const { checkAndRotateEncryptionKey } = await import('@/lib/keyRotationManager');
    const result = await checkAndRotateEncryptionKey({ now: 1000 });

    expect(result).toMatchObject({ initialized: true, rotated: false, version: 1 });
    expect(ensureEncryptionKeyVersion).toHaveBeenCalledWith(1);
    expect(rotateTripEncryptionKey).not.toHaveBeenCalled();
  });

  it('resumes and completes a due rotation before deleting the retired key', async () => {
    storage.set('drivesense_encryption_key_meta', {
      version: 1,
      lastRotated: 1000,
    });
    const now = 1000 + (31 * 24 * 60 * 60 * 1000);
    const { checkAndRotateEncryptionKey } = await import('@/lib/keyRotationManager');
    const result = await checkAndRotateEncryptionKey({ now });

    expect(ensureEncryptionKeyVersion).toHaveBeenCalledWith(2);
    expect(rotateTripEncryptionKey).toHaveBeenCalledWith(2);
    expect(rotateEncryptedJsonKey).toHaveBeenCalledTimes(5);
    expect(deleteEncryptionKeyVersion).toHaveBeenCalledWith(1);
    expect(storage.get('drivesense_encryption_key_meta')).toEqual({
      version: 2,
      lastRotated: now,
    });
    expect(result).toMatchObject({
      rotated: true,
      previousVersion: 1,
      version: 2,
      encryptedJsonValuesRotated: 5,
    });
    expect(recordSystemEvent).toHaveBeenCalledWith(
      'encryption_key_rotated',
      expect.objectContaining({ indexeddb_record_count: 3 }),
      expect.any(Object)
    );
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
