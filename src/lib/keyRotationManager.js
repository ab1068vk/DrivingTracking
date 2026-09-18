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
import { fallbackTripDocumentReleasesKey, inspectStoredTripKeyVersions } from '@/lib/localTripRepository';
import { MONOLITHIC_DOCUMENT_OWNER } from '@/lib/monolithicCompatibility';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { isAndroid } from '@/lib/nativePlatform';
import {
  discoverEncryptedDocumentKeys,
  proveZeroBrowserKeyReferences,
  stepBrowserKeyRewrap,
} from '@/lib/browserKeyReferences';
import { nativeTripArchive } from '@/lib/nativeTripArchive';

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
  'drivesense_key_rotation_log_v1',
  'drivesense_privacy_cell_key_v1',
  // P4-C-F05: `drivesense_trips` is deliberately absent. It is the monolithic
  // fallback archive, and `rotateEncryptedJsonKey` would decrypt and rewrite all
  // of it inside this coordinated turn. Its rotation belongs to the explicit
  // compatibility owner (`runMonolithicTripCompatibilityMaintenance`, driven
  // from the app's quiet-period compatibility step); until that has run, the
  // retiring key version is retained rather than destroyed, and
  // `releaseRetainedKeyVersions()` below retires it once the archive proves it
  // is no longer needed.
  'speed_knowledge_v1',
  'speed_knowledge_v1_write_ahead',
  'speed_knowledge_native_mirror_v1',
  'speed_sign_review_images_v1',
];
export const KEY_ROTATION_LOG_KEY = 'drivesense_key_rotation_log_v1';

let rotationPromise = null;

const initialMeta = (now) => ({
  version: 1,
  lastRotated: now,
});

/**
 * DN2: one coordinator turn admits ONE existing native rotation batch.
 *
 * `maxNativeBatches = 0` keeps the historical run-to-completion behaviour for
 * callers that are not scheduler turns. Nothing about key creation, rewrap,
 * retirement, zero-reference proof, native rotation state or commit ordering
 * moves here — only how many batches one invocation admits.
 */
async function rotate(now, { maxNativeBatches = 0 } = {}) {
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

  const startedAt = Number(meta.rotationStartedAt) || now;
  let result;
  if (isAndroid()) {
    let nativeResult;
    let nativeEnvelopeRecordsRewrapped = 0;
    let batches = 0;
    const batchCeiling = Math.max(0, Math.floor(Number(maxNativeBatches) || 0));
    do {
      nativeResult = await nativeTripArchive.rotateEnvelopeKekBatch(nextVersion, 50);
      nativeEnvelopeRecordsRewrapped += Number(nativeResult.rewrapped) || 0;
      batches += 1;
      if (batchCeiling > 0 && batches >= batchCeiling) break;
    } while (!nativeResult.complete);

    if (nativeResult.complete !== true) {
      // DN2 non-final batch. Nothing may be finalized: the committed `version`
      // does not advance, `pendingVersion` and the old alias stay, and no final
      // metadata, `lastRotated`, rotation-log entry or success event is written.
      // A later turn — including one after a process restart — resumes the same
      // `pendingVersion`, because the meta written above is what it reads back.
      return {
        rotated: false,
        hasMore: true,
        version: currentVersion,
        pendingVersion: nextVersion,
        nativeEnvelopeRecordsRewrapped,
        recordsExamined: nativeEnvelopeRecordsRewrapped,
        nativeBatches: batches,
      };
    }
    result = {
      indexedDbRecordsRotated: 0,
      fallbackStoreRotated: false,
      nativeEnvelopeRecordsRewrapped,
      recordsExamined: nativeEnvelopeRecordsRewrapped,
      payloadBytesRewritten: 0,
    };
  } else {
    // P4-C-F05. The browser/IndexedDB rotation is now bounded the same way the
    // native one is: one fixed ciphertext window per admitted batch against the
    // repository's own durable cursor. A larger archive produces more turns, not
    // a larger turn, and a renderer restart resumes the same `pendingVersion`
    // because the cursor records its target.
    const { stepTripEncryptionKeyRotationBatch } = await import('@/lib/localTripRepository');
    const batchCeiling = Math.max(0, Math.floor(Number(maxNativeBatches) || 0));
    let indexedDbRecordsRotated = 0;
    let recordsExamined = 0;
    let fallbackStoreRotated = false;
    let batches = 0;
    let batch;
    do {
      batch = await stepTripEncryptionKeyRotationBatch(nextVersion);
      indexedDbRecordsRotated += Number(batch.indexedDbRecordsRotated) || 0;
      recordsExamined += Math.max(0, Number(batch.examined ?? batch.processed) || 0);
      fallbackStoreRotated = fallbackStoreRotated || batch.fallbackStoreRotated === true;
      batches += 1;
      if (batchCeiling > 0 && batches >= batchCeiling) break;
    } while (batch.hasMore);

    if (batch.hasMore) {
      // Non-final batch: nothing may be finalized. The committed `version` does
      // not advance, `pendingVersion` and the old alias stay, and no final
      // metadata, `lastRotated`, rotation-log entry or success event is written.
      return {
        rotated: false,
        hasMore: true,
        version: currentVersion,
        pendingVersion: nextVersion,
        indexedDbRecordsRotated,
        recordsExamined,
        browserBatches: batches,
        nativeEnvelopeRecordsRewrapped: 0,
      };
    }
    result = {
      indexedDbRecordsRotated,
      recordsExamined,
      fallbackStoreRotated,
      nativeEnvelopeRecordsRewrapped: 0,
      payloadBytesRewritten: 0,
      // P4-C-F05: the bounded sweep never rewrites the fallback document, so
      // whether the retiring key is still referenced by it is carried forward
      // to the retirement decision below rather than assumed away.
      fallbackDocumentPending: batch.fallbackDocumentPending === true,
      fallbackDocumentOwnerless: batch.ownerless === true,
    };
  }
  // AUD-007. `ROTATING_ENCRYPTED_JSON_KEYS` is hand-maintained, and CODEX independently
  // found four live documents missing from it. Adding four more names would not make a
  // hand-written list reliable, so the sweep is driven by the documents that were
  // actually written (recorded by `setEncryptedJson`) unioned with the static list --
  // the static list still covers anything written before this index existed.
  // Round 2: a forward-only index is not discovery. Documents written before the index
  // existed are invisible to it, and an index write can fail while the ciphertext still
  // publishes. The durable store is enumerated instead; the static list and the index can
  // only ADD to what enumeration finds. `unknown` means enumeration could not complete,
  // which must retain the old key rather than assume nothing else exists.
  // AUD-007 round 3. The registered domains get their bounded rewrap turn BEFORE
  // anything is finalized, and an unfinished turn defers finalization instead of being
  // discarded. Round 2 called this once and threw `hasMore` away: a rotation that could
  // only move the first page of sessions finalized anyway, so the rest stayed sealed
  // under a version rotation had just stopped tracking. `pendingVersion` is already
  // durable at this point, so the next turn -- including one after a restart -- resumes
  // the same target and the rewraps already committed are not redone.
  const previouslyRetained = Array.isArray(meta.retainedKeyVersions)
    ? meta.retainedKeyVersions.map((version) => Math.max(0, Number(version) || 0)).filter(Boolean)
    : [];
  const retirable = [...new Set([...previouslyRetained, currentVersion])]
    .filter((version) => version > 0 && version < nextVersion);
  if (!isAndroid()) {
    // AUD-007 round 4. Each domain's continuation is carried across turns AND persisted
    // with `pendingVersion`, so a turn resumes where the last one stopped even after a
    // renderer restart. Round 3 discarded it, so every turn restarted at the first key
    // and spent its budget re-examining rows it had already migrated.
    const savedCursors = (meta.rewrapCursors && typeof meta.rewrapCursors === 'object')
      ? meta.rewrapCursors
      : {};
    let rewrapHasMore = false;
    let rewrapped = 0;
    const nextCursors = { ...savedCursors };
    for (const version of retirable) {
      const scope = `${version}:${nextVersion}`;
      const step = await stepBrowserKeyRewrap(version, nextVersion, savedCursors[scope] || {});
      rewrapped += Math.max(0, Number(step?.rewrapped) || 0);
      nextCursors[scope] = step?.cursors || {};
      if (step?.hasMore === true) rewrapHasMore = true;
    }
    if (rewrapHasMore) {
      // Non-final turn: persist the continuation alongside the pending target so the
      // next turn — including one after a restart — does not redo committed rewraps.
      await setJson(ENCRYPTION_KEY_META_KEY, { ...meta, rewrapCursors: nextCursors });
      return {
        rotated: false,
        hasMore: true,
        version: currentVersion,
        pendingVersion: nextVersion,
        browserKeyReferencesRewrapped: rewrapped,
        indexedDbRecordsRotated: result.indexedDbRecordsRotated || 0,
        recordsExamined: result.recordsExamined || 0,
        nativeEnvelopeRecordsRewrapped: result.nativeEnvelopeRecordsRewrapped || 0,
      };
    }
  }

  const discovery = await discoverEncryptedDocumentKeys().catch(() => ({ keys: [], unknown: true }));
  const encryptedDocumentDiscoveryUnknown = discovery.unknown === true;
  const encryptedJsonKeys = [...new Set([...ROTATING_ENCRYPTED_JSON_KEYS, ...discovery.keys])];
  let encryptedJsonValuesRotated = 0;
  for (const key of encryptedJsonKeys) {
    if (await rotateEncryptedJsonKey(key, nextVersion)) {
      encryptedJsonValuesRotated += 1;
    }
  }

  // Android's legacy payload-key family is still referenced by native intake
  // journal/checkpoint files that cannot be atomically enumerated and rewrapped
  // through the JS encrypted-Preferences registry.  Retain that old alias until
  // those domains have a registry-wide zero-reference proof.  The independent
  // P3.5 archive KEKs are retired natively after their own zero proof.
  //
  // P4-C-F05: the monolithic fallback trip document is rotated only by the
  // explicit whole-history owner, so the retiring version is destroyed only
  // once its O(1) reference record proves that document no longer needs it.
  // A version that is still referenced is *retained with a recorded reason*,
  // never silently skipped, and is retired by a later rotation whose proof
  // succeeds.
  const fallbackReleasesKey = await fallbackTripDocumentReleasesKey(currentVersion);
  const retainedKeyVersions = [];
  const retentionReasons = {};
  if (!isAndroid()) {
    for (const version of retirable) {
      // Require a complete zero-reference proof. The previous gate consulted ONE
      // consumer (the monolithic fallback document) and destroyed keys that the route
      // spool, the P6 stores, speed knowledge and several encrypted documents still
      // depended on. Unknown, failed, or in-flight now means RETAIN.
      const proof = await proveZeroBrowserKeyReferences(version);
      let finalized = { deleted: false, reason: 'not_attempted' };
      if (fallbackReleasesKey && proof.zero && !encryptedDocumentDiscoveryUnknown) {
        // Round 4: deletion is a finalization that re-proves under closed admission, so
        // it can legitimately refuse. Record the refusal as a retention instead of
        // assuming the key is gone. An implementation that reports nothing keeps the
        // historical contract (it deleted); only an explicit refusal retains.
        finalized = (await deleteEncryptionKeyVersion(version)) ?? { deleted: true };
      }
      if (finalized.deleted !== false) {
        // retired
      } else {
        retainedKeyVersions.push(version);
        retentionReasons[version] = encryptedDocumentDiscoveryUnknown
          ? 'encrypted_document_discovery_unknown'
          : finalized.reason && finalized.reason !== 'not_attempted'
            ? finalized.reason
            : proof.zero
              ? MONOLITHIC_DOCUMENT_OWNER
              : (proof.blockedBy || 'unproven_references');
      }
    }
  }
  await setJson(ENCRYPTION_KEY_META_KEY, {
    version: nextVersion,
    lastRotated: now,
    ...(retainedKeyVersions.length ? {
      retainedKeyVersions,
      retainedFor: MONOLITHIC_DOCUMENT_OWNER,
      retentionReasons,
    } : {}),
  });
  await appendRotationLog({
    fromVersion: currentVersion,
    toVersion: nextVersion,
    startedAt,
    completedAt: Date.now(),
    recordsReencrypted: result.indexedDbRecordsRotated + encryptedJsonValuesRotated,
    ...(retainedKeyVersions.length ? {
      retainedKeyVersions,
      retainedFor: MONOLITHIC_DOCUMENT_OWNER,
    } : {}),
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
    retainedKeyVersions,
    hasMore: false,
    previousVersion: currentVersion,
    version: nextVersion,
    encryptedJsonValuesRotated,
    encryptedJsonKeysExamined: encryptedJsonKeys.length,
    ...(retainedKeyVersions.length ? {
      retainedKeyVersions,
      retainedFor: MONOLITHIC_DOCUMENT_OWNER,
    } : {}),
    ...result,
  };
}

/**
 * P4-C-F05 — retire key versions that were retained for the monolithic fallback
 * archive, once that archive proves it no longer needs them.
 *
 * A rotation that finishes while the fallback archive is still on the old key
 * records that version in `retainedKeyVersions` instead of destroying it. That
 * debt used to be discharged only by the *next* rotation, up to
 * `KEY_ROTATION_DAYS` later. The explicit compatibility owner calls this
 * immediately after it rewrites the archive, so the retained key is released as
 * soon as the proof succeeds.
 *
 * The proof is `fallbackTripDocumentReleasesKey`, which requires a *proven*
 * absence or a stamped newer key version. An unknown presence probe retains the
 * key. Android's native key ownership is untouched.
 */
export async function releaseRetainedKeyVersions() {
  const meta = await getJson(ENCRYPTION_KEY_META_KEY, null);
  const retained = Array.isArray(meta?.retainedKeyVersions)
    ? [...new Set(meta.retainedKeyVersions.map((version) => Math.max(0, Number(version) || 0)))]
      .filter(Boolean)
    : [];
  if (!retained.length) return { released: [], retained: [] };
  if (isAndroid()) return { released: [], retained };

  const currentVersion = Math.max(1, Number(meta?.version) || 1);
  const released = [];
  const stillRetained = [];
  const refusals = {};
  for (const version of retained) {
    if (version >= currentVersion) {
      // Never retire the key the store is actually on.
      stillRetained.push(version);
      continue;
    }
    // AUD-007 round 2: ONE deletion authority. This helper previously deleted a
    // historical root key on the fallback document's word alone, bypassing the
    // registered-domain proof entirely — so a key the spool, P6 or speed knowledge
    // still depended on could be destroyed here even when ordinary rotation had
    // correctly retained it. Every path that can destroy a key asks the same question.
    const proof = await proveZeroBrowserKeyReferences(version);
    const discovery = await discoverEncryptedDocumentKeys().catch(() => ({ unknown: true }));
    if (!(proof.zero && discovery.unknown !== true && await fallbackTripDocumentReleasesKey(version))) {
      stillRetained.push(version);
      continue;
    }
    // AUD-007 round 5. Deletion can REFUSE — a finalization already running, writers that
    // did not drain, a proof that came back non-zero. Round 4 asked and then ignored the
    // answer here, so a refused deletion still moved the version out of retained metadata:
    // the key survived on disk while the ledger said it had been released, which is worse
    // than either outcome alone. A version leaves retained metadata only on a positive
    // `deleted: true`.
    const outcome = (await deleteEncryptionKeyVersion(version)) ?? { deleted: true };
    if (outcome.deleted === false) {
      stillRetained.push(version);
      refusals[version] = outcome.reason || 'deletion_refused';
      continue;
    }
    released.push(version);
  }

  if (released.length) {
    await setJson(ENCRYPTION_KEY_META_KEY, {
      version: meta.version,
      lastRotated: meta.lastRotated,
      ...(stillRetained.length ? {
        retainedKeyVersions: stillRetained,
        retainedFor: MONOLITHIC_DOCUMENT_OWNER,
        ...(Object.keys(refusals).length ? { retentionReasons: refusals } : {}),
      } : {}),
    });
    recordSystemEvent('encryption_key_retained_versions_released', {
      released_versions: released,
      retained_versions: stillRetained,
    }, { category: 'privacy', title: 'Superseded encryption keys retired' });
  }
  return { released, retained: stillRetained };
}

export function checkAndRotateEncryptionKey({ now = Date.now(), maxNativeBatches = 0 } = {}) {
  if (!rotationPromise) {
    rotationPromise = rotate(now, { maxNativeBatches })
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

/**
 * One bounded scheduler turn of key rotation: at most one existing native
 * envelope-KEK batch. Returns `hasMore: true` while the native engine reports
 * the rotation incomplete, so the coordinator tail re-admits the same logical
 * instance instead of this manager monopolising until the archive is done.
 */
export const stepEncryptionKeyRotation = ({ now = Date.now(), maxNativeBatches = 1 } = {}) => (
  checkAndRotateEncryptionKey({ now, maxNativeBatches: Math.max(1, Math.floor(Number(maxNativeBatches) || 1)) })
);

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
  if (isAndroid()) {
    const [native, rotationLog, activeKeyVersion] = await Promise.all([
      nativeTripArchive.envelopeKekRotationStatus(),
      loadRotationLog(),
      getActiveEncryptionKeyVersion(),
    ]);
    const lastRotation = rotationLog.at(-1) || null;
    const rotationErrors = rotationLog.filter((entry) => entry.status === 'error');
    return {
      status: rotationErrors.length ? 'error' : native.phase === 'COMPLETE' ? 'ok' : native.phase === 'IDLE' ? 'unknown' : 'warn',
      activeKeyVersion,
      nativeEnvelopeRotation: native,
      lastRotationAt: lastRotation?.completedAt || null,
      rotationErrors: rotationErrors.length,
      evidence: native.phase === 'COMPLETE'
        ? 'Native trip and speed DEKs have a registry-wide zero-reference proof for retired KEKs.'
        : `Native envelope rotation state: ${native.phase || 'unknown'}`,
    };
  }
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
