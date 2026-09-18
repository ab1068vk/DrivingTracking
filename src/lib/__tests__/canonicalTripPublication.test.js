/**
 * AUD-007 round 6 — canonical publication paths, and a restart-safe proof generation.
 *
 * Round 5 shipped with three modules named in its own handoff as unwrapped, and CODEX
 * found a real canonical trip-write failure in one of them. The sequence it proved:
 *
 *   an ordinary `create()` begins under v1 → `encodeTripRecord()` captures and encrypts
 *   under v1 → the writer stalls → rotation advances to v2 → deletion sees no admission
 *   owner and destroys v1 → the writer resumes and commits a durable row whose wrapper
 *   names v1 → the next read fails `KEY_VERSION_DESTROYED`.
 *
 * And the second blocker: durable proof progress was qualified by a PROCESS-LOCAL counter.
 * A watermark written at epoch 1, invalidated by a writer at epoch 2, then met again after
 * a restart where the counter began at 1, aliased as valid.
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

const tripFixture = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-09-14T12:00:00.000Z',
  end_time: '2026-09-14T12:10:00.000Z',
  route_points: [{ lat: 43.1, lng: -79.1, timestamp: '2026-09-14T12:00:00.000Z' }],
});

describe('AUD-007 round 6 — canonical publication and restart-safe proofs', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'aud007-r6-lock' }) },
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

  /** 1. An ordinary trip create across finalization. */
  it('refuses deletion while an ordinary trip create is in flight', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    const parked = parkOneEncrypt();
    const writer = repository.localTripRepository.create(tripFixture('r6-create'));
    await parked.entered;

    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });

    parked.release();
    await writer;
    const stored = indexedDb.getStoreState('drivesense_mobile', 'trips')
      .records.get('r6-create')?.encrypted_payload;
    await expect(crypto.decryptSensitiveValue(stored, 'trip:r6-create'))
      .resolves.toMatchObject({ id: 'r6-create' });
  });

  /** 2. An update/edit of an existing trip. */
  it('refuses deletion while a trip update is in flight', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await repository.localTripRepository.create(tripFixture('r6-update'));

    const parked = parkOneEncrypt();
    const writer = repository.localTripRepository.update('r6-update', { status: 'edited' });
    await parked.entered;

    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: false });

    parked.release();
    await writer.catch(() => null);
  });

  /** 4. The privacy-zone native wrapper. */
  it('publishes the native privacy-zone wrapper under admission', async () => {
    // The structural guarantee: the encrypt and the durable Preferences write are inside
    // ONE publication token, so a finalization cannot land between them. This is asserted
    // structurally because the native write goes through Capacitor Preferences, which has
    // no in-process durable substrate to observe off-device.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const text = readFileSync(resolve(process.cwd(), 'src/lib/privacyZones.js'), 'utf8');
    // Skip the import line; find the CALL.
    const start = text.indexOf('await withDurableKeyPublication(');
    expect(start).toBeGreaterThan(0);
    const body = text.slice(start, start + 600);
    expect(body).toMatch(/encryptSensitiveValue\(/);
    expect(body).toMatch(/Preferences\.set\(/);
  });

  /** 6. A failing producer releases admission rather than wedging rotation. */
  it('releases admission when a trip write fails', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    const repository = await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    await repository.localTripRepository.create({ id: '', status: 'completed' }).catch(() => null);

    expect(refs.hasInFlightBrowserKeyWrites()).toBe(false);
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: true });
  });

  /** 7 + 8. A restart must invalidate durable proof progress, not alias it. */
  it('does not let a durable proof stamp alias after a restart', async () => {
    const first = await import('@/lib/browserKeyReferences');
    const beforeRestart = first.getBrowserKeyProofGeneration();
    expect(first.isBrowserKeyProofGenerationCurrent(beforeRestart)).toBe(true);

    // A reference-creating writer invalidates it within the same process.
    const release = await first.admitBrowserKeyWrite();
    release();
    expect(first.isBrowserKeyProofGenerationCurrent(beforeRestart)).toBe(false);

    // And a restart resets the counter — the identity must not repeat with it.
    vi.resetModules();
    const restarted = await import('@/lib/browserKeyReferences');
    const afterRestart = restarted.getBrowserKeyProofGeneration();

    expect(afterRestart.epoch).toBe(beforeRestart.epoch);          // counter did reset
    expect(afterRestart.generation).not.toBe(beforeRestart.generation);
    expect(restarted.isBrowserKeyProofGenerationCurrent(beforeRestart)).toBe(false);
  });

  /** 9. A writer publishing behind a watermark invalidates the proof. */
  it('invalidates proof progress when a reference-creating writer is admitted', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const stamp = refs.getBrowserKeyProofGeneration();

    const rewrap = await refs.admitBrowserKeyWrite({ createsReferences: false });
    rewrap();
    expect(refs.isBrowserKeyProofGenerationCurrent(stamp)).toBe(true);   // rewrap: no change

    const writer = await refs.admitBrowserKeyWrite();
    writer();
    expect(refs.isBrowserKeyProofGenerationCurrent(stamp)).toBe(false);  // real writer: stale
  });

  /** 10 + 11. Convergence still happens, and refusal still retains. */
  it('still retires a key once producers drain, and retains while they do not', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    let release = () => {};
    const producing = refs.withDurableKeyPublication(async () => {
      await new Promise((resolve) => { release = resolve; });
    });
    await Promise.resolve();
    await expect(crypto.deleteEncryptionKeyVersion(1, { drainTimeoutMs: 10 }))
      .resolves.toMatchObject({ deleted: false });

    release();
    await producing;
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: true });
  });

  /** 12. The canonical primitive hands the version in rather than being asked for it. */
  it('resolves the key version inside admission and hands it to the producer', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await crypto.ensureEncryptionKeyVersion(1);

    let seen = null;
    await refs.withDurableKeyPublication(async ({ keyVersion }) => { seen = keyVersion; });

    expect(seen).toBe(1);
  });
});
