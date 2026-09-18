/**
 * AUD-007 round 3 — bounded, converging browser key rotation.
 *
 * Round 2 stopped the data loss but left four properties unproven, and two of them were
 * production failures in their own right:
 *
 *  A. Discovery enumerated the durable store by key PREFIX, so rotation rewrote
 *     `drivesense_settings` — a plaintext document — as ciphertext. Enumeration may
 *     discover candidates; only a recognisable encrypted record of this key domain may
 *     enter the rewrap.
 *  B. The spool's INITIAL wrapper was created outside the writer fence, so a session that
 *     began before finalization could publish a manifest sealed under a version rotation
 *     had already destroyed.
 *  C. Reference acquisition used `getAll()` and then sliced, so the "bounded" turn read
 *     the whole store first.
 *  D. `hasMore` was discarded, so a rotation that could not finish its rewrap finalized
 *     anyway — and with count-only domains the live root-key set then grew without bound.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => false,
  isNativePlatform: () => false,
  getNativePlatform: () => 'web',
}));

// The real module is kept: P6 owns `openP6TripDerivedDatabase` and the store names, and
// a wholesale mock would silently unregister the very domains under test.
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

const collect = async (source) => {
  const out = [];
  for await (const value of source) out.push(value);
  return out;
};

const liveKeyVersions = (db) => [...db.getStoreState('drivesense_secure_keys', 'keys').records.keys()]
  .map((id) => Number(String(id).replace('gps_payload_key_v', '')))
  .filter((version) => Number.isFinite(version));
const hasKey = (db, version) => liveKeyVersions(db).includes(version);

/** Open any store once so the shared FakeObjectStore prototype can be reached. */
const withoutGetAll = async (indexedDb, run) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDb.open('probe_db', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('probe_store')) {
        request.result.createObjectStore('probe_store', {});
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const proto = Object.getPrototypeOf(
    db.transaction('probe_store', 'readonly').objectStore('probe_store'),
  );
  db.close();
  const original = proto.getAll;
  proto.getAll = function forbidden() { throw new Error('GETALL_FORBIDDEN'); };
  try {
    return await run();
  } finally {
    proto.getAll = original;
  }
};

describe('AUD-007 round 3 — bounded, converging browser key rotation', () => {
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

  const captureRoute = async (spool, tripId, points = 2) => {
    const sessionId = spool.begin({ id: tripId });
    for (let index = 0; index < points; index += 1) {
      spool.append({
        lat: 43 + index / 1e5,
        lng: -79 - index / 1e5,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }, { id: tripId });
    }
    await spool.complete({ id: tripId, status: 'completed' });
    await spool.flush();
    return sessionId;
  };

  /** Drive a rotation to completion across however many bounded turns it needs. */
  const rotateToCompletion = async (manager, now, limit = 12) => {
    let last;
    for (let turn = 0; turn < limit; turn += 1) {
      last = await manager.checkAndRotateEncryptionKey({ now });
      if (last.hasMore !== true) return { result: last, turns: turn + 1 };
    }
    throw new Error('rotation did not converge within the turn limit');
  };

  /** A. PLAINTEXT IS NOT AN ENCRYPTED DOCUMENT. */
  it('never rewrites a plaintext app document as ciphertext during rotation', async () => {
    const mobile = await import('@/lib/mobileStorage');
    const manager = await import('@/lib/keyRotationManager');

    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    const settings = { auto_tracking_enabled: true, units: 'metric' };
    await mobile.setJson('drivesense_settings', settings);

    await rotateToCompletion(manager, 1_000 + manager.KEY_ROTATION_MS + 1);

    await expect(mobile.getJson('drivesense_settings', null)).resolves.toEqual(settings);
    const raw = await mobile.getJson('drivesense_settings', null);
    expect(raw?.encrypted).toBeUndefined();
  });

  /** A (control). A genuinely encrypted discovered document still rotates. */
  it('still rotates a discovered encrypted document that no static list names', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const mobile = await import('@/lib/mobileStorage');
    const manager = await import('@/lib/keyRotationManager');

    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    await crypto.setEncryptedJson('drivesense_privacy_score_history_v1', { sample: true });
    expect(manager.ROTATING_ENCRYPTED_JSON_KEYS)
      .not.toContain('drivesense_privacy_score_history_v1');

    await rotateToCompletion(manager, 1_000 + manager.KEY_ROTATION_MS + 1);

    expect(Number((await mobile.getJson('drivesense_privacy_score_history_v1', null))?.key_version))
      .toBe(2);
    await expect(crypto.getEncryptedJson('drivesense_privacy_score_history_v1', null))
      .resolves.toMatchObject({ sample: true });
  });

  /** B. The INITIAL wrapper is a writer too. */
  it('fences the initial spool wrapper so it cannot publish a destroyed version', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool } = await import('@/lib/browserActiveTripSpool');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    // begin() starts the wrap asynchronously and returns immediately. Holding that one
    // encrypt open makes the race deterministic instead of dependent on how many
    // microtasks a rotation happens to take.
    const realEncrypt = globalThis.crypto.subtle.encrypt.bind(globalThis.crypto.subtle);
    let unblock = () => {};
    let entered = () => {};
    const wrapStarted = new Promise((resolve) => { entered = resolve; });
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementationOnce((...args) => (
      new Promise((resolve, reject) => {
        unblock = () => realEncrypt(...args).then(resolve, reject);
        entered();
      })
    ));

    const sessionId = browserActiveTripSpool.begin({ id: 'fenced-start' });
    await wrapStarted;
    await manager.checkAndRotateEncryptionKey({ now: 1_000 + manager.KEY_ROTATION_MS + 1 });
    unblock();
    browserActiveTripSpool.append(
      { lat: 43.1, lng: -79.1, timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'fenced-start' },
    );
    await browserActiveTripSpool.complete({ id: 'fenced-start', status: 'completed' });
    await browserActiveTripSpool.flush();

    const durable = indexedDb.getStoreState('roadsage_active_spool_v1', 'manifests')
      .records.get(sessionId);
    const publishedVersion = Number(durable?.wrappedDek?.key_version);
    // Whatever version it published must still exist, and the route must still read.
    expect(hasKey(indexedDb, publishedVersion)).toBe(true);
    await expect(collect(browserActiveTripSpool.readPoints(sessionId))).resolves.toHaveLength(1);
  });

  /** C. Spool acquisition is a cursor, not a whole-store read. */
  it('acquires spool key references without reading the whole manifest store', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const spool = await import('@/lib/browserActiveTripSpool');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    await captureRoute(spool.browserActiveTripSpool, 'cursor-a');
    await captureRoute(spool.browserActiveTripSpool, 'cursor-b');

    await withoutGetAll(indexedDb, async () => {
      await expect(spool.countSpoolKeyVersionReferences(1)).resolves.toBeGreaterThan(0);
      await expect(spool.rewrapSpoolKeyVersion(1, 2)).resolves
        .toMatchObject({ rewrapped: 2, hasMore: false });
    });
  });

  /** C. P6 acquisition is a cursor, not a whole-store read. */
  it('acquires P6 key references without reading the whole derived store', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const p6 = await import('@/lib/p6TripDerivedState');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');
    await crypto.ensureEncryptionKeyVersion(1);

    const payload = await crypto.encryptSensitiveValue(
      { total: 4 }, 'p6:analytics-bucket:bucket-1:rev-1',
    );
    const db = await openP6TripDerivedDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS)
        .put({ key: 'bucket-1', revisionToken: 'rev-1', payload });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await withoutGetAll(indexedDb, async () => {
      await expect(p6.countP6KeyVersionReferences(1)).resolves.toBe(1);
    });
  });

  /** D. `hasMore` must defer finalization and resume durably. */
  it('carries an unfinished rewrap across turns instead of finalizing early', async () => {
    const manager = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool, KEY_REWRAP_SESSIONS_PER_TURN } =
      await import('@/lib/browserActiveTripSpool');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    const sessions = [];
    for (let index = 0; index < KEY_REWRAP_SESSIONS_PER_TURN + 4; index += 1) {
      sessions.push(await captureRoute(browserActiveTripSpool, `bulk-${index}`));
    }

    const at = 1_000 + manager.KEY_ROTATION_MS + 1;
    const first = await manager.checkAndRotateEncryptionKey({ now: at });
    expect(first).toMatchObject({ rotated: false, hasMore: true, version: 1, pendingVersion: 2 });
    expect(hasKey(indexedDb, 1)).toBe(true);   // nothing finalized, nothing destroyed

    // Durable resume: a restarted renderer must continue the SAME pending rotation from
    // what is already committed, not start over and not finalize what it did not finish.
    vi.resetModules();
    const resumed = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool: reloaded } = await import('@/lib/browserActiveTripSpool');
    const { result } = await rotateToCompletion(resumed, at);
    expect(result).toMatchObject({ rotated: true, version: 2 });

    for (const sessionId of sessions) {
      await expect(collect(reloaded.readPoints(sessionId))).resolves.toHaveLength(2);
    }
  });

  /** E. Real P6 references converge — they are rewrapped, not merely counted. */
  it('rewraps real P6 derived references onto the new version', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    await import('@/lib/p6TripDerivedState');
    const manager = await import('@/lib/keyRotationManager');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    const bucketContext = 'p6:analytics-bucket:bucket-9:rev-9';
    const chunkContext = 'p6:trip-derived:trip-9:rev-9:geometry-v1:0';
    const [bucket, chunk] = await Promise.all([
      crypto.encryptSensitiveValue({ total: 7 }, bucketContext),
      crypto.encryptSensitiveValue({ pointBlock: 'abc' }, chunkContext),
    ]);
    const db = await openP6TripDerivedDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([
        P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS,
        P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      ], 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS)
        .put({ key: 'bucket-9', revisionToken: 'rev-9', payload: bucket });
      tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).put({
        key: 'trip-9:rev-9:geometry-v1:0',
        tripId: 'trip-9',
        contentVersion: 'rev-9:geometry-v1',
        ordinal: 0,
        payload: chunk,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await rotateToCompletion(manager, 1_000 + manager.KEY_ROTATION_MS + 1);

    const after = await openP6TripDerivedDatabase();
    const read = (store, key) => new Promise((resolve, reject) => {
      const request = after.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const bucketRow = await read(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'bucket-9');
    const chunkRow = await read(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'trip-9:rev-9:geometry-v1:0');
    after.close();

    expect(Number(bucketRow?.payload?.key_version)).toBe(2);
    expect(Number(chunkRow?.payload?.key_version)).toBe(2);
    // Rewrapped, not re-created: the plaintext must be unchanged under the same AAD.
    await expect(crypto.decryptSensitiveValue(bucketRow.payload, bucketContext))
      .resolves.toEqual({ total: 7 });
    await expect(crypto.decryptSensitiveValue(chunkRow.payload, chunkContext))
      .resolves.toEqual({ pointBlock: 'abc' });
    expect(hasKey(indexedDb, 1)).toBe(false);   // the retention actually resolved
  });

  /** E. Real speed references converge, and the driver's own corrections survive. */
  it('rewraps real speed-knowledge partitions and preserves user corrections', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    const speed = await import('@/lib/speedKnowledgeRepository');
    const manager = await import('@/lib/keyRotationManager');
    await manager.checkAndRotateEncryptionKey({ now: 1_000 });

    const context = 'p6:speed-v2:stage-1:abcd:3:0';
    const value = {
      cells: { abcd12: { limitKmh: 40 } },
      corrections: [{ roadId: 'r-1', limitKmh: 40, source: 'user' }],
    };
    const payload = await crypto.encryptSensitiveValue(value, context);
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
      tx.objectStore(speed.P6_SPEED_STORES.PARTITIONS).put({
        key: 'stage-1:abcd:0',
        stageId: 'stage-1',
        bucketId: 'abcd',
        publicationVersion: 3,
        ordinal: 0,
        commitState: 'COMMITTED',
        payload,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    await rotateToCompletion(manager, 1_000 + manager.KEY_ROTATION_MS + 1);

    const row = indexedDb
      .getStoreState(speed.SPEED_KNOWLEDGE_DB_NAME, speed.P6_SPEED_STORES.PARTITIONS)
      .records.get('stage-1:abcd:0');
    expect(Number(row?.payload?.key_version)).toBe(2);
    await expect(crypto.decryptSensitiveValue(row.payload, context)).resolves.toEqual(value);
    await expect(speed.countSpeedKnowledgeKeyVersionReferences(1)).resolves.toBe(0);
  });

  /** F. The live key set stays bounded across repeated real rotations. */
  it('keeps the live root-key count bounded across repeated rotations', async () => {
    const crypto = await import('@/lib/securePayloadCrypto');
    await import('@/lib/p6TripDerivedState');
    await import('@/lib/speedKnowledgeRepository');
    const manager = await import('@/lib/keyRotationManager');
    const { browserActiveTripSpool } = await import('@/lib/browserActiveTripSpool');
    const { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } =
      await import('@/lib/localTripRepository');

    await manager.checkAndRotateEncryptionKey({ now: 1_000 });
    const sessionId = await captureRoute(browserActiveTripSpool, 'bounded-route', 3);
    await crypto.setEncryptedJson('drivesense_privacy_score_history_v1', { sample: 1 });

    // A real count-only holder: before round 3, P6 could only report a reference, so the
    // retention never resolved and every rotation added another live version.
    const bucket = await crypto.encryptSensitiveValue(
      { total: 11 }, 'p6:analytics-bucket:bounded:rev-0',
    );
    const p6Db = await openP6TripDerivedDatabase();
    await new Promise((resolve, reject) => {
      const tx = p6Db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS)
        .put({ key: 'bounded', revisionToken: 'rev-0', payload: bucket });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    p6Db.close();

    let at = 1_000;
    for (let rotation = 0; rotation < 5; rotation += 1) {
      at += manager.KEY_ROTATION_MS + 1;
      await rotateToCompletion(manager, at);
      // current + at most one retained: the set must not grow with the rotation count.
      expect(liveKeyVersions(indexedDb).length).toBeLessThanOrEqual(2);
    }

    // Bounded is necessary but not sufficient: the retention must actually RESOLVE, or
    // the app runs forever on a key that rotation was supposed to retire.
    const active = await crypto.getActiveEncryptionKeyVersion();
    expect(liveKeyVersions(indexedDb)).toEqual([active]);

    await expect(collect(browserActiveTripSpool.readPoints(sessionId))).resolves.toHaveLength(3);
    await expect(crypto.getEncryptedJson('drivesense_privacy_score_history_v1', null))
      .resolves.toMatchObject({ sample: 1 });
  });
});
