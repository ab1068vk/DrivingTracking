import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { clearNativeCompletedTrips, getNativeCompletedTrips } from '@/lib/activityRecognition';
import { isAndroid } from '@/lib/nativePlatform';
import {
  buildScoreProvenance,
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  getScoreProvenanceStatus,
  SCORING_VERSION,
} from '@/lib/tripEngine';
import { estimateTripEconomics } from '@/lib/tripInsights';
import { localSettings, saveLastParkedLocation } from '@/lib/trackingStore';
import { invalidateDangerZoneCache } from '@/lib/dangerZoneEngine';
import { invalidateRouteRiskIndex } from '@/lib/routeRiskIndex';
import {
  buildPhoneUseFromTripEvidence,
  mergePhoneUseEventsIntoDrivingEvents,
} from '@/lib/phoneUsageAccess';
import { hasRecoverableOriginalRouteGeometry, restoreOriginalRouteGeometry } from '@/lib/mapPlaybackInsights';

const TRIPS_KEY = 'drivesense_trips';
const DRIVER_SIGNATURE_KEY = 'drivesense_driver_signature';
const DB_NAME = 'drivesense_mobile';
const TRIP_STORE = 'trips';
export const TRIP_SCHEMA_VERSION = 22;
export const RESCORE_PROGRESS_EVENT = 'road-sage:rescore-progress';
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

const DB_VERSION = tripDbMigrationRunner.version;

const openDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }

  const request = indexedDB.open(DB_NAME, DB_VERSION);
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

const idbRequest = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const idbTransactionDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const getAllTrips = async () => {
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readonly');
    const trips = await idbRequest(tx.objectStore(TRIP_STORE).getAll());
    db.close();
    return trips;
  } catch {
    return getJson(TRIPS_KEY, []);
  }
};

const putTrip = async (trip) => {
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(TRIP_STORE).put(trip));
    db.close();
  } catch {
    const trips = await getJson(TRIPS_KEY, []);
    const next = [trip, ...trips.filter((item) => String(item.id) !== String(trip.id))];
    await setJson(TRIPS_KEY, next);
  }
};

const putTrips = async (incomingTrips) => {
  if (!incomingTrips.length) return;
  try {
    const db = await openDb();
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    const store = tx.objectStore(TRIP_STORE);
    incomingTrips.forEach((trip) => store.put(trip));
    await idbTransactionDone(tx);
    db.close();
  } catch {
    const trips = await getJson(TRIPS_KEY, []);
    const incomingIds = new Set(incomingTrips.map((trip) => String(trip.id)));
    const next = [
      ...incomingTrips,
      ...trips.filter((item) => !incomingIds.has(String(item.id))),
    ];
    await setJson(TRIPS_KEY, next);
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

const legacyScoreProvenanceNote = 'Legacy score tagged with the current scoring version on app launch; values were not recalculated.';

const tagLegacyScoreProvenance = (trip, thresholds) => {
  if (!trip || trip.status !== 'completed') return trip;
  if (trip.score_provenance?.scoring_version) return trip;

  const computedAt = trip.updated_at || trip.end_time || trip.created_at || new Date().toISOString();
  return {
    ...trip,
    score_provenance: {
      ...buildScoreProvenance(trip.component_scores || {}, thresholds, computedAt),
      ...(trip.score_provenance && typeof trip.score_provenance === 'object' ? trip.score_provenance : {}),
      scoring_version: SCORING_VERSION,
      computed_at: computedAt,
      migrated_without_rescore: true,
      migration_note: legacyScoreProvenanceNote,
    },
    score_provenance_change: trip.score_provenance_change || {
      previous_scoring_version: null,
      current_scoring_version: SCORING_VERSION,
      reason: 'legacy_tagged_without_rescore',
      changed_constants: [],
      tagged_at: new Date().toISOString(),
    },
  };
};

const tagExistingTripsWithCurrentScoringVersion = async (trips = []) => {
  const thresholds = buildDrivingThresholds(localSettings.get());
  const next = trips.map((trip) => tagLegacyScoreProvenance(trip, thresholds));
  const changed = next.filter((trip, index) => trip !== trips[index]);
  if (changed.length) await putTrips(changed);
  return next;
};

const mergedPhoneUseForTrip = (trip, routePoints, stats, detectionPhoneUse) => {
  return buildPhoneUseFromTripEvidence(trip, routePoints, stats.duration_seconds, detectionPhoneUse);
};

const eventFeedbackKey = (event, index) => [
  event?.type || 'event',
  event?.timestamp || index,
  Number.isFinite(Number(event?.value)) ? Number(event.value).toFixed(2) : '',
].join('|');

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

const rescoreTrip = (trip) => {
  if (!trip || trip.status !== 'completed') return trip;
  const routePoints = restoreOriginalRouteGeometry(trip.route_points || []);
  const settings = localSettings.get();
  const thresholds = buildDrivingThresholds(settings);
  const provenanceStatus = getScoreProvenanceStatus(trip, thresholds);
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
  const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(routePoints, thresholds, trip.end_time);
  const feedbackAdjusted = applyEventFeedbackToEvents(events, trip.event_feedback);
  const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, detectedPhoneUse);
  const scores = calculateTripScores(feedbackAdjusted.events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
  const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
  const drivingEvents = mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || feedbackAdjusted.events, phoneUse);
  const scoreProvenanceChange = provenanceStatus.needsRescore || trip.needs_rescore
    ? {
      previous_scoring_version: trip.score_provenance?.scoring_version ?? null,
      current_scoring_version: scores.score_provenance.scoring_version,
      reason: provenanceStatus.status === 'missing'
        ? 'provenance_added'
        : trip.score_provenance?.scoring_version !== scores.score_provenance.scoring_version
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
    driving_events: drivingEvents,
    ...(scoreProvenanceChange ? { score_provenance_change: scoreProvenanceChange } : {}),
    feedback_adjusted_events_count: feedbackAdjusted.removed,
    needs_rescore: false,
    schema_version: TRIP_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
  };
};

const needsRescore = (trip, thresholds = buildDrivingThresholds(localSettings.get())) => (
  trip?.status === 'completed' &&
  (
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
  const total = trips.filter((trip) => needsRescore(trip, thresholds)).length;
  let completed = 0;
  if (total) emitRescoreProgress({ status: 'running', completed, total });
  for (const trip of trips) {
    if (needsRescore(trip, thresholds)) {
      const rescored = rescoreTrip(trip);
      rescoredTrips.push(rescored);
      next.push(rescored);
      completed += 1;
      emitRescoreProgress({ status: 'running', completed, total });
    } else {
      next.push(trip);
    }
  }
  if (rescoredTrips.length) {
    await putTrips(rescoredTrips);
    emitRescoreProgress({ status: 'complete', completed, total });
  }
  return next;
};

const importNativeCompletedTrips = async () => {
  if (!isAndroid() || importingNativeTrips) return;

  importingNativeTrips = true;
  try {
    const nativeTrips = await getNativeCompletedTrips();
    if (!nativeTrips.length) return;

    for (const trip of nativeTrips) {
      const routePoints = trip.route_points || [];
      const settings = localSettings.get();
      const thresholds = buildDrivingThresholds(settings);
      const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
      const { events, phoneUse: detectedPhoneUse } = detectDrivingEvents(routePoints, thresholds, trip.end_time);
      const phoneUse = mergedPhoneUseForTrip(trip, routePoints, stats, detectedPhoneUse);
      const scores = calculateTripScores(events, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
      const economics = estimateTripEconomics({ ...trip, ...stats, ...scores }, {}, settings);
      const drivingEvents = mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || events, phoneUse);

      const importedTrip = {
        ...trip,
        ...stats,
        ...scores,
        co2_saved_kg: economics.co2_saved_kg,
        route_points: routePoints,
        route_points_raw_count: Number(trip.route_points_raw_count) || routePoints.length,
        route_points_map_count: Number(trip.route_points_map_count) || routePoints.length,
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
    const tx = db.transaction(TRIP_STORE, 'readwrite');
    await idbRequest(tx.objectStore(TRIP_STORE).delete(id));
    db.close();
  } catch {
    const trips = await getJson(TRIPS_KEY, []);
    await setJson(TRIPS_KEY, trips.filter((trip) => String(trip.id) !== String(id)));
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
  id: trip.id || `trip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  ...trip,
  schema_version: trip.schema_version || TRIP_SCHEMA_VERSION,
  updated_at: new Date().toISOString(),
});

export const localTripRepository = {
  async list({ sort = '-start_time', limit = 100 } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    return sortTrips(trips, sort).slice(0, limit);
  },

  async listAll({ sort = '-start_time' } = {}) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    return sortTrips(trips, sort);
  },

  async getById(id) {
    await importNativeCompletedTrips();
    await pruneExpiredTrips();
    const taggedTrips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const trips = await rescoreTripsIfNeeded(taggedTrips);
    const trip = trips.find((item) => String(item.id) === String(id));
    if (!trip) throw new Error('Trip not found');
    return trip;
  },

  async create(trip) {
    const saved = withId({ ...trip, created_at: new Date().toISOString() });
    await putTrip(saved);
    if (saved.status === 'completed') await invalidateTripDerivedCaches();
    await pruneExpiredTrips();
    return saved;
  },

  async update(id, patch) {
    const current = await this.getById(id);
    const updated = withId({ ...current, ...patch, id: current.id });
    await putTrip(updated);
    if (updated.status === 'completed') await invalidateTripDerivedCaches();
    return updated;
  },

  async delete(id) {
    await deleteTrip(id);
    return { success: true };
  },

  async upsertMany(trips = []) {
    const thresholds = buildDrivingThresholds(localSettings.get());
    const normalized = trips.map((trip) => {
      const next = withId({
        ...trip,
        created_at: trip.created_at || trip.start_time || new Date().toISOString(),
      });
      return needsRescore(next, thresholds) ? rescoreTrip(next) : next;
    });
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
    const thresholds = buildDrivingThresholds(localSettings.get());
    const trips = await tagExistingTripsWithCurrentScoringVersion(await getAllTrips());
    const completed = trips.filter((trip) => trip.status === 'completed');
    const mismatched = completed
      .map((trip) => ({ trip, provenance: getScoreProvenanceStatus(trip, thresholds) }))
      .filter(({ provenance }) => provenance.needsRescore);
    return {
      scoring_version: SCORING_VERSION,
      completed_count: completed.length,
      mismatch_count: mismatched.length,
      unavailable_score_count: completed.filter((trip) => trip.score_overall == null).length,
      trips: mismatched.map(({ trip, provenance }) => ({
        id: trip.id,
        start_time: trip.start_time,
        nickname: trip.nickname || '',
        scoring_version: trip.score_provenance?.scoring_version || null,
        status: provenance.status,
        reason: provenance.reason,
        changed_constants: provenance.changedConstants,
      })),
    };
  },
};
