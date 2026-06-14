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

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => storage.has(key) ? storage.get(key) : fallback),
  setJson: vi.fn(async (key, value) => storage.set(key, value)),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  ENCRYPTION_KEY_META_KEY: 'drivesense_encryption_key_meta',
  ensureEncryptionKeyVersion,
  deleteEncryptionKeyVersion,
  rotateEncryptedJsonKey,
}));

vi.mock('@/lib/localTripRepository', () => ({ rotateTripEncryptionKey }));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent,
}));

describe('keyRotationManager', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
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
});
