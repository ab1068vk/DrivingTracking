import { registerPlugin } from '@capacitor/core';
import { P35_NATIVE_AUTHORITY_ENABLED } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  LAST_CHECKPOINT_EXPORT_KEY,
  PRIVACY_AUDIT_ANCHOR_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
  AUDIT_FORMAT_KEY,
  beginPrivacyAuditErasure,
  finishPrivacyAuditErasure,
} from '@/lib/hashChainLog';
import {
  KEY_ROTATION_LOG_KEY,
  ROTATING_ENCRYPTED_JSON_KEYS,
} from '@/lib/keyRotationManager';
import {
  DB_NAME_META_KEY,
  DRIVER_SIGNATURE_KEY,
  RAW_GPS_LIFECYCLE_STATE_KEY,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY,
  TRIPS_KEY,
  TRIPS_ERASURE_BARRIER_KEY,
  eraseTripRepositoryForDataRights,
  setNativeErasurePending,
} from '@/lib/localTripRepository';
import { VEHICLES_KEY } from '@/lib/localVehicleRepository';
import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import {
  PRIVACY_POSTURE_SNAPSHOT_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  getPrivacyScoreHistory,
} from '@/lib/privacyIntelligence';
import {
  createPrivacyExportSalt,
  getHydratedPrivacyZones,
  maskTripForPrivacyExport,
  NATIVE_PRIVACY_ZONES_KEY,
  PRIVACY_ZONES_SECURE_KEY,
  ZONE_STATS_KEY,
} from '@/lib/privacyZones';
import { PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY } from '@/lib/privacyZoneSuggestions';
import { RESCORING_QUEUE_KEY } from '@/lib/rescoringQueue';
import { ROAD_CONTEXT_QUEUE_STORAGE_KEY } from '@/lib/roadContextQueue';
import {
  ENCRYPTION_KEY_META_KEY,
  eraseEncryptionKeysForDataRights,
} from '@/lib/securePayloadCrypto';
import {
  eraseSpeedKnowledgeForDataRights,
  SPEED_KNOWLEDGE_STORAGE_KEY,
} from '@/lib/speedKnowledgeRepository';
import {
  ACTIVE_TRIP_KEY,
  LAST_PARKED_KEY,
  LAST_PARKING_STATE_KEY,
  SETTINGS_KEY,
  beginSettingsErasureFence,
  clearSettingsMemoryForErasure,
  endSettingsErasureFence,
  localSettings,
} from '@/lib/trackingStore';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { logSystemFailure } from '@/lib/systemLog';
import { runCanonicalGenerationRollover } from '@/lib/nativeProjectionBarrier';
import { eraseDiagnosticsHistoryForDataRights } from '@/lib/diagnosticsHistoryStore';
import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import { TRANSMISSION_LOG_KEY } from '@/lib/transmissionLog';
import {
  eraseExportSigningKeyForDataRights,
  SIGNING_KEY_ALIAS,
} from '@/lib/exportIntegrity';

export const DATA_RIGHTS_ERASURE_RECEIPT_FORMAT = 'road-sage-erasure-receipt';
export const DATA_RIGHTS_ERASURE_RECEIPT_VERSION = 1;
export const DATA_PORTABILITY_FORMAT = 'road-sage-data-portability';
export const DATA_PORTABILITY_VERSION = 1;

const AuditAnchor = registerPlugin('AuditAnchor');
const clearNativeCompletedTripsForErasure = () => import('@/lib/activityRecognition')
  .then(({ eraseNativeLocalDataForDataRights }) => eraseNativeLocalDataForDataRights());

const extraErasureKeys = Object.freeze([
  TRIPS_KEY,
  SETTINGS_KEY,
  VEHICLES_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
  PRIVACY_AUDIT_ANCHOR_KEY,
  LAST_CHECKPOINT_EXPORT_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  PRIVACY_POSTURE_SNAPSHOT_KEY,
  PRIVACY_ZONES_SECURE_KEY,
  NATIVE_PRIVACY_ZONES_KEY,
  ZONE_STATS_KEY,
  TRANSMISSION_LOG_KEY,
  KEY_ROTATION_LOG_KEY,
  ENCRYPTION_KEY_META_KEY,
  DB_NAME_META_KEY,
  DRIVER_SIGNATURE_KEY,
  RAW_GPS_LIFECYCLE_STATE_KEY,
  TRIP_EVENT_MIGRATION_KEY,
  TRIP_EVENT_MIGRATION_NOTE_DISMISSED_KEY,
  PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY,
  RESCORING_QUEUE_KEY,
  ROAD_CONTEXT_QUEUE_STORAGE_KEY,
  SPEED_KNOWLEDGE_STORAGE_KEY,
  SIGNING_KEY_ALIAS,
  'drivesense_system_logs_v1',
  'drivesense_tracking_diagnostics',
  'drivesense_calibration_profile',
  'drivesense_coach_programs_v1',
  'drivesense_driver_progression_ledger_v1',
  // The segmented XP store's header, conversion checkpoint and bounded
  // progression document. Its `drivesense_progression_xp_seg_v1_*` and
  // `drivesense_progression_xp_head_v1_*` records are retired by the
  // `drivesense_` residual sweep below.
  'drivesense_progression_xp_index_v1',
  'drivesense_progression_xp_migration_v1',
  'drivesense_progression_state_v1',
  'drivesense_parking_learning_v1',
  'drivesense_speed_sign_evidence_v1',
  'drivesense_speed_geometry_index_v1',
  'roadsage_pending_post_drive_review_v1',
  'road_sage_calibration_labels',
  'road_sage_calibration_survey_markers',
  'road_sage_anonymous_install_id',
  'road_sage_trip_filter_presets',
  'drivesense_dismissed_tag_suggestions',
  'drivesense_first_launch_permission_prompted',
  'drivesense_dashboard_score_review_dismissal',
  'drivesense_dashboard_speed_limit_review_dismissal',
  'drivesense_notified_achievements',
  'drivesense_achievement_notification_ids_v1',
  'drivesense_notification_dedupe_v1',
  'drivesense_phone_notif_last_ms',
  'drivesense_heading_drift_notif_last_ms',
  'drivesense_speeding_notif_last_ms',
  'drivesense_fatigue_notif_trip_id',
  'roadsage_active_insight_experiment_v1',
  'roadsage_ignored_unset_speed_sections_v1',
  'roadsage_ignored_trip_speed_review_sections_v1',
  'roadsage_excluded_speed_sections_v1',
  'privacy_intel_v2_banner_dismissed',
  'sidebar_state',
]);

const APP_STORAGE_PREFIXES = Object.freeze([
  'drivesense_',
  'road_sage_',
  'roadsage_',
  'trip_speed_summary_',
]);
const APP_STORAGE_EXACT_KEYS = new Set([
  'privacy_zones_v1',
  'privacy_intel_v2_banner_dismissed',
  'speed_knowledge_v1',
  'sidebar_state',
]);
/**
 * Safety barriers the residual sweep must never remove.
 *
 * The sweep matches on the `drivesense_` prefix, so it would otherwise retire
 * the fallback-erasure barrier as ordinary app storage — while the blob that
 * barrier guards may still exist because its removal failed. Only
 * `eraseTripRepositoryForDataRights` retires it, and only after proving the blob
 * is gone.
 */
const ERASURE_SAFETY_BARRIER_KEYS = new Set([TRIPS_ERASURE_BARRIER_KEY, AUDIT_FORMAT_KEY]);

const isAppStorageKey = (key) => (
  !ERASURE_SAFETY_BARRIER_KEYS.has(String(key)) && (
    APP_STORAGE_EXACT_KEYS.has(String(key)) ||
    APP_STORAGE_PREFIXES.some((prefix) => String(key).startsWith(prefix))
  )
);

const encryptedErasureKeys = new Set([
  ...ROTATING_ENCRYPTED_JSON_KEYS,
  // P4-C-F05 removed the fallback trip archive from the rotating set, because a
  // lifecycle KEK turn must never rewrite it. It is still encrypted, so erasure
  // must still classify it as encrypted storage.
  TRIPS_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  PRIVACY_POSTURE_SNAPSHOT_KEY,
  PRIVACY_ZONES_SECURE_KEY,
  ZONE_STATS_KEY,
  TRANSMISSION_LOG_KEY,
  KEY_ROTATION_LOG_KEY,
  PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY,
  NATIVE_PRIVACY_ZONES_KEY,
]);

const unique = (items = []) => Array.from(new Set(items.filter(Boolean)));

const canonicalStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256hex = async (value) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof TextEncoder === 'undefined') {
    throw new Error('SHA-256 is unavailable in this runtime.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export function getErasureKeyList() {
  return unique([
    ...ROTATING_ENCRYPTED_JSON_KEYS,
    ACTIVE_TRIP_KEY,
    LAST_PARKED_KEY,
    LAST_PARKING_STATE_KEY,
    ...extraErasureKeys,
  ]).map((key) => ({
    key,
    storage: encryptedErasureKeys.has(key)
      ? 'encrypted_json'
      : 'json_or_preferences',
  }));
}

async function overwriteThenRemoveKey(key) {
  const existed = await getJson(key, null).then((value) => value != null).catch(() => false);
  await setJson(key, {
    _secure_delete_tombstone: true,
    _secure_delete_at: Date.now(),
    random_padding: Math.random().toString(36).repeat(128),
  }).catch(() => {});
  await removeJson(key);
  return { key, existed, wiped: true, method: 'overwrite_then_remove' };
}

const browserStorageKeys = (storage) => {
  try {
    if (!storage) return [];
    return Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean);
  } catch {
    return [];
  }
};

async function removeResidualAppStorage() {
  const candidates = [
    ...browserStorageKeys(globalThis.localStorage),
  ];
  if (isNativePlatform()) {
    const { Preferences } = await import('@capacitor/preferences');
    const nativeKeys = await Preferences.keys();
    candidates.push(...(nativeKeys?.keys || []));
  }
  const keys = unique(candidates).filter(isAppStorageKey);
  for (const key of keys) await removeJson(key);

  const sessionKeys = browserStorageKeys(globalThis.sessionStorage)
    .filter((key) => key === 'token' || key === 'access_token');
  sessionKeys.forEach((key) => {
    try {
      globalThis.sessionStorage.removeItem(key);
    } catch {
      // Session storage may be unavailable in hardened browser contexts.
    }
  });
  return { keysRemoved: keys, sessionKeysRemoved: sessionKeys };
}

async function signErasureReceiptPayload(payload) {
  const payloadHash = await sha256hex(canonicalStringify(payload));
  if (!isNativePlatform()) {
    return {
      signatureStatus: 'unsigned',
      payloadHash,
      signature: null,
      signing_pubkey: null,
      signer: 'web-runtime-unavailable',
    };
  }
  try {
    const signed = await AuditAnchor.signTipHash({ tipHash: payloadHash });
    return {
      signatureStatus: signed?.signature && signed?.publicKey ? 'signed' : 'unsigned',
      payloadHash,
      signature: signed?.signature || null,
      signing_pubkey: signed?.publicKey || null,
      signer: signed?.signature ? 'AuditAnchor.signTipHash' : 'native-signature-unavailable',
    };
  } catch {
    return {
      signatureStatus: 'unsigned',
      payloadHash,
      signature: null,
      signing_pubkey: null,
      signer: 'native-signature-unavailable',
    };
  }
}

export function validatePortabilityExport(bundle = {}) {
  const errors = [];
  if (bundle.format !== DATA_PORTABILITY_FORMAT) errors.push('format');
  if (Number(bundle.version) !== DATA_PORTABILITY_VERSION) errors.push('version');
  if (!Array.isArray(bundle.trips)) errors.push('trips');
  if (!bundle.settings || typeof bundle.settings !== 'object' || Array.isArray(bundle.settings)) errors.push('settings');
  if (!Array.isArray(bundle.privacyZones)) errors.push('privacyZones');
  if (!Array.isArray(bundle.scoreHistory)) errors.push('scoreHistory');
  if (!bundle.generatedAt) errors.push('generatedAt');
  return {
    valid: errors.length === 0,
    errors,
    schema: `${DATA_PORTABILITY_FORMAT}_v${DATA_PORTABILITY_VERSION}`,
  };
}

const privacyZonePortabilityPlaceholders = (zones = []) => (
  (Array.isArray(zones) ? zones : []).map((zone) => ({
    id: zone?.id || null,
    label: zone?.label || 'Private place',
    type: zone?.type === 'corridor' ? 'corridor' : 'circle',
    sensitivity: zone?.sensitivity === 'high' ? 'high' : 'standard',
    ...(zone?.expiresAt ? { expiresAt: zone.expiresAt } : {}),
    masked_for_privacy: true,
  }))
);

/**
 * @param {Record<string, any>} settings
 * @param {any[]} zones
 */
const privacySafeSettingsForPortability = (settings = {}, zones = []) => {
  const safe = { ...(settings || {}) };
  delete safe.last_map_center;
  safe.privacy_zones = privacyZonePortabilityPlaceholders(zones);
  return safe;
};

/**
 * Mask every trip for the portability bundle, one trip at a time.
 *
 * The bundle is a single JSON file, so its masked trips are unavoidably
 * materialized — but reading them is not. This pages trip ids and loads one
 * complete trip at a time, masking it immediately and releasing the original,
 * instead of holding the whole decrypted archive alongside its masked copy.
 */
async function collectPortabilityTrips({ trips, privacySettings, privacyExportSalt, signal = null }) {
  if (Array.isArray(trips)) {
    return trips.map((trip) => maskTripForPrivacyExport(trip, privacySettings, privacyExportSalt));
  }
  const { runBoundedTripJob, clearBoundedJobCheckpoint } = await import('@/lib/boundedTripJob');
  const masked = [];
  const jobKey = 'data_portability_export';
  const outcome = await runBoundedTripJob({
    jobKey,
    fingerprint: 'portability-v1',
    status: '',
    loadFullTrip: true,
    signal,
    resume: false,
    initialState: () => ({}),
    onTrip: ({ trip }) => {
      masked.push(maskTripForPrivacyExport(trip, privacySettings, privacyExportSalt));
    },
  });
  if (outcome.completed) await clearBoundedJobCheckpoint(jobKey);
  return masked;
}

export async function buildDataPortabilityExport({
  trips = null,
  vehicles = null,
  settings = null,
  privacyZones = null,
  scoreHistory = null,
  signal = null,
} = {}) {
  const resolvedSettings = settings || localSettings.get();
  const resolvedPrivacyZones = Array.isArray(privacyZones)
    ? privacyZones
    : await getHydratedPrivacyZones(resolvedSettings).catch(() => []);
  const privacyExportSalt = createPrivacyExportSalt();
  const privacySettings = {
    ...resolvedSettings,
    privacy_zones: resolvedPrivacyZones,
  };
  const bundle = {
    format: DATA_PORTABILITY_FORMAT,
    version: DATA_PORTABILITY_VERSION,
    schema: {
      trips: 'Array of the user-owned stored trip records after privacy-zone export masking.',
      vehicles: 'Array of locally stored vehicle records.',
      settings: 'Road Sage local settings at export time, with coordinate-bearing privacy fields removed.',
      privacyZones: 'Configured privacy-zone placeholders with exact geometry and cell hashes removed.',
      scoreHistory: 'Privacy Intelligence score-history entries.',
    },
    generatedAt: new Date().toISOString(),
    trips: await collectPortabilityTrips({ trips, privacySettings, privacyExportSalt, signal }),
    // HPR-003. A bundle that calls itself the user's data may not stop at a
    // silent cap: the fleet is read as bounded turns to its terminal page, and
    // retired profiles are included so historical trip attribution stays
    // resolvable in the artifact.
    vehicles: Array.isArray(vehicles)
      ? vehicles
      : [...await vehicleService.listAllVehiclesForExport(), ...await vehicleService.listRetired()],
    settings: privacySafeSettingsForPortability(resolvedSettings, resolvedPrivacyZones),
    privacyZones: privacyZonePortabilityPlaceholders(resolvedPrivacyZones),
    scoreHistory: Array.isArray(scoreHistory) ? scoreHistory : await getPrivacyScoreHistory(),
  };
  const validation = validatePortabilityExport(bundle);
  if (!validation.valid) {
    throw new Error(`Portability export schema invalid: ${validation.errors.join(', ')}`);
  }
  return bundle;
}

export async function downloadJsonFile(
  filename,
  payload,
  mimeType = 'application/json',
  { logNativeFailure = true } = {}
) {
  const data = `${JSON.stringify(payload)}\n`;
  try {
    if (isNativePlatform()) {
      const result = await saveExportToDownloads({ filename, data, mimeType });
      return { native: true, filename, uri: result.uri };
    }
  } catch (error) {
    if (logNativeFailure) {
      logSystemFailure('privacy_export_native_save_failed', error, {
        filename,
        native_fallback: true,
      });
    }
    // Browser fallback below keeps export available even if native file saving fails.
  }
  const blob = new Blob([data], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { native: false, filename };
}

export async function exportDataPortabilityBundle(options = {}) {
  try {
    const bundle = await buildDataPortabilityExport(options);
    const filename = `road-sage-data-portability-${new Date().toISOString().slice(0, 10)}.json`;
    return {
      bundle,
      ...(await downloadJsonFile(filename, bundle)),
    };
  } catch (error) {
    logSystemFailure('data_portability_export_failed', error, {});
    throw error;
  }
}

const reportErasureProgress = (onProgress, progress) => {
  try {
    onProgress?.(progress);
  } catch {
    // Progress reporting must never interrupt a destructive operation.
  }
};

export async function eraseAllLocalDataAndBuildReceipt({ now = Date.now(), onProgress } = {}) {
  // Declared before the try so the finally can release exactly this erasure's ownership,
  // even if the fence was never acquired.
  let fenceToken = null;
  try {
    const startedAt = new Date(now).toISOString();
    // AUD-004 round 2: the fence goes up BEFORE anything destructive, and comes down only
    // after the residue proof below. A native settings write dispatched before the erasure
    // could otherwise settle between the removal and the memory clear, see its own
    // generation as current, and republish the settings that were just erased.
    fenceToken = beginSettingsErasureFence();
    const keyList = getErasureKeyList();
    const totalSteps = keyList.length + 10;
    reportErasureProgress(onProgress, { phase: 'trips', completed: 0, total: totalSteps });
    // The barrier must be durably established BEFORE destructive erasure, and
    // its failure must propagate: it is what stops a queued native completion
    // repopulating the repository we are about to empty. One bounded global
    // record guards the whole erase, so a 10,000-trip erasure never creates
    // 10,000 suppression ids for a journal that holds at most 64.
    if (isAndroid()) await setNativeErasurePending(true);
    // Existing erasure authority first; the audit owner then fences all queued
    // appends/conversion before its local state is removed. No native DB lock
    // is held while waiting for this explicit owner lock.
    const auditErasureToken = await beginPrivacyAuditErasure();
    // Native authority never replaces the legacy/projection cleanup obligation:
    // both domains can retain sensitive historical identity.  The canonical
    // generation rollover is fail-closed and must complete before key erasure.
    // P4-B-F02: the rollover runs inside the projection commit barrier, so an
    // in-flight G1 projection turn can neither interleave with it nor leave G1
    // rows/checkpoint behind once it verifies. Erasure ownership is unchanged.
    const nativeTripRepository = isAndroid() && P35_NATIVE_AUTHORITY_ENABLED
      ? await runCanonicalGenerationRollover(
        () => nativeTripArchive.eraseGeneration('data_rights_erasure'),
        { reason: 'data_rights_erasure' }
      )
      : null;
    if (nativeTripRepository?.verified === true) {
      // Scheduling-observer notification only. Per-turn token revalidation is
      // the mandatory guarantee (C14), so a failure here must never fail an
      // erasure whose canonical generation rollover already verified.
      try {
        const { notifyP4CanonicalAuthorityChanged } = await import('@/lib/appLifecycleWork');
        notifyP4CanonicalAuthorityChanged('data_rights_generation_erased');
      } catch (cause) {
        logSystemFailure('p4_authority_invalidation_after_data_rights_erase', cause);
      }
    }
    const legacyTripRepository = await eraseTripRepositoryForDataRights();
    const tripRepository = {
      ...legacyTripRepository,
      nativeCanonical: nativeTripRepository,
      verified: legacyTripRepository.verified === true
        && (!isAndroid() || !P35_NATIVE_AUTHORITY_ENABLED || nativeTripRepository?.verified === true),
    };
    reportErasureProgress(onProgress, { phase: 'trips', completed: 1, total: totalSteps });
    const nativeSpeedKnowledge = isAndroid() && P35_NATIVE_AUTHORITY_ENABLED
      ? await nativeTripArchive.eraseSpeedGeneration('data_rights_erasure')
      : null;
    const legacySpeedKnowledge = await eraseSpeedKnowledgeForDataRights();
    const speedKnowledge = {
      ...legacySpeedKnowledge,
      nativeCanonical: nativeSpeedKnowledge,
      verified: legacySpeedKnowledge.indexedDbDeleted === true
        && legacySpeedKnowledge.fallbackRemoved === true
        && legacySpeedKnowledge.writeAheadRemoved === true
        && legacySpeedKnowledge.nativeMirrorRemoved === true
        && (!isAndroid() || !P35_NATIVE_AUTHORITY_ENABLED || nativeSpeedKnowledge?.verified === true),
    };
    reportErasureProgress(onProgress, { phase: 'speed_knowledge', completed: 2, total: totalSteps });
    await browserActiveTripSpool.eraseAllForDataRights();
    const browserActiveSpoolsCleared = true;
    const nativeCompletedTripsCleared = isAndroid()
      ? await clearNativeCompletedTripsForErasure().then(() => true).catch((error) => {
        logSystemFailure('data_erasure_native_trip_clear_failed', error, {});
        return false;
      })
      : false;
    // Cleared only after native storage is verified cleared. If the clear failed
    // the pending state survives, native imports stay suppressed, restart
    // retries, and the receipt reports the erase as incomplete.
    if (isAndroid() && nativeCompletedTripsCleared) {
      await setNativeErasurePending(false).catch(() => undefined);
    }
    reportErasureProgress(onProgress, { phase: 'native_data', completed: 3, total: totalSteps });
    const exportSigningKeys = await eraseExportSigningKeyForDataRights();
    reportErasureProgress(onProgress, { phase: 'signing_keys', completed: 4, total: totalSteps });
    const encryptionKeys = await eraseEncryptionKeysForDataRights();
    reportErasureProgress(onProgress, { phase: 'encryption_keys', completed: 5, total: totalSteps });
    const diagnosticsStorage = await eraseDiagnosticsHistoryForDataRights();
    reportErasureProgress(onProgress, { phase: 'diagnostics_storage', completed: 6, total: totalSteps });
    const wipedKeys = [];
    for (let index = 0; index < keyList.length; index += 1) {
      const item = keyList[index];
      wipedKeys.push(await overwriteThenRemoveKey(item.key));
      reportErasureProgress(onProgress, {
        phase: 'local_keys',
        completed: 7 + index,
        total: totalSteps,
      });
    }
    const residualStorage = await removeResidualAppStorage();
    reportErasureProgress(onProgress, {
      phase: 'residual_storage',
      completed: keyList.length + 7,
      total: totalSteps,
    });
    clearSettingsMemoryForErasure();
    reportErasureProgress(onProgress, {
      phase: 'memory',
      completed: keyList.length + 8,
      total: totalSteps,
    });

    const payload = {
      format: DATA_RIGHTS_ERASURE_RECEIPT_FORMAT,
      version: DATA_RIGHTS_ERASURE_RECEIPT_VERSION,
      startedAt,
      completedAt: new Date().toISOString(),
      erasedKeys: keyList,
      wipedKeys,
      tripRepository,
      speedKnowledge,
      nativeCompletedTripsCleared,
      browserActiveSpoolsCleared,
      nativeLocalDataCleared: nativeCompletedTripsCleared,
      // Never report durable eradication while known recoverable data can still
      // repopulate the repository. The native journal is one such source; the
      // repository's own stores and the fallback blob are others, and a receipt
      // that reads only the native result would sign off on an erase that left
      // trips, legacy summaries, orphan projections or the fallback blob behind.
      erasureComplete: tripRepository.verified === true
        && speedKnowledge.verified === true
        && browserActiveSpoolsCleared
        && (!isAndroid() || nativeCompletedTripsCleared),
      pendingNativeCleanup: isAndroid() && !nativeCompletedTripsCleared,
      pendingRepositoryCleanup: tripRepository.verified !== true,
      pendingSpeedKnowledgeCleanup: speedKnowledge.verified !== true,
      repositoryErasureFailures: tripRepository.failures ?? [],
      residualStorage,
      exportSigningKeys,
      encryptionKeys,
      diagnosticsStorage,
      limitation: 'This receipt records Road Sage app-level overwrite/remove operations. A rooted device, compromised app bundle, browser cache, OS backup, or storage wear-leveling can remain outside what the app can verify from inside itself.',
    };
    if (payload.erasureComplete) await finishPrivacyAuditErasure(auditErasureToken);
    // Failure/partial erasure leaves ERASING durable. No fresh log is created
    // merely because its rows were cleared before another owner failed.
    reportErasureProgress(onProgress, {
      phase: 'signing',
      completed: keyList.length + 9,
      total: totalSteps,
    });
    const signature = await signErasureReceiptPayload(payload);
    if (isAndroid() && nativeTripRepository?.verified === true) {
      try {
        const { admitP5ReviewedWork, P5_LIFECYCLE_JOB_KEYS } = await import('@/lib/appLifecycleWork');
        admitP5ReviewedWork(P5_LIFECYCLE_JOB_KEYS.ARCHIVE_RESIDUE_GC, {
          wake: { type: 'canonical_health', key: 'healthy' },
        });
      } catch (cause) {
        logSystemFailure('p5_residue_admission_after_data_rights_erase', cause);
      }
    }
    reportErasureProgress(onProgress, {
      phase: 'signing',
      completed: totalSteps - 1,
      total: totalSteps,
    });
    return {
      ...payload,
      signature,
    };
  } catch (error) {
    logSystemFailure('data_erasure_failed', error, {
      key_count: getErasureKeyList().length,
    });
    throw error;
  } finally {
    // Lowered only here, and only THIS erasure's ownership: the fence has to outlive the
    // residue proof, it must come down even when erasure fails, and an overlapping
    // erasure's ownership is not ours to release.
    if (fenceToken !== null) endSettingsErasureFence(fenceToken);
  }
}

export async function eraseAllLocalDataAndDownloadReceipt(options = {}) {
  const receipt = await eraseAllLocalDataAndBuildReceipt(options);
  const totalSteps = getErasureKeyList().length + 11;
  const filename = `road-sage-erasure-receipt-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  try {
    reportErasureProgress(options.onProgress, {
      phase: 'saving_receipt',
      completed: totalSteps - 1,
      total: totalSteps,
    });
    const result = {
      receipt,
      ...(await downloadJsonFile(filename, receipt, 'application/json', { logNativeFailure: false })),
    };
    reportErasureProgress(options.onProgress, {
      phase: 'saving_receipt',
      completed: totalSteps,
      total: totalSteps,
    });
    return result;
  } catch (error) {
    const receiptError = error instanceof Error
      ? error
      : new Error('Local data was erased, but the erasure receipt could not be saved.');
    Object.assign(receiptError, {
      dataErased: true,
      receiptFilename: filename,
    });
    throw receiptError;
  }
}
