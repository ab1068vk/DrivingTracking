import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DB_NAME,
  REPOSITORY_MAINTENANCE_WINDOW,
  TRIP_KEY_ROTATION_WINDOW,
  localTripRepository,
  stepRawGpsRetention,
  stepTripDataRetention,
  stepTripEncryptionKeyRotationBatch,
  stepTripRepositoryMaintenance,
} from '@/lib/localTripRepository';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * P4-C-F04 / P4-C-F05 — the repository and browser-KEK lifecycle turns are
 * bounded by the records they touch, not merely *named* "one unit".
 *
 * The law under test is a growth law: as retained history grows, the number of
 * coordinator turns grows and the per-turn cost does not. It is asserted at the
 * storage seam, so a regression that restores `getAllTrips()` / `getAll()`
 * inside one lifecycle turn fails on `getAllCount`, and one that widens the
 * window fails on the per-turn row count.
 *
 * History is seeded straight into the store, deliberately without allocating
 * decryptable payloads: what is measured is how many records a turn reads and
 * writes, which is exactly the property that used to grow with N.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const settingsValue = (overrides = {}) => JSON.stringify({
  settings_defaults_version: 11,
  data_retention_days: 0,
  raw_gps_retention_days: 0,
  motion_sample_retention_days: 0,
  privacy_zones: [],
  ...overrides,
});

const installEnvironment = (settings = {}) => {
  const fakeIndexedDb = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fakeIndexedDb);
  const values = new Map([['drivesense_settings', settingsValue(settings)]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  return fakeIndexedDb;
};

/**
 * Create the schema through the repository's own migration path, then seed
 * synthetic history directly - the same pattern the existing deep-cursor
 * regressions use.
 */
const seedHistory = async (fake, count, { ageDays = 400 } = {}) => {
  await localTripRepository.create({
    id: 'anchor',
    status: 'completed',
    start_time: '2020-01-01T00:00:00.000Z',
    route_points: [],
    route_data_expired_at: '2020-02-01T00:00:00.000Z',
    motion_samples_expired_at: '2020-02-01T00:00:00.000Z',
  });
  const database = fake.databases.get(DB_NAME);
  const stores = {
    trips: database.stores.get('trips'),
    summaries: database.stores.get('trip_summaries'),
    projections: database.stores.get('trip_projections'),
  };
  const base = Date.now() - (ageDays * DAY_MS);
  for (let index = 0; index < count; index += 1) {
    const id = `seed-${String(index).padStart(5, '0')}`;
    const start_time = new Date(base + index).toISOString();
    // Tombstoned rows carry no payload, so a bounded turn's row accounting can
    // be measured without any decrypt work at all.
    const record = {
      id,
      start_time,
      status: 'secure-delete-pending',
      _secure_delete_tombstone: true,
      _secure_delete_at: Date.now(),
    };
    stores.trips.records.set(id, record);
    stores.projections?.records.set(id, { ...record });
  }
  return stores;
};

const resetCounters = (stores) => {
  for (const store of Object.values(stores)) {
    if (!store) continue;
    store.getAllCount = 0;
    store.putAttempts = 0;
  }
};

const totalGetAll = (stores) => Object.values(stores)
  .reduce((sum, store) => sum + (store?.getAllCount || 0), 0);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('P4-C-F04: repository maintenance turns are bounded by records, not by history', () => {
  it.each([100, 5_000])('walks a fixed window and never materializes the store at N=%s', async (total) => {
    const fake = installEnvironment({ data_retention_days: 1 });
    const stores = await seedHistory(fake, total);

    const perTurn = [];
    let turns = 0;
    for (; turns < 400; turns += 1) {
      resetCounters(stores);
      const outcome = await stepTripDataRetention();
      // The old pass called `getAllTrips()` and deleted every expired trip.
      expect(totalGetAll(stores)).toBe(0);
      expect(outcome.processed).toBeLessThanOrEqual(REPOSITORY_MAINTENANCE_WINDOW);
      perTurn.push(outcome.processed);
      if (!outcome.hasMore) break;
    }

    // A fixed slice per turn, and more turns as history grows.
    expect(Math.max(...perTurn)).toBe(REPOSITORY_MAINTENANCE_WINDOW);
    expect(turns).toBeGreaterThanOrEqual(Math.floor(total / REPOSITORY_MAINTENANCE_WINDOW));
    expect(perTurn.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(total);
  }, 300_000);

  it.each([100, 5_000])('bounds the raw-GPS sweep to one window of trips at N=%s', async (total) => {
    const fake = installEnvironment({ raw_gps_retention_days: 1, motion_sample_retention_days: 1 });
    const stores = await seedHistory(fake, total);

    let turns = 0;
    let outcome = { hasMore: true };
    for (; turns < 400 && outcome.hasMore; turns += 1) {
      resetCounters(stores);
      outcome = await stepRawGpsRetention({ force: true });
      // Never a whole-history walk of every route and motion array.
      expect(totalGetAll(stores)).toBe(0);
      expect(outcome.processed).toBeLessThanOrEqual(REPOSITORY_MAINTENANCE_WINDOW);
    }

    expect(turns).toBeGreaterThanOrEqual(Math.floor(total / REPOSITORY_MAINTENANCE_WINDOW));
  }, 300_000);

  it('runs one subpass window per coordinator turn rather than an internal driver', async () => {
    const fake = installEnvironment({ data_retention_days: 1 });
    const stores = await seedHistory(fake, 200);

    let unitIndex = 0;
    let sawRepeatedUnit = false;
    for (let turn = 0; turn < 60; turn += 1) {
      resetCounters(stores);
      const outcome = await stepTripRepositoryMaintenance({ unitIndex });
      expect(totalGetAll(stores)).toBe(0);
      // A subpass with records left keeps the sequence on the same unit, so a
      // large history produces more turns instead of one larger turn.
      if (outcome.nextUnitIndex === outcome.unitIndex) sawRepeatedUnit = true;
      unitIndex = outcome.nextUnitIndex;
      if (!outcome.hasMore) break;
    }

    expect(sawRepeatedUnit).toBe(true);
  }, 300_000);

  it('delegates raw-GPS retention to the bounded P5 native owner under native authority', async () => {
    installEnvironment({ raw_gps_retention_days: 1 });
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    vi.doMock('@/lib/nativePlatform', () => ({ isAndroid: () => true, isNativePlatform: () => true }));
    vi.resetModules();
    const repository = await import('@/lib/localTripRepository');

    const outcome = await repository.stepRawGpsRetention({ force: true });

    // The local copy remains disposable there. P5 replaces the historical
    // ownerless stub with its bounded native canonical retention job.
    expect(outcome).toMatchObject({
      enabled: false,
      delegated: true,
      owner: 'p5NativeRawGpsRetention',
    });
    expect(outcome.processed).toBe(0);
    expect(outcome.hasMore).toBe(false);
    vi.doUnmock('@/lib/nativePlatform');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('P4-C-F05: browser KEK rotation is a fixed ciphertext batch per turn', () => {
  it.each([100, 5_000])('never materializes the store and pages the sweep at N=%s', async (total) => {
    const fake = installEnvironment();
    const stores = await seedHistory(fake, total);

    let turns = 0;
    let batch = { hasMore: true };
    for (; turns < 800 && batch.hasMore; turns += 1) {
      resetCounters(stores);
      batch = await stepTripEncryptionKeyRotationBatch(2);
      // The old browser rotation called `getAll()` on all three stores.
      expect(totalGetAll(stores)).toBe(0);
      expect(batch.processed).toBeLessThanOrEqual(TRIP_KEY_ROTATION_WINDOW);
    }

    expect(batch.hasMore).toBe(false);
    // More history means more bounded batches, not a bigger batch.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(total / TRIP_KEY_ROTATION_WINDOW));
  }, 300_000);

  it('resumes the same target version from domain state after a renderer restart', async () => {
    const fake = installEnvironment();
    await seedHistory(fake, 120);

    const first = await stepTripEncryptionKeyRotationBatch(3);
    expect(first.hasMore).toBe(true);
    expect(first.processed).toBe(TRIP_KEY_ROTATION_WINDOW);

    // There is no in-memory cursor to lose: the sweep position is a `trip_meta`
    // record, so the next call - from any renderer - continues the same target.
    const second = await stepTripEncryptionKeyRotationBatch(3);
    expect(second.hasMore).toBe(true);

    let guard = 0;
    let batch = second;
    while (batch.hasMore && guard < 800) {
      batch = await stepTripEncryptionKeyRotationBatch(3);
      guard += 1;
    }
    expect(batch.hasMore).toBe(false);
    // Windows, not one pass: 120 seeded rows over the source and projection
    // phases cannot be covered by a single batch.
    expect(guard).toBeGreaterThan(120 / TRIP_KEY_ROTATION_WINDOW);

    // A different target version starts its own sweep rather than inheriting
    // the finished one's position.
    const restarted = await stepTripEncryptionKeyRotationBatch(4);
    expect(restarted.hasMore).toBe(true);
    expect(restarted.processed).toBeLessThanOrEqual(TRIP_KEY_ROTATION_WINDOW);
  }, 300_000);
});
