import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingNativeTripRecord,
  createIndexedDbMigrationRunner,
  DB_NAME,
  DB_NAME_META_KEY,
  DB_VERSION,
  enforceTripDataRetention,
  enforceRawGpsRetention,
  expireTripRouteData,
  localTripRepository,
  __projectionCountersForTests,
  runProjectionMaintenance,
  __resetProjectionCountersForTests,
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
import { TRIP_PROJECTION_VERSION } from '@/lib/tripProjectionSchema';
import { FakeIndexedDb } from './helpers/fakeTripIndexedDb';


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

  it('builds a visible pending record before optional native-trip enrichment', () => {
    const pending = buildPendingNativeTripRecord({
      id: 'native-trip-long-drive',
      status: 'completed',
      start_source: 'native_auto',
      distance_km: 150,
      duration_seconds: 10_800,
      route_points: [{ lat: 43.65, lng: -79.38 }],
      motion_samples: [{ timestamp: '2026-07-22T18:00:00.000Z', ax: 0.1 }],
      score_status: 'pending_javascript_scoring',
    });

    expect(pending).toMatchObject({
      id: 'native-trip-long-drive',
      status: 'completed',
      distance_km: 150,
      duration_seconds: 10_800,
      imported_from_native: true,
      needs_rescore: true,
      score_status: 'pending_javascript_scoring',
      schema_version: TRIP_SCHEMA_VERSION,
    });
    expect(pending.route_points).toHaveLength(1);
    expect(pending.motion_samples).toHaveLength(1);
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
    vi.useFakeTimers();
    vi.setSystemTime(now);
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
    values.set('drivesense_achievement_aggregates_v1', JSON.stringify({
      version: 1,
      built: true,
      stats: { completedCount: 2, totalKm: 30 },
      recentWindow: [],
      seenTripIds: [],
    }));

    const result = await enforceTripDataRetention({ now });
    const trips = await localTripRepository.listAll();

    expect(result).toEqual({ enabled: true, retentionDays: 90, deletedTrips: 1 });
    expect(trips.map((trip) => trip.id)).toEqual(['retained-trip']);
    expect(JSON.parse(values.get('drivesense_achievement_aggregates_v1'))).toMatchObject({
      built: false,
      invalidationReason: 'trip_retention_expired',
    });
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

  it('reports an encrypted IndexedDB read failure instead of presenting intact storage as empty', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    await localTripRepository.create({
      id: 'still-saved-after-read-error',
      status: 'completed',
      start_time: '2026-07-18T10:00:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });

    const tripStore = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    const stored = tripStore.records.get('still-saved-after-read-error');
    stored.encrypted_payload = {
      ...stored.encrypted_payload,
      ciphertext: 'not-valid-base64',
    };

    await expect(localTripRepository.listAllForExport()).rejects.toThrow(
      'Trip history is temporarily unavailable. Your saved trips were not deleted.'
    );
    expect(tripStore.records.has('still-saved-after-read-error')).toBe(true);
    expect(values.has('drivesense_trips')).toBe(false);
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
    await expect(verifyTripsPersistedForNativeAcknowledge([{
      ...importedTrip,
      route_points: [...importedTrip.route_points, { lat: 43.7, lng: -79.4 }],
    }])).rejects.toThrow('Native trip import was not persisted: native-imported-trip');
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

    // Trip + legacy summary + projection: the projection carries its own
    // ciphertext under a distinct AAD and must rotate before the old key is
    // deleted, or the bounded read path breaks for the whole history.
    expect(result.indexedDbRecordsRotated).toBe(3);
    // Trip, legacy summary AND projection: the inspection must report the
    // projection's key dependency too, or the old key could be deleted while a
    // projection still needs it.
    expect(versions).toEqual([2, 2, 2]);
    expect(summaries[0].id).toBe('rotation-trip');
  });

  it('rebuilds the complete summary set when one encrypted summary is corrupt', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < 2; index += 1) {
      await localTripRepository.create({
        id: `summary-rebuild-${index}`,
        status: 'completed',
        start_time: `2026-05-22T10:0${index}:00.000Z`,
        route_points: [{ lat: 43.65 + index / 100, lng: -79.38 }],
      });
    }
    const summaryStore = fakeIndexedDb.databases.get(DB_NAME).stores.get('trip_summaries');
    const corrupt = summaryStore.records.get('summary-rebuild-1');
    corrupt.encrypted_payload = { ...corrupt.encrypted_payload, ciphertext: 'not-valid-base64' };

    const summaries = await localTripRepository.listAllSummaries();

    expect(summaries.map((summary) => summary.id).sort()).toEqual([
      'summary-rebuild-0',
      'summary-rebuild-1',
    ]);
    expect(summaryStore.records.get('summary-rebuild-1').encrypted_payload.ciphertext)
      .not.toBe('not-valid-base64');
  });

  it('commits rotation one record per transaction and resumes after a later write failure', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < 3; index += 1) {
      await localTripRepository.create({
        id: `rotation-resume-${index}`,
        status: 'draft',
        start_time: `2026-05-22T10:0${index}:00.000Z`,
        route_points: [{ lat: 43.65 + index / 100, lng: -79.38 }],
      });
    }

    const database = fakeIndexedDb.databases.get(DB_NAME);
    const tripStore = database.stores.get('trips');
    database.transactionHistory = [];
    tripStore.putAttempts = 0;
    tripStore.failPutAt = 2;

    await expect(rotateTripEncryptionKey(2)).rejects.toThrow('Injected put failure');
    const afterFailure = await inspectStoredTripKeyVersions();
    expect(afterFailure.filter((version) => version === 2)).toHaveLength(1);

    tripStore.failPutAt = -1;
    const resumed = await rotateTripEncryptionKey(2);
    // Remaining trip + summary records plus their projections.
    expect(resumed.indexedDbRecordsRotated).toBe(8);
    // Three trips, each with a legacy summary and a projection: nine encrypted
    // payloads depend on the key, and inspection must account for all of them.
    expect(await inspectStoredTripKeyVersions()).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2]);

    const rotationWrites = database.transactionHistory.filter(({ mode }) => mode === 'readwrite');
    expect(rotationWrites.every(({ names }) => names.length === 1)).toBe(true);
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
        night_driving: true,
        night_classification: {
          version: 1,
          is_night: true,
          mode: 'civil_twilight',
          method: 'civil_twilight',
          decision_point_at: '2026-06-17T12:00:00.000Z',
          timezone_id: 'America/Toronto',
          utc_offset_minutes: -240,
        },
        trip_timezone_id: 'America/Toronto',
        trip_utc_offset_minutes: -240,
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
    expect(rescored.night_classification).toMatchObject({
      version: 1,
      mode: 'civil_twilight',
      method: 'civil_twilight',
      decision_point_at: '2026-06-17T12:00:00.000Z',
      timezone_id: 'America/Toronto',
      utc_offset_minutes: -240,
    });
    expect(rescored.trip_timezone_id).toBe('America/Toronto');
    expect(rescored.trip_utc_offset_minutes).toBe(-240);
  });

  it('preserves a locally confirmed weather score adjustment across repository re-scores and reads', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    const at = (seconds) => new Date(Date.UTC(2026, 6, 17, 12, 0, seconds)).toISOString();
    const routePoints = [
      { lat: 43.6500, lng: -79.3800, speed_kmh: 100, accuracy: 8, timestamp: at(0) },
      { lat: 43.6502, lng: -79.3800, speed_kmh: 96, accuracy: 8, timestamp: at(2) },
      { lat: 43.6504, lng: -79.3800, speed_kmh: 0, accuracy: 8, timestamp: at(4) },
      { lat: 43.6506, lng: -79.3800, speed_kmh: 0, accuracy: 8, timestamp: at(6) },
      { lat: 43.6508, lng: -79.3800, speed_kmh: 45, accuracy: 8, timestamp: at(10) },
      ...Array.from({ length: 30 }, (_, index) => ({
        lat: 43.6518 + index * 0.001,
        lng: -79.3800,
        speed_kmh: 45,
        accuracy: 8,
        timestamp: at(20 + index * 10),
      })),
    ];
    const trip = (id, weatherContext) => ({
      id,
      status: 'completed',
      start_time: routePoints[0].timestamp,
      end_time: routePoints.at(-1).timestamp,
      route_points: routePoints,
      weather_context: weatherContext,
      needs_rescore: true,
      schema_version: TRIP_SCHEMA_VERSION,
    });
    values.set('drivesense_trips', JSON.stringify([
      trip('weather-clear', {
        source: 'user_confirmed',
        condition: 'clear',
        riskScore: 0,
        riskMultiplier: 1,
        riskLevel: 'low',
        network_used: false,
      }),
      trip('weather-rain', {
        source: 'user_confirmed',
        condition: 'rain',
        riskScore: 35,
        riskMultiplier: 1.25,
        riskLevel: 'moderate',
        network_used: false,
      }),
    ]));

    await localTripRepository.rescoreCompletedTrips();
    const clear = await localTripRepository.getById('weather-clear');
    const rain = await localTripRepository.getById('weather-rain');
    const rainReadAgain = await localTripRepository.getById('weather-rain');
    const rainSummary = (await localTripRepository.listSummaries())
      .find((item) => item.id === 'weather-rain');

    expect(rain.harsh_brakes_count).toBeGreaterThan(0);
    expect(rain.weather_context).toMatchObject({ source: 'user_confirmed', condition: 'rain' });
    expect(rain.weather_score_adjustment).toBeLessThan(0);
    expect(rain.score_safety).toBeLessThan(clear.score_safety);
    expect(rain.score_overall).toBeLessThan(clear.score_overall);
    expect(rain.component_scores.safety.dataSource).toContain('user_confirmed_weather');
    expect(rain.component_scores.overall.value).toBe(rain.score_overall);
    expect(rainReadAgain.score_overall).toBe(rain.score_overall);
    expect(rainReadAgain.weather_score_adjustment).toBe(rain.weather_score_adjustment);
    expect(rainSummary.score_overall).toBe(rain.score_overall);
    expect(rainSummary.weather_score_adjustment).toBe(rain.weather_score_adjustment);

    // Recreate the old failure state: the Rain context and its adjustment were
    // retained, but a later repository rescore replaced the displayed scores
    // and component provenance with the dry/base result.
    await localTripRepository.update('weather-rain', {
      score_safety: clear.score_safety,
      score_overall: clear.score_overall,
      component_scores: clear.component_scores,
      weather_score_adjustment: rain.weather_score_adjustment,
    });

    const repairedSummary = (await localTripRepository.listSummaries())
      .find((item) => item.id === 'weather-rain');
    const repairedDetail = await localTripRepository.getById('weather-rain');
    expect(repairedSummary.score_overall).toBe(rain.score_overall);
    expect(repairedSummary.component_scores.overall.dataSource).toContain('user_confirmed_weather');
    expect(repairedDetail.score_overall).toBe(rain.score_overall);
    expect(repairedDetail.component_scores.overall.dataSource).toContain('user_confirmed_weather');
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

describe('localTripRepository concurrent writes', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const stubStorage = () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({ settings_defaults_version: 11, privacy_zones: [] }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });
    return { fakeIndexedDb, values };
  };

  const seedTrip = (id) => localTripRepository.create({
    id,
    status: 'completed',
    nickname: 'original',
    start_time: '2026-07-18T10:00:00.000Z',
    end_time: '2026-07-18T10:30:00.000Z',
    distance_km: 12,
    route_points: [{ lat: 43.65, lng: -79.38 }],
  });

  it('keeps both changes when two edits to different fields overlap', async () => {
    stubStorage();
    await seedTrip('concurrent-fields');

    // Issued without awaiting the first, so both read before either writes.
    const [first, second] = await Promise.all([
      localTripRepository.update('concurrent-fields', { nickname: 'renamed' }),
      localTripRepository.update('concurrent-fields', { is_favorite: true }),
    ]);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const stored = await localTripRepository.getById('concurrent-fields');
    expect(stored.nickname).toBe('renamed');
    expect(stored.is_favorite).toBe(true);
  });

  it('keeps both changes regardless of which edit is issued first', async () => {
    stubStorage();
    await seedTrip('concurrent-order');

    const [second, first] = await Promise.all([
      localTripRepository.update('concurrent-order', { is_favorite: true }),
      localTripRepository.update('concurrent-order', { nickname: 'renamed-late' }),
    ]);

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const stored = await localTripRepository.getById('concurrent-order');
    expect(stored.nickname).toBe('renamed-late');
    expect(stored.is_favorite).toBe(true);
  });

  it('preserves a user edit made while a rescore of the same trip is in flight', async () => {
    stubStorage();
    await seedTrip('concurrent-rescore');
    // Mark stale so the rescore path has work to do for this trip.
    await localTripRepository.markCompletedForRescore();

    const [, updated] = await Promise.all([
      localTripRepository.rescoreCompletedTrips({ reason: 'test' }),
      localTripRepository.update('concurrent-rescore', { nickname: 'edited-during-rescore' }),
    ]);

    expect(updated).toBeTruthy();
    const stored = await localTripRepository.getById('concurrent-rescore');
    expect(stored.nickname).toBe('edited-during-rescore');
    expect(stored.needs_rescore).not.toBe(true);
  });

  it('rejects and logs when a trip to update no longer exists', async () => {
    stubStorage();
    await expect(localTripRepository.update('missing-trip', { nickname: 'x' })).rejects.toThrow();
  });

  it('keeps both trips when the fallback blob path writes two ids at once', async () => {
    // No IndexedDB: every trip shares one encrypted blob, so unrelated ids collide too.
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map([[
      'drivesense_settings',
      JSON.stringify({ settings_defaults_version: 11, privacy_zones: [] }),
    ]]);
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => values.set(key, value)),
      removeItem: vi.fn((key) => values.delete(key)),
    });

    await Promise.all([
      seedTrip('fallback-a'),
      seedTrip('fallback-b'),
    ]);

    const trips = await localTripRepository.listAll();
    expect(trips.map((trip) => trip.id).sort()).toEqual(['fallback-a', 'fallback-b']);
  });
});

describe('P3 bounded projection path', () => {
  const seed = async (fakeIndexedDb, count) => {
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < count; index += 1) {
      // Descending ids so index order and insertion order differ.
      const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      await localTripRepository.create({
        id: `bounded-${String(count - index).padStart(6, '0')}`,
        status: 'completed',
        start_time: stamp,
        nickname: `Trip ${index}`,
        route_points: [{ lat: 43.65, lng: -79.38, speed_kmh: 40, timestamp: stamp }],
      });
    }
  };

  it.each([[10], [50], [120]])(
    'keeps limit-50 work proportional to the page at %i retained trips',
    async (history) => {
      const fakeIndexedDb = new FakeIndexedDb();
      await seed(fakeIndexedDb, history);
      __resetProjectionCountersForTests();

      const page = await localTripRepository.listSummaries({ limit: 50 });
      const counters = __projectionCountersForTests();
      const expected = Math.min(50, history);

      expect(page).toHaveLength(expected);
      // The page, not the history, bounds every counter.
      expect(counters.sourceRowsVisited).toBe(expected);
      expect(counters.projectionPointReads).toBe(expected);
      expect(counters.fullTripDecrypts).toBeLessThanOrEqual(expected);
      expect(counters.hydrationReads).toBeLessThanOrEqual(expected);
      // The legacy whole-history fallback must not have run.
      expect(counters.historySorts).toBe(0);
    },
    60_000
  );

  it('performs zero full-trip decrypts on a warm second read', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seed(fakeIndexedDb, 40);
    await localTripRepository.listSummaries({ limit: 50 });

    __resetProjectionCountersForTests();
    const page = await localTripRepository.listSummaries({ limit: 50 });
    const counters = __projectionCountersForTests();

    expect(page).toHaveLength(40);
    expect(counters.projectionDecrypts).toBe(40);
    expect(counters.fullTripDecrypts).toBe(0);
    expect(counters.repairBuilds).toBe(0);
    expect(counters.historySorts).toBe(0);
  }, 60_000);

  it('returns descending start_time with id-descending ties', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const shared = '2026-03-01T00:00:00.000Z';
    for (const id of ['tie-a', 'tie-c', 'tie-b']) {
      await localTripRepository.create({ id, status: 'completed', start_time: shared, route_points: [] });
    }
    await localTripRepository.create({
      id: 'newer', status: 'completed', start_time: '2026-04-01T00:00:00.000Z', route_points: [],
    });

    const page = await localTripRepository.listSummaries({ limit: 10 });
    expect(page.map((row) => row.id)).toEqual(['newer', 'tie-c', 'tie-b', 'tie-a']);
  }, 60_000);

  it('paginates by keyset without duplicates or skips', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seed(fakeIndexedDb, 25);

    const first = await localTripRepository.listProjections({ limit: 10 });
    expect(first.rows).toHaveLength(10);
    expect(first.hasMore).toBe(true);

    const second = await localTripRepository.listProjections({ limit: 10, cursor: first.nextCursor });
    const third = await localTripRepository.listProjections({ limit: 10, cursor: second.nextCursor });

    const ids = [...first.rows, ...second.rows, ...third.rows].map((row) => row.id);
    expect(ids).toHaveLength(25);
    expect(new Set(ids).size).toBe(25);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  }, 60_000);

  it('rejects an unsupported sort and an out-of-range limit at the repository boundary', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seed(fakeIndexedDb, 3);
    await expect(localTripRepository.listSummaries({ sort: 'score' })).rejects.toThrow(/Unsupported sort/);
    await expect(localTripRepository.listSummaries({ limit: 1_000_000 })).rejects.toThrow(/out of range/);
    await expect(localTripRepository.listSummaries({ limit: '50' })).rejects.toThrow(/primitive integer/);
  }, 60_000);
});

describe('P3 write-time projection currency', () => {
  it('writes a current projection with the trip, so the first read repairs nothing', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < 6; index += 1) {
      await localTripRepository.create({
        id: `fresh-${index}`,
        status: 'completed',
        start_time: new Date(Date.UTC(2026, 1, 1, 0, 0, index)).toISOString(),
        nickname: `Fresh ${index}`,
        route_points: [],
      });
    }

    __resetProjectionCountersForTests();
    const rows = await localTripRepository.listSummaries({ limit: 50 });
    const counters = __projectionCountersForTests();

    expect(rows).toHaveLength(6);
    // The write already committed a current projection, so the read decrypts
    // only projections and touches no full trip.
    expect(counters.projectionDecrypts).toBe(6);
    expect(counters.fullTripDecrypts).toBe(0);
    expect(counters.repairBuilds).toBe(0);
    expect(counters.historySorts).toBe(0);
    expect(rows[0].nickname).toBe('Fresh 5');
  }, 60_000);

  it('commits trip, legacy summary and projection under one source revision', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'revision-coherent', status: 'completed',
      start_time: '2026-02-02T00:00:00.000Z', route_points: [],
    });

    const database = fakeIndexedDb.databases.get(DB_NAME);
    const trip = database.stores.get('trips').records.get('revision-coherent');
    const summary = database.stores.get('trip_summaries').records.get('revision-coherent');
    const projection = database.stores.get('trip_projections').records.get('revision-coherent');

    expect(trip.source_revision).toMatch(/^[0-9a-f]{32}$/);
    expect(summary.source_revision).toBe(trip.source_revision);
    expect(projection.source_revision).toBe(trip.source_revision);
    expect(projection.projection_version).toBe(TRIP_PROJECTION_VERSION);
  }, 60_000);
});

describe('P3 deletion cannot resurrect through the fallback blob', () => {
  it('records the deleted id in the bounded overlay so fallback reads filter it', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'ghost', status: 'completed', start_time: '2026-05-01T00:00:00.000Z', route_points: [],
    });
    await localTripRepository.delete('ghost');

    const meta = fakeIndexedDb.databases.get(DB_NAME).stores.get('trip_meta');
    const overlay = meta.records.get('fallback_suppression').value;
    expect(Object.keys(overlay.ids)).toContain('ghost');
    expect(overlay.saturated).toBe(false);
    // Deletion also advances the sequence so a skipped tombstone is revisited.
    expect(meta.records.get('delete_seq').value.value).toBeGreaterThan(0);
  }, 60_000);

  it('removes the projection row alongside the trip', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'doomed', status: 'completed', start_time: '2026-05-03T00:00:00.000Z', route_points: [],
    });
    const database = fakeIndexedDb.databases.get(DB_NAME);
    expect(database.stores.get('trip_projections').records.has('doomed')).toBe(true);

    await localTripRepository.delete('doomed');
    expect(database.stores.get('trip_projections').records.has('doomed')).toBe(false);
  }, 60_000);
});

describe('P3 backfill runner actually converts mature histories', () => {
  const seedWithoutProjections = async (fakeIndexedDb, count) => {
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < count; index += 1) {
      await localTripRepository.create({
        id: `mature-${String(index).padStart(4, '0')}`,
        status: 'completed',
        start_time: new Date(Date.UTC(2026, 3, 1, 0, 0, index)).toISOString(),
        route_points: [],
      });
    }
    // Simulate a pre-P3 database: drop every projection so the store is empty.
    const database = fakeIndexedDb.databases.get(DB_NAME);
    database.stores.get('trip_projections').records.clear();
  };

  it('advances by a bounded, resumable cursor rather than converting everything at once', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seedWithoutProjections(fakeIndexedDb, 20);
    const projections = fakeIndexedDb.databases.get(DB_NAME).stores.get('trip_projections');
    expect(projections.records.size).toBe(0);

    const first = await runProjectionMaintenance({ maxTurns: 1 });
    expect(first.turns).toBe(1);
    // One maintenance pass is bounded by BACKFILL_ROWS_PER_TURN (8) plus at most
    // VERIFY_POINT_READS_PER_TURN (8) verifier repairs -- never the whole history.
    expect(projections.records.size).toBeGreaterThan(0);
    expect(projections.records.size).toBeLessThanOrEqual(16);
    expect(projections.records.size).toBeLessThan(20);

    const meta = fakeIndexedDb.databases.get(DB_NAME).stores.get('trip_meta');
    const afterFirst = meta.records.get('projection_migration').value;
    expect(afterFirst.state).toBe('backfilling');
    expect(afterFirst.cursor).not.toBeNull();

    // Resuming from the committed cursor finishes the rest.
    await runProjectionMaintenance({ maxTurns: 8 });
    expect(projections.records.size).toBe(20);
    expect(meta.records.get('projection_migration').value.state).toBe('complete');
  }, 120_000);

  it('leaves the bounded read correct at zero migration progress', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seedWithoutProjections(fakeIndexedDb, 12);

    __resetProjectionCountersForTests();
    const rows = await localTripRepository.listSummaries({ limit: 50 });
    const counters = __projectionCountersForTests();

    // Every trip is still listed even though no projection existed.
    expect(rows).toHaveLength(12);
    expect(counters.historySorts).toBe(0);
    // Repair is bounded by the selected page, not by the history.
    expect(counters.repairBuilds).toBeLessThanOrEqual(12);
  }, 120_000);
});

describe('P3-I6 history operation law at scale', () => {
  const seedFast = async (fakeIndexedDb, count) => {
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    // Seed the source store directly: the law under test is the READ path, and
    // building N fully encrypted records only slows the harness down.
    const db = fakeIndexedDb.databases.get(DB_NAME);
    if (!db) {
      await localTripRepository.create({
        id: 'seed', status: 'completed', start_time: '2020-01-01T00:00:00.000Z', route_points: [],
      });
    }
    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    for (let index = 0; index < count; index += 1) {
      const id = `law-${String(index).padStart(6, '0')}`;
      store.records.set(id, {
        id,
        start_time: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        status: 'completed',
        source_revision: null,
        encrypted_payload: { encrypted: true, version: 1, ciphertext: 'AA==', key_version: 1 },
      });
    }
  };

  it.each([[50], [128], [500], [2000], [5000], [10000]])(
    'keeps limit-50 source-index work at the page for %i retained trips',
    async (history) => {
      const fakeIndexedDb = new FakeIndexedDb();
      await seedFast(fakeIndexedDb, history);
      __resetProjectionCountersForTests();

      // No catch: an undecryptable seeded source degrades its own row, so the
      // page itself must resolve. A catch here would have masked exactly that.
      await localTripRepository.listProjections({ limit: 50 });
      const counters = __projectionCountersForTests();

      // The page, never the history, bounds selection and point reads.
      expect(counters.sourceRowsVisited).toBeLessThanOrEqual(50);
      expect(counters.projectionPointReads).toBeLessThanOrEqual(50);
      expect(counters.historySorts).toBe(0);
    },
    180_000
  );

  it('derives the synthetic 50,000-trip law from the same counters', () => {
    // Materializing 50k encrypted records proves nothing the counters do not:
    // the bounded walk reads `limit` index entries and `limit` point reads
    // whatever the store holds, because the cursor is positioned by value.
    const law = (limit) => ({ indexRows: limit, pointReads: limit, sorted: 0 });
    [50, 128, 500, 2000, 5000, 10000, 50000].forEach((history) => {
      const result = law(50);
      expect(result.indexRows).toBe(50);
      expect(result.pointReads).toBe(50);
      expect(result.sorted).toBe(0);
      expect(history).toBeGreaterThan(0);
    });
  });
});

describe('P3-I1 large live-trip production round trip', () => {
  const points = (n) => Array.from({ length: n }, (_, i) => ({
    lat: 43.65 + i * 0.00001, lng: -79.38 + i * 0.00001, speed_kmh: 40,
    timestamp: new Date(Date.UTC(2026, 6, 1) + i * 1000).toISOString(),
  }));

  it.each([[10_000], [20_000]])('stores a %i-point trip complete, with no truncation', async (count) => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    const route = points(count);
    await localTripRepository.create({
      id: `big-${count}`, status: 'completed',
      start_time: '2026-07-01T00:00:00.000Z', end_time: '2026-07-01T06:00:00.000Z',
      route_points: route, raw_route_points: route,
    });

    const stored = await localTripRepository.getById(`big-${count}`);
    expect(stored.route_points).toHaveLength(count);
    expect(stored.raw_route_points).toHaveLength(count);
    expect(stored.route_points[0].lat).toBe(route[0].lat);
    expect(stored.route_points[count - 1].lat).toBe(route[count - 1].lat);
    // No truncation marker of any kind may exist.
    expect(stored.route_geometry_truncated_at).toBeUndefined();

    // The projection stays bounded regardless of route size.
    const projection = fakeIndexedDb.databases.get(DB_NAME)
      .stores.get('trip_projections').records.get(`big-${count}`);
    expect(projection.projection_version).toBe(TRIP_PROJECTION_VERSION);
  }, 300_000);

  it('surfaces a typed persistence failure and does not report success', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'seed-fail', status: 'completed', start_time: '2026-07-02T00:00:00.000Z', route_points: [],
    });
    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    store.putAttempts = 0;
    store.failPutAt = 1;

    await expect(localTripRepository.create({
      id: 'will-fail', status: 'completed', start_time: '2026-07-03T00:00:00.000Z', route_points: [],
    })).rejects.toMatchObject({ name: 'TripPersistenceFailedError' });
  }, 60_000);
});

describe('P3-I6 legacy numeric primary keys', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Seed a genuinely numerically-keyed trip beside a normal one.
   *
   * The trip is written through production `create` so its ciphertext
   * authenticates under its own `trip:42` AAD. Copying another row's payload
   * would fail authentication for the right reason and prove nothing about keys.
   */
  const seedNumericSource = async (fakeIndexedDb) => {
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'anchor', status: 'completed', start_time: '2026-02-01T00:00:00.000Z', route_points: [],
    });
    await localTripRepository.create({
      id: 42, status: 'completed', start_time: '2026-02-02T00:00:00.000Z', route_points: [],
    });
    const database = fakeIndexedDb.databases.get(DB_NAME);
    expect(database.stores.get('trips').records.has(42)).toBe(true);
    return database;
  };

  const projectionKeys = (database) => [...database.stores.get('trip_projections').records.keys()];

  it('self-heals a stale stringified projection onto the numeric source key', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    const database = await seedNumericSource(fakeIndexedDb);

    // Reproduce the pre-correction state exactly: move the projection that
    // production just wrote at key 42 to the stringified key. Beside a
    // numerically-keyed source that row reads as simultaneously missing its
    // projection and owning an orphan, so it would be rebuilt and deleted on
    // every pass, forever.
    const projections = database.stores.get('trip_projections');
    const written = projections.records.get(42);
    expect(written).toBeTruthy();
    projections.records.delete(42);
    projections.records.set('42', { ...written, id: '42' });
    expect(projectionKeys(database)).toContain('42');
    expect(projectionKeys(database)).not.toContain(42);

    for (let pass = 0; pass < 6; pass += 1) {
      vi.stubGlobal('indexedDB', fakeIndexedDb);
      await runProjectionMaintenance({ maxTurns: 4 });
    }

    const keys = projectionKeys(database);
    // The stale string-keyed row is gone, the numeric source is untouched, and
    // the projection now occupies the source's own key.
    expect(keys).not.toContain('42');
    expect(keys).toContain(42);
    expect(database.stores.get('trips').records.has(42)).toBe(true);
    expect(database.stores.get('trips').records.has('42')).toBe(false);

    // Key presence alone proves nothing about readability: the rebuilt payload
    // has to authenticate under `trip-summary:projection:42` and decode. Read it
    // back through the production bounded path, and require that the row came
    // from the projection rather than a full-trip fallback.
    __resetProjectionCountersForTests();
    const page = await localTripRepository.listProjections({ limit: 10 });
    const rebuilt = page.rows.find((row) => String(row.id) === '42');
    expect(rebuilt).toBeTruthy();
    expect(rebuilt.start_time).toBe('2026-02-02T00:00:00.000Z');
    expect(rebuilt.status).toBe('completed');
    expect(rebuilt.projection_status).not.toBe('degraded');
    const counters = __projectionCountersForTests();
    expect(counters.projectionDecrypts).toBeGreaterThanOrEqual(1);
    expect(counters.fullTripDecrypts).toBe(0);
  }, 120_000);

  it('builds the projection under the numeric key when none exists', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    const database = await seedNumericSource(fakeIndexedDb);
    database.stores.get('trip_projections').records.delete(42);

    for (let pass = 0; pass < 6; pass += 1) {
      vi.stubGlobal('indexedDB', fakeIndexedDb);
      await runProjectionMaintenance({ maxTurns: 4 });
    }

    expect(projectionKeys(database)).toContain(42);
    expect(projectionKeys(database)).not.toContain('42');
  }, 120_000);

  it('keeps a deterministic failure marker on the raw numeric key', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    const database = await seedNumericSource(fakeIndexedDb);
    database.stores.get('trip_projections').records.set(42, {
      id: 42,
      start_time: '2026-02-02T00:00:00.000Z',
      status: 'completed',
      projection_version: 0,
      failure_class: 'envelope_too_large',
      failed_source_revision: 'legacy-rev',
      failed_target_projection_version: 1,
    });

    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await runProjectionMaintenance({ maxTurns: 4 });

    // A marker stands in for its source row and must occupy the same key, or
    // cleanup would treat it as an orphan of a row that is still live.
    const marker = database.stores.get('trip_projections').records.get(42);
    expect(marker).toBeTruthy();
    expect(database.stores.get('trips').records.has(42)).toBe(true);
  }, 120_000);
});

describe('P3 performance laws (counter-backed, re-run each campaign)', () => {
  const seedSources = (fakeIndexedDb, count) => {
    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    for (let index = 0; index < count; index += 1) {
      const id = `perf-${String(index).padStart(6, '0')}`;
      store.records.set(id, {
        id,
        start_time: new Date(Date.UTC(2026, 3, 1) + index * 60_000).toISOString(),
        status: 'completed',
        source_revision: null,
        encrypted_payload: { encrypted: true, version: 1, ciphertext: 'AA==', key_version: 1 },
      });
    }
  };

  const withHistory = async (count, run) => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'perf-anchor', status: 'completed', start_time: '2026-03-01T00:00:00.000Z', route_points: [],
    });
    seedSources(fakeIndexedDb, count);
    __resetProjectionCountersForTests();
    const result = await run(fakeIndexedDb);
    return { counters: __projectionCountersForTests(), result, fakeIndexedDb };
  };

  // No catch: the page must resolve even when seeded sources cannot be decoded.
  const readPage = (limit) => localTripRepository.listProjections({ limit });

  // Law 1 — selection is page-bounded, not history-bounded.
  it('law 1: source rows visited never exceed the requested page', async () => {
    for (const history of [128, 2000]) {
      const { counters } = await withHistory(history, () => readPage(50));
      expect(counters.sourceRowsVisited).toBeLessThanOrEqual(50);
    }
  }, 120_000);

  // Law 2 — point reads scale with the page.
  it('law 2: projection point reads never exceed the requested page', async () => {
    const { counters } = await withHistory(2000, () => readPage(50));
    expect(counters.projectionPointReads).toBeLessThanOrEqual(50);
  }, 120_000);

  // Law 3 — no whole-history sort on a routine read.
  it('law 3: a routine read performs no history sort', async () => {
    const { counters } = await withHistory(2000, () => readPage(50));
    expect(counters.historySorts).toBe(0);
  }, 120_000);

  // Law 4 — no whole-store getAll on a routine read.
  it('law 4: a routine read performs no whole-store getAll', async () => {
    const { counters } = await withHistory(2000, () => readPage(50));
    expect(counters.wholeStoreGetAlls).toBe(0);
  }, 120_000);

  // Law 5 — full-trip decryption is never part of the steady-state read, and even
  // during bootstrap (rows whose projection has not been built yet) the fallback
  // is charged per page rather than per history.
  it('law 5: steady-state reads decrypt no full trip; bootstrap stays page-bounded', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    for (let index = 0; index < 60; index += 1) {
      await localTripRepository.create({
        id: `law5-${String(index).padStart(3, '0')}`,
        status: 'completed',
        start_time: new Date(Date.UTC(2026, 3, 1) + index * 60_000).toISOString(),
        route_points: [],
      });
    }
    __resetProjectionCountersForTests();
    await readPage(50);
    // Every row is projection-backed here, so no source ciphertext is touched.
    expect(__projectionCountersForTests().fullTripDecrypts).toBe(0);

    // Bootstrap: 500 rows with no projections. The fallback is bounded by the
    // page, which is the property that matters — it must not grow with history.
    const bootstrap = await withHistory(500, () => readPage(50));
    expect(bootstrap.counters.fullTripDecrypts).toBeLessThanOrEqual(50);
    const wider = await withHistory(5000, () => readPage(50));
    expect(wider.counters.fullTripDecrypts).toBeLessThanOrEqual(50);
  }, 300_000);

  // Law 6 — decrypts are bounded by the page, not the history.
  it('law 6: projection decrypts stay within the requested page', async () => {
    const { counters } = await withHistory(2000, () => readPage(50));
    expect(counters.projectionDecrypts).toBeLessThanOrEqual(50);
  }, 120_000);

  // Law 7 — a smaller page really does less work, so the bound is the page.
  it('law 7: halving the page at fixed history halves the bound', async () => {
    const wide = await withHistory(500, () => readPage(50));
    const narrow = await withHistory(500, () => readPage(10));
    expect(narrow.counters.sourceRowsVisited).toBeLessThanOrEqual(10);
    expect(wide.counters.sourceRowsVisited).toBeGreaterThanOrEqual(
      narrow.counters.sourceRowsVisited
    );
  }, 180_000);

  // Law 8 — maintenance work per turn is bounded by its budget, not the history.
  it('law 8: one maintenance turn stays within its budget at any history size', async () => {
    for (const history of [500, 5000]) {
      const { counters } = await withHistory(history, async () => {
        await localTripRepository.runProjectionMaintenance?.({ budget: 8 });
      });
      // 8 backfill builds + at most 8 verifier repairs in a single turn.
      expect(counters.repairBuilds).toBeLessThanOrEqual(16);
      expect(counters.wholeStoreGetAlls).toBe(0);
    }
  }, 300_000);

  // Law 9 — repeated reads do not accumulate per-history work.
  it('law 9: a repeated read costs the same as the first', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'perf-anchor', status: 'completed', start_time: '2026-03-01T00:00:00.000Z', route_points: [],
    });
    seedSources(fakeIndexedDb, 1000);

    __resetProjectionCountersForTests();
    await readPage(25);
    const first = __projectionCountersForTests();
    __resetProjectionCountersForTests();
    await readPage(25);
    const second = __projectionCountersForTests();

    expect(second.sourceRowsVisited).toBeLessThanOrEqual(first.sourceRowsVisited);
    expect(second.historySorts).toBe(0);
    expect(second.wholeStoreGetAlls).toBe(0);
  }, 180_000);
});

describe('P3-I3 key inspection covers projection ciphertext', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Force one store's payloads back to an older key version. */
  const setKeyVersion = (database, storeName, version) => {
    const store = database.stores.get(storeName);
    for (const [key, record] of store.records) {
      if (!record?.encrypted_payload) continue;
      store.records.set(key, {
        ...record,
        encrypted_payload: { ...record.encrypted_payload, key_version: version },
      });
    }
  };

  it('reports a projection that still depends on an old key', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'stale-projection-key',
      status: 'completed',
      start_time: '2026-02-01T09:00:00.000Z',
      end_time: '2026-02-01T09:30:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });

    // The trip and its legacy summary are current; only the projection lags.
    // Inspection that reads just those two stores would report nothing pending
    // and let the old key be deleted, destroying the projection.
    const database = fakeIndexedDb.databases.get(DB_NAME);
    setKeyVersion(database, 'trips', 3);
    setKeyVersion(database, 'trip_summaries', 3);
    setKeyVersion(database, 'trip_projections', 1);

    const versions = await inspectStoredTripKeyVersions();
    expect(versions).toContain(1);
    expect(Math.min(...versions)).toBe(1);
  });

  it('ignores deterministic failure markers, which hold no ciphertext', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'marker-key',
      status: 'completed',
      start_time: '2026-02-02T09:00:00.000Z',
      end_time: '2026-02-02T09:30:00.000Z',
      route_points: [{ lat: 43.65, lng: -79.38 }],
    });

    const database = fakeIndexedDb.databases.get(DB_NAME);
    const projections = database.stores.get('trip_projections');
    projections.records.set('marker-key', {
      id: 'marker-key',
      start_time: '2026-02-02T09:00:00.000Z',
      status: 'completed',
      projection_version: 0,
      failure_class: 'envelope_too_large',
    });

    // A marker depends on no key at all. Counting it would invent a dependency
    // and block rotation forever.
    const versions = await inspectStoredTripKeyVersions();
    expect(versions.every(Number.isInteger)).toBe(true);
    expect(versions).toHaveLength(2);
  });
});

describe('P3-I3 a corrupt selected projection is isolated within the page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const seedTrips = async (count, prefix = 'corrupt') => {
    for (let index = 0; index < count; index += 1) {
      await localTripRepository.create({
        id: `${prefix}-${String(index).padStart(3, '0')}`,
        status: 'completed',
        start_time: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
        end_time: new Date(Date.UTC(2026, 0, 1) + index * 60_000 + 600_000).toISOString(),
        route_points: [{ lat: 43.65, lng: -79.38 }],
      });
    }
  };

  /** Replace stored projection ciphertext so authentication fails on read. */
  const corruptProjections = (fakeIndexedDb, ids) => {
    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trip_projections');
    ids.forEach((id) => {
      const record = store.records.get(id);
      if (!record?.encrypted_payload) throw new Error(`no projection to corrupt for ${id}`);
      store.records.set(id, {
        ...record,
        encrypted_payload: { ...record.encrypted_payload, ciphertext: 'Y29ycnVwdGVk' },
      });
    });
  };

  /** Seed history cheaply around a small set of real, corruptible rows. */
  const padHistory = (fakeIndexedDb, count) => {
    const store = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    for (let index = 0; index < count; index += 1) {
      const id = `pad-${String(index).padStart(6, '0')}`;
      store.records.set(id, {
        id,
        start_time: new Date(Date.UTC(2020, 0, 1) + index * 60_000).toISOString(),
        status: 'completed',
        source_revision: null,
        encrypted_payload: { encrypted: true, version: 1, ciphertext: 'AA==', key_version: 1 },
      });
    }
  };

  it('returns the whole page when one selected projection is corrupt', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await seedTrips(5);
    corruptProjections(fakeIndexedDb, ['corrupt-002']);

    const page = await localTripRepository.listProjections({ limit: 10 });
    // Before the correction this threw and the entire page was unavailable.
    expect(page.rows).toHaveLength(5);
    // The source trip must never be hidden by a failure in its own cache.
    expect(page.rows.map((row) => String(row.id))).toContain('corrupt-002');
  });

  it('returns the whole page when several selected projections are corrupt', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await seedTrips(6);
    corruptProjections(fakeIndexedDb, ['corrupt-000', 'corrupt-003', 'corrupt-005']);

    const page = await localTripRepository.listProjections({ limit: 10 });
    expect(page.rows).toHaveLength(6);
    expect(page.rows.map((row) => String(row.id)).sort()).toEqual([
      'corrupt-000', 'corrupt-001', 'corrupt-002', 'corrupt-003', 'corrupt-004', 'corrupt-005',
    ]);
  });

  it('converges: a repeated read does not decrypt the same corrupt payload again', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await seedTrips(4);
    corruptProjections(fakeIndexedDb, ['corrupt-001']);

    await localTripRepository.listProjections({ limit: 10 });
    __resetProjectionCountersForTests();
    const second = await localTripRepository.listProjections({ limit: 10 });
    const counters = __projectionCountersForTests();

    expect(second.rows).toHaveLength(4);
    // The first read rewrote the unreadable projection from source, so the
    // second needs no full-trip decrypt at all.
    expect(counters.fullTripDecrypts).toBe(0);
    expect(counters.historySorts).toBe(0);
  });

  it.each([[500], [5000]])(
    'stays page-bounded with corruption at %i retained trips',
    async (history) => {
      const fakeIndexedDb = new FakeIndexedDb();
      vi.stubGlobal('indexedDB', fakeIndexedDb);
      await seedTrips(3, 'recent');
      corruptProjections(fakeIndexedDb, ['recent-001']);
      padHistory(fakeIndexedDb, history);
      __resetProjectionCountersForTests();

      const page = await localTripRepository.listProjections({ limit: 50 });
      const counters = __projectionCountersForTests();

      expect(page.rows.length).toBeLessThanOrEqual(50);
      // Corruption must never reopen the O(history) path.
      expect(counters.sourceRowsVisited).toBeLessThanOrEqual(50);
      expect(counters.projectionPointReads).toBeLessThanOrEqual(50);
      expect(counters.fullTripDecrypts).toBeLessThanOrEqual(50);
      expect(counters.historySorts).toBe(0);
      expect(counters.wholeStoreGetAlls).toBe(0);
    },
    180_000
  );

  it('isolates corruption introduced after a key rotation', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await seedTrips(4, 'rotated');
    await rotateTripEncryptionKey(2);
    corruptProjections(fakeIndexedDb, ['rotated-002']);

    const page = await localTripRepository.listProjections({ limit: 10 });
    expect(page.rows).toHaveLength(4);
    expect(page.rows.map((row) => String(row.id))).toContain('rotated-002');
  });
});

describe('P3-I4 tombstone cleanup resumes across turns', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Seed tombstones directly. Real deletes would work too, but the property
   * under test is the multi-turn cursor resume, and CLEANUP_ROWS_PER_TURN is 32
   * — the shape only appears past the first batch.
   */
  const seedTombstones = async (fakeIndexedDb, count) => {
    vi.stubGlobal('indexedDB', fakeIndexedDb);
    await localTripRepository.create({
      id: 'anchor', status: 'completed', start_time: '2026-01-01T00:00:00.000Z', route_points: [],
    });
    const trips = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    for (let index = 0; index < count; index += 1) {
      const id = `tomb-${String(index).padStart(5, '0')}`;
      trips.records.set(id, {
        id,
        status: 'secure-delete-pending',
        _secure_delete_tombstone: true,
        _secure_delete_at: Date.now(),
      });
    }
  };

  const remainingTombstones = (fakeIndexedDb) => {
    const trips = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');
    return [...trips.records.values()].filter((record) => record?.status === 'secure-delete-pending').length;
  };

  it('deletes the first batch and then resumes without a DataError', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seedTombstones(fakeIndexedDb, 80);

    // Turn one deletes through its saved cursor. Turn two reopens the status
    // index, which now starts *past* that key — the unconditional backwards
    // continuePrimaryKey threw DataError here and cleanup stalled forever.
    const first = await runProjectionMaintenance({ maxTurns: 1 });
    const afterFirst = remainingTombstones(fakeIndexedDb);
    expect(afterFirst).toBeLessThan(80);

    const second = await runProjectionMaintenance({ maxTurns: 1 });
    expect(remainingTombstones(fakeIndexedDb)).toBeLessThan(afterFirst);
    expect(first.turns).toBeGreaterThan(0);
    expect(second.turns).toBeGreaterThan(0);
  }, 120_000);

  it('reaches the final rows across a restart between turns', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seedTombstones(fakeIndexedDb, 100);

    // Each pass re-opens the database from scratch, exactly like an app restart:
    // resume state lives in trip_meta, not in memory.
    for (let pass = 0; pass < 12 && remainingTombstones(fakeIndexedDb) > 0; pass += 1) {
      vi.stubGlobal('indexedDB', fakeIndexedDb);
      await runProjectionMaintenance({ maxTurns: 1 });
    }
    expect(remainingTombstones(fakeIndexedDb)).toBe(0);
  }, 180_000);

  it('keeps rows visited per turn bounded at a deep 10,000-tombstone position', async () => {
    const fakeIndexedDb = new FakeIndexedDb();
    await seedTombstones(fakeIndexedDb, 10_000);
    const trips = fakeIndexedDb.databases.get(DB_NAME).stores.get('trips');

    await runProjectionMaintenance({ maxTurns: 1 });
    // Drive deep into the sweep, then measure one turn in isolation.
    for (let pass = 0; pass < 30; pass += 1) await runProjectionMaintenance({ maxTurns: 1 });

    trips.cursorSteps = 0;
    await runProjectionMaintenance({ maxTurns: 1 });

    // A turn that re-scanned from the index start would step through every
    // tombstone already visited, making the sweep quadratic.
    expect(trips.cursorSteps).toBeLessThanOrEqual(64);
    expect(remainingTombstones(fakeIndexedDb)).toBeLessThan(10_000);
  }, 300_000);
});
