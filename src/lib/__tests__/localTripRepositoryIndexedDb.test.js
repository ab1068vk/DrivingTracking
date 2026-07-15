import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIndexedDbMigrationRunner,
  DB_NAME,
  DB_NAME_META_KEY,
  DB_VERSION,
  enforceTripDataRetention,
  enforceRawGpsRetention,
  expireTripRouteData,
  localTripRepository,
  inspectStoredTripKeyVersions,
  migrateIndexedDbName,
  migrateLegacyTripStorageToEncrypted,
  normalizeRetiredTripEventTypes,
  preserveNativePrivacyAggregateStats,
  preserveResolvedSpeedLimitReview,
  rotateTripEncryptionKey,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_VERSION,
  TRIP_SCHEMA_VERSION,
  verifyTripsPersistedForNativeAcknowledge,
} from '@/lib/localTripRepository';
import { SCORING_VERSION } from '@/lib/scoringConstants';
import { DEFAULT_THRESHOLDS, buildScoreConstantsSnapshot } from '@/lib/tripEngine';
import { setEncryptedJson } from '@/lib/securePayloadCrypto';
import {
  createPrivacyCellHashes,
  PRIVACY_ZONES_SECURE_KEY,
  savePrivacyZonesToStorage,
} from '@/lib/privacyZones';

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
      this.state.putHistory.push(value);
      this.state.records.set(value[this.keyPath], value);
      queueMicrotask(() => this.state.databaseState.activeTransaction?.oncomplete?.());
      return value[this.keyPath];
    });
  }

  get(id) {
    return makeIdbRequest(() => this.state.records.get(id));
  }

  getAll() {
    return makeIdbRequest(() => {
      this.state.getAllCount += 1;
      return [...this.state.records.values()];
    });
  }

  count() {
    return makeIdbRequest(() => this.state.records.size);
  }

  delete(id) {
    return makeIdbRequest(() => {
      this.state.records.delete(id);
      queueMicrotask(() => this.state.databaseState.activeTransaction?.oncomplete?.());
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
      putHistory: [],
      getAllCount: 0,
      databaseState: this.state,
    };
    this.state.stores.set(name, store);
    return new FakeObjectStore(store);
  }

  transaction(name) {
    const names = Array.isArray(name) ? name : [name];
    names.forEach((storeName) => {
      if (!this.state.stores.has(storeName)) throw new Error(`Missing object store: ${storeName}`);
    });
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

  it('preserves native pre-redaction distance when privacy gaps shorten the visible route', () => {
    const reconciled = preserveNativePrivacyAggregateStats({
      start_source: 'native_auto',
      distance_km: 4.5,
      avg_speed_kmh: 32.1,
      duration_seconds: 506,
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-06-14T16:00:00.000Z' },
        {
          lat: null,
          lng: null,
          timestamp: '2026-06-14T16:08:00.000Z',
          masked_for_privacy: true,
          privacy_gap: true,
        },
      ],
    }, {
      distance_km: 3.8,
      estimated_private_distance_km: 0,
      avg_speed_kmh: 27,
      duration_seconds: 506,
    });

    expect(reconciled).toMatchObject({
      distance_km: 4.5,
      estimated_private_distance_km: 0.7,
      avg_speed_kmh: 32.1,
      duration_seconds: 506,
      distance_provenance: 'native_pre_privacy_redaction',
    });
  });

  it('does not restore a smaller native undercount over a corrected private-route distance', () => {
    const reconciled = preserveNativePrivacyAggregateStats({
      start_source: 'native_auto',
      distance_km: 54.177,
      avg_speed_kmh: 56.1,
      duration_seconds: 3479,
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2026-07-12T00:38:55.808Z' },
        { masked_for_privacy: true, privacy_gap: true, timestamp: '2026-07-12T00:39:00.000Z' },
      ],
    }, {
      distance_km: 67.55,
      estimated_private_distance_km: 0.4,
      avg_speed_kmh: 69.9,
      duration_seconds: 3479,
    });

    expect(reconciled).toMatchObject({
      distance_km: 67.55,
      avg_speed_kmh: 69.9,
      duration_seconds: 3479,
      distance_provenance: 'route_recalculated_above_native_aggregate',
      native_distance_km_original: 54.177,
    });
  });

  it('keeps a completed speed review resolved when the native trip is imported again', () => {
    const reimported = preserveResolvedSpeedLimitReview({
      id: 'native-trip-reviewed',
      speed_limit_review_required: true,
      speed_limit_review_reason: 'Background tracking cannot confirm posted signs while driving.',
      speed_limit_context: {
        status: 'deferred_review',
        review_required: true,
      },
    }, {
      id: 'native-trip-reviewed',
      speed_limit_review_required: false,
      speed_limit_review_resolved_at: '2026-07-14T12:00:00.000Z',
    });

    expect(reimported).toMatchObject({
      speed_limit_review_required: false,
      speed_limit_review_resolved_at: '2026-07-14T12:00:00.000Z',
      speed_limit_review_reason: null,
      speed_limit_context: {
        review_required: false,
        review_resolved_at: '2026-07-14T12:00:00.000Z',
      },
    });
  });

  it('keeps genuinely unresolved native speed reviews required', () => {
    const reimported = preserveResolvedSpeedLimitReview({
      id: 'native-trip-unreviewed',
      speed_limit_review_required: true,
    }, {
      id: 'native-trip-unreviewed',
      speed_limit_review_required: true,
    });

    expect(reimported.speed_limit_review_required).toBe(true);
  });

  it('expires route coordinates while preserving trip summaries', () => {
    const expired = expireTripRouteData({
      id: 'old-trip',
      status: 'completed',
      score_overall: 88,
      distance_km: 12.4,
      duration_seconds: 1800,
      start_address: 'Private start',
      end_address: 'Private end',
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 40 },
        { latitude: 43.66, longitude: -79.39, speed_kmh: 45 },
      ],
      driving_events: [{ type: 'harsh_brake', lat: 43.65, lng: -79.38, value: -4.2 }],
      native_tracking_timeline: [{ type: 'location', latitude: 43.65, longitude: -79.38 }],
      needs_rescore: true,
    }, 90, Date.parse('2026-06-13T12:00:00.000Z'));

    expect(expired).toMatchObject({
      score_overall: 88,
      distance_km: 12.4,
      duration_seconds: 1800,
      route_points: [],
      route_points_raw_count: 2,
      route_points_map_count: 0,
      start_address: null,
      end_address: null,
      route_data_expired_at: '2026-06-13T12:00:00.000Z',
      route_data_retention_days: 90,
      needs_rescore: false,
    });
    expect(expired.driving_events[0]).toEqual({ type: 'harsh_brake', value: -4.2 });
    expect(expired.native_tracking_timeline[0]).toEqual({ type: 'location' });
  });

  it('enforces raw GPS retention once per day without deleting trip summaries', async () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z');
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    values.set('drivesense_settings', JSON.stringify({
      settings_defaults_version: 11,
      data_retention_days: 0,
      raw_gps_retention_days: 90,
      privacy_zones: [],
    }));
    values.set('drivesense_trips', JSON.stringify([{
      id: 'eligible-old-trip',
      status: 'completed',
      start_time: '2025-12-01T10:00:00.000Z',
      end_time: '2025-12-01T10:30:00.000Z',
      route_points: [
        { lat: 43.65, lng: -79.38, timestamp: '2025-12-01T10:00:00.000Z' },
        { lat: 43.66, lng: -79.39, timestamp: '2025-12-01T10:30:00.000Z' },
      ],
      driving_events: [{ type: 'harsh_brake', lat: 43.655, lng: -79.385, value: -4 }],
      score_overall: 91,
      distance_km: 18.2,
      duration_seconds: 1800,
    }, {
      id: 'old-draft',
      status: 'draft',
      start_time: '2025-12-01T10:00:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    }]));

    const first = await enforceRawGpsRetention({ force: true, now });
    const second = await enforceRawGpsRetention({ now: now + 60 * 60 * 1000 });
    const trips = await localTripRepository.listAll();
    const expired = trips.find((trip) => trip.id === 'eligible-old-trip');
    const draft = trips.find((trip) => trip.id === 'old-draft');

    expect(first).toMatchObject({ enabled: true, purgedTrips: 1, purgedPoints: 2, lastRunAt: now });
    expect(second).toMatchObject({ enabled: true, skipped: true, purgedTrips: 0 });
    expect(expired).toMatchObject({
      score_overall: 91,
      distance_km: 18.2,
      duration_seconds: 1800,
      route_points: [],
      route_data_retention_days: 30,
      needs_rescore: false,
    });
    expect(expired.driving_events[0]).toEqual({ type: 'harsh_brake', value: -4 });
    expect(draft.route_points).toHaveLength(1);
  });

  it('enforces complete-trip retention and reports the deleted count', async () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z');
    const values = new Map();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    values.set('drivesense_settings', JSON.stringify({
      settings_defaults_version: 11,
      data_retention_days: 90,
      raw_gps_retention_days: 0,
      privacy_zones: [],
    }));
    values.set('drivesense_trips', JSON.stringify([{
      id: 'expired-trip',
      status: 'completed',
      start_time: '2025-12-01T10:00:00.000Z',
      end_time: '2025-12-01T10:30:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    }, {
      id: 'retained-trip',
      status: 'completed',
      start_time: '2026-06-01T10:00:00.000Z',
      end_time: '2026-06-01T10:30:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    }]));

    const result = await enforceTripDataRetention({ now });
    const trips = await localTripRepository.listAll();

    expect(result).toEqual({ enabled: true, retentionDays: 90, deletedTrips: 1 });
    expect(trips.map((trip) => trip.id)).toEqual(['retained-trip']);
  });

  it('loads trips only once when export enforces complete-trip retention', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 11,
        data_retention_days: 365,
        raw_gps_retention_days: 30,
        privacy_zones: [],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    await localTripRepository.create({
      id: 'export-retained-trip',
      status: 'completed',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });

    const tripStore = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    tripStore.getAllCount = 0;

    const trips = await localTripRepository.listAllForExport();

    expect(trips).toHaveLength(1);
    expect(tripStore.getAllCount).toBe(1);
  });

  it('opens an empty IndexedDB and creates the trip store with required indexes', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    });

    const database = fakeIndexedDb.databases.get('drivesense_mobile');
    const trips = database.stores.get('trips');
    const summaries = database.stores.get('trip_summaries');

    expect(DB_NAME).toBe('drivesense_mobile');
    expect(database.version).toBe(DB_VERSION);
    expect(trips.keyPath).toBe('id');
    expect(trips.indexes.has('start_time')).toBe(true);
    expect(trips.indexKeyPaths.get('start_time')).toBe('start_time');
    expect(trips.indexes.has('status')).toBe(true);
    expect(trips.indexKeyPaths.get('status')).toBe('status');
    expect(summaries.keyPath).toBe('id');
    expect(summaries.indexes.has('start_time')).toBe(true);
    expect(summaries.indexes.has('status')).toBe(true);
    const [storedRecord] = [...trips.records.values()];
    expect(storedRecord).toMatchObject({
      status: 'draft',
      encrypted_payload: {
        encrypted: true,
        algorithm: 'AES-256-GCM',
      },
    });
    expect(JSON.stringify(storedRecord)).not.toContain('43.6532');
    expect(JSON.stringify(storedRecord)).not.toContain('-79.3832');
  });

  it('verifies imported native trips are readable before acknowledging the native cache', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    const importedTrip = await localTripRepository.create({
      id: 'native-imported-trip',
      status: 'completed',
      start_time: '2026-05-22T10:00:00.000Z',
      end_time: '2026-05-22T10:15:00.000Z',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    });

    await expect(verifyTripsPersistedForNativeAcknowledge([importedTrip])).resolves.toBe(true);
    await expect(verifyTripsPersistedForNativeAcknowledge([
      { id: 'missing-native-trip' },
    ])).rejects.toThrow('Native trip import was not persisted: missing-native-trip');
  });

  it('opens one trip by key and serves lightweight summaries without scanning full trip records', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      id: 'direct-read-trip',
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [
        { lat: 43.6532, lng: -79.3832, speed_kmh: 30 },
        { lat: 43.6542, lng: -79.3842, speed_kmh: 35 },
      ],
    });

    const database = fakeIndexedDb.databases.get(DB_NAME);
    const tripStore = database.stores.get('trips');
    tripStore.getAllCount = 0;

    const trip = await localTripRepository.getById('direct-read-trip');
    const summaries = await localTripRepository.listAllSummaries();

    expect(trip.route_points).toHaveLength(2);
    expect(tripStore.getAllCount).toBe(0);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'direct-read-trip',
      status: 'draft',
      summary_version: 1,
    });
    expect(summaries[0].route_points).toBeUndefined();
  });

  it('rotates both full trip and summary encryption records together', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      id: 'rotation-trip',
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    });

    const result = await rotateTripEncryptionKey(2);
    const versions = await inspectStoredTripKeyVersions();
    const summaries = await localTripRepository.listAllSummaries();

    expect(result.indexedDbRecordsRotated).toBe(2);
    expect(versions).toEqual([2, 2]);
    expect(summaries[0].id).toBe('rotation-trip');
  });

  it('redacts private route and event coordinates at the repository write boundary', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({
        settings_defaults_version: 9,
        privacy_zones: [{ id: 'home', label: 'Home', lat: 43.65, lng: -79.38, radius_m: 120 }],
      }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    await localTripRepository.create({
      id: 'repo-privacy-trip',
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 12, timestamp: '2026-05-22T10:00:00.000Z' },
        { lat: 43.6532, lng: -79.38, speed_kmh: 30, timestamp: '2026-05-22T10:01:00.000Z' },
      ],
      driving_events: [
        { type: 'harsh_brake', lat: 43.6501, lng: -79.38, timestamp: '2026-05-22T10:00:10.000Z' },
      ],
    });

    const stored = await localTripRepository.getById('repo-privacy-trip');

    expect(stored.route_points[0]).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_live_redacted: true,
      privacy_zone_id: 'home',
    });
    expect(stored.route_points[0].latitude).toBeUndefined();
    expect(stored.route_points[0].longitude).toBeUndefined();
    expect(stored.route_points[1].lat).toBe(43.6532);
    expect(stored.driving_events[0]).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_event_redacted: true,
      privacy_zone_id: 'home',
    });
  });

  it('commits random replacement data before deleting an IndexedDB trip', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);

    await localTripRepository.create({
      id: 'secure-delete-trip',
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [{ lat: 43.6532, lng: -79.3832 }],
    });
    const result = await localTripRepository.delete('secure-delete-trip');

    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    const tombstone = store.putHistory.at(-1);
    expect(result).toEqual({
      success: true,
      deletion_method: 'indexeddb_overwrite_then_delete',
      record_found: true,
    });
    expect(store.records.has('secure-delete-trip')).toBe(false);
    expect(tombstone).toMatchObject({
      id: 'secure-delete-trip',
      status: 'secure-delete-pending',
      _secure_delete_tombstone: true,
    });
    expect(tombstone.random_padding).toMatch(/^[a-f0-9]{8192,}$/);
    expect(JSON.stringify(tombstone)).not.toContain('43.6532');
    expect(JSON.stringify(tombstone)).not.toContain('-79.3832');
  });

  it('hydrates cell-only privacy zones before repository writes', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    await savePrivacyZonesToStorage([]);
    const cellOnlyZone = {
      id: 'home-restart',
      label: 'Home',
      radius_m: 120,
      privacy_cell_schema: 'global_grid_v1',
      privacy_cell_size_m: 50,
      privacy_cell_hashes: createPrivacyCellHashes({ lat: 43.65, lng: -79.38, radius_m: 120 }),
      masked_for_privacy: true,
    };
    await setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, [cellOnlyZone]);
    values.set('drivesense_settings', JSON.stringify({
      settings_defaults_version: 9,
      privacy_zones: [{
        id: 'home-restart',
        label: 'Home',
        radius_m: 120,
        masked_for_privacy: true,
      }],
    }));

    const saved = await localTripRepository.create({
      id: 'repo-cell-only-trip',
      status: 'draft',
      start_time: '2026-05-22T10:00:00.000Z',
      route_points: [
        { lat: 43.65, lng: -79.38, speed_kmh: 12, timestamp: '2026-05-22T10:00:00.000Z' },
      ],
    });

    expect(saved.route_points[0]).toMatchObject({
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_zone_id: 'home-restart',
    });
    expect(JSON.stringify([...fakeIndexedDb.databases.get('drivesense_mobile').stores.get('trips').records.values()]))
      .not.toContain('43.65');
    expect(JSON.stringify(values.get('drivesense_settings'))).not.toContain('43.65');
    expect(JSON.stringify(values.get('drivesense_settings'))).not.toContain('-79.38');
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
    expect(migratedTrips.get('legacy-trip')).toMatchObject({
      id: 'legacy-trip',
      encrypted_payload: { encrypted: true },
    });
    expect(fakeIndexedDb.databases.has('legacy_drivesense_mobile')).toBe(false);
    expect(values.get(DB_NAME_META_KEY)).toBe(DB_NAME);
  });

  it('rewrites legacy plaintext trip records after a successful read', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const db = await new Promise((resolve, reject) => {
      const request = fakeIndexedDb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('trips', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacyTrip = {
      id: 'legacy-plaintext-trip',
      status: 'draft',
      start_time: '2026-01-01T12:00:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    };
    await new Promise((resolve, reject) => {
      const request = db.transaction('trips', 'readwrite').objectStore('trips').put(legacyTrip);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    db.close();

    const trips = await localTripRepository.listAll();
    const stored = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips').records.get(legacyTrip.id);

    expect(trips).toContainEqual(expect.objectContaining(legacyTrip));
    expect(stored.encrypted_payload).toMatchObject({ encrypted: true });
    expect(JSON.stringify(stored)).not.toContain('43.65');
    expect(JSON.stringify(stored)).not.toContain('-79.38');
  });

  it('explicitly migrates legacy plaintext trip storage during startup', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const db = await new Promise((resolve, reject) => {
      const request = fakeIndexedDb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('trips', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacyTrip = {
      id: 'startup-migration-trip',
      status: 'completed',
      start_time: '2026-01-01T12:00:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    };
    await new Promise((resolve, reject) => {
      const request = db.transaction('trips', 'readwrite').objectStore('trips').put(legacyTrip);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    db.close();

    const result = await migrateLegacyTripStorageToEncrypted();
    const stored = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips').records.get(legacyTrip.id);

    expect(result.indexedDbRecordsMigrated).toBe(1);
    expect(stored.encrypted_payload).toMatchObject({ encrypted: true });
    expect(JSON.stringify(stored)).not.toContain('43.65');
    expect(JSON.stringify(stored)).not.toContain('-79.38');
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

  it('refreshes an outdated trip before returning its cached history summary', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const startMs = Date.parse('2026-07-11T20:38:00.000Z');
    const routePoints = Array.from({ length: 11 }, (_, index) => ({
      lat: 43.65 + index * 0.000135,
      lng: -79.38,
      speed_kmh: 54,
      accuracy: 30,
      timestamp: new Date(startMs + index * 1_000).toISOString(),
    }));
    values.set('drivesense_trips', JSON.stringify([{
      id: 'distance-undercount',
      status: 'completed',
      start_time: routePoints[0].timestamp,
      end_time: routePoints.at(-1).timestamp,
      route_points: routePoints,
      distance_km: 0,
      schema_version: TRIP_SCHEMA_VERSION - 1,
      score_provenance: {
        scoring_version: SCORING_VERSION,
        constants_snapshot: buildScoreConstantsSnapshot(DEFAULT_THRESHOLDS),
      },
    }]));

    const [summary] = await localTripRepository.listSummaries();

    expect(summary.schema_version).toBe(TRIP_SCHEMA_VERSION);
    expect(summary.distance_km).toBeGreaterThan(0.14);
    expect(summary.distance_km).toBeLessThan(0.17);
  });

  it('immediately re-scores eligible completed trips and reports skipped history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T12:00:00.000Z'));
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const currentProvenance = {
      scoring_version: SCORING_VERSION,
      constants_snapshot: buildScoreConstantsSnapshot(DEFAULT_THRESHOLDS),
    };
    values.set('drivesense_trips', JSON.stringify([
      {
        id: 'eligible',
        status: 'completed',
        start_time: '2026-06-17T12:00:00.000Z',
        end_time: '2026-06-17T12:05:00.000Z',
        route_points: [
          { lat: 43.65, lng: -79.38, speed_kmh: 35, timestamp: '2026-06-17T12:00:00.000Z' },
          { lat: 43.66, lng: -79.39, speed_kmh: 38, timestamp: '2026-06-17T12:05:00.000Z' },
        ],
        score_overall: 1,
        score_safety: 1,
        score_smoothness: 1,
        score_eco: 1,
        score_provenance: currentProvenance,
        schema_version: TRIP_SCHEMA_VERSION,
      },
      {
        id: 'expired',
        status: 'completed',
        start_time: '2026-01-01T12:00:00.000Z',
        end_time: '2026-01-01T12:05:00.000Z',
        route_points: [],
        route_data_expired_at: '2026-06-01T12:00:00.000Z',
        score_overall: 75,
        score_provenance: currentProvenance,
        schema_version: TRIP_SCHEMA_VERSION,
      },
    ]));

    const result = await localTripRepository.rescoreCompletedTrips();
    const rescored = await localTripRepository.getById('eligible');

    expect(result).toMatchObject({
      requested: 2,
      eligible: 1,
      completed: 1,
      changed: 1,
      unchanged: 0,
      skipped: 1,
      failed: 0,
    });
    expect(result.skippedTrips).toContainEqual({ id: 'expired', reason: 'route_data_expired' });
    expect(rescored.score_overall).not.toBe(1);
    expect(rescored.needs_rescore).toBe(false);
    expect(rescored.score_provenance.scoring_version).toBe(SCORING_VERSION);
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
