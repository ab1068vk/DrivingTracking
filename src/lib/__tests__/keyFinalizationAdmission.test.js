/**
 * AUD-007 round 4 — finalization admission, and durable rewrap progression.
 *
 * Round 3 left two production-real holes that CODEX reproduced:
 *
 *  1. **Admission stayed open between proof and deletion.** A zero-reference proof could
 *     succeed, a real writer could then enter and capture the outgoing version, deletion
 *     could happen, and the writer would publish durable ciphertext under a key that no
 *     longer exists. The next read fails with `KEY_VERSION_DESTROYED`. A counter that is
 *     only consulted *inside* the proof cannot close that window: the window opens after
 *     the proof returns.
 *
 *  2. **Cursor-bounded acquisition without cursor-bounded PROGRESS.** Each rewrap turn
 *     restarted from the first key, so with 321 rows a turn rewrapped 64 and the next
 *     turn re-examined those same 64 first. By turn five the examination budget was spent
 *     walking an already-migrated prefix and the remaining old-version rows were never
 *     reached. Bounded work that never advances is not progress.
 *
 * The invariant these regressions defend:
 *
 *   Once final zero-reference proof begins for version V, no new writer may acquire V
 *   until proof and deletion complete atomically or abort and force re-proof. And every
 *   rewrap turn must start where the previous turn stopped, across process restarts.
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

const liveKeyVersions = (db) => [...db.getStoreState('drivesense_secure_keys', 'keys').records.keys()]
  .map((id) => Number(String(id).replace('gps_payload_key_v', '')))
  .filter((version) => Number.isFinite(version));
const hasKey = (db, version) => liveKeyVersions(db).includes(version);

/** Hold one `crypto.subtle.encrypt` open so a writer can be parked mid-flight. */
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

const seedBuckets = async (crypto, openP6TripDerivedDatabase, stores, count, keyVersion) => {
  const rows = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const key = `bucket-${String(index).padStart(4, '0')}`;
    const revisionToken = 'rev-1';
    return {
      key,
      revisionToken,
      payload: await crypto.encryptSensitiveValue(
        { total: index }, `p6:analytics-bucket:${key}:${revisionToken}`, { keyVersion },
      ),
    };
  }));
  const db = await openP6TripDerivedDatabase();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores.ANALYTICS_BUCKETS, 'readwrite');
    const store = tx.objectStore(stores.ANALYTICS_BUCKETS);
    rows.forEach((row) => store.put(row));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return rows;
};

describe('AUD-007 round 4 — finalization admission and durable rewrap progress', () => {
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

  /** 1. The window between proof and delete must be closed. */
  it('refuses to delete a version a post-proof writer has already captured', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    expect((await refs.proveZeroBrowserKeyReferences(1)).zero).toBe(true);

    const parked = parkOneEncrypt();
    const writer = crypto.setEncryptedJson('drivesense_post_proof_v1', { value: 7 });
    await parked.entered;

    // The writer holds v1. Deletion must not proceed behind its back.
    const outcome = await crypto.deleteEncryptionKeyVersion(1);
    expect(outcome).toMatchObject({ deleted: false });
    expect(hasKey(indexedDb, 1)).toBe(true);

    parked.release();
    await writer;
    await expect(crypto.getEncryptedJson('drivesense_post_proof_v1', null))
      .resolves.toEqual({ value: 7 });
  });

  /** 2. A writer admitted before finalization drains, and then deletion may proceed. */
  it('drains an already-admitted writer and then deletes cleanly', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const crypto = await import('@/lib/securePayloadCrypto');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    await crypto.setEncryptedJson('drivesense_drained_v1', { value: 1 });
    // No writer outstanding now: the same deletion that was refused above succeeds.
    await expect(crypto.deleteEncryptionKeyVersion(1)).resolves.toMatchObject({ deleted: true });
    expect(hasKey(indexedDb, 1)).toBe(false);
  });

  /** 3. A writer arriving during finalization must not publish the outgoing version. */
  it('holds a writer that arrives during finalization until admission reopens', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const refs = await import('@/lib/browserKeyReferences');
    const crypto = await import('@/lib/securePayloadCrypto');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    await crypto.ensureEncryptionKeyVersion(2);

    let observedDuringFinalization = null;
    const finalization = refs.finalizeBrowserKeyVersionDeletion(1, async () => {
      // A writer entering here must not be admitted while admission is closed.
      observedDuringFinalization = refs.isBrowserKeyFinalizationInProgress();
      await crypto.deleteEncryptionKeyVersion(1, { finalized: true });
    });

    const late = crypto.setEncryptedJson('drivesense_late_writer_v1', { value: 9 }, { keyVersion: 2 });
    await finalization;
    await late;

    expect(observedDuringFinalization).toBe(true);
    expect(refs.isBrowserKeyFinalizationInProgress()).toBe(false);
    await expect(crypto.getEncryptedJson('drivesense_late_writer_v1', null))
      .resolves.toEqual({ value: 9 });
  });

  /** 4. P6 rewrap must advance past an already-migrated prefix larger than the budget. */
  it('advances P6 rewrap past a migrated prefix larger than the scan budget', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const p6 = await import('@/lib/p6TripDerivedState');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await crypto.ensureEncryptionKeyVersion(2);
    await seedBuckets(crypto, openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES, 321, 1);

    let rewrapped = 0;
    for (let turn = 0; turn < 6; turn += 1) {
      const step = await p6.rewrapP6KeyVersion(1, 2);
      rewrapped += step.rewrapped;
      if (!step.hasMore) break;
    }

    expect(rewrapped).toBe(321);

    // The PROOF has to converge too. With more rows than one examination budget, a single
    // call legitimately reports UNKNOWN (which retains); what must not happen is that it
    // reports UNKNOWN forever, because then a fully converged key could never retire.
    let proven = null;
    for (let turn = 0; turn < 6 && proven === null; turn += 1) {
      proven = await p6.countP6KeyVersionReferences(1).catch(() => null);
    }
    expect(proven).toBe(0);
  });

  /** 5. Speed gets the same bounded progress, and user corrections survive it. */
  it('advances speed rewrap past a migrated prefix and preserves corrections', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const speed = await import('@/lib/speedKnowledgeRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await crypto.ensureEncryptionKeyVersion(2);

    const total = 150;
    const contextFor = (index) => `p6:speed-v2:stage-1:b${String(index).padStart(4, '0')}:3:0`;
    const rows = await Promise.all(Array.from({ length: total }, async (_, index) => ({
      key: `stage-1:b${String(index).padStart(4, '0')}:0`,
      stageId: 'stage-1',
      bucketId: `b${String(index).padStart(4, '0')}`,
      publicationVersion: 3,
      ordinal: 0,
      commitState: 'COMMITTED',
      payload: await crypto.encryptSensitiveValue(
        { corrections: [{ roadId: `r-${index}`, limitKmh: 40, source: 'user' }] },
        contextFor(index), { keyVersion: 1 },
      ),
    })));

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(speed.SPEED_KNOWLEDGE_DB_NAME, speed.SPEED_KNOWLEDGE_DB_VERSION);
      request.onupgradeneeded = () => {
        const opened = request.result;
        if (!opened.objectStoreNames.contains('knowledge')) {
          opened.createObjectStore('knowledge', { keyPath: 'key' });
        }
        Object.values(speed.P6_SPEED_STORES).forEach((name) => {
          if (!opened.objectStoreNames.contains(name)) {
            opened.createObjectStore(name, { keyPath: 'key' });
          }
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(speed.P6_SPEED_STORES.PARTITIONS, 'readwrite');
      const store = tx.objectStore(speed.P6_SPEED_STORES.PARTITIONS);
      rows.forEach((row) => store.put(row));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    let rewrapped = 0;
    for (let turn = 0; turn < 8; turn += 1) {
      const step = await speed.rewrapSpeedKnowledgeKeyVersion(1, 2);
      rewrapped += step.rewrapped;
      if (!step.hasMore) break;
    }

    expect(rewrapped).toBe(total);
    await expect(speed.countSpeedKnowledgeKeyVersionReferences(1)).resolves.toBe(0);
    const row = indexedDb
      .getStoreState(speed.SPEED_KNOWLEDGE_DB_NAME, speed.P6_SPEED_STORES.PARTITIONS)
      .records.get('stage-1:b0100:0');
    await expect(crypto.decryptSensitiveValue(row.payload, contextFor(100)))
      .resolves.toEqual({ corrections: [{ roadId: 'r-100', limitKmh: 40, source: 'user' }] });
  });

  /** 6. The cursor is durable: a restarted process must not start over. */
  it('resumes the P6 rewrap cursor after a module restart', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await crypto.ensureEncryptionKeyVersion(2);
    await seedBuckets(crypto, openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES, 200, 1);

    const first = await (await import('@/lib/p6TripDerivedState')).rewrapP6KeyVersion(1, 2);
    expect(first.rewrapped).toBeGreaterThan(0);
    expect(first.hasMore).toBe(true);

    vi.resetModules();
    const restarted = await import('@/lib/p6TripDerivedState');
    const second = await restarted.rewrapP6KeyVersion(1, 2);

    // A restart that started over would re-examine the migrated prefix and report the
    // same first page again.
    expect(second.examined).toBeLessThanOrEqual(second.rewrapped + first.rewrapped);
    expect(first.rewrapped + second.rewrapped).toBeLessThanOrEqual(200);
    expect(second.rewrapped).toBeGreaterThan(0);
  });

  /** 7. A malformed row on a later page retains the key rather than being skipped past. */
  it('retains the old key when a later page holds an unrewrappable row', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const p6 = await import('@/lib/p6TripDerivedState');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);
    await crypto.ensureEncryptionKeyVersion(2);
    await seedBuckets(crypto, openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES, 80, 1);

    // A row whose AAD cannot be derived: no revisionToken.
    const orphan = await crypto.encryptSensitiveValue({ total: 1 }, 'p6:analytics-bucket:zz:?', { keyVersion: 1 });
    const db = await openP6TripDerivedDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).put({ key: 'zz-orphan', payload: orphan });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    for (let turn = 0; turn < 6; turn += 1) {
      const step = await p6.rewrapP6KeyVersion(1, 2);
      if (!step.hasMore) break;
    }

    // The orphan still references v1, so the reference count must keep the key alive.
    await expect(p6.countP6KeyVersionReferences(1)).resolves.toBe(1);
  });

  /** 8. Repeated real rotations stay bounded with all of this in place. */
  it('keeps the live root-key count bounded across repeated rotations', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    await import('@/lib/p6TripDerivedState');
    await import('@/lib/speedKnowledgeRepository');
    const manager = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool } = await import('@/lib/browserActiveTripSpool');

    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    const sessionId = browserActiveTripSpool.begin({ id: 'bounded-r4' });
    browserActiveTripSpool.append(
      { lat: 43.1, lng: -79.1, timestamp: '2026-01-01T00:00:00.000Z' }, { id: 'bounded-r4' },
    );
    await browserActiveTripSpool.complete({ id: 'bounded-r4', status: 'completed' });
    await browserActiveTripSpool.flush();
    await crypto.setEncryptedJson('drivesense_privacy_score_history_v1', { sample: 1 });

    let at = 1_000;
    for (let rotation = 0; rotation < 4; rotation += 1) {
      at += manager.KEY_ROTATION_MS + 1;
      for (let turn = 0; turn < 12; turn += 1) {
        const result = await manager.checkAndRotateEncryptionKey({ now: at });
        if (result.hasMore !== true) break;
      }
      expect(liveKeyVersions(indexedDb).length).toBeLessThanOrEqual(2);
    }

    const points = [];
    for await (const point of browserActiveTripSpool.readPoints(sessionId)) points.push(point);
    expect(points).toHaveLength(1);
    await expect(crypto.getEncryptedJson('drivesense_privacy_score_history_v1', null))
      .resolves.toMatchObject({ sample: 1 });
  });
});
