/**
 * AUD-004 round 2 — data-rights erasure must be a bounded, resumable progression.
 *
 * `eraseTripRepositoryForDataRights()` materialized every key in every canonical and P6
 * store with `getAllKeys()` and then deleted every row in one JavaScript call. That is
 * history-proportional work and history-proportional resident memory in a single turn.
 *
 * Being user-explicit does not exempt it: a profile with a hundred thousand rows still has
 * to erase without one unbounded turn, and an erasure interrupted halfway must resume
 * rather than restart — and must never sign a completion it did not reach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb, FakeKeyRange } from './helpers/fakeTripIndexedDb';

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
vi.mock('@capacitor/preferences', () => ({ Preferences: nativePreferences }));
vi.mock('@/lib/hashChainLog', async (importActual) => ({
  ...(await importActual()),
  beginPrivacyAuditErasure: vi.fn(async () => ({ token: 'aud004-bounded' })),
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

const tripFixture = (id) => ({
  id,
  status: 'completed',
  start_time: '2026-03-01T08:00:00.000Z',
  end_time: '2026-03-01T08:20:00.000Z',
  route_points: [{ lat: 51.5, lng: -0.1, timestamp: '2026-03-01T08:00:00.000Z' }],
});

describe('AUD-004 bounded, resumable data-rights erasure', () => {
  let backing;

  beforeEach(() => {
    runtime.android = false;
    nativePreferences.values.clear();
    backing = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', backing);
    vi.stubGlobal('IDBKeyRange', FakeKeyRange);
    vi.stubGlobal('localStorage', storageDouble());
    vi.stubGlobal('sessionStorage', storageDouble());
    vi.stubGlobal('navigator', {
      locks: { request: async (_name, _options, run) => run({ name: 'aud004-bounded-lock' }) },
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

  const seedDerived = (stores, count) => {
    const db = backing.databases.get('drivesense_mobile');
    for (let index = 0; index < count; index += 1) {
      const key = `row-${String(index).padStart(5, '0')}`;
      db.stores.get(stores.ANALYTICS_BUCKETS).records.set(key, { key, revisionToken: 'r' });
    }
  };

  const derivedCount = (stores) => backing.databases.get('drivesense_mobile')
    .stores.get(stores.ANALYTICS_BUCKETS).records.size;

  /**
   * A store that accepts every delete and keeps every row. It has to stay a working Map
   * for reads — the point is a silent deletion failure, not an unreadable store, so the
   * residue proof must still be able to look and still refuse to verify.
   */
  const makeStubbornStore = (stores) => {
    const store = backing.databases.get('drivesense_mobile')
      .stores.get(stores.ANALYTICS_BUCKETS);
    const records = store.records;
    store.records = {
      get size() { return records.size; },
      get: (key) => records.get(key),
      set: (key, value) => records.set(key, value),
      has: (key) => records.has(key),
      delete: () => true,
      keys: () => records.keys(),
      values: () => records.values(),
      entries: () => records.entries(),
      forEach: (fn) => records.forEach(fn),
      [Symbol.iterator]: () => records[Symbol.iterator](),
    };
  };

  /** One turn must be bounded even when the profile is not. */
  it('erases in bounded turns instead of one history-proportional call', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-1'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 40);

    const turn = await repository.eraseTripRepositoryForDataRights({ rowBudget: 8, maxTurns: 1 });

    expect(turn.hasMore).toBe(true);
    expect(turn.verified).toBe(false);       // nothing may be signed mid-progress
    expect(derivedCount(repository.P6_TRIP_DERIVED_STORES)).toBeGreaterThan(0);
    expect(turn.rowsErasedThisCall).toBeLessThanOrEqual(8);
  });

  /** And the turns must actually converge, leaving no store behind. */
  it('completes across turns and only then verifies', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-2'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 40);

    let last = null;
    for (let turn = 0; turn < 40; turn += 1) {
      last = await repository.eraseTripRepositoryForDataRights({ rowBudget: 8, maxTurns: 1 });
      if (!last.hasMore) break;
    }

    expect(last.hasMore).toBe(false);
    expect(last.verified).toBe(true);
    expect(derivedCount(repository.P6_TRIP_DERIVED_STORES)).toBe(0);
    expect(last.remainingRecords.derived).toBe(0);
  });

  /** The continuation has to be durable, not a closure variable. */
  it('resumes an interrupted erasure after a module restart', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-3'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 30);

    const first = await repository.eraseTripRepositoryForDataRights({ rowBudget: 6, maxTurns: 1 });
    expect(first.hasMore).toBe(true);
    const remainingAfterFirst = derivedCount(repository.P6_TRIP_DERIVED_STORES);

    vi.resetModules();
    const restarted = await import('@/lib/localTripRepository');
    const second = await restarted.eraseTripRepositoryForDataRights({ rowBudget: 6, maxTurns: 1 });

    // A restart that started over would re-walk the rows already deleted and make no
    // progress on the tail.
    expect(derivedCount(restarted.P6_TRIP_DERIVED_STORES)).toBeLessThan(remainingAfterFirst);
    expect(second.rowsErasedThisCall).toBeGreaterThan(0);
  });

  /** A default call still erases everything — bounded is not partial. */
  it('erases the whole profile when no turn limit is given', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-4'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 50);

    const result = await repository.eraseTripRepositoryForDataRights();

    expect(result.hasMore).toBe(false);
    expect(result.verified).toBe(true);
    expect(derivedCount(repository.P6_TRIP_DERIVED_STORES)).toBe(0);
  });

  /** A failure on a later page must not be signed off as a clean erasure. */
  it('does not verify when a later page cannot be erased', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-5'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 30);

    makeStubbornStore(repository.P6_TRIP_DERIVED_STORES);

    const result = await repository.eraseTripRepositoryForDataRights();

    expect(result.verified).toBe(false);
    expect(result.remainingRecords.derived).toBeGreaterThan(0);
  });

  /** The receipt follows the repository: no terminal completion, no completion claim. */
  it('never reports erasureComplete for an unfinished erasure', async () => {
    const repository = await import('@/lib/localTripRepository');
    await repository.localTripRepository.create(tripFixture('bounded-6'));
    seedDerived(repository.P6_TRIP_DERIVED_STORES, 20);

    makeStubbornStore(repository.P6_TRIP_DERIVED_STORES);

    const { eraseAllLocalDataAndBuildReceipt } = await import('@/lib/dataRights');
    const receipt = await eraseAllLocalDataAndBuildReceipt({
      now: Date.parse('2026-09-14T12:00:00Z'),
    });

    expect(receipt.tripRepository.verified).toBe(false);
    expect(receipt.erasureComplete).toBe(false);
  });
});
