import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbMigrationRunner,
  DB_NAME,
  DB_NAME_META_KEY,
  DB_VERSION,
  localTripRepository,
  migrateIndexedDbName,
  normalizeRetiredTripEventTypes,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_VERSION,
  TRIP_SCHEMA_VERSION,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringConstants';
import { DEFAULT_THRESHOLDS, buildScoreConstantsSnapshot } from '@/lib/tripEngine';

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
      queueMicrotask(() => this.state.databaseState.activeTransaction?.oncomplete?.());
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
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.databaseState.activeTransaction = this;
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
      databaseState: this.state,
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

  deleteDatabase(name) {
    return makeIdbRequest(() => {
      this.databases.delete(name);
      return undefined;
    });
  }
}

describe('localTripRepository IndexedDB migrations', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens an empty IndexedDB and creates the trip store with required indexes', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
    });

    const database = fakeIndexedDb.databases.get('road_sage_mobile');
    const trips = database.stores.get('trips');

    expect(DB_NAME).toBe('road_sage_mobile');
    expect(database.version).toBe(DB_VERSION);
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

  it('migrates trip records when the configured IndexedDB name changes', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map([[DB_NAME_META_KEY, 'legacy_drivesense_mobile']]);
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
    };

    const legacyDb = await new Promise((resolve, reject) => {
      const request = fakeIndexedDb.open('legacy_drivesense_mobile', DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('trips', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = legacyDb.transaction('trips', 'readwrite');
    await new Promise((resolve, reject) => {
      const request = tx.objectStore('trips').put({
        id: 'legacy-trip',
        status: 'completed',
        start_time: '2026-01-01T12:00:00.000Z',
      });
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    legacyDb.close();

    await expect(migrateIndexedDbName({ currentName: DB_NAME, storage })).resolves.toBe(true);

    const migratedTrips = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips').records;
    expect(migratedTrips.get('legacy-trip')).toMatchObject({ id: 'legacy-trip' });
    expect(fakeIndexedDb.databases.has('legacy_drivesense_mobile')).toBe(false);
    expect(values.get(DB_NAME_META_KEY)).toBe(DB_NAME);
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
      scoring_version: null,
      calibration_status: 'unknown_legacy_unrescored',
      components: {},
      constants_snapshot: {},
      migrated_without_rescore: true,
      target_scoring_version: SCORING_VERSION,
    });
    expect(trip.score_provenance_change).toMatchObject({
      reason: 'legacy_tagged_without_rescore',
      previous_scoring_version: null,
      current_scoring_version: SCORING_VERSION,
    });
  });

  it('automatically re-scores recent trips when outdated provenance exceeds the threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const routePoints = [
      { lat: 43.65, lng: -79.38, speed_kmh: 40, timestamp: '2026-05-26T12:00:00.000Z' },
      { lat: 43.651, lng: -79.38, speed_kmh: 40, timestamp: '2026-05-26T12:05:00.000Z' },
    ];
    const completedTrip = (id, scoringVersion) => ({
      id,
      status: 'completed',
      start_time: '2026-05-26T12:00:00.000Z',
      end_time: '2026-05-26T12:05:00.000Z',
      route_points: routePoints,
      score_overall: 70,
      score_safety: 70,
      score_smoothness: 70,
      score_eco: 70,
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
      score_provenance: {
        scoring_version: scoringVersion,
        constants_snapshot: buildScoreConstantsSnapshot(DEFAULT_THRESHOLDS),
      },
    });

    values.set('drivesense_trips', JSON.stringify([
      completedTrip('outdated', '2.0.0'),
      completedTrip('current-1', SCORING_VERSION),
      completedTrip('current-2', SCORING_VERSION),
    ]));

    const trips = await localTripRepository.listAll();
    const rescored = trips.find((item) => item.id === 'outdated');

    expect(rescored.score_provenance.scoring_version).toBe(SCORING_VERSION);
    expect(rescored.score_provenance_change).toMatchObject({
      previous_scoring_version: '2.0.0',
      current_scoring_version: SCORING_VERSION,
      reason: 'scoring_version_changed',
    });
  });

  it('renames retired lane-change events once before listing stored trips', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    values.set('drivesense_trips', JSON.stringify([{
      id: 'legacy-heading',
      status: 'completed',
      distance_km: 10,
      driving_events: [{ type: 'lane_change', severity: 'medium', timestamp: '2026-01-01T12:00:00.000Z', value: 3 }],
      event_feedback: {
        'lane_change|2026-01-01T12:00:00.000Z|3.00': { verdict: 'accurate' },
      },
      lane_changes_count: 1,
      heading_deviation_count: 1,
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
      score_provenance: {
        scoring_version: SCORING_VERSION,
        constants_snapshot: buildScoreConstantsSnapshot(DEFAULT_THRESHOLDS),
      },
    }]));

    const [trip] = await localTripRepository.listAll();

    expect(JSON.parse(values.get(TRIP_EVENT_MIGRATION_KEY))).toBe(TRIP_EVENT_MIGRATION_VERSION);
    expect(trip.driving_events[0]).toMatchObject({
      type: 'heading_deviation_legacy',
      legacy_renamed: true,
    });
    expect(trip.event_feedback['heading_deviation_legacy|2026-01-01T12:00:00.000Z|3.00']).toMatchObject({ verdict: 'accurate' });
    expect(trip.lane_changes_count).toBeUndefined();
    expect(trip.heading_deviation_count).toBe(0);
    expect(trip.heading_deviation_legacy_count).toBe(1);
  });

  it('normalizes retired lane-change events before writing new local trips', () => {
    expect(normalizeRetiredTripEventTypes({
      id: 'new-import',
      distance_km: 5,
      driving_events: [{ type: 'lane_change' }],
    })).toMatchObject({
      driving_events: [{ type: 'heading_deviation_legacy', legacy_renamed: true }],
      heading_deviation_count: 0,
      heading_deviation_legacy_count: 1,
    });
  });
});
