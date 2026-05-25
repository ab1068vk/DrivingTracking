import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIndexedDbMigrationRunner, localTripRepository, TRIP_SCHEMA_VERSION } from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/tripEngine';

const makeDomStringList = (items) => ({
  contains: (item) => items.has(item),
});

const makeIdbRequest = (run) => {
  const request = {
    error: null,
    result: undefined,
    onerror: null,
    onsuccess: null,
  };

  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
    }
  });

  return request;
};

class FakeObjectStore {
  constructor(state) {
    this.state = state;
    this.keyPath = state.keyPath;
  }

  get indexNames() {
    return makeDomStringList(this.state.indexes);
  }

  createIndex(name, keyPath) {
    if (this.state.indexes.has(name)) {
      throw new Error(`Index already exists: ${name}`);
    }
    this.state.indexes.add(name);
    this.state.indexKeyPaths.set(name, keyPath);
    return { name, keyPath };
  }

  put(value) {
    return makeIdbRequest(() => {
      this.state.records.set(value[this.keyPath], value);
      return value[this.keyPath];
    });
  }

  getAll() {
    return makeIdbRequest(() => [...this.state.records.values()]);
  }

  delete(id) {
    return makeIdbRequest(() => {
      this.state.records.delete(id);
      return undefined;
    });
  }
}

class FakeTransaction {
  constructor(databaseState) {
    this.databaseState = databaseState;
    this.error = null;
  }

  objectStore(name) {
    const store = this.databaseState.stores.get(name);
    if (!store) throw new Error(`Missing object store: ${name}`);
    return new FakeObjectStore(store);
  }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
  }

  get objectStoreNames() {
    return makeDomStringList(new Set(this.state.stores.keys()));
  }

  createObjectStore(name, options) {
    if (this.state.stores.has(name)) {
      throw new Error(`Object store already exists: ${name}`);
    }
    const store = {
      keyPath: options.keyPath,
      indexes: new Set(),
      indexKeyPaths: new Map(),
      records: new Map(),
    };
    this.state.stores.set(name, store);
    return new FakeObjectStore(store);
  }

  transaction(name) {
    if (!this.state.stores.has(name)) {
      throw new Error(`Missing object store: ${name}`);
    }
    return new FakeTransaction(this.state);
  }

  close() {}
}

class FakeIndexedDb {
  constructor() {
    this.databases = new Map();
  }

  open(name, version) {
    const request = {
      error: null,
      result: undefined,
      transaction: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
    };

    queueMicrotask(() => {
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;

      if (oldVersion > version) {
        request.error = new Error('VersionError');
        request.onerror?.({ target: request });
        return;
      }

      if (!state) {
        state = { version, stores: new Map() };
        this.databases.set(name, state);
      }

      request.result = new FakeDatabase(state);

      if (oldVersion < version) {
        state.version = version;
        request.transaction = new FakeTransaction(state);
        request.onupgradeneeded?.({
          oldVersion,
          newVersion: version,
          target: request,
        });
      }

      request.onsuccess?.({ target: request });
    });

    return request;
  }
}

describe('localTripRepository IndexedDB migrations', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an empty IndexedDB and creates the trip store with required indexes', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
    });

    const database = fakeIndexedDb.databases.get('drivesense_mobile');
    const trips = database.stores.get('trips');

    expect(database.version).toBe(1);
    expect(trips.keyPath).toBe('id');
    expect(trips.indexes.has('start_time')).toBe(true);
    expect(trips.indexKeyPaths.get('start_time')).toBe('start_time');
    expect(trips.indexes.has('status')).toBe(true);
    expect(trips.indexKeyPaths.get('status')).toBe('status');
  });

  it('runs only migrations newer than the existing IndexedDB version', () => {
    const calls = [];
    const runner = createIndexedDbMigrationRunner([
      {
        version: 1,
        migrate: () => calls.push('v1'),
      },
      {
        version: 2,
        migrate: () => calls.push('v2'),
      },
    ]);

    runner.migrate({
      db: {},
      oldVersion: 1,
      transaction: {},
    });

    expect(runner.version).toBe(2);
    expect(calls).toEqual(['v2']);
  });

  it('tags legacy completed trip provenance without silently recalculating scores on launch', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    values.set('drivesense_trips', JSON.stringify([{
      id: 'legacy-null-score',
      status: 'completed',
      start_time: '2026-01-01T17:00:00.000Z',
      end_time: '2026-01-01T17:05:00.000Z',
      route_points: [],
      score_overall: null,
      score_safety: null,
      score_smoothness: null,
      score_eco: null,
      defensive_driving_score: 80,
      brake_onset_sequence_count: 0,
      heading_deviation_available: true,
      heading_drift_beta_available: true,
      braking_efficiency_grade: 'unknown',
      overall_compliance_score: 100,
      dominant_road_type: 'urban',
      co2_saved_kg: 0,
      phone_use_score: 100,
      phone_use_risk: 'none',
      schema_version: TRIP_SCHEMA_VERSION,
    }]));

    const [trip] = await localTripRepository.listAll();

    expect(trip.score_overall).toBeNull();
    expect(trip.score_provenance).toMatchObject({
      scoring_version: SCORING_VERSION,
      migrated_without_rescore: true,
    });
    expect(trip.score_provenance_change).toMatchObject({
      reason: 'legacy_tagged_without_rescore',
      current_scoring_version: SCORING_VERSION,
    });
  });
});
