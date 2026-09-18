import { beforeEach, describe, expect, it, vi } from 'vitest';

const META_KEY = 'drivesense_encryption_key_meta';

const fixture = vi.hoisted(() => ({
  storage: new Map(),
  encrypted: new Map(),
  batchCalls: [],
  remaining: 0,
  activeVersion: 1,
}));

const ensureEncryptionKeyVersion = vi.hoisted(() => vi.fn());
const deleteEncryptionKeyVersion = vi.hoisted(() => vi.fn());
const rotateEncryptedJsonKey = vi.hoisted(() => vi.fn(async () => true));
const recordSystemEvent = vi.hoisted(() => vi.fn());
const rotateEnvelopeKekBatch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => (
    fixture.storage.has(key) ? structuredClone(fixture.storage.get(key)) : fallback
  )),
  setJson: vi.fn(async (key, value) => { fixture.storage.set(key, structuredClone(value)); }),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  ENCRYPTION_KEY_META_KEY: META_KEY,
  ensureEncryptionKeyVersion,
  deleteEncryptionKeyVersion,
  rotateEncryptedJsonKey,
  getActiveEncryptionKeyVersion: vi.fn(async () => fixture.activeVersion),
  getEncryptedJson: vi.fn(async (key, fallback) => (
    fixture.encrypted.has(key) ? fixture.encrypted.get(key) : fallback
  )),
  setEncryptedJson: vi.fn(async (key, value) => { fixture.encrypted.set(key, value); }),
}));

vi.mock('@/lib/localTripRepository', () => ({
  rotateTripEncryptionKey: vi.fn(async () => ({ indexedDbRecordsRotated: 0, fallbackStoreRotated: false })),
  inspectStoredTripKeyVersions: vi.fn(async () => []),
  // P4-C-F05: no fallback archive in these fixtures, so nothing holds the key.
  fallbackTripDocumentReleasesKey: vi.fn(async () => true),
}));

vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent }));
vi.mock('@/lib/nativePlatform', () => ({ isAndroid: () => true }));
vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    rotateEnvelopeKekBatch,
    envelopeKekRotationStatus: vi.fn(async () => ({
      phase: fixture.remaining > 0 ? 'REWRAPPING' : 'COMPLETE',
    })),
  },
}));

const DUE_NOW = 1000 + (31 * 24 * 60 * 60 * 1000);

const seedDueRotation = () => {
  fixture.storage.set(META_KEY, { version: 1, lastRotated: 1000 });
};

beforeEach(() => {
  vi.resetModules();
  fixture.storage.clear();
  fixture.encrypted.clear();
  fixture.batchCalls = [];
  fixture.remaining = 3;
  fixture.activeVersion = 1;
  vi.clearAllMocks();
  rotateEnvelopeKekBatch.mockImplementation(async (version, size) => {
    fixture.batchCalls.push({ version, size });
    fixture.remaining = Math.max(0, fixture.remaining - 1);
    return { rewrapped: 10, complete: fixture.remaining === 0 };
  });
  rotateEncryptedJsonKey.mockResolvedValue(true);
});

describe('DN2 multi-session KEK rotation', () => {
  it('V16: a non-final batch finalizes nothing and keeps pendingVersion', async () => {
    seedDueRotation();
    const { stepEncryptionKeyRotation } = await import('@/lib/keyRotationManager');

    const turn = await stepEncryptionKeyRotation({ now: DUE_NOW });

    expect(turn).toMatchObject({ rotated: false, hasMore: true, version: 1, pendingVersion: 2 });
    // Exactly one existing native batch per coordinator turn.
    expect(fixture.batchCalls).toEqual([{ version: 2, size: 50 }]);
    // Committed version does not advance; pendingVersion remains.
    expect(fixture.storage.get(META_KEY)).toMatchObject({
      version: 1,
      pendingVersion: 2,
      rotationStartedAt: DUE_NOW,
    });
    expect(fixture.storage.get(META_KEY).lastRotated).toBe(1000);
    // No final metadata, no success log, no rotation-log entry, no alias cleanup.
    expect(recordSystemEvent).not.toHaveBeenCalled();
    expect(fixture.encrypted.get('drivesense_key_rotation_log_v1')).toBeUndefined();
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();
    expect(rotateEncryptedJsonKey).not.toHaveBeenCalled();
  });

  it('V16: a restart between turns resumes the same pendingVersion, not a new target', async () => {
    seedDueRotation();
    let module = await import('@/lib/keyRotationManager');
    await module.stepEncryptionKeyRotation({ now: DUE_NOW });

    // Simulate process death: fresh module registry, same durable meta.
    vi.resetModules();
    module = await import('@/lib/keyRotationManager');
    const later = DUE_NOW + (90 * 24 * 60 * 60 * 1000);
    const resumed = await module.stepEncryptionKeyRotation({ now: later });

    expect(resumed).toMatchObject({ hasMore: true, pendingVersion: 2, version: 1 });
    expect(fixture.batchCalls.map((call) => call.version)).toEqual([2, 2]);
    expect(ensureEncryptionKeyVersion).not.toHaveBeenCalledWith(3);
    expect(fixture.storage.get(META_KEY)).toMatchObject({ version: 1, pendingVersion: 2 });
    // The restart must not restamp the rotation start.
    expect(fixture.storage.get(META_KEY).rotationStartedAt).toBe(DUE_NOW);
  });

  it('V16: the JS tail runs only after the native engine reports complete', async () => {
    seedDueRotation();
    const { stepEncryptionKeyRotation, ROTATING_ENCRYPTED_JSON_KEYS, loadRotationLog } =
      await import('@/lib/keyRotationManager');

    const first = await stepEncryptionKeyRotation({ now: DUE_NOW });
    const second = await stepEncryptionKeyRotation({ now: DUE_NOW });
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(true);
    // Active key version is still the committed one while rotation is in flight.
    expect(fixture.activeVersion).toBe(1);

    const final = await stepEncryptionKeyRotation({ now: DUE_NOW });

    expect(final).toMatchObject({ rotated: true, hasMore: false, previousVersion: 1, version: 2 });
    expect(fixture.batchCalls).toHaveLength(3);
    // Established source order for the tail is preserved: encrypted-JSON
    // registry rotation, then old-alias policy (Android retains it), then final
    // version metadata + pendingVersion clear + lastRotated, then rotation log,
    // then the success event.
    expect(rotateEncryptedJsonKey).toHaveBeenCalledTimes(ROTATING_ENCRYPTED_JSON_KEYS.length);
    // Android keeps the old alias: the legacy payload-key family is still
    // referenced by native intake journal/checkpoint files.
    expect(deleteEncryptionKeyVersion).not.toHaveBeenCalled();
    expect(fixture.storage.get(META_KEY)).toEqual({ version: 2, lastRotated: DUE_NOW });
    expect(await loadRotationLog()).toEqual([
      expect.objectContaining({ fromVersion: 1, toVersion: 2, startedAt: DUE_NOW, status: 'ok' }),
    ]);
    expect(recordSystemEvent).toHaveBeenCalledWith(
      'encryption_key_rotated',
      expect.objectContaining({ previous_version: 1, current_version: 2 }),
      expect.objectContaining({ category: 'privacy' })
    );
  });

  it('V16: rotation status stays non-complete mid-rotation and reports the native phase', async () => {
    seedDueRotation();
    const { stepEncryptionKeyRotation, getKeyRotationStatus } = await import('@/lib/keyRotationManager');
    await stepEncryptionKeyRotation({ now: DUE_NOW });

    const status = await getKeyRotationStatus();
    expect(status).toMatchObject({ status: 'warn', activeKeyVersion: 1 });
    expect(status.nativeEnvelopeRotation.phase).toBe('REWRAPPING');
  });

  it('one turn admits one batch regardless of how much archive remains', async () => {
    fixture.remaining = 500;
    seedDueRotation();
    const { stepEncryptionKeyRotation } = await import('@/lib/keyRotationManager');

    await stepEncryptionKeyRotation({ now: DUE_NOW });

    expect(fixture.batchCalls).toHaveLength(1);
    expect(fixture.batchCalls[0]).toEqual({ version: 2, size: 50 });
  });

  it('the default non-turn caller still runs the rotation to completion', async () => {
    seedDueRotation();
    const { checkAndRotateEncryptionKey } = await import('@/lib/keyRotationManager');

    const result = await checkAndRotateEncryptionKey({ now: DUE_NOW });

    expect(result).toMatchObject({ rotated: true, hasMore: false, version: 2 });
    expect(fixture.batchCalls).toHaveLength(3);
  });
});
