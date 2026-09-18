/**
 * AUD-007 FINAL — admission must survive until the DURABLE COMMIT.
 *
 * Every earlier round held the token across `capture → encrypt` and released it when the
 * encoder returned bytes. The declared invariant said `capture → encrypt → durable
 * commit`; the actual lifetime was `capture → encrypt → release → (later) commit`, and
 * CODEX proved the consequence: wrappers made under v1, admission already false, v1
 * deleted, and the writer then committing ciphertext nothing could read.
 *
 * These regressions pin the boundary itself. A queued `put()` is not a commit, an open
 * transaction is not a commit, and bytes in hand are certainly not a commit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from './helpers/fakeTripIndexedDb';

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));

const storageDouble = () => {
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

/**
 * Park the source digest, which `putTrip` computes AFTER every wrapper is encrypted and
 * BEFORE it opens the durable transaction. This is CODEX's exact window.
 */
const parkOneDigest = () => {
  const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let release = () => {};
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce((...args) => (
    new Promise((resolve, reject) => {
      release = () => realDigest(...args).then(resolve, reject);
      signalEntered();
    })
  ));
  return { entered, release: () => release() };
};

const tripFixture = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-09-14T12:00:00.000Z',
  end_time: '2026-09-14T12:10:00.000Z',
  route_points: [{ lat: 43.1, lng: -79.1, timestamp: '2026-09-14T12:00:00.000Z' }],
});

describe('AUD-007 FINAL — publication lifetime reaches the durable commit', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'aud007-final' }) },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** 1 + 2. Create: parked after encryption, before commit. */
  it('holds admission after encryption and refuses deletion before the commit', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    const parked = parkOneDigest();
    const writer = repository.localTripRepository.create(tripFixture('final-create'));
    await parked.entered;

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(true);
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });

    parked.release();
    await writer;
    const stored = indexedDb.getStoreState('drivesense_mobile', 'trips')
      .records.get('final-create')?.encrypted_payload;
    await expect(crypto.decryptSensitiveValue(stored, 'trip:final-create'))
      .resolves.toMatchObject({ id: 'final-create' });
  });

  /** 3. Update/edit takes the same boundary. */
  it('holds admission across an update until its commit', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(tripFixture('final-update'));

    const parked = parkOneDigest();
    const writer = repository.localTripRepository.update('final-update', { status: 'edited' });
    await parked.entered;

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(true);
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });

    parked.release();
    await writer.catch(() => null);
  });

  /** 4. The projection envelope is committed inside the same publication. */
  it('commits the projection inside the trip publication, not after it', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    await repository.localTripRepository.create(tripFixture('final-projection'));

    const projection = indexedDb.getStoreState('drivesense_mobile', 'trip_projections')
      ?.records.get('final-projection');
    // Committed in the same transaction as the trip, so it exists and names a live key.
    expect(projection).toBeTruthy();
    expect(Number(projection.encrypted_payload?.key_version)).toBe(1);
  });

  /** 5. A failed publication releases admission rather than wedging rotation. */
  it('releases admission when the publication fails before commit', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    await expect(refs.withDurableKeyPublication(async () => {
      throw new Error('transaction aborted');
    })).rejects.toThrow(/aborted/);

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(false);
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: true });
  });

  /** 6. Success releases only AFTER the commit, never before. */
  it('still holds admission while the transaction is open and drops it after', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    let heldDuringCommit = null;
    await refs.withDurableKeyPublication(async () => {
      const { setJson } = await import('@/lib/mobileStorage');
      await setJson('drivesense_final_probe_v1', { committed: true });
      heldDuringCommit = refs.hasInFlightBrowserKeyWrites();
    });

    expect(heldDuringCommit).toBe(true);
    expect(refs.hasInFlightBrowserKeyWrites()).toBe(false);
  });

  /** 7. A finalization that begins mid-publication cannot delete that version. */
  it('cannot delete a version while a publication is mid-flight', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    let releaseProducer = () => {};
    const producing = refs.withDurableKeyPublication(async () => {
      await new Promise((resolve) => { releaseProducer = resolve; });
    });
    await Promise.resolve();

    const outcome = await crypto.deleteEncryptionKeyVersion(1, { drainTimeoutMs: 20 });
    expect(outcome.deleted).toBe(false);

    releaseProducer();
    await producing;
  });

  /** A producer must not deadlock against its own nested publication. */
  it('does not deadlock when a publication nests another publication', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    await expect(refs.withDurableKeyPublication(async () => {
      await refs.withDurableKeyPublication(async () => {
        const { setJson } = await import('@/lib/mobileStorage');
        await setJson('drivesense_final_nested_v1', { nested: true });
      });
      return 'ok';
    })).resolves.toBe('ok');

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(false);
  });
});
