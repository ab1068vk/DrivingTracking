import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DB_NAME,
  NATIVE_COMPLETED_IMPORT_MAX_ITEMS,
  REPOSITORY_MAINTENANCE_MAX_EXAMINED,
  REPOSITORY_MAINTENANCE_WINDOW,
  localTripRepository,
  runProjectionMaintenance,
  stepProjectionMaintenance,
} from '@/lib/localTripRepository';
import {
  BACKFILL_MAX_EXAMINED,
  BACKFILL_ROWS_PER_TURN,
  CLEANUP_MAX_EXAMINED,
  CLEANUP_ROWS_PER_TURN,
  PROJECTION_REPAIR_READS_PER_BACKFILL_ROW,
  PROJECTION_REPAIR_READS_PER_MISMATCH,
  PROJECTION_SUBPASS_MAX_EXAMINED,
  VERIFY_MAX_EXAMINED,
  VERIFY_POINT_READS_PER_TURN,
  VERIFY_ROWS_PER_TURN,
} from '@/lib/tripProjectionMaintenance';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * P4-C-F09 — the repository ceiling must describe every independently read row.
 *
 * A verification slice reads a 256-row source window and a 256-row projection
 * window, and then repairs up to eight mismatches. Repair does not reuse the row
 * it was handed: `repairVerifiedMismatches` re-reads it to classify it,
 * `repairProjectionsForRows` re-reads it to decrypt the trip, and
 * `commitProjectionRecord` re-reads it inside the guard that makes the write
 * safe. Those reads were absent from both the reported `examined` and the
 * declared budget, so a maximum-mismatch turn read 536 rows while claiming 512.
 *
 * This suite drives the production verification slice against a real fixture and
 * asserts that what the fake store actually served equals what the turn
 * reported, at the true maximum rather than on a small sample.
 */

const settingsValue = () => JSON.stringify({
  settings_defaults_version: 11,
  data_retention_days: 0,
  raw_gps_retention_days: 0,
  motion_sample_retention_days: 0,
  privacy_zones: [],
});

const installEnvironment = () => {
  const fake = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fake);
  const values = new Map([['drivesense_settings', settingsValue()]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
  return fake;
};

const TRIP_COUNT = VERIFY_ROWS_PER_TURN + 16;

/** Real trips through the production create path, so repair can decrypt them. */
const seedTrips = async (count) => {
  const base = Date.UTC(2026, 0, 1);
  for (let index = 0; index < count; index += 1) {
    await localTripRepository.create({
      id: `trip-${String(index).padStart(5, '0')}`,
      status: 'completed',
      start_time: new Date(base + (index * 60_000)).toISOString(),
      end_time: new Date(base + (index * 60_000) + 30_000).toISOString(),
      distance_km: 1,
      route_points: [{ lat: 43.6 + (index / 10_000), lng: -79.4 }],
    });
  }
};

const storesOf = (fake) => {
  const database = fake.databases.get(DB_NAME);
  return {
    trips: database.stores.get('trips'),
    projections: database.stores.get('trip_projections'),
    meta: database.stores.get('trip_meta'),
  };
};

const resetReadCounters = (stores) => {
  for (const store of [stores.trips, stores.projections]) {
    store.getCount = 0;
    store.cursorSteps = 0;
  }
};

/**
 * Every row the fake store actually served to this turn: cursor rows from the
 * two index windows plus every point read, including the repair path's.
 */
const rowsActuallyRead = (stores) => (
  (stores.trips.cursorSteps || 0) + (stores.projections.cursorSteps || 0)
  + (stores.trips.getCount || 0) + (stores.projections.getCount || 0)
);

/** Force the next coordinated slice onto the verification subpass. */
const armVerifyPhase = (stores) => {
  stores.meta.records.set('projection_maintenance_phase', {
    key: 'projection_maintenance_phase',
    value: { phase: 'verify', updated_at: Date.now() },
  });
  // A fresh verification pass, so the whole window is in front of the cursor.
  stores.meta.records.delete('projection_verify');
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('P4-C-F09: the declared ceilings are derived from the real read counts', () => {
  it('derives the verification ceiling from its windows and its repair re-reads', () => {
    expect(VERIFY_MAX_EXAMINED).toBe(
      (VERIFY_ROWS_PER_TURN * 2) + (VERIFY_POINT_READS_PER_TURN * PROJECTION_REPAIR_READS_PER_MISMATCH)
    );
    expect(BACKFILL_MAX_EXAMINED).toBe(
      (BACKFILL_ROWS_PER_TURN * 2) + (BACKFILL_ROWS_PER_TURN * PROJECTION_REPAIR_READS_PER_BACKFILL_ROW)
    );
    expect(CLEANUP_MAX_EXAMINED).toBe(CLEANUP_ROWS_PER_TURN + 1);
    // Only one subpass runs per coordinated turn, so the slice ceiling is their
    // maximum - and it is the verification slice.
    expect(PROJECTION_SUBPASS_MAX_EXAMINED).toBe(
      Math.max(BACKFILL_MAX_EXAMINED, VERIFY_MAX_EXAMINED, CLEANUP_MAX_EXAMINED)
    );
    expect(PROJECTION_SUBPASS_MAX_EXAMINED).toBe(536);
    expect(REPOSITORY_MAINTENANCE_MAX_EXAMINED).toBe(Math.max(
      REPOSITORY_MAINTENANCE_WINDOW,
      NATIVE_COMPLETED_IMPORT_MAX_ITEMS,
      PROJECTION_SUBPASS_MAX_EXAMINED,
    ));
    expect(REPOSITORY_MAINTENANCE_MAX_EXAMINED).toBe(536);
  });
});

describe('P4-C-F09: a maximum-mismatch verification turn reports every row it read', () => {
  it('counts the three independent re-reads each live mismatch costs', async () => {
    const fake = installEnvironment();
    await seedTrips(TRIP_COUNT);
    // Converge the projection store through the explicit whole-pass driver so
    // the fixture starts consistent.
    await runProjectionMaintenance();
    const stores = storesOf(fake);
    expect(stores.projections.records.size).toBe(TRIP_COUNT);

    // Exactly `VERIFY_POINT_READS_PER_TURN` live mismatches: the source rows are
    // there, their projections are not.
    const missing = [...stores.projections.records.keys()]
      .sort()
      .slice(0, VERIFY_POINT_READS_PER_TURN);
    for (const id of missing) stores.projections.records.delete(id);

    armVerifyPhase(stores);
    resetReadCounters(stores);
    const turn = await stepProjectionMaintenance();

    expect(turn.phase).toBe('verify');
    // The turn reported exactly what the store served it.
    expect(turn.examined).toBe(rowsActuallyRead(stores));
    // And that is the true maximum: two full windows plus three re-reads per
    // mismatch. Load-bearing: the pre-fix accounting reported 512 here.
    expect(turn.examined).toBe(
      (VERIFY_ROWS_PER_TURN * 2) + (VERIFY_POINT_READS_PER_TURN * PROJECTION_REPAIR_READS_PER_MISMATCH)
    );
    expect(turn.examined).toBe(VERIFY_MAX_EXAMINED);
    expect(turn.examined).toBeLessThanOrEqual(REPOSITORY_MAINTENANCE_MAX_EXAMINED);
    // The mismatches were really repaired, not merely counted.
    for (const id of missing) expect(stores.projections.records.has(id)).toBe(true);
  }, 120_000);

  it('counts the two independent re-reads each orphan mismatch costs', async () => {
    // A pure orphan is a projection the source side no longer reaches at all:
    // `compareMergeRows` reports `orphan_projection` against a null source, so
    // the repair classifies it and deletes it under the transaction guard -
    // two independent reads, where a live repair costs three.
    const SOURCE_ROWS = VERIFY_ROWS_PER_TURN - VERIFY_POINT_READS_PER_TURN;
    const fake = installEnvironment();
    await seedTrips(SOURCE_ROWS);
    await runProjectionMaintenance();
    const stores = storesOf(fake);
    expect(stores.projections.records.size).toBe(SOURCE_ROWS);

    // Orphan projections ordered *after* every trip, so the source window is
    // exhausted before the verifier reaches them.
    const template = [...stores.projections.records.values()][0];
    const orphanIds = [];
    for (let index = 0; index < VERIFY_POINT_READS_PER_TURN; index += 1) {
      const id = `orphan-${String(index).padStart(5, '0')}`;
      orphanIds.push(id);
      stores.projections.records.set(id, {
        ...structuredClone(template),
        id,
        start_time: new Date(Date.UTC(2030, 0, 1) + index).toISOString(),
      });
    }

    armVerifyPhase(stores);
    resetReadCounters(stores);
    const turn = await stepProjectionMaintenance();

    expect(turn.examined).toBe(rowsActuallyRead(stores));
    // The two windows this turn really had (the source side is short), plus two
    // re-reads per orphan.
    expect(turn.examined).toBe(
      SOURCE_ROWS + (SOURCE_ROWS + VERIFY_POINT_READS_PER_TURN)
      + (VERIFY_POINT_READS_PER_TURN * 2)
    );
    expect(turn.examined).toBeLessThan(VERIFY_MAX_EXAMINED);
    expect(turn.examined).toBeLessThanOrEqual(REPOSITORY_MAINTENANCE_MAX_EXAMINED);
    // The orphans were really removed under the transaction guard.
    for (const id of orphanIds) expect(stores.projections.records.has(id)).toBe(false);
  }, 120_000);

  it('a clean verification turn reports its two windows and nothing more', async () => {
    const fake = installEnvironment();
    await seedTrips(TRIP_COUNT);
    await runProjectionMaintenance();
    const stores = storesOf(fake);

    armVerifyPhase(stores);
    resetReadCounters(stores);
    const turn = await stepProjectionMaintenance();

    expect(turn.examined).toBe(rowsActuallyRead(stores));
    expect(turn.examined).toBe(VERIFY_ROWS_PER_TURN * 2);
    // A turn that changed nothing still consumed the rows it read.
    expect(turn.verified).toBeGreaterThan(0);
  }, 120_000);
});
