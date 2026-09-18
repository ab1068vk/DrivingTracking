import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * Fallback-erasure barrier lifetime (Codex closure I2).
 *
 * The invariant: an erasure that destroys the source data but cannot destroy the
 * fallback blob must never leave that blob readable — not after a restart, and
 * not when IndexedDB is unavailable. The overlay that normally hides deleted
 * rows is itself erased during a data-rights wipe, so a separate durable barrier
 * has to cover the window, and it may only retire once the blob is proven gone.
 *
 * `mobileStorage` is backed by a real in-memory map here so a "restart" is
 * simply re-reading it through the production code path.
 */

const { store, faults } = vi.hoisted(() => ({
  store: new Map(),
  faults: {
    setKeys: new Set(), removeKeys: new Set(), getKeys: new Set(), swallowSetKeys: new Set(),
  },
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: async (key, fallback) => {
    if (faults.getKeys.has(key)) throw new Error(`injected get failure for ${key}`);
    return store.has(key) ? structuredClone(store.get(key)) : fallback;
  },
  setJson: async (key, value) => {
    if (faults.setKeys.has(key)) throw new Error(`injected set failure for ${key}`);
    // A write that reports success and stores nothing: the failure mode the
    // readback exists to catch.
    if (faults.swallowSetKeys.has(key)) return;
    store.set(key, structuredClone(value));
  },
  removeJson: async (key) => {
    if (faults.removeKeys.has(key)) throw new Error(`injected remove failure for ${key}`);
    store.delete(key);
  },
}));

const {
  TRIPS_KEY,
  TRIPS_ERASURE_BARRIER_KEY,
  eraseTripRepositoryForDataRights,
  localTripRepository,
} = await import('@/lib/localTripRepository');

const tripFixture = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-06-01T08:00:00.000Z',
  end_time: '2026-06-01T08:30:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.1, timestamp: '2026-06-01T08:00:00.000Z' }],
});

/**
 * Put a readable trip blob in the fallback store, as a session that ran while
 * IndexedDB was unavailable would have left behind.
 */
const seedFallbackBlob = (ids) => {
  store.set(TRIPS_KEY, ids.map((id) => tripFixture(id)));
};

let backing;

beforeEach(() => {
  store.clear();
  faults.setKeys.clear();
  faults.removeKeys.clear();
  faults.getKeys.clear();
  faults.swallowSetKeys.clear();
  backing = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', backing);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * An IndexedDB whose `open` always fails.
 *
 * The fallback blob is only consulted when the primary store cannot be read, so
 * a healthy-but-empty database would make these assertions pass without ever
 * touching the path under test. This forces the real fallback read.
 */
class BrokenIndexedDb {
  open() {
    const request = { error: null, result: undefined, onerror: null, onsuccess: null };
    queueMicrotask(() => {
      request.error = new Error('injected IndexedDB open failure');
      request.onerror?.({ target: request });
    });
    return request;
  }

  cmp() { return 0; }
}

/** Everything `listAll` surfaces from the fallback blob when IndexedDB fails. */
const visibleAfterRestart = async ({ indexedDb = new BrokenIndexedDb() } = {}) => {
  vi.stubGlobal('indexedDB', indexedDb);
  const trips = await localTripRepository.listAll();
  return trips.map((trip) => String(trip.id));
};

describe('the barrier is raised before anything is destroyed', () => {
  it('raises and then retires it on a clean erase', async () => {
    await localTripRepository.create(tripFixture('clean-1'));
    const result = await eraseTripRepositoryForDataRights();

    expect(result.fallbackBarrierRaised).toBe(true);
    expect(result.fallbackBarrierRetired).toBe(true);
    expect(result.verified).toBe(true);
    expect(store.has(TRIPS_ERASURE_BARRIER_KEY)).toBe(false);
  });

  it('reports unverified when the barrier itself cannot be stored', async () => {
    faults.setKeys.add(TRIPS_ERASURE_BARRIER_KEY);
    const result = await eraseTripRepositoryForDataRights();
    expect(result.fallbackBarrierRaised).toBeUndefined();
    expect(result.verified).toBe(false);
    expect(result.failures.map((entry) => entry.stage)).toContain('fallback_barrier');
  });
});

describe('a barrier that cannot be established aborts before any destruction', () => {
  /** Snapshot every representation the erase would otherwise destroy. */
  const snapshot = () => {
    const database = backing.databases.get('drivesense_mobile');
    const rows = (name) => [...(database?.stores.get(name)?.records.keys() ?? [])].map(String).sort();
    return {
      trips: rows('trips'),
      summaries: rows('trip_summaries'),
      projections: rows('trip_projections'),
      meta: rows('trip_meta'),
      blob: structuredClone(store.get(TRIPS_KEY) ?? null),
    };
  };

  const seedProfile = async () => {
    await localTripRepository.create(tripFixture('keep-1'));
    await localTripRepository.create(tripFixture('keep-2'));
    seedFallbackBlob(['blob-1']);
  };

  it.each([
    ['the barrier write fails', () => { faults.setKeys.add(TRIPS_ERASURE_BARRIER_KEY); }],
    ['the barrier readback fails', () => { faults.getKeys.add(TRIPS_ERASURE_BARRIER_KEY); }],
    ['the barrier readback comes back unset', () => {
      // A write that silently does not persist is the readback's whole purpose.
      faults.swallowSetKeys.add(TRIPS_ERASURE_BARRIER_KEY);
    }],
  ])('%s: nothing is erased', async (_label, injectFault) => {
    await seedProfile();
    const before = snapshot();
    // The fallback destructive steps are armed too, so if the abort did not
    // happen the source would be gone and the blob would survive unguarded.
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    injectFault();

    const result = await eraseTripRepositoryForDataRights();

    expect(result.verified).toBe(false);
    expect(result.abortedBeforeErasure).toBe(true);
    expect(result.failures.map((entry) => entry.stage)).toEqual(['fallback_barrier']);
    // No destructive fallback operation was even attempted.
    expect(result.fallbackRemoved).toBe(false);
    expect(result.recordsWiped).toBe(0);
    expect(result.summaryRecordsWiped).toBe(0);
    expect(result.projectionRecordsWiped).toBe(0);
    // Every representation is byte-for-byte what it was.
    expect(snapshot()).toEqual(before);
  });

  it('does not treat surviving data as erased after a restart', async () => {
    await seedProfile();
    faults.setKeys.add(TRIPS_ERASURE_BARRIER_KEY);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await eraseTripRepositoryForDataRights();

    // No barrier was raised, so a restart must read the profile normally rather
    // than withholding it as mid-erasure.
    faults.setKeys.clear();
    faults.removeKeys.clear();
    expect(store.has(TRIPS_ERASURE_BARRIER_KEY)).toBe(false);
    vi.stubGlobal('indexedDB', backing);
    const trips = await localTripRepository.listAll();
    expect(trips.map((trip) => String(trip.id)).sort()).toEqual(['keep-1', 'keep-2']);
  });

  it('a retry with working storage completes the erasure', async () => {
    await seedProfile();
    faults.setKeys.add(TRIPS_ERASURE_BARRIER_KEY);
    const aborted = await eraseTripRepositoryForDataRights();
    expect(aborted.abortedBeforeErasure).toBe(true);

    faults.setKeys.clear();
    const retried = await eraseTripRepositoryForDataRights();

    expect(retried.abortedBeforeErasure).toBeUndefined();
    expect(retried.fallbackBarrierRaised).toBe(true);
    expect(retried.fallbackBarrierRetired).toBe(true);
    expect(retried.verified).toBe(true);
    expect(retried.recordsWiped).toBe(2);
    expect(store.has(TRIPS_KEY)).toBe(false);
    expect(store.has(TRIPS_ERASURE_BARRIER_KEY)).toBe(false);
    vi.stubGlobal('indexedDB', backing);
    expect(await localTripRepository.listAll()).toEqual([]);
  });
});

describe('a surviving fallback blob is never readable after a failed erase', () => {
  const expectHidden = async (result) => {
    expect(result.verified).toBe(false);
    // The blob is still there — that is the point of the test.
    expect(store.get(TRIPS_KEY)).toBeTruthy();
    // And the barrier survived with it.
    expect(store.get(TRIPS_ERASURE_BARRIER_KEY)?.pending).toBe(true);
    expect(await visibleAfterRestart()).toEqual([]);
  };

  it('overwrite fails', async () => {
    seedFallbackBlob(['ghost-a', 'ghost-b']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await expectHidden(await eraseTripRepositoryForDataRights());
  });

  it('removal fails', async () => {
    seedFallbackBlob(['ghost-c']);
    faults.removeKeys.add(TRIPS_KEY);
    // Overwrite succeeds, so what survives is a tombstone rather than trips;
    // the barrier must still hold until removal is proven.
    const result = await eraseTripRepositoryForDataRights();
    expect(result.verified).toBe(false);
    expect(store.get(TRIPS_ERASURE_BARRIER_KEY)?.pending).toBe(true);
    expect(await visibleAfterRestart()).toEqual([]);
  });

  it('both overwrite and removal fail', async () => {
    seedFallbackBlob(['ghost-d', 'ghost-e']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await expectHidden(await eraseTripRepositoryForDataRights());
  });

  it('stays hidden across a restart with a fresh database handle', async () => {
    await localTripRepository.create(tripFixture('idb-1'));
    seedFallbackBlob(['ghost-f']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await eraseTripRepositoryForDataRights();

    // A restart during an IndexedDB outage — the only condition under which the
    // fallback blob is consulted at all.
    expect(await visibleAfterRestart()).toEqual([]);
  });

  it('stays hidden when IndexedDB is unavailable entirely', async () => {
    seedFallbackBlob(['ghost-g']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await eraseTripRepositoryForDataRights();

    // The overlay lives in IndexedDB; the barrier deliberately does not, so it
    // still fails closed when there is no IndexedDB to consult.
    vi.stubGlobal('indexedDB', undefined);
    const trips = await localTripRepository.listAll();
    expect(trips.map((trip) => String(trip.id))).toEqual([]);
  });

  it('stays hidden when the barrier read itself fails', async () => {
    seedFallbackBlob(['ghost-h']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await eraseTripRepositoryForDataRights();

    faults.getKeys.add(TRIPS_ERASURE_BARRIER_KEY);
    expect(await visibleAfterRestart()).toEqual([]);
  });
});

describe('a retry can finish the erasure', () => {
  it('clears the blob, retires the barrier and reports complete', async () => {
    seedFallbackBlob(['retry-1', 'retry-2']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    const failed = await eraseTripRepositoryForDataRights();
    expect(failed.verified).toBe(false);
    expect(store.get(TRIPS_ERASURE_BARRIER_KEY)?.pending).toBe(true);

    // Storage recovers and the user retries.
    faults.setKeys.clear();
    faults.removeKeys.clear();
    const retried = await eraseTripRepositoryForDataRights();

    expect(retried.verified).toBe(true);
    expect(retried.fallbackRemoved).toBe(true);
    expect(retried.fallbackBarrierRetired).toBe(true);
    expect(store.has(TRIPS_KEY)).toBe(false);
    expect(store.has(TRIPS_ERASURE_BARRIER_KEY)).toBe(false);
    // Read back through a healthy database, which is the state a successful
    // retry leaves behind. Asserting through a broken one would only prove that
    // storage is unavailable, which says nothing about erasure.
    expect(await visibleAfterRestart({ indexedDb: backing })).toEqual([]);
  });
});

describe('the fallback overlay outlives the erase until the blob is gone', () => {
  it('keeps the suppression overlay when the blob survives', async () => {
    await localTripRepository.create(tripFixture('overlay-1'));
    await localTripRepository.delete('overlay-1');
    const metaBefore = backing.databases.get('drivesense_mobile').stores.get('trip_meta');
    expect([...metaBefore.records.keys()]).toContain('fallback_suppression');

    seedFallbackBlob(['overlay-1']);
    faults.setKeys.add(TRIPS_KEY);
    faults.removeKeys.add(TRIPS_KEY);
    await eraseTripRepositoryForDataRights();

    // Erasing the overlay while its blob still exists is exactly what let an
    // erased trip come back.
    const metaAfter = backing.databases.get('drivesense_mobile').stores.get('trip_meta');
    expect([...metaAfter.records.keys()]).toContain('fallback_suppression');
  });

  it('retires the overlay once the blob is verified gone', async () => {
    await localTripRepository.create(tripFixture('overlay-2'));
    await localTripRepository.delete('overlay-2');
    const result = await eraseTripRepositoryForDataRights();

    expect(result.verified).toBe(true);
    const meta = backing.databases.get('drivesense_mobile').stores.get('trip_meta');
    expect([...meta.records.keys()]).not.toContain('fallback_suppression');
  });
});
