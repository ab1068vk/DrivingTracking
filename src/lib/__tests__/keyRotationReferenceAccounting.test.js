/**
 * AUD-007 — browser key-version reference accounting.
 *
 * The defect: rotation deleted a superseded key version after consulting ONE consumer
 * (the monolithic fallback trip document), while the RSAS route spool, the P6 derived
 * stores, speed knowledge and several encrypted-JSON documents still held ciphertext
 * wrapped under that version. Deletion is irreversible and the missing version was then
 * silently re-minted as a different random key, so the failure surfaced as an anonymous
 * GCM authentication error far from its cause.
 *
 * The invariant these regressions defend:
 *
 *   A browser key version may be deleted only after EVERY registered persistent domain
 *   has proven zero live references to it. Unknown or failed inspection means RETAIN,
 *   never "probably absent".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));

vi.mock('@/lib/localTripRepository', () => ({
  fallbackTripDocumentReleasesKey: vi.fn(async () => true),
  stepTripEncryptionKeyRotationBatch: vi.fn(async () => ({
    indexedDbRecordsRotated: 0,
    fallbackStoreRotated: false,
    processed: 0,
    examined: 0,
    hasMore: false,
  })),
}));

vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {} }));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

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

const collect = async (source) => {
  const out = [];
  for await (const value of source) out.push(value);
  return out;
};

const keyStore = (db) => db.getStoreState('drivesense_secure_keys', 'keys').records;
const hasKey = (db, version) => keyStore(db).has(`gps_payload_key_v${version}`);

describe('AUD-007 browser key-version reference accounting', () => {
  let indexedDb;

  beforeEach(() => {
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('localStorage', localStorageDouble());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** ROUTE DEK SURVIVAL — the exact loss CODEX reproduced. */
  it('keeps a canonical browser route readable across a successful rotation', async () => {
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS } = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool } = await import('@/lib/browserActiveTripSpool');

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });

    const tripId = 'aud007-route';
    const sessionId = browserActiveTripSpool.begin({ id: tripId });
    browserActiveTripSpool.append({ lat: 43.1, lng: -79.1, timestamp: '2026-01-01T00:00:00.000Z' }, { id: tripId });
    browserActiveTripSpool.append({ lat: 43.2, lng: -79.2, timestamp: '2026-01-01T00:00:01.000Z' }, { id: tripId });
    await browserActiveTripSpool.complete({ id: tripId, status: 'completed' });
    await browserActiveTripSpool.flush();

    await expect(collect(browserActiveTripSpool.readPoints(sessionId))).resolves.toHaveLength(2);

    await checkAndRotateEncryptionKey({ now: at + KEY_ROTATION_MS + 1 });

    // THE point of AUD-007: the route must still be readable, with no remint required.
    await expect(collect(browserActiveTripSpool.readPoints(sessionId))).resolves.toHaveLength(2);

    const manifest = indexedDb
      .getStoreState('roadsage_active_spool_v1', 'manifests')
      .records.get(sessionId);
    // Either the DEK was rewrapped to the new version, or the old key was retained.
    const rewrapped = manifest.wrappedDek.key_version === 2;
    expect(rewrapped || hasKey(indexedDb, 1)).toBe(true);
  });

  /** MULTI-DOMAIN RETENTION — a registered domain holding a reference blocks deletion. */
  it('retains the old key while any registered domain still references it', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS } = await import('@/lib/keyRotationManager');

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });

    refs.registerBrowserKeyReferenceDomain({
      id: 'test-holds-a-reference',
      countReferences: async (version) => (version === 1 ? 3 : 0),
    });

    const rotated = await checkAndRotateEncryptionKey({ now: at + KEY_ROTATION_MS + 1 });
    expect(rotated.version).toBe(2);
    expect(hasKey(indexedDb, 1)).toBe(true);              // NOT deleted
    expect(rotated.retainedKeyVersions).toContain(1);
  });

  /** INSPECTION FAILURE — unknown means retain, never "probably absent". */
  it('retains the old key when a domain cannot be inspected', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS } = await import('@/lib/keyRotationManager');

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });

    refs.registerBrowserKeyReferenceDomain({
      id: 'test-throws',
      countReferences: async () => { throw new Error('store unreadable'); },
    });

    await checkAndRotateEncryptionKey({ now: at + KEY_ROTATION_MS + 1 });
    expect(hasKey(indexedDb, 1)).toBe(true);
  });

  /** WRITER FENCE — a writer that began before the fence cannot strand a reference. */
  it('retains the old key when a pre-fence writer is still in flight', async () => {
    const refs = await import('@/lib/browserKeyReferences');
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS } = await import('@/lib/keyRotationManager');

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });

    // A writer that started before finalization and has not published yet.
    const release = refs.beginBrowserKeyWrite();
    try {
      await checkAndRotateEncryptionKey({ now: at + KEY_ROTATION_MS + 1 });
      expect(hasKey(indexedDb, 1)).toBe(true);   // cannot prove zero references yet
    } finally {
      release();
    }
  });

  /** DESTROYED-VERSION SEMANTICS — a deliberately destroyed version must not remint. */
  it('reports a destroyed key version instead of silently minting a new one', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const refs = await import('@/lib/browserKeyReferences');

    await crypto.ensureEncryptionKeyVersion(1);
    // Real ciphertext under v1, not a hand-made payload shape.
    const sealed = await crypto.encryptSensitiveValue({ secret: 'route-dek' }, 'storage:anything');
    expect(sealed.key_version).toBe(1);
    await expect(crypto.decryptSensitiveValue(sealed, 'storage:anything'))
      .resolves.toMatchObject({ secret: 'route-dek' });

    await crypto.deleteEncryptionKeyVersion(1);
    expect(hasKey(indexedDb, 1)).toBe(false);
    await expect(refs.isBrowserKeyVersionDestroyed(1)).resolves.toBe(true);

    // Reading that ciphertext must NOT resurrect a different random v1 key.
    await expect(crypto.decryptSensitiveValue(sealed, 'storage:anything'))
      .rejects.toThrow(/KEY_VERSION_DESTROYED/);
    expect(hasKey(indexedDb, 1)).toBe(false);   // still not reminted
  });

  /** INTERRUPTED ROTATION — the existing positive property must survive the fix. */
  it('does not destroy the source key while a rotation is still pending', async () => {
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS } = await import('@/lib/keyRotationManager');
    const repo = await import('@/lib/localTripRepository');

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });

    repo.stepTripEncryptionKeyRotationBatch.mockResolvedValueOnce({
      indexedDbRecordsRotated: 1, fallbackStoreRotated: false, processed: 1, examined: 1, hasMore: true,
    });
    const pending = await checkAndRotateEncryptionKey({
      now: at + KEY_ROTATION_MS + 1, maxNativeBatches: 1,
    });

    expect(pending.rotated).toBe(false);
    expect(pending.hasMore).toBe(true);
    expect(hasKey(indexedDb, 1)).toBe(true);     // source key intact mid-rotation
  });

  /** STRUCTURAL COMPLETENESS — the encrypted-JSON sweep must not be a hand-written list. */
  it('rotates every encrypted document that was actually written, not a hand-maintained list', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const { listKnownEncryptedDocumentKeys } = await import('@/lib/browserKeyReferences');

    await crypto.ensureEncryptionKeyVersion(1);
    // A document nobody added to ROTATING_ENCRYPTED_JSON_KEYS.
    await crypto.setEncryptedJson('drivesense_parking_diagnostics_v1', { sample: true });

    await expect(listKnownEncryptedDocumentKeys())
      .resolves.toContain('drivesense_parking_diagnostics_v1');
  });

  /**
   * The four documents CODEX found missing from the hand-written list must actually be
   * re-encrypted by a rotation — indexing them is not the same as rotating them.
   */
  it('rotates documents that the hand-written list omits', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const { getJson } = await import('@/lib/mobileStorage');
    const { checkAndRotateEncryptionKey, KEY_ROTATION_MS, ROTATING_ENCRYPTED_JSON_KEYS } =
      await import('@/lib/keyRotationManager');

    const omitted = [
      'drivesense_parking_diagnostics_v1',
      'drivesense_privacy_score_history_v1',
      'drivesense_privacy_posture_snapshots_v1',
      'drivesense_privacy_zone_suggestion_dismissals_v1',
    ];
    // Precondition: these really are absent from the static list.
    omitted.forEach((key) => expect(ROTATING_ENCRYPTED_JSON_KEYS).not.toContain(key));

    const at = 1_000;
    await checkAndRotateEncryptionKey({ now: at });
    for (const key of omitted) await crypto.setEncryptedJson(key, { sample: key });
    for (const key of omitted) {
      expect(Number((await getJson(key, null))?.key_version)).toBe(1);
    }

    await checkAndRotateEncryptionKey({ now: at + KEY_ROTATION_MS + 1 });

    for (const key of omitted) {
      expect(Number((await getJson(key, null))?.key_version)).toBe(2);
      await expect(crypto.getEncryptedJson(key, null)).resolves.toMatchObject({ sample: key });
    }
  });
});
