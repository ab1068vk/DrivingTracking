import { getJson, setJson } from '@/lib/mobileStorage';
import {
  deleteEncryptionKeyVersion,
  ENCRYPTION_KEY_META_KEY,
  ensureEncryptionKeyVersion,
  getActiveEncryptionKeyVersion,
  getEncryptedJson,
  rotateEncryptedJsonKey,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { inspectStoredTripKeyVersions } from '@/lib/localTripRepository';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const KEY_ROTATION_DAYS = 30;
export const KEY_ROTATION_MS = KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
export const ROTATING_ENCRYPTED_JSON_KEYS = [
  'drivesense_active_trip',
  'drivesense_danger_zones',
  'drivesense_last_parked',
  'drivesense_last_parking_state',
  'drivesense_parking_history_v1',
  'drivesense_parking_vehicle_states_v1',
  'drivesense_map_matching_cache_v2',
  'drivesense_open_meteo_weather_cache_v1',
  'drivesense_osm_speed_limit_cache_v2',
  'drivesense_speed_sign_evidence_v1',
  'drivesense_speed_geometry_index_v1',
  'drivesense_privacy_zone_stats_v1',
  'drivesense_privacy_zones_config_v1',
  'drivesense_route_risk_index',
  'drivesense_transmission_log_v1',
];
export const KEY_ROTATION_LOG_KEY = 'drivesense_key_rotation_log_v1';

let rotationPromise = null;

const initialMeta = (now) => ({
  version: 1,
  lastRotated: now,
});

async function rotate(now) {
  let meta = await getJson(ENCRYPTION_KEY_META_KEY, null);
  if (!meta) {
    meta = initialMeta(now);
    await ensureEncryptionKeyVersion(meta.version);
    await setJson(ENCRYPTION_KEY_META_KEY, meta);
    return { rotated: false, initialized: true, version: meta.version };
  }

  const currentVersion = Math.max(1, Number(meta.version) || 1);
  const lastRotated = Number(meta.lastRotated) || 0;
  const pendingVersion = Math.max(0, Number(meta.pendingVersion) || 0);
  if (!pendingVersion && now - lastRotated < KEY_ROTATION_MS) {
    return { rotated: false, version: currentVersion };
  }

  const nextVersion = pendingVersion || currentVersion + 1;
  await ensureEncryptionKeyVersion(nextVersion);
  if (!pendingVersion) {
    meta = {
      ...meta,
      version: currentVersion,
      pendingVersion: nextVersion,
      rotationStartedAt: now,
    };
    await setJson(ENCRYPTION_KEY_META_KEY, meta);
  }

  const { rotateTripEncryptionKey } = await import('@/lib/localTripRepository');
  const startedAt = Number(meta.rotationStartedAt) || now;
  const result = await rotateTripEncryptionKey(nextVersion);
  let encryptedJsonValuesRotated = 0;
  for (const key of ROTATING_ENCRYPTED_JSON_KEYS) {
    if (await rotateEncryptedJsonKey(key, nextVersion)) {
      encryptedJsonValuesRotated += 1;
    }
  }

  await deleteEncryptionKeyVersion(currentVersion);
  await setJson(ENCRYPTION_KEY_META_KEY, {
    version: nextVersion,
    lastRotated: now,
  });
  await appendRotationLog({
    fromVersion: currentVersion,
    toVersion: nextVersion,
    startedAt,
    completedAt: Date.now(),
    recordsReencrypted: result.indexedDbRecordsRotated + encryptedJsonValuesRotated,
    status: 'ok',
  });

  recordSystemEvent('encryption_key_rotated', {
    previous_version: currentVersion,
    current_version: nextVersion,
    indexeddb_record_count: result.indexedDbRecordsRotated,
    fallback_store_rotated: result.fallbackStoreRotated,
    encrypted_json_value_count: encryptedJsonValuesRotated,
  }, {
    category: 'privacy',
    title: 'Encryption key rotated',
  });

  return {
    rotated: true,
    previousVersion: currentVersion,
    version: nextVersion,
    encryptedJsonValuesRotated,
    ...result,
  };
}

export function checkAndRotateEncryptionKey({ now = Date.now() } = {}) {
  if (!rotationPromise) {
    rotationPromise = rotate(now)
      .catch((error) => {
        void appendRotationLog({
          startedAt: now,
          completedAt: Date.now(),
          status: 'error',
          error: error?.message || 'Unknown key rotation error',
        });
        logSystemFailure('encryption_key_rotation', error, {
          rotation_interval_days: KEY_ROTATION_DAYS,
        });
        throw error;
      })
      .finally(() => {
        rotationPromise = null;
      });
  }
  return rotationPromise;
}

async function appendRotationLog(entry) {
  const log = await loadRotationLog();
  await setEncryptedJson(KEY_ROTATION_LOG_KEY, [...log, entry].slice(-20));
}

export async function loadRotationLog() {
  try {
    const log = await getEncryptedJson(KEY_ROTATION_LOG_KEY, []);
    return Array.isArray(log) ? log.slice(-20) : [];
  } catch {
    return [];
  }
}

export async function getKeyRotationStatus() {
  const [versions, rotationLog, activeKeyVersion] = await Promise.all([
    inspectStoredTripKeyVersions(),
    loadRotationLog(),
    getActiveEncryptionKeyVersion(),
  ]);
  const lastRotation = rotationLog.at(-1) || null;
  const rotationErrors = rotationLog.filter((entry) => entry.status === 'error');

  if (!versions.length) {
    return {
      status: lastRotation?.status === 'error' ? 'error' : 'unknown',
      evidence: lastRotation?.status === 'error'
        ? `Latest key rotation failed: ${lastRotation.error || 'unknown error'}`
        : 'No encrypted trip records were available to inspect',
      activeKeyVersion,
      oldestPayloadKeyVersion: null,
      newestPayloadKeyVersion: null,
      payloadsPendingRotation: 0,
      lastRotationAt: lastRotation?.completedAt || null,
      rotationErrors: rotationErrors.length,
    };
  }

  const oldestPayloadKeyVersion = Math.min(...versions);
  const newestPayloadKeyVersion = Math.max(...versions);
  const payloadsPendingRotation = versions.filter((version) => version < activeKeyVersion).length;
  const status = rotationErrors.length
    ? 'error'
    : payloadsPendingRotation
      ? 'warn'
      : lastRotation
        ? 'ok'
        : 'unknown';

  return {
    status,
    activeKeyVersion,
    oldestPayloadKeyVersion,
    newestPayloadKeyVersion,
    payloadsPendingRotation,
    lastRotationAt: lastRotation?.completedAt || null,
    rotationErrors: rotationErrors.length,
    evidence: rotationErrors.length
      ? `${rotationErrors.length} recorded key rotation failure(s)`
      : payloadsPendingRotation
        ? `${payloadsPendingRotation} payload(s) still use key v${oldestPayloadKeyVersion}; active key is v${activeKeyVersion}`
        : `All ${versions.length} inspected payloads use active key v${activeKeyVersion}`,
  };
}
