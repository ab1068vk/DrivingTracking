import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';

/**
 * DPD-043 — a completed rescore pass must not be redone on every launch.
 *
 * On the A54 at 5,000 trips every cold start re-ran the `rescore_windows`
 * repository unit from the oldest trip: ~11 minutes decrypting the whole
 * history with the renderer near 2 GB. The pass wrote `status: 'complete'` but
 * nothing read it, and a finished pass left `cursor: null` — "start at the
 * beginning" to the next launch.
 *
 * A "launch" here is a fresh module graph over the same persisted fake
 * IndexedDB (`vi.resetModules()`), so in-memory state cannot carry a result
 * from one launch to the next — only what the pass made durable can.
 */

const settingsValue = () => JSON.stringify({
  settings_defaults_version: 11,
  data_retention_days: 0,
  raw_gps_retention_days: 0,
  motion_sample_retention_days: 0,
  privacy_zones: [],
});

let fake;

beforeEach(() => {
  fake = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fake);
  const values = new Map([['drivesense_settings', settingsValue()]]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** A cold launch: new module instances, same durable store. */
const launch = async () => {
  vi.resetModules();
  return import('@/lib/localTripRepository');
};

const stores = (repo) => {
  const database = fake.databases.get(repo.DB_NAME);
  return { trips: database.stores.get('trips'), meta: database.stores.get('trip_meta') };
};

const meta = (repo, key) => stores(repo).meta.records.get(key)?.value;

const resetReads = (repo) => {
  const { trips } = stores(repo);
  trips.cursorSteps = 0;
  trips.getCount = 0;
};

const BASE = Date.UTC(2026, 0, 1);

/** Real trips through the production create path; they are written stale. */
const seed = async (repo, from, count, { points = 2 } = {}) => {
  for (let index = from; index < from + count; index += 1) {
    const start = BASE + (index * 60_000);
    await repo.localTripRepository.create({
      id: `trip-${String(index).padStart(5, '0')}`,
      status: 'completed',
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 30_000).toISOString(),
      distance_km: 1,
      route_points: Array.from({ length: points }, (_, p) => ({
        lat: 43.6 + (index / 10_000) + (p / 1_000),
        lng: -79.4 - (p / 1_000),
        timestamp: start + (p * 15_000),
      })),
    });
  }
};

/** Run coordinator-sized turns until the unit reports nothing left. */
const drain = async (repo) => {
  const turns = [];
  for (let turn = 0; turn < 200; turn += 1) {
    const result = await repo.stepRescoreMaintenanceWindow();
    turns.push(result);
    if (!result.hasMore) break;
  }
  expect(turns.at(-1).hasMore).toBe(false);
  return {
    turns,
    examined: turns.reduce((sum, turn) => sum + turn.examined, 0),
    rescored: turns.reduce((sum, turn) => sum + turn.rescored, 0),
    modes: [...new Set(turns.map((turn) => turn.mode))],
  };
};

const N = 20;

/** Seed N stale trips and let one pass complete under the current key. */
const completedHistory = async () => {
  const repo = await launch();
  await seed(repo, 0, N);
  const first = await drain(repo);
  expect(first.modes).toContain('full_pass');
  expect(meta(repo, 'maintenance_state')).toMatchObject({
    status: 'complete',
    completedKey: repo.rescoreMaintenanceKey(),
  });
  return repo;
};

describe('DPD-043: device reproduction (pre-existing API only)', () => {
  it('a relaunch after a finished pass does not walk the trips again', async () => {
    let repo = await launch();
    await seed(repo, 0, N);
    for (let turn = 0; turn < 50; turn += 1) {
      if (!(await repo.stepRescoreMaintenanceWindow()).hasMore) break;
    }
    expect(meta(repo, 'maintenance_state').status).toBe('complete');

    repo = await launch();
    resetReads(repo);
    const next = await repo.stepRescoreMaintenanceWindow();
    // Before DPD-043 this read the oldest window again: examined 8, 8 cursor steps.
    expect(stores(repo).trips.cursorSteps).toBe(0);
    expect(next.examined).toBe(0);
    expect(next.hasMore).toBe(false);
  });
});

describe('DPD-043: completed history is not rescanned', () => {
  it('a cold launch after a completed pass reads no trip at all', async () => {
    await completedHistory();
    const repo = await launch();
    resetReads(repo);
    const result = await repo.stepRescoreMaintenanceWindow();
    expect(result).toMatchObject({ examined: 0, rescored: 0, hasMore: false, mode: 'idle' });
    expect(stores(repo).trips.cursorSteps).toBe(0);
    expect(stores(repo).trips.getCount).toBe(0);
  });

  it('stays idle across repeated launches (idempotent)', async () => {
    await completedHistory();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repo = await launch();
      resetReads(repo);
      const { examined, modes } = await drain(repo);
      expect(examined).toBe(0);
      expect(modes).toEqual(['idle']);
      expect(stores(repo).trips.cursorSteps).toBe(0);
    }
  });

  it('never walks more than one window per turn', async () => {
    const repo = await launch();
    await seed(repo, 0, N);
    const { turns } = await drain(repo);
    turns.forEach((turn) => expect(turn.examined).toBeLessThanOrEqual(repo.RESCORE_DEBT_IDS_PER_TURN));
    expect(repo.RESCORE_DEBT_IDS_PER_TURN).toBeLessThanOrEqual(repo.REPOSITORY_MAINTENANCE_WINDOW);
  });
});

describe('DPD-043: an interrupted pass resumes', () => {
  it('continues from its committed cursor after a restart instead of from the oldest trip', async () => {
    let repo = await launch();
    await seed(repo, 0, N);
    const firstTurn = await repo.stepRescoreMaintenanceWindow();
    expect(firstTurn).toMatchObject({ mode: 'full_pass', hasMore: true });
    const interrupted = meta(repo, 'maintenance_state');
    expect(interrupted.status).toBe('running');
    expect(interrupted.cursor).not.toBeNull();

    repo = await launch();
    const rest = await drain(repo);
    // Every record is examined exactly once across the interruption.
    expect(firstTurn.examined + rest.examined).toBe(N);
    expect(meta(repo, 'maintenance_state').status).toBe('complete');
  });
});

describe('DPD-043: new history is still handled', () => {
  it('drains trips written stale after completion by id, without walking the history', async () => {
    let repo = await completedHistory();
    await seed(repo, N, 3);
    expect(Object.keys(meta(repo, 'rescore_maintenance_debt').entries)).toHaveLength(3);

    repo = await launch();
    resetReads(repo);
    const { examined, rescored, modes } = await drain(repo);
    expect(modes).toContain('debt');
    expect(modes).not.toContain('full_pass');
    expect(examined).toBe(3);
    expect(rescored).toBe(3);
    expect(stores(repo).trips.cursorSteps).toBe(0);
    expect(meta(repo, 'rescore_maintenance_debt').entries).toEqual({});
    expect(meta(repo, 'maintenance_state').completedKey).toBe(repo.rescoreMaintenanceKey());

    repo = await launch();
    expect(await repo.stepRescoreMaintenanceWindow()).toMatchObject({ examined: 0, mode: 'idle' });
  });

  it('a trip a rescore cannot make current does not re-enter the debt (no livelock)', async () => {
    let repo = await completedHistory();
    await seed(repo, N, 1, { points: 1 });
    repo = await launch();
    const { turns } = await drain(repo);
    expect(turns.length).toBeLessThanOrEqual(3);
    expect(meta(repo, 'rescore_maintenance_debt').entries).toEqual({});
    expect(await repo.stepRescoreMaintenanceWindow()).toMatchObject({ examined: 0, mode: 'idle' });
  });

  it('a write of a current trip records no debt', async () => {
    const repo = await completedHistory();
    const start = BASE + (900 * 60_000);
    await repo.localTripRepository.create({
      id: 'trip-current',
      status: 'completed',
      start_time: new Date(start).toISOString(),
      end_time: new Date(start + 600_000).toISOString(),
      distance_km: 5,
      route_points: [
        { lat: 43.6, lng: -79.4, timestamp: start },
        { lat: 43.62, lng: -79.42, timestamp: start + 600_000 },
      ],
      // Every field the predicate checks is present and current.
      schema_version: repo.TRIP_SCHEMA_VERSION,
      needs_rescore: false,
      defensive_driving_score: 80,
      brake_onset_sequence_count: 0,
      heading_deviation_available: true,
      heading_drift_beta_available: true,
      braking_efficiency_grade: 'good',
      overall_compliance_score: 100,
      dominant_road_type: 'urban',
      co2_saved_kg: 0.1,
      phone_use_score: 100,
      phone_use_risk: 'none',
    });
    expect(meta(repo, 'rescore_maintenance_debt').entries).toEqual({});
  });

  it('an ordinary edit of a trip that is still stale records debt for it (Law C)', async () => {
    // Two-point trips stay stale after a rescore (no defensive score / CO2), so an
    // edit made outside the maintenance must be looked at again.
    const repo = await completedHistory();
    await repo.localTripRepository.update('trip-00003', { notes: 'edited' });
    expect(Object.keys(meta(repo, 'rescore_maintenance_debt').entries)).toEqual(['trip-00003']);
  });

  it('debt past its id cap collapses to one new full pass', async () => {
    let repo = await completedHistory();
    const { meta: metaStore } = stores(repo);
    metaStore.records.set('rescore_maintenance_debt', {
      key: 'rescore_maintenance_debt',
      value: { entries: {}, overflow: true },
    });
    repo = await launch();
    const pass = await drain(repo);
    expect(pass.modes).toContain('full_pass');
    expect(pass.examined).toBe(N);
    expect(meta(repo, 'rescore_maintenance_debt')).toMatchObject({ entries: {}, overflow: false });

    repo = await launch();
    expect(await repo.stepRescoreMaintenanceWindow()).toMatchObject({ examined: 0, mode: 'idle' });
  });

  it('records the overflow flag once the id cap is exceeded', async () => {
    const repo = await completedHistory();
    const { meta: metaStore } = stores(repo);
    const entries = Object.fromEntries(
      Array.from({ length: repo.RESCORE_DEBT_MAX_IDS }, (_, index) => [`ghost-${index}`, 'stamp'])
    );
    metaStore.records.set('rescore_maintenance_debt', {
      key: 'rescore_maintenance_debt',
      value: { entries, overflow: false },
    });
    await seed(repo, N, 1);
    expect(meta(repo, 'rescore_maintenance_debt')).toMatchObject({ entries: {}, overflow: true });
  });
});

describe('DPD-043: real invalidation still works', () => {
  it('a schema/predicate key change starts exactly one new full pass', async () => {
    let repo = await completedHistory();
    const { meta: metaStore } = stores(repo);
    const state = metaStore.records.get('maintenance_state').value;
    metaStore.records.set('maintenance_state', {
      key: 'maintenance_state',
      value: { ...state, completedKey: 'schema:26|predicate:1' },
    });
    repo = await launch();
    const pass = await drain(repo);
    expect(pass.modes).toContain('full_pass');
    expect(pass.examined).toBe(N);

    repo = await launch();
    expect(await repo.stepRescoreMaintenanceWindow()).toMatchObject({ examined: 0, mode: 'idle' });
  });

  it('a pre-DPD-043 "complete" with no key gets one upgrade pass, then stays idle', async () => {
    let repo = await completedHistory();
    stores(repo).meta.records.set('maintenance_state', {
      key: 'maintenance_state',
      value: { cursor: null, status: 'complete', updated_at: 1 },
    });
    repo = await launch();
    const pass = await drain(repo);
    expect(pass.examined).toBe(N);

    repo = await launch();
    expect(await repo.stepRescoreMaintenanceWindow()).toMatchObject({ examined: 0, mode: 'idle' });
  });

  it('a pass started under another key restarts from the oldest trip instead of resuming', async () => {
    let repo = await launch();
    await seed(repo, 0, N);
    await repo.stepRescoreMaintenanceWindow();
    const { meta: metaStore } = stores(repo);
    const state = metaStore.records.get('maintenance_state').value;
    metaStore.records.set('maintenance_state', {
      key: 'maintenance_state',
      value: { ...state, passKey: 'schema:26|predicate:1' },
    });
    repo = await launch();
    const rest = await drain(repo);
    expect(rest.examined).toBe(N);
  });

  it('losing the maintenance record (erasure/new generation) starts a fresh pass', async () => {
    let repo = await completedHistory();
    stores(repo).meta.records.delete('maintenance_state');
    repo = await launch();
    const pass = await drain(repo);
    expect(pass.examined).toBe(N);
    expect(meta(repo, 'maintenance_state').completedKey).toBe(repo.rescoreMaintenanceKey());
  });
});
