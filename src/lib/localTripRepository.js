import { STORAGE_PRESENCE, getJson, probeStoredJson, removeJson, setJson } from '@/lib/mobileStorage';
import { MONOLITHIC_DOCUMENT_OWNER, monolithicOwnerless } from '@/lib/monolithicCompatibility';
import {
  acknowledgeNativeCompletedTrips,
  getNativeCompletedTripPage,
} from '@/lib/activityRecognition';
import { nativeTripArchive } from '@/lib/nativeTripArchive';
import {
  attemptPendingProjectionDiscard,
  consumeProjectionDiscardAllowance,
  hasPendingProjectionDiscard,
  runUnderProjectionBarrier,
} from '@/lib/nativeProjectionBarrier';
import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import { isAndroid } from '@/lib/nativePlatform';
import { eventRatePerDistance } from '@/lib/mathUtils';
import { RESCORE_PROGRESS_EVENT } from '@/lib/tripRepositoryEvents';
import {
  applyEventFeedbackToEvents,
  applyEventFeedbackToPhoneUseWith,
  eventFeedbackKey,
  reconcileEventFeedbackKeys,
} from '@/lib/eventFeedbackKeys';
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
import { activeTripStore, localSettings } from '@/lib/trackingStore';
import {
  sanitizeTripForPrivacyStorageAsync,
} from '@/lib/privacyZones';
import { prepareScoreInputsForPrivacy } from '@/lib/scoreInputPrivacy';
import { appendScoreChangeEntry, buildScoreChangeEntry } from '@/lib/scoring/scoreChangeLedger';
import { invalidateDangerZoneCache } from '@/lib/dangerZoneEngine';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  buildPhoneUseFromEvents,
  buildPhoneUsageAccessProvenance,
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
} from '@/lib/phoneUsageAccess';
import { hasRecoverableOriginalRouteGeometry, restoreOriginalRouteGeometry } from '@/lib/mapPlaybackInsights';
import { buildSensorFusionSummary } from '@/lib/sensorFusionModel';
import {
  decryptSensitiveValues,
  decryptSensitiveValue,
  encryptSensitiveValues,
  encryptSensitiveValue,
  getActiveEncryptionKeyVersion,
  getEncryptedJson,
  isEncryptedPayload,
  MAX_SECURE_BATCH_RECORDS,
  secureDecryptBatchPrefixLength,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { isSecureDeleteTombstone, secureDelete } from '@/lib/encryptedStore';
import { assertDurablePublication, withDurableKeyPublication } from '@/lib/browserKeyReferences';
import { publishP7SourceChange } from '@/lib/p7SourceChange';
import { appendPrivacyEvent } from '@/lib/hashChainLog';
import { buildTripSummary } from '@/lib/tripSummary';
import { buildTripProjection, ProjectionBuildError } from '@/lib/tripProjection';
import { PROJECTION_STALE_VERSION } from '@/lib/tripProjectionSchema';
import { assertProjectionQuery } from '@/lib/tripProjectionQuery';
import {
  P7_COMPLETENESS,
  P7_UNAVAILABLE_CODES,
  assertP7PublicLimit,
} from '@/lib/queryContracts/envelope';
import {
  decodeTripCursorV2,
  encodeTripCursorV2,
  normalizeCursorBind,
} from '@/lib/tripQueryCursor';
import {
  classifyProjectionRows,
  decodeProjectionPayloads,
  encodeProjectionPayloads,
  mintSourceRevision,
  projectionEncryptionContext,
  projectionFailureMarkerFor,
  projectionRecordFor,
  readProjectionRecords,
  selectSourceWindow,
} from '@/lib/tripProjectionStore';
import { asTripListModel, overflowBitsOf } from '@/lib/tripListModel';
import {
  MAX_CHUNK_LOGICAL_CHARGE,
  TripPersistenceFailedError,
  assertLogicalWriteBatch,
  chunkCharge,
  measureSourceTrip,
  nextWriteWindow,
} from '@/lib/tripWriteAdmission';
import {
  META_KEYS,
  PROJECTION_MAINTENANCE_PHASES,
  PROJECTION_SUBPASS_MAX_EXAMINED,
  defaultFallbackSuppression,
  defaultNativeErasurePending,
  defaultNativeVisibility,
  fallbackRowVisible,
  fallbackReadable,
  nativeImportSuppressed,
  recordDeleteForNative,
  suppressFallbackId,
} from '@/lib/tripProjectionMaintenance';
import { readIndexWindow, runBackfillTurn, runCleanupTurn, runVerifyTurn } from '@/lib/tripProjectionRunner';
import { applyWeatherRiskToScores } from '@/lib/weatherContext';
import {
  dispatchNativeManualTripFinalized,
  findNativeManualCompletion,
  isNativeManualCompletionForActiveTrip,
} from '@/lib/nativeManualTripIdentity';

export const TRIPS_KEY = 'drivesense_trips';

/**
 * Durable global fail-closed barrier covering the fallback trip blob during a
 * data-rights erasure.
 *
 * It lives beside the blob rather than in `trip_meta` on purpose: the window it
 * guards is exactly the window in which the IndexedDB overlay is being torn
 * down, and it must still fail closed when IndexedDB is unavailable entirely.
 * One boolean record, never a list, so it stays O(1) regardless of history.
 */
/**
 * P4-C-F04/F05 — the O(1) reference record for the monolithic fallback blob.
 *
 * The blob itself is a single JSON document, so nothing bounded may read it.
 * Every writer of `TRIPS_KEY` therefore also records *what key version it is
 * now under* in this constant-size record, which is the only thing a lifecycle
 * turn or a KEK finalization is allowed to consult about it.
 *
 * `known: false` means no writer has stamped it yet; callers must then treat
 * the document as possibly still holding ciphertext under a retiring key.
 */
export const TRIPS_FALLBACK_REFERENCE_KEY = 'drivesense_trips_fallback_reference_v1';

/**
 * Write the fallback trips document and stamp its reference record.
 *
 * Every `setEncryptedJson(TRIPS_KEY, ...)` in this module goes through here so
 * the reference can never drift from the ciphertext it describes.
 */
const writeFallbackTripsDocument = async (value, options = {}) => {
  await setEncryptedJson(TRIPS_KEY, value, options);
  let keyVersion = Math.max(0, Number(options.keyVersion) || 0);
  if (!keyVersion) {
    keyVersion = Math.max(0, Number(await getActiveEncryptionKeyVersion().catch(() => 0)) || 0);
  }
  await setJson(TRIPS_FALLBACK_REFERENCE_KEY, {
    present: true,
    keyVersion: keyVersion || null,
    updatedAt: Date.now(),
  });
};

/** Record that the fallback document no longer exists. */
const clearFallbackTripsReference = () => setJson(TRIPS_FALLBACK_REFERENCE_KEY, {
  present: false,
  keyVersion: null,
  updatedAt: Date.now(),
});

/**
 * What the fallback trip document currently references, at fixed cost.
 *
 * Presence falls back to a key-enumeration probe (bounded by the number of
 * storage keys, never by the document's size) so a blob written by a build
 * older than this record is still noticed rather than silently retired.
 *
 * P4-C-F05: `present` is tri-state - `true`, `false`, or `null` when the probe
 * could not answer. A caller must never read `null` as "absent".
 */
export async function readFallbackTripDocumentReference() {
  const stored = await getJson(TRIPS_FALLBACK_REFERENCE_KEY, null);
  if (stored && typeof stored === 'object' && typeof stored.present === 'boolean') {
    return {
      known: true,
      present: stored.present,
      keyVersion: Number(stored.keyVersion) || null,
      owner: MONOLITHIC_DOCUMENT_OWNER,
    };
  }
  const probe = await probeStoredJson(TRIPS_KEY);
  const present = probe === STORAGE_PRESENCE.PRESENT
    ? true
    : probe === STORAGE_PRESENCE.ABSENT ? false : null;
  return { known: false, present, keyVersion: null, owner: MONOLITHIC_DOCUMENT_OWNER };
}

/** Does this reference leave any possibility that the document exists? */
export const fallbackTripDocumentMayExist = (reference) => reference?.present !== false;

/**
 * Is every obligation the fallback document holds against `retiringVersion`
 * discharged, so that key version may be destroyed?
 *
 * P4-C-F05: only a *proven* absence releases the key. An unstamped document, or
 * a presence probe that could not enumerate storage at all, both retain it -
 * retaining a key costs a key slot, releasing one wrongly loses the archive.
 */
export async function fallbackTripDocumentReleasesKey(retiringVersion) {
  const reference = await readFallbackTripDocumentReference();
  if (reference.present === false) return true;
  // `null` is "the probe could not answer" and is never permission to destroy.
  if (reference.present !== true) return false;
  if (!reference.known || !reference.keyVersion) return false;
  return reference.keyVersion > Math.max(0, Number(retiringVersion) || 0);
}

export const TRIPS_ERASURE_BARRIER_KEY = 'drivesense_trips_erasure_barrier_v1';
export const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';
export const RAW_GPS_LIFECYCLE_STATE_KEY = 'drivesense_raw_gps_lifecycle_state_v1';
export const RAW_GPS_LIFECYCLE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DB_NAME = 'drivesense_mobile';
export const DB_NAME_META_KEY = 'drivesense_indexeddb_name';
export const DB_NAME = String(import.meta.env.VITE_DB_NAME || DEFAULT_DB_NAME).trim() || DEFAULT_DB_NAME;
const TRIP_STORE = 'trips';
export const P6_TRIP_SOURCE_STORE = TRIP_STORE;
const TRIP_SUMMARY_STORE = 'trip_summaries';
/** P3 projection cache. `trips` remains the source of identity, order and truth. */
export const TRIP_PROJECTION_STORE = 'trip_projections';
/** P3 projection-local migration/verify/cleanup/suppression state. Not P5's coordinator. */
export const TRIP_META_STORE = 'trip_meta';
export const P6_TRIP_DERIVED_STORES = Object.freeze({
  CONTROL: 'p6_control',
  WORK: 'p6_trip_work',
  SOURCE_APPLIED: 'p6_source_applied',
  CONTRIBUTIONS: 'p6_trip_contributions',
  ANALYTICS_BUCKETS: 'p6_analytics_buckets',
  RECENT_ORDER: 'p6_recent_order',
  GEOMETRY_CHUNKS: 'p6_geometry_chunks',
  SPATIAL_POSTINGS: 'p6_trip_spatial_postings',
  ROAD_OBSERVATIONS: 'p6_road_observations',
  ROAD_WINDOWS: 'p6_road_windows',
  MANIFESTS: 'p6_manifests',
});
const P6_BROWSER_DOMAIN_IDS = Object.freeze([
  'D1_ANALYTICS', 'D2_GEOMETRY', 'D3_SPATIAL_SELECTION', 'D4_ROAD_LEARNING_SPEED_LOOKUP',
]);
const dirtyP6GlobalHeads = (store, reason) => {
  P6_BROWSER_DOMAIN_IDS.forEach((domain) => store.put({
    key: `${domain}:all`, domain, subject: 'all', state: 'DIRTY', complete: false,
    reason, updatedAt: Date.now(),
  }));
};
export const NATIVE_PROJECTION_STATE_KEY = 'p35_native_projection_state_v1';

/**
 * P7 browser query revision (Annex A §A2.4).
 *
 * This is **query metadata, not canonical authority**: it never gates a
 * canonical read or write, never appears in a backup, never participates in
 * recovery, and never substitutes for a P3.5 generation. It lives under one new
 * key in the existing `trip_meta` store — no new database, store or index — and
 * exists only so a cursor v2 token can be refused before any row is returned
 * once the row set it was minted against has changed.
 *
 * `generation` is the conservative epoch: re-minting it invalidates every
 * outstanding cursor at once. `revision` is the monotonic per-mutation counter
 * advanced inside the mutation's own projection-write transaction.
 */
export const P7_QUERY_REVISION_KEY = 'p7_query_revision_v1';
export const TRIP_INDEX_START_TIME_ID = 'by_start_time_id';
export const TRIP_INDEX_STATUS_START_TIME_ID = 'by_status_start_time_id';
/** Bounded page ceiling enforced inside the repository so no caller can widen it. */
export const MAX_PROJECTION_PAGE = 500;
export const DEFAULT_PROJECTION_PAGE = 100;
export const TRIP_SCHEMA_VERSION = 27;
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
 *
 * Version 24 recalculates distance without dropping frequent vehicle-speed GPS
 * samples below the accuracy-derived movement floor.
 *
 * Version 25 reruns that distance migration and refreshes outdated history
 * summaries synchronously before trip cards are returned.
 *
 * Version 26 stops a smaller legacy native distance from overriding a larger
 * route recalculation when privacy-masked points are present.
 */

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const makeAbortError = () => {
  const error = new Error('Operation cancelled.');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw makeAbortError();
};

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

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

const getTripSummaryStoreForUpgrade = (db, transaction) => {
  if (!hasStore(db, TRIP_SUMMARY_STORE)) {
    return db.createObjectStore(TRIP_SUMMARY_STORE, { keyPath: 'id' });
  }
  return transaction.objectStore(TRIP_SUMMARY_STORE);
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
  {
    version: 2,
    migrate({ db, transaction }) {
      const store = getTripSummaryStoreForUpgrade(db, transaction);
      ensureTripIndex(store, 'start_time', 'start_time');
      ensureTripIndex(store, 'status', 'status');
    },
  },
  {
    // P3. Compound source-store indexes make a bounded keyset walk expressible:
    // an `IDBKeyRange` constrains only the index key, so the primary key has to
    // be part of that key rather than an implicit tie-breaker. The projection
    // store mirrors `['start_time','id']` so the completeness verifier can merge
    // both cursors in one ordering.
    //
    // The upgrade creates stores and indexes only. Existing rows have no
    // `source_revision`, and it is deliberately not indexed, so its absence
    // cannot drop a row out of any index.
    version: 3,
    migrate({ db, transaction }) {
      const trips = getTripStoreForUpgrade(db, transaction);
      ensureTripIndex(trips, TRIP_INDEX_START_TIME_ID, ['start_time', 'id']);
      ensureTripIndex(trips, TRIP_INDEX_STATUS_START_TIME_ID, ['status', 'start_time', 'id']);

      const projections = hasStore(db, TRIP_PROJECTION_STORE)
        ? transaction.objectStore(TRIP_PROJECTION_STORE)
        : db.createObjectStore(TRIP_PROJECTION_STORE, { keyPath: 'id' });
      ensureTripIndex(projections, TRIP_INDEX_START_TIME_ID, ['start_time', 'id']);
      ensureTripIndex(projections, 'projection_version', 'projection_version');
      ensureTripIndex(projections, 'status', 'status');

      if (!hasStore(db, TRIP_META_STORE)) {
        db.createObjectStore(TRIP_META_STORE, { keyPath: 'key' });
      }
    },
  },
  {
    // P6 creates only empty derived stores and indexes during upgrade. No
    // retained trip is read or decoded here.
    version: 4,
    migrate({ db }) {
      const create = (name, keyPath = 'key') => (
        hasStore(db, name) ? null : db.createObjectStore(name, { keyPath })
      );
      const control = create(P6_TRIP_DERIVED_STORES.CONTROL);
      const work = create(P6_TRIP_DERIVED_STORES.WORK, 'tripId');
      if (work) {
        work.createIndex('by_desired_seq', 'desiredSeq');
        work.createIndex('by_state', 'state');
      }
      create(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED);
      create(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS);
      create(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
      const recent = create(P6_TRIP_DERIVED_STORES.RECENT_ORDER);
      if (recent) recent.createIndex('by_source_start_id', ['sourceBinding', 'startTime', 'tripId']);
      const geometry = create(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS);
      if (geometry) geometry.createIndex('by_trip_version_ordinal', ['tripId', 'contentVersion', 'ordinal']);
      const postings = create(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS);
      if (postings) {
        postings.createIndex('by_cell_trip', ['sourceBinding', 'cellToken', 'tripId', 'sourceRevision', 'blockOrdinal']);
      }
      const observations = create(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS);
      if (observations) observations.createIndex('by_trip_revision_ordinal', ['tripId', 'sourceRevision', 'ordinal']);
      create(P6_TRIP_DERIVED_STORES.MANIFESTS);
      if (control) {
        control.put({ key: 'schema', version: 1, writersEnabled: false, updatedAt: Date.now() });
      }
    },
  },
  {
    // P6 cleanup/query indexes. This remains fixed metadata work: adding an
    // index asks IndexedDB to maintain its normal upgrade machinery and does
    // not run application JavaScript over retained records.
    version: 5,
    migrate({ db, transaction }) {
      const ensureP6Index = (storeName, indexName, keyPath) => {
        if (!hasStore(db, storeName)) return;
        ensureTripIndex(transaction.objectStore(storeName), indexName, keyPath);
      };
      ensureP6Index(P6_TRIP_DERIVED_STORES.RECENT_ORDER, 'by_trip', 'tripId');
      ensureP6Index(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'by_trip', 'tripId');
      ensureP6Index(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'by_trip', 'tripId');
      ensureP6Index(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, 'by_trip', 'tripId');
    },
  },
  {
    version: 6,
    migrate({ db, transaction }) {
      if (hasStore(db, P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS)) {
        ensureTripIndex(transaction.objectStore(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS), 'by_trip_ordinal', ['tripId', 'ordinal']);
      }
    },
  },
  {
    // Exact road-window reducer state. Rows contain only encrypted payloads;
    // the indexes expose owner identity, phase and ordinal, never location.
    version: 7,
    migrate({ db }) {
      if (!hasStore(db, P6_TRIP_DERIVED_STORES.ROAD_WINDOWS)) {
        const windows = db.createObjectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS, { keyPath: 'key' });
        windows.createIndex('by_trip', 'tripId');
        windows.createIndex('by_trip_window', ['tripId', 'sourceRevision', 'windowOrdinal']);
        windows.createIndex('by_trip_state', ['tripId', 'sourceRevision', 'state', 'windowOrdinal']);
      }
    },
  },
  {
    // P6 analytics values moved from clear structured-clone fields to the
    // existing protected-payload envelope. Upgrade only revokes the aggregate
    // head; E1 performs the bounded derived reset and rebuild.
    version: 8,
    migrate({ db, transaction }) {
      if (hasStore(db, P6_TRIP_DERIVED_STORES.MANIFESTS)) {
        transaction.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
          key: 'D1_ANALYTICS:all',
          domain: 'D1_ANALYTICS',
          subject: 'all',
          sourceBinding: 'browser',
          state: 'REBUILD_REQUIRED',
          complete: false,
          reason: 'ENCRYPTED_ANALYTICS_REBUILD_REQUIRED',
          updatedAt: Date.now(),
        });
      }
    },
  },
  {
    // `by_trip_version` duplicated `by_trip` for every spatial posting and had
    // no reader. At the frozen 3M-point fixture its entries alone cost tens of
    // megabytes, so it is dropped rather than maintained: the P6 durable
    // footprint has to fit the frozen E(N,P,S) envelope, and an index nothing
    // queries is the cheapest byte to give back. Removing an index is fixed
    // metadata work and reads no retained record.
    version: 9,
    migrate({ db, transaction }) {
      if (!hasStore(db, P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS)) return;
      const postings = transaction.objectStore(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS);
      if (postings.indexNames.contains('by_trip_version')) postings.deleteIndex('by_trip_version');
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

const DB_OPEN_TIMEOUT_MS = 15_000;
const DB_OPEN_BLOCKED_MESSAGE = 'IndexedDB open blocked. Close any other Road Sage window or tab and try again.';

const openDbByName = (dbName) => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }

  const request = indexedDB.open(dbName, DB_VERSION);
  let settled = false;

  // A version upgrade held open by another live connection fires neither success nor error.
  // Without the handlers below the promise never settles and every trip read/write queued
  // behind it hangs silently, which presents to the user as total data loss.
  const timeoutId = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error(`IndexedDB open timed out for ${dbName}. ${DB_OPEN_BLOCKED_MESSAGE}`));
  }, DB_OPEN_TIMEOUT_MS);
  timeoutId?.unref?.();

  const settle = (finish, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    finish(value);
  };

  request.onupgradeneeded = (event) => {
    // Upgrading means we are past the blocked phase; a long migration must not trip the timeout.
    clearTimeout(timeoutId);
    tripDbMigrationRunner.migrate({
      db: request.result,
      oldVersion: event.oldVersion,
      transaction: request.transaction,
    });
    if (isAndroid()) {
      void nativeTripArchive.reportIndexedDbOpen({
        databaseName: dbName,
        oldVersion: Number(event.oldVersion) || 0,
        newVersion: Number(event.newVersion) || DB_VERSION,
      }).catch((error) => {
        logSystemFailure('p35_indexeddb_generation_signal', error, { db_name: dbName });
      });
    }
  };
  request.onsuccess = () => settle(resolve, request.result);
  request.onerror = () => settle(reject, request.error);
  request.onblocked = () => settle(reject, new Error(`${DB_OPEN_BLOCKED_MESSAGE} (${dbName})`));
});

const openDb = () => migrateConfiguredDbName().then(() => openDbByName(DB_NAME));

/** Selected browser trip owner seam for P6 derived-only transactions. */
export const openP6TripDerivedDatabase = () => openDb();

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
const tripSummaryEncryptionContext = (id) => `trip-summary:${String(id)}`;

/**
 * AUD-007 REDESIGN. The encoder is not the ownership boundary — but it is now the
 * ENFORCEMENT point.
 *
 * Wrapping the encoder in a token produced `capture → encrypt → release → (later) durable
 * commit`, so the token moved out to the durable transaction. That left the encoders
 * callable by anyone, and CODEX duly found two more persistent callers inside this very
 * module that encrypted and committed with no publication at all.
 *
 * The four trip encoders below therefore REQUIRE a live publication handle. They still do
 * not own admission and still just produce bytes; they simply refuse to produce
 * root-key-bound bytes for a caller that cannot prove it is inside a publication which
 * will carry them to a durable commit. A future persistent writer cannot forget to admit:
 * there is no handle to pass.
 */
const encodeTripRecord = async (trip, publication, options = {}) => {
  assertDurablePublication(publication, 'encodeTripRecord');
  const storageTrip = await sanitizeTripForPrivacyStorageAsync(trip);
  return {
    id: storageTrip.id,
    start_time: storageTrip.start_time || '',
    end_time: storageTrip.end_time || '',
    status: storageTrip.status || '',
    rsas_session_id: storageTrip.rsas_session_id || null,
    route_data_expired_at: storageTrip.route_data_expired_at || null,
    motion_samples_expired_at: storageTrip.motion_samples_expired_at || null,
    encrypted_payload: await encryptSensitiveValue(
      storageTrip,
      tripEncryptionContext(storageTrip.id),
      options
    ),
  };
};

const encodeTripSummaryRecord = async (trip, publication, options = {}) => {
  assertDurablePublication(publication, 'encodeTripSummaryRecord');
  const summary = buildTripSummary(trip);
  return {
    id: summary.id,
    start_time: summary.start_time || '',
    status: summary.status || '',
    encrypted_payload: await encryptSensitiveValue(
      summary,
      tripSummaryEncryptionContext(summary.id),
      options
    ),
  };
};

const decodeTripRecord = async (record) => {
  if (!isEncryptedPayload(record?.encrypted_payload)) return record;
  return decryptSensitiveValue(record.encrypted_payload, tripEncryptionContext(record.id));
};

const decodeTripRecords = async (records = [], options = {}) => {
  const source = Array.isArray(records) ? records : [];
  const decoded = await decryptSensitiveValues(source.map((record) => ({
    payload: isEncryptedPayload(record?.encrypted_payload) ? record.encrypted_payload : record,
    context: tripEncryptionContext(record?.id),
  })), options);
  return decoded;
};

const decodeTripSummaryRecords = async (records = [], options = {}) => {
  const source = Array.isArray(records) ? records : [];
  return decryptSensitiveValues(source.map((record) => ({
    payload: isEncryptedPayload(record?.encrypted_payload) ? record.encrypted_payload : record,
    context: tripSummaryEncryptionContext(record?.id),
  })), options);
};

// ─── P3 bounded projection path ───────────────────────────────────────────────
//
// Operation counters exist so scaling can be asserted directly rather than
// inferred from a passing test. They are test-only and never exported to P0.
const projectionCounters = {
  sourceRowsVisited: 0,
  projectionPointReads: 0,
  projectionDecrypts: 0,
  fullTripDecrypts: 0,
  hydrationReads: 0,
  repairBuilds: 0,
  historySorts: 0,
  wholeStoreGetAlls: 0,
};

export const __projectionCountersForTests = () => ({ ...projectionCounters });
export const __resetProjectionCountersForTests = () => {
  Object.keys(projectionCounters).forEach((key) => { projectionCounters[key] = 0; });
};

/**
 * Guarded projection write.
 *
 * The candidate revision is minted and the projection encrypted **outside** the
 * transaction, because an IndexedDB transaction cannot survive an awaited bridge
 * call. Inside the transaction the source row is re-read and the write proceeds
 * only if the row still exists, is not tombstoned, and its revision still equals
 * what was captured — with `ABSENT` a first-class value, so bootstrap and the
 * ordinary guarded put are one rule.
 */
/**
 * AUD-007 FINAL: the projection commit boundary. `encodeProjectionPayloads` hands back
 * bytes without a token; this is where those bytes become durable, so this owns it.
 */
const commitProjectionRecord = async (db, sourceRow, candidateRevision, record, reads = null) => withDurableKeyPublication(async () => {
  const tx = db.transaction([TRIP_STORE, TRIP_PROJECTION_STORE], 'readwrite');
  const trips = tx.objectStore(TRIP_STORE);
  const projections = tx.objectStore(TRIP_PROJECTION_STORE);
  // P4-C-F09: the guard re-reads the source row. That read is independent of
  // the window read that selected the row and is counted as its own unit.
  const fresh = await idbRequest(trips.get(sourceRow.id));
  if (reads) reads.count += 1;
  if (!fresh || isSecureDeleteTombstone(fresh)) {
    tx.abort();
    return false;
  }
  const currentRevision = fresh.source_revision ?? null;
  if (String(currentRevision ?? '') !== String(sourceRow.source_revision ?? '')) {
    tx.abort();
    return false;
  }
  if (currentRevision == null) {
    trips.put({ ...fresh, source_revision: candidateRevision });
  }
  projections.put(record);
  await idbTransactionDone(tx);
  return true;
});

/**
 * Build projections for the rows of one selected page that lack a usable one.
 * Bounded by the page: at most `page` full-trip reads, once per trip ever.
 */
/**
 * AUD-007 FINAL: projection repair encodes ciphertext and commits it further down. Both
 * halves belong to one publication, or the bytes escape the token in between — the exact
 * shape of the defect this correction exists to close.
 */
const repairProjectionsForRows = async (db, rows, reads = null) => withDurableKeyPublication(async (publication) => {
  if (!rows.length) return new Map();
  const built = new Map();
  const tx = db.transaction(TRIP_STORE, 'readonly');
  const store = tx.objectStore(TRIP_STORE);
  const records = await Promise.all(rows.map((row) => idbRequest(store.get(row.id))));
  // P4-C-F09: one independent source read per row, whether or not it turns out
  // to be repairable.
  if (reads) reads.count += rows.length;

  const decodable = [];
  records.forEach((record, index) => {
    if (record && !isSecureDeleteTombstone(record)) decodable.push({ row: rows[index], record });
  });
  if (!decodable.length) return built;

  projectionCounters.fullTripDecrypts += decodable.length;
  let trips;
  try {
    trips = await decodeTripRecords(decodable.map(({ record }) => record));
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // Source records share the projection payloads' all-or-error batch contract,
    // so one undecryptable trip would otherwise make the whole page unavailable
    // while repairing it. Isolation is bounded by the selected page and happens
    // only on this path; a member that still fails degrades its own row.
    logSystemFailure('trip_projection_repair_batch_isolated', error, {
      db_name: DB_NAME,
      row_count: decodable.length,
    });
    trips = [];
    for (const { record } of decodable) {
      try {
        const [trip] = await decodeTripRecords([record]);
        trips.push(trip);
      } catch (memberError) {
        if (memberError?.name === 'AbortError') throw memberError;
        trips.push(null);
      }
    }
  }

  const envelopes = [];
  const markers = [];
  for (let index = 0; index < decodable.length; index += 1) {
    const { row } = decodable[index];
    // An unreadable source cannot produce a projection. The row still appears in
    // the listing, served degraded, rather than taking the page with it.
    if (trips[index] == null) continue;
    const revision = row.source_revision ?? mintSourceRevision();
    const sanitized = await sanitizeTripForPrivacyStorageAsync(trips[index]);
    try {
      envelopes.push({
        row,
        revision,
        envelope: buildTripProjection(sanitized, { sourceRevision: revision }),
      });
    } catch (error) {
      // Deterministic contract failure only. A transient crypto/storage error is
      // not caught here and keeps its existing failure semantics.
      if (!(error instanceof ProjectionBuildError)) throw error;
      markers.push({ row, revision, marker: projectionFailureMarkerFor(row, error.failureClass) });
    }
  }

  if (envelopes.length) {
    projectionCounters.repairBuilds += envelopes.length;
    const payloads = await encodeProjectionPayloads(envelopes.map((entry) => entry.envelope), publication);
    for (let index = 0; index < envelopes.length; index += 1) {
      const { row, revision, envelope } = envelopes[index];
      const record = projectionRecordFor(envelope, payloads[index], row?.id);
      const committed = await commitProjectionRecord(db, row, revision, record, reads);
      if (committed) built.set(row.id, envelope);
    }
  }
  for (const { row, revision, marker } of markers) {
    await commitProjectionRecord(db, row, revision, marker, reads);
  }
  return built;
});

/**
 * Bounded exact-ID hydration, run **inside** the repository so a page cannot
 * escape to a consumer carrying a truncated exact identity or display value.
 */
const hydrateTruncatedProjections = async (db, entries) => {
  if (!entries.length) return new Map();
  projectionCounters.hydrationReads += entries.length;
  const tx = db.transaction(TRIP_STORE, 'readonly');
  const store = tx.objectStore(TRIP_STORE);
  const records = await Promise.all(entries.map(({ id }) => idbRequest(store.get(id))));
  const live = [];
  records.forEach((record, index) => {
    if (record && !isSecureDeleteTombstone(record)) live.push({ id: entries[index].id, record });
  });
  if (!live.length) return new Map();
  const trips = await decodeTripRecords(live.map(({ record }) => record));
  const byId = new Map();
  for (let index = 0; index < live.length; index += 1) {
    const trip = await sanitizeTripForPrivacyStorageAsync(trips[index]);
    byId.set(live[index].id, {
      nickname: trip.nickname,
      start_address: trip.start_address,
      end_address: trip.end_address,
      notes: trip.notes,
      tags: trip.tags,
      route_key: trip.route_key,
      vehicle_id: trip.vehicle_id,
    });
  }
  return byId;
};

/**
 * One bounded rescore window.
 *
 * Reads a single indexed window of source rows, rescores only those, writes them
 * through the chunked three-store writer and commits the cursor. It must never
 * call the legacy whole-history entry points (`markCompletedForRescore`,
 * `rescoreCompletedTrips`), which retain their O(N) arrays and remain later-phase
 * residuals — a mutation test asserts that.
 *
 * Bounded foreground reads never trigger this: `listSummaries` no longer
 * evaluates `needsRescore` over the history at all.
 *
 * @param {{ cursor?: any, limit?: number }} [options]
 */
export async function rescoreProjectionMaintenanceWindow({ cursor = null, limit = 8 } = {}) {
  if (!canUseIndexedDb()) return { cursor: null, rescored: 0, examined: 0, done: true };
  const db = await openDb();
  try {
    const rows = await readIndexWindow(db, {
      storeName: TRIP_STORE,
      indexName: TRIP_INDEX_START_TIME_ID,
      after: cursor,
      limit,
    });
    if (!rows.length) return { cursor: null, rescored: 0, examined: 0, done: true };

    const live = rows
      .map(({ value }) => value)
      .filter((record) => record && !isSecureDeleteTombstone(record));
    if (!live.length) {
      return { cursor: rows[rows.length - 1].key, rescored: 0, examined: rows.length, done: false };
    }

    const trips = await decodeTripRecords(live);
    const thresholds = buildDrivingThresholds(localSettings.get());
    const stale = trips.filter((trip) => needsRescore(trip, thresholds));
    let rescored = 0;
    if (stale.length) {
      const refreshed = await rescoreTripsIfNeeded(stale);
      // The chunked three-store writer keeps trip, legacy summary and projection
      // coherent under one revision per record.
      await putTrips(refreshed);
      rescored = refreshed.length;
    }
    // P4-C-F09: the window read, not only the rows that needed rescoring.
    return { cursor: rows[rows.length - 1].key, rescored, examined: rows.length, done: false };
  } finally {
    db.close();
  }
}

/** Bounded trip count. `count()` is an index/store operation, not a decrypt scan. */
const countStoredTrips = async () => {
  if (!canUseIndexedDb()) return 0;
  const db = await openDb();
  try {
    const tx = db.transaction(TRIP_STORE, 'readonly');
    return await idbRequest(tx.objectStore(TRIP_STORE).count());
  } finally {
    db.close();
  }
};

/**
 * Drive bounded rescore windows and **persist** the cursor between them.
 *
 * A primitive that returns a cursor no caller stores is not a resumable
 * maintenance system, so progress is committed to `trip_meta` after every window
 * and the next run resumes from it.
 */
const runRescoreMaintenanceWindows = async ({ maxWindows = 4 } = {}) => {
  if (!canUseIndexedDb()) return { rescored: 0, examined: 0, done: true };
  let rescored = 0;
  let examined = 0;
  let done = false;
  const db = await openDb();
  let state;
  try {
    state = await readTripMeta(db, META_KEYS.MAINTENANCE, { cursor: null, status: 'idle' });
  } finally {
    db.close();
  }
  let cursor = state.cursor ?? null;
  for (let window = 0; window < maxWindows; window += 1) {
    const result = await rescoreProjectionMaintenanceWindow({ cursor });
    rescored += result.rescored;
    examined += Math.max(0, Number(result.examined) || 0);
    cursor = result.cursor;
    const persistDb = await openDb();
    try {
      await writeTripMetaRecord(persistDb, META_KEYS.MAINTENANCE, {
        ...state, cursor, status: result.done ? 'complete' : 'running', updated_at: Date.now(),
      });
    } finally {
      persistDb.close();
    }
    await yieldToEventLoop();
    if (result.done) { done = true; break; }
  }
  return { rescored, examined, done };
};

/**
 * Distinguish "the store itself is unusable" from "one selected page failed".
 *
 * Only the former justifies the legacy whole-history read. Projection crypto,
 * authentication and envelope failures are repaired or degraded within the
 * selected page, so they can never become recurring O(history) foreground work.
 */
const isPrimaryStorageUnavailable = (error) => {
  if (!canUseIndexedDb()) return true;
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'VersionError') return true;
  if (name === 'QuotaExceededError' || name === 'AbortError') return true;
  return /IndexedDB (unavailable|open (timed out|blocked))|Missing object store|blocked/i.test(message);
};

/**
 * Drive the projection maintenance runners for a bounded number of turns.
 *
 * Total backfill/verification/cleanup work is O(N), but each turn is bounded,
 * commits its own cursor and yields, so an unrelated foreground operation never
 * pays for the whole history. Nothing here is required before first render — the
 * bounded read path is correct at zero migration progress.
 *
 * @param {{ maxTurns?: number }} [options]
 */
/**
 * Repair the rows one verification turn reported as mismatched.
 *
 * A mismatch is repaired through the same guarded path the read uses, so a
 * concurrent update or delete aborts the write rather than winning.
 */
const repairVerifiedMismatches = async (db, rows) => {
  // P4-C-F09: every source row this repair independently re-reads, reported to
  // the verifier as the current invocation's own read consumption.
  const reads = { count: 0 };
  const tx = db.transaction(TRIP_STORE, 'readonly');
  const store = tx.objectStore(TRIP_STORE);
  const records = await Promise.all(rows.map(({ id }) => idbRequest(store.get(id))));
  reads.count += rows.length;
  const live = [];
  const orphans = [];
  records.forEach((record, index) => {
    if (record && !isSecureDeleteTombstone(record)) {
      live.push({
        id: record.id,
        start_time: String(record.start_time ?? ''),
        status: String(record.status ?? ''),
        source_revision: record.source_revision ?? null,
      });
    } else {
      // No live source: this projection is an orphan. Repeatedly attempting a
      // source repair would never converge, so delete it under the same
      // transaction guard instead.
      orphans.push(rows[index].id);
    }
  });
  if (live.length) await repairProjectionsForRows(db, live, reads);
  if (orphans.length && db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) {
    const orphanTx = db.transaction([TRIP_STORE, TRIP_PROJECTION_STORE], 'readwrite');
    const sourceStore = orphanTx.objectStore(TRIP_STORE);
    const projectionStore = orphanTx.objectStore(TRIP_PROJECTION_STORE);
    for (const id of orphans) {
      // Re-read inside the transaction: a source that reappeared between the
      // verifier pass and now is not an orphan.
      const fresh = await idbRequest(sourceStore.get(id));
      reads.count += 1;
      if (!fresh || isSecureDeleteTombstone(fresh)) projectionStore.delete(id);
    }
    await idbTransactionDone(orphanTx);
  }
  return reads.count;
};

/** One backfill turn, wired to this repository's stores and repair path. */
const projectionBackfillTurn = (db) => runBackfillTurn(db, {
  metaStore: TRIP_META_STORE,
  tripStore: TRIP_STORE,
  projectionStore: TRIP_PROJECTION_STORE,
  indexName: TRIP_INDEX_START_TIME_ID,
  repair: async (rows) => {
    // P4-C-F09: the projections built, and the source rows the repair path had
    // to re-read to build them.
    const reads = { count: 0 };
    const built = await repairProjectionsForRows(db, rows, reads);
    return { converted: built.size, examined: reads.count };
  },
});

/** One verification turn, with this repository's guarded mismatch repair. */
const projectionVerifyTurn = (db) => runVerifyTurn(db, {
  metaStore: TRIP_META_STORE,
  tripStore: TRIP_STORE,
  projectionStore: TRIP_PROJECTION_STORE,
  indexName: TRIP_INDEX_START_TIME_ID,
  onMismatch: (rows) => repairVerifiedMismatches(db, rows),
});

/** One tombstone-cleanup turn across the three record stores. */
const projectionCleanupTurn = (db) => runCleanupTurn(db, {
  metaStore: TRIP_META_STORE,
  stores: [TRIP_STORE, TRIP_SUMMARY_STORE, TRIP_PROJECTION_STORE]
    .filter((name) => db.objectStoreNames.contains(name)),
  statusIndex: 'status',
  tombstoneStatus: 'secure-delete-pending',
  measure: (record) => {
    try { return new TextEncoder().encode(JSON.stringify(record)).byteLength; } catch { return 0; }
  },
});

/**
 * P4-C-F04 — exactly one projection subpass per coordinated turn.
 *
 * The phase lives in `trip_meta` beside the cursors the subpasses already own,
 * so the projection domain - not the coordinator - decides which unit comes
 * next and a restart resumes on the same one. `examined` is what this single
 * subpass read in this invocation; `hasMore` is false only when the cleanup
 * phase finished, i.e. when a full backfill/verify/cleanup rotation is done.
 */
export async function runProjectionMaintenanceSlice() {
  const empty = {
    phase: null, backfilled: 0, verified: 0, cleaned: 0, examined: 0, turns: 0, hasMore: false,
  };
  if (!canUseIndexedDb()) return empty;
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) return empty;
    const stored = await readTripMeta(db, META_KEYS.MAINTENANCE_PHASE, null);
    const phase = PROJECTION_MAINTENANCE_PHASES.includes(stored?.phase)
      ? stored.phase
      : PROJECTION_MAINTENANCE_PHASES[0];

    let result;
    let totals;
    if (phase === 'backfill') {
      result = await projectionBackfillTurn(db);
      totals = { backfilled: result.converted || 0, verified: 0, cleaned: 0 };
    } else if (phase === 'verify') {
      result = await projectionVerifyTurn(db);
      totals = { backfilled: 0, verified: result.checkedThisTurn || 0, cleaned: 0 };
    } else {
      result = await projectionCleanupTurn(db);
      totals = { backfilled: 0, verified: 0, cleaned: result.removed || 0 };
    }

    // A phase that still has records keeps the sequence on itself; a finished
    // one hands over to the next, and cleanup closes the rotation.
    const index = PROJECTION_MAINTENANCE_PHASES.indexOf(phase);
    const advanced = result.done === true;
    const nextPhase = advanced
      ? PROJECTION_MAINTENANCE_PHASES[(index + 1) % PROJECTION_MAINTENANCE_PHASES.length]
      : phase;
    await writeTripMetaRecord(db, META_KEYS.MAINTENANCE_PHASE, {
      phase: nextPhase, updated_at: Date.now(),
    });
    await yieldToEventLoop();
    return {
      phase,
      ...totals,
      examined: Math.max(0, Number(result.examined) || 0),
      turns: 1,
      hasMore: !(advanced && phase === PROJECTION_MAINTENANCE_PHASES.at(-1)),
    };
  } finally {
    db.close();
  }
}

/**
 * Drive every projection subpass to a bounded depth in one call.
 *
 * This is the *explicit*, non-lifecycle whole-pass driver used by
 * `runTripRepositoryMaintenance()`. Coordinated turns use
 * `runProjectionMaintenanceSlice()`, which runs one subpass.
 */
export async function runProjectionMaintenance({ maxTurns = 8 } = {}) {
  if (!canUseIndexedDb()) return { backfilled: 0, verified: 0, cleaned: 0, turns: 0, hasMore: false };
  const db = await openDb();
  const totals = { backfilled: 0, verified: 0, cleaned: 0, turns: 0, hasMore: false };
  try {
    if (!db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) return totals;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      const backfill = await projectionBackfillTurn(db);
      totals.backfilled += backfill.converted;
      totals.turns += 1;
      totals.hasMore = totals.hasMore || backfill.done !== true;
      await yieldToEventLoop();
      if (backfill.done) break;
    }

    const verify = await projectionVerifyTurn(db);
    totals.verified += verify.checkedThisTurn || 0;
    totals.hasMore = totals.hasMore || verify.done !== true;
    await yieldToEventLoop();

    const cleanup = await projectionCleanupTurn(db);
    totals.cleaned += cleanup.removed;
    totals.hasMore = totals.hasMore || cleanup.done !== true;
    return totals;
  } finally {
    db.close();
  }
}

/**
 * Read the constant-size native projection checkpoint from disposable IDB.
 *
 * P4-B-F02 fail-closed rule: while a verified rollover's discard is still
 * outstanding, the stored checkpoint belongs to a superseded generation and no
 * caller may resume from it. Reporting "no checkpoint" is the safe answer —
 * the projection is disposable, so the worst case is a fresh bounded rebuild.
 */
export async function readNativeProjectionState() {
  if (!canUseIndexedDb()) return null;
  if (hasPendingProjectionDiscard()) return null;
  const db = await openDb();
  try { return await readTripMeta(db, NATIVE_PROJECTION_STATE_KEY, null); }
  finally { db.close(); }
}

/**
 * Apply one native-catalog projection turn. The caller supplies at most one
 * bounded bridge page. Native catalog identity/order remains authoritative;
 * this cache can be discarded at any point without hiding a trip.
 */
/**
 * AUD-007 FINAL: the native projection turn encodes a page and commits it inside the
 * projection barrier. One publication spans both.
 */
export async function applyNativeProjectionTurn({
  generation,
  items = [],
  deletedIds = [],
  checkpoint,
  verifyCommit = null,
}) {
  return withDurableKeyPublication(async (publication) => {
  if (!canUseIndexedDb()) return { written: 0, deleted: 0 };
  if (!generation || items.length > 200 || deletedIds.length > 200) throw new Error('Native projection turn exceeds bounds');
  const envelopes = [];
  const rows = [];
  for (const item of items) {
    const revision = `native:${Number(item?.revision) || 0}`;
    try {
      const envelope = buildTripProjection(item, { sourceRevision: revision });
      envelopes.push(envelope);
      rows.push({ item, revision, envelope });
    } catch (error) {
      if (!(error instanceof ProjectionBuildError)) throw error;
      rows.push({ item, revision, failure: error.failureClass });
    }
  }
  const encrypted = await encodeProjectionPayloads(envelopes, publication);
  let encryptedIndex = 0;
  // P4-B-F02: the generation fence is re-read *inside* the barrier that a
  // canonical rollover/erasure must also hold, so no rollover can interleave
  // between the last successful fence read and this durable commit. Building
  // and encrypting the page needs no exclusion and stays outside it.
  return runUnderProjectionBarrier(async () => {
    // P4-B-F02: a superseded generation whose discard failed must not be
    // committed over. One bounded retry per coordinated turn happens here,
    // inside the barrier the caller already holds; if it still fails the turn
    // is refused with a typed deferral rather than writing on top of stale
    // state, so the projection stays fail-closed instead of leaking.
    if (hasPendingProjectionDiscard()) {
      const discarded = await attemptPendingProjectionDiscard('projection_discard_retry');
      if (!discarded) {
        // Within the automatic allowance this is a *continuation*: the same
        // logical instance is re-admitted at the tail and makes exactly one
        // further attempt, with a scheduler yield and interactive precedence in
        // between. Once the allowance is spent the instance settles as a
        // surfaced, non-retryable failure rather than sleeping on a wake no
        // current producer can emit.
        const exhausted = consumeProjectionDiscardAllowance();
        return {
          written: 0,
          deleted: 0,
          refused: true,
          fence: exhausted
            ? { allowed: false, failed: true, reason: 'projection_discard_unavailable' }
            : { allowed: false, retry: true, reason: 'projection_discard_pending' },
        };
      }
    }
    if (verifyCommit) {
      const fence = await verifyCommit();
      if (!fence?.allowed) return { written: 0, deleted: 0, refused: true, fence };
    }
    const db = await openDb();
    try {
      const tx = db.transaction([TRIP_PROJECTION_STORE, TRIP_META_STORE], 'readwrite');
      const store = tx.objectStore(TRIP_PROJECTION_STORE);
      for (const row of rows) {
        if (row.failure) {
          store.put({
            ...projectionFailureMarkerFor({
              id: row.item.id,
              start_time: String(row.item.start_time || ''),
              status: String(row.item.status || ''),
              source_revision: row.revision,
            }, row.failure),
            native_generation: generation,
          });
        } else {
          store.put({
            ...projectionRecordFor(row.envelope, encrypted[encryptedIndex++], row.item.id),
            native_generation: generation,
          });
        }
      }
      deletedIds.forEach((id) => store.delete(id));
      tx.objectStore(TRIP_META_STORE).put({ key: NATIVE_PROJECTION_STATE_KEY, value: checkpoint });
      await idbTransactionDone(tx);
      return { written: rows.length, deleted: deletedIds.length };
    } finally { db.close(); }
  });
  });
}

/**
 * Drop every projection row a superseded native generation owned, plus the
 * projection checkpoint.
 *
 * The projection is disposable by design, so this never touches canonical
 * state: it only guarantees that no derived row or checkpoint outlives the
 * generation that produced it. The caller holds the projection barrier (see
 * `runCanonicalGenerationRollover`), which is why this does not take it again.
 * The next projection turn then finds no checkpoint and starts a fresh bounded
 * rebuild for the new generation.
 */
export async function discardNativeProjectionState({
  reason = 'canonical_generation_rollover',
  keepGeneration = null,
} = {}) {
  if (!canUseIndexedDb()) return { removedRows: 0, checkpointRemoved: false, reason };
  const db = await openDb();
  try {
    const hasProjections = db.objectStoreNames.contains(TRIP_PROJECTION_STORE);
    const stale = [];
    if (hasProjections) {
      const readTx = db.transaction(TRIP_PROJECTION_STORE, 'readonly');
      const records = await idbRequest(readTx.objectStore(TRIP_PROJECTION_STORE).getAll());
      for (const record of records || []) {
        if (!record?.native_generation) continue;
        if (keepGeneration && String(record.native_generation) === String(keepGeneration)) continue;
        stale.push(record.id);
      }
    }
    const stores = hasProjections ? [TRIP_PROJECTION_STORE, TRIP_META_STORE] : [TRIP_META_STORE];
    const tx = db.transaction(stores, 'readwrite');
    if (hasProjections) {
      const store = tx.objectStore(TRIP_PROJECTION_STORE);
      stale.forEach((id) => store.delete(id));
    }
    tx.objectStore(TRIP_META_STORE).delete(NATIVE_PROJECTION_STATE_KEY);
    await idbTransactionDone(tx);
    // P7 A2.4 clause 4: a generation rollover or erasure invalidates every
    // outstanding cursor and Q10 accumulator, so it takes the conservative epoch.
    await advanceP7QueryEpoch(reason);
    return { removedRows: stale.length, checkpointRemoved: true, reason };
  } finally { db.close(); }
}

/**
 * The bounded projection query. Ordering and identity come from `trips`, so this
 * is correct at zero migration progress; only the selected page's projections
 * are read, repaired, decrypted and hydrated.
 */
/**
 * Materialize one already-selected source window into list rows.
 *
 * Split out of `listBoundedProjections` so the P7 Q1 path (cursor v2) and the
 * existing v1 path share one implementation: repair, decrypt and hydration
 * sequencing, and therefore the per-page bounds, cannot drift between them.
 */
const materializeProjectionWindow = async (db, window) => {
  {
    const live = window.rows.filter((row) => row.status !== 'secure-delete-pending');
    projectionCounters.sourceRowsVisited += live.length;
    if (!live.length) return [];

    const ids = live.map((row) => row.id);
    projectionCounters.projectionPointReads += ids.length;
    const projections = await readProjectionRecords(db, TRIP_PROJECTION_STORE, ids);
    const classified = classifyProjectionRows(live, projections);

    const rebuilt = await repairProjectionsForRows(db, classified.needsBuild);

    projectionCounters.projectionDecrypts += classified.usable.length;
    const decoded = await decodeProjectionPayloads(classified.usable);
    const envelopeById = new Map(rebuilt);
    decoded.forEach(({ row, envelope }) => {
      if (envelope) envelopeById.set(row.id, envelope);
    });

    // A selected projection that could not be decrypted or authenticated is
    // rewritten from its source now, bounded by this page. Without it the same
    // unreadable ciphertext would be decrypted again on every read, and the row
    // would stay degraded forever instead of converging.
    const unreadable = decoded.filter(({ envelope }) => !envelope).map(({ row }) => row);
    if (unreadable.length) {
      const converged = await repairProjectionsForRows(db, unreadable);
      converged.forEach((envelope, id) => envelopeById.set(id, envelope));
    }

    // Rows with a matching deterministic failure marker, or that no repair could
    // produce an envelope for, are served from bounded detail instead.
    const detailOnly = [
      ...classified.deterministicFailures.map(({ row }) => row),
      ...unreadable.filter((row) => !envelopeById.has(row.id)),
    ];
    const overflowRows = live.filter((row) => {
      const envelope = envelopeById.get(row.id);
      return envelope && overflowBitsOf(envelope).length > 0;
    });
    const hydrationTargets = [...detailOnly, ...overflowRows];
    const hydrated = await hydrateTruncatedProjections(db, hydrationTargets);

    const rows = live.map((row) => {
      const envelope = envelopeById.get(row.id);
      if (!envelope) {
        const exact = hydrated.get(row.id);
        return {
          id: row.id,
          start_time: row.start_time,
          status: row.status,
          projection_status: 'degraded',
          privacy_mode: 'unknown',
          route_replay_available: false,
          ...(exact || {}),
        };
      }
      return asTripListModel(envelope, { hydrated: hydrated.get(row.id) });
    });

    return rows;
  }
};

/**
 * The bounded projection query (v1 cursor path). Ordering and identity come
 * from `trips`, so this is correct at zero migration progress; only the
 * selected page's projections are read, repaired, decrypted and hydrated.
 */
const listBoundedProjections = async ({ sort, limit, status = null, cursor = null } = {}) => {
  const query = assertProjectionQuery({ sort, limit }, {
    maxLimit: MAX_PROJECTION_PAGE,
    defaultLimit: DEFAULT_PROJECTION_PAGE,
  });
  const db = await openDb();
  try {
    const window = await selectSourceWindow(db, {
      storeName: TRIP_STORE,
      unfilteredIndex: TRIP_INDEX_START_TIME_ID,
      filteredIndex: TRIP_INDEX_STATUS_START_TIME_ID,
      status,
      limit: query.limit,
      direction: query.direction,
      cursor,
      sort: query.sort,
    });
    const rows = await materializeProjectionWindow(db, window);
    if (!rows.length) return { rows: [], nextCursor: null, hasMore: false };
    return { rows, nextCursor: window.nextCursor, hasMore: window.hasMore };
  } finally {
    db.close();
  }
};

/**
 * Named, budgeted bounded-scan filters for Q1 (Annex A §A2.7).
 *
 * `status` and the `start_time` range are served by the existing
 * `by_start_time_id` / `by_status_start_time_id` indexes. **Every other filter
 * must be a named predicate registered here**, evaluated on the materialized
 * page rows within the page's own source-row budget — never an arbitrary
 * caller-supplied callback, and never a new index (OQ-2 is closed against one).
 *
 * The registry starts empty on purpose: the stage that migrates a consumer
 * registers exactly the names that consumer's existing UI already filters on,
 * so no filter vocabulary is invented ahead of a real product need. An
 * unregistered key is answered `FILTER_UNSUPPORTED` with no data, never with a
 * silently short page.
 */
export const P7_NAMED_FILTERS = new Map();

/** @param {string} name @param {(row: any, value: any) => boolean} predicate */
export const registerP7NamedFilter = (name, predicate) => {
  if (typeof name !== 'string' || !name) throw new TypeError('A named filter needs a name.');
  if (typeof predicate !== 'function') throw new TypeError(`Filter ${name} needs a predicate.`);
  P7_NAMED_FILTERS.set(name, predicate);
};

/** ISO representation of a range bound, matching how `start_time` is stored. */
const rangeKeyFor = (epochMs) => (
  Number.isFinite(epochMs) ? new Date(Number(epochMs)).toISOString() : null
);

const withinRange = (row, fromMs, toMs) => {
  if (fromMs == null && toMs == null) return true;
  const at = Date.parse(String(row?.start_time ?? ''));
  if (!Number.isFinite(at)) return false;
  if (fromMs != null && at < fromMs) return false;
  // Half-open [from, to) on both authorities (Annex C §C2).
  if (toMs != null && at >= toMs) return false;
  return true;
};

/**
 * **Q1** — the canonical bounded history page, with browser cursor v2.
 *
 * One source window of at most `limit` rows is visited per invocation, so
 * `sourceRowsVisited <= k + 1`, `projectionDecrypts <= k` and
 * `fullTripDecrypts = 0` hold regardless of how much history is retained. A
 * filtered page that cannot fill `k` matches inside that budget returns
 * `PARTIAL` plus a continuation — never a short page presented as complete.
 *
 * @param {{sort?: string, status?: string|null, limit?: number,
 *          range?: {fromMs?: number|null, toMs?: number|null},
 *          filter?: object, cursor?: string|null}} request
 * @returns {Promise<object>} the generic P7 query envelope
 */
/**
 * The Q1 answer on a platform with no primary storage.
 *
 * Selection, ordering, the date range and the named filters are applied
 * exactly as the indexed path applies them; only the source differs, because
 * on this platform there is no index to walk. It returns the same envelope,
 * with a real continuation when more rows remain, so a caller cannot tell the
 * difference except through the counter.
 */
/**
 * The keyset order the indexed path pages in, reproduced on the degraded source.
 *
 * `by_start_time_id` is a **composite** key, and only a composite comparison
 * gives a continuation a single unambiguous successor: two drives that start in
 * the same second must still have a stable relative order, or page two can
 * repeat or skip one of them.
 */
const degradedKeysetOrder = (rows, sort) => {
  const dir = String(sort ?? '').startsWith('-') ? -1 : 1;
  return [...rows].sort((left, right) => {
    const leftKey = String(left?.start_time ?? '');
    const rightKey = String(right?.start_time ?? '');
    if (leftKey !== rightKey) return leftKey > rightKey ? dir : -dir;
    const leftId = String(left?.id ?? '');
    const rightId = String(right?.id ?? '');
    if (leftId === rightId) return 0;
    return leftId > rightId ? dir : -dir;
  });
};

/** The first index strictly after `position` in the same keyset order. */
const degradedResumeIndex = (rows, position, sort) => {
  if (!position?.key) return 0;
  const known = rows.findIndex((row) => String(row?.id ?? '') === String(position.key.id ?? ''));
  // The exact row is still present: resume immediately after it.
  if (known >= 0) return known + 1;
  // It was deleted under the continuation. The keyset is still totally ordered,
  // so the successor is the first row that sorts strictly after the last key —
  // never the start of the list, which would repeat the whole page.
  const dir = String(sort ?? '').startsWith('-') ? -1 : 1;
  const after = (row) => {
    const rowKey = String(row?.start_time ?? '');
    const cursorKey = String(position.key.sort ?? '');
    if (rowKey !== cursorKey) return (rowKey > cursorKey ? 1 : -1) === dir;
    const rowId = String(row?.id ?? '');
    const cursorId = String(position.key.id ?? '');
    if (rowId === cursorId) return false;
    return (rowId > cursorId ? 1 : -1) === dir;
  };
  const index = rows.findIndex(after);
  return index >= 0 ? index : rows.length;
};

async function degradedHistoryPage({
  bind, pageLimit, snapshot, envelopeSnapshot, filter, requestedFilterKeys, position = null,
}) {
  projectionCounters.historySorts += 1;
  const all = degradedKeysetOrder(await getCurrentTripSummaries(), bind.sort);
  const eligible = all.filter((row) => (
    // `normalizeCursorBind` renders "no status filter" as the string `any`,
    // which is what the indexed path also treats as unfiltered. Comparing a
    // row status against the literal would match nothing at all.
    ((bind.status == null || bind.status === 'any') || String(row?.status ?? '') === String(bind.status))
    && withinRange(row, bind.range.fromMs, bind.range.toMs)
    && requestedFilterKeys.every((key) => P7_NAMED_FILTERS.get(key)(row, filter[key]))
  ));

  // P7-IMPL-F07. The decoded continuation is the position already reached, and
  // paging **from it** is the whole point of returning one: slicing from zero
  // made page two repeat page one for as long as the caller kept asking.
  const start = degradedResumeIndex(eligible, position, bind.sort);
  const matched = eligible.slice(start, start + pageLimit);
  const hasMore = eligible.length > start + matched.length;
  const last = matched[matched.length - 1];
  const continuation = hasMore && last
    ? await encodeTripCursorV2({
      key: { sort: last.start_time ?? '', id: String(last.id ?? '') },
      bind,
      src: { generation: snapshot.generation, rev: snapshot.revision },
      scan: {
        budgetSpent: (position?.scan?.budgetSpent ?? 0) + matched.length,
        matched: (position?.scan?.matched ?? 0) + matched.length,
      },
    })
    : null;

  return {
    data: matched,
    completeness: hasMore && matched.length < pageLimit
      ? P7_COMPLETENESS.PARTIAL
      : P7_COMPLETENESS.EXACT,
    continuation,
    snapshot: envelopeSnapshot,
  };
}

export async function queryTripHistoryPage(request = {}) {
  const {
    sort = '-start_time', status = null, limit = DEFAULT_PROJECTION_PAGE,
    range = null, filter = null, cursor = null,
  } = request;

  const snapshot = await readP7QuerySnapshot();
  const bind = await normalizeCursorBind({ sort, status, range, filter });
  const envelopeSnapshot = {
    authority: snapshot.authority,
    generation: snapshot.generation,
    revision: snapshot.revision,
    queryId: bind.filterId,
    takenAt: Date.now(),
  };
  const unavailable = (code, reason) => ({
    data: null,
    completeness: null,
    continuation: null,
    snapshot: envelopeSnapshot,
    unavailable: { code, reason },
  });

  let pageLimit;
  try {
    pageLimit = assertP7PublicLimit(limit);
  } catch (error) {
    return unavailable(error.code, 'limit_out_of_range');
  }

  // An unregistered filter key is refused before any row is read, rather than
  // answered with a page that quietly ignored it.
  const requestedFilterKeys = Object.keys(filter ?? {}).filter((key) => {
    const value = filter[key];
    return value !== undefined && value !== null && value !== ''
      && !(Array.isArray(value) && value.length === 0);
  });
  const unsupported = requestedFilterKeys.filter((key) => !P7_NAMED_FILTERS.has(key));
  if (unsupported.length) {
    return unavailable(P7_UNAVAILABLE_CODES.FILTER_UNSUPPORTED, unsupported.join(','));
  }

  let position;
  try {
    position = await decodeTripCursorV2(cursor, {
      authority: 'browser',
      bind,
      src: { generation: snapshot.generation, rev: snapshot.revision },
    });
  } catch (error) {
    return unavailable(error.code, 'cursor_rejected');
  }

  if (!canUseIndexedDb()) {
    // P7-IMPL-F07. A platform with no IndexedDB has no source index to page,
    // and the read this replaced degraded to the monolithic fallback blob
    // rather than failing. Refusing here made every migrated page report the
    // store as unreadable on that platform — a regression, not a bound.
    //
    // The degraded answer is still the **page** the caller asked for, and it
    // still counts a `historySorts`, so the degradation is visible in the
    // counters instead of hidden behind a normal-looking envelope. The P7 law
    // is that no unbounded read happens **when a bounded path exists**; here
    // none does.
    return degradedHistoryPage({
      bind, pageLimit, snapshot, envelopeSnapshot, filter, requestedFilterKeys, position,
    });
  }

  const direction = bind.sort === '-start_time' ? 'prev' : 'next';
  const db = await openDb();
  let window;
  let rows;
  try {
    window = await selectSourceWindow(db, {
      storeName: TRIP_STORE,
      unfilteredIndex: TRIP_INDEX_START_TIME_ID,
      filteredIndex: TRIP_INDEX_STATUS_START_TIME_ID,
      status: bind.status,
      limit: pageLimit,
      direction,
      sort: bind.sort,
      position: position ? { startTime: position.key.sort, id: position.key.id } : null,
      fromKey: rangeKeyFor(bind.range.fromMs),
      toKey: rangeKeyFor(bind.range.toMs),
    });
    rows = await materializeProjectionWindow(db, window);
  } catch (error) {
    logSystemFailure('p7_query_history_page', error, { authority: 'browser' });
    return unavailable(P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, 'page_read_failed');
  } finally {
    db.close();
  }

  const matched = rows.filter((row) => (
    withinRange(row, bind.range.fromMs, bind.range.toMs)
    && requestedFilterKeys.every((key) => P7_NAMED_FILTERS.get(key)(row, filter[key]))
  ));

  const continuation = window.hasMore && window.lastKey
    ? await encodeTripCursorV2({
      key: window.lastKey,
      bind,
      src: { generation: snapshot.generation, rev: snapshot.revision },
      scan: {
        budgetSpent: (position?.scan.budgetSpent ?? 0) + window.rows.length,
        matched: (position?.scan.matched ?? 0) + matched.length,
      },
    })
    : null;

  // EXACT when the scan reached the applicable end, or when a full page was
  // filled. PARTIAL only when the budget stopped the answer short of `k`
  // matches while more source rows remain — and then a real continuation exists.
  const completeness = (!window.hasMore || matched.length >= pageLimit)
    ? P7_COMPLETENESS.EXACT
    : P7_COMPLETENESS.PARTIAL;

  return {
    data: matched,
    completeness,
    continuation,
    snapshot: envelopeSnapshot,
  };
}

/**
 * Diagnostics-only population evidence. IndexedDB's count operation returns a
 * scalar without materialising summaries or opening any route payload.
 */
export async function readDiagnosticsTripPopulation() {
  const before = await readP7QuerySnapshot();
  if (!canUseIndexedDb()) {
    return {
      available: false,
      reason: 'indexeddb_unavailable',
      snapshot: { ...before, queryId: 'diagnostics.population', takenAt: Date.now() },
    };
  }
  const db = await openDb();
  try {
    const tx = db.transaction(TRIP_STORE, 'readonly');
    const total = await idbRequest(tx.objectStore(TRIP_STORE).count());
    const after = await readP7QuerySnapshot();
    if (String(before.generation) !== String(after.generation) || Number(before.revision) !== Number(after.revision)) {
      return {
        available: false,
        reason: 'snapshot_changed_during_count',
        snapshot: { ...after, queryId: 'diagnostics.population', takenAt: Date.now() },
      };
    }
    return {
      available: true,
      totalTripCount: Math.max(0, Number(total) || 0),
      completedTripCount: null,
      completedCountState: 'not_indexed',
      snapshot: { ...after, queryId: 'diagnostics.population', takenAt: Date.now() },
    };
  } finally {
    db.close();
  }
}

/**
 * **Q6** — the adjacent trip in history order, for prev/next navigation on a
 * detail surface.
 *
 * One point read to locate the anchor's keyset position, then **one**
 * `selectSourceWindow` call with `limit: 1`. Never a list, never a scan.
 *
 * @param {string|number} id the anchor trip
 * @param {'previous'|'next'} direction older (`previous`) or newer (`next`)
 * @param {{status?: string|null}} [options]
 * @returns {Promise<object>} the generic P7 query envelope
 */
export async function queryTripAdjacent(id, direction = 'previous', options = {}) {
  const status = options.status ?? null;
  const snapshot = await readP7QuerySnapshot();
  const bind = await normalizeCursorBind({ sort: '-start_time', status });
  const envelopeSnapshot = {
    authority: snapshot.authority,
    generation: snapshot.generation,
    revision: snapshot.revision,
    queryId: bind.filterId,
    takenAt: Date.now(),
  };
  const unavailable = (code, reason) => ({
    data: null, completeness: null, continuation: null, snapshot: envelopeSnapshot,
    unavailable: { code, reason },
  });

  if (!canUseIndexedDb()) {
    return unavailable(P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, 'indexeddb_unavailable');
  }

  const db = await openDb();
  try {
    const tx = db.transaction(TRIP_STORE, 'readonly');
    const anchor = await idbRequest(tx.objectStore(TRIP_STORE).get(id));
    if (!anchor) return unavailable(P7_UNAVAILABLE_CODES.DETAIL_NOT_FOUND, 'anchor_missing');

    // `previous` means older, which is the descending direction of the index.
    const window = await selectSourceWindow(db, {
      storeName: TRIP_STORE,
      unfilteredIndex: TRIP_INDEX_START_TIME_ID,
      filteredIndex: TRIP_INDEX_STATUS_START_TIME_ID,
      status: bind.status,
      limit: 1,
      direction: direction === 'next' ? 'next' : 'prev',
      sort: bind.sort,
      position: { startTime: anchor.start_time, id: anchor.id },
    });
    const rows = await materializeProjectionWindow(db, window);
    return {
      // A proven end of history is EXACT with no row, not an unavailable result.
      data: rows[0] ?? null,
      completeness: P7_COMPLETENESS.EXACT,
      continuation: null,
      snapshot: envelopeSnapshot,
    };
  } catch (error) {
    logSystemFailure('p7_query_trip_adjacent', error, { authority: 'browser' });
    return unavailable(P7_UNAVAILABLE_CODES.STORAGE_UNAVAILABLE, 'adjacent_read_failed');
  } finally {
    db.close();
  }
}

/**
 * **Q7** — bounded tag context for tag inference, on save and on detail open.
 *
 * One Q1 page, capped at `maxRecent`. It replaces the 100-row summary reads on
 * the detail surfaces and the hidden `listSummaries({limit:50})` the save path
 * performs today, so a save and a detail open both stop reading a list.
 *
 * @param {{maxRecent?: number, status?: string|null}} [request]
 * @returns {Promise<object>} the generic P7 query envelope
 */
export async function queryTripTagContext(request = {}) {
  const maxRecent = request.maxRecent ?? 25;
  const page = await queryTripHistoryPage({
    limit: maxRecent,
    status: request.status ?? 'completed',
    sort: '-start_time',
  });
  if (page.unavailable) return page;
  return {
    ...page,
    data: {
      // The result is complete for an explicitly capped contract, so it is
      // EXACT and says so rather than manufacturing a PARTIAL it cannot continue.
      cappedAt: maxRecent,
      trips: page.data.map((row) => ({
        id: row.id,
        start_time: row.start_time,
        tag: row.tag,
        tags: row.tags,
        tag_sources: row.tag_sources,
        // `inferTripTags` groups the context by repeated route, so the route
        // key is part of "tag context". It is an existing projection field —
        // no projection field is added here.
        route_key: row.route_key,
      })),
    },
    completeness: P7_COMPLETENESS.EXACT,
    continuation: null,
  };
}

const encodeTripRecords = async (trips, publication, options = {}) => {
  assertDurablePublication(publication, 'encodeTripRecords');
  const source = Array.isArray(trips) ? trips : [];
  const encoded = [];
  for (let start = 0; start < source.length; start += MAX_SECURE_BATCH_RECORDS) {
    const storageTrips = await sanitizeTripsForPrivacyStorage(
      source.slice(start, start + MAX_SECURE_BATCH_RECORDS)
    );
    const encryptedPayloads = await encryptSensitiveValues(storageTrips.map((trip) => ({
      value: trip,
      context: tripEncryptionContext(trip.id),
    })), options);
    storageTrips.forEach((trip, index) => {
      encoded.push({
        id: trip.id,
        start_time: trip.start_time || '',
        end_time: trip.end_time || '',
        status: trip.status || '',
        rsas_session_id: trip.rsas_session_id || null,
        route_data_expired_at: trip.route_data_expired_at || null,
        motion_samples_expired_at: trip.motion_samples_expired_at || null,
        encrypted_payload: encryptedPayloads[index],
      });
    });
    storageTrips.fill(null);
    encryptedPayloads.fill(null);
    if (start + MAX_SECURE_BATCH_RECORDS < source.length) await yieldToEventLoop();
  }
  return encoded;
};

const encodeTripSummaryRecords = async (trips, publication, options = {}) => {
  assertDurablePublication(publication, 'encodeTripSummaryRecords');
  const source = Array.isArray(trips) ? trips : [];
  const encoded = [];
  for (let start = 0; start < source.length; start += MAX_SECURE_BATCH_RECORDS) {
    const summaries = source
      .slice(start, start + MAX_SECURE_BATCH_RECORDS)
      .map((trip) => buildTripSummary(trip));
    const encryptedPayloads = await encryptSensitiveValues(summaries.map((summary) => ({
      value: summary,
      context: tripSummaryEncryptionContext(summary.id),
    })), options);
    summaries.forEach((summary, index) => {
      encoded.push({
        id: summary.id,
        start_time: summary.start_time || '',
        status: summary.status || '',
        encrypted_payload: encryptedPayloads[index],
      });
    });
    summaries.fill(null);
    encryptedPayloads.fill(null);
    if (start + MAX_SECURE_BATCH_RECORDS < source.length) await yieldToEventLoop();
  }
  return encoded;
};
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

/**
 * AUD-007 FINAL: the migration write boundary. Encodes and commits under one token.
 */
const writeTripsToDb = async (dbName, trips) => withDurableKeyPublication(async (publication) => {
  if (!trips.length) return;
  const db = await openDbByName(dbName);
  try {
    for (let start = 0; start < trips.length; start += 4) {
      const encryptedTrips = await encodeTripRecords(trips.slice(start, start + 4), publication);
      const tx = db.transaction(TRIP_STORE, 'readwrite');
      const store = tx.objectStore(TRIP_STORE);
      encryptedTrips.forEach((trip) => store.put(trip));
      await idbTransactionDone(tx);
    }
  } finally {
    db.close();
  }
});

/**
 * AUD-007 REDESIGN — CODEX bypass B. Summary backfill is reachable from an ordinary
 * summary read whenever the summary store and the trip store disagree (interrupted write,
 * migration, a row rewrapped under a retired key). It encrypted every summary and
 * committed the rows several awaits later with no publication at all, so a finalization
 * landing in between destroyed the version those rows name.
 */
const writeTripSummariesToDb = async (dbName, trips) => withDurableKeyPublication(async (publication) => {
  if (!trips.length) return;
  const db = await openDbByName(dbName);
  try {
    if (!db.objectStoreNames.contains(TRIP_SUMMARY_STORE)) return;
    for (let start = 0; start < trips.length; start += 8) {
      const encryptedSummaries = await encodeTripSummaryRecords(trips.slice(start, start + 8), publication);
      const tx = db.transaction(TRIP_SUMMARY_STORE, 'readwrite');
      const store = tx.objectStore(TRIP_SUMMARY_STORE);
      encryptedSummaries.forEach((summary) => store.put(summary));
      await idbTransactionDone(tx);
    }
  } finally {
    db.close();
  }
});

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

/**
 * Read the legacy single-blob fallback, filtered by the deletion overlay.
 *
 * A trip deleted while IndexedDB was healthy is not removed from `TRIPS_KEY` —
 * a normal delete never touches that blob — so without this filter a later
 * IndexedDB read failure could resurrect it. When the overlay is saturated the
 * whole fallback is withheld: failing closed costs availability of a legacy
 * degraded path, never integrity, and is O(1).
 */
/** Is a data-rights erasure of the fallback blob still unfinished? */
const fallbackErasureBarrierRaised = async () => {
  try {
    const barrier = await getJson(TRIPS_ERASURE_BARRIER_KEY, null);
    return barrier?.pending === true;
  } catch {
    // The barrier is a safety device: if it cannot be read, assume it is raised.
    return true;
  }
};

const readFallbackTrips = async () => {
  // Checked before the blob is even read. An erasure that removed the source
  // data but could not remove this blob leaves it recoverable, and the overlay
  // that would have hidden it may itself have been erased — so the barrier, not
  // the overlay, is what keeps an erased trip from coming back here.
  //
  // Empty, not `null`: callers read `null` as "no fallback exists, surface the
  // storage error", and telling a user their trips are *temporarily
  // unavailable* after they asked for them to be erased would be false. An
  // erased store holds no trips, which is what this returns.
  if (await fallbackErasureBarrierRaised()) return [];
  const stored = await getJson(TRIPS_KEY, null);
  if (stored == null) return null;
  const trips = isEncryptedPayload(stored)
    ? await decryptSensitiveValue(stored, `storage:${TRIPS_KEY}`)
    : stored;
  if (!Array.isArray(trips)) return null;

  // When IndexedDB is entirely absent this blob *is* the primary store, and
  // `deleteTrip` rewrites it directly on that path, so there is nothing to
  // suppress and failing closed would hide the only copy of every trip.
  if (!canUseIndexedDb()) return trips;

  // IndexedDB exists, so this blob is a stale secondary copy and the overlay is
  // what hides trips deleted while IndexedDB was healthy. An IndexedDB outage is
  // precisely when this path runs, so an unreadable overlay must withhold the
  // fallback rather than expose it: metadata uncertainty must never make deleted
  // data more visible.
  let suppression = { ...defaultFallbackSuppression(), saturated: true };
  try {
    const db = await openDb();
    try {
      suppression = await readTripMeta(db, META_KEYS.FALLBACK_SUPPRESSION, defaultFallbackSuppression());
    } finally {
      db.close();
    }
  } catch (error) {
    logSystemFailure('trip_projection_fallback_overlay_unreadable', error, { db_name: DB_NAME });
  }
  if (!fallbackReadable(suppression)) return null;
  return trips.filter((trip) => fallbackRowVisible(suppression, trip?.id));
};

const getAllTrips = async ({ signal, onProgress } = {}) => {
  try {
    throwIfAborted(signal);
    const db = await openDb();
    let records;
    try {
      const readTx = db.transaction(TRIP_STORE, 'readonly');
      records = await idbRequest(readTx.objectStore(TRIP_STORE).getAll());
      const tombstones = records.filter(isSecureDeleteTombstone);
      if (tombstones.length) {
        const cleanupTx = db.transaction(TRIP_STORE, 'readwrite');
        const store = cleanupTx.objectStore(TRIP_STORE);
        tombstones.forEach((record) => store.delete(record.id));
        await idbTransactionDone(cleanupTx);
      }
    } finally {
      db.close();
    }
    const liveRecords = records.filter((record) => !isSecureDeleteTombstone(record));
    const trips = await decodeTripRecords(liveRecords, { signal, onProgress });
    const sanitizedTrips = await sanitizeTripsForPrivacyStorage(trips);
    const tripsToRewrite = sanitizedTrips.filter((trip, index) => (
      trip !== trips[index] || !isEncryptedPayload(liveRecords[index]?.encrypted_payload)
    ));
    if (tripsToRewrite.length && !signal) {
      await writeTripsToDb(DB_NAME, tripsToRewrite).catch((error) => {
        logSystemFailure('trip_repository_read_rewrite_deferred', error, {
          db_name: DB_NAME,
          trip_count: tripsToRewrite.length,
        });
      });
    }
    throwIfAborted(signal);
    return sanitizedTrips;
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const trips = await readFallbackTrips();
    if (!trips) {
      logSystemFailure('trip_repository_indexeddb_read', error, {
        db_name: DB_NAME,
        fallback_present: false,
      });
      throw new Error('Trip history is temporarily unavailable. Your saved trips were not deleted.', { cause: error });
    }
    const sanitizedTrips = await sanitizeTripsForPrivacyStorage(trips);
    if (sanitizedTrips.some((trip, index) => trip !== trips[index])) {
      await writeFallbackTripsDocument(sanitizedTrips);
    }
    return sanitizedTrips;
  }
};

const getStoredTripById = async (id) => {
  try {
    const db = await openDb();
    let record;
    try {
      const tx = db.transaction(TRIP_STORE, 'readonly');
      const store = tx.objectStore(TRIP_STORE);
      record = await idbRequest(store.get(id));
      if (!record && typeof id === 'string' && id.trim() && Number.isFinite(Number(id))) {
        const numericTx = db.transaction(TRIP_STORE, 'readonly');
        record = await idbRequest(numericTx.objectStore(TRIP_STORE).get(Number(id)));
      }
    } finally {
      db.close();
    }
    if (!record || isSecureDeleteTombstone(record)) return null;
    const trip = await decodeTripRecord(record);
    const sanitized = await sanitizeTripForPrivacyStorageAsync(trip);
    if (!isEncryptedPayload(record.encrypted_payload) || JSON.stringify(sanitized) !== JSON.stringify(trip)) {
      // The decoded record is the source here; `sanitized` above exists to
      // detect the drift, not to be the thing written. putTrip always receives
      // the source so its preflight measures what a caller actually supplied.
      await putTrip(trip).catch((error) => {
        logSystemFailure('trip_repository_record_rewrite_deferred', error, {
          db_name: DB_NAME,
          trip_id_present: id != null,
        });
      });
    }
    return sanitized;
  } catch (error) {
    const trips = await readFallbackTrips();
    if (!trips) {
      logSystemFailure('trip_repository_indexeddb_record_read', error, {
        db_name: DB_NAME,
        trip_id_present: id != null,
        fallback_present: false,
      });
      throw new Error('This trip is temporarily unavailable. Its saved record was not deleted.', { cause: error });
    }
    return trips.find((trip) => String(trip.id) === String(id)) || null;
  }
};

const getAllTripSummaries = async () => {
  if (!canUseIndexedDb()) {
    return (await getAllTrips()).map(buildTripSummary);
  }

  try {
    const db = await openDb();
    let summaryRecords;
    let tripCount;
    try {
      if (!db.objectStoreNames.contains(TRIP_SUMMARY_STORE)) throw new Error('Trip summary store unavailable');
      const summaryTx = db.transaction(TRIP_SUMMARY_STORE, 'readonly');
      summaryRecords = await idbRequest(summaryTx.objectStore(TRIP_SUMMARY_STORE).getAll());
      const tripTx = db.transaction(TRIP_STORE, 'readonly');
      tripCount = await idbRequest(tripTx.objectStore(TRIP_STORE).count());
    } finally {
      db.close();
    }

    const liveSummaries = summaryRecords.filter((record) => !isSecureDeleteTombstone(record));
    if (liveSummaries.length === tripCount) {
      try {
        return await decodeTripSummaryRecords(liveSummaries);
      } catch {
        // Rebuild below if a summary was interrupted or encrypted with a retired key.
      }
    }
  } catch {
    // Fall through to a one-time, source-of-truth backfill.
  }

  const trips = await getAllTrips();
  await writeTripSummariesToDb(DB_NAME, trips).catch(() => {});
  return trips.map(buildTripSummary);
};

/**
 * Encrypt the monolithic fallback trip document if it is still plaintext.
 *
 * P4-C-F04: this is the whole of the fallback encryption obligation that the
 * bounded lifecycle turns hand off. It is deliberately a single whole-document
 * operation - the document cannot be split - so it belongs only to explicit,
 * non-lifecycle callers.
 *
 * Restart-safe by construction: the source document is replaced by exactly one
 * `setEncryptedJson`, and the reference marker is stamped only after that write
 * resolves, so an interruption leaves the readable plaintext in place and no
 * marker claiming work that did not happen. Re-running is a no-op once the
 * document is encrypted.
 */
async function encryptFallbackTripsDocument() {
  try {
    const fallbackTrips = await getJson(TRIPS_KEY, null);
    if (!Array.isArray(fallbackTrips)) return false;
    await writeFallbackTripsDocument(await sanitizeTripsForPrivacyStorage(fallbackTrips));
    return true;
  } catch (error) {
    logSystemFailure('trip_storage_encryption_migration_fallback', error, {
      key: TRIPS_KEY,
    });
    return false;
  }
}

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

  fallbackStoreMigrated = await encryptFallbackTripsDocument();

  if (indexedDbRecordsMigrated || fallbackStoreMigrated) {
    recordSystemEvent('trip_storage_encryption_migrated', {
      indexeddb_record_count: indexedDbRecordsMigrated,
      fallback_store_migrated: fallbackStoreMigrated,
    }, { category: 'privacy', title: 'Trip storage encrypted' });
  }

  return { indexedDbRecordsMigrated, fallbackStoreMigrated };
}

/**
 * Rewrap a set of already-selected records of one store under `targetKeyVersion`.
 *
 * Extracted unchanged from `rotateTripEncryptionKey` (P4-C-F05) so the bounded
 * per-turn rotation and the explicit whole-pass rotation share exactly one
 * implementation of decrypt/encrypt/one-record-per-transaction ordering.
 */
/**
 * AUD-007 FINAL: rotation re-encode is a publication too. It encodes under the incoming
 * version and commits in its own transaction; without a token those bytes escape between
 * the two exactly like the canonical trip write did.
 */
const rotateRecordsInStore = async (db, {
  storeName,
  records,
  decode,
  encode,
  contextFor,
  normalizedTarget,
  yieldEvery = 20,
  counters,
}) => withDurableKeyPublication(async (publication) => {
  const candidates = [];
  if (counters) counters.examined = (counters.examined || 0) + records.length;
  for (const record of records) {
    if (isSecureDeleteTombstone(record)) {
      const cleanupTx = db.transaction(storeName, 'readwrite');
      const done = idbTransactionDone(cleanupTx);
      await Promise.all([
        idbRequest(cleanupTx.objectStore(storeName).delete(record.id)),
        done,
      ]);
    } else if (Number(record?.encrypted_payload?.key_version) !== normalizedTarget) {
      candidates.push(record);
    }
  }

  let cursor = 0;
  while (cursor < candidates.length) {
    const remaining = candidates.slice(cursor, cursor + 8);
    const batchCount = secureDecryptBatchPrefixLength(remaining.map((record) => ({
      payload: record.encrypted_payload,
      context: contextFor(record.id),
    })));
    const batchRecords = remaining.slice(0, batchCount);
    let plaintextValues;
    let encryptedRecords;
    try {
      plaintextValues = await decode(batchRecords);
      encryptedRecords = await encode(plaintextValues, publication, { keyVersion: normalizedTarget });
      for (let index = 0; index < encryptedRecords.length; index += 1) {
        const encryptedRecord = encryptedRecords[index];
        const writeTx = db.transaction(storeName, 'readwrite');
        const done = idbTransactionDone(writeTx);
        await Promise.all([
          idbRequest(writeTx.objectStore(storeName).put(encryptedRecord)),
          done,
        ]);
        plaintextValues[index] = null;
        encryptedRecords[index] = null;
        counters.rotated += 1;
        counters.processed += 1;
        if (yieldEvery > 0 && counters.processed % yieldEvery === 0) await yieldToEventLoop();
      }
    } finally {
      plaintextValues?.fill?.(null);
      encryptedRecords?.fill?.(null);
      batchRecords.length = 0;
    }
    cursor += batchCount;
  }
}, { createsReferences: false });

/** Rewrap the projection rows in `records`, which carry their own AAD. */
const rotateProjectionRecords = async (db, { records, normalizedTarget, yieldEvery = 20, counters }) => {
  if (counters) counters.examined = (counters.examined || 0) + records.length;
  const encrypted = records.filter((record) => (
    record?.projection_version !== PROJECTION_STALE_VERSION
    && isEncryptedPayload(record?.encrypted_payload)
  ));
  for (const record of encrypted) {
    if (Number(record.encrypted_payload?.key_version) === normalizedTarget) continue;
    const [envelope] = await decryptSensitiveValues([{
      payload: record.encrypted_payload,
      context: projectionEncryptionContext(record.id),
    }]);
    // AUD-007 round 6: a rewrap is still a durable root-key-bound publication, so it holds
    // the canonical token across encrypt-and-commit. `createsReferences: false` because it
    // moves an existing reference onto the incoming version rather than creating a new one
    // against the outgoing version — counting it would invalidate every proof watermark
    // for no gain.
    await withDurableKeyPublication(async () => {
      const [payload] = await encryptSensitiveValues([{
        value: envelope,
        context: projectionEncryptionContext(record.id),
      }], { keyVersion: normalizedTarget });
      // One record per read-write transaction, sequentially awaited, exactly
      // as the P2 rotation contract requires.
      const writeTx = db.transaction(TRIP_PROJECTION_STORE, 'readwrite');
      const done = idbTransactionDone(writeTx);
      await Promise.all([
        idbRequest(writeTx.objectStore(TRIP_PROJECTION_STORE)
          .put({ ...record, encrypted_payload: payload })),
        done,
      ]);
    }, { createsReferences: false });
    counters.rotated += 1;
    counters.processed += 1;
    if (yieldEvery > 0 && counters.processed % yieldEvery === 0) await yieldToEventLoop();
  }
};

/**
 * Rewrap the single fallback trips blob, which is one document, not a store.
 *
 * P4-C-F05: this reads, decrypts and rewrites the whole archive, so it is only
 * ever reachable from the explicit whole-history rotation - never from a
 * coordinated KEK turn. It stamps the O(1) reference record on the way out, so
 * the next finalization can tell that the retiring key is free.
 */
const rotateFallbackTripsBlob = async (normalizedTarget) => {
  const fallbackPayload = await getJson(TRIPS_KEY, null);
  if (fallbackPayload == null) {
    await clearFallbackTripsReference();
    return false;
  }
  if (isEncryptedPayload(fallbackPayload) && Number(fallbackPayload.key_version) !== normalizedTarget) {
    const fallbackTrips = await decryptSensitiveValue(fallbackPayload, `storage:${TRIPS_KEY}`);
    await writeFallbackTripsDocument(fallbackTrips, { keyVersion: normalizedTarget });
    return true;
  }
  if (Array.isArray(fallbackPayload)) {
    await writeFallbackTripsDocument(fallbackPayload, { keyVersion: normalizedTarget });
    return true;
  }
  if (isEncryptedPayload(fallbackPayload)) {
    // Already on the target version: nothing to rewrite, but the reference is
    // now known, which is what releases the retiring key.
    await setJson(TRIPS_FALLBACK_REFERENCE_KEY, {
      present: true, keyVersion: normalizedTarget, updatedAt: Date.now(),
    });
  }
  return false;
};

/**
 * P4-C-F04 / P4-C-F05 — the explicit, production-reachable owner of every
 * monolithic fallback trip obligation.
 *
 * The bounded lifecycle turns (`stepLegacyTripStorageEncryption`,
 * `stepRetiredTripEventTypeMigration`, `stepTripEncryptionKeyRotationBatch`)
 * report `ownerless` for `TRIPS_KEY` because a single indivisible JSON document
 * cannot be a bounded unit at any window size. `ownerless` is only honest if
 * something real does the work; this is that something. It is invoked from the
 * app's quiet-period compatibility step - the same explicit, non-lifecycle
 * surface that owns the v1 queue conversions - and never from a coordinator
 * turn, so no whole-document work returns to `appWorkCoordinator`,
 * `appLifecycleWork`, or `repositoryMaintenance`.
 *
 * It discharges, in order:
 *   1. encryption: a still-plaintext archive is sanitized and encrypted;
 *   2. rewrap: an archive on a superseded key version is decrypted and
 *      re-encrypted under `targetKeyVersion` (the active key by default);
 *   3. proof: the O(1) reference record is stamped with what the archive now
 *      holds, which is what later lets a retained key version be released.
 *
 * Restart behaviour: each step is one whole-document write whose reference
 * stamp lands only after the write resolves. An interruption leaves the archive
 * readable under the key it already had and no marker claiming otherwise, and
 * the next invocation simply repeats the outstanding step.
 */
export async function runMonolithicTripCompatibilityMaintenance({
  targetKeyVersion = null,
} = {}) {
  const requested = Math.max(0, Number(targetKeyVersion) || 0);
  const active = requested || Math.max(0, Number(
    await getActiveEncryptionKeyVersion().catch(() => 0)
  ) || 0);
  const target = Math.max(1, active || 1);

  const encrypted = await encryptFallbackTripsDocument();
  let rotated = false;
  try {
    rotated = await rotateFallbackTripsBlob(target);
  } catch (error) {
    logSystemFailure('trip_storage_fallback_rotation_compatibility', error, {
      key: TRIPS_KEY,
      target_key_version: target,
    });
  }

  const reference = await readFallbackTripDocumentReference();
  if (encrypted || rotated) {
    recordSystemEvent('trip_fallback_compatibility_maintained', {
      encrypted,
      rotated,
      key_version: reference.keyVersion,
    }, { category: 'privacy', title: 'Legacy trip archive maintained' });
  }
  return {
    owner: MONOLITHIC_DOCUMENT_OWNER,
    document: TRIPS_KEY,
    encrypted,
    rotated,
    present: reference.present,
    keyVersion: reference.keyVersion,
    // Nothing is outstanding once the archive is proven absent, or proven to be
    // on the target version. An unknown probe leaves the obligation open.
    settled: reference.present === false || (
      reference.present === true && reference.known && reference.keyVersion === target
    ),
    targetKeyVersion: target,
  };
}

/**
 * P4-C-F05 — one bounded browser/IndexedDB KEK rotation batch.
 *
 * The non-Android rotation used to call `rotateTripEncryptionKey`, which reads
 * the trip, summary and projection stores with `getAll()` and rewrites every
 * candidate before returning, all inside one suspendible coordinator turn. A
 * larger archive made that one turn bigger rather than producing more turns.
 *
 * The sweep is now a fixed window per call against a domain-owned cursor in
 * `trip_meta`, so:
 *
 *  - at most `limit` source rows (and their 1:1 summary rows), then at most
 *    `limit` projection rows, are resident per call;
 *  - the cursor records the target version, so a renderer restart resumes the
 *    same `pendingVersion` sweep instead of starting a different one;
 *  - the caller finalizes - old-key deletion, committed version, rotation log,
 *    event - only when this reports `hasMore: false`.
 */
export const TRIP_KEY_ROTATION_WINDOW = 25;
const KEY_ROTATION_CURSOR_KEY = 'trip_key_rotation_cursor';

export async function stepTripEncryptionKeyRotationBatch(targetKeyVersion, {
  limit = TRIP_KEY_ROTATION_WINDOW,
  yieldEvery = 20,
} = {}) {
  const normalizedTarget = Math.max(1, Number(targetKeyVersion) || 1);
  // `examined` is every ciphertext record this batch read, including the ones
  // already on the target version that needed no rewrite.
  const counters = { rotated: 0, processed: 0, examined: 0 };

  if (!canUseIndexedDb()) {
    // P4-C-F05: with no record store the only thing left is the monolithic
    // fallback document, and decrypting/rewriting all of it is not a bounded
    // KEK turn at any window size. The sweep is ownerless here; the caller must
    // not finalize as if the ciphertext had been rewrapped.
    return monolithicOwnerless(TRIPS_KEY, {
      indexedDbRecordsRotated: 0,
      fallbackStoreRotated: false,
      fallbackDocumentPending: fallbackTripDocumentMayExist(await readFallbackTripDocumentReference()),
    });
  }

  const db = await openDb();
  try {
    const stored = await readTripMeta(db, KEY_ROTATION_CURSOR_KEY, null);
    // A cursor for a different target belongs to an abandoned rotation.
    const state = stored && Number(stored.targetKeyVersion) === normalizedTarget
      ? stored
      : { targetKeyVersion: normalizedTarget, phase: 'source', cursor: null };

    if (state.phase === 'source') {
      const rows = await readIndexWindow(db, {
        storeName: TRIP_STORE,
        indexName: TRIP_INDEX_START_TIME_ID,
        after: state.cursor,
        limit,
      });
      if (rows.length) {
        const records = rows.map(({ value }) => value).filter(Boolean);
        await rotateRecordsInStore(db, {
          storeName: TRIP_STORE,
          records,
          decode: decodeTripRecords,
          encode: encodeTripRecords,
          contextFor: tripEncryptionContext,
          normalizedTarget,
          yieldEvery,
          counters,
        });
        if (db.objectStoreNames.contains(TRIP_SUMMARY_STORE)) {
          // Summaries are keyed by trip id and written with their trip, so the
          // window's own ids select exactly the summary rows that belong to it.
          const summaryTx = db.transaction(TRIP_SUMMARY_STORE, 'readonly');
          const summaryStore = summaryTx.objectStore(TRIP_SUMMARY_STORE);
          const summaries = (await Promise.all(
            records.map((record) => idbRequest(summaryStore.get(record.id))),
          )).filter(Boolean);
          if (summaries.length) {
            await rotateRecordsInStore(db, {
              storeName: TRIP_SUMMARY_STORE,
              records: summaries,
              decode: decodeTripSummaryRecords,
              encode: encodeTripSummaryRecords,
              contextFor: tripSummaryEncryptionContext,
              normalizedTarget,
              yieldEvery,
              counters,
            });
          }
        }
        await writeTripMetaRecord(db, KEY_ROTATION_CURSOR_KEY, {
          targetKeyVersion: normalizedTarget,
          phase: 'source',
          cursor: rows[rows.length - 1].key,
        });
        return {
          indexedDbRecordsRotated: counters.rotated,
          fallbackStoreRotated: false,
          processed: rows.length,
          // P4-C-F09: source rows plus the 1:1 summary rows this window read.
          examined: counters.examined,
          hasMore: true,
        };
      }
      await writeTripMetaRecord(db, KEY_ROTATION_CURSOR_KEY, {
        targetKeyVersion: normalizedTarget,
        phase: 'projection',
        cursor: null,
      });
      return {
        indexedDbRecordsRotated: 0,
        fallbackStoreRotated: false,
        processed: 0,
        examined: 0,
        hasMore: true,
      };
    }

    if (state.phase === 'projection' && db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) {
      const rows = await readIndexWindow(db, {
        storeName: TRIP_PROJECTION_STORE,
        indexName: TRIP_INDEX_START_TIME_ID,
        after: state.cursor,
        limit,
      });
      if (rows.length) {
        await rotateProjectionRecords(db, {
          records: rows.map(({ value }) => value).filter(Boolean),
          normalizedTarget,
          yieldEvery,
          counters,
        });
        await writeTripMetaRecord(db, KEY_ROTATION_CURSOR_KEY, {
          targetKeyVersion: normalizedTarget,
          phase: 'projection',
          cursor: rows[rows.length - 1].key,
        });
        return {
          indexedDbRecordsRotated: counters.rotated,
          fallbackStoreRotated: false,
          processed: rows.length,
          examined: counters.examined,
          hasMore: true,
        };
      }
    }

    // Every store window is exhausted. The monolithic fallback document is not
    // rotated here - a lifecycle turn may never rewrite it - so the sweep
    // reports whether that obligation is still outstanding and the caller
    // decides what may be retired.
    await writeTripMetaRecord(db, KEY_ROTATION_CURSOR_KEY, null);
    const reference = await readFallbackTripDocumentReference();
    return {
      indexedDbRecordsRotated: counters.rotated,
      fallbackStoreRotated: false,
      fallbackDocumentPending: fallbackTripDocumentMayExist(reference),
      fallbackDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
      processed: 0,
      examined: 0,
      hasMore: false,
    };
  } finally {
    db.close();
  }
}

export async function rotateTripEncryptionKey(targetKeyVersion, { yieldEvery = 20 } = {}) {
  const normalizedTarget = Math.max(1, Number(targetKeyVersion) || 1);
  let indexedDbRecordsRotated = 0;
  let processed = 0;

  if (canUseIndexedDb()) {
    const db = await openDb();
    try {
      // AUD-007 REDESIGN. The explicit whole-history rotation has its own copy of the
      // rewrap loop, and it encoded and committed with no publication — the same defect
      // CODEX found twice elsewhere, in a third place nobody had looked. It is admitted
      // with `createsReferences: false` for the same reason as the bounded turn: a rewrap
      // moves an existing reference onto the incoming version rather than creating one
      // against the outgoing version.
      const rotateStoreRecords = async ({ storeName, records, decode, encode, contextFor }) => (
        withDurableKeyPublication(async (publication) => {
        const candidates = [];
        for (const record of records) {
          if (isSecureDeleteTombstone(record)) {
            const cleanupTx = db.transaction(storeName, 'readwrite');
            const done = idbTransactionDone(cleanupTx);
            await Promise.all([
              idbRequest(cleanupTx.objectStore(storeName).delete(record.id)),
              done,
            ]);
          } else if (Number(record?.encrypted_payload?.key_version) !== normalizedTarget) {
            candidates.push(record);
          }
        }

        let cursor = 0;
        while (cursor < candidates.length) {
          const remaining = candidates.slice(cursor, cursor + 8);
          const batchCount = secureDecryptBatchPrefixLength(remaining.map((record) => ({
            payload: record.encrypted_payload,
            context: contextFor(record.id),
          })));
          const batchRecords = remaining.slice(0, batchCount);
          let plaintextValues;
          let encryptedRecords;
          try {
            plaintextValues = await decode(batchRecords);
            encryptedRecords = await encode(plaintextValues, publication, { keyVersion: normalizedTarget });
            for (let index = 0; index < encryptedRecords.length; index += 1) {
              const encryptedRecord = encryptedRecords[index];
              const writeTx = db.transaction(storeName, 'readwrite');
              const done = idbTransactionDone(writeTx);
              await Promise.all([
                idbRequest(writeTx.objectStore(storeName).put(encryptedRecord)),
                done,
              ]);
              plaintextValues[index] = null;
              encryptedRecords[index] = null;
              indexedDbRecordsRotated += 1;
              processed += 1;
              if (yieldEvery > 0 && processed % yieldEvery === 0) await yieldToEventLoop();
            }
          } finally {
            plaintextValues?.fill?.(null);
            encryptedRecords?.fill?.(null);
            batchRecords.length = 0;
          }
          cursor += batchCount;
        }
        }, { createsReferences: false })
      );

      const readTx = db.transaction(TRIP_STORE, 'readonly');
      const records = await idbRequest(readTx.objectStore(TRIP_STORE).getAll());
      await rotateStoreRecords({
        storeName: TRIP_STORE,
        records,
        decode: decodeTripRecords,
        encode: encodeTripRecords,
        contextFor: tripEncryptionContext,
      });
      if (db.objectStoreNames.contains(TRIP_SUMMARY_STORE)) {
        const summaryReadTx = db.transaction(TRIP_SUMMARY_STORE, 'readonly');
        const summaries = await idbRequest(summaryReadTx.objectStore(TRIP_SUMMARY_STORE).getAll());
        await rotateStoreRecords({
          storeName: TRIP_SUMMARY_STORE,
          records: summaries,
          decode: decodeTripSummaryRecords,
          encode: encodeTripSummaryRecords,
          contextFor: tripSummaryEncryptionContext,
        });
      }
      // Projections hold their own ciphertext under a distinct AAD. Rotating
      // trips and legacy summaries but not projections would leave every
      // projection encrypted under a key the rotation manager then deletes,
      // which breaks the bounded read path for the whole history.
      if (db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) {
        const projectionReadTx = db.transaction(TRIP_PROJECTION_STORE, 'readonly');
        const projections = await idbRequest(
          projectionReadTx.objectStore(TRIP_PROJECTION_STORE).getAll()
        );
        // A version-0 deterministic marker carries no ciphertext: rotating it
        // would be a no-op at best and a decrypt failure at worst.
        const encrypted = projections.filter((record) => (
          record?.projection_version !== PROJECTION_STALE_VERSION
          && isEncryptedPayload(record?.encrypted_payload)
        ));
        for (const record of encrypted) {
          if (Number(record.encrypted_payload?.key_version) === normalizedTarget) continue;
          const [envelope] = await decryptSensitiveValues([{
            payload: record.encrypted_payload,
            context: projectionEncryptionContext(record.id),
          }]);
          // AUD-007 round 6: same token discipline as the other projection rewrap.
          await withDurableKeyPublication(async () => {
            const [payload] = await encryptSensitiveValues([{
              value: envelope,
              context: projectionEncryptionContext(record.id),
            }], { keyVersion: normalizedTarget });
            // One record per read-write transaction, sequentially awaited, exactly
            // as the P2 rotation contract requires.
            const writeTx = db.transaction(TRIP_PROJECTION_STORE, 'readwrite');
            const done = idbTransactionDone(writeTx);
            await Promise.all([
              idbRequest(writeTx.objectStore(TRIP_PROJECTION_STORE)
                .put({ ...record, encrypted_payload: payload })),
              done,
            ]);
          }, { createsReferences: false });
          indexedDbRecordsRotated += 1;
          processed += 1;
          if (yieldEvery > 0 && processed % yieldEvery === 0) await yieldToEventLoop();
        }
      }
    } finally {
      db.close();
    }
  }

  // The explicit whole-history rotation is the owner of the monolithic fallback
  // document; the coordinated batch above deliberately never touches it.
  const fallbackStoreRotated = await rotateFallbackTripsBlob(normalizedTarget);

  return { indexedDbRecordsRotated, fallbackStoreRotated };
}

export async function inspectStoredTripKeyVersions() {
  if (canUseIndexedDb()) {
    try {
      const db = await openDb();
      try {
        const tx = db.transaction(TRIP_STORE, 'readonly');
        const records = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
        const summaryRecords = db.objectStoreNames.contains(TRIP_SUMMARY_STORE)
          ? await idbRequest(db.transaction(TRIP_SUMMARY_STORE, 'readonly').objectStore(TRIP_SUMMARY_STORE).getAll())
          : [];
        // Projections are encrypted payloads like any other, so an old key
        // cannot be retired while one still depends on it. Deterministic
        // failure markers are excluded because they hold no ciphertext at all —
        // including them would report a key dependency that does not exist.
        const projectionRecords = db.objectStoreNames.contains(TRIP_PROJECTION_STORE)
          ? (await idbRequest(db.transaction(TRIP_PROJECTION_STORE, 'readonly').objectStore(TRIP_PROJECTION_STORE).getAll()))
            .filter((record) => (
              record?.projection_version !== PROJECTION_STALE_VERSION
              && record?.encrypted_payload != null
            ))
          : [];
        return records
          .concat(summaryRecords)
          .concat(projectionRecords)
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

/**
 * Serializes writes per trip id.
 *
 * Trip writes are read-modify-write and always `put()` the whole record, so two writers to the
 * same trip silently discard each other's changes. The read and write cannot share one
 * IndexedDB transaction because privacy sanitization and Web Crypto run between them and a
 * transaction auto-commits at the next event-loop turn — hence an app-level lock.
 *
 * Same shape as `activeTripWriteQueue` in trackingStore.js, but partitioned by id so unrelated
 * trips never block each other, and errors reach the caller instead of being swallowed.
 * Chaining is forward-only and no lock is acquired while another is held, so it cannot deadlock.
 */
/** @type {Map<string, Promise<any>>} */
const tripWriteQueues = new Map();

/**
 * @param {string[]} keys
 * @param {Promise<any>} tail
 */
const releaseTripWriteQueue = (keys, tail) => {
  keys.forEach((key) => {
    if (tripWriteQueues.get(key) === tail) tripWriteQueues.delete(key);
  });
};

/**
 * @template T
 * @param {any[]} ids
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const withTripWriteLocks = (ids, task) => {
  const keys = [...new Set((Array.isArray(ids) ? ids : [ids]).map((id) => String(id)))];
  if (!keys.length) return Promise.resolve().then(task);
  const previousTails = keys.map((key) => tripWriteQueues.get(key) || Promise.resolve());
  // Run whether or not the previous holder succeeded; one failure must not stall the queue.
  const run = Promise.all(previousTails).then(task, task);
  const tail = run.catch(() => {});
  keys.forEach((key) => tripWriteQueues.set(key, tail));
  tail.then(() => releaseTripWriteQueue(keys, tail));
  return run;
};

/**
 * @template T
 * @param {any} id
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const withTripWriteLock = (id, task) => withTripWriteLocks([id], task);

/**
 * Serializes the non-IndexedDB fallback path, where every trip lives in one `TRIPS_KEY` blob.
 * Per-id locks cannot help there: writers for two *different* trips still collide on the same
 * read-modify-write of the shared array. Both layers are required.
 */
let fallbackTripsWriteQueue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
const withFallbackTripsQueue = (task) => {
  const run = fallbackTripsWriteQueue.then(task, task);
  fallbackTripsWriteQueue = run.catch(() => {});
  return run;
};

const sameFieldValue = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

/**
 * Describes what a writer changed relative to the snapshot it computed from: the fields it set,
 * and the fields it deliberately removed (migrations drop retired keys, so a set-only diff would
 * let a merge resurrect them).
 */
const diffTripFields = (next, previous) => {
  const changed = {};
  const removed = [];
  if (!next || typeof next !== 'object') return { changed, removed };
  const before = previous && typeof previous === 'object' ? previous : {};
  Object.keys(next).forEach((key) => {
    if (!sameFieldValue(next[key], before[key])) changed[key] = next[key];
  });
  Object.keys(before).forEach((key) => {
    if (!(key in next)) removed.push(key);
  });
  return { changed, removed };
};

/** Applies one writer's field changes on top of the freshest stored record. */
const mergeTripFieldChanges = (current, original, next) => {
  const { changed, removed } = diffTripFields(next, original);
  if (!Object.keys(changed).length && !removed.length) return current;
  const merged = { ...current, ...changed };
  removed.forEach((key) => { delete merged[key]; });
  return merged;
};

/**
 * Persist one trip from its **raw source**, returning the sanitized record that
 * was stored.
 *
 * Callers must pass the unsanitized source and use the returned value. Doing the
 * sanitization in the caller would put a source-sized copy in memory before the
 * preflight that exists to measure the source, and would then sanitize a second
 * time in here.
 *
 * Every stage — measurement, `toJSON`, sanitization, summary/projection
 * preparation, crypto, the IndexedDB write and the fallback write — is inside
 * the typed failure contract. A cycle, a BigInt, a throwing `toJSON`, a
 * sanitizer fault or a failed fallback must surface as `TripPersistenceFailedError`
 * and never as a raw error that a caller could mistake for something other than
 * "this save did not happen".
 */
/**
 * AUD-007 FINAL. THE canonical durable publication boundary for a single trip.
 *
 * Everything that makes root-key-bound ciphertext for this operation — the trip wrapper,
 * the legacy summary wrapper and the projection envelope — and the one IndexedDB
 * transaction that commits them all, live inside a single publication token. The token is
 * released only after `idbTransactionDone(tx)` resolves: a queued `put()` is not a commit,
 * an open transaction is not a commit, and bytes in hand are certainly not a commit.
 *
 * Create, update/edit and every other single-record path share this function, so they
 * inherit the guarantee without each needing its own wrapper — which is the point. A
 * future `createFooTrip()` that persists through here cannot bypass admission by someone
 * forgetting to wrap it.
 */
const putTrip = async (trip) => withDurableKeyPublication(async (publication) => {
  let storageTrip = null;
  let sourceBytes = 0;
  let isolatedStaging = false;
  try {
    // All-field source preflight runs BEFORE the privacy-sanitized copy, the
    // legacy summary, the projection, any JSON plaintext and any ciphertext, so an
    // open-shaped imported field is measured with early abort instead of being
    // discovered only after several source-sized representations already exist.
    // The resulting charge is observability — it selects isolated staging, never
    // rejection, truncation or deferral.
    ({ bytes: sourceBytes } = measureSourceTrip(trip));
    isolatedStaging = chunkCharge(sourceBytes) > MAX_CHUNK_LOGICAL_CHARGE;
    storageTrip = await sanitizeTripForPrivacyStorageAsync(trip);
    const encryptedTrip = await encodeTripRecord(storageTrip, publication);
    const encryptedSummary = await encodeTripSummaryRecord(storageTrip, publication);
    const revision = mintSourceRevision();
    const [projectionRecord] = await buildProjectionsForWrite([storageTrip], [revision], publication);
    // The digest is asynchronous, so it is taken before the transaction opens:
    // awaiting inside one would let IndexedDB auto-commit mid-write.
    const sourceHash = await p6SourceHash(encryptedTrip);
    const db = await openDb();
    try {
      const hasSummaryStore = db.objectStoreNames.contains(TRIP_SUMMARY_STORE);
      const hasProjectionStore = db.objectStoreNames.contains(TRIP_PROJECTION_STORE);
      const stores = [TRIP_STORE];
      if (hasSummaryStore) stores.push(TRIP_SUMMARY_STORE);
      if (hasProjectionStore) stores.push(TRIP_PROJECTION_STORE);
      // The single-record path is the one ordinary saves and edits take, so it
      // owes the same revision-bound derived debt the batch path records. A
      // canonical commit without its marker would leave D1-D4 permanently
      // unaware of the trip.
      const hasP6WorkStore = db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.WORK);
      if (hasP6WorkStore) stores.push(P6_TRIP_DERIVED_STORES.WORK);
      const hasP6ManifestStore = db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.MANIFESTS);
      if (hasP6ManifestStore) stores.push(P6_TRIP_DERIVED_STORES.MANIFESTS);
      // P7 A2.4: the single-record write is the atomic host for the browser
      // query revision. A create, an ordering-key edit, a status edit, a vehicle
      // change and a score change all land here, and each must make an
      // outstanding cursor restart rather than silently skip or duplicate a row.
      const hasMetaStore = db.objectStoreNames.contains(TRIP_META_STORE);
      if (hasMetaStore) stores.push(TRIP_META_STORE);
      const tx = db.transaction(stores, 'readwrite');
      if (hasMetaStore) advanceQueryRevisionWithin(tx);
      tx.objectStore(TRIP_STORE).put({ ...encryptedTrip, source_revision: revision });
      if (hasSummaryStore) {
        tx.objectStore(TRIP_SUMMARY_STORE).put({ ...encryptedSummary, source_revision: revision });
      }
      if (hasProjectionStore && projectionRecord) {
        tx.objectStore(TRIP_PROJECTION_STORE).put(projectionRecord);
      }
      if (hasP6WorkStore) {
        tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put(p6TripWorkRecord({
          trip: storageTrip, revision, sourceHash,
        }));
      }
      if (hasP6ManifestStore) {
        dirtyP6GlobalHeads(tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS), 'SOURCE_REVISION_CHANGED');
      }
      await idbTransactionDone(tx);
      // AUD-001: the source revision this transaction advanced is now DURABLE. Every
      // single-record class — create, update, edit, split, retention repair — shares this
      // commit, so none of them has to remember to signal separately.
      publishP7SourceChange('trip_committed');
    } finally {
      db.close();
    }
  } catch (error) {
    const failed = (cause, stage) => {
      logSystemFailure(stage, cause, {
        db_name: DB_NAME,
        trip_id_present: (storageTrip ?? trip)?.id != null,
      });
      return new TripPersistenceFailedError(
        'Road Sage could not safely save this trip. Existing trip data was left unchanged.',
        { tripIdPresent: (storageTrip ?? trip)?.id != null, sourceBytes, isolatedStaging },
        { cause }
      );
    };

    // The fallback backend can only run once a sanitized record exists. If
    // preparation itself failed there is nothing safe to write, so falling
    // through to it would persist either nothing or an unsanitized source.
    if (storageTrip !== null && !canUseIndexedDb()) {
      try {
        await withFallbackTripsQueue(async () => {
          const trips = await getEncryptedJson(TRIPS_KEY, []);
          const next = [storageTrip, ...trips.filter((item) => String(item.id) !== String(storageTrip.id))];
          await writeFallbackTripsDocument(next);
        });
        return storageTrip;
      } catch (fallbackError) {
        throw failed(fallbackError, 'trip_repository_fallback_write');
      }
    }

    throw failed(error, 'trip_repository_indexeddb_write');
  }
  return storageTrip;
});

/**
 * Read the three bounded native-suppression states. All are constant-size: the
 * per-id set is capped by the native journal's 64-entry maximum, and a probe
 * outage or pending erase is one global record rather than per-delete metadata.
 */
const readNativeSuppressionState = async () => {
  const empty = {
    visibility: defaultNativeVisibility(),
    erasurePending: defaultNativeErasurePending(),
    ids: { ids: {} },
  };
  if (!canUseIndexedDb()) return empty;
  try {
    const db = await openDb();
    try {
      return {
        visibility: await readTripMeta(db, META_KEYS.NATIVE_VISIBILITY, empty.visibility),
        erasurePending: await readTripMeta(db, META_KEYS.NATIVE_ERASURE_PENDING, empty.erasurePending),
        ids: await readTripMeta(db, META_KEYS.NATIVE_SUPPRESSION, empty.ids),
      };
    } finally {
      db.close();
    }
  } catch {
    // Fail closed: an unreadable suppression state must not become
    // "known, nothing suppressed", which would admit every native completion
    // exactly when the metadata guarding deletions is unavailable.
    return {
      visibility: { state: 'uncertain', generation: 0, since: Date.now() },
      erasurePending: { pending: true, since: Date.now(), attempts: 0 },
      ids: { ids: {} },
    };
  }
};

/** Read one bounded `trip_meta` record, or its default. */
const readTripMeta = async (db, key, fallback) => {
  if (!db.objectStoreNames.contains(TRIP_META_STORE)) return fallback;
  const tx = db.transaction(TRIP_META_STORE, 'readonly');
  const record = await idbRequest(tx.objectStore(TRIP_META_STORE).get(key));
  return record?.value ?? fallback;
};

/**
 * Advance the browser query revision **inside a transaction the caller already
 * opened**, so the advance commits atomically with the mutation's own
 * projection write (Annex A §A2.4 clause 3).
 *
 * The read and the write are chained through the request callback rather than
 * through `await`, because awaiting between them would let IndexedDB
 * auto-commit the transaction mid-advance.
 *
 * @param {IDBTransaction} tx a readwrite transaction that includes `trip_meta`
 */
const advanceQueryRevisionWithin = (tx) => {
  let store;
  try {
    store = tx.objectStore(TRIP_META_STORE);
  } catch {
    // The caller did not include `trip_meta` in its scope. Advancing is then
    // impossible here, and the mutation path must take the conservative epoch
    // instead; silently doing nothing would be a missed invalidation.
    return false;
  }
  const request = store.get(P7_QUERY_REVISION_KEY);
  request.onsuccess = () => {
    const current = request.result?.value;
    store.put({
      key: P7_QUERY_REVISION_KEY,
      value: {
        generation: String(current?.generation || mintSourceRevision()),
        revision: (Number(current?.revision) || 0) + 1,
      },
    });
  };
  return true;
};

/**
 * The current P7 query snapshot every cursor v2 token is bound to.
 *
 * A missing record is not an error: it means no row-set-relevant mutation has
 * happened under P7 yet, so the snapshot starts at revision 0 with a freshly
 * minted epoch.
 *
 * @returns {Promise<{authority: 'browser', generation: string, revision: number}>}
 */
export async function readP7QuerySnapshot() {
  const fallback = { generation: '', revision: 0 };
  if (!canUseIndexedDb()) return { authority: 'browser', ...fallback, revision: unprovenEpochAdvances };
  const db = await openDb();
  try {
    const stored = await readTripMeta(db, P7_QUERY_REVISION_KEY, null);
    return {
      authority: 'browser',
      generation: String(stored?.generation ?? fallback.generation),
      // An epoch advance that could not be made durable still has to invalidate
      // every outstanding cursor: folding it in here means a stale token is
      // refused for the rest of the session rather than silently accepted.
      revision: (Number(stored?.revision) || 0) + unprovenEpochAdvances,
    };
  } finally { db.close(); }
}

/**
 * Epoch advances that failed to persist. Never decremented: a cursor minted
 * before one must never become valid again in this session.
 */
let unprovenEpochAdvances = 0;

/**
 * The conservative epoch of Annex A §A2.4 clause 4: re-mint the generation and
 * advance the revision, which refuses **every** outstanding cursor and Q10
 * continuation before any row.
 *
 * Used by the mutation classes that genuinely cannot share a single
 * projection-write transaction — deletion, import, restore, erasure and
 * canonical generation rollover. Conservative over-invalidation is legal; a
 * missed invalidation is not.
 *
 * @param {string} reason recorded for diagnostics only
 */
export async function advanceP7QueryEpoch(reason = 'bulk_mutation') {
  if (!canUseIndexedDb()) return { advanced: false, reason };
  // AUD-001, found while attacking the coordinator: opening the database was OUTSIDE the
  // try, so a storage failure at that moment escaped without incrementing the unproven
  // counter and without signalling. Every caller reaches here AFTER its mutation has
  // already committed — a delete, an import, an erasure — so "could not open storage" is
  // not "nothing changed"; it is a change nobody was told about.
  let db = null;
  try {
    db = await openDb();
    const current = await readTripMeta(db, P7_QUERY_REVISION_KEY, null);
    const next = {
      generation: mintSourceRevision(),
      revision: (Number(current?.revision) || 0) + 1,
    };
    await writeTripMetaRecord(db, P7_QUERY_REVISION_KEY, next);
    // AUD-001: the canonical source has advanced and is durable. One O(1) signal.
    publishP7SourceChange(reason);
    return { advanced: true, reason, ...next };
  } catch (error) {
    // A failed advance must not look like a successful one: a stale cursor that
    // is accepted afterwards is exactly the duplicate/skip defect cursor v2
    // exists to prevent. The in-memory counter keeps every outstanding cursor
    // refused for the rest of the session even though the durable write failed,
    // so the caller's own mutation result is reported truthfully instead of
    // being turned into a failure it did not have.
    unprovenEpochAdvances += 1;
    logSystemFailure('p7_query_epoch_advance', error, { reason });
    // AUD-001: the advance is not durable but IS conservatively known to have happened —
    // every outstanding cursor is refused for the rest of the session. A cache still
    // showing the pre-mutation answer would be the visible half of that same defect.
    publishP7SourceChange(`${reason}:unproven`);
    return { advanced: false, durable: false, reason };
  } finally { db?.close(); }
}

const writeTripMetaRecord = async (db, key, value) => {
  if (!db.objectStoreNames.contains(TRIP_META_STORE)) return;
  const tx = db.transaction(TRIP_META_STORE, 'readwrite');
  tx.objectStore(TRIP_META_STORE).put({ key, value });
  await idbTransactionDone(tx);
};

/**
 * A recovery obligation that could not be made durable.
 *
 * Deletion and erasure both depend on obligations that stop a *different*
 * store — the fallback blob, the native completed journal — from handing the
 * data back. When one cannot be stored, the safe outcome is a failed operation,
 * never a successful-looking one.
 */
export class TripDeletionObligationError extends Error {
  constructor(source, options = {}) {
    super(`The ${source} deletion obligation could not be stored, so this deletion is not safe to report as complete.`, options);
    this.name = 'TripDeletionObligationError';
    this.source = source;
  }
}

/**
 * Write a bounded `trip_meta` record and **prove** it landed.
 *
 * `writeTripMetaRecord` returns silently when the store is absent, which is
 * right for optional maintenance bookkeeping and wrong for a safety barrier: a
 * silently dropped write is exactly the difference between a durable obligation
 * and an assumption that one exists.
 */
const requireTripMetaRecord = async (db, key, value) => {
  if (!db.objectStoreNames.contains(TRIP_META_STORE)) {
    throw new Error(`The ${key} obligation cannot be stored: trip_meta is unavailable.`);
  }
  await writeTripMetaRecord(db, key, value);
  const stored = await readTripMeta(db, key, null);
  if (stored == null) throw new Error(`The ${key} obligation did not persist.`);
  return stored;
};

/**
 * Record a deleted id in the bounded fallback overlay.
 *
 * Constant-time and constant-size: at most 512 explicit ids are ever stored, and
 * the 513th insertion flips a global saturated flag instead of appending, so a
 * mature history cannot turn deletion metadata into O(deletes).
 */
const suppressDeletedIdInFallback = async (db, id) => {
  try {
    const current = await readTripMeta(db, META_KEYS.FALLBACK_SUPPRESSION, defaultFallbackSuppression());
    const next = suppressFallbackId(current, id, Date.now());
    if (next !== current) await requireTripMetaRecord(db, META_KEYS.FALLBACK_SUPPRESSION, next);
    const seq = await readTripMeta(db, META_KEYS.DELETE_SEQ, { value: 0 });
    await requireTripMetaRecord(db, META_KEYS.DELETE_SEQ, { value: (seq.value || 0) + 1 });
  } catch (error) {
    logSystemFailure('trip_projection_fallback_suppression', error, { db_name: DB_NAME });
    // The overlay could not record this id, so fallback reads can no longer be
    // trusted to hide this deletion. Saturating is the fail-closed substitute:
    // it hides everything the overlay cannot account for.
    try {
      const current = await readTripMeta(db, META_KEYS.FALLBACK_SUPPRESSION, defaultFallbackSuppression());
      await requireTripMetaRecord(db, META_KEYS.FALLBACK_SUPPRESSION, {
        ...current, saturated: true, generation: (current.generation || 0) + 1, since: Date.now(),
      });
    } catch (saturationError) {
      // Neither the exact id nor its fail-closed substitute is durable. A stale
      // fallback row can therefore hand this trip back, so the deletion must not
      // be reported as successful.
      throw new TripDeletionObligationError('fallback', { cause: saturationError });
    }
  }
};

/**
 * Probe the native completed journal for a deleted id and record bounded
 * suppression.
 *
 * A successful probe creates an exact entry only when the journal actually holds
 * the id, so the set is bounded by its 64-entry maximum and ordinary deletes
 * never consume capacity. A failed probe writes **no per-id entry** — it raises
 * one global uncertainty flag — so a prolonged bridge outage cannot make
 * suppression metadata grow with the number of deletes.
 */
const suppressDeletedIdInNative = async (db, id) => {
  if (!isAndroid()) return;
  let probe;
  try {
    const result = await nativeTripArchive.tombstone(id, 'legacy_authority_delete', false);
    probe = {
      ok: true,
      present: result?.deleted === true,
      at: Date.now(),
    };
  } catch {
    probe = { ok: false, at: Date.now() };
  }
  try {
    const visibility = await readTripMeta(db, META_KEYS.NATIVE_VISIBILITY, defaultNativeVisibility());
    const suppression = await readTripMeta(db, META_KEYS.NATIVE_SUPPRESSION, { ids: {} });
    const next = recordDeleteForNative({ visibility, suppression, tripId: id, probe });
    if (next.visibility !== visibility) {
      await requireTripMetaRecord(db, META_KEYS.NATIVE_VISIBILITY, next.visibility);
    }
    await requireTripMetaRecord(db, META_KEYS.NATIVE_SUPPRESSION, next.suppression);
  } catch (error) {
    logSystemFailure('trip_projection_native_suppression', error, { db_name: DB_NAME });
    // A failed probe already means the journal may hold this id; failing to
    // persist either the exact suppression or the global uncertainty leaves a
    // queued native completion free to return the trip after a restart.
    throw new TripDeletionObligationError('native', { cause: error });
  }
};

/**
 * Build the projection records that accompany a logical write.
 *
 * A deterministic contract failure yields a `projection_version = 0` marker so
 * the trip and its legacy summary still commit — a cache that cannot be built
 * must never fail a user's save. Any other error propagates and fails the write,
 * so a transient crypto or storage failure keeps its existing semantics.
 */
const buildProjectionsForWrite = async (storageTrips, revisions, publication) => {
  // Threaded, and checked here as well as inside the encoder: this helper is the one
  // place a projection page is built for a canonical write, so a caller that reaches it
  // without a publication is refused before any envelope is even constructed.
  assertDurablePublication(publication, 'buildProjectionsForWrite');
  const envelopes = [];
  const markers = new Map();
  storageTrips.forEach((trip, index) => {
    const revision = revisions[index];
    try {
      envelopes.push({ index, envelope: buildTripProjection(trip, { sourceRevision: revision }) });
    } catch (error) {
      if (!(error instanceof ProjectionBuildError)) throw error;
      markers.set(index, projectionFailureMarkerFor({
        // Raw key, not String(...): the marker must occupy the same key as the
        // source row it stands in for.
        id: trip.id,
        start_time: trip.start_time || '',
        status: trip.status || '',
        source_revision: revision,
      }, error.failureClass));
    }
  });

  const records = new Array(storageTrips.length).fill(null);
  markers.forEach((marker, index) => { records[index] = marker; });
  if (envelopes.length) {
    const payloads = await encodeProjectionPayloads(envelopes.map((entry) => entry.envelope), publication);
    envelopes.forEach((entry, position) => {
      records[entry.index] = projectionRecordFor(entry.envelope, payloads[position], storageTrips[entry.index]?.id);
    });
  }
  return records;
};

const recordP6BrowserTripTombstone = async (db, id) => {
  if (!db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.WORK)) return;
  const stores = [TRIP_STORE, P6_TRIP_DERIVED_STORES.WORK];
  if (db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.MANIFESTS)) {
    stores.push(P6_TRIP_DERIVED_STORES.MANIFESTS);
  }
  const tx = db.transaction(stores, 'readwrite');
  const source = await idbRequest(tx.objectStore(TRIP_STORE).get(id));
  tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put(p6TripWorkRecord({
    trip: { id },
    revision: source?.source_revision || 'deleted',
    // Keep the owner transaction alive: WebCrypto is asynchronous and can let
    // IndexedDB auto-commit while the digest promise is pending. The marker
    // only needs a stable compare token; the stronger asynchronous digest is
    // calculated before transactions on normal writes.
    sourceHash: source ? p6SourceHashSync(source) : 'source-absent',
    disposition: 'TOMBSTONE',
  }));
  if (stores.includes(P6_TRIP_DERIVED_STORES.MANIFESTS)) {
    for (const domain of P6_BROWSER_DOMAIN_IDS) {
      tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
        key: `${domain}:${String(id)}`,
        domain,
        subject: String(id),
        state: 'DIRTY',
        complete: false,
        reason: 'SOURCE_TOMBSTONED',
        updatedAt: Date.now(),
      });
    }
    dirtyP6GlobalHeads(tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS), 'SOURCE_TOMBSTONED');
  }
  await idbTransactionDone(tx);
};

const p6SourceHashSync = (record) => {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  let hash = 2166136261;
  bytes.forEach((value) => { hash = Math.imul(hash ^ value, 16777619) >>> 0; });
  return `fnv1a-${hash.toString(16).padStart(8, '0')}-${bytes.byteLength}`;
};

const p6SourceHash = async (record) => {
  const bytes = new TextEncoder().encode(JSON.stringify(record));
  if (globalThis.crypto?.subtle?.digest) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
  }
  return p6SourceHashSync(record);
};

const p6TripWorkRecord = ({ trip, revision, sourceHash, disposition = 'UPSERT' }) => ({
  tripId: String(trip.id),
  desiredRevision: String(revision),
  sourceHash,
  desiredSeq: Date.now(),
  disposition,
  dirtyDomains: [...P6_BROWSER_DOMAIN_IDS],
  state: 'DIRTY',
  cursor: null,
  updatedAt: Date.now(),
});

/**
 * Persist one admitted chunk: trip + legacy summary + projection commit together
 * under a single source revision, or none of them do.
 */
/**
 * AUD-007 FINAL: the chunked persist boundary. Trip, summary and projection wrappers and
 * the transaction that commits them share one token, released after completion.
 */
const persistTripChunk = async (storageTrips) => withDurableKeyPublication(async (publication) => {
  {
    const encryptedTrips = await encodeTripRecords(storageTrips, publication);
    const encryptedSummaries = await encodeTripSummaryRecords(storageTrips, publication);
    // Every normal logical write mints a fresh revision, which is what makes the
    // read-path guarded put able to detect a concurrent update by comparison.
    const revisions = storageTrips.map(() => mintSourceRevision());
    const projections = await buildProjectionsForWrite(storageTrips, revisions, publication);
    const sourceHashes = await Promise.all(encryptedTrips.map((trip) => p6SourceHash(trip)));
    const db = await openDb();
    try {
      const hasSummaryStore = db.objectStoreNames.contains(TRIP_SUMMARY_STORE);
      const hasProjectionStore = db.objectStoreNames.contains(TRIP_PROJECTION_STORE);
      const stores = [TRIP_STORE];
      if (hasSummaryStore) stores.push(TRIP_SUMMARY_STORE);
      if (hasProjectionStore) stores.push(TRIP_PROJECTION_STORE);
      const hasP6WorkStore = db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.WORK);
      if (hasP6WorkStore) stores.push(P6_TRIP_DERIVED_STORES.WORK);
      const hasP6ManifestStore = db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.MANIFESTS);
      if (hasP6ManifestStore) stores.push(P6_TRIP_DERIVED_STORES.MANIFESTS);
      // P7 A2.4: one advance per committed window. A batch that changes many
      // rows still only has to make outstanding cursors restart once.
      const hasMetaStore = db.objectStoreNames.contains(TRIP_META_STORE);
      if (hasMetaStore) stores.push(TRIP_META_STORE);
      const tx = db.transaction(stores, 'readwrite');
      if (hasMetaStore) advanceQueryRevisionWithin(tx);
      const store = tx.objectStore(TRIP_STORE);
      encryptedTrips.forEach((trip, index) => store.put({ ...trip, source_revision: revisions[index] }));
      if (hasSummaryStore) {
        const summaryStore = tx.objectStore(TRIP_SUMMARY_STORE);
        encryptedSummaries.forEach((summary, index) => (
          summaryStore.put({ ...summary, source_revision: revisions[index] })
        ));
      }
      if (hasProjectionStore) {
        const projectionStore = tx.objectStore(TRIP_PROJECTION_STORE);
        projections.forEach((record) => { if (record) projectionStore.put(record); });
      }
      if (hasP6WorkStore) {
        const p6Work = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
        storageTrips.forEach((trip, index) => p6Work.put(p6TripWorkRecord({
          trip,
          revision: revisions[index],
          sourceHash: sourceHashes[index],
        })));
      }
      if (hasP6ManifestStore) {
        dirtyP6GlobalHeads(tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS), 'SOURCE_REVISION_CHANGED');
      }
      await idbTransactionDone(tx);
      // AUD-001: the same boundary for the batch classes — import, restore, upsertMany,
      // native completed-trip intake and journal ingest all commit through here. Sixty
      // chunks still cost one invalidation, because the signal coalesces.
      publishP7SourceChange('trips_committed');
    } finally {
      db.close();
    }
  }
});

/**
 * Multi-record logical write.
 *
 * Admission runs on the **source** objects before any sanitized copy or
 * ciphertext exists, and closes a chunk before preparing an item that would
 * exceed the budget rather than discovering the excess afterwards. A record
 * whose own charge exceeds the chunk budget becomes an isolated single-item
 * chunk — the complete source is still written, never truncated, never deferred.
 */
const putTrips = async (incomingTrips) => {
  if (!incomingTrips.length) return;
  let storageTrips = [];
  try {
    // Preflight the source, choose one bounded window, prepare ONLY that window,
    // commit it, release it, then move on. Sanitizing the whole input first and
    // slicing afterwards would make peak preparation depend on the entire
    // logical batch rather than on the admitted window.
    let offset = 0;
    while (offset < incomingTrips.length) {
      const window = nextWriteWindow(incomingTrips, offset);
      const take = Math.max(1, window.count);
      storageTrips = await sanitizeTripsForPrivacyStorage(incomingTrips.slice(offset, offset + take));
      await persistTripChunk(storageTrips);
      storageTrips = [];
      offset += take;
      await yieldToEventLoop();
    }
  } catch (error) {
    if (canUseIndexedDb()) {
      logSystemFailure('trip_repository_indexeddb_batch_write', error, {
        db_name: DB_NAME,
        trip_count: storageTrips.length,
      });
      throw new TripPersistenceFailedError(
        'Road Sage could not safely save these trips. Existing trip data was left unchanged.',
        { tripCount: incomingTrips.length },
        { cause: error }
      );
    }
    await withFallbackTripsQueue(async () => {
      const trips = await getEncryptedJson(TRIPS_KEY, []);
      const incomingIds = new Set(storageTrips.map((trip) => String(trip.id)));
      const next = [
        ...storageTrips,
        ...trips.filter((item) => !incomingIds.has(String(item.id))),
      ];
      await writeFallbackTripsDocument(next);
    });
  }
};

/**
 * Batch-writes derived changes (rescores, migrations, retention) without clobbering fields the
 * writer does not own.
 *
 * These paths read every trip, spend real time computing, then write whole records back — long
 * enough for a user edit to land in between. Diffing each result against the snapshot it was
 * computed from yields only the fields this writer actually changed, which are then applied on
 * top of the freshest stored record.
 *
 * @param {any[]} originalTrips Snapshot the next values were computed from.
 * @param {any[]} nextTrips Computed records to persist.
 */
const applyTripFieldChanges = async (originalTrips, nextTrips) => {
  if (!Array.isArray(nextTrips) || !nextTrips.length) return [];
  const originalById = new Map(
    (Array.isArray(originalTrips) ? originalTrips : []).map((trip) => [String(trip?.id), trip])
  );
  const ids = nextTrips.map((trip) => trip?.id).filter((id) => id != null);
  return withTripWriteLocks(ids, async () => {
    const freshTrips = await getStoredTripsByIds(ids).catch(() => []);
    const freshById = new Map(freshTrips.map((trip) => [String(trip?.id), trip]));
    const merged = nextTrips.map((next) => {
      const key = String(next?.id);
      const original = originalById.get(key);
      const current = freshById.get(key);
      if (!original || !current) return next;
      return mergeTripFieldChanges(current, original, next);
    });
    await putTrips(merged);
    return merged;
  });
};

const invalidateTripDerivedCaches = async () => {
  const { clearSpeedGeometryIndex } = await import('@/lib/speedGeometryIndex');
  await Promise.all([
    removeJson(DRIVER_SIGNATURE_KEY),
    invalidateDangerZoneCache(),
    invalidateRouteRiskIndex(),
    clearSpeedGeometryIndex('trip_repository_changed'),
  ]);
};

let nativeTripImportPromise = null;

const emitRescoreProgress = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(RESCORE_PROGRESS_EVENT, { detail }));
};

const legacyScoreProvenanceNote = 'Legacy score marked unknown on app launch; values were not recalculated.';

/** Order-independent value comparison for the small provenance objects below. */
const sameProvenanceValue = (left, right) => {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((item, index) => sameProvenanceValue(item, right[index]));
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => sameProvenanceValue(left[key], right[key]));
};

const tagLegacyScoreProvenance = (trip) => {
  if (!trip || trip.status !== 'completed') return trip;
  const storedScoringVersion = trip.score_version || trip.score_provenance?.scoring_version || trip.score_provenance?.version || null;
  if (storedScoringVersion === SCORING_VERSION) return trip;

  const computedAt = trip.updated_at || trip.end_time || trip.created_at || new Date().toISOString();
  const tagged = {
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
  // The tag is idempotent by construction, but rebuilding the object made every
  // read look like a change to `prepareTripForRead`, which persists it. That
  // minted a new source revision on every read of a legacy-scored trip: write
  // amplification on its own, and with P6 a livelock, because the derived
  // pipeline re-dirties the trip through the very read it needs to converge.
  if (sameProvenanceValue(trip.score_provenance, tagged.score_provenance)
    && sameProvenanceValue(trip.score_provenance_change, tagged.score_provenance_change)) {
    return trip;
  }
  return tagged;
};

/**
 * The vehicles the rows in hand actually reference (HPR-003/HPR-010).
 *
 * Scoring and economics used to read a 500-row vehicle prefix, so a trip whose
 * vehicle sat outside it silently lost its profile. This resolves exactly the
 * referenced ids — active or retired — in one collection read.
 */
const vehiclesForTrips = async (rows = []) => {
  const ids = [...new Set((Array.isArray(rows) ? rows : [rows])
    .map((trip) => trip?.vehicle_id)
    .filter((id) => id != null && id !== '')
    .map(String))];
  if (!ids.length) return [];
  return localVehicleRepository.getByIds(ids).catch(() => []);
};

const vehicleForTrip = (trip, vehicles = []) => (
  Array.isArray(vehicles)
    ? vehicles.find((vehicle) => String(vehicle.id) === String(trip?.vehicle_id)) || null
    : null
);

const tagExistingTripsWithCurrentScoringVersion = async (trips = []) => {
  const next = trips.map((trip) => tagLegacyScoreProvenance(trip));
  const changedOriginals = trips.filter((trip, index) => next[index] !== trip);
  const changed = next.filter((trip, index) => trip !== trips[index]);
  if (changed.length) await applyTripFieldChanges(changedOriginals, changed);
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
  const needsCountRefresh = drivingEvents.length > 0 && (
    next.heading_deviation_count !== modernHeadingCount ||
    next.heading_deviation_legacy_count !== legacyHeadingCount
  );

  if (changed || needsCountRefresh || existingTrip.lane_changes_count != null || existingTrip.lane_changes_per_10km != null) {
    delete next.lane_changes_count;
    delete next.lane_changes_per_10km;
    next.heading_deviation_count = modernHeadingCount;
    next.heading_deviations_per_10km = eventRatePerDistance(modernHeadingCount, next.distance_km);
    next.heading_deviation_legacy_count = legacyHeadingCount;
    next.heading_deviation_legacy_per_10km = eventRatePerDistance(legacyHeadingCount, next.distance_km);
    changed = true;
  }

  return changed ? { ...next, updated_at: new Date().toISOString() } : trip;
};

const migrateRetiredTripEventTypesOnce = async () => {
  const version = Number(await getJson(TRIP_EVENT_MIGRATION_KEY, 0)) || 0;
  if (version >= TRIP_EVENT_MIGRATION_VERSION) return { changed: 0, alreadyRan: true };

  const trips = await getAllTrips();
  const migratedTrips = trips.map(normalizeRetiredTripEventTypes);
  const changedOriginals = trips.filter((trip, index) => migratedTrips[index] !== trip);
  const changedTrips = migratedTrips.filter((trip, index) => trip !== trips[index]);
  if (changedTrips.length) {
    await applyTripFieldChanges(changedOriginals, changedTrips);
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
  if (publicDistanceKm > nativeDistanceKm) {
    return {
      ...calculatedStats,
      distance_provenance: 'route_recalculated_above_native_aggregate',
      native_distance_km_original: nativeDistanceKm,
    };
  }
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

const getStoredTripsByIds = async (ids = []) => {
  const requestedIds = (Array.isArray(ids) ? ids : []).filter((id) => id != null);
  if (!requestedIds.length) return [];
  if (!canUseIndexedDb()) {
    const requested = new Set(requestedIds.map(String));
    return (await getAllTrips()).filter((trip) => requested.has(String(trip?.id)));
  }

  try {
    const db = await openDb();
    let records;
    try {
      const tx = db.transaction(TRIP_STORE, 'readonly');
      const store = tx.objectStore(TRIP_STORE);
      records = await Promise.all(requestedIds.map((id) => idbRequest(store.get(id))));
    } finally {
      db.close();
    }
    const liveRecords = records.filter((record) => record && !isSecureDeleteTombstone(record));
    const trips = await decodeTripRecords(liveRecords, { yieldEvery: 6 });
    return sanitizeTripsForPrivacyStorage(trips);
  } catch (error) {
    const trips = await readFallbackTrips();
    if (!trips) throw error;
    const requested = new Set(requestedIds.map(String));
    return trips.filter((trip) => requested.has(String(trip?.id)));
  }
};

export const preserveRecordedNightClassification = (trip = {}, calculatedStats = {}) => {
  const recorded = trip?.night_classification;
  if (!recorded || typeof recorded !== 'object' || Number(recorded.version) < 1) {
    return calculatedStats;
  }
  return {
    ...calculatedStats,
    night_driving: trip.night_driving === true,
    night_classification: recorded,
    trip_timezone_id: trip.trip_timezone_id || recorded.timezone_id || calculatedStats.trip_timezone_id || null,
    trip_utc_offset_minutes: Number.isFinite(Number(trip.trip_utc_offset_minutes))
      ? Number(trip.trip_utc_offset_minutes)
      : recorded.utc_offset_minutes ?? calculatedStats.trip_utc_offset_minutes ?? null,
  };
};

export { applyEventFeedbackToEvents };

export const applyEventFeedbackToPhoneUse = (phoneUse = {}, feedback = {}, durationSeconds = 0) => (
  applyEventFeedbackToPhoneUseWith(phoneUse, feedback, durationSeconds, buildPhoneUseFromEvents)
);

const rescoreTrip = (trip, vehicles = []) => {
  if (!trip || trip.status !== 'completed') return trip;
  const routePoints = restoreOriginalRouteGeometry(trip.route_points || []);
  const settings = localSettings.get();
  const thresholds = buildDrivingThresholds(settings);
  const scoreInputPrivacy = prepareScoreInputsForPrivacy({
    routePoints,
    events: [],
    settings,
  });
  const scoringRoutePoints = scoreInputPrivacy.routePoints;
  const privacyZones = scoreInputPrivacy.zones;
  const currentPhoneUsageAccessGranted = typeof settings.phone_usage_access_granted === 'boolean'
    ? settings.phone_usage_access_granted
    : null;
  const phoneUsageAccessProvenance = buildPhoneUsageAccessProvenance(trip, currentPhoneUsageAccessGranted);
  const provenanceStatus = getScoreProvenanceStatus(trip, thresholds);
  const stats = preserveRecordedNightClassification(
    trip,
    preserveNativePrivacyAggregateStats(
      trip,
      calculateTripStats(scoringRoutePoints, trip.start_time, trip.end_time, thresholds, {
        ...trip,
        raw_route_points: scoringRoutePoints,
      })
    )
  );
  const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(scoringRoutePoints, thresholds, trip.end_time, privacyZones);
  const mergedPhoneUse = mergedPhoneUseForTrip(trip, scoringRoutePoints, stats, detectedPhoneUse);
  // Feedback keys embed the event magnitude, which moves when detection inputs
  // change (a confirmed speed limit rewrites every speeding event's peak).
  // Follow the event instead of orphaning the driver's verdict.
  const reconciledFeedback = reconcileEventFeedbackKeys(trip.event_feedback, [
    ...events,
    ...(Array.isArray(mergedPhoneUse?.phone_use_events) ? mergedPhoneUse.phone_use_events : []),
    ...(Array.isArray(mergedPhoneUse?.phone_proxy_events) ? mergedPhoneUse.phone_proxy_events : []),
  ]).feedback;
  const feedbackAdjusted = applyEventFeedbackToEvents(events, reconciledFeedback);
  const phoneFeedbackAdjusted = applyEventFeedbackToPhoneUse(
    mergedPhoneUse,
    reconciledFeedback,
    stats.duration_seconds
  );
  const phoneUse = phoneFeedbackAdjusted.phoneUse;
  const motionSamples = Array.isArray(trip.motion_samples) ? trip.motion_samples : [];
  const sensorFusionSummary = motionSamples.length
    ? buildSensorFusionSummary(motionSamples, scoringRoutePoints, null, feedbackAdjusted.events)
    : trip.sensor_fusion_summary;
  const baseScores = calculateTripScores(feedbackAdjusted.events, stats, scoringRoutePoints, thresholds, stats.duration_seconds, phoneUse, {
    endTime: trip.end_time,
    privacyZones,
    motionSamples,
    orientationCalibration: sensorFusionSummary?.phone_orientation,
  });
  // Weather is a post-processing context adjustment, not part of the core GPS
  // event formulas. Reapply the saved context after every repository re-score
  // so a detail refetch, app restart, or scoring migration cannot erase it.
  const scores = applyWeatherRiskToScores(baseScores, trip.weather_context || null);
  const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, vehicleForTrip(trip, vehicles), settings);
  const drivingEvents = prepareScoreInputsForPrivacy({
    routePoints: [],
    events: mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || feedbackAdjusted.events, phoneUse),
    settings,
    zones: privacyZones,
  }).events;
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
  // A trip with no prior component scores is being scored for the first time,
  // not re-scored; every component would read as "gained a value" and the entry
  // would be noise rather than a change the user caused.
  const hadPreviousScores = Object.values(trip.component_scores || {}).some((component) => (
    Number.isFinite(Number(typeof component === 'object' ? component?.value : component))
  ));
  const scoreChangeEntry = hadPreviousScores
    ? buildScoreChangeEntry({
      previousTrip: trip,
      nextTrip: scores,
      reason: scoreProvenanceChange?.reason || 'user_requested_rescore',
      changedConstants: provenanceStatus.changedConstants,
      at: scores.score_provenance.computed_at,
    })
    : null;
  const scoreChangeLedger = scoreChangeEntry
    ? appendScoreChangeEntry(trip.score_change_ledger, scoreChangeEntry)
    : trip.score_change_ledger;
  return {
    ...trip,
    ...stats,
    ...scores,
    co2_saved_kg: economics.co2_saved_kg,
    route_points: scoringRoutePoints,
    score_input_masking_applied: true,
    privacy_zone_touched: scoreInputPrivacy.touchesPrivacyZone,
    privacy_trend_excluded: scoreInputPrivacy.trendExcluded,
    ...(sensorFusionSummary ? { sensor_fusion_summary: sensorFusionSummary } : {}),
    driving_events: drivingEvents,
    phone_usage_access_provenance: phoneUsageAccessProvenance.changed ? phoneUsageAccessProvenance : null,
    ...(scoreProvenanceChange ? { score_provenance_change: scoreProvenanceChange } : {}),
    ...(scoreChangeLedger ? { score_change_ledger: scoreChangeLedger } : {}),
    event_feedback: reconciledFeedback,
    feedback_adjusted_events_count: feedbackAdjusted.removed + phoneFeedbackAdjusted.removed,
    feedback_flagged_events_count: feedbackAdjusted.flagged + phoneFeedbackAdjusted.flagged,
    needs_rescore: false,
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
};

const weatherAdjustmentNeedsRescore = (trip = {}) => {
  const weather = trip.weather_context;
  const expectedDataSource = weather?.source === 'user_confirmed'
    ? 'user_confirmed_weather'
    : weather?.source === 'open_meteo'
      ? 'open_meteo_weather'
      : null;
  if (!expectedDataSource || Number(weather?.riskScore) <= 0 || Number(weather?.riskMultiplier) <= 1) {
    return false;
  }

  const weatherScoredEventCount =
    (Number(trip.harsh_brakes_count) || 0) +
    (Number(trip.sharp_turns_count) || 0) +
    (Number(trip.speeding_events_count) || 0);
  if (weatherScoredEventCount <= 0) return false;

  const overallSources = trip.component_scores?.overall?.dataSource;
  return !Array.isArray(overallSources) || !overallSources.includes(expectedDataSource);
};

const needsRescore = (trip, _thresholds = buildDrivingThresholds(localSettings.get()), options = {}) => (
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
    weatherAdjustmentNeedsRescore(trip) ||
    trip.schema_version !== TRIP_SCHEMA_VERSION
  )
);

const rescoreIneligibilityReason = (trip) => {
  if (trip?.status !== 'completed') return 'not_completed';
  if (trip?.privacy_mode === 'summary_only') return 'summary_only';
  if (trip?.route_data_expired_at) return 'route_data_expired';
  const routePoints = restoreOriginalRouteGeometry(trip.route_points || []);
  if (routePoints.length < 2) return 'insufficient_route_data';
  return null;
};

const scoreSnapshot = (trip = {}) => ({
  overall: Number.isFinite(Number(trip.score_overall)) ? Number(trip.score_overall) : null,
  safety: Number.isFinite(Number(trip.score_safety)) ? Number(trip.score_safety) : null,
  smoothness: Number.isFinite(Number(trip.score_smoothness)) ? Number(trip.score_smoothness) : null,
  eco: Number.isFinite(Number(trip.score_eco)) ? Number(trip.score_eco) : null,
});

const scoreSnapshotsDiffer = (before, after) => (
  Object.keys(before).some((key) => before[key] !== after[key])
);

const rescoreTripsIfNeeded = async (trips = []) => {
  const next = [];
  const rescoredTrips = [];
  const thresholds = buildDrivingThresholds(localSettings.get());
  const autoProvenanceTripIds = autoRescoreProvenanceTripIds(trips, thresholds);
  const rescoreOptions = { autoProvenanceTripIds };
  const vehicles = await vehiclesForTrips(trips);
  const total = trips.filter((trip) => needsRescore(trip, thresholds, rescoreOptions)).length;
  let completed = 0;
  if (total) emitRescoreProgress({
    status: 'running',
    completed,
    total,
    reason: autoProvenanceTripIds.size ? 'auto_provenance' : 'schema_refresh',
  });
  const rescoredOriginals = [];
  for (const trip of trips) {
    if (needsRescore(trip, thresholds, rescoreOptions)) {
      const rescored = rescoreTrip(trip, vehicles);
      rescoredOriginals.push(trip);
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
    await applyTripFieldChanges(rescoredOriginals, rescoredTrips);
    emitRescoreProgress({
      status: 'complete',
      completed,
      total,
      reason: autoProvenanceTripIds.size ? 'auto_provenance' : 'schema_refresh',
    });
  }
  return next;
};

let currentTripSummariesPromise = null;

const getCurrentTripSummaries = async () => {
  if (currentTripSummariesPromise) return currentTripSummariesPromise;

  currentTripSummariesPromise = (async () => {
    const summaries = await getAllTripSummaries();
    const thresholds = buildDrivingThresholds(localSettings.get());
    const hasSummaryNeedingRefresh = summaries.some((trip) => needsRescore(trip, thresholds));
    if (!hasSummaryNeedingRefresh) return summaries;

    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const refreshedTrips = await rescoreTripsIfNeeded(taggedTrips);
    return refreshedTrips.map(buildTripSummary);
  })().finally(() => {
    currentTripSummariesPromise = null;
  });

  return currentTripSummariesPromise;
};

/**
 * The value half of a canonical read: current scoring preparation applied to the
 * stored record, with nothing written.
 *
 * HPR-019 (Wave 6 correction). `prepareTripForRead` persists what it prepares,
 * which is right for a screen — opening a trip should settle its rescore — and
 * wrong for an export. Reading a trip advances the P7 query revision, so a walk
 * that hydrates N trips moves the source N times by itself, and no coherence
 * check built on that revision could tell the walk's own writes from somebody
 * else's mutation. Splitting the value out lets an export read without becoming
 * the thing it is trying to detect.
 */
const prepareTripValueForRead = async (trip) => {
  if (!trip) return null;
  const thresholds = buildDrivingThresholds(localSettings.get());
  const prepared = normalizeRetiredTripEventTypes(tagLegacyScoreProvenance(trip));
  if (!needsRescore(prepared, thresholds)) return prepared;
  const vehicles = await vehiclesForTrips([prepared]);
  return rescoreTrip(prepared, vehicles);
};

const prepareTripForRead = async (trip) => {
  if (!trip) return null;
  const prepared = await prepareTripValueForRead(trip);
  if (prepared === trip) return prepared;

  // Reading a trip persists a rescore, so it must merge rather than overwrite: otherwise simply
  // opening a trip detail page can wipe an edit made concurrently from elsewhere.
  return withTripWriteLock(trip.id, async () => {
    const freshCurrent = await getStoredTripById(trip.id).catch(() => null);
    const merged = freshCurrent ? mergeTripFieldChanges(freshCurrent, trip, prepared) : prepared;
    await putTrip(merged);
    return merged;
  }).catch((error) => {
    // A read must still return its value when persistence fails; log rather than throw.
    logSystemFailure('trip_repository_rescore_on_read_write', error, {
      trip_id_present: trip.id != null,
    });
    return prepared;
  });
};

const emptyNativeImportResult = (queueState = {}) => ({
  importedTrips: [],
  matchedActiveTrip: null,
  hasMore: queueState.hasMore === true,
  // AUD-005 round 3. A zero-trip page is not an empty queue. The shortcut that returned a
  // bare empty result dropped `blocked` on the floor, so a caller was told "nothing to do"
  // while the journal was deliberately preserving unresolved work.
  blocked: queueState.blocked === true,
  oversizedTripIds: queueState.oversizedTripIds || [],
  unreadableTripIds: queueState.unreadableTripIds || [],
  preservedUnreadableCount: Math.max(0, Number(queueState.preservedUnreadableCount) || 0),
  queueStatus: queueState.queueStatus ?? null,
});

/**
 * AUD-005. One completed-trip intake turn is bounded by construction: a fixed page size
 * and a fixed number of pages. A larger backlog produces more turns, never a larger turn,
 * and whatever a turn does not reach stays queued natively rather than being dropped.
 */
export const NATIVE_IMPORT_PAGE_SIZE = 4;
export const NATIVE_IMPORT_MAX_PAGES = 8;

export async function verifyTripsPersistedForNativeAcknowledge(trips = []) {
  const missingTripIds = [];

  for (const trip of trips) {
    if (trip?.id == null) {
      missingTripIds.push('(missing-id)');
      continue;
    }
    const stored = await getStoredTripById(trip.id);
    const storedRouteCount = Array.isArray(stored?.route_points) ? stored.route_points.length : 0;
    const expectedRouteCount = Array.isArray(trip?.route_points) ? trip.route_points.length : 0;
    const sameIdentity = stored &&
      String(stored.id) === String(trip.id) &&
      String(stored.start_time || '') === String(trip.start_time || '') &&
      String(stored.end_time || '') === String(trip.end_time || '') &&
      storedRouteCount === expectedRouteCount;
    if (!sameIdentity) {
      missingTripIds.push(String(trip.id));
    }
  }

  if (missingTripIds.length) {
    throw new Error(`Native trip import was not persisted: ${missingTripIds.join(', ')}`);
  }

  return true;
}

export const preserveResolvedSpeedLimitReview = (incomingTrip = {}, storedTrip = null) => {
  const reviewWasResolved = storedTrip?.speed_limit_review_required === false ||
    Boolean(storedTrip?.speed_limit_review_resolved_at);
  if (!reviewWasResolved) return incomingTrip;

  return {
    ...incomingTrip,
    speed_limit_review_required: false,
    ...(storedTrip?.speed_limit_review_resolved_at
      ? { speed_limit_review_resolved_at: storedTrip.speed_limit_review_resolved_at }
      : {}),
    speed_limit_review_reason: null,
    ...(incomingTrip?.speed_limit_context
      ? {
        speed_limit_context: {
          ...incomingTrip.speed_limit_context,
          review_required: false,
          ...(storedTrip?.speed_limit_review_resolved_at
            ? { review_resolved_at: storedTrip.speed_limit_review_resolved_at }
            : {}),
        },
      }
      : {}),
  };
};

export const buildPendingNativeTripRecord = (trip = {}, storedTrip = null) => (
  preserveResolvedSpeedLimitReview({
    ...trip,
    imported_from_native: true,
    needs_rescore: true,
    score_status: trip.score_status || 'pending_javascript_scoring',
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: trip.updated_at || new Date().toISOString(),
  }, storedTrip)
);

const importNativeCompletedTrips = async () => {
  if (!isAndroid()) return emptyNativeImportResult();
  if (import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true') {
    // P3.5 native intake is committed and acknowledged entirely on the native
    // side. Never pull result.trips[] across the bridge or acknowledge it after
    // same-IndexedDB read-back. Legacy authority can remain readable while the
    // native archive ingests bounded receipts and migration finishes.
    await nativeTripArchive.health();
    await nativeTripArchive.ingestJournal(8, 8 * 1024 * 1024);
    return emptyNativeImportResult();
  }

  // Until the separately validated authority cutover is enabled, preserve the
  // installed legacy intake behavior. This branch is a build-time authority
  // selection, not a runtime fallback from a failed native canonical archive.
  if (nativeTripImportPromise) return nativeTripImportPromise;

  nativeTripImportPromise = (async () => {
    const activeTripAtImport = activeTripStore.get();
    // The imported rows are not in hand yet, so this path resolves references
    // against the complete collection rather than a prefix.
    const vehicles = await localVehicleRepository.getAllForReference().catch(() => []);

    // AUD-005. The whole pending journal used to cross the bridge as one payload, be
    // held as one array, and be imported and acknowledged as one unit, so the cost of
    // opening the app was proportional to everything that had accumulated -- and a
    // failure anywhere acknowledged nothing, so the next attempt paid the whole cost
    // again. The drain is now page at a time: ask for a bounded page, import it,
    // acknowledge it, then ask for the next one. Bounded is not lossy -- what a turn
    // does not reach stays queued natively and is reported as `hasMore`.
    const drainPage = async (nativeTrips) => {
      // Deletion suppression. A native completion is persisted before it is
      // acknowledged, so a user delete followed by a crash-and-resume could
      // otherwise resurrect the trip. Suppression is bounded by the journal's own
      // 64-entry maximum, and a probe outage or a pending erase suppresses
      // globally rather than per id.
      const suppression = await readNativeSuppressionState();
      const admitted = nativeTrips.filter((trip) => !nativeImportSuppressed({
        visibility: suppression.visibility,
        erasurePending: suppression.erasurePending,
        suppression: suppression.ids,
        tripId: trip?.id,
      }));
      if (!admitted.length) return { importedTrips: [], acknowledged: true };

      const importedTrips = [];
      for (const trip of admitted) {
        const storedTrip = trip?.id == null
          ? null
          : await getStoredTripById(trip.id).catch(() => null);
        const routePoints = trip.route_points || [];
        const pendingTrip = buildPendingNativeTripRecord(trip, storedTrip);

        // Persist the native record before running optional scoring. A completed
        // drive must remain visible and recoverable even if enrichment fails on a
        // large or unusual sensor payload.
        await putTrip(pendingTrip);
        let importedTrip = pendingTrip;
        importedTrips.push(importedTrip);

        try {
          const settings = localSettings.get();
          const thresholds = buildDrivingThresholds(settings);
          const scoreInputPrivacy = prepareScoreInputsForPrivacy({
            routePoints,
            events: [],
            settings,
          });
          const scoringRoutePoints = scoreInputPrivacy.routePoints;
          const privacyZones = scoreInputPrivacy.zones;
          const stats = preserveRecordedNightClassification(
            trip,
            preserveNativePrivacyAggregateStats(
              trip,
              calculateTripStats(scoringRoutePoints, trip.start_time, trip.end_time, thresholds, {
                ...trip,
                raw_route_points: scoringRoutePoints,
              })
            )
          );
          const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(scoringRoutePoints, thresholds, trip.end_time, privacyZones);
          const mergedPhoneUse = mergedPhoneUseForTrip(trip, scoringRoutePoints, stats, detectedPhoneUse);
          // Import re-detects events, so the driver's verdicts must be reapplied
          // here too - phone-use evidence alone used to be filtered, which let a
          // rejected driving event reappear after a native re-import.
          const reconciledFeedback = reconcileEventFeedbackKeys(trip.event_feedback, [
            ...events,
            ...(Array.isArray(mergedPhoneUse?.phone_use_events) ? mergedPhoneUse.phone_use_events : []),
            ...(Array.isArray(mergedPhoneUse?.phone_proxy_events) ? mergedPhoneUse.phone_proxy_events : []),
          ]).feedback;
          const feedbackAdjusted = applyEventFeedbackToEvents(events, reconciledFeedback);
          const phoneFeedbackAdjusted = applyEventFeedbackToPhoneUse(
            mergedPhoneUse,
            reconciledFeedback,
            stats.duration_seconds
          );
          const phoneUse = phoneFeedbackAdjusted.phoneUse;
          const motionSamples = Array.isArray(trip.motion_samples) ? trip.motion_samples : [];
          const sensorFusionSummary = motionSamples.length
            ? buildSensorFusionSummary(motionSamples, scoringRoutePoints, null, feedbackAdjusted.events)
            : trip.sensor_fusion_summary;
          const scores = calculateTripScores(feedbackAdjusted.events, stats, scoringRoutePoints, thresholds, stats.duration_seconds, phoneUse, {
            endTime: trip.end_time,
            privacyZones,
            motionSamples,
            orientationCalibration: sensorFusionSummary?.phone_orientation,
          });
          const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, vehicleForTrip(trip, vehicles), settings);
          const drivingEvents = prepareScoreInputsForPrivacy({
            routePoints: [],
            events: mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || feedbackAdjusted.events, phoneUse),
            settings,
            zones: privacyZones,
          }).events;

          importedTrip = preserveResolvedSpeedLimitReview({
            ...trip,
            ...stats,
            ...scores,
            co2_saved_kg: economics.co2_saved_kg,
            route_points: scoringRoutePoints,
            route_points_raw_count: Number(trip.route_points_raw_count) || routePoints.length,
            route_points_map_count: Number(trip.route_points_map_count) || scoringRoutePoints.length,
            score_input_masking_applied: true,
            privacy_zone_touched: scoreInputPrivacy.touchesPrivacyZone,
            privacy_trend_excluded: scoreInputPrivacy.trendExcluded,
            ...(sensorFusionSummary ? { sensor_fusion_summary: sensorFusionSummary } : {}),
            driving_events: drivingEvents,
            event_feedback: reconciledFeedback,
            feedback_adjusted_events_count: feedbackAdjusted.removed + phoneFeedbackAdjusted.removed,
            feedback_flagged_events_count: feedbackAdjusted.flagged + phoneFeedbackAdjusted.flagged,
            imported_from_native: true,
            schema_version: TRIP_SCHEMA_VERSION,
            updated_at: trip.updated_at || new Date().toISOString(),
          }, storedTrip);

          await putTrip(importedTrip);
          importedTrips[importedTrips.length - 1] = importedTrip;
        } catch (error) {
          logSystemFailure('native_completed_trip_enrichment', error, {
            trip_id_present: trip?.id != null,
            route_point_count: Array.isArray(routePoints) ? routePoints.length : 0,
            motion_sample_count: Array.isArray(trip?.motion_samples) ? trip.motion_samples.length : 0,
          });
        }

        // Android resolves and persists parking before it exposes a completed trip
        // for import. Do not run the lower-context JavaScript resolver here: it lacks
        // the native stop/activity/connection evidence and could replace a confirmed
        // 100% native result with a weaker endpoint-only result when the app opens.
        // The versioned native parking snapshot is reconciled by the Parking page and
        // remains the single authority shared with the home-screen widget.
      }

      await verifyTripsPersistedForNativeAcknowledge(importedTrips);
      const acknowledgedTripIds = importedTrips.map((trip) => trip?.id).filter((id) => id != null);
      const acknowledgement = await acknowledgeNativeCompletedTrips(acknowledgedTripIds).catch((error) => {
        logSystemFailure('native_completed_trips_acknowledge_after_verified_import', error, {
          imported_trip_count: importedTrips.length,
        });
        return null;
      });
      // An unverified acknowledgement stops the drain but keeps what this page imported:
      // those trips are durable, and the pages that were acknowledged stay acknowledged.
      // The rest is still queued natively, which is what `hasMore` reports.
      return { importedTrips, acknowledged: acknowledgement?.success === true };
    };

    const importedTrips = [];
    const seenTripIds = new Set();
    let hasMore = false;
    let blocked = false;
    let lastQueueState = null;
    for (let page = 0; page < NATIVE_IMPORT_MAX_PAGES; page += 1) {
      const nativePage = await getNativeCompletedTripPage({ maxItems: NATIVE_IMPORT_PAGE_SIZE });
      const published = nativePage.trips;
      // Round 2: continuation comes from the journal, never from the page length. A queue
      // whose only entries are preserved-unreadable returns zero trips, and reading that
      // as "drained" abandons work the native side is deliberately keeping.
      if (nativePage.blocked) blocked = true;
      if (nativePage.hasMore) hasMore = true;
      lastQueueState = nativePage;
      if (!published.length) break;
      // An older native build, or one that ignores the page size, must not be able to
      // make this turn unbounded. What is trimmed here is not acknowledged, so it stays
      // queued and arrives on the next page.
      const nativeTrips = published.slice(0, NATIVE_IMPORT_PAGE_SIZE);

      // A bridge that keeps answering with trips this turn has already handled is not
      // making progress -- a suppressed or unacknowledgeable entry, say. Stop and report
      // the remainder rather than spin on it.
      const fresh = nativeTrips.filter((trip) => trip?.id == null || !seenTripIds.has(trip.id));
      if (!fresh.length) { hasMore = true; break; }
      fresh.forEach((trip) => { if (trip?.id != null) seenTripIds.add(trip.id); });

      // A page that fails must not discard the pages that succeeded, and must not let
      // the turn report a clean finish over work it never reached.
      let drained;
      try {
        drained = await drainPage(fresh);
      } catch (error) {
        logSystemFailure('native_completed_trips_page_import', error, {
          page_trip_count: fresh.length,
          imported_trip_count: importedTrips.length,
        });
        hasMore = true;
        break;
      }
      importedTrips.push(...drained.importedTrips);
      if (!drained.acknowledged) {
        logSystemFailure(
          'native_completed_trips_acknowledge_after_verified_import',
          new Error('Native completed trips remain queued because acknowledgement was not verified.'),
          { imported_trip_count: drained.importedTrips.length },
        );
        hasMore = true;
        break;
      }
      // A short page only ends the drain when the journal agrees nothing remains.
      if (published.length < NATIVE_IMPORT_PAGE_SIZE && !nativePage.hasMore) break;
      if (page === NATIVE_IMPORT_MAX_PAGES - 1) hasMore = true;
    }
    if (!importedTrips.length && !hasMore && !blocked) {
      return emptyNativeImportResult(lastQueueState || {});
    }
    if (!importedTrips.length) {
      // Nothing imported, but the queue is not clean: carry the reason out intact.
      return emptyNativeImportResult({ ...(lastQueueState || {}), hasMore, blocked });
    }

    const matchedActiveTrip = findNativeManualCompletion(importedTrips, activeTripAtImport);
    if (matchedActiveTrip && activeTripAtImport) {
      const currentActiveTrip = activeTripStore.get();
      if (
        currentActiveTrip &&
        isNativeManualCompletionForActiveTrip(matchedActiveTrip, currentActiveTrip)
      ) {
        activeTripStore.clear();
        await activeTripStore.flush();
      }
      dispatchNativeManualTripFinalized(activeTripAtImport, matchedActiveTrip);
    }
    if (importedTrips.length) {
      void import('@/lib/roadMemoryCoordinator')
        .then(({ synchronizeLocalRoadMemory }) => (
          synchronizeLocalRoadMemory(importedTrips, { rescore: true })
        ))
        .catch((error) => {
          logSystemFailure('native_completed_trip_road_memory', error, {
            imported_trip_count: importedTrips.length,
          });
        });
    }
    await invalidateTripDerivedCaches();
    return {
      importedTrips,
      matchedActiveTrip,
      hasMore,
      // Preserved-unreadable or oversized entries are NOT drained. Saying so keeps the
      // caller from reporting a clean queue over work the journal is still holding.
      blocked,
      oversizedTripIds: lastQueueState?.oversizedTripIds || [],
      unreadableTripIds: lastQueueState?.unreadableTripIds || [],
      preservedUnreadableCount: Math.max(0, Number(lastQueueState?.preservedUnreadableCount) || 0),
      queueStatus: lastQueueState?.queueStatus ?? null,
    };
  })().catch((error) => {
    logSystemFailure('native_completed_trips_import', error);
    // The existing JS store remains usable if the native bridge is unavailable.
    return emptyNativeImportResult();
  }).finally(() => {
    nativeTripImportPromise = null;
  });

  return nativeTripImportPromise;
};

export const syncNativeCompletedTrips = () => importNativeCompletedTrips();

const deleteTrip = async (id) => {
  let sourceMutationMayHaveCommitted = false;
  try {
    const db = await openDb();
    try {
      // Recovery obligations are committed BEFORE anything becomes invisible.
      //
      // A trip written while IndexedDB was unavailable still lives in the single
      // `TRIPS_KEY` blob, and a queued native completion can still carry the id;
      // neither is touched by the deletes below. Recording those obligations
      // first means a trip is never removed from the store that *is* visible
      // while a store that could hand it back has no fail-closed obligation
      // covering it. Both are O(1) — the whole-blob rewrite stays background
      // work and never becomes a foreground prerequisite.
      await suppressDeletedIdInFallback(db, id);
      await suppressDeletedIdInNative(db, id);
      const evidenceDisposition = await applyP6TripEvidenceDispositionFully(
        id, 'SUBTRACT', isAndroid() ? 'native' : 'browser'
      );
      if (evidenceDisposition.hasMore) {
        const pending = new Error('P6_EVIDENCE_DISPOSITION_PARTIAL');
        pending.code = 'P6_EVIDENCE_DISPOSITION_PARTIAL';
        pending.details = evidenceDisposition;
        throw pending;
      }
      // The derived invalidation is durable before canonical source removal.
      // If the following secure deletion fails, the source remains and the P6
      // worker rechecks it; if it succeeds, no stale derived head can serve.
      await recordP6BrowserTripTombstone(db, id);

      // `secureDelete` commits its overwrite before its logical delete. Mark the
      // source as possibly changed before entering that two-transaction seam so
      // a later failure can still force conservative P7 publication.
      sourceMutationMayHaveCommitted = true;
      const recordFound = await secureDelete(db, TRIP_STORE, id);
      // The legacy summary and the projection hold trip data, not bookkeeping.
      // Swallowing a failure here would leave the deleted trip recoverable while
      // reporting the deletion as complete, so it fails the deletion instead.
      if (db.objectStoreNames.contains(TRIP_SUMMARY_STORE)) {
        await secureDelete(db, TRIP_SUMMARY_STORE, id);
      }
      if (db.objectStoreNames.contains(TRIP_PROJECTION_STORE)) {
        await secureDelete(db, TRIP_PROJECTION_STORE, id);
      }
      return {
        recordFound,
        deletionMethod: 'indexeddb_overwrite_then_delete',
      };
    } finally {
      db.close();
    }
  } catch (error) {
    if (canUseIndexedDb()) {
      logSystemFailure('trip_repository_indexeddb_delete', error, {
        db_name: DB_NAME,
        trip_id_present: id != null,
      });
      const failure = new Error(
        'Road Sage could not verify this trip deletion. The saved record may still require cleanup.',
        { cause: error },
      );
      failure.sourceMutationMayHaveCommitted = sourceMutationMayHaveCommitted;
      throw failure;
    }
    if (isAndroid()) {
      // The blob rewrite below is itself durable removal, but with no IndexedDB
      // there is no `trip_meta` to hold the native suppression, and the native
      // journal can re-import the id. Nothing here can make that safe, so the
      // deletion is reported as failed rather than as a false success.
      throw new TripDeletionObligationError('native', { cause: error });
    }
    return withFallbackTripsQueue(async () => {
      const trips = await getEncryptedJson(TRIPS_KEY, []);
      const remainingTrips = trips.filter((trip) => String(trip.id) !== String(id));
      await writeFallbackTripsDocument(remainingTrips);
      return {
        recordFound: remainingTrips.length !== trips.length,
        deletionMethod: 'encrypted_collection_rewrite',
      };
    });
  }
};

/**
 * Set the bounded global native-erasure state.
 *
 * One record guards the whole erase, so a 10,000-trip erasure does not create
 * 10,000 suppression ids to protect a native journal that holds at most 64.
 * While pending, every native completion import is suppressed regardless of id.
 * @param {boolean} pending
 */
export async function setNativeErasurePending(pending) {
  if (!canUseIndexedDb()) {
    // Clearing a barrier that cannot exist is a no-op. *Raising* one is not:
    // returning success here would let the erase proceed believing native
    // imports are suppressed when nothing is suppressing them.
    if (pending !== true) return;
    throw new Error('The data-erasure safety barrier could not be stored.');
  }
  try {
    const db = await openDb();
    try {
      const current = await readTripMeta(db, META_KEYS.NATIVE_ERASURE_PENDING, defaultNativeErasurePending());
      const next = {
        pending: pending === true,
        since: pending ? (current.since ?? Date.now()) : null,
        attempts: pending ? (current.attempts || 0) + 1 : 0,
      };
      if (pending === true) {
        // Read back: the barrier must be proven durable, not assumed.
        const stored = await requireTripMetaRecord(db, META_KEYS.NATIVE_ERASURE_PENDING, next);
        if (stored?.pending !== true) {
          throw new Error('The data-erasure safety barrier did not persist.');
        }
      } else {
        await writeTripMetaRecord(db, META_KEYS.NATIVE_ERASURE_PENDING, next);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    logSystemFailure('trip_projection_native_erasure_state', error, { db_name: DB_NAME });
    // Callers rely on this as a privacy safety barrier, not as telemetry. If it
    // cannot be made durable the erase must not proceed as though it exists.
    throw new Error('The data-erasure safety barrier could not be stored.', { cause: error });
  }
}

/**
 * Erase every representation of trip data this repository owns, and report
 * whether that erasure was **verified**.
 *
 * Two properties matter more than the counts. First, enumeration is per store
 * rather than driven by the trips store: an orphan projection or an orphan
 * legacy summary — a row whose source is already gone — is exactly the kind of
 * record P3 maintenance exists to discover later, and leaving it behind would
 * not be eradication. Second, nothing is swallowed: a failure that determines
 * whether recoverable user data remains is recorded, and `verified` is false
 * unless every stage succeeded and the residue check came back empty.
 */
/**
 * AUD-004. Every P6 derived store that can hold trip-linked state, erased together with
 * the canonical rows. It is the full set on purpose: naming the three stores CODEX
 * happened to seed would leave the next one to be found the same way.
 */
const P6_ERASURE_STORES = Object.freeze(
  Object.values(P6_TRIP_DERIVED_STORES)
    .filter((name) => name !== P6_TRIP_SOURCE_STORE)
    // The overwrite-then-delete tombstone has to be keyed the way the store is, or the
    // put is rejected and the whole erasure aborts on the first derived row.
    .map((name) => ({ name, keyPath: name === P6_TRIP_DERIVED_STORES.WORK ? 'tripId' : 'key' })),
);

/**
 * AUD-004 round 2. One erasure TURN, bounded; the call drives turns until done.
 *
 * `getAllKeys()` then delete-everything is history-proportional work AND
 * history-proportional resident memory in one turn. Being user-explicit does not exempt
 * it from the bounded-turn law: a profile with a hundred thousand rows still has to erase
 * without one unbounded call, and an interrupted erasure has to resume rather than
 * restart. The continuation is a durable `(storeIndex, afterKey)` pair in the trip meta
 * store, so it survives a renderer restart, and NOTHING is verified until every store has
 * terminally completed.
 */
const ERASURE_CURSOR_META_KEY = 'data_rights_erasure_cursor';
const ERASURE_ROWS_PER_TURN = 256;

/** Fixed, complete order. A store omitted here is a store never erased. */
const erasureStoreSequence = () => ([
  { name: TRIP_STORE, counter: 'recordsWiped', keyPath: 'id' },
  { name: TRIP_SUMMARY_STORE, counter: 'summaryRecordsWiped', keyPath: 'id' },
  { name: TRIP_PROJECTION_STORE, counter: 'projectionRecordsWiped', keyPath: 'id' },
  ...P6_ERASURE_STORES.map(({ name, keyPath }) => ({ name, counter: 'derivedRecordsWiped', keyPath })),
]);

const readErasureCursor = async (db) => {
  if (!db.objectStoreNames.contains(TRIP_META_STORE)) return null;
  try {
    const tx = db.transaction(TRIP_META_STORE, 'readonly');
    return (await idbRequest(tx.objectStore(TRIP_META_STORE).get(ERASURE_CURSOR_META_KEY)))?.cursor ?? null;
  } catch {
    return null;   // an unreadable cursor restarts the sweep; it never skips a store
  }
};

const writeErasureCursor = async (db, cursor) => {
  if (!db.objectStoreNames.contains(TRIP_META_STORE)) return;
  try {
    const tx = db.transaction(TRIP_META_STORE, 'readwrite');
    const store = tx.objectStore(TRIP_META_STORE);
    if (cursor) store.put({ key: ERASURE_CURSOR_META_KEY, cursor, updatedAt: Date.now() });
    else store.delete(ERASURE_CURSOR_META_KEY);
    await idbTransactionDone(tx);
  } catch {
    // A cursor that will not persist costs a repeated sweep, never a skipped row.
  }
};

/** Collect at most `limit` primary keys after `afterKey` — acquisition itself is bounded. */
const erasureKeyPage = async (db, storeName, afterKey, limit) => {
  const tx = db.transaction(storeName, 'readonly');
  const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
  return new Promise((resolve, reject) => {
    const keys = [];
    let lastKey = afterKey ?? null;
    const request = tx.objectStore(storeName).openKeyCursor
      ? tx.objectStore(storeName).openKeyCursor(range)
      : tx.objectStore(storeName).openCursor(range);
    request.onerror = () => reject(request.error || new Error('erasure key scan failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve({ keys, lastKey, exhausted: true }); return; }
      lastKey = cursor.primaryKey;
      keys.push(cursor.primaryKey);
      if (keys.length >= limit) { resolve({ keys, lastKey, exhausted: false }); return; }
      cursor.continue();
    };
  });
};

export async function eraseTripRepositoryForDataRights(options = {}) {
  const rowBudget = Math.max(1, Number(options.rowBudget) || ERASURE_ROWS_PER_TURN);
  const maxTurns = Math.max(1, Number(options.maxTurns) || Number.MAX_SAFE_INTEGER);
  const result = {
    store: `indexeddb:${DB_NAME}/${TRIP_STORE}`,
    recordsWiped: 0,
    summaryRecordsWiped: 0,
    // Previously never initialized, so the first `+= 1` produced NaN and the
    // receipt reported a projection count of "not a number".
    projectionRecordsWiped: 0,
    // AUD-004: the P6 derived stores in this database held plaintext trip metadata that
    // erasure never counted, let alone removed.
    derivedRecordsWiped: 0,
    rowsErasedThisCall: 0,
    hasMore: false,
    fallbackKey: TRIPS_KEY,
    fallbackRemoved: false,
    method: 'indexeddb_overwrite_then_delete',
    verified: false,
    failures: [],
  };

  const fail = (stage, error) => {
    result.failures.push({ stage, message: error?.message ?? String(error) });
    logSystemFailure('data_erasure_trip_repository_stage', error, { stage, db_name: DB_NAME });
  };

  // The barrier goes up BEFORE anything is destroyed, and is proven durable by
  // reading it back. Everything after this point may fail; what must not happen
  // is that the fallback blob outlives the overlay that hid its deleted rows.
  try {
    await setJson(TRIPS_ERASURE_BARRIER_KEY, { pending: true, since: Date.now() });
    const stored = await getJson(TRIPS_ERASURE_BARRIER_KEY, null);
    if (stored?.pending !== true) throw new Error('The fallback erasure barrier did not persist.');
    result.fallbackBarrierRaised = true;
  } catch (error) {
    // Abort before destroying anything. Continuing would delete the source,
    // summaries, projections and metadata while the fallback blob is left
    // unguarded — the precise state the barrier exists to prevent. Nothing has
    // been touched yet, so returning here leaves the profile intact and
    // retryable.
    fail('fallback_barrier', error);
    result.verified = false;
    result.abortedBeforeErasure = true;
    return result;
  }

  if (canUseIndexedDb()) {
    try {
      const db = await openDb();
      try {
        // AUD-004. The P6 derived stores live in THIS database and hold plaintext trip
        // metadata that erasure never visited: `p6_recent_order` carries the trip id and
        // its start time, a contribution row carries the recent key (start time + id),
        // and a geometry chunk carries the trip id, its point count and its encoded
        // size. Deleting the canonical trip while those survive leaves a durable record
        // that a trip existed, when it started and how long its route was — and the
        // receipt still said `verified`. Derived is not exempt; the subject is the same
        // person, and a data-rights erasure is about the person, not about which store
        // happens to hold the bytes.
        //
        // Round 2: bounded and resumable. Each turn takes a page of KEYS from a cursor —
        // acquisition itself is bounded, not `getAllKeys().slice()` — erases them
        // overwrite-then-delete, and persists where it stopped.
        const sequence = erasureStoreSequence();
        const saved = await readErasureCursor(db);
        let storeIndex = Math.max(0, Number(saved?.storeIndex) || 0);
        let afterKey = saved?.afterKey ?? null;
        let budget = rowBudget * maxTurns;

        while (storeIndex < sequence.length && budget > 0) {
          const { name, counter, keyPath } = sequence[storeIndex];
          if (!db.objectStoreNames.contains(name)) {
            storeIndex += 1;
            afterKey = null;
            continue;
          }
          const page = await erasureKeyPage(db, name, afterKey, Math.min(rowBudget, budget));
          for (const key of page.keys) {
            if (key == null) continue;
            if (await secureDelete(db, name, key, { keyPath })) result[counter] += 1;
            result.rowsErasedThisCall += 1;
            budget -= 1;
          }
          // The cursor advances past the page it just handled. A store that accepts the
          // delete but keeps the row still advances, so the sweep terminates; the row it
          // left behind is caught by the residue proof, which refuses verification.
          afterKey = page.exhausted ? null : page.lastKey;
          if (page.exhausted) { storeIndex += 1; afterKey = null; }
        }

        result.hasMore = storeIndex < sequence.length;
        await writeErasureCursor(db, result.hasMore ? { storeIndex, afterKey } : null);
        if (result.hasMore) {
          // Nothing may be verified, proven or signed while stores remain unerased.
          db.close();
          return result;
        }

        // P3-owned obligations. Two are deliberately NOT cleared here.
        //
        // `native_erasure_pending` keeps native imports suppressed until native
        // storage is verified cleared, and the caller clears it only on success.
        // `fallback_suppression` is the overlay that hides deleted trips inside a
        // surviving fallback blob; removing it while that blob may still exist
        // would let erased trips reappear after a restart. It is retired at the
        // end, once the blob is verified absent.
        if (db.objectStoreNames.contains(TRIP_META_STORE)) {
          const metaTx = db.transaction(TRIP_META_STORE, 'readwrite');
          const metaStore = metaTx.objectStore(TRIP_META_STORE);
          [
            META_KEYS.MIGRATION, META_KEYS.VERIFY, META_KEYS.DELETE_CLEANUP,
            META_KEYS.DELETE_SEQ, META_KEYS.NATIVE_VISIBILITY, META_KEYS.NATIVE_SUPPRESSION,
            META_KEYS.MAINTENANCE,
          ].forEach((key) => metaStore.delete(key));
          await idbTransactionDone(metaTx);
          result.projectionMetaCleared = true;
        }

        const remainingIn = async (storeName) => {
          if (!db.objectStoreNames.contains(storeName)) return 0;
          const tx = db.transaction(storeName, 'readonly');
          return idbRequest(tx.objectStore(storeName).count());
        };
        let derivedRemaining = 0;
        for (const { name } of P6_ERASURE_STORES) {
          derivedRemaining += await remainingIn(name);
        }
        result.remainingRecords = {
          trips: await remainingIn(TRIP_STORE),
          summaries: await remainingIn(TRIP_SUMMARY_STORE),
          projections: await remainingIn(TRIP_PROJECTION_STORE),
          derived: derivedRemaining,
        };
        const residue = result.remainingRecords.trips
          + result.remainingRecords.summaries
          + result.remainingRecords.projections
          + result.remainingRecords.derived;
        if (residue > 0) {
          fail('repository_residue', new Error(`${residue} recoverable trip records remain after erasure.`));
        }
      } finally {
        db.close();
      }
    } catch (error) {
      fail('indexeddb', error);
      result.method = 'encrypted_collection_overwrite_then_remove';
    }
  }

  try {
    await setJson(TRIPS_KEY, {
      _secure_delete_tombstone: true,
      _secure_delete_at: Date.now(),
      random_padding: Math.random().toString(36).repeat(128),
    });
  } catch (error) {
    fail('fallback_overwrite', error);
  }
  try {
    await removeJson(TRIPS_KEY);
    await clearFallbackTripsReference();
    result.fallbackRemoved = true;
  } catch (error) {
    fail('fallback_remove', error);
  }
  try {
    const residual = await getJson(TRIPS_KEY, null);
    // A surviving tombstone carries no trip data; a surviving payload does.
    result.fallbackResidual = residual != null && residual?._secure_delete_tombstone !== true;
    if (result.fallbackResidual) {
      fail('fallback_residue', new Error('The fallback trip blob still holds recoverable data.'));
    }
  } catch (error) {
    result.fallbackResidual = true;
    fail('fallback_verify', error);
  }

  // Only now may the overlay and the barrier be retired, and only because the
  // blob they guard is proven gone. If anything above failed they both survive,
  // a restart still fails closed, and a retry can finish the erasure.
  if (result.failures.length === 0) {
    if (canUseIndexedDb()) {
      try {
        const db = await openDb();
        try {
          if (db.objectStoreNames.contains(TRIP_META_STORE)) {
            const tx = db.transaction(TRIP_META_STORE, 'readwrite');
            tx.objectStore(TRIP_META_STORE).delete(META_KEYS.FALLBACK_SUPPRESSION);
            await idbTransactionDone(tx);
          }
        } finally {
          db.close();
        }
      } catch (error) {
        fail('fallback_overlay_retire', error);
      }
    }
    try {
      await removeJson(TRIPS_ERASURE_BARRIER_KEY);
      const remaining = await getJson(TRIPS_ERASURE_BARRIER_KEY, null);
      if (remaining != null) throw new Error('The fallback erasure barrier could not be retired.');
      result.fallbackBarrierRetired = true;
    } catch (error) {
      // A barrier that will not retire is inconvenient, never unsafe: it only
      // withholds a blob that is already gone. It still fails the erasure so the
      // state is visible and retryable.
      fail('fallback_barrier_retire', error);
    }
  }

  result.verified = result.failures.length === 0;
  return result;
}

const isTripExpiredForRetention = (trip, cutoff) => {
  const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
  return Number.isFinite(when) && when > 0 && when < cutoff;
};

const normalizeRetentionDays = (value) => Math.max(0, Math.floor(Number(value) || 0));

/**
 * Delete one already-bounded set and publish once for the committed mutation
 * set. A failed later member cannot erase the fact that earlier members — or a
 * secure-delete tombstone for the failing member — already became durable.
 */
const deleteTripsForRetention = async (expired, { retentionDays, reason }) => {
  let deletedTrips = 0;
  let failure = null;
  let sourceMutationMayHaveCommitted = false;

  for (const trip of expired) {
    try {
      const result = await deleteTrip(trip.id);
      if (result.recordFound) deletedTrips += 1;
    } catch (error) {
      failure = error;
      sourceMutationMayHaveCommitted = error?.sourceMutationMayHaveCommitted === true;
      break;
    }
  }

  const sourceChanged = deletedTrips > 0 || sourceMutationMayHaveCommitted;
  if (sourceChanged) {
    // The canonical deletion/tombstone is already durable. Publish before
    // fallible cache epilogues so their failure cannot strand P7 consumers.
    await advanceP7QueryEpoch(reason);
    try {
      await invalidateTripDerivedCaches();
      const { invalidateAchievementAggregates } = await import('@/lib/achievementAggregates');
      await invalidateAchievementAggregates('trip_retention_expired');
    } catch (error) {
      if (!failure) failure = error;
    }
    recordSystemEvent('trip_data_retention_enforced', {
      retention_days: retentionDays,
      deleted_trip_count: deletedTrips,
      incomplete: Boolean(failure),
    }, {
      category: 'storage',
      severity: failure ? 'warn' : 'info',
      title: failure ? 'Expired trip cleanup incomplete' : 'Expired trips deleted',
      message: failure
        ? `${deletedTrips} expired trip${deletedTrips === 1 ? '' : 's'} deleted; remaining cleanup will retry.`
        : `Deleted ${deletedTrips} trip${deletedTrips === 1 ? '' : 's'} older than ${retentionDays} days.`,
    });
  }

  if (failure) {
    const incomplete = new Error(
      'Road Sage could not finish trip retention. Committed deletions were published and remaining cleanup can retry.',
      { cause: failure },
    );
    incomplete.code = 'TRIP_RETENTION_INCOMPLETE';
    incomplete.retentionOutcome = {
      status: 'pending',
      requestedTrips: expired.length,
      deletedTrips,
      pendingTrips: Math.max(1, expired.length - deletedTrips),
      retryable: true,
    };
    throw incomplete;
  }

  return { deletedTrips };
};

export const enforceTripDataRetention = async ({
  now = Date.now(),
  trips: providedTrips = null,
  retentionDays: explicitRetentionDays = null,
} = {}) => {
  const retentionDays = explicitRetentionDays == null
    ? normalizeRetentionDays(localSettings.get().data_retention_days)
    : normalizeRetentionDays(explicitRetentionDays);
  if (!retentionDays) {
    return { enabled: false, retentionDays: 0, deletedTrips: 0 };
  }

  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const trips = Array.isArray(providedTrips) ? providedTrips : await getAllTrips();
  const expired = trips.filter((trip) => isTripExpiredForRetention(trip, cutoff));

  const deletion = expired.length
    ? await deleteTripsForRetention(expired, {
      retentionDays,
      reason: 'trip_retention_expired',
    })
    : { deletedTrips: 0 };

  return {
    enabled: true,
    retentionDays,
    deletedTrips: deletion.deletedTrips,
  };
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

  return expiredRouteShape(trip, retentionDays, expiredAt,
    Number(trip.route_points_raw_count) || routePoints.length);
}

const expiredRouteShape = (trip, retentionDays, expiredAt, pointCount) => {
  return {
    ...trip,
    route_points: [],
    route_points_raw_count: pointCount,
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
};

const P6_EVIDENCE_DISPOSITION_CURSOR_PREFIX = 'p6_evidence_disposition_cursor_v1';

const applyP6TripEvidenceDispositionPage = async (tripId, disposition, { sourceAuthority = 'browser', cursor = null, maxItems = 8 } = {}) => {
  const cursorKey = `${P6_EVIDENCE_DISPOSITION_CURSOR_PREFIX}:${sourceAuthority}:${String(tripId)}:${disposition}`;
  const durableCursor = cursor == null ? await getJson(cursorKey, '').catch(() => '') : cursor;
  const [{ LocalSpeedKnowledge }, { speedKnowledgeStore }] = await Promise.all([
    import('@/lib/localSpeedKnowledge'), import('@/lib/speedKnowledgeRepository'),
  ]);
  const result = await new LocalSpeedKnowledge(speedKnowledgeStore).applyP6ProvenanceDispositionPage({
    sourceAuthority, tripId: String(tripId), disposition, cursor: durableCursor, maxItems,
  });
  if (result.hasMore && result.nextCursor) await setJson(cursorKey, result.nextCursor);
  else await removeJson(cursorKey).catch(() => {});
  return result;
};

const applyP6TripEvidenceDispositionFully = async (tripId, disposition, sourceAuthority = 'browser') => {
  const result = await applyP6TripEvidenceDispositionPage(tripId, disposition, {
    sourceAuthority, cursor: null, maxItems: 50,
  });
  if (result.state === 'CONVERSION_REQUIRED') throw new Error('P6_RETENTION_EVIDENCE_CONVERSION_REQUIRED');
  return result;
};

/**
 * Drops stored IMU samples while keeping every derived summary.
 *
 * High-fidelity capture is the biggest storage line a trip carries, and unlike
 * route points it has no display use once `sensor_fusion_summary` exists — so it
 * ages out on its own, shorter clock than raw GPS.
 */
export function expireTripMotionSamples(trip, retentionDays, expiredAt = Date.now()) {
  if (!trip || typeof trip !== 'object' || trip.motion_samples_expired_at) return trip;
  const samples = Array.isArray(trip.motion_samples) ? trip.motion_samples : [];
  if (!samples.length) return trip;

  return {
    ...trip,
    motion_samples: [],
    motion_samples_expired_count: Number(trip.motion_samples_expired_count) || samples.length,
    motion_samples_expired_at: new Date(expiredAt).toISOString(),
    motion_samples_retention_days: retentionDays,
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
    const settings = localSettings.get();
    const retentionDays = Number(settings.raw_gps_retention_days || 0);
    // Motion samples ride the same sweep on their own, shorter clock so
    // high-fidelity capture ages out before route data does.
    const motionRetentionDays = Number(settings.motion_sample_retention_days || 0);
    const previous = await getRawGpsLifecycleStatus();
    if (!retentionDays && !motionRetentionDays) {
      return { enabled: false, purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0, lastRunAt: previous.lastRunAt || null };
    }
    if (!force && Number(previous.lastRunAt) > 0 && now - Number(previous.lastRunAt) < RAW_GPS_LIFECYCLE_INTERVAL_MS) {
      return {
        enabled: true,
        skipped: true,
        purgedTrips: 0,
        purgedPoints: 0,
        purgedMotionSamples: 0,
        lastRunAt: Number(previous.lastRunAt),
      };
    }

    const dayMs = 24 * 60 * 60 * 1000;
    const cutoff = now - retentionDays * dayMs;
    const motionCutoff = now - motionRetentionDays * dayMs;
    const trips = await getAllTrips();
    const expiredTrips = [];
    const expiredOriginals = [];
    let purgedPoints = 0;
    let purgedMotionSamples = 0;

    for (const trip of trips) {
      const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
      if (trip.status !== 'completed' || !Number.isFinite(when) || when <= 0) continue;

      let expired = trip;
      if (motionRetentionDays && when < motionCutoff) {
        const motionExpired = expireTripMotionSamples(expired, motionRetentionDays, now);
        if (motionExpired !== expired) {
          purgedMotionSamples += Array.isArray(expired.motion_samples) ? expired.motion_samples.length : 0;
          expired = motionExpired;
        }
      }
      if (retentionDays && when < cutoff && !trip.route_data_expired_at) {
        const routeExpired = expireTripRouteData(expired, retentionDays, now);
        if (routeExpired !== expired) {
          purgedPoints += Array.isArray(expired.route_points) ? expired.route_points.length : 0;
          expired = routeExpired;
        }
      }
      if (expired === trip) continue;
      expiredOriginals.push(trip);
      expiredTrips.push(expired);
    }

    if (expiredTrips.length) {
      await applyTripFieldChanges(expiredOriginals, expiredTrips);
      await invalidateTripDerivedCaches();
      try {
        await appendPrivacyEvent({
          op: 'RAW_GPS_AUTO_PURGED',
          details: {
            purged_trip_count: expiredTrips.length,
            purged_point_count: purgedPoints,
            purged_motion_sample_count: purgedMotionSamples,
            reason: `raw_gps_retention_${retentionDays}d_motion_${motionRetentionDays}d`,
          },
        });
      } catch (error) {
        logSystemFailure('raw_gps_retention_audit_append', error, {
          purged_trip_count: expiredTrips.length,
        });
      }
      recordSystemEvent('raw_gps_retention_enforced', {
        retention_days: retentionDays,
        motion_retention_days: motionRetentionDays,
        purged_trip_count: expiredTrips.length,
        purged_point_count: purgedPoints,
        purged_motion_sample_count: purgedMotionSamples,
      }, {
        category: 'privacy',
        title: 'Expired route data removed',
        message: `Removed route coordinates from ${expiredTrips.length} old trip${expiredTrips.length === 1 ? '' : 's'} while keeping summaries.`,
      });
    }

    const state = {
      lastRunAt: now,
      retentionDays,
      motionRetentionDays,
      purgedTrips: expiredTrips.length,
      purgedPoints,
      purgedMotionSamples,
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

// Called only by TRIP_METADATA_PENDING, before its DONE commit. The saved
// authenticated spool count is authoritative even though route_points is [].
export async function commitRsasRouteExpiry({ sessionId, tripId, retentionDays, expiredAt, pointCount, motionRetentionDays = 0 }) {
  if (nativeOwnsRawGpsRetention()) throw new Error('RSAS_PURGE_NATIVE_AUTHORITY');
  const evidenceDisposition = await applyP6TripEvidenceDispositionFully(tripId, 'FREEZE', 'browser');
  if (evidenceDisposition.hasMore) {
    return {
      state: 'P6_FREEZE_PARTIAL', hasMore: true,
      itemsWorked: Number(evidenceDisposition.itemsWorked) || 0,
      bytesWorked: Number(evidenceDisposition.bytesWorked) || 0,
      purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0,
    };
  }
  const retained = await withTripWriteLocks([tripId], async () => {
    const [trip] = await getStoredTripsByIds([tripId]);
    if (!trip || trip.rsas_session_id !== sessionId) return null;
    const count = Math.max(0, Number(trip.route_points_raw_count) || Number(pointCount) || 0);
    let expired = trip.route_data_expired_at ? trip : expiredRouteShape(trip, retentionDays, expiredAt, count);
    if (motionRetentionDays > 0) expired = expireTripMotionSamples(expired, motionRetentionDays, expiredAt);
    if (expired !== trip) await putTrips([expired]);
    const motionCount = motionRetentionDays > 0 && expired.motion_samples_expired_at === new Date(expiredAt).toISOString()
      ? Math.max(0, Number(expired.motion_samples_expired_count) || 0) : 0;
    return { trip: expired, count, motionCount };
  });
  if (!retained) return { purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0 };
  await invalidateTripDerivedCaches();
  // A failed append leaves TRIP_METADATA_PENDING intact; replay uses the same
  // private operation identity and cannot emit a second privacy receipt.
  const { appendPrivacyEventBounded } = await import('@/lib/hashChainLog');
  const receipt = await appendPrivacyEventBounded({
    op: 'RAW_GPS_AUTO_PURGED', operationId: `rsas-purge-${sessionId}`, timestamp: expiredAt,
    details: { purged_trip_count: 1, purged_point_count: retained.count,
      purged_motion_sample_count: retained.motionCount, reason: `raw_gps_retention_${retentionDays}d_motion_${motionRetentionDays}d` },
  });
  if (receipt.state !== 'READY') throw Object.assign(new Error(receipt.state), {
    code: receipt.state, itemsWorked: receipt.itemsWorked, bytesWorked: receipt.bytesWorked,
  });
  if (receipt.appended) recordSystemEvent('raw_gps_retention_enforced', {
    retention_days: retentionDays, motion_retention_days: motionRetentionDays, purged_trip_count: 1,
    purged_point_count: retained.count, purged_motion_sample_count: retained.motionCount,
  }, { category: 'privacy', title: 'Expired route data removed' });
  return { purgedTrips: 1, purgedPoints: retained.count, purgedMotionSamples: retained.motionCount,
    auditItemsWorked: receipt.itemsWorked, auditBytesWorked: receipt.bytesWorked };
}

/**
 * Explicit predecessor-record retention compatibility.
 *
 * Pre-RSAS browser records hold one indivisible encrypted trip payload. Web
 * Crypto cannot resume inside that ciphertext, so this operation deliberately
 * admits exactly one caller-selected record and never runs from lifecycle.
 * Publication is guarded old-record-or-new-record atomic; an oversized,
 * missing, concurrently replaced, or erasure-fenced source is preserved.
 * @param {{tripId?: string, retentionDays?: number, motionRetentionDays?: number, now?: number, maxEncodedBytes?: number}} options
 */
export async function runLegacyBrowserRawGpsRetention({
  tripId,
  retentionDays = Number(localSettings.get().raw_gps_retention_days || 0),
  motionRetentionDays = Number(localSettings.get().motion_sample_retention_days || 0),
  now = Date.now(),
  maxEncodedBytes = 32 * 1024 * 1024,
} = /** @type {{tripId?: string, retentionDays?: number, motionRetentionDays?: number, now?: number, maxEncodedBytes?: number}} */ ({})) {
  const id = String(tripId || '');
  if (!id) return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'REFUSED_ID_REQUIRED', changed: false };
  if (nativeOwnsRawGpsRetention()) {
    return { owner: 'native', state: 'REFUSED_NATIVE_AUTHORITY', tripId: id, changed: false };
  }
  if (!canUseIndexedDb()) {
    return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'REFUSED_MONOLITHIC_FALLBACK', tripId: id, changed: false };
  }
  if (await fallbackErasureBarrierRaised()) {
    return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'REFUSED_ERASURE_PENDING', tripId: id, changed: false };
  }
  const db = await openDb();
  try {
    const readTx = db.transaction(TRIP_STORE, 'readonly');
    const source = await idbRequest(readTx.objectStore(TRIP_STORE).get(id));
    if (!source || isSecureDeleteTombstone(source)) {
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'SOURCE_ABSENT', tripId: id, changed: false };
    }
    if (source.rsas_session_id) {
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'REFUSED_RSAS_OWNED', tripId: id, changed: false };
    }
    const encodedBytes = new TextEncoder().encode(JSON.stringify(source)).byteLength;
    const ceiling = Math.max(1, Number(maxEncodedBytes) || 1);
    if (encodedBytes > ceiling) {
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'REFUSED_SIZE', tripId: id, encodedBytes, maxEncodedBytes: ceiling, changed: false };
    }
    const trip = await decodeTripRecord(source);
    const when = new Date(trip?.end_time || trip?.start_time || trip?.created_at || 0).getTime();
    if (trip?.status !== 'completed' || !Number.isFinite(when) || when <= 0) {
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'NOT_ELIGIBLE', tripId: id, encodedBytes, changed: false };
    }
    const dayMs = 24 * 60 * 60 * 1000;
    let next = trip;
    if (motionRetentionDays && when < now - motionRetentionDays * dayMs) {
      next = expireTripMotionSamples(next, motionRetentionDays, now);
    }
    if (retentionDays && when < now - retentionDays * dayMs) {
      next = expireTripRouteData(next, retentionDays, now);
    }
    if (next === trip) {
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'NOT_DUE', tripId: id, encodedBytes, changed: false };
    }
    const evidenceDisposition = await applyP6TripEvidenceDispositionFully(id, 'FREEZE', 'browser');
    if (evidenceDisposition.hasMore) {
      return {
        owner: MONOLITHIC_DOCUMENT_OWNER, state: 'P6_FREEZE_PARTIAL', tripId: id,
        encodedBytes, changed: false, hasMore: true,
        itemsWorked: Number(evidenceDisposition.itemsWorked) || 0,
        bytesWorked: Number(evidenceDisposition.bytesWorked) || 0,
      };
    }
    const nextRevision = mintSourceRevision();
    /**
     * AUD-007 REDESIGN — CODEX bypass A. This re-encode and the guarded transaction that
     * commits it are ONE publication. Previously the wrappers were made here and the
     * transaction opened several awaits later (a source hash, a fresh read, a guard
     * comparison), so a finalization landing in that window destroyed the version those
     * wrappers name and the compatibility pass durably wrote unreadable records.
     *
     * The publication starts at the re-encode, not at the top of the function: everything
     * above is reads and refusals that produce no ciphertext, and admitting across them
     * would hold rotation off for the whole of a user-triggered pass that usually refuses.
     */
    const retentionOutcome = await withDurableKeyPublication(async (publication) => {
    const candidate = { ...(await encodeTripRecord(next, publication)), source_revision: nextRevision };
    const summary = { ...(await encodeTripSummaryRecord(next, publication)), source_revision: nextRevision };
    const candidateHash = await p6SourceHash(candidate);
    const sourceBinding = JSON.stringify(source);
    const retentionStores = [TRIP_STORE, TRIP_SUMMARY_STORE];
    if (db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.WORK)) {
      retentionStores.push(P6_TRIP_DERIVED_STORES.WORK);
    }
    if (db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.MANIFESTS)) {
      retentionStores.push(P6_TRIP_DERIVED_STORES.MANIFESTS);
    }
    // AUD-001: this is a CANONICAL mutation — it rewrites the trip, its legacy summary and
    // its `source_revision` — but it committed on its own and told nobody. The query
    // snapshot never advanced, so outstanding cursors stayed valid over changed rows, and
    // no P7 family was invalidated, so detail and geometry answers stayed stale.
    //
    // The revision advance belongs INSIDE this transaction, so it is part of the same
    // durable mutation rather than a follow-up that a crash could lose.
    const hasRetentionMetaStore = db.objectStoreNames.contains(TRIP_META_STORE);
    if (hasRetentionMetaStore) retentionStores.push(TRIP_META_STORE);
    const tx = db.transaction(retentionStores, 'readwrite');
    const revisionAdvanced = hasRetentionMetaStore && advanceQueryRevisionWithin(tx);
    const store = tx.objectStore(TRIP_STORE);
    const currentRecord = await idbRequest(store.get(id));
    if (!currentRecord || JSON.stringify(currentRecord) !== sourceBinding) {
      tx.abort();
      return { stale: true };
    }
    store.put(candidate);
    tx.objectStore(TRIP_SUMMARY_STORE).put(summary);
    if (retentionStores.includes(P6_TRIP_DERIVED_STORES.WORK)) {
      tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put(p6TripWorkRecord({
        trip: next,
        revision: nextRevision,
        sourceHash: candidateHash,
        disposition: 'RETENTION_FREEZE',
      }));
    }
    if (retentionStores.includes(P6_TRIP_DERIVED_STORES.MANIFESTS)) {
      dirtyP6GlobalHeads(tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS), 'RETENTION_REVISION_CHANGED');
    }
    await idbTransactionDone(tx);
    return { stale: false, revisionAdvanced };
    });
    if (retentionOutcome.stale) {
      // Nothing was committed, so nothing may be published: a signal here would announce a
      // source change that never happened.
      return { owner: MONOLITHIC_DOCUMENT_OWNER, state: 'STALE_SOURCE', tripId: id, encodedBytes, changed: false };
    }
    // AUD-001: published only now, after the transaction COMPLETED. If the in-transaction
    // advance could not run — no `trip_meta` store in this schema — the source still moved,
    // so the conservative epoch is taken instead of assuming nothing changed. Unknown is
    // "a change nobody was told about", which is the defect, not the safe side.
    if (!retentionOutcome.revisionAdvanced) await advanceP7QueryEpoch('legacy_raw_gps_retention');
    else publishP7SourceChange('legacy_raw_gps_retention');
    await invalidateTripDerivedCaches();
    const pointCount = Array.isArray(trip.route_points) ? trip.route_points.length : 0;
    const motionCount = Array.isArray(trip.motion_samples) ? trip.motion_samples.length : 0;
    await appendPrivacyEvent({
      op: 'RAW_GPS_AUTO_PURGED',
      details: {
        purged_trip_count: 1,
        purged_point_count: pointCount,
        purged_motion_sample_count: motionCount,
        reason: `legacy_browser_raw_gps_retention_${retentionDays}d_motion_${motionRetentionDays}d`,
      },
    });
    return {
      owner: MONOLITHIC_DOCUMENT_OWNER,
      state: 'COMPLETE',
      tripId: id,
      encodedBytes,
      changed: true,
      purgedTrips: 1,
      purgedPoints: pointCount,
      purgedMotionSamples: motionCount,
    };
  } finally {
    db.close();
  }
}

/**
 * P4-C-F04 — genuinely bounded repository maintenance turns.
 *
 * The seven maintenance subpasses used to be *named* bounded units while still
 * executing whole-history work: legacy encryption migration called IndexedDB
 * `getAll()`, trip and raw-GPS retention called `getAllTrips()` and walked every
 * route/motion array, and the projection and rescore passes each drove their own
 * internal multi-turn loop to completion. One coordinator turn could therefore
 * decrypt the entire archive while declaring `{items: 1}`.
 *
 * Each subpass below now advances a fixed window of records per coordinator
 * turn against a durable cursor that the *repository* owns (a `trip_meta`
 * record, exactly like the projection and rescore cursors that already existed).
 * More retained history means more coordinator turns, never a larger turn, and
 * no coordinator checkpoint was introduced: the coordinator still holds nothing
 * but which subpass comes next.
 */
export const REPOSITORY_MAINTENANCE_WINDOW = 25;

const MAINTENANCE_CURSOR_KEYS = Object.freeze({
  ENCRYPTION: 'repository_maintenance_encryption_cursor',
  RETENTION: 'repository_maintenance_retention_cursor',
  RAW_GPS: 'repository_maintenance_raw_gps_cursor',
  RETIRED_EVENTS: 'repository_maintenance_retired_events_cursor',
});

const readMaintenanceCursor = async (db, key) => {
  const stored = await readTripMeta(db, key, null);
  return stored && typeof stored === 'object' ? stored : { cursor: null };
};

const writeMaintenanceCursor = (db, key, value) => writeTripMetaRecord(db, key, value);

/**
 * One window of the legacy plaintext-to-encrypted conversion.
 *
 * P4-C-F04: the fallback (non-IndexedDB) blob is a single document, so
 * converting it means parsing, sanitizing and rewriting the complete archive.
 * That is not a bounded lifecycle unit at any window size, so this step never
 * touches it: with no IndexedDB the subpass is explicitly ownerless, and after
 * the indexed sweep it reports the outstanding obligation instead of doing it.
 * `migrateLegacyTripStorageToEncrypted()` - the existing explicit whole-history
 * operation - keeps that obligation, and the fallback write path re-encrypts
 * the document under the active key on its next write regardless.
 */
export async function stepLegacyTripStorageEncryption({ limit = REPOSITORY_MAINTENANCE_WINDOW } = {}) {
  let indexedDbRecordsMigrated = 0;
  if (!canUseIndexedDb()) {
    return monolithicOwnerless(TRIPS_KEY, {
      indexedDbRecordsMigrated: 0,
      fallbackStoreMigrated: false,
    });
  }
  {
    const db = await openDb();
    try {
      const state = await readMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.ENCRYPTION);
      const rows = await readIndexWindow(db, {
        storeName: TRIP_STORE,
        indexName: TRIP_INDEX_START_TIME_ID,
        after: state.cursor,
        limit,
      });
      if (rows.length) {
        const legacyTrips = rows
          .map(({ value }) => value)
          .filter((record) => (
            record &&
            !isSecureDeleteTombstone(record) &&
            !isEncryptedPayload(record?.encrypted_payload)
          ));
        if (legacyTrips.length) {
          await writeTripsToDb(DB_NAME, legacyTrips);
          indexedDbRecordsMigrated = legacyTrips.length;
        }
        await writeMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.ENCRYPTION, {
          cursor: rows[rows.length - 1].key,
        });
        if (indexedDbRecordsMigrated) {
          recordSystemEvent('trip_storage_encryption_migrated', {
            indexeddb_record_count: indexedDbRecordsMigrated,
            fallback_store_migrated: false,
          }, { category: 'privacy', title: 'Trip storage encrypted' });
        }
        return {
          processed: rows.length,
          examined: rows.length,
          indexedDbRecordsMigrated,
          hasMore: true,
        };
      }
      await writeMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.ENCRYPTION, { cursor: null });
    } catch (error) {
      logSystemFailure('trip_storage_encryption_migration_indexeddb', error, { db_name: DB_NAME });
    } finally {
      db.close();
    }
  }

  // The indexed sweep is finished. Whatever the fallback document still holds
  // is reported through its O(1) reference record, never converted here.
  const reference = await readFallbackTripDocumentReference();
  return {
    processed: 0,
    examined: 0,
    indexedDbRecordsMigrated: 0,
    fallbackStoreMigrated: false,
    fallbackDocumentPending: fallbackTripDocumentMayExist(reference),
    fallbackDocumentOwner: MONOLITHIC_DOCUMENT_OWNER,
    hasMore: false,
  };
}

/**
 * One window of the retention sweep. Expired trips inside the window are
 * deleted through the ordinary delete path, so recovery obligations, caches and
 * audit events keep their existing semantics.
 */
export async function stepTripDataRetention({ now = Date.now(), limit = REPOSITORY_MAINTENANCE_WINDOW } = {}) {
  const retentionDays = normalizeRetentionDays(localSettings.get().data_retention_days);
  if (!retentionDays || !canUseIndexedDb()) {
    return { enabled: false, retentionDays: 0, deletedTrips: 0, processed: 0, examined: 0, hasMore: false };
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  const db = await openDb();
  let rows;
  let state;
  try {
    state = await readMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.RETENTION);
    rows = await readIndexWindow(db, {
      storeName: TRIP_STORE,
      indexName: TRIP_INDEX_START_TIME_ID,
      after: state.cursor,
      limit,
    });
  } finally {
    db.close();
  }

  if (!rows.length) {
    const reset = await openDb();
    try { await writeMaintenanceCursor(reset, MAINTENANCE_CURSOR_KEYS.RETENTION, { cursor: null }); }
    finally { reset.close(); }
    return { enabled: true, retentionDays, deletedTrips: 0, processed: 0, examined: 0, hasMore: false };
  }

  const live = rows.map(({ value }) => value).filter((record) => record && !isSecureDeleteTombstone(record));
  // Only the window's own records are ever decoded.
  const trips = live.length ? await decodeTripRecords(live) : [];
  const expired = trips.filter((trip) => isTripExpiredForRetention(trip, cutoff));
  const deletion = expired.length
    ? await deleteTripsForRetention(expired, {
      retentionDays,
      reason: 'trip_retention_expired_bounded',
    })
    : { deletedTrips: 0 };

  const advanced = await openDb();
  try {
    await writeMaintenanceCursor(advanced, MAINTENANCE_CURSOR_KEYS.RETENTION, {
      cursor: rows[rows.length - 1].key,
    });
  } finally {
    advanced.close();
  }

  return {
    enabled: true,
    retentionDays,
    deletedTrips: deletion.deletedTrips,
    processed: rows.length,
    // P4-C-F09: the window this turn read, not only the rows it deleted.
    examined: rows.length,
    hasMore: true,
  };
}

/**
 * True when the native canonical archive owns raw-GPS retention.
 *
 * On native authority the local IndexedDB copy is disposable. P5's registered
 * native retention job is now the owner, so browser repository maintenance
 * reports delegated/not-applicable without mutating the projection.
 */
const nativeOwnsRawGpsRetention = () => (
  isAndroid() && import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true'
);

/**
 * One window of the raw-GPS/motion retention sweep. At most `limit` trips - and
 * therefore at most `limit` route/motion payloads - are resident per turn.
 */
export async function stepRawGpsRetention({ now = Date.now(), limit = REPOSITORY_MAINTENANCE_WINDOW, force = false } = {}) {
  if (nativeOwnsRawGpsRetention()) {
    return { enabled: false, delegated: true, owner: 'p5NativeRawGpsRetention', purgedTrips: 0, processed: 0, examined: 0, hasMore: false };
  }
  const settings = localSettings.get();
  const retentionDays = Number(settings.raw_gps_retention_days || 0);
  const motionRetentionDays = Number(settings.motion_sample_retention_days || 0);
  const previous = await getRawGpsLifecycleStatus();
  if ((!retentionDays && !motionRetentionDays) || !canUseIndexedDb()) {
    return { enabled: false, purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0, processed: 0, examined: 0, hasMore: false };
  }
  const sweepInProgress = previous.cursor != null;
  if (!force && !sweepInProgress && Number(previous.lastRunAt) > 0 &&
    now - Number(previous.lastRunAt) < RAW_GPS_LIFECYCLE_INTERVAL_MS) {
    return {
      enabled: true,
      skipped: true,
      purgedTrips: 0,
      purgedPoints: 0,
      purgedMotionSamples: 0,
      processed: 0,
      examined: 0,
      hasMore: false,
      lastRunAt: Number(previous.lastRunAt),
    };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const cutoff = now - retentionDays * dayMs;
  const motionCutoff = now - motionRetentionDays * dayMs;

  const db = await openDb();
  let rows;
  try {
    const state = await readMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.RAW_GPS);
    rows = await readIndexWindow(db, {
      storeName: TRIP_STORE,
      indexName: TRIP_INDEX_START_TIME_ID,
      after: state.cursor,
      limit,
    });
  } finally {
    db.close();
  }

  if (!rows.length) {
    const reset = await openDb();
    try { await writeMaintenanceCursor(reset, MAINTENANCE_CURSOR_KEYS.RAW_GPS, { cursor: null }); }
    finally { reset.close(); }
    // The sweep is finished: publish the same lifecycle status the whole-history
    // pass used to publish, while this *turn* truthfully reports zero purged.
    const state = {
      lastRunAt: now,
      retentionDays,
      motionRetentionDays,
      purgedTrips: Number(previous.sweepPurgedTrips) || 0,
      purgedPoints: Number(previous.sweepPurgedPoints) || 0,
      purgedMotionSamples: Number(previous.sweepPurgedMotionSamples) || 0,
      cursor: null,
    };
    await setJson(RAW_GPS_LIFECYCLE_STATE_KEY, state);
    return {
      enabled: true,
      lastRunAt: state.lastRunAt,
      retentionDays,
      motionRetentionDays,
      purgedTrips: 0,
      purgedPoints: 0,
      purgedMotionSamples: 0,
      sweepPurgedTrips: state.purgedTrips,
      sweepPurgedPoints: state.purgedPoints,
      sweepPurgedMotionSamples: state.purgedMotionSamples,
      processed: 0,
      examined: 0,
      hasMore: false,
    };
  }

  const live = rows.map(({ value }) => value).filter((record) => record && !isSecureDeleteTombstone(record));
  const retentionClock = (record) => new Date(record?.end_time || record?.start_time || 0).getTime();
  const isDue = (record) => {
    if (record?.status !== 'completed') return false;
    const when = retentionClock(record);
    if (!Number.isFinite(when) || when <= 0) return false;
    return Boolean(
      (retentionDays && when < cutoff && !record.route_data_expired_at) ||
      (motionRetentionDays && when < motionCutoff && !record.motion_samples_expired_at)
    );
  };
  const legacyDebt = live.find((record) => isDue(record) && !record.rsas_session_id);
  if (legacyDebt) {
    // A predecessor record can contain an arbitrarily large encrypted route.
    // Routine lifecycle observes only its constant-size outer fields and pins
    // the page; the explicit one-record compatibility operation owns decrypt.
    return monolithicOwnerless(`legacy-browser-trip:${String(legacyDebt.id || '')}`, {
      enabled: true,
      legacyRawGpsDebt: true,
      legacyTripId: String(legacyDebt.id || ''),
      processed: 0,
      examined: live.indexOf(legacyDebt) + 1,
      hasMore: false,
    });
  }
  const pendingPurge = new Set();
  for (const record of live) {
    if (!record.rsas_session_id) continue;
    const state = await browserActiveTripSpool.canonicalPurgeState(record.rsas_session_id);
    if (state && state !== 'DONE') pendingPurge.add(record.rsas_session_id);
  }
  const dueRsas = live.filter((record) => record.rsas_session_id &&
    (isDue(record) || pendingPurge.has(record.rsas_session_id)));
  const trips = dueRsas.length ? await decodeTripRecords(dueRsas) : [];
  const expiredTrips = [];
  const expiredOriginals = [];
  let purgedPoints = 0;
  let purgedMotionSamples = 0;
  let rsasPurgeWorked = false;
  let rsasPurgeIncomplete = false;
  let rsasPurgedTrips = 0;
  let rsasPurgedPoints = 0;
  let rsasPurgedMotionSamples = 0;
  let auditItemsWorked = 0;
  let auditBytesWorked = 0;

  for (const trip of trips) {
    const when = new Date(trip.end_time || trip.start_time || trip.created_at || 0).getTime();
    if (trip.status !== 'completed' || !Number.isFinite(when) || when <= 0) continue;

    const rawPurgeDue = Boolean((retentionDays && when < cutoff && !trip.route_data_expired_at) || pendingPurge.has(trip.rsas_session_id));
    let expired = trip;
    if (!rawPurgeDue && motionRetentionDays && when < motionCutoff) {
      const motionExpired = expireTripMotionSamples(expired, motionRetentionDays, now);
      if (motionExpired !== expired) {
        purgedMotionSamples += Array.isArray(expired.motion_samples) ? expired.motion_samples.length : 0;
        expired = motionExpired;
      }
    }
    if (rawPurgeDue) {
      if (trip.rsas_session_id) {
        if (rsasPurgeWorked) continue;
        const frozen = await applyP6TripEvidenceDispositionPage(trip.id, 'FREEZE', {
          sourceAuthority: 'browser', maxItems: 8,
        });
        if (frozen.state === 'CONVERSION_REQUIRED') {
          return monolithicOwnerless(`p6-speed-evidence:${String(trip.id || '')}`, {
            enabled: true, processed: rows.length, examined: rows.length, hasMore: false,
          });
        }
        if (frozen.hasMore) {
          return { enabled: true, state: 'P6_FREEZE_PARTIAL', processed: rows.length,
            examined: rows.length + Number(frozen.itemsWorked || 0), hasMore: true,
            purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0 };
        }
        await browserActiveTripSpool.beginCanonicalPurge(trip.rsas_session_id, {
          retentionDays,
          motionRetentionDays: motionRetentionDays && when < motionCutoff && !trip.motion_samples_expired_at ? motionRetentionDays : 0,
          expiredAt: now,
        });
        let purge;
        try { purge = await browserActiveTripSpool.stepCanonicalPurge(trip.rsas_session_id, { limit: 16 }); }
        catch (error) {
          if (error?.code) error.itemsWorked = (Number(error.itemsWorked) || 0) + rows.length;
          throw error;
        }
        auditItemsWorked += Number(purge.auditItemsWorked) || 0;
        auditBytesWorked += Number(purge.auditBytesWorked) || 0;
        rsasPurgeWorked = true;
        // The read overlay is already ROUTE_EXPIRED. Publish the idempotent
        // repository expired shape only after all segment unlink steps finish.
        if (purge.state !== 'DONE') {
          rsasPurgeIncomplete = true;
          continue;
        }
        rsasPurgedTrips += Number(purge.purgedTrips) || 0;
        rsasPurgedPoints += Number(purge.purgedPoints) || 0;
        rsasPurgedMotionSamples += Number(purge.purgedMotionSamples) || 0;
        // Metadata/receipt already committed inside TRIP_METADATA_PENDING.
        // Do not run the in-record helper or append a second raw receipt.
        continue;
      }
      const routeExpired = expireTripRouteData(expired, retentionDays, now);
      if (routeExpired !== expired) {
        purgedPoints += Array.isArray(expired.route_points) ? expired.route_points.length : 0;
        expired = routeExpired;
      }
    }
    if (expired === trip) continue;
    expiredOriginals.push(trip);
    expiredTrips.push(expired);
  }

  if (expiredTrips.length) {
    for (const trip of expiredOriginals) {
      const frozen = await applyP6TripEvidenceDispositionPage(trip.id, 'FREEZE', {
        sourceAuthority: 'browser', maxItems: 8,
      });
      if (frozen.state === 'CONVERSION_REQUIRED') {
        return monolithicOwnerless(`p6-speed-evidence:${String(trip.id || '')}`, {
          enabled: true, processed: rows.length, examined: rows.length, hasMore: false,
        });
      }
      if (frozen.hasMore) return { enabled: true, state: 'P6_FREEZE_PARTIAL',
        processed: rows.length, examined: rows.length + Number(frozen.itemsWorked || 0), hasMore: true,
        purgedTrips: 0, purgedPoints: 0, purgedMotionSamples: 0 };
    }
    await applyTripFieldChanges(expiredOriginals, expiredTrips);
    await invalidateTripDerivedCaches();
    try {
      await appendPrivacyEvent({
        op: 'RAW_GPS_AUTO_PURGED',
        details: {
          purged_trip_count: expiredTrips.length,
          purged_point_count: purgedPoints,
          purged_motion_sample_count: purgedMotionSamples,
          reason: `raw_gps_retention_${retentionDays}d_motion_${motionRetentionDays}d`,
        },
      });
    } catch (error) {
      logSystemFailure('raw_gps_retention_audit_append', error, {
        purged_trip_count: expiredTrips.length,
      });
    }
    recordSystemEvent('raw_gps_retention_enforced', {
      retention_days: retentionDays,
      motion_retention_days: motionRetentionDays,
      purged_trip_count: expiredTrips.length,
      purged_point_count: purgedPoints,
      purged_motion_sample_count: purgedMotionSamples,
    }, {
      category: 'privacy',
      title: 'Expired route data removed',
      message: `Removed route coordinates from ${expiredTrips.length} old trip${expiredTrips.length === 1 ? '' : 's'} while keeping summaries.`,
    });
  }

  // Keep this page pinned while its single RSAS deletion is unfinished. A
  // process restart then resumes the durable purge state instead of requiring
  // a complete archive sweep before this trip is visited again.
  const nextCursor = rsasPurgeIncomplete ? (previous.cursor ?? null) : rows[rows.length - 1].key;
  const advanced = await openDb();
  try {
    await writeMaintenanceCursor(advanced, MAINTENANCE_CURSOR_KEYS.RAW_GPS, {
      cursor: nextCursor,
    });
  } finally {
    advanced.close();
  }
  // Sweep-scoped running totals, so the completing turn can publish the same
  // lifecycle status the whole-history pass used to publish.
  await setJson(RAW_GPS_LIFECYCLE_STATE_KEY, {
    ...previous,
    retentionDays,
    motionRetentionDays,
    cursor: nextCursor,
    sweepPurgedTrips: (Number(previous.sweepPurgedTrips) || 0) + expiredTrips.length + rsasPurgedTrips,
    sweepPurgedPoints: (Number(previous.sweepPurgedPoints) || 0) + purgedPoints + rsasPurgedPoints,
    sweepPurgedMotionSamples: (Number(previous.sweepPurgedMotionSamples) || 0) + purgedMotionSamples + rsasPurgedMotionSamples,
  });

  return {
    enabled: true,
    purgedTrips: expiredTrips.length + rsasPurgedTrips,
    purgedPoints: purgedPoints + rsasPurgedPoints,
    purgedMotionSamples: purgedMotionSamples + rsasPurgedMotionSamples,
    auditItemsWorked,
    auditBytesWorked,
    processed: rows.length,
    examined: rows.length,
    hasMore: true,
  };
}

/**
 * One window of the retired trip-event-type migration.
 *
 * The one-shot version marker is only advanced once the whole index has been
 * walked, so an interrupted upgrade resumes instead of declaring itself done.
 */
export async function stepRetiredTripEventTypeMigration({ limit = REPOSITORY_MAINTENANCE_WINDOW } = {}) {
  const version = Number(await getJson(TRIP_EVENT_MIGRATION_KEY, 0)) || 0;
  if (version >= TRIP_EVENT_MIGRATION_VERSION) {
    return { changed: 0, alreadyRan: true, processed: 0, examined: 0, hasMore: false };
  }
  if (!canUseIndexedDb()) {
    // P4-C-F04: the fallback store is a single document, and
    // `migrateRetiredTripEventTypesOnce()` maps and filters all of it. That
    // whole pass stays with its existing explicit owner - the whole-history
    // read entry points (`list`, `listAll`, export) still run it - and the
    // version marker is deliberately left un-advanced so the debt survives.
    return monolithicOwnerless(TRIPS_KEY, { changed: 0, alreadyRan: false });
  }

  const db = await openDb();
  let rows;
  try {
    const state = await readMaintenanceCursor(db, MAINTENANCE_CURSOR_KEYS.RETIRED_EVENTS);
    rows = await readIndexWindow(db, {
      storeName: TRIP_STORE,
      indexName: TRIP_INDEX_START_TIME_ID,
      after: state.cursor,
      limit,
    });
  } finally {
    db.close();
  }

  if (!rows.length) {
    const finished = await openDb();
    try { await writeMaintenanceCursor(finished, MAINTENANCE_CURSOR_KEYS.RETIRED_EVENTS, { cursor: null }); }
    finally { finished.close(); }
    await setJson(TRIP_EVENT_MIGRATION_KEY, TRIP_EVENT_MIGRATION_VERSION);
    return { changed: 0, alreadyRan: false, processed: 0, examined: 0, hasMore: false };
  }

  const live = rows.map(({ value }) => value).filter((record) => record && !isSecureDeleteTombstone(record));
  const trips = live.length ? await decodeTripRecords(live) : [];
  const migratedTrips = trips.map(normalizeRetiredTripEventTypes);
  const changedOriginals = trips.filter((trip, index) => migratedTrips[index] !== trip);
  const changedTrips = migratedTrips.filter((trip, index) => trip !== trips[index]);
  if (changedTrips.length) {
    await applyTripFieldChanges(changedOriginals, changedTrips);
    await invalidateTripDerivedCaches();
  }

  const advanced = await openDb();
  try {
    await writeMaintenanceCursor(advanced, MAINTENANCE_CURSOR_KEYS.RETIRED_EVENTS, {
      cursor: rows[rows.length - 1].key,
    });
  } finally {
    advanced.close();
  }
  return {
    changed: changedTrips.length,
    alreadyRan: false,
    processed: rows.length,
    examined: rows.length,
    hasMore: true,
  };
}

/**
 * P4-C-F04 — one bounded projection subpass per coordinated turn.
 *
 * Exactly one of backfill / verification / cleanup runs, chosen by the phase
 * the projection domain itself persists. `processed` is the records the subpass
 * examined in this invocation - not only the rows it converted, verified or
 * removed - so a turn that reads two 256-row windows and changes nothing still
 * reports the 512 records it consumed.
 */
export async function stepProjectionMaintenance() {
  const totals = await runProjectionMaintenanceSlice();
  const examined = Math.max(0, Number(totals.examined) || 0);
  return {
    ...totals,
    processed: examined,
    examined,
    hasMore: totals.hasMore === true,
  };
}

/** One bounded rescore window, with its existing committed cursor. */
export async function stepRescoreMaintenanceWindow() {
  const result = await runRescoreMaintenanceWindows({ maxWindows: 1 });
  const examined = Math.max(0, Number(result.examined) || 0);
  return { ...result, processed: examined, examined, hasMore: result.done !== true };
}

let repositoryMaintenancePromise = null;

/**
 * The repository maintenance sequence, expressed as its individual bounded
 * domain units. One coordinator turn runs exactly one of these — turning the
 * whole seven-subpass sequence into a single turn would violate C07/C08.
 * Each unit keeps its own cursor/checkpoint; no new durable state is added.
 */
const REPOSITORY_MAINTENANCE_UNITS = [
  ['legacy_storage_migration', () => stepLegacyTripStorageEncryption()],
  // Native intake is already bounded by the completed-trip journal's own
  // 64-entry maximum and the 8-item/8MiB journal ingest cap.
  ['native_completed_import', async () => {
    const outcome = await importNativeCompletedTrips();
    const examined = Math.max(0, Number(outcome?.imported) || 0);
    return { ...outcome, processed: examined, examined, hasMore: false };
  }],
  ['trip_data_retention', () => stepTripDataRetention()],
  ['raw_gps_retention', () => stepRawGpsRetention()],
  ['retired_event_types', () => stepRetiredTripEventTypeMigration()],
  ['projection_maintenance', () => stepProjectionMaintenance().catch((error) => {
    logSystemFailure('trip_projection_maintenance', error, { db_name: DB_NAME });
    return { processed: 0, examined: 0, hasMore: false };
  })],
  ['rescore_windows', () => stepRescoreMaintenanceWindow().catch((error) => {
    logSystemFailure('trip_projection_rescore_maintenance', error, { db_name: DB_NAME });
    return { rescored: 0, processed: 0, examined: 0, hasMore: false };
  })],
];

export const REPOSITORY_MAINTENANCE_UNIT_COUNT = REPOSITORY_MAINTENANCE_UNITS.length;

/**
 * P4-C-F09 — records one coordinated repository turn may examine.
 *
 * Derived, not asserted: exactly one subpass runs per turn, so the ceiling is
 * the widest single subpass. The record-store subpasses each read one
 * `REPOSITORY_MAINTENANCE_WINDOW`; the native intake unit is capped by the
 * journal's own 64-entry maximum; the projection slice reads at most one
 * verification pair of windows.
 */
export const NATIVE_COMPLETED_IMPORT_MAX_ITEMS = 64;
export const REPOSITORY_MAINTENANCE_MAX_EXAMINED = Math.max(
  REPOSITORY_MAINTENANCE_WINDOW,
  NATIVE_COMPLETED_IMPORT_MAX_ITEMS,
  PROJECTION_SUBPASS_MAX_EXAMINED,
);

/**
 * Run one bounded repository-maintenance turn.
 *
 * P4-C-F04: a subpass that still has records left keeps the sequence on the
 * same unit rather than advancing, so a large history is drained by more turns
 * of the same fixed size. `processed` is the subpass's own count of records it
 * actually touched - never a fabricated 1 - and `nextUnitIndex` is the only
 * thing a scheduler needs to carry between turns.
 */
export async function stepTripRepositoryMaintenance({ unitIndex = 0 } = {}) {
  const index = Math.max(0, Math.floor(Number(unitIndex) || 0));
  if (index >= REPOSITORY_MAINTENANCE_UNITS.length) {
    return { unit: null, unitIndex: index, nextUnitIndex: 0, processed: 0, hasMore: false, result: null };
  }
  const [unit, run] = REPOSITORY_MAINTENANCE_UNITS[index];
  const result = await run();
  const unitHasMore = result?.hasMore === true;
  const nextUnitIndex = unitHasMore ? index : index + 1;
  // P4-C-F09: the records this invocation examined. A subpass that reads a full
  // window and changes nothing still consumed that window; a subpass that
  // declined ownership of a monolithic document consumed nothing.
  const examined = Math.max(0, Number(result?.examined ?? result?.processed) || 0);
  return {
    unit,
    unitIndex: index,
    nextUnitIndex,
    unitHasMore,
    ownerless: result?.ownerless === true,
    owner: result?.ownerless === true ? (result.owner || null) : null,
    processed: examined,
    examined,
    hasMore: unitHasMore || nextUnitIndex < REPOSITORY_MAINTENANCE_UNITS.length,
    result: result ?? null,
    auditItemsWorked: Number(result?.auditItemsWorked) || 0,
    auditBytesWorked: Number(result?.auditBytesWorked) || 0,
  };
}

export async function runTripRepositoryMaintenance() {
  if (repositoryMaintenancePromise) return repositoryMaintenancePromise;

  repositoryMaintenancePromise = (async () => {
    await migrateLegacyTripStorageToEncrypted();
    await importNativeCompletedTrips();
    await enforceTripDataRetention();
    await enforceRawGpsRetention();
    await migrateRetiredTripEventTypesOnce();
    // Summaries are cheap to read and already tell us whether any stored trip
    // needs a schema/scoring refresh. Avoid decrypting every full GPS trace on
    // every app launch when the repository is already current.
    // Bounded projection maintenance: backfill, verify and cleanup each advance
    // by a committed cursor. Total work is O(N); no turn is, and no foreground
    // read waits for it.
    await runProjectionMaintenance().catch((error) => {
      logSystemFailure('trip_projection_maintenance', error, { db_name: DB_NAME });
    });
    // Scheduled P3 maintenance must not read and decrypt every retained summary
    // just to produce a count. Rescore freshness is advanced by the bounded
    // window primitive, which persists its own cursor and resumes after restart.
    const rescore = await runRescoreMaintenanceWindows().catch((error) => {
      logSystemFailure('trip_projection_rescore_maintenance', error, { db_name: DB_NAME });
      return { rescored: 0 };
    });
    return { tripCount: await countStoredTrips(), rescored: rescore.rescored };
  })();

  try {
    return await repositoryMaintenancePromise;
  } finally {
    repositoryMaintenancePromise = null;
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
  // P3.5 explicit migration-only primitives. They intentionally bypass native
  // journal import, read-time rescoring and retention so migration observes a
  // stable legacy source record without mutating or acknowledging anything.
  async listLegacyMigrationPage({ cursor = null, limit = 50 } = {}) {
    return listBoundedProjections({ sort: 'start_time', limit, cursor });
  },

  async getLegacyTripForMigration(id) {
    return getStoredTripById(id);
  },
  /**
   * Typed keyset primitive over the compact projection. This is the P7 target
   * and the storage-bound path: selection, decryption and hydration are all
   * proportional to the requested page, never to retained history.
   */
  async listProjections({ sort, limit, status = null, cursor = null } = {}) {
    await importNativeCompletedTrips();
    return listBoundedProjections({ sort, limit, status, cursor });
  },

  /**
   * Bounded summary read, now served by the projection path.
   *
   * The legacy route ran `getCurrentTripSummaries()`, which read and decrypted
   * every summary and — if any single trip was stale — decrypted the entire
   * full-trip history before slicing to `limit`. Neither happens here: ordering
   * comes from the source index, only the selected page is read, and rescore
   * freshness is owned by repository maintenance rather than by a display query.
   *
   * On any storage failure it falls back to the legacy path so a read never
   * fails outright.
   */
  async listSummaries({ sort, limit } = {}) {
    await importNativeCompletedTrips();
    const query = assertProjectionQuery({ sort, limit }, {
      maxLimit: MAX_PROJECTION_PAGE,
      defaultLimit: DEFAULT_PROJECTION_PAGE,
    });
    if (canUseIndexedDb()) {
      try {
        const page = await listBoundedProjections({ sort: query.sort, limit: query.limit });
        return page.rows;
      } catch (error) {
        if (error?.name === 'ProjectionQueryError') throw error;
        // Only genuinely unavailable primary storage may fall back to the legacy
        // whole-history path. A projection-level failure — corrupt ciphertext,
        // failed authentication after a key change, envelope mismatch — is
        // page-bounded by construction, and routing it here would re-read and
        // re-decrypt the entire retained history on every subsequent query.
        if (!isPrimaryStorageUnavailable(error)) {
          logSystemFailure('trip_projection_bounded_read_degraded', error, { db_name: DB_NAME });
          throw error;
        }
        logSystemFailure('trip_projection_bounded_read', error, { db_name: DB_NAME });
      }
    }
    projectionCounters.historySorts += 1;
    return sortTrips(await getCurrentTripSummaries(), query.sort).slice(0, query.limit);
  },

  /**
   * **`list` is retired in P7 Stage 9: a typed refusal on the browser
   * authority.**
   *
   * `getAllTrips()` decrypted **every** stored record in
   * full, then a retention sweep, an event migration, a version-tagging pass
   * and a rescore pass all ran over that array, and only then were `limit`
   * rows sliced off the front. Four pages called it on mount, so the limit
   * described what was rendered while the work scaled with the whole history.
   *
   * The refusal is typed rather than a deletion so a reintroduced caller fails
   * with the reason instead of silently reacquiring that cost. The native
   * repository refuses it the same way, so the two authorities agree.
   *
   * `listAllSummaries` below is **already callerless in production** and the
   * plan retires it by classification rather than by stub — the release audit
   * moves it from category A to D. It still serves the summary-store
   * durability contract P3.5 owns, which is a different property from the
   * unbounded page read this stage removes.
   */
  async listAllSummaries({ sort = '-start_time' } = {}) {
    await importNativeCompletedTrips();
    return sortTrips(await getCurrentTripSummaries(), sort);
  },

  async list() {
    throw Object.assign(
      new Error('list was retired in P7. Read a bounded Q1 page instead.'),
      { code: 'UNBOUNDED_QUERY_FORBIDDEN', query: 'list' },
    );
  },

  async listForSpeedMap({ sort = '-start_time', offset = 0, limit = 80 } = {}) {
    await importNativeCompletedTrips();
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 80)));
    const eligibleSummaries = sortTrips(await getCurrentTripSummaries(), sort).filter((trip) => (
      trip?.status === 'completed' &&
      trip?.privacy_mode !== 'summary_only' &&
      !trip?.route_data_expired_at
    ));
    const selectedSummaries = eligibleSummaries.slice(safeOffset, safeOffset + safeLimit);
    const selectedIds = selectedSummaries.map((trip) => trip.id);
    const loadedTrips = await getStoredTripsByIds(selectedIds);
    const loadedById = new Map(loadedTrips.map((trip) => [String(trip?.id), trip]));
    const trips = selectedIds
      .map((id) => loadedById.get(String(id)))
      .filter((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 1);
    return {
      trips,
      totalAvailable: eligibleSummaries.length,
      nextOffset: Math.min(eligibleSummaries.length, safeOffset + selectedSummaries.length),
    };
  },

  async listAllForExport({ sort = '-start_time', signal, onProgress } = {}) {
    throwIfAborted(signal);
    await importNativeCompletedTrips();
    throwIfAborted(signal);
    const trips = await getAllTrips({ signal, onProgress });
    throwIfAborted(signal);
    const now = Date.now();
    const retention = await enforceTripDataRetention({ now, trips });
    throwIfAborted(signal);
    if (!retention.enabled || !retention.deletedTrips) return sortTrips(trips, sort);

    const cutoff = now - retention.retentionDays * 24 * 60 * 60 * 1000;
    return sortTrips(trips.filter((trip) => !isTripExpiredForRetention(trip, cutoff)), sort);
  },

  async listAll({ sort = '-start_time' } = {}) {
    await importNativeCompletedTrips();
    await enforceTripDataRetention();
    await migrateRetiredTripEventTypesOnce();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    return sortTrips(trips, sort);
  },

  async getById(id) {
    await importNativeCompletedTrips();
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');
    return prepareTripForRead(trip);
  },

  /**
   * One complete trip, including payload-only fields such as `driving_events`.
   *
   * Bounded jobs use this to process exactly one trip at a time; it is never a
   * licence to iterate the whole archive.
   */
  async getFullById(id) {
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');
    return prepareTripForRead(trip);
  },

  /**
   * One complete trip, prepared exactly as `getFullById` prepares it, but
   * **without persisting** the preparation.
   *
   * HPR-019 (Wave 6 correction): an export walk claims a source snapshot and must
   * be able to prove the evidence it collected still belongs to it. It cannot do
   * that while its own reads advance the query revision. This is the read an
   * artifact uses; it returns the same value and leaves the source alone.
   *
   * A rescore that this read computed is simply not saved. The ordinary detail
   * path still settles it the next time a screen opens the trip.
   */
  async readFullByIdForExport(id) {
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');
    return prepareTripValueForRead(trip);
  },

  /**
   * The current P7 source identity, as an O(1) meta read.
   *
   * It is the same `{authority, generation, revision}` every Q1 page already
   * returns in its envelope — not a second revision system. An export compares
   * it with the snapshot its page was read under.
   */
  readQuerySnapshot() {
    return readP7QuerySnapshot();
  },

  async getPayloadStream(id) {
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');
    if (trip.route_payload_storage !== 'browser_rsas_v1' || !trip.rsas_session_id) {
      async function* legacyPayload() {
        for (const point of trip.route_points || []) yield point;
      }
      return legacyPayload();
    }
    return browserActiveTripSpool.readPoints(trip.rsas_session_id);
  },

  async getOverview(id, maxPoints = 900) {
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');
    const safeMax = Math.max(1, Math.min(2_000, Math.floor(Number(maxPoints) || 900)));
    const points = Array.isArray(trip.route_preview)
      ? trip.route_preview
      : Array.isArray(trip.route_points)
        ? trip.route_points
        : [];
    if (points.length <= safeMax) return { points };
    const stride = Math.ceil(points.length / safeMax);
    return { points: points.filter((_point, index) => index % stride === 0).slice(0, safeMax) };
  },

  async create(trip) {
    const source = !isAndroid() && trip?.rsas_session_id
      ? await activeTripStore.completeBrowserCanonical(trip)
      : trip;
    const saved = /** @type {Record<string, any>} */ (withId({ ...source, created_at: new Date().toISOString() }));
    // The lock also makes the native-manual de-dup check below check-then-act atomic.
    const storageSaved = await withTripWriteLock(saved.id, async () => {
      const existing = await getStoredTripById(saved.id).catch(() => null);
      if (
        existing?.route_payload_storage === 'browser_rsas_v1' &&
        existing?.rsas_session_id &&
        saved?.route_payload_storage === 'browser_rsas_v1' &&
        saved?.rsas_session_id
      ) {
        if (existing.rsas_session_id === saved.rsas_session_id) return existing;
        const error = new Error('A canonical browser trip cannot be replaced by another session.');
        error.code = 'CANONICAL_TRIP_ALREADY_FINALIZED';
        throw error;
      }
      if (
        existing?.imported_from_native === true &&
        existing?.start_source === 'native_manual' &&
        saved?.native_manual_background === true
      ) {
        return existing;
      }
      // The raw source goes to putTrip so the all-field preflight runs before
      // the first source-sized sanitized copy exists, and so the record is
      // sanitized once rather than here and again inside the writer.
      return putTrip(saved);
    });
    if (storageSaved.status === 'completed') await invalidateTripDerivedCaches();
    await enforceTripDataRetention();
    return storageSaved;
  },

  async update(id, patch) {
    // `patch` carries only the fields the caller owns, so re-reading inside the lock and
    // merging onto the freshest record lets a user edit and a background rescore both survive.
    let storageUpdated;
    try {
      storageUpdated = await withTripWriteLock(id, async () => {
        const current = await getStoredTripById(id);
        if (!current) throw new Error('Road Sage could not find this trip to update.');
        const updated = /** @type {Record<string, any>} */ (withId({ ...current, ...patch, id: current.id }));
        return putTrip(updated);
      });
    } catch (error) {
      logSystemFailure('trip_repository_update', error, { trip_id_present: id != null });
      throw error;
    }
    if (storageUpdated.status === 'completed') await invalidateTripDerivedCaches();
    return storageUpdated;
  },

  async delete(id) {
    const existing = await getStoredTripById(id).catch(() => null);
    if (existing?.route_payload_storage === 'browser_rsas_v1' && existing?.rsas_session_id) {
      await browserActiveTripSpool.deleteCanonical(existing.rsas_session_id);
    }
    const result = await withTripWriteLock(id, () => deleteTrip(id));
    // P7 A2.4 clause 4: deletion is not a single transaction (see the mechanism
    // map in `queryContracts/cursor.js`), so it takes the conservative epoch.
    // Every outstanding cursor and Q10 continuation then restarts rather than
    // returning a silently short or backfilled page.
    await advanceP7QueryEpoch('trip_deleted');
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

  async eraseAll() {
    const trips = await this.listAll({ sort: '-start_time' });
    for (const trip of trips) await this.delete(trip.id);
    return { erased: true, verified: true, removedTripCount: trips.length, authority: 'browser_indexeddb' };
  },

  /**
   * Restore-only batch contract. Imported rows are classified against the
   * restore session's explicit policy and never invoke ambient whole-history
   * retention. Eligible writes are individually durable so a failure can name
   * the exact committed prefix without changing `upsertMany` for other callers.
   */
  async restoreBatch(trips = [], { retentionDays = 0, now = Date.now() } = {}) {
    assertLogicalWriteBatch(trips);
    const resolvedRetentionDays = normalizeRetentionDays(retentionDays);
    const cutoff = resolvedRetentionDays
      ? now - resolvedRetentionDays * 24 * 60 * 60 * 1000
      : null;
    const thresholds = buildDrivingThresholds(localSettings.get());
    const vehicles = await vehiclesForTrips(trips);
    const candidates = trips.map((trip) => {
      const next = withId({
        ...trip,
        created_at: trip.created_at || trip.start_time || new Date(now).toISOString(),
      });
      return needsRescore(next, thresholds) ? rescoreTrip(next, vehicles) : next;
    });
    const survivingTrips = [];
    let removedByRetention = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (cutoff != null && isTripExpiredForRetention(candidate, cutoff)) {
        removedByRetention += 1;
        continue;
      }
      try {
        const saved = await withTripWriteLock(candidate.id, () => putTrip(candidate));
        survivingTrips.push(saved);
      } catch (error) {
        error.restoreOutcome = {
          attemptedTrips: candidates.length,
          processedTrips: index,
          survivingTrips,
          removedByRetention,
          failedWrites: 1,
          unprocessedTrips: Math.max(0, candidates.length - index - 1),
          retentionPending: 0,
          status: 'partial',
        };
        throw error;
      }
    }

    if (survivingTrips.some((trip) => trip.status === 'completed')) {
      await invalidateTripDerivedCaches();
    }
    return {
      attemptedTrips: candidates.length,
      processedTrips: candidates.length,
      survivingTrips,
      removedByRetention,
      failedWrites: 0,
      unprocessedTrips: 0,
      retentionPending: 0,
      status: 'complete',
    };
  },

  async stepRetentionReconciliation(options = {}) {
    return stepTripDataRetention(options);
  },

  async upsertMany(trips = []) {
    // Rejected before locks, rescoring, sanitization, copies, crypto or any
    // downstream side effect, so an over-limit caller cannot observe a partially
    // applied write. Every production caller is already bounded: backup import
    // batches four, native import writes one.
    assertLogicalWriteBatch(trips);
    const thresholds = buildDrivingThresholds(localSettings.get());
    const vehicles = await vehiclesForTrips(trips);
    const rescoredTrips = trips.map((trip) => {
      const next = withId({
        ...trip,
        created_at: trip.created_at || trip.start_time || new Date().toISOString(),
      });
      return needsRescore(next, thresholds) ? rescoreTrip(next, vehicles) : next;
    });
    const normalized = await sanitizeTripsForPrivacyStorage(rescoredTrips);
    // Native import is the authoritative source for these records, so it keeps whole-object
    // overwrite semantics; the lock only stops it interleaving with a concurrent edit.
    await withTripWriteLocks(normalized.map((trip) => trip.id), () => putTrips(normalized));
    if (normalized.some((trip) => trip.status === 'completed')) await invalidateTripDerivedCaches();
    await enforceTripDataRetention();
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
    await applyTripFieldChanges(trips, updated);
    if (count) await invalidateTripDerivedCaches();
    return count;
  },

  async rescoreCompletedTrips({ onlyProvenanceMismatch = false, reason = 'manual' } = {}) {
    await importNativeCompletedTrips();
    await enforceTripDataRetention();
    await migrateRetiredTripEventTypesOnce();
    const thresholds = buildDrivingThresholds(localSettings.get());
    const trips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const scoped = trips.filter((trip) => (
      trip.status === 'completed' &&
      (!onlyProvenanceMismatch || getScoreProvenanceStatus(trip, thresholds).needsRescore)
    ));
    const skipped = scoped
      .map((trip) => ({ id: trip.id, reason: rescoreIneligibilityReason(trip) }))
      .filter((item) => item.reason);
    const skippedIds = new Set(skipped.map((item) => String(item.id)));
    const eligible = scoped.filter((trip) => !skippedIds.has(String(trip.id)));
    const vehicles = await vehiclesForTrips(trips);
    const rescoredTrips = [];
    const rescoredOriginals = [];
    const changes = [];
    const failures = [];
    let completed = 0;

    emitRescoreProgress({
      status: 'running',
      completed,
      total: eligible.length,
      skipped: skipped.length,
      reason,
    });

    for (const trip of eligible) {
      try {
        const before = scoreSnapshot(trip);
        const rescored = rescoreTrip({ ...trip, needs_rescore: true }, vehicles);
        const after = scoreSnapshot(rescored);
        rescoredOriginals.push(trip);
        rescoredTrips.push(rescored);
        if (scoreSnapshotsDiffer(before, after)) {
          changes.push({
            id: trip.id,
            nickname: trip.nickname || '',
            start_time: trip.start_time || null,
            before,
            after,
          });
        }
      } catch (error) {
        failures.push({
          id: trip.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      completed += 1;
      emitRescoreProgress({
        status: 'running',
        completed,
        total: eligible.length,
        skipped: skipped.length,
        failed: failures.length,
        reason,
      });
    }

    if (rescoredTrips.length) {
      await applyTripFieldChanges(rescoredOriginals, rescoredTrips);
      await invalidateTripDerivedCaches();
    }

    const result = {
      requested: scoped.length,
      eligible: eligible.length,
      completed: rescoredTrips.length,
      changed: changes.length,
      unchanged: Math.max(0, rescoredTrips.length - changes.length),
      skipped: skipped.length,
      failed: failures.length,
      changes,
      skippedTrips: skipped,
      failures,
    };
    emitRescoreProgress({
      status: 'complete',
      total: eligible.length,
      completed: rescoredTrips.length,
      skipped: skipped.length,
      failed: failures.length,
      changed: changes.length,
      reason,
    });
    return result;
  },

  async rescoreTripById(id, { reason = 'manual' } = {}) {
    await importNativeCompletedTrips();
    await enforceTripDataRetention();
    await migrateRetiredTripEventTypesOnce();
    const trip = await getStoredTripById(id);
    if (!trip) throw new Error('Trip not found');

    const skippedReason = rescoreIneligibilityReason(trip);
    if (skippedReason) {
      return {
        requested: 1,
        completed: 0,
        changed: false,
        skipped: true,
        skippedReason,
        before: scoreSnapshot(trip),
        after: scoreSnapshot(trip),
        updatedTrip: await prepareTripForRead(trip),
      };
    }

    const vehicles = await vehiclesForTrips([trip]);
    const before = scoreSnapshot(trip);
    const rescored = rescoreTrip({ ...trip, needs_rescore: true }, vehicles);
    const after = scoreSnapshot(rescored);
    await applyTripFieldChanges([trip], [rescored]);
    await invalidateTripDerivedCaches();
    recordSystemEvent('trip_targeted_rescore_completed', {
      trip_id_present: true,
      reason,
      score_changed: scoreSnapshotsDiffer(before, after),
      feedback_adjusted_events_count: Number(rescored.feedback_adjusted_events_count) || 0,
    }, { category: 'scoring', title: 'Trip re-scored' });

    return {
      requested: 1,
      completed: 1,
      changed: scoreSnapshotsDiffer(before, after),
      skipped: false,
      skippedReason: null,
      before,
      after,
      updatedTrip: await prepareTripForRead(rescored),
    };
  },

  async getScoreMigrationSummary() {
    await importNativeCompletedTrips();
    await enforceTripDataRetention();
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
    const completedEligibility = completed.map((trip) => ({
      trip,
      reason: rescoreIneligibilityReason(trip),
    }));
    const mismatchEligibility = mismatched.map(({ trip }) => ({
      trip,
      reason: rescoreIneligibilityReason(trip),
    }));
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
      rescore_eligible_count: completedEligibility.filter((item) => !item.reason).length,
      rescore_ineligible_count: completedEligibility.filter((item) => item.reason).length,
      mismatch_rescore_eligible_count: mismatchEligibility.filter((item) => !item.reason).length,
      mismatch_rescore_ineligible_count: mismatchEligibility.filter((item) => item.reason).length,
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
