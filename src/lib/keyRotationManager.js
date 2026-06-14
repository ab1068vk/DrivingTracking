import { getJson, setJson } from '@/lib/mobileStorage';
import {
  deleteEncryptionKeyVersion,
  ENCRYPTION_KEY_META_KEY,
  ensureEncryptionKeyVersion,
  rotateEncryptedJsonKey,
} from '@/lib/securePayloadCrypto';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

export const KEY_ROTATION_DAYS = 30;
export const KEY_ROTATION_MS = KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
const ROTATING_ENCRYPTED_JSON_KEYS = [
  'drivesense_active_trip',
  'drivesense_last_parked',
  'drivesense_privacy_zone_stats_v1',
  'drivesense_privacy_zones_config_v1',
  'drivesense_transmission_log_v1',
];

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
