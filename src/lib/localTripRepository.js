import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { clearNativeCompletedTrips, getNativeCompletedTrips } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import {
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  getScoreProvenanceStatus,
  SCORING_VERSION,
} from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';
import { localVehicleRepository } from '@/lib/localVehicleRepository';
import { localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import {
  getPrivacyZones,
  maskEventsForPrivacy,
  sanitizeTripForPrivacyStorageAsync,
} from '@/lib/privacyZones';
import { invalidateDangerZoneCache } from '@/lib/dangerZoneEngine';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  buildPhoneUsageAccessProvenance,
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
} from '@/lib/phoneUsageAccess';
import { hasRecoverableOriginalRouteGeometry, restoreOriginalRouteGeometry } from '@/lib/mapPlaybackInsights';
import { buildSensorFusionSummary } from '@/lib/sensorFusionModel';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  getEncryptedJson,
  isEncryptedPayload,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { isSecureDeleteTombstone, secureDelete } from '@/lib/encryptedStore';
import { appendPrivacyEvent } from '@/lib/hashChainLog';

const TRIPS_KEY = 'drivesense_trips';
const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';
export const RAW_GPS_LIFECYCLE_STATE_KEY = 'drivesense_raw_gps_lifecycle_state_v1';
export const RAW_GPS_LIFECYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DB_NAME = 'drivesense_mobile';
export const DB_NAME_META_KEY = 'drivesense_indexeddb_name';
export const DB_NAME = String(import.meta.env.VITE_DB_NAME || DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;
const TRIP_STORE = 'trips';
export const TRIP_SCHEMA_VERSION = 23;
export const TRIP_EVENT_MIGRATION_VERSION = 1;
export const TRIP_EVENT_MIGRATION_KEY = 'drivesense_trip_event_migration_version';
export const TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY = 'drivesense_heading_event_migration_note_dismissed';
export { RESCORE_PROGRESS_EVENT };
export const AUTO_RESCORE_RECENT_WINDOW_DAYS = 28;
export const AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO = 0.2;
/*
 * Completed trip record schema additions in version 3:
 * - road-type segmented scores: highway_score, urban_score, residential_score, dominant_road_type
 * - brake-onset smoothness: brake_onset_smoothness_score, avg_brake_onset_ramp_seconds,
 *   brake_onset_smoothness_grade, brake_onset_sequence_count
 * - cornering consistency: cornering_consistency_score, cornering_grade, mean_lateral_g, peak_lateral_g, corner_sample_count
 * - braking efficiency: braking_efficiency_score, braking_efficiency_grade, braking_sequence_count, avg_braking_smoothness
 * - compliance: highway_compliance, urban_compliance, residential_compliance, overall_compliance_score
 * - overtake quality: overtake_quality_score, overtake_quality_grade, overtake_count, unsafe_reentry_count
 * - road condition proxy: slippery_proxy, wet_signal_count, wet_ratio, safety_condition_bonus, avg_distance_ratio
 * - stats speed zones: speed_zones
 *
 * Completed trip record schema additions in version 4:
 * - phone use detection: phone_use_events, phone_use_window_count, phone_use_total_seconds,
 *   phone_use_risk, phone_use_score, phone_use_pct_of_trip, phone_use_high_confidence_count
 * - native cross-check: native_phone_proxy_count
 *
 * Completed trip record schema additions in version 6:
 * - Android Usage Access phone-use evidence: native_phone_usage_events,
 *   native_phone_usage_event_count, native_phone_usage_total_seconds,
 *   native_phone_usage_access_granted
 *
 * Version 7 recalculates completed trips with stricter lane-change,
 * erratic-speed, overtake-quality, traffic-stop, and night-card logic.
 *
 * Version 8 preserves and reconstructs phone-use events across rescoring and
 * OpenStreetMap/weather refreshes so historical phone-use trips remain visible.
 *
 * Version 9 recalculates trips after privacy-masked coordinates were excluded
 * from map, playback, segment, and speed-zone distance calculations.
 *
 * Version 10 backfills estimated CO2 savings so legacy completed trips can
 * count toward carbon reports and achievement badges when vehicle context is available.
 *
 * Version 11 recalculates jerk scores after removing the long-trip 20-point
 * floor and adding insufficient-data confidence handling.
 *
 * Version 12 recalculates intersection scores with four-second traffic-stop
 * detection, nullable unobserved scores, and no permanent penalty floor.
 *
 * Version 13 recalculates following-distance scores across city and highway
 * driving with speed-weighted penalties and short-trip insufficient-data handling.
 *
 * Version 14 recalculates eco scores with named fallback multipliers, bounded
 * idle ratios, and unavailable handling for invalid zero-multiplier settings.
 *
 * Version 15 recalculates SVI from moving samples within city/highway strata,
 * with distance-weighted mixed-route scoring and nullable insufficient data.
 *
 * Version 16 recalculates confidence metadata, gap-corrected duration,
 * contextual braking grades, fatigue scaling, and de-duplicated phone events.
 *
 * Version 17 replaces unsupported public GPS-only safety claims with
 * brake-onset, stop-start, heading-deviation, heading-drift beta, and
 * estimated close-proximity manoeuvre fields.
 *
 * Version 18 adds availability flags so withheld GPS-only proxy surfaces are
 * hidden when the required evidence or advanced detection mode is absent.
 *
 * Version 19 makes GPS phone and overtake signatures diagnostic only; Android
 * Usage Access remains the scoreable source for phone-use evidence.
 *
 * Version 20 adds canonical component_scores evidence envelopes for uniform
 * value availability, evidence level, source attribution, and sample counts.
 *
 * Version 21 recalculates component evidence with registry-defined distance
 * and sample requirements instead of one trip-wide distance confidence.
 *
 * Version 22 stores scoring provenance and refreshes trips when their scoring
 * version or calibration-input snapshot no longer matches current settings.
 *
 * Version 23 adds lane-changing detection/scoring fields and Safety blend input.
 */

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const hasStore = (db, storeName) => db.objectStoreNames.contains(storeName);

const hasIndex = (store, indexName) => store.indexNames.contains(indexName);

const ensureTripIndex = (store, indexName, keyPath) => {
  if (!hasIndex(store, indexName)) {
    store.createIndex(indexName, keyPath);
  }
};

const getTripStoreForUpgrade = (db, transaction) => {
  if (!hasStore(db, TRIP_STORE)) {
    return db.createObjectStore(TRIP_STORE, { keyPath: 'id' });
  }
  return transaction.objectStore(TRIP_STORE);
};

export const createIndexedDbMigrationRunner = (migrations) => {
  const orderedMigrations = [...migrations].sort((a, b) => a.version - b.version);
  const latestVersion = orderedMigrations.at(-1)?.version ?? 1;

  return {
    version: latestVersion,
    migrate({ db, oldVersion, transaction }) {
      orderedMigrations
        .filter((migration) => oldVersion < migration.version)
        .forEach((migration) => migration.migrate({ db, transaction }));
    },
  };
};

const tripDbMigrationRunner = createIndexedDbMigrationRunner([
  {
    version: 1,
    migrate({ db, transaction }) {
      const store = getTripStoreForUpgrade(db, transaction);
      ensureTripIndex(store, 'start_time', 'start_time');
      ensureTripIndex(store, 'status', 'status');
    },
  },
]);

export const DB_VERSION = tripDbMigrationRunner.version;

const localStorageMeta = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};

const openDbByName = (dbName) => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }

  const request = indexedDB.open(dbName, DB_VERSION);
  request.onupgradeneeded = (event) => {
    tripDbMigrationRunner.migrate({
      db: request.result,
      oldVersion: event.oldVersion,
      transaction: request.transaction,
    });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const openDb = () => migrateConfiguredDbName().then(() => openDbByName(DB_NAME));

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbTransactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const tripEncryptionContext = (id) => `trip:${String(id)}`;

const encodeTripRecord = async (trip, options = {}) => {
  const storageTrip = await sanitizeTripForPrivacyStorageAsync(trip);
  return {
    id: storageTrip.id,
    start_time: storageTrip.start_time || '',
    status: storageTrip.status || '',
    encrypted_payload: await encryptSensitiveValue(
      storageTrip,
      tripEncryptionContext(storageTrip.id),
      options
    ),
  };
};

const decodeTripRecord = async (record) => {
  if (!isEncryptedPayload(record?.encrypted_payload)) return record;
  return decryptSensitiveValue(record.encrypted_payload, tripEncryptionContext(record.id));
};

const decodeTripRecords = (records = []) => Promise.all(records.map(decodeTripRecord));
const sanitizeTripsForPrivacyStorage = (trips = []) => (
  Promise.all((Array.isArray(trips) ? trips : []).map((trip) => sanitizeTripForPrivacyStorageAsync(trip)))
);

const readTripsFromDb = async (dbName) => {
  const db = await openDbByName(dbName);
  try {
    const tx = db.transaction(TRIP_STORE, 'readonly');
    const records = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
    return decodeTripRecords(records.filter((record) => !isSecureDeleteTombstone(record)));
  } finally {
    db.close();
  }
};

const writeTripsToDb = async (dbName, trips) => {
  if (!trips.length) return;
  const encryptedTrips = await Promise.all(trips.map(encodeTripRecord));
  const db = await openDbByName(dbName);
  try {
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    const store = tx.objectStore(TRIP_STORE);
    encryptedTrips.forEach((trip) => store.put(trip));
    await idbTransactionDone(tx);
  } finally {
    db.close();
  }
};

const deleteDbByName = (dbName) => new Promise((resolve, reject) => {
  if (!canUseIndexedDb() || typeof indexedDB.deleteDatabase !== 'function') {
    resolve();
    return;
  }

  const request = indexedDB.deleteDatabase(dbName);
  request.onsuccess = () => resolve();
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error(`IndexedDB delete blocked for ${dbName}`));
});

let dbNameMigrationPromise = null;

/**
 * @param {{ previousName?: string, currentName?: string, storage?: Storage | null }} [options]
 */
export const migrateIndexedDbName = async ({
  previousName,
  currentName = DB_NAME,
  storage = localStorageMeta(),
} = {}) => {
  if (!canUseIndexedDb() || !storage) return false;

  const storedPreviousName = previousName ?? storage.getItem(DB_NAME_META_KEY);
  const legacyPreviousName = storedPreviousName || (currentName !== DEFAULT_DB_NAME ? DEFAULT_DB_NAME : currentName);
  if (!legacyPreviousName || legacyPreviousName === currentName) {
    storage.setItem(DB_NAME_META_KEY, currentName);
    return false;
  }

  const sourceTrips = await readTripsFromDb(legacyPreviousName);
  if (sourceTrips.length > 0) {
    const destinationTrips = await readTripsFromDb(currentName);
    const destinationIds = new Set(destinationTrips.map((trip) => String(trip.id)));
    const tripsToCopy = sourceTrips.filter((trip) => !destinationIds.has(String(trip.id)));
    await writeTripsToDb(currentName, tripsToCopy);

    const afterTrips = await readTripsFromDb(currentName);
    const expectedCount = new Set([
      ...destinationTrips.map((trip) => String(trip.id)),
      ...sourceTrips.map((trip) => String(trip.id)),
    ]).size;
    if (afterTrips.length !== expectedCount) {
      throw new Error(`IndexedDB rename migration count mismatch from ${legacyPreviousName} to ${currentName}`);
    }
  } else {
    await openDbByName(currentName).then((db) => db.close());
  }

  await deleteDbByName(legacyPreviousName);
  storage.setItem(DB_NAME_META_KEY, currentName);
  return true;
};

const migrateConfiguredDbName = () => {
  if (!dbNameMigrationPromise) {
    dbNameMigrationPromise = migrateIndexedDbName().catch((error) => {
      dbNameMigrationPromise = null;
      throw error;
    });
  }
  return dbNameMigrationPromise;
};

const getAllTrips = async () => {
  try {
    const db = await openDb();
    const readTx = db.transaction(TRIP_STORE, 'readonly');
    const records = await idbRequest(readTx.objectStore(TRIP_STORE).getAll());
    const tombstones = records.filter(isSecureDeleteTombstone);
    if (tombstones.length) {
      const cleanupTx = db.transaction(TRIP_STORE, 'readwrite');
      const store = cleanupTx.objectStore(TRIP_STORE);
      tombstones.forEach((record) => store.delete(record.id));
      await idbTransactionDone(cleanupTx);
    }
    db.close();
    const liveRecords = records.filter((record) => !isSecureDeleteTombstone(record));
    const trips = await decodeTripRecords(liveRecords);
    const legacyTrips = liveRecords.filter((record) => !isEncryptedPayload(record?.encrypted_payload));
    const sanitizedTrips = await sanitizeTripsForPrivacyStorage(trips);
    const sanitizedChanged = JSON.stringify(sanitizedTrips) !== JSON.stringify(trips);
    if (legacyTrips.length || sanitizedChanged) await writeTripsToDb(DB_NAME, sanitizedTrips);
    return sanitizedTrips;
  } catch {
    const trips = await getEncryptedJson(TRIPS_KEY, []);
    const sanitizedTrips = await sanitizeTripsForPrivacyStorage(trips);
    if (JSON.stringify(sanitizedTrips) !== JSON.stringify(trips)) {
      await setEncryptedJson(TRIPS_KEY, sanitizedTrips);
    }
    return sanitizedTrips;
  }
};

export async function migrateLegacyTripStorageToEncrypted() {
  let indexedDbRecordsMigrated = 0;
  let fallbackStoreMigrated = false;

  if (canUseIndexedDb()) {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(TRIP_STORE, 'readonly');
        const records = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
        const legacyTrips = records.filter((record) => (
          !isSecureDeleteTombstone(record) &&
          !isEncryptedPayload(record?.encrypted_payload)
        ));
        if (legacyTrips.length) {
          await writeTripsToDb(DB_NAME, legacyTrips);
          indexedDbRecordsMigrated = legacyTrips.length;
        }
      } finally {
        db.close();
      }
    } catch (error) {
      logSystemFailure('trip_storage_encryption_migration_indexeddb', error, {
        db_name: DB_NAME,
      });
    }
  }

  try {
    const fallbackTrips = await getJson(TRIPS_KEY, null);
    if (Array.isArray(fallbackTrips)) {
      await setEncryptedJson(TRIPS_KEY, await sanitizeTripsForPrivacyStorage(fallbackTrips));
      fallbackStoreMigrated = true;
    }
  } catch (error) {
    logSystemFailure('trip_storage_encryption_migration_fallback', error, {
      key: TRIPS_KEY,
    });
  }

  if (indexedDbRecordsMigrated || fallbackStoreMigrated) {
    recordSystemEvent('trip_storage_encryption_migrated', {
      indexeddb_record_count: indexedDbRecordsMigrated,
      fallback_store_migrated: fallbackStoreMigrated,
    }, { category: 'privacy', title: 'Trip storage encrypted' });
  }

  return { indexedDbRecordsMigrated, fallbackStoreMigrated };
}

export async function rotateTripEncryptionKey(targetKeyVersion, { yieldEvery = 20 } = {}) {
  const normalizedTarget = Math.max(1, Number(targetKeyVersion) || 1);
  let indexedDbRecordsRotated = 0;
  let fallbackStoreRotated = false;
  let processed = 0;

  if (canUseIndexedDb()) {
    const db = await openDb();
    try {
      const readTx = db.transaction(TRIP_STORE, 'readonly');
      const records = await idbRequest(readTx.objectStore(TRIP_STORE).getAll());
      for (const record of records) {
        if (isSecureDeleteTombstone(record)) {
          const cleanupTx = db.transaction(TRIP_STORE, 'readwrite');
          await idbRequest(cleanupTx.objectStore(TRIP_STORE).delete(record.id));
          continue;
        }
        if (Number(record?.encrypted_payload?.key_version) === normalizedTarget) continue;
        const trip = await decodeTripRecord(record);
        const encryptedRecord = await encodeTripRecord(trip, { keyVersion: normalizedTarget });
        const writeTx = db.transaction(TRIP_STORE, 'readwrite');
        await idbRequest(writeTx.objectStore(TRIP_STORE).put(encryptedRecord));
        indexedDbRecordsRotated += 1;
        processed += 1;
        if (yieldEvery > 0 && processed % yieldEvery === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } finally {
      db.close();
    }
  }

  const fallbackPayload = await getJson(TRIPS_KEY, null);
  if (isEncryptedPayload(fallbackPayload) && Number(fallbackPayload.key_version) !== normalizedTarget) {
    const fallbackTrips = await decryptSensitiveValue(fallbackPayload, `storage:${TRIPS_KEY}`);
    await setEncryptedJson(TRIPS_KEY, fallbackTrips, { keyVersion: normalizedTarget });
    fallbackStoreRotated = true;
  } else if (Array.isArray(fallbackPayload)) {
    await setEncryptedJson(TRIPS_KEY, fallbackPayload, { keyVersion: normalizedTarget });
    fallbackStoreRotated = true;
  }

  return { indexedDbRecordsRotated, fallbackStoreRotated };
}

export async function inspectStoredTripKeyVersions() {
  if (canUseIndexedDb()) {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(TRIP_STORE, 'readonly');
        const records = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
        return records
          .filter((record) => !isSecureDeleteTombstone(record))
          .map((record) => Number(record?.encrypted_payload?.key_version))
          .filter(Number.isInteger);
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the encrypted JSON store.
    }
  }

  const fallbackPayload = await getJson(TRIPS_KEY, null);
  return Number.isInteger(Number(fallbackPayload?.key_version))
    ? [Number(fallbackPayload.key_version)]
    : [];
}

const putTrip = async (trip) => {
  const storageTrip = await sanitizeTripForPrivacyStorageAsync(trip);
  try {
    const encryptedTrip = await encodeTripRecord(storageTrip);
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(TRIP_STORE).put(encryptedTrip));
    db.close();
  } catch {
    const trips = await getEncryptedJson(TRIPS_KEY, []);
    const next = [storageTrip, ...trips.filter((item) => String(item.id) !== String(storageTrip.id))];
    await setEncryptedJson(TRIPS_KEY, next);
  }
};

const putTrips = async (incomingTrips) => {
  if (!incomingTrips.length) return;
  const storageTrips = await sanitizeTripsForPrivacyStorage(incomingTrips);
  try {
    const encryptedTrips = await Promise.all(storageTrips.map(encodeTripRecord));
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    const store = tx.objectStore(TRIP_STORE);
    encryptedTrips.forEach((trip) => store.put(trip));
    await idbTransactionDone(tx);
    db.close();
  } catch {
    const trips = await getEncryptedJson(TRIPS_KEY, []);
    const incomingIds = new Set(storageTrips.map((trip) => String(trip.id)));
    const next = [
      ...storageTrips,
      ...trips.filter((item) => !incomingIds.has(String(item.id))),
    ];
    await setEncryptedJson(TRIPS_KEY, next);
  }
};

const invalidateTripDerivedCaches = async () => {
  await Promise.all([
    removeJson(DRIVER_SIGNATURE_KEY),
    invalidateDangerZoneCache(),
    invalidateRouteRiskIndex(),
  ]);
};

let importingNativeTrips = false;

const emitRescoreProgress = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RESCORE_PROGRESS_EVENT, { detail }));
};

const legacyScoreProvenanceNote = 'Legacy score marked unknown on app launch; values were not recalculated.';

const tagLegacyScoreProvenance = (trip) => {
  if (!trip || trip.status !== 'completed') return trip;
  const storedScoringVersion = trip.score_version || trip.score_provenance?.scoring_version || trip.score_provenance?.version || null;
  if (storedScoringVersion === SCORING_VERSION) return trip;

  const computedAt = trip.updated_at || trip.end_time || trip.created_at || new Date().toISOString();
  return {
    ...trip,
    score_provenance: {
      ...(trip.score_provenance && typeof trip.score_provenance === 'object' ? trip.score_provenance : {}),
      scoring_version: storedScoringVersion,
      computed_at: computedAt,
      calibration_status: 'unknown_legacy_unrescored',
      components: {},
      constants_snapshot: {},
      migrated_without_rescore: true,
      migration_note: legacyScoreProvenanceNote,
      target_scoring_version: SCORING_VERSION,
    },
    score_provenance_change: trip.score_provenance_change || {
      previous_scoring_version: storedScoringVersion,
      current_scoring_version: SCORING_VERSION,
      reason: 'legacy_tagged_without_rescore',
      changed_constants: [],
      tagged_at: new Date().toISOString(),
    },
  };
};

const vehicleForTrip = (trip, vehicles = []) => (
  Array.isArray(vehicles)
    ? vehicles.find((vehicle) => String(vehicle.id) === String(trip?.vehicle_id)) || null
    : null
);

const tagExistingTripsWithCurrentScoringVersion = async (trips = []) => {
  const next = trips.map((trip) => tagLegacyScoreProvenance(trip));
  const changed = next.filter((trip, index) => trip !== trips[index]);
  if (changed.length) await putTrips(changed);
  return next;
};

const recentCompletedTrips = (trips = [], now = new Date()) => {
  const cutoff = now.getTime() - AUTO_RESCORE_RECENT_WINDOW_DAYS * 86400000;
  return trips.filter((trip) => {
    if (trip?.status !== 'completed') return false;
    const startMs = new Date(trip.start_time || trip.end_time || trip.updated_at || 0).getTime();
    return Number.isFinite(startMs) && startMs >= cutoff;
  });
};

const autoRescoreProvenanceTripIds = (trips = [], thresholds = buildDrivingThresholds(localSettings.get())) => {
  const recent = recentCompletedTrips(trips);
  if (!recent.length) return new Set();
  const outdated = recent.filter((trip) => getScoreProvenanceStatus(trip, thresholds).needsRescore);
  if ((outdated.length / recent.length) <= AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO) return new Set();
  return new Set(outdated.map((trip) => trip.id));
};

const mergedPhoneUseForTrip = (trip, routePoints, stats, detectionPhoneUse) => {
  return buildPhoneUseFromTripEvidence(trip, routePoints, stats.duration_seconds, detectionPhoneUse);
};

const eventFeedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

const retiredEventTypeMap = Object.freeze({
  lane_change: 'heading_deviation_legacy',
});

const normalizeRetiredEventType = (event) => {
  if (!event || typeof event !== 'object') return event;
  const nextType = retiredEventTypeMap[event.type];
  return nextType
    ? { ...event, type: nextType, legacy_renamed: true }
    : event;
};

const normalizeEventFeedbackKeys = (feedback = {}, eventsBefore = [], eventsAfter = []) => {
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) return feedback;
  const remapped = { ...feedback };
  eventsBefore.forEach((event, index) => {
    if (event?.type !== 'lane_change') return;
    const oldKey = eventFeedbackKey(event, index);
    const newKey = eventFeedbackKey(eventsAfter[index], index);
    if (oldKey === newKey || remapped[oldKey] == null) return;
    remapped[newKey] = remapped[newKey] || remapped[oldKey];
    delete remapped[oldKey];
  });
  return remapped;
};

export const normalizeRetiredTripEventTypes = (trip = {}) => {
  if (!trip || typeof trip !== 'object') return trip;
  const existingTrip = /** @type {Record<string, any>} */ (trip);
  const eventFields = ['driving_events', 'phone_proxy_events', 'phone_use_events'];
  let changed = false;
  const next = /** @type {Record<string, any>} */ ({ ...trip });

  eventFields.forEach((field) => {
    if (!Array.isArray(existingTrip[field])) return;
    const normalized = existingTrip[field].map(normalizeRetiredEventType);
    if (normalized.some((event, index) => event !== existingTrip[field][index])) {
      next[field] = normalized;
      changed = true;
      if (field === 'driving_events') {
        next.event_feedback = normalizeEventFeedbackKeys(existingTrip.event_feedback, existingTrip[field], normalized);
      }
    }
  });

  const drivingEvents = Array.isArray(next.driving_events) ? next.driving_events : [];
  const modernHeadingCount = drivingEvents.length
    ? drivingEvents.filter((event) => event?.type === 'heading_deviation').length
    : Number(next.heading_deviation_count) || 0;
  const legacyHeadingCount = drivingEvents.length
    ? drivingEvents.filter((event) => event?.type === 'heading_deviation_legacy').length
    : Number(next.heading_deviation_legacy_count ?? next.lane_changes_count) || 0;
  const distanceKm = Math.max(1, Number(next.distance_km) || 1);
  const needsCountRefresh = drivingEvents.length > 0 && (
    next.heading_deviation_count !== modernHeadingCount ||
    next.heading_deviation_legacy_count !== legacyHeadingCount
  );

  if (changed || needsCountRefresh || existingTrip.lane_changes_count != null || existingTrip.lane_changes_per_10km != null) {
    delete next.lane_changes_count;
    delete next.lane_changes_per_10km;
    next.heading_deviation_count = modernHeadingCount;
    next.heading_deviations_per_10km = Math.round((modernHeadingCount / distanceKm) * 100) / 10;
    next.heading_deviation_legacy_count = legacyHeadingCount;
    next.heading_deviation_legacy_per_10km = Math.round((legacyHeadingCount / distanceKm) * 100) / 10;
    changed = true;
  }

  return changed ? { ...next, updated_at: new Date().toISOString() } : trip;
};

const migrateRetiredTripEventTypesOnce = async () => {
  const version = Number(await getJson(TRIP_EVENT_MIGRATION_KEY, 0)) || 0;
  if (version >= TRIP_EVENT_MIGRATION_VERSION) return { changed: 0, alreadyRan: true };

  const trips = await getAllTrips();
  const migratedTrips = trips.map(normalizeRetiredTripEventTypes);
  const changedTrips = migratedTrips.filter((trip, index) => trip !== trips[index]);
  if (changedTrips.length) {
    await putTrips(changedTrips);
    await invalidateTripDerivedCaches();
  }
  await setJson(TRIP_EVENT_MIGRATION_KEY, TRIP_EVENT_MIGRATION_VERSION);
  return { changed: changedTrips.length, alreadyRan: false };
};

const NATIVE_AGGREGATE_FIELDS = Object.freeze([
  'avg_speed_kmh',
  'avg_running_speed_kmh',
  'max_speed_kmh',
  'idle_time_seconds',
  'gap_seconds',
  'wall_clock_duration_seconds',
  'duration_seconds',
  'night_driving',
]);

export const preserveNativePrivacyAggregateStats = (trip = {}, calculatedStats = {}) => {
  const nativeTrip = trip?.start_source === 'native_auto' || trip?.imported_from_native === true;
  const routePoints = Array.isArray(trip?.route_points) ? trip.route_points : [];
  const hasPrivacyGap = routePoints.some((point) => (
    point?.masked_for_privacy === true ||
    point?.privacy_gap === true ||
    point?.privacy_live_redacted === true
  ));
  const nativeDistanceKm = Number(trip?.distance_km);
  if (!nativeTrip || !hasPrivacyGap || !Number.isFinite(nativeDistanceKm) || nativeDistanceKm < 0) {
    return calculatedStats;
  }

  const publicDistanceKm = Math.max(0, Number(calculatedStats?.distance_km) || 0);
  const next = {
    ...calculatedStats,
    distance_km: nativeDistanceKm,
    estimated_private_distance_km: Math.round(
      Math.min(nativeDistanceKm, Math.max(
        Number(calculatedStats?.estimated_private_distance_km) || 0,
        nativeDistanceKm - publicDistanceKm
      )) * 1000
    ) / 1000,
    distance_provenance: 'native_pre_privacy_redaction',
  };

  NATIVE_AGGREGATE_FIELDS.forEach((field) => {
    if (trip[field] != null) next[field] = trip[field];
  });
  return next;
};

export const applyEventFeedbackToEvents = (events = [], feedback = {}) => {
  const reviewed = feedback && typeof feedback === 'object' ? feedback : {};
  let removed = 0;
  const filtered = events.filter((event, index) => {
    const verdict = reviewed[eventFeedbackKey(event, index)]?.verdict;
    if (verdict === 'wrong') {
      removed += 1;
      return false;
    }
    return true;
  });
  return { events: filtered, removed };
};

const rescoreTrip = (trip, vehicles = []) => {
  if (!trip || trip.status !== 'completed') return trip;
  const routePoints = restoreOriginalRouteGeometry(trip.route_points || []);
  const settings = localSettings.get();
  const thresholds = buildDrivingThresholds(settings);
  const privacyZones = getPrivacyZones(settings);
  const currentPhoneUsageAccessGranted = typeof settings.phone_usage_access_granted === 'boolean'
    ? settings.phone_usage_access_granted
    : null;
  const phoneUsageAccessProvenance = buildPhoneUsageAccessProvenance(trip, currentPhoneUsageAccessGranted);
  const provenanceStatus = getScoreProvenanceStatus(trip, thresholds);
  const stats = preserveNativePrivacyAggregateStats(
    trip,
    calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds, {
      ...trip,
      raw_route_points: routePoints,
    })
  );
  const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(routePoints, thresholds, trip.end_time, privacyZones);
  const feedbackAdjusted = applyEventFeedbackToEvents(events, trip.event_feedback);
  const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, detectedPhoneUse);
  const motionSamples = Array.isArray(trip.motion_samples) ? trip.motion_samples : [];
  const sensorFusionSummary = motionSamples.length
    ? buildSensorFusionSummary(motionSamples, routePoints, null, feedbackAdjusted.events)
    : trip.sensor_fusion_summary;
  const scores = calculateTripScores(feedbackAdjusted.events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, {
    endTime: trip.end_time,
    privacyZones,
    motionSamples,
    orientationCalibration: sensorFusionSummary?.phone_orientation,
  });
  const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, vehicleForTrip(trip, vehicles), settings);
  const drivingEvents = maskEventsForPrivacy(
    mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || feedbackAdjusted.events, phoneUse),
    { privacy_zones: privacyZones }
  );
  const previousScoringVersion = trip.score_version || trip.score_provenance?.version || trip.score_provenance?.scoring_version || null;
  const scoreProvenanceChange = provenanceStatus.needsRescore || trip.needs_rescore
    ? {
      previous_scoring_version: previousScoringVersion,
      current_scoring_version: scores.score_provenance.scoring_version,
      reason: provenanceStatus.status === 'missing'
        ? 'provenance_added'
        : previousScoringVersion !== scores.score_provenance.scoring_version
          ? 'scoring_version_changed'
          : provenanceStatus.changedConstants.length
            ? 'scoring_inputs_changed'
            : 'user_requested_rescore',
      changed_constants: provenanceStatus.changedConstants,
      rescored_at: scores.score_provenance.computed_at,
    }
    : trip.score_provenance_change;
  return {
    ...trip,
    ...stats,
    ...scores,
    co2_saved_kg: economics.co2_saved_kg,
    route_points: routePoints,
    ...(sensorFusionSummary ? { sensor_fusion_summary: sensorFusionSummary } : {}),
    driving_events: drivingEvents,
    phone_usage_access_provenance: phoneUsageAccessProvenance.changed ? phoneUsageAccessProvenance : null,
    ...(scoreProvenanceChange ? { score_provenance_change: scoreProvenanceChange } : {}),
    feedback_adjusted_events_count: feedbackAdjusted.removed,
    needs_rescore: false,
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
};

const needsRescore = (trip, thresholds = buildDrivingThresholds(localSettings.get()), options = {}) => (
  trip?.status === 'completed' &&
  trip?.privacy_mode !== 'summary_only' &&
  !trip.route_data_expired_at &&
  (
    options.autoProvenanceTripIds?.has(trip.id) ||
    trip.needs_rescore ||
    hasRecoverableOriginalRouteGeometry(trip.route_points || []) ||
    trip.defensive_driving_score == null ||
    trip.brake_onset_sequence_count == null ||
    trip.heading_deviation_available == null ||
    trip.heading_drift_beta_available == null ||
    trip.braking_efficiency_grade == null ||
    trip.overall_compliance_score == null ||
    trip.dominant_road_type == null ||
    trip.co2_saved_kg == null ||
    trip.phone_use_score == null ||
    trip.phone_use_risk == null ||
    (Number(trip.phone_use_window_count) > 0 && !(trip.driving_events || []).some((event) => event?.type === 'phone_use')) ||
    trip.schema_version !== TRIP_SCHEMA_VERSION
  )
);

const rescoreTripsIfNeeded = async (trips = []) => {
  const next = [];
  const rescoredTrips = [];
  const thresholds = buildDrivingThresholds(localSettings.get());
  const autoProvenanceTripIds = autoRescoreProvenanceTripIds(trips, thresholds);
  const rescoreOptions = { autoProvenanceTripIds };
  const vehicles = await localVehicleRepository.list({ sort: '-created_date', limit: 500 }).catch(() => []);
  const total = trips.filter((trip) => needsRescore(trip, thresholds, rescoreOptions)).length;
  let completed = 0;
  if (total) emitRescoreProgress({
    status: 'running',
    completed,
    total,
    reason: autoProvenanceTripIds.size ? 'auto_provenance' : 'schema_refresh',
  });
  for (const trip of trips) {
    if (needsRescore(trip, thresholds, rescoreOptions)) {
      const rescored = rescoreTrip(trip, vehicles);
      rescoredTrips.push(rescored);
      next.push(rescored);
      completed += 1;
      emitRescoreProgress({
        status: 'running',
        completed,
        total,
        reason: autoProvenanceTripIds.has(trip.id) ? 'auto_provenance' : 'schema_refresh',
      });
    } else {
      next.push(trip);
    }
  }
  if (rescoredTrips.length) {
    await putTrips(rescoredTrips);
    emitRescoreProgress({
      status: 'complete',
      completed,
      total,
      reason: autoProvenanceTripIds.size ? 'auto_provenance' : 'schema_refresh',
    });
  }
  return next;
};

const importNativeCompletedTrips = async () => {
  if (!isAndroid() || importingNativeTrips) return;

  importingNativeTrips = true;
  try {
    const nativeTrips = await getNativeCompletedTrips();
    if (!nativeTrips.length) return;

    const vehicles = await localVehicleRepository.list({ sort: '-created_date', limit: 500 }).catch(() => []);
    for (const trip of nativeTrips) {
      const routePoints = trip.route_points || [];
      const settings = localSettings.get();
      const thresholds = buildDrivingThresholds(settings);
      const privacyZones = getPrivacyZones(settings);
      const stats = preserveNativePrivacyAggregateStats(
        trip,
        calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds, {
          ...trip,
          raw_route_points: routePoints,
        })
      );
      const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(routePoints, thresholds, trip.end_time, privacyZones);
      const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, detectedPhoneUse);
      const motionSamples = Array.isArray(trip.motion_samples) ? trip.motion_samples : [];
      const sensorFusionSummary = motionSamples.length
        ? buildSensorFusionSummary(motionSamples, routePoints, null, events)
        : trip.sensor_fusion_summary;
      const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, {
        endTime: trip.end_time,
        privacyZones,
        motionSamples,
        orientationCalibration: sensorFusionSummary?.phone_orientation,
      });
      const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, vehicleForTrip(trip, vehicles), settings);
      const drivingEvents = maskEventsForPrivacy(
        mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || events, phoneUse),
        { privacy_zones: privacyZones }
      );

      const importedTrip = {
        ...trip,
        ...stats,
        ...scores,
        co2_saved_kg: economics.co2_saved_kg,
        route_points: routePoints,
        route_points_raw_count: Number(trip.route_points_raw_count) || routePoints.length,
        route_points_map_count: Number(trip.route_points_map_count) || routePoints.length,
        ...(sensorFusionSummary ? { sensor_fusion_summary: sensorFusionSummary } : {}),
        driving_events: drivingEvents,
        imported_from_native: true,
        schema_version: TRIP_SCHEMA_VERSION,
        updated_at: trip.updated_at || new Date().toISOString(),
      };

      await putTrip(importedTrip);

      const finalPoint = [...routePoints].reverse().find((point) => point?.lat != null && point?.lng != null);
      const endedStopped = importedTrip.parking_stop_detected ||
        Number(importedTrip.parking_stop_duration_seconds || 0) > 0 ||
        Number(finalPoint?.speed_kmh || 0) < (thresholds.IDLE_SPEED_KMH ?? 5);
      if (finalPoint && endedStopped) {
        await saveLastParkedLocation({
          lat: finalPoint.lat,
          lng: finalPoint.lng,
          timestamp: importedTrip.end_time || finalPoint.timestamp || new Date().toISOString(),
          tripId: importedTrip.id,
          source: importedTrip.parking_stop_detected ? 'native_parking_stop' : 'native_stopped_trip_end',
        });
        // Native background trips update the shared parked location only when they ended stopped.
      }
    }

    await clearNativeCompletedTrips();
    await invalidateTripDerivedCaches();
  } catch {
    // The existing JS store remains usable if the native bridge is unavailable.
  } finally {
    importingNativeTrips = false;
  }
};

const deleteTrip = async (id) => {
  try {
    const db = await openDb();
    try {
      const recordFound = await secureDelete(db, TRIP_STORE, id);
      return {
        recordFound,
        deletionMethod: 'indexeddb_overwrite_then_delete',
      };
    } finally {
      db.close();
    }
  } catch {
    const trips = await getEncryptedJson(TRIPS_KEY, []);
    const remainingTrips = trips.filter((trip) => String(trip.id) !== String(id));
    await setEncryptedJson(TRIPS_KEY, remainingTrips);
    return {
      recordFound: remainingTrips.length !== trips.length,
      deletionMethod: 'encrypted_collection_rewrite',
    };
  }
};

const pruneExpiredTrips = async () => {
  const retentionDays = Number(localSettings.get().data_retention_days || 0);
  if (!retentionDays) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const trips = await getAllTrips();
  const expired = trips.filter((trip) => {
    const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
    return Number.isFinite(when) && when > 0 && when < cutoff;
  });

  for (const trip of expired) {
    await deleteTrip(trip.id);
  }
};

const coordinateFields = [
  'lat',
  'lng',
  'latitude',
  'longitude',
  'original_lat',
  'original_lng',
  'matched_lat',
  'matched_lng',
];

const stripCoordinates = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const next = { ...value };
  coordinateFields.forEach((field) => {
    delete next[field];
  });
  return next;
};

const stripCoordinatesFromList = (value) => (
  Array.isArray(value) ? value.map(stripCoordinates) : value
);

export function expireTripRouteData(trip, retentionDays, expiredAt = Date.now()) {
  if (!trip || typeof trip !== 'object' || trip.route_data_expired_at) return trip;
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (!routePoints.length) return trip;

  return {
    ...trip,
    route_points: [],
    route_points_raw_count: Number(trip.route_points_raw_count) || routePoints.length,
    route_points_map_count: 0,
    driving_events: stripCoordinatesFromList(trip.driving_events),
    phone_proxy_events: stripCoordinatesFromList(trip.phone_proxy_events),
    phone_use_events: stripCoordinatesFromList(trip.phone_use_events),
    native_phone_usage_events: stripCoordinatesFromList(trip.native_phone_usage_events),
    native_tracking_timeline: stripCoordinatesFromList(trip.native_tracking_timeline),
    start_address: null,
    end_address: null,
    route_data_expired_at: new Date(expiredAt).toISOString(),
    route_data_retention_days: retentionDays,
    route_data_expiration_reason: 'raw_gps_retention_policy',
    needs_rescore: false,
    updated_at: new Date(expiredAt).toISOString(),
  };
}

export async function getRawGpsLifecycleStatus() {
  const state = await getJson(RAW_GPS_LIFECYCLE_STATE_KEY, {});
  return state && typeof state === 'object' ? state : {};
}

let rawGpsEnforcementPromise = null;

export async function enforceRawGpsRetention({ force = false, now = Date.now() } = {}) {
  if (rawGpsEnforcementPromise) return rawGpsEnforcementPromise;

  rawGpsEnforcementPromise = (async () => {
    const retentionDays = Number(localSettings.get().raw_gps_retention_days || 0);
    const previous = await getRawGpsLifecycleStatus();
    if (!retentionDays) {
      return { enabled: false, purgedTrips: 0, purgedPoints: 0, lastRunAt: previous.lastRunAt || null };
    }
    if (!force && Number(previous.lastRunAt) > 0 && now - Number(previous.lastRunAt) < RAW_GPS_LIFECYCLE_INTERVAL_MS) {
      return {
        enabled: true,
        skipped: true,
        purgedTrips: 0,
        purgedPoints: 0,
        lastRunAt: Number(previous.lastRunAt),
      };
    }

    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    const trips = await getAllTrips();
    const expiredTrips = [];
    let purgedPoints = 0;

    for (const trip of trips) {
      const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
      if (
        trip.status !== 'completed' ||
        !Number.isFinite(when) ||
        when <= 0 ||
        when >= cutoff ||
        trip.route_data_expired_at
      ) continue;
      const expired = expireTripRouteData(trip, retentionDays, now);
      if (expired === trip) continue;
      purgedPoints += Array.isArray(trip.route_points) ? trip.route_points.length : 0;
      expiredTrips.push(expired);
    }

    if (expiredTrips.length) {
      await putTrips(expiredTrips);
      await invalidateTripDerivedCaches();
      try {
        await appendPrivacyEvent({
          op: 'RAW_GPS_AUTO_PURGED',
          details: {
            purged_trip_count: expiredTrips.length,
            purged_point_count: purgedPoints,
            reason: `raw_gps_retention_${retentionDays}d`,
          },
        });
      } catch (error) {
        logSystemFailure('raw_gps_retention_audit_append', error, {
          purged_trip_count: expiredTrips.length,
        });
      }
      recordSystemEvent('raw_gps_retention_enforced', {
        retention_days: retentionDays,
        purged_trip_count: expiredTrips.length,
        purged_point_count: purgedPoints,
      }, {
        category: 'privacy',
        title: 'Expired route data removed',
        message: `Removed route coordinates from ${expiredTrips.length} old trip${expiredTrips.length === 1 ? '' : 's'} while keeping summaries.`,
      });
    }

    const state = {
      lastRunAt: now,
      retentionDays,
      purgedTrips: expiredTrips.length,
      purgedPoints,
    };
    await setJson(RAW_GPS_LIFECYCLE_STATE_KEY, state);
    return { enabled: true, ...state };
  })();

  try {
    return await rawGpsEnforcementPromise;
  } finally {
    rawGpsEnforcementPromise = null;
  }
}

const sortTrips = (trips, sort) => {
  const field = sort?.replace('-', '') || 'start_time';
  const dir = sort?.startsWith('-') ? -1 : 1;
  return [...trips].sort((a, b) => {
    const av = a[field] || '';
    const bv = b[field] || '';
    return av > bv ? dir : av < bv ? -dir : 0;
  });
};

const withId = (trip) => ({
  ...normalizeRetiredTripEventTypes({
    id: trip.id || `trip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...trip,
    schema_version: trip.schema_version || TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  }),
});

export const localTripRepository = {
  async list({ sort = '-start_time', limit = 100 } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    await migrateRetiredTripEventTypesOnce();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    return sortTrips(trips, sort).slice(0, limit);
  },

  async listAll({ sort = '-start_time' } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    await migrateRetiredTripEventTypesOnce();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    return sortTrips(trips, sort);
  },

  async getById(id) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    await migrateRetiredTripEventTypesOnce();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    const trip = trips.find((item) => String(item.id) === String(id));
    if (!trip) throw new Error('Trip not found');
    return trip;
  },

  async create(trip) {
    const saved = /** @type {Record<string, any>} */ (withId({ ...trip, created_at: new Date().toISOString() }));
    const storageSaved = await sanitizeTripForPrivacyStorageAsync(saved);
    await putTrip(storageSaved);
    if (storageSaved.status === 'completed') await invalidateTripDerivedCaches();
    await pruneExpiredTrips();
    return storageSaved;
  },

  async update(id, patch) {
    const current = await this.getById(id);
    const updated = /** @type {Record<string, any>} */ (withId({ ...current, ...patch, id: current.id }));
    const storageUpdated = await sanitizeTripForPrivacyStorageAsync(updated);
    await putTrip(storageUpdated);
    if (storageUpdated.status === 'completed') await invalidateTripDerivedCaches();
    return storageUpdated;
  },

  async delete(id) {
    const result = await deleteTrip(id);
    recordSystemEvent('secure_trip_deletion_completed', {
      deletion_method: result.deletionMethod,
      record_found: result.recordFound,
      encrypted_at_rest: true,
      physical_media_guarantee: false,
    }, {
      category: 'storage',
      title: 'Secure trip deletion completed',
      message: result.recordFound
        ? 'The encrypted trip record was overwritten or rewritten before logical removal.'
        : 'No matching local trip record remained to delete.',
    });
    return {
      success: true,
      deletion_method: result.deletionMethod,
      record_found: result.recordFound,
    };
  },

  async upsertMany(trips = []) {
    const thresholds = buildDrivingThresholds(localSettings.get());
    const vehicles = await localVehicleRepository.list({ sort: '-created_date', limit: 500 }).catch(() => []);
    const rescoredTrips = trips.map((trip) => {
      const next = withId({
        ...trip,
        created_at: trip.created_at || trip.start_time || new Date().toISOString(),
      });
      return needsRescore(next, thresholds) ? rescoreTrip(next, vehicles) : next;
    });
    const normalized = await sanitizeTripsForPrivacyStorage(rescoredTrips);
    await putTrips(normalized);
    if (normalized.some((trip) => trip.status === 'completed')) await invalidateTripDerivedCaches();
    await pruneExpiredTrips();
    return normalized;
  },

  async markCompletedForRescore({ onlyProvenanceMismatch = false } = {}) {
    const thresholds = buildDrivingThresholds(localSettings.get());
    const trips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    let count = 0;
    const updated = trips.map((trip) => (
      trip.status === 'completed' &&
      (!onlyProvenanceMismatch || getScoreProvenanceStatus(trip, thresholds).needsRescore)
        ? { ...trip, needs_rescore: true, updated_at: new Date().toISOString(), score_update_acknowledged_at: null }
        : trip
    )).map((trip, index) => {
      if (trip !== trips[index]) count += 1;
      return trip;
    });
    await putTrips(updated);
    if (count) await invalidateTripDerivedCaches();
    return count;
  },

  async getScoreMigrationSummary() {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    await migrateRetiredTripEventTypesOnce();
    const thresholds = buildDrivingThresholds(localSettings.get());
    const trips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const completed = trips.filter((trip) => trip.status === 'completed');
    const mismatched = completed
      .map((trip) => ({ trip, provenance: getScoreProvenanceStatus(trip, thresholds) }))
      .filter(({ provenance }) => provenance.needsRescore);
    const recentCompleted = recentCompletedTrips(trips);
    const recentMismatched = recentCompleted
      .map((trip) => ({ trip, provenance: getScoreProvenanceStatus(trip, thresholds) }))
      .filter(({ provenance }) => provenance.needsRescore);
    const recentMismatchRatio = recentCompleted.length
      ? recentMismatched.length / recentCompleted.length
      : 0;
    return {
      scoring_version: SCORING_VERSION,
      completed_count: completed.length,
      mismatch_count: mismatched.length,
      recent_window_days: AUTO_RESCORE_RECENT_WINDOW_DAYS,
      recent_completed_count: recentCompleted.length,
      recent_mismatch_count: recentMismatched.length,
      recent_mismatch_ratio: Math.round(recentMismatchRatio * 100) / 100,
      auto_rescore_threshold_ratio: AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
      auto_rescore_recommended: recentMismatchRatio > AUTO_RESCORE_OUTDATED_PROVENANCE_RATIO,
      unavailable_score_count: completed.filter((trip) => trip.score_overall == null).length,
      event_migration_version: Number(await getJson(TRIP_EVENT_MIGRATION_KEY, 0)) || 0,
      trips: mismatched.map(({ trip, provenance }) => ({
        id: trip.id,
        start_time: trip.start_time,
        nickname: trip.nickname || '',
        scoring_version: trip.score_version || trip.score_provenance?.version || trip.score_provenance?.scoring_version || null,
        status: provenance.status,
        reason: provenance.reason,
        changed_constants: provenance.changedConstants,
      })),
    };
  },
};
