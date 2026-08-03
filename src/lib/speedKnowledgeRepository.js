import { getJson, setJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  getEncryptedJson,
  isEncryptedPayload,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { decorateRoadMemoryCandidates } from '@/lib/roadMemoryIntelligence';
import {
  MAX_SAVED_SPEED_LIMIT_KMH,
  speedKnowledgeCellConfidence,
  speedKnowledgeCellEligibility,
} from '@/lib/speedKnowledgeCellPolicy';

export const SPEED_KNOWLEDGE_STORAGE_KEY = 'speed_knowledge_v1';
export const SPEED_KNOWLEDGE_DB_NAME = 'drivesense_speed_knowledge';
export const SPEED_KNOWLEDGE_DB_VERSION = 1;
export const SPEED_KNOWLEDGE_SCHEMA_VERSION = 2;
export const SPEED_KNOWLEDGE_WRITE_AHEAD_KEY = 'speed_knowledge_v1_write_ahead';
export const SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY = 'speed_knowledge_native_mirror_v1';
export const SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY =
  'speed_knowledge_native_mirror_initialized_v1';
const SPEED_KNOWLEDGE_STORE = 'knowledge';

const indexedDbEncryptionContext = (key) => (
  `indexeddb:${SPEED_KNOWLEDGE_DB_NAME}/${SPEED_KNOWLEDGE_STORE}:${key}`
);

const mutationTails = new Map();

const normalizedRevision = (value) => {
  const revision = Number(value?.knowledgeRevision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
};

export const normalizeSpeedKnowledgeMetadata = (value, {
  previous = null,
  increment = false,
  updatedAt = null,
} = {}) => {
  const next = value && typeof value === 'object' ? value : {};
  const revision = Math.max(normalizedRevision(next), normalizedRevision(previous)) +
    (increment ? 1 : 0);
  const existingUpdatedAt = String(next.knowledgeUpdatedAt || '').trim();
  return {
    ...next,
    schemaVersion: SPEED_KNOWLEDGE_SCHEMA_VERSION,
    knowledgeRevision: revision,
    knowledgeUpdatedAt: updatedAt || existingUpdatedAt || null,
  };
};

export const speedKnowledgeMetadata = (value) => {
  const normalized = normalizeSpeedKnowledgeMetadata(value);
  return {
    schemaVersion: normalized.schemaVersion,
    knowledgeRevision: normalized.knowledgeRevision,
    knowledgeUpdatedAt: normalized.knowledgeUpdatedAt,
  };
};

export const runSpeedKnowledgeStoreExclusive = (key, operation) => {
  const queueKey = String(key || SPEED_KNOWLEDGE_STORAGE_KEY);
  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request(`drivesense:${queueKey}`, { mode: 'exclusive' }, operation);
  }
  const previousTail = mutationTails.get(queueKey) || Promise.resolve();
  const result = previousTail.catch(() => {}).then(operation);
  const nextTail = result.catch(() => {});
  mutationTails.set(queueKey, nextTail);
  return result.finally(() => {
    if (mutationTails.get(queueKey) === nextTail) mutationTails.delete(queueKey);
  });
};

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error);
});

const openDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb()) {
    reject(new Error('IndexedDB unavailable'));
    return;
  }
  const request = indexedDB.open(SPEED_KNOWLEDGE_DB_NAME, SPEED_KNOWLEDGE_DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(SPEED_KNOWLEDGE_STORE)) {
      request.result.createObjectStore(SPEED_KNOWLEDGE_STORE, { keyPath: 'key' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const deleteDb = () => new Promise((resolve, reject) => {
  if (!canUseIndexedDb() || typeof indexedDB.deleteDatabase !== 'function') {
    resolve(false);
    return;
  }

  const request = indexedDB.deleteDatabase(SPEED_KNOWLEDGE_DB_NAME);
  request.onsuccess = () => resolve(true);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error(`IndexedDB delete blocked for ${SPEED_KNOWLEDGE_DB_NAME}`));
});

const readIndexedDb = async (key) => {
  const db = await openDb();
  let storedValue = null;
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readonly');
    const record = await requestResult(transaction.objectStore(SPEED_KNOWLEDGE_STORE).get(key));
    storedValue = record?.value ?? null;
  } finally {
    db.close();
  }
  if (storedValue == null) return null;
  if (isEncryptedPayload(storedValue)) {
    return decryptSensitiveValue(storedValue, indexedDbEncryptionContext(key));
  }
  // One-time migration for repositories created before saved-road geometry
  // was encrypted. Rewriting happens only after the plaintext value is safely
  // loaded, so a crypto failure cannot destroy the recoverable legacy record.
  await writeIndexedDb(key, storedValue);
  recordSystemEvent('speed_knowledge_at_rest_migrated', {
    store: 'indexeddb',
  }, {
    category: 'storage',
    title: 'Saved road speeds encrypted',
  });
  return storedValue;
};

const writeIndexedDb = async (key, value) => {
  const encryptedValue = await encryptSensitiveValue(value, indexedDbEncryptionContext(key));
  const db = await openDb();
  try {
    const transaction = db.transaction(SPEED_KNOWLEDGE_STORE, 'readwrite');
    transaction.objectStore(SPEED_KNOWLEDGE_STORE).put({
      key,
      value: encryptedValue,
      updatedAt: new Date().toISOString(),
    });
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};

let migrationPromise = null;

const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

const cellBounds = (geohash) => {
  const hash = String(geohash || '').toLowerCase();
  if (!hash || hash.length > 12) return null;
  let even = true;
  const latitude = [-90, 90];
  const longitude = [-180, 180];
  for (const character of hash) {
    const value = GEOHASH_ALPHABET.indexOf(character);
    if (value < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const range = even ? longitude : latitude;
      const midpoint = (range[0] + range[1]) / 2;
      if ((value & (1 << bit)) !== 0) range[0] = midpoint;
      else range[1] = midpoint;
      even = !even;
    }
  }
  return {
    south: latitude[0],
    west: longitude[0],
    north: latitude[1],
    east: longitude[1],
  };
};

const exclusionBounds = (section = {}) => {
  const points = [
    ...(Array.isArray(section?.sectionPoints) ? section.sectionPoints : []),
    section,
  ].map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (points.length) {
    const south = Math.min(...points.map((point) => point.lat));
    const north = Math.max(...points.map((point) => point.lat));
    const west = Math.min(...points.map((point) => point.lng));
    const east = Math.max(...points.map((point) => point.lng));
    const latitudePad = 0.045 / 111;
    const cosine = Math.max(0.1, Math.cos(((south + north) / 2) * Math.PI / 180));
    const longitudePad = 0.045 / (111 * cosine);
    return {
      south: south - latitudePad,
      west: west - longitudePad,
      north: north + latitudePad,
      east: east + longitudePad,
    };
  }
  return cellBounds(section?.geohash);
};

const boundsOverlap = (left, right) => Boolean(left && right) &&
  left.south <= right.north && left.north >= right.south &&
  left.west <= right.east && left.east >= right.west;

const nativeTracedSectionPoints = (record = {}) => (
  (Array.isArray(record?.sectionPoints) ? record.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
      point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180 &&
      !(Math.abs(point.lat) < 0.001 && Math.abs(point.lng) < 0.001))
);

const cellOverlapsExcludedSection = (geohash, exclusions = []) => {
  const bounds = cellBounds(geohash);
  if (!bounds) return true;
  return (Array.isArray(exclusions) ? exclusions : []).some((section) => (
    boundsOverlap(bounds, exclusionBounds(section))
  ));
};

const eligibleNativeCell = (geohash, cell, value, nowMs = Date.now()) => {
  const eligibility = speedKnowledgeCellEligibility(cell, nowMs);
  return Boolean(cellBounds(geohash)) &&
    eligibility.eligible &&
    !cellOverlapsExcludedSection(geohash, value?.excludedSections);
};

const nativeCellsMirror = (value, nowMs = Date.now()) => Object.fromEntries(
  Object.entries(value?.cells && typeof value.cells === 'object' ? value.cells : {})
    .filter(([geohash, cell]) => eligibleNativeCell(geohash, cell, value, nowMs))
    .map(([geohash, cell]) => [geohash, {
      limitKmh: Number(cell.limitKmh),
      source: String(cell.source),
      confidence: speedKnowledgeCellConfidence(cell),
      verifiedAt: cell?.verifiedAt,
      lastVerifiedAt: cell?.lastVerifiedAt,
      appliedAt: cell?.appliedAt,
      lastUpdatedAt: cell?.lastUpdatedAt,
      expiresAt: cell?.expiresAt,
      verificationStatus: cell?.verificationStatus,
      evidenceCount: Number(cell?.evidenceCount) || 0,
      tripCount: Number(cell?.tripCount) || 0,
      tripEvidenceIds: [...new Set(
        (Array.isArray(cell?.tripEvidenceIds) ? cell.tripEvidenceIds : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      )].slice(-100),
      conflict: false,
    }])
);

const nativeSpeedKnowledgeMirror = (value) => ({
  resolverContractVersion: 1,
  schemaVersion: Number(value?.schemaVersion) || SPEED_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeRevision: normalizedRevision(value),
  knowledgeUpdatedAt: value?.knowledgeUpdatedAt || null,
  cells: nativeCellsMirror(value),
  excludedSections: Array.isArray(value?.excludedSections)
    ? value.excludedSections.map((section) => ({
      id: section?.id,
      geohash: section?.geohash,
      lat: section?.lat,
      lng: section?.lng,
      reason: section?.reason,
      directionMode: section?.directionMode || 'both',
      directionBearing: section?.directionBearing,
      sectionPoints: Array.isArray(section?.sectionPoints)
        ? section.sectionPoints.map((point) => ({ lat: point?.lat, lng: point?.lng }))
        : undefined,
    }))
    : [],
  corrections: Array.isArray(value?.corrections)
    ? value.corrections
      .filter((correction) => (
        Number(correction?.limitKmh) > 0 &&
        Number(correction.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH &&
        nativeTracedSectionPoints(correction).length >= 2
      ))
      .map((correction) => ({
      id: correction?.id,
      ruleId: correction?.ruleId,
      geohash: correction?.geohash,
      lat: correction?.lat,
      lng: correction?.lng,
      coordinateSource: correction?.coordinateSource,
      limitKmh: Number(correction?.limitKmh),
      source: correction?.source,
      appliedAt: correction?.appliedAt,
      validFrom: correction?.validFrom ?? correction?.valid_from,
      expiresAt: correction?.expiresAt,
      qualifierStatus: correction?.qualifierStatus,
      directionMode: correction?.directionMode,
      directionBearing: correction?.directionBearing,
      timeRule: correction?.timeRule,
      sectionPoints: nativeTracedSectionPoints(correction),
    }))
    : [],
  roadMemory: {
    version: 3,
    candidates: Array.isArray(value?.roadMemory?.candidates)
      ? decorateRoadMemoryCandidates(value.roadMemory.candidates).candidates
        .filter((candidate) => candidate.canAffectScoreAndAlerts === true &&
          Number(candidate?.limitKmh) > 0 &&
          Number(candidate.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH &&
          nativeTracedSectionPoints(candidate).length >= 2)
        .map((candidate) => ({
          id: candidate?.id,
          geohash: candidate?.geohash,
          lat: candidate?.lat,
          lng: candidate?.lng,
          limitKmh: Number(candidate?.limitKmh),
          source: 'local_road_memory',
          confidence: candidate?.calibratedConfidence,
          evidenceConfidence: candidate?.evidenceConfidence,
          confidenceCalibrationFactor: Number(candidate?.effectiveConfidence) > 0
            ? Math.max(0, Math.min(1,
              Number(candidate?.calibratedConfidence) / Number(candidate.effectiveConfidence)
            ))
            : 0,
          canAffectScoreAndAlerts: true,
          tripCount: candidate?.tripCount,
          agreement: candidate?.agreement,
          lastObservedAt: candidate?.lastObservedAt,
          directionMode: candidate?.directionMode,
          directionBearing: candidate?.directionBearing,
          stage: 'operational',
          active: true,
          intelligenceValidated: true,
          timeProfilesAcceptedAt: candidate?.timeProfilesAcceptedAt ||
            (candidate?.reviewState === 'time_profiles_accepted' ? candidate?.reviewedAt : null),
          timeProfiles: (
            candidate?.timeProfilesAcceptedAt || candidate?.reviewState === 'time_profiles_accepted'
          ) && Array.isArray(candidate?.timeProfiles)
            ? candidate.timeProfiles
              .filter((profile) => profile?.eligible === true &&
                Number(profile?.limitKmh) > 0 && Number(profile.limitKmh) <= MAX_SAVED_SPEED_LIMIT_KMH)
              .map((profile) => ({
                bucket: profile?.bucket,
                limitKmh: Number(profile?.limitKmh),
                tripCount: profile?.tripCount,
                agreement: profile?.agreement,
                eligible: true,
              }))
            : [],
          sectionPoints: nativeTracedSectionPoints(candidate),
        }))
      : [],
  },
});

const locationEmptySpeedKnowledge = (value = {}) => ({
  schemaVersion: Number(value?.schemaVersion) || SPEED_KNOWLEDGE_SCHEMA_VERSION,
  knowledgeRevision: normalizedRevision(value),
  knowledgeUpdatedAt: value?.knowledgeUpdatedAt || null,
  cells: {},
  excludedSections: [],
  corrections: [],
  roadMemory: { version: 3, candidates: [] },
});

const privacyFilteredNativeKnowledge = async (value) => {
  const [{ getHydratedPrivacyZones }, { purgeSpeedKnowledgeDataForPrivacyZones }] = await Promise.all([
    import('@/lib/privacyZones'),
    import('@/lib/speedKnowledgePrivacy'),
  ]);
  const zones = await getHydratedPrivacyZones();
  if (!Array.isArray(zones)) throw new Error('Privacy-zone hydration returned invalid data');
  const filtered = purgeSpeedKnowledgeDataForPrivacyZones(value, zones);
  if (!filtered?.data || typeof filtered.data !== 'object') {
    throw new Error('Privacy-zone speed filter returned invalid data');
  }
  return filtered.data;
};

const replaceNativeSpeedKnowledgeMirror = async (value) => {
  // Removing first is intentional: if encryption or Preferences fails while
  // writing the replacement, Android must see no saved-road geometry instead
  // of continuing to use a stale mirror that may now overlap a privacy zone.
  await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
  await setEncryptedJson(
    SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
    nativeSpeedKnowledgeMirror(value)
  );
};

const syncNativeSpeedKnowledgeMirror = async (_key, value) => {
  if (!isNativePlatform()) {
    await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
    nativeMirrorStatus = { state: 'not_applicable', syncedAt: 0, error: '' };
    return;
  }
  // Write a native-readable one-way marker before the mirror can ever be
  // removed. Android uses legacy storage only on a proven pre-mirror upgrade;
  // once initialized, an absent mirror means fail closed, not "fall back".
  try {
    await setJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
  } catch (error) {
    // Keep the existing mirror and legacy value intact when the guard itself
    // cannot be persisted. Reporting the failure prevents a stale "synced"
    // UI state while still preserving the safe upgrade path.
    nativeMirrorStatus = {
      state: 'error',
      syncedAt: 0,
      error: error?.message || 'Native speed mirror migration marker failed',
    };
    logSystemFailure('speed_knowledge_native_mirror_marker', error, {
      key: SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
    });
    throw error;
  }
  try {
    let privacySafeValue;
    try {
      privacySafeValue = await privacyFilteredNativeKnowledge(value);
    } catch (privacyError) {
      // Never leave an older location-bearing mirror in place when current
      // privacy zones cannot be loaded or evaluated. The web store remains
      // intact and can repopulate the mirror after privacy filtering recovers.
      await replaceNativeSpeedKnowledgeMirror(locationEmptySpeedKnowledge(value));
      nativeMirrorStatus = {
        state: 'privacy_blocked',
        syncedAt: Date.now(),
        error: privacyError?.message || 'Native speed privacy filter failed',
      };
      logSystemFailure('speed_knowledge_native_privacy_filter', privacyError, {
        key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      });
      return;
    }
    await replaceNativeSpeedKnowledgeMirror(privacySafeValue);
    nativeMirrorStatus = { state: 'synced', syncedAt: Date.now(), error: '' };
  } catch (error) {
    // A failed write can be ambiguous on platform storage (for example, the
    // value may have been partially committed before the bridge rejected).
    // A second removal keeps background resolution fail-closed.
    await removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY).catch((removalError) => {
      logSystemFailure('speed_knowledge_native_mirror_fail_closed_remove', removalError, {
        key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      });
    });
    nativeMirrorStatus = {
      state: 'error',
      syncedAt: 0,
      error: error?.message || 'Native speed mirror failed',
    };
    throw error;
  }
};

let nativeMirrorStatus = {
  state: 'unknown',
  syncedAt: 0,
  error: '',
};

export const getNativeSpeedKnowledgeMirrorStatus = () => ({ ...nativeMirrorStatus });

const syncNativeMirrorWithoutBlockingCanonicalMigration = async (value, phase) => {
  try {
    await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, value);
    return true;
  } catch (error) {
    // IndexedDB is the canonical in-app store. Native mirror availability is
    // reported independently and must never make valid canonical data unreadable.
    logSystemFailure('speed_knowledge_native_mirror_migration', error, {
      key: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      phase,
    });
    return false;
  }
};

export const migrateSpeedKnowledgeToIndexedDb = async () => {
  if (!canUseIndexedDb()) return false;
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const indexedValue = await readIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY);
      if (indexedValue != null) {
        const normalizedValue = normalizeSpeedKnowledgeMetadata(indexedValue);
        if (
          Number(indexedValue.schemaVersion) !== normalizedValue.schemaVersion ||
          Number(indexedValue.knowledgeRevision) !== normalizedValue.knowledgeRevision
        ) {
          await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, normalizedValue);
        }
        const mirrorSynced = await syncNativeMirrorWithoutBlockingCanonicalMigration(
          normalizedValue,
          'existing_indexeddb'
        );
        // Keep the legacy value available for an older native runtime until
        // the migration marker and replacement mirror are both safely stored.
        if (mirrorSynced) await removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY);
        return false;
      }
      const legacyStoredValue = await getJson(SPEED_KNOWLEDGE_STORAGE_KEY, null);
      const legacyValue = isEncryptedPayload(legacyStoredValue)
        ? await decryptSensitiveValue(
          legacyStoredValue,
          `storage:${SPEED_KNOWLEDGE_STORAGE_KEY}`
        )
        : legacyStoredValue;
      if (legacyValue == null) {
        const emptyValue = normalizeSpeedKnowledgeMetadata({ cells: {}, corrections: [] });
        await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, emptyValue);
        await syncNativeMirrorWithoutBlockingCanonicalMigration(emptyValue, 'new_empty_indexeddb');
        return false;
      }
      const migratedValue = normalizeSpeedKnowledgeMetadata(legacyValue);
      await writeIndexedDb(SPEED_KNOWLEDGE_STORAGE_KEY, migratedValue);
      const mirrorSynced = await syncNativeMirrorWithoutBlockingCanonicalMigration(
        migratedValue,
        'legacy_to_indexeddb'
      );
      if (mirrorSynced) await removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY);
      recordSystemEvent('speed_knowledge_indexeddb_migrated', {
        cell_count: Object.keys(legacyValue.cells || {}).length,
        correction_count: Array.isArray(legacyValue.corrections) ? legacyValue.corrections.length : 0,
      }, {
        category: 'storage',
        title: 'Saved road speeds migrated',
      });
      return true;
    })().catch((error) => {
      migrationPromise = null;
      logSystemFailure('speed_knowledge_indexeddb_migration', error);
      throw error;
    });
  }
  return migrationPromise;
};

export const speedKnowledgeStore = {
  async get(key = SPEED_KNOWLEDGE_STORAGE_KEY) {
    if (!canUseIndexedDb()) {
      const value = await getEncryptedJson(key, null);
      return value == null ? null : normalizeSpeedKnowledgeMetadata(value);
    }
    try {
      await migrateSpeedKnowledgeToIndexedDb();
      const [indexedValue, writeAheadValue] = await Promise.all([
        readIndexedDb(key),
        getEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, null),
      ]);
      if (indexedValue == null && writeAheadValue == null) return null;
      const indexed = indexedValue == null ? null : normalizeSpeedKnowledgeMetadata(indexedValue);
      const writeAhead = writeAheadValue == null
        ? null
        : normalizeSpeedKnowledgeMetadata(writeAheadValue);
      if (normalizedRevision(writeAhead) > normalizedRevision(indexed)) {
        try {
          await writeIndexedDb(key, writeAhead);
          await removeEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY);
        } catch (recoveryError) {
          logSystemFailure('speed_knowledge_write_ahead_recovery', recoveryError, { key });
        }
        try {
          await syncNativeSpeedKnowledgeMirror(key, writeAhead);
        } catch (mirrorError) {
          logSystemFailure('speed_knowledge_native_mirror_recovery', mirrorError, { key });
        }
        return writeAhead;
      }
      return indexed || writeAhead;
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_read', error, { key });
      const value = await getEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, null) ||
        await getEncryptedJson(key, null);
      return value == null ? null : normalizeSpeedKnowledgeMetadata(value);
    }
  },

  async set(key = SPEED_KNOWLEDGE_STORAGE_KEY, value) {
    const normalizedValue = normalizeSpeedKnowledgeMetadata(value);
    if (!canUseIndexedDb()) {
      await setEncryptedJson(key, normalizedValue);
      try {
        await syncNativeSpeedKnowledgeMirror(key, normalizedValue);
      } catch (error) {
        logSystemFailure('speed_knowledge_native_mirror_write', error, { key });
      }
      return;
    }
    try {
      await migrateSpeedKnowledgeToIndexedDb();
      await writeIndexedDb(key, normalizedValue);
      await removeEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY);
      await removeEncryptedJson(key);
    } catch (error) {
      logSystemFailure('speed_knowledge_indexeddb_write', error, { key });
      await setEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY, normalizedValue);
    }
    try {
      await syncNativeSpeedKnowledgeMirror(key, normalizedValue);
    } catch (error) {
      logSystemFailure('speed_knowledge_native_mirror_write', error, { key });
    }
  },

  runExclusive(key = SPEED_KNOWLEDGE_STORAGE_KEY, operation) {
    return runSpeedKnowledgeStoreExclusive(key, operation);
  },

  async update(key = SPEED_KNOWLEDGE_STORAGE_KEY, updater) {
    if (typeof updater !== 'function') throw new TypeError('Speed knowledge updater must be a function');
    return runSpeedKnowledgeStoreExclusive(key, async () => {
      const current = normalizeSpeedKnowledgeMetadata((await this.get(key)) || {});
      const proposed = await updater(current);
      if (proposed === undefined) return current;
      const next = normalizeSpeedKnowledgeMetadata(proposed, {
        previous: current,
        increment: true,
        updatedAt: new Date().toISOString(),
      });
      await this.set(key, next);
      return next;
    });
  },
};

export const readSpeedKnowledgeData = () => speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY);

export async function retryNativeSpeedKnowledgeMirror() {
  const current = await readSpeedKnowledgeData();
  await syncNativeSpeedKnowledgeMirror(SPEED_KNOWLEDGE_STORAGE_KEY, current);
  return getNativeSpeedKnowledgeMirrorStatus();
}

export const readSpeedKnowledgeMetadata = async () => (
  speedKnowledgeMetadata(await readSpeedKnowledgeData())
);

export const replaceSpeedKnowledgeData = async (value) => {
  await speedKnowledgeStore.update(SPEED_KNOWLEDGE_STORAGE_KEY, () => value);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('speed-knowledge-changed', {
      detail: { action: 'replace_speed_knowledge' },
    }));
  }
};

export async function eraseSpeedKnowledgeForDataRights() {
  return runSpeedKnowledgeStoreExclusive(SPEED_KNOWLEDGE_STORAGE_KEY, async () => {
    const result = {
      store: `indexeddb:${SPEED_KNOWLEDGE_DB_NAME}/${SPEED_KNOWLEDGE_STORE}`,
      indexedDbDeleted: false,
      fallbackKey: SPEED_KNOWLEDGE_STORAGE_KEY,
      fallbackRemoved: false,
      writeAheadKey: SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      writeAheadRemoved: false,
      nativeMirrorKey: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      nativeMirrorRemoved: false,
      method: 'indexeddb_delete_and_mirror_remove',
    };

    // Prevent native legacy fallback during or after erasure even if an older
    // canonical Preferences value takes longer to remove.
    await Promise.resolve(setJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true)).catch(() => {});

    try {
      result.indexedDbDeleted = await deleteDb();
      migrationPromise = null;
    } catch (error) {
      result.method = 'mirror_remove_indexeddb_delete_failed';
      logSystemFailure('speed_knowledge_data_erasure_indexeddb', error, {});
    }

    await Promise.resolve(setEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY, {
      _secure_delete_tombstone: true,
      _secure_delete_at: Date.now(),
      random_padding: Math.random().toString(36).repeat(128),
    })).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_STORAGE_KEY)).then(() => {
      result.fallbackRemoved = true;
    }).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_WRITE_AHEAD_KEY)).then(() => {
      result.writeAheadRemoved = true;
    }).catch(() => {});
    await Promise.resolve(removeEncryptedJson(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY)).then(() => {
      result.nativeMirrorRemoved = true;
    }).catch(() => {});

    return result;
  });
}
