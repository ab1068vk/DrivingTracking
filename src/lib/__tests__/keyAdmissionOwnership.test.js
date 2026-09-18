/**
 * AUD-007 round 5 — refusal is not success, and every producer owns admission.
 *
 * Round 4 made deletion a finalization that can legitimately refuse. Two things were then
 * wrong with what surrounded it:
 *
 *  1. **The second deletion door ignored the answer.** `releaseRetainedKeyVersions()`
 *     called the new structured deletion, received `{deleted: false}`, and still moved the
 *     version out of retained metadata. The key survived on disk while the ledger said it
 *     had been released — worse than either outcome alone, because nothing would retry.
 *
 *  2. **Real producers still bypassed admission.** A writer that captured the outgoing
 *     version, did asynchronous work, and committed later held nothing across that span,
 *     so a finalizer saw no admitted writer, proved zero, deleted the version, and the
 *     writer then published durable ciphertext under a destroyed key.
 *
 * And a third property these defend: a multi-turn proof watermark is only valid against
 * the generation that produced it. Persistent progress must not outlive its cause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));

vi.mock('@/lib/localTripRepository', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fallbackTripDocumentReleasesKey: vi.fn(async () => true),
    stepTripEncryptionKeyRotationBatch: vi.fn(async () => ({
      indexedDbRecordsRotated: 0,
      fallbackStoreRotated: false,
      processed: 0,
      examined: 0,
      hasMore: false,
    })),
  };
});

vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));

const localStorageDouble = () => {
  const values = new Map();
  return {
    values,
    get length() { return values.size; },
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
  };
};

const hasKey = (db, version) => db.getStoreState('drivesense_secure_keys', 'keys')
  .records.has(`gps_payload_key_v${version}`);

/** Hold one `crypto.subtle.encrypt` open so a producer can be parked mid-flight. */
const parkOneEncrypt = () => {
  const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
  let release = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce((...args) => (
    new Promise((resolve, reject) => {
      release = () => realEncrypt(...args).then(resolve, reject);
      signalEntered();
    })
  ));
  return { entered, release: () => release() };
};

describe('AUD-007 round 5 — deletion refusal and producer admission', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('localStorage', localStorageDouble());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const seedRetained = async (crypto, storage) => {
    await crypto.ensureEncryptionKeyVersion(1);
    await crypto.ensureEncryptionKeyVersion(2);
    await storage.setJson(crypto.ENCRYPTION_KEY_META_KEY, {
      version: 2,
      lastRotated: 1_000,
      retainedKeyVersions: [1],
    });
  };

  /** 1. Retained cleanup may not release metadata when deletion refuses. */
  it('keeps a version retained when the second deletion door is refused', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const manager = await import('@/lib/keyRotationManager');
    const storage = await import('@/lib/mobileStorage');
    await seedRetained(crypto, storage);

    let releaseFinalizer = () => {};
    let signalFinalizer = () => {};
    const entered = new Promise((resolve) => { signalFinalizer = resolve; });
    const finalizer = refs.finalizeBrowserKeyVersionDeletion(99, async () => {
      signalFinalizer();
      await new Promise((resolve) => { releaseFinalizer = resolve; });
    });
    await entered;

    const outcome = await manager.releaseRetainedKeyVersions();
    expect(outcome).toEqual({ released: [], retained: [1] });
    expect(await storage.getJson(crypto.ENCRYPTION_KEY_META_KEY, null))
      .toMatchObject({ retainedKeyVersions: [1] });
    expect(hasKey(indexedDb, 1)).toBe(true);

    releaseFinalizer();
    await finalizer;
  });

  /** 2. A writer that will not drain keeps the version retained, not released. */
  it('keeps a version retained when writers do not drain', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const manager = await import('@/lib/keyRotationManager');
    const storage = await import('@/lib/mobileStorage');
    await seedRetained(crypto, storage);

    const parked = parkOneEncrypt();
    const writer = crypto.setEncryptedJson('drivesense_parked_writer_v1', { value: 1 });
    await parked.entered;

    const outcome = await manager.releaseRetainedKeyVersions();
    expect(outcome.released).toEqual([]);
    expect(outcome.retained).toEqual([1]);
    expect(hasKey(indexedDb, 1)).toBe(true);

    parked.release();
    await writer;
  });

  /** 3. The speed producer owns admission across its whole publication. */
  it('refuses deletion while a real speed write is in flight', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const crypto = await import('@/lib/securePayloadCrypto');
    const speed = await import('@/lib/speedKnowledgeRepository');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    await crypto.ensureEncryptionKeyVersion(2);

    const parked = parkOneEncrypt();
    const writer = speed.speedKnowledgeStore.set(speed.SPEED_KNOWLEDGE_STORAGE_KEY, {
      schemaVersion: 1, knowledgeRevision: 1, cells: {},
      corrections: [{ id: 'user-1', limitKmh: 40 }],
    });
    await parked.entered;

    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });
    parked.release();
    await writer;
    expect(hasKey(indexedDb, 1)).toBe(true);
  });

  /** 4. The P6 producer owns admission across its whole publication. */
  it('refuses deletion while a real P6 derived turn is in flight', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const refs = await import('@/lib/browserKeyReferences');
    await crypto.ensureEncryptionKeyVersion(1);

    // The P6 turns publish under `withDurableKeyPublication`; hold one open and the
    // finalizer must not be able to prove the version unreferenced behind it.
    let releaseProducer = () => {};
    const producing = refs.withDurableKeyPublication(async () => {
      await new Promise((resolve) => { releaseProducer = resolve; });
    });
    await Promise.resolve();

    await expect(crypto.deleteEncryptionKeyVersion(1, { drainTimeoutMs: 20 }))
      .resolves.toMatchObject({ deleted: false });
    expect(hasKey(indexedDb, 1)).toBe(true);

    releaseProducer();
    await producing;
  });

  /** 5. The spool's initial wrapper owns admission before it captures a version. */
  it('refuses deletion while an initial spool wrapper is in flight', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const crypto = await import('@/lib/securePayloadCrypto');
    const { browserActiveTripSpool } = await import('@/lib/browserActiveTripSpool');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    const parked = parkOneEncrypt();
    const sessionId = browserActiveTripSpool.begin({ id: 'r5-spool' });
    await parked.entered;

    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });

    parked.release();
    browserActiveTripSpool.append(
      { lat: 43.1, lng: -79.1, timestamp: '2026-01-01T00:00:00.000Z' }, { id: 'r5-spool' },
    );
    await browserActiveTripSpool.complete({ id: 'r5-spool', status: 'completed' });
    await browserActiveTripSpool.flush();

    const durable = indexedDb.getStoreState('roadsage_active_spool_v1', 'manifests')
      .records.get(sessionId);
    expect(hasKey(indexedDb, Number(durable?.wrappedDek?.key_version))).toBe(true);
  });

  /** 6. Admission is released when the producer fails, not leaked. */
  it('releases admission when a producer throws', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    await expect(refs.withDurableKeyPublication(async () => {
      throw new Error('producer failed');
    })).rejects.toThrow(/producer failed/);

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(false);
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: true });
  });

  /** 7. A proof watermark cannot outlive the generation that produced it. */
  it('discards proof progress once a reference-creating writer has been admitted', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const before = refs.getBrowserKeyReferenceEpoch();

    const release = await refs.admitBrowserKeyWrite();
    const during = refs.getBrowserKeyReferenceEpoch();
    release();

    // A rewrap only moves existing references forward, so it must NOT invalidate a sweep:
    // counting it would restart every proof forever and a large store could never converge.
    const rewrapRelease = await refs.admitBrowserKeyWrite({ createsReferences: false });
    const afterRewrap = refs.getBrowserKeyReferenceEpoch();
    rewrapRelease();

    expect(during).toBeGreaterThan(before);
    expect(afterRewrap).toBe(during);
  });

  /** 8. A genuine success still cleans retained metadata. */
  it('releases and cleans metadata when deletion actually succeeds', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const manager = await import('@/lib/keyRotationManager');
    const storage = await import('@/lib/mobileStorage');
    await seedRetained(crypto, storage);

    const outcome = await manager.releaseRetainedKeyVersions();

    expect(outcome).toEqual({ released: [1], retained: [] });
    expect(hasKey(indexedDb, 1)).toBe(false);
    expect(await storage.getJson(crypto.ENCRYPTION_KEY_META_KEY, null))
      .not.toHaveProperty('retainedKeyVersions');
  });
});
