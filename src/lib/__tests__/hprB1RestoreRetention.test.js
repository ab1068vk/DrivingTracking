import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const OLD_TIME = new Date(NOW - 400 * DAY_MS).toISOString();
const RECENT_TIME = new Date(NOW - 2 * DAY_MS).toISOString();

const settingsValue = (retentionDays) => JSON.stringify({
  settings_defaults_version: 24,
  data_retention_days: retentionDays,
  raw_gps_retention_days: 0,
  motion_sample_retention_days: 0,
  privacy_zones: [],
});

const storageDouble = (initialRetentionDays = 0) => {
  const values = new Map([['drivesense_settings', settingsValue(initialRetentionDays)]]);
  return {
    values,
    storage: {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    },
  };
};

const trip = (id, time = RECENT_TIME) => ({
  id,
  status: 'completed',
  start_time: time,
  end_time: time,
  distance_km: 5,
  duration_seconds: 600,
  route_points: [{ lat: 43.65, lng: -79.38, timestamp: time }],
});

async function boot(retentionDays = 0, existing = null) {
  vi.resetModules();
  const indexedDb = existing?.indexedDb || new FakeIndexedDb();
  const storageState = existing?.storageState || storageDouble(retentionDays);
  vi.stubGlobal('indexedDB', indexedDb);
  vi.stubGlobal('localStorage', storageState.storage);
  vi.stubGlobal('sessionStorage', storageDouble(0).storage);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_name, optionsOrRun, maybeRun) => (
        typeof optionsOrRun === 'function' ? optionsOrRun() : maybeRun()
      ),
    },
  });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('CustomEvent', class {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  });
  const crypto = await import('@/lib/securePayloadCrypto');
  await crypto.ensureEncryptionKeyVersion(1);
  const repository = await import('@/lib/localTripRepository');
  const sourceChange = await import('@/lib/p7SourceChange');
  sourceChange.resetP7SourceChangeForTests();
  return { indexedDb, storageState, repository, sourceChange };
}

const exists = async (repository, id) => {
  try {
    return Boolean(await repository.localTripRepository.getById(id));
  } catch {
    return false;
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('HPR-B1 restore-specific retention contract', () => {
  it('uses explicit keep-everything policy instead of ambient 30-day retention', async () => {
    const { repository } = await boot(30);

    const outcome = await repository.localTripRepository.restoreBatch(
      [trip('old-import-kept', OLD_TIME)],
      { retentionDays: 0, now: NOW },
    );

    expect(outcome).toMatchObject({
      attemptedTrips: 1,
      removedByRetention: 0,
      failedWrites: 0,
      retentionPending: 0,
      status: 'complete',
    });
    expect(outcome.survivingTrips.map(({ id }) => id)).toEqual(['old-import-kept']);
    expect(await exists(repository, 'old-import-kept')).toBe(true);
  });

  it('does not count an imported row excluded by the explicit restored policy', async () => {
    const { indexedDb, repository } = await boot(0);

    const outcome = await repository.localTripRepository.restoreBatch(
      [trip('old-import-removed', OLD_TIME)],
      { retentionDays: 30, now: NOW },
    );

    expect(outcome).toMatchObject({
      attemptedTrips: 1,
      removedByRetention: 1,
      failedWrites: 0,
      retentionPending: 0,
      status: 'complete',
    });
    expect(outcome.survivingTrips).toEqual([]);
    expect(await exists(repository, 'old-import-removed')).toBe(false);
    expect(indexedDb.getStoreState(repository.DB_NAME, 'trips').getAllCount).toBe(0);
  });

  it.each([4, 40, 400])('keeps imported-row work linear and performs no whole-store scan at T=%s', async (total) => {
    const { indexedDb, repository } = await boot(30);
    let restored = 0;
    for (let offset = 0; offset < total; offset += 4) {
      const batch = Array.from(
        { length: Math.min(4, total - offset) },
        (_, index) => trip(`scale-${total}-${offset + index}`),
      );
      const outcome = await repository.localTripRepository.restoreBatch(batch, {
        retentionDays: 30,
        now: NOW,
      });
      restored += outcome.survivingTrips.length;
    }

    const store = indexedDb.getStoreState(repository.DB_NAME, 'trips');
    expect(restored).toBe(total);
    expect(store.getAllCount).toBe(0);
    expect(store.putAttempts).toBe(total);
  }, 120_000);

  it('uses the durable setting after restart to resume bounded pre-existing reconciliation', async () => {
    const first = await boot(0);
    await first.repository.localTripRepository.create(trip('pre-existing-old', OLD_TIME));
    const trackingStore = await import('@/lib/trackingStore');
    trackingStore.localSettings.update({ data_retention_days: 30 });

    const durable = { indexedDb: first.indexedDb, storageState: first.storageState };
    const second = await boot(30, durable);
    const store = second.indexedDb.getStoreState(second.repository.DB_NAME, 'trips');
    store.getAllCount = 0;

    const outcome = await second.repository.stepTripDataRetention({ now: NOW, limit: 1 });

    expect(outcome).toMatchObject({ enabled: true, deletedTrips: 1, processed: 1 });
    expect(store.getAllCount).toBe(0);
    expect(await exists(second.repository, 'pre-existing-old')).toBe(false);
  });

  it('publishes and invalidates a cursor after batch-local automatic retention deletes', async () => {
    const { repository, sourceChange } = await boot(0);
    await repository.localTripRepository.create(trip('batch-old-a', OLD_TIME));
    await repository.localTripRepository.create(trip('batch-old-b', OLD_TIME));
    const page = await repository.queryTripHistoryPage({ limit: 1, status: 'completed' });
    const beforeSnapshot = await repository.readP7QuerySnapshot();
    const beforeToken = sourceChange.getP7SourceToken();
    const notifications = [];
    const unsubscribe = sourceChange.subscribeP7SourceChange((event) => notifications.push(event));

    const outcome = await repository.enforceTripDataRetention({
      now: NOW,
      retentionDays: 30,
      trips: [trip('batch-old-a', OLD_TIME)],
    });
    unsubscribe();

    const afterSnapshot = await repository.readP7QuerySnapshot();
    const stale = await repository.queryTripHistoryPage({
      limit: 1,
      status: 'completed',
      cursor: page.continuation,
    });
    expect(outcome.deletedTrips).toBe(1);
    expect(afterSnapshot.revision).toBeGreaterThan(beforeSnapshot.revision);
    expect(sourceChange.getP7SourceToken()).toBeGreaterThan(beforeToken);
    expect(notifications).toHaveLength(1);
    expect(stale.unavailable?.code).toBe('CURSOR_RESTART_REQUIRED');
  });

  it('publishes and invalidates a cursor after a bounded retention turn deletes', async () => {
    const { repository, sourceChange } = await boot(0);
    await repository.localTripRepository.create(trip('step-old-a', OLD_TIME));
    await repository.localTripRepository.create(trip('step-old-b', OLD_TIME));
    const page = await repository.queryTripHistoryPage({ limit: 1, status: 'completed' });
    const trackingStore = await import('@/lib/trackingStore');
    trackingStore.localSettings.update({ data_retention_days: 30 });
    const beforeSnapshot = await repository.readP7QuerySnapshot();
    const beforeToken = sourceChange.getP7SourceToken();
    const notifications = [];
    const unsubscribe = sourceChange.subscribeP7SourceChange((event) => notifications.push(event));

    const outcome = await repository.stepTripDataRetention({ now: NOW, limit: 1 });
    unsubscribe();

    const afterSnapshot = await repository.readP7QuerySnapshot();
    const stale = await repository.queryTripHistoryPage({
      limit: 1,
      status: 'completed',
      cursor: page.continuation,
    });
    expect(outcome.deletedTrips).toBe(1);
    expect(afterSnapshot.revision).toBeGreaterThan(beforeSnapshot.revision);
    expect(sourceChange.getP7SourceToken()).toBeGreaterThan(beforeToken);
    expect(notifications).toHaveLength(1);
    expect(stale.unavailable?.code).toBe('CURSOR_RESTART_REQUIRED');
  });

  it('does no deletion and no whole-store scan when explicit retention is zero', async () => {
    const { indexedDb, repository, sourceChange } = await boot(30);
    await repository.localTripRepository.restoreBatch([trip('zero-keeps-old', OLD_TIME)], {
      retentionDays: 0,
      now: NOW,
    });
    const store = indexedDb.getStoreState(repository.DB_NAME, 'trips');
    const beforeDeletes = store.deleteAttempts;
    const beforeToken = sourceChange.getP7SourceToken();

    const outcome = await repository.enforceTripDataRetention({
      now: NOW,
      retentionDays: 0,
      trips: [trip('zero-keeps-old', OLD_TIME)],
    });

    expect(outcome).toEqual({ enabled: false, retentionDays: 0, deletedTrips: 0 });
    expect(store.deleteAttempts).toBe(beforeDeletes);
    expect(store.getAllCount).toBe(0);
    expect(sourceChange.getP7SourceToken()).toBe(beforeToken);
    expect(await exists(repository, 'zero-keeps-old')).toBe(true);
  });

  it('publishes a committed subset when a later retention deletion fails and remains retryable', async () => {
    const { indexedDb, repository, sourceChange } = await boot(0);
    const first = trip('partial-delete-a', OLD_TIME);
    const second = trip('partial-delete-b', OLD_TIME);
    await repository.localTripRepository.create(first);
    await repository.localTripRepository.create(second);
    const store = indexedDb.getStoreState(repository.DB_NAME, 'trips');
    store.deleteAttempts = 0;
    store.failDeleteAt = 2;
    const beforeToken = sourceChange.getP7SourceToken();

    await expect(repository.enforceTripDataRetention({
      now: NOW,
      retentionDays: 30,
      trips: [first, second],
    })).rejects.toMatchObject({
      code: 'TRIP_RETENTION_INCOMPLETE',
      retentionOutcome: expect.objectContaining({
        status: 'pending',
        requestedTrips: 2,
        pendingTrips: 1,
      }),
    });
    expect(sourceChange.getP7SourceToken()).toBeGreaterThan(beforeToken);
    expect(await exists(repository, 'partial-delete-a')).toBe(false);

    store.failDeleteAt = -1;
    const retry = await repository.enforceTripDataRetention({
      now: NOW,
      retentionDays: 30,
      trips: [first, second],
    });
    expect(retry).toMatchObject({ enabled: true, deletedTrips: 1 });
    expect(await exists(repository, 'partial-delete-b')).toBe(false);
  });
});
