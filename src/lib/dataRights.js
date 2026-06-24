import { registerPlugin } from '@capacitor/core';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import {
  LAST_CHECKPOINT_EXPORT_KEY,
  PRIVACY_AUDIT_ANCHOR_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
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
  eraseTripRepositoryForDataRights,
} from '@/lib/localTripRepository';
import { VEHICLES_KEY } from '@/lib/localVehicleRepository';
import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isAndroid, isNativePlatform } from '@/lib/nativePlatform';
import {
  PRIVACY_POSTURE_SNAPSHOT_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  getPrivacyScoreHistory,
} from '@/lib/privacyIntelligence';
import { getHydratedPrivacyZones } from '@/lib/privacyZones';
import { PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY } from '@/lib/privacyZoneSuggestions';
import { RESCORING_QUEUE_KEY } from '@/lib/rescoringQueue';
import { ROAD_CONTEXT_QUEUE_STORAGE_KEY } from '@/lib/roadContextQueue';
import { ENCRYPTION_KEY_META_KEY } from '@/lib/securePayloadCrypto';
import {
  ACTIVE_TRIP_KEY,
  LAST_PARKED_KEY,
  SETTINGS_KEY,
  clearSettingsMemoryForErasure,
  localSettings,
} from '@/lib/trackingStore';
import { clearNativeCompletedTrips } from '@/lib/activityRecognition';
import { saveExportToDownloads } from '@/lib/nativeDownloads';
import { logSystemFailure } from '@/lib/systemLog';

export const DATA_RIGHTS_ERASURE_RECEIPT_FORMAT = 'road-sage-erasure-receipt';
export const DATA_RIGHTS_ERASURE_RECEIPT_VERSION = 1;
export const DATA_PORTABILITY_FORMAT = 'road-sage-data-portability';
export const DATA_PORTABILITY_VERSION = 1;

const AuditAnchor = registerPlugin('AuditAnchor');

const extraErasureKeys = Object.freeze([
  TRIPS_KEY,
  SETTINGS_KEY,
  VEHICLES_KEY,
  PRIVACY_AUDIT_CHAIN_KEY,
  PRIVACY_AUDIT_ANCHOR_KEY,
  LAST_CHECKPOINT_EXPORT_KEY,
  PRIVACY_SCORE_HISTORY_KEY,
  PRIVACY_POSTURE_SNAPSHOT_KEY,
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
    ...extraErasureKeys,
  ]).map((key) => ({
    key,
    storage: ROTATING_ENCRYPTED_JSON_KEYS.includes(key) ||
      key === PRIVACY_SCORE_HISTORY_KEY ||
      key === PRIVACY_POSTURE_SNAPSHOT_KEY ||
      key === KEY_ROTATION_LOG_KEY ||
      key === PRIVACY_ZONE_SUGGESTION_DISMISSALS_KEY
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

export async function buildDataPortabilityExport({
  trips = null,
  vehicles = null,
  settings = null,
  privacyZones = null,
  scoreHistory = null,
} = {}) {
  const resolvedSettings = settings || localSettings.get();
  const bundle = {
    format: DATA_PORTABILITY_FORMAT,
    version: DATA_PORTABILITY_VERSION,
    schema: {
      trips: 'Array of the user-owned stored trip records, including route points/events as retained locally.',
      vehicles: 'Array of locally stored vehicle records.',
      settings: 'Road Sage local settings at export time.',
      privacyZones: 'Configured privacy zones hydrated from secure local storage.',
      scoreHistory: 'Privacy Intelligence score-history entries.',
    },
    generatedAt: new Date().toISOString(),
    trips: Array.isArray(trips) ? trips : await tripService.listAll({ sort: '-start_time' }),
    vehicles: Array.isArray(vehicles) ? vehicles : await vehicleService.list({ sort: '-created_date', limit: 1000 }),
    settings: resolvedSettings,
    privacyZones: Array.isArray(privacyZones)
      ? privacyZones
      : await getHydratedPrivacyZones(resolvedSettings).catch(() => []),
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
  const data = `${JSON.stringify(payload, null, 2)}\n`;
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

export async function exportDataPortabilityBundle() {
  try {
    const bundle = await buildDataPortabilityExport();
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

export async function eraseAllLocalDataAndBuildReceipt({ now = Date.now() } = {}) {
  try {
    const startedAt = new Date(now).toISOString();
    const keyList = getErasureKeyList();
    const tripRepository = await eraseTripRepositoryForDataRights();
    const wipedKeys = [];
    for (const item of keyList) {
      wipedKeys.push(await overwriteThenRemoveKey(item.key));
    }
    const nativeCompletedTripsCleared = isAndroid()
      ? await clearNativeCompletedTrips().then(() => true).catch((error) => {
        logSystemFailure('data_erasure_native_trip_clear_failed', error, {});
        return false;
      })
      : false;
    clearSettingsMemoryForErasure();

    const payload = {
      format: DATA_RIGHTS_ERASURE_RECEIPT_FORMAT,
      version: DATA_RIGHTS_ERASURE_RECEIPT_VERSION,
      startedAt,
      completedAt: new Date().toISOString(),
      erasedKeys: keyList,
      wipedKeys,
      tripRepository,
      nativeCompletedTripsCleared,
      limitation: 'This receipt records Road Sage app-level overwrite/remove operations. A rooted device, compromised app bundle, browser cache, OS backup, or storage wear-leveling can remain outside what the app can verify from inside itself.',
    };
    const signature = await signErasureReceiptPayload(payload);
    return {
      ...payload,
      signature,
    };
  } catch (error) {
    logSystemFailure('data_erasure_failed', error, {
      key_count: getErasureKeyList().length,
    });
    throw error;
  }
}

export async function eraseAllLocalDataAndDownloadReceipt() {
  const receipt = await eraseAllLocalDataAndBuildReceipt();
  const filename = `road-sage-erasure-receipt-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
  try {
    return {
      receipt,
      ...(await downloadJsonFile(filename, receipt, 'application/json', { logNativeFailure: false })),
    };
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
