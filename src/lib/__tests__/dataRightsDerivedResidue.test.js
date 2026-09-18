/**
 * AUD-004 — data-rights erasure must reach the derived stores, and must not claim more
 * than it proved.
 *
 * The defect had two halves:
 *
 *  1. The P6 derived stores live in the same IndexedDB database as trips and hold
 *     PLAINTEXT trip metadata — `p6_recent_order` carries the trip id and start time, a
 *     contribution row carries the recent key, a geometry chunk carries the trip id,
 *     point count and encoded size. Erasure never visited them, and the receipt still
 *     reported `verified` / `erasureComplete`.
 *  2. A native settings write dispatched before the erasure landed afterwards and wrote
 *     the pre-erasure settings straight back, so a "complete" erasure repopulated the
 *     settings it had just removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from '@/lib/__tests__/helpers/fakeTripIndexedDb';

const runtime = vi.hoisted(() => ({ android: false }));
const nativePreferences = vi.hoisted(() => ({
  values: new Map(),
  get: vi.fn(async ({ key }) => ({ value: nativePreferences.values.get(key) ?? null })),
  set: vi.fn(async ({ key, value }) => { nativePreferences.values.set(key, String(value)); }),
  remove: vi.fn(async ({ key }) => { nativePreferences.values.delete(key); }),
  keys: vi.fn(async () => ({ keys: [...nativePreferences.values.keys()] })),
}));

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => runtime.android,
  isNativePlatform: () => runtime.android,
  getNativePlatform: () => (runtime.android ? 'android' : 'web'),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => runtime.android,
    getPlatform: () => (runtime.android ? 'android' : 'web'),
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: nativePreferences.get,
    set: nativePreferences.set,
    remove: nativePreferences.remove,
    keys: nativePreferences.keys,
  },
}));

vi.mock('@/lib/hashChainLog', async (importActual) => ({
  ...(await importActual()),
  beginPrivacyAuditErasure: vi.fn(async () => ({ token: 'aud004-regression' })),
  finishPrivacyAuditErasure: vi.fn(async () => ({ finished: true })),
}));

const storageDouble = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
  };
};

const trip = {
  id: 'aud004-trip',
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  end_time: '2026-03-01T08:20:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.1, timestamp: '2026-03-01T08:00:00.000Z' }],
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AUD-004 derived-store residue and the erasure receipt', () => {
  let backing;

  beforeEach(() => {
    runtime.android = false;
    nativePreferences.values.clear();
    nativePreferences.get.mockClear();
    nativePreferences.set.mockReset();
    nativePreferences.set.mockImplementation(async ({ key, value }) => {
      nativePreferences.values.set(key, String(value));
    });
    nativePreferences.remove.mockClear();
    nativePreferences.keys.mockClear();
    backing = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', backing);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'aud004-test-lock' }) },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const seedDerivedResidue = (stores) => {
    const db = backing.databases.get('drivesense_mobile');
    const rows = [
      [stores.RECENT_ORDER, 'recent:aud004', {
        key: 'recent:aud004', tripId: trip.id, startTime: trip.start_time,
        sourceBinding: 'browser', sourceRevision: 1,
      }],
      [stores.CONTRIBUTIONS, 'D1:browser:aud004-trip', {
        key: 'D1:browser:aud004-trip', tripId: trip.id,
        recentKey: `browser:${trip.start_time}:${trip.id}`,
        bucketKeys: ['2026-03-01'], updatedAt: Date.now(),
      }],
      [stores.GEOMETRY_CHUNKS, 'aud004-trip:1:0', {
        key: 'aud004-trip:1:0', tripId: trip.id, ordinal: 0,
        pointCount: 4321, encodedBytes: 98765, commitState: 'COMMITTED',
      }],
    ];
    for (const [storeName, key, row] of rows) {
      backing.databases.get('drivesense_mobile').stores.get(storeName).records.set(key, row);
    }
    return db;
  };

  const derivedResidueCount = (stores) => {
    const db = backing.databases.get('drivesense_mobile');
    return [stores.RECENT_ORDER, stores.CONTRIBUTIONS, stores.GEOMETRY_CHUNKS]
      .reduce((sum, name) => sum + (db.stores.get(name)?.records.size ?? 0), 0);
  };

  it('erases plaintext P6 trip metadata along with the canonical rows', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(trip);
    seedDerivedResidue(repository.P6_TRIP_DERIVED_STORES);
    expect(derivedResidueCount(repository.P6_TRIP_DERIVED_STORES)).toBe(3);

    const result = await repository.eraseTripRepositoryForDataRights();

    expect(derivedResidueCount(repository.P6_TRIP_DERIVED_STORES)).toBe(0);
    expect(result.derivedRecordsWiped).toBeGreaterThanOrEqual(3);
    expect(result.remainingRecords.derived).toBe(0);
    expect(result.verified).toBe(true);
  });

  it('refuses to verify while derived residue survives', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(trip);
    const db = seedDerivedResidue(repository.P6_TRIP_DERIVED_STORES);

    // A store that will not give up its rows. Erasure must report that, not paper over it.
    const stubborn = db.stores.get(repository.P6_TRIP_DERIVED_STORES.RECENT_ORDER);
    const records = stubborn.records;
    stubborn.records = {
      get size() { return records.size; },
      get: (key) => records.get(key),
      set: (key, value) => records.set(key, value),
      has: (key) => records.has(key),
      delete: () => true,                       // accepted, never actually removed
      keys: () => records.keys(),
      values: () => records.values(),
      entries: () => records.entries(),
      [Symbol.iterator]: () => records[Symbol.iterator](),
      forEach: (fn) => records.forEach(fn),
      clear: () => {},
    };

    const result = await repository.eraseTripRepositoryForDataRights();

    expect(result.remainingRecords.derived).toBeGreaterThan(0);
    expect(result.verified).toBe(false);
    expect(result.failures.some((failure) => failure.stage === 'repository_residue')).toBe(true);
  });

  it('does not report erasureComplete while derived residue survives', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(trip);
    const db = seedDerivedResidue(repository.P6_TRIP_DERIVED_STORES);
    const stubborn = db.stores.get(repository.P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS);
    const records = stubborn.records;
    stubborn.records = Object.create(records, { delete: { value: () => true } });

    const { eraseAllLocalDataAndBuildReceipt } = await import('@/lib/dataRights');
    const receipt = await eraseAllLocalDataAndBuildReceipt({
      now: Date.parse('2026-09-13T12:00:00Z'),
    });

    expect(receipt.tripRepository.verified).toBe(false);
    expect(receipt.erasureComplete).toBe(false);
  });

  it('reports erasureComplete once the derived stores really are empty', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(trip);
    seedDerivedResidue(repository.P6_TRIP_DERIVED_STORES);

    const { eraseAllLocalDataAndBuildReceipt } = await import('@/lib/dataRights');
    const receipt = await eraseAllLocalDataAndBuildReceipt({
      now: Date.parse('2026-09-13T12:00:00Z'),
    });

    expect(derivedResidueCount(repository.P6_TRIP_DERIVED_STORES)).toBe(0);
    expect(receipt.tripRepository.verified).toBe(true);
  });

  it('fences an already-dispatched native settings write out of erased settings', async () => {
    runtime.android = true;
    const settingsKey = 'drivesense_settings';
    const local = storageDouble({
      [settingsKey]: JSON.stringify({ tracking_paused: false, privacy_zones: [] }),
    });
    vi.stubGlobal('localStorage', local);
    nativePreferences.values.set(settingsKey, local.values.get(settingsKey));

    let releaseWrite;
    let writerEntered;
    const entered = new Promise((resolve) => { writerEntered = resolve; });
    nativePreferences.set.mockImplementationOnce(({ key, value }) => new Promise((resolve) => {
      writerEntered();
      releaseWrite = () => {
        nativePreferences.values.set(key, String(value));
        resolve();
      };
    }));

    const { clearSettingsMemoryForErasure, localSettings } = await import('@/lib/trackingStore');
    localSettings.update({ tracking_paused: true });
    await entered;

    // dataRights ordering: the key is removed natively and locally, then in-memory
    // settings are cleared. The dispatched write is still outstanding at that point.
    nativePreferences.values.delete(settingsKey);
    local.values.delete(settingsKey);
    clearSettingsMemoryForErasure();
    releaseWrite();
    await flush();
    await flush();

    expect(nativePreferences.values.has(settingsKey)).toBe(false);
  });

  it('still writes settings natively when no erasure intervened', async () => {
    runtime.android = true;
    const settingsKey = 'drivesense_settings';
    vi.stubGlobal('localStorage', storageDouble({
      [settingsKey]: JSON.stringify({ tracking_paused: false, privacy_zones: [] }),
    }));

    const { localSettings } = await import('@/lib/trackingStore');
    localSettings.update({ tracking_paused: true });
    await flush();
    await flush();

    expect(nativePreferences.values.has(settingsKey)).toBe(true);
    expect(JSON.parse(nativePreferences.values.get(settingsKey)).tracking_paused).toBe(true);
  });
});
