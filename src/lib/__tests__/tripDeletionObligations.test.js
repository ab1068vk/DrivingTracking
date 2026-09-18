import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * Deletion and erasure safety obligations (Codex closure I2).
 *
 * The property under test is *no resurrection*: a trip must not disappear from
 * the store the user can see while a store that could hand it back — the
 * fallback blob, the native completed journal — has no durable fail-closed
 * obligation covering it. Every barrier and obligation write is therefore
 * exercised with an injected failure, because the defect was that those
 * failures were caught, logged and reported as a successful deletion.
 */

const { nativeState, systemFailures } = vi.hoisted(() => ({
  nativeState: { android: true, journal: [], journalThrows: false },
  systemFailures: [],
}));

vi.mock('@/lib/systemLog', async (importActual) => {
  const actual = await importActual();
  return { ...actual, logSystemFailure: (event) => { systemFailures.push(event); } };
});

vi.mock('@/lib/nativePlatform', async (importActual) => {
  const actual = await importActual();
  return { ...actual, isAndroid: () => nativeState.android };
});

vi.mock('@/lib/activityRecognition', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    // AUD-005 round 2: the drain reads a TYPED page so it can see the journal's own
    // continuation and blocked state instead of inferring them from the trip count.
    getNativeCompletedTripPage: async () => {
      if (nativeState.journalThrows) throw new Error('native bridge unavailable');
      return {
        trips: nativeState.journal,
        queueStatus: { pendingCount: nativeState.journal.length },
        oversizedTripIds: [],
        unreadableTripIds: [],
        blocked: false,
        hasMore: false,
      };
    },
    acknowledgeNativeCompletedTrips: async () => true,
  };
});

const {
  eraseTripRepositoryForDataRights,
  localTripRepository,
  setNativeErasurePending,
  syncNativeCompletedTrips,
} = await import('@/lib/localTripRepository');

/**
 * Wrap a fake IndexedDB so chosen transactions fail.
 *
 * `request.result` is assigned inside the fake's own microtask, so the database
 * is intercepted through a property setter rather than after the fact.
 */
const withInjectedFailure = (inner, shouldFail) => ({
  open(name, version) {
    const request = inner.open(name, version);
    let stored;
    Object.defineProperty(request, 'result', {
      configurable: true,
      get: () => stored,
      set: (db) => {
        if (db && !db.__failureInjected) {
          db.__failureInjected = true;
          const original = db.transaction.bind(db);
          db.transaction = (storeNames, mode) => {
            if (shouldFail(storeNames, mode)) throw new Error('injected transaction failure');
            return original(storeNames, mode);
          };
        }
        stored = db;
      },
    });
    return request;
  },
  deleteDatabase: (name) => inner.deleteDatabase(name),
});

const names = (storeNames) => (Array.isArray(storeNames) ? storeNames : [storeNames]);
const failMetaWrites = (storeNames, mode) => names(storeNames).includes('trip_meta') && mode === 'readwrite';

const tripFixture = (id, overrides = {}) => ({
  id,
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  end_time: '2026-03-01T08:20:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.1, timestamp: '2026-03-01T08:00:00.000Z' }],
  ...overrides,
});

let backing;

beforeEach(() => {
  backing = new FakeIndexedDb();
  nativeState.android = false;
  nativeState.journal = [];
  nativeState.journalThrows = false;
  vi.stubGlobal('indexedDB', backing);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deletion obligations are durable before deletion is visible (I2-A)', () => {
  it('fails the delete, and removes nothing, when the fallback obligation cannot be stored', async () => {
    await localTripRepository.create(tripFixture('keep-me'));
    vi.stubGlobal('indexedDB', withInjectedFailure(backing, failMetaWrites));

    await expect(localTripRepository.delete('keep-me')).rejects.toThrow(/could not verify this trip deletion/i);

    // The obligation is what makes the deletion safe to report. Without it the
    // trip must still be here rather than gone-but-resurrectable.
    vi.stubGlobal('indexedDB', backing);
    const remaining = await localTripRepository.listAll();
    expect(remaining.map((trip) => trip.id)).toContain('keep-me');
  });

  it('fails the delete when the native obligation cannot be stored', async () => {
    await localTripRepository.create(tripFixture('native-keep'));
    nativeState.android = true;
    nativeState.journal = [];
    vi.stubGlobal('indexedDB', withInjectedFailure(backing, failMetaWrites));

    await expect(localTripRepository.delete('native-keep')).rejects.toThrow(/could not verify this trip deletion/i);

    vi.stubGlobal('indexedDB', backing);
    nativeState.android = false;
    const remaining = await localTripRepository.listAll();
    expect(remaining.map((trip) => trip.id)).toContain('native-keep');
  });

  it('fails the delete on Android when there is no IndexedDB to record the obligation in', async () => {
    nativeState.android = true;
    vi.stubGlobal('indexedDB', undefined);
    // No trip_meta exists at all, so the native journal could re-import the id
    // and nothing would suppress it.
    await expect(localTripRepository.delete('unreachable')).rejects.toThrow();
  });

  it('deletes normally when every obligation is durable', async () => {
    await localTripRepository.create(tripFixture('go-away'));
    nativeState.android = true;
    nativeState.journal = [];
    const outcome = await localTripRepository.delete('go-away');
    nativeState.android = false;
    expect(outcome.record_found).toBe(true);
    const remaining = await localTripRepository.listAll();
    expect(remaining.map((trip) => trip.id)).not.toContain('go-away');
  });
});

describe('no resurrection after deletion (I2-A)', () => {
  /**
   * Admission marker.
   *
   * The native import swallows its own errors and returns an empty result
   * either way, so "empty" alone cannot tell suppression from a crash. In this
   * environment the Android crypto path is unavailable, so a journal entry that
   * *was* admitted always reaches persistence and logs a failure. Presence of that log
   * means admitted; absence means suppressed. Without this control the suppression
   * assertions would pass for the wrong reason.
   *
   * AUD-005 moved where that failure surfaces: the drain now isolates a failing PAGE so
   * the pages that succeeded are kept, so an admitted-but-failing import is logged as
   * `native_completed_trips_page_import` rather than escaping to the whole-import catch.
   */
  const IMPORT_ATTEMPTED = 'native_completed_trips_page_import';

  it('admits a journal entry that was never deleted (control)', async () => {
    nativeState.android = true;
    nativeState.journal = [tripFixture('control-trip')];
    systemFailures.length = 0;
    await syncNativeCompletedTrips();
    expect(systemFailures).toContain(IMPORT_ATTEMPTED);
  });

  it('does not re-admit a deleted trip that is still in the native journal', async () => {
    // Seeded as an already-imported trip: `isAndroid()` also routes the crypto
    // path to the native bridge, so only the delete and the import run as Android.
    await localTripRepository.create(tripFixture('ghost'));
    nativeState.android = true;
    nativeState.journal = [tripFixture('ghost')];

    await localTripRepository.delete('ghost');

    // "Restart": a fresh import pass over the same still-populated journal.
    systemFailures.length = 0;
    const result = await syncNativeCompletedTrips();
    expect(systemFailures).not.toContain(IMPORT_ATTEMPTED);
    expect(result.importedTrips ?? []).toEqual([]);

    nativeState.android = false;
    const after = await localTripRepository.listAll();
    expect(after.map((trip) => trip.id)).not.toContain('ghost');
  });

  it('suppresses native import globally when the delete probe failed', async () => {
    await localTripRepository.create(tripFixture('probe-ghost'));
    nativeState.android = true;
    nativeState.journal = [tripFixture('probe-ghost')];
    // The probe fails during the delete, so the exact id cannot be confirmed.
    // Global uncertainty must cover it instead of a per-id entry — and it must
    // still suppress once the bridge comes back.
    nativeState.journalThrows = true;
    await localTripRepository.delete('probe-ghost');
    nativeState.journalThrows = false;

    systemFailures.length = 0;
    await syncNativeCompletedTrips();
    expect(systemFailures).not.toContain(IMPORT_ATTEMPTED);

    nativeState.android = false;
    const after = await localTripRepository.listAll();
    expect(after.map((trip) => trip.id)).not.toContain('probe-ghost');
  });
});

describe('the erasure barrier must be proven durable (I2-B)', () => {
  it('refuses to raise the barrier when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(setNativeErasurePending(true)).rejects.toThrow(/safety barrier/i);
  });

  it('refuses to raise the barrier when the write fails', async () => {
    vi.stubGlobal('indexedDB', withInjectedFailure(backing, failMetaWrites));
    await expect(setNativeErasurePending(true)).rejects.toThrow(/safety barrier/i);
  });

  it('raises the barrier when it can be stored', async () => {
    await expect(setNativeErasurePending(true)).resolves.toBeUndefined();
  });

  it('clearing a barrier that cannot exist is a no-op, not a failure', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(setNativeErasurePending(false)).resolves.toBeUndefined();
  });
});

describe('repository erasure is verified, not assumed (I2-C)', () => {
  it('counts projections as a number and reports verified on a clean erase', async () => {
    await localTripRepository.create(tripFixture('erase-1'));
    await localTripRepository.create(tripFixture('erase-2'));

    const result = await eraseTripRepositoryForDataRights();
    expect(Number.isFinite(result.projectionRecordsWiped)).toBe(true);
    expect(result.recordsWiped).toBe(2);
    expect(result.verified).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.remainingRecords).toEqual({ trips: 0, summaries: 0, projections: 0, derived: 0 });
  });

  it('erases an orphan projection whose source trip is already gone', async () => {
    await localTripRepository.create(tripFixture('orphan-source'));
    // Remove only the source row, leaving its projection behind — the exact
    // residue a trips-store-driven enumeration would never visit.
    const db = backing.databases.get('drivesense_mobile');
    db.stores.get('trips').records.delete('orphan-source');

    const result = await eraseTripRepositoryForDataRights();
    expect(result.projectionRecordsWiped).toBeGreaterThanOrEqual(1);
    expect(result.remainingRecords.projections).toBe(0);
    expect(result.verified).toBe(true);
  });

  it('reports unverified when the erase itself fails', async () => {
    await localTripRepository.create(tripFixture('stubborn'));
    vi.stubGlobal('indexedDB', withInjectedFailure(
      backing,
      (storeNames, mode) => names(storeNames).includes('trips') && mode === 'readwrite'
    ));

    const result = await eraseTripRepositoryForDataRights();
    expect(result.verified).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
