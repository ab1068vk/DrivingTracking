import { browserActiveTripSpool } from '@/lib/browserActiveTripSpool';
import { CARBON_ANALYTICS_SETTINGS_KEYS, CARBON_ANALYTICS_VEHICLE_FIELDS } from '@/lib/tripInsights';
import { publishP7SourceChange } from '@/lib/p7SourceChange';
import {
  getBrowserKeyProofGeneration,
  isBrowserKeyProofGenerationCurrent,
  withDurableKeyPublication,
  registerBrowserKeyReferenceDomain,
} from '@/lib/browserKeyReferences';
import {
  localTripRepository,
  openP6TripDerivedDatabase,
  P6_TRIP_DERIVED_STORES,
  P6_TRIP_SOURCE_STORE,
} from '@/lib/localTripRepository';
import {
  P6_DOMAIN_KEYS,
  P6_JOB_KEYS,
  P6_READINESS_STATES,
  P6_SOURCE_READ_RESERVE_BYTES,
  P6_TURN_BUDGET,
  normalizeP6Readiness,
} from '@/lib/p6Contracts';

/**
 * Which P6 implementation owns this process's trips.
 *
 * P6 follows the **authority**, not the platform: on Android under browser
 * authority the trips live in IndexedDB, so routing on `isAndroid()` alone
 * reaches a native archive that holds none of them.
 */
const nativeDerivedStateSelected = () => isAndroid() && import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true';

import { P7_PUBLIC_PAGE_LIMIT } from '@/lib/queryContracts/envelope';
import { decodeP6PointBlock, encodeP6PointBlock } from '@/lib/p6PointBlockCodec';
import {
  orderP6ReclamationCandidates,
  registerP6BrowserDerivedReclaimer,
  requireBrowserP6DerivedStorage,
} from '@/lib/p6DerivedStorage';
import {
  decryptSensitiveValue,
  encryptSensitiveValue,
  isEncryptedPayload,
} from '@/lib/securePayloadCrypto';
import { isAndroid } from '@/lib/nativePlatform';
import { nativeTripArchive } from '@/lib/nativeTripArchive';

const encoder = new TextEncoder();
const encodedJsonBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('P6 transaction aborted'));
});

export async function reclaimP6BrowserDerivedStorageTurn({ scanLimit = 128 } = {}) {
  const db = await openP6TripDerivedDatabase();
  try {
    const stores = [P6_TRIP_DERIVED_STORES.ROAD_WINDOWS, P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS]
      .filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(stores, 'readonly');
    const candidates = [];
    const pages = await Promise.all(stores.map((storeName) => new Promise((resolve, reject) => {
        const found = []; const request = tx.objectStore(storeName).openCursor();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { const cursor = request.result; if (!cursor || found.length >= scanLimit) return resolve(found); found.push({ key: cursor.primaryKey, value: cursor.value }); cursor.continue(); };
      })));
    await transactionDone(tx);
    const geometryTrips = [...new Set(pages.flatMap((rows, index) => stores[index] === P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS
      ? rows.map((row) => String(row.value?.tripId || '')).filter(Boolean) : []))];
    const manifestTx = db.transaction(P6_TRIP_DERIVED_STORES.MANIFESTS, 'readonly');
    const manifests = new Map(await Promise.all(geometryTrips.map(async (tripId) => [tripId,
      await requestResult(manifestTx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS)
        .get(`${P6_DOMAIN_KEYS.GEOMETRY}:${tripId}`))])));
    await transactionDone(manifestTx);
    for (let storeIndex = 0; storeIndex < stores.length; storeIndex += 1) {
      const storeName = stores[storeIndex]; const rows = pages[storeIndex];
      for (const row of rows) {
        const value = row.value || {}; let kind = 'OTHER_DERIVED_CHUNKS'; let domain = null;
        if (storeName === P6_TRIP_DERIVED_STORES.ROAD_WINDOWS) kind = 'OBSOLETE_STAGE';
        else if (storeName === P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS) {
          const manifest = manifests.get(String(value.tripId || ''));
          if (manifest?.contentVersion !== value.contentVersion) kind = 'RETIRED_CONTENT_VERSION';
          else { kind = Number(value.ordinal) === -1 ? 'PREVIEW_CACHE' : 'OTHER_DERIVED_CHUNKS'; domain = P6_DOMAIN_KEYS.GEOMETRY; }
        } else if (storeName === P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS) { kind = 'SPATIAL_POSTINGS'; domain = P6_DOMAIN_KEYS.SPATIAL_SELECTION; }
        else { kind = 'FROZEN_OBSERVATION_PAYLOAD'; domain = P6_DOMAIN_KEYS.ROAD_LEARNING; }
        candidates.push({ id: `${storeName}:${String(row.key)}`, storeName, key: row.key, kind,
          tripId: value.tripId, domain, updatedAt: Number(value.updatedAt) || 0,
          bytes: Number(value.encodedBytes) || encodedJsonBytes(value) });
      }
    }
    const selected = orderP6ReclamationCandidates(candidates)[0];
    if (!selected) return { state: 'NO_RECLAIMABLE_DERIVED_DATA', itemsWorked: candidates.length, bytesWorked: 0, reclaimedBytes: 0, hasMore: false };
    const writeStores = [selected.storeName, P6_TRIP_DERIVED_STORES.MANIFESTS, P6_TRIP_DERIVED_STORES.WORK];
    const write = db.transaction(writeStores, 'readwrite');
    await new Promise((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () => reject(write.error);
      write.onabort = () => reject(write.error || new Error('P6 reclamation transaction aborted'));
      const remove = () => write.objectStore(selected.storeName).delete(selected.key);
      if (!selected.domain || !selected.tripId) { remove(); return; }
      const manifests = write.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
      const workStore = write.objectStore(P6_TRIP_DERIVED_STORES.WORK);
      const key = `${selected.domain}:${selected.tripId}`;
      let manifest; let work; let manifestReady = false; let workReady = false; let applied = false;
      const apply = () => {
        if (applied || !manifestReady || !workReady) return;
        applied = true;
        const now = Date.now();
        if (manifest?.complete) manifests.put({ ...manifest, state: P6_READINESS_STATES.REBUILD_REQUIRED,
          complete: false, storageOutcome: 'DERIVED_RECLAIMED', updatedAt: now });
        if (work) {
          // Strip the analytics-only restore marker. It rides a `{...work}`
          // spread, so carrying it through this re-dirty would let the next
          // rediscovery turn republish D1 and then restore the row straight to
          // its terminal state — silently abandoning the rebuild this reclaim
          // just asked for, with the `D2:all` head left VERIFIED over geometry
          // that is gone. The marker belongs to the turn that wrote it; any
          // other writer touching the row invalidates it.
          const { analyticsOnlyTerminalState: _consumedByReclaim, ...carried } = work;
          workStore.put({ ...carried, state: 'DIRTY', cursor: null, roadCursor: null, updatedAt: now });
        }
        remove();
      };
      const manifestRequest = manifests.get(key);
      manifestRequest.onerror = () => reject(manifestRequest.error);
      manifestRequest.onsuccess = () => { manifest = manifestRequest.result; manifestReady = true; apply(); };
      const workRequest = workStore.get(selected.tripId);
      workRequest.onerror = () => reject(workRequest.error);
      workRequest.onsuccess = () => { work = workRequest.result; workReady = true; apply(); };
    });
    return { state: 'RECLAIMED', kind: selected.kind, itemsWorked: candidates.length + 1,
      bytesWorked: selected.bytes, reclaimedBytes: selected.bytes, hasMore: candidates.length > 1 };
  } finally { db.close(); }
}

const registeredTripDerivedReclaimer = () => reclaimP6BrowserDerivedStorageTurn();
registerP6BrowserDerivedReclaimer(registeredTripDerivedReclaimer, 10);

const finitePoint = (point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng));
const publicPoint = (point) => finitePoint(point)
  && Math.abs(Number(point.lat)) <= 90
  && Math.abs(Number(point.lng)) <= 180
  && !(Math.abs(Number(point.lat)) < 0.001 && Math.abs(Number(point.lng)) < 0.001)
  && point?.privacy_export_placeholder !== true
  && point?.privacy_masked !== true
  && point?.masked_for_privacy !== true
  && point?.privacy_gap !== true
  && point?.privacy_live_redacted !== true;
const compactPoint = (point) => ({
  lat: Number(point.lat),
  lng: Number(point.lng),
  timestamp: point.timestamp ?? point.timestampMs ?? point.recorded_at ?? null,
  speedKmh: Number.isFinite(Number(point.speed_kmh ?? point.speedKmh))
    ? Number(point.speed_kmh ?? point.speedKmh)
    : null,
  heading: Number.isFinite(Number(point.heading ?? point.bearing)) ? Number(point.heading ?? point.bearing) : null,
  accuracy: Number.isFinite(Number(point.accuracy)) ? Number(point.accuracy) : null,
  speedLimitKmh: Number.isFinite(Number(point.speed_limit_kmh ?? point.limitKmh))
    ? Number(point.speed_limit_kmh ?? point.limitKmh)
    : null,
  limitSource: String(point.speed_limit_source ?? point.limitSource ?? ''),
  utcOffsetMinutes: Number.isFinite(Number(point.utc_offset_minutes ?? point.utcOffsetMinutes))
    ? Number(point.utc_offset_minutes ?? point.utcOffsetMinutes)
    : null,
  timezoneId: String(point.timezone_id ?? point.timezoneId ?? ''),
});

const cellFor = (point) => {
  const size = 0.00135;
  return `${Math.floor((Number(point.lat) + 90) / size)}:${Math.floor((Number(point.lng) + 180) / size)}`;
};

const randomBytes = (length) => {
  const bytes = new Uint8Array(length);
  if (!globalThis.crypto?.getRandomValues) throw new Error('P6_SPATIAL_SECRET_CRYPTO_UNAVAILABLE');
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const hex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
const fromHex = (value) => new Uint8Array(String(value).match(/.{1,2}/g)?.map((part) => Number.parseInt(part, 16)) || []);

// A cell token is a keyed one-way name for a grid cell, never a location, and
// it appears three times per posting: in the primary key, in the record and in
// the by_cell_trip index. The full SHA-256 tag spent 64 characters on each of
// those; 96 bits of a keyed tag is still far beyond any preimage or forgery
// reach without the secret, and at the frozen 3M-point fixture the collision
// probability across every distinct cell stays below 1e-13 — and a collision
// would only widen the candidate set the precise predicate then rejects.
const P6_CELL_TOKEN_HEX_LENGTH = 24;
const hmacCell = async (secret, cell) => {
  if (!globalThis.crypto?.subtle) throw new Error('P6_SPATIAL_HMAC_UNAVAILABLE');
  const key = await globalThis.crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const tag = hex(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(cell))));
  return tag.slice(0, P6_CELL_TOKEN_HEX_LENGTH);
};

const spatialSecretContext = 'indexeddb:drivesense_mobile/p6_control:spatial-secret-v1';

const readSpatialSecret = async () => withDurableKeyPublication(async () => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    const record = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).get('spatial-secret-v1'));
    if (record?.value) {
      const plain = await decryptSensitiveValue(record.value, spatialSecretContext);
      return fromHex(plain?.hex || '');
    }
  } finally {
    db.close();
  }
  const secret = randomBytes(32);
  const value = await encryptSensitiveValue({ hex: hex(secret) }, spatialSecretContext);
  const writeDb = await openP6TripDerivedDatabase();
  try {
    const tx = writeDb.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
    tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).put({ key: 'spatial-secret-v1', value, updatedAt: Date.now() });
    await transactionDone(tx);
  } finally {
    writeDb.close();
  }
  return secret;
});

const addContribution = (bucket = {}, value = {}, multiplier = 1) => {
  const next = { ...bucket };
  Object.entries(value).forEach(([key, item]) => {
    if (typeof item === 'number' && Number.isFinite(item)) next[key] = (Number(next[key]) || 0) + multiplier * item;
  });
  next.updatedAt = Date.now();
  return next;
};

const analyticsBucketKeys = (trip) => {
  const time = new Date(trip?.start_time || 0).getTime();
  const date = Number.isFinite(time) ? new Date(time) : new Date(0);
  const day = date.toISOString().slice(0, 10);
  const hour = date.toISOString().slice(0, 13);
  const vehicle = String(trip?.vehicle_id || trip?.vehicleId || '');
  return ['browser:global:2', `browser:utc-day:${day}:2`, `browser:utc-hour:${hour}:2`, `browser:vehicle:${vehicle}:2`];
};

const analyticsRevisionToken = () => globalThis.crypto?.randomUUID?.()
  || `p6-analytics-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const analyticsContributionContext = (row) => (
  `p6:analytics-contribution:${row.tripId}:${row.sourceRevision}:2:${row.revisionToken}`
);
const analyticsBucketContext = (row) => `p6:analytics-bucket:${row.key}:${row.revisionToken}`;
const decryptAnalyticsContribution = async (row) => {
  if (!row?.payload || !row?.revisionToken || !isEncryptedPayload(row.payload)) {
    throw new Error('P6_ANALYTICS_CONTRIBUTION_ENCRYPTION_REQUIRED');
  }
  return decryptSensitiveValue(row.payload, analyticsContributionContext(row));
};
const decryptAnalyticsBucket = async (row) => {
  if (!row?.payload || !row?.revisionToken || !isEncryptedPayload(row.payload)) {
    throw new Error('P6_ANALYTICS_BUCKET_ENCRYPTION_REQUIRED');
  }
  return decryptSensitiveValue(row.payload, analyticsBucketContext(row));
};
const sameAnalyticsRevision = (current, observed) => (
  (current?.revisionToken || null) === (observed?.revisionToken || null)
);

const deleteIndexPage = (index, value, limit = 128) => new Promise((resolve, reject) => {
  let removed = 0;
  const request = index.openCursor(IDBKeyRange.only(value));
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor || removed >= limit) return resolve({ removed, hasMore: Boolean(cursor) });
    cursor.delete();
    removed += 1;
    cursor.continue();
  };
});

/**
 * Order two IndexedDB primary keys. Prefers the engine's own comparator so the
 * ordering matches the cursor's, and falls back to a plain compare for the
 * string/number keys these stores use when `cmp` is unavailable.
 */
const compareIndexedDbKeys = (left, right) => {
  const engine = globalThis.indexedDB;
  if (engine && typeof engine.cmp === 'function') {
    try { return engine.cmp(left, right); } catch { /* fall through */ }
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/**
 * Delete one bounded page of rows that belong to a superseded revision of the
 * same trip. Scanning is charged against the limit too, so a trip whose rows are
 * all current still costs a bounded turn instead of a full-history walk.
 */
const deleteSupersededPage = (
  index, tripId, appliedRevision, afterPrimaryKey = null, limit = 128,
) => new Promise((resolve, reject) => {
  let removed = 0;
  let scanned = 0;
  let positioned = afterPrimaryKey == null;
  let lastPrimaryKey = afterPrimaryKey;
  const request = index.openCursor(IDBKeyRange.only(tripId));
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor || scanned >= limit) return resolve({
      removed, scanned, hasMore: Boolean(cursor), lastPrimaryKey,
    });
    if (!positioned) {
      positioned = true;
      // Resuming a paged delete. The previous page deleted rows, so this
      // reopened cursor can already sit at — or beyond — the resume key.
      // `continuePrimaryKey` only moves forward: asking it to stand still or go
      // backwards throws `DataError`, which rejected the retirement turn and
      // took the whole trip-derived job down with it, leaving D1 to advance
      // only one subject per external lifecycle admission (DPD-015).
      const ahead = compareIndexedDbKeys(cursor.primaryKey, afterPrimaryKey);
      if (ahead < 0) {
        cursor.continuePrimaryKey(tripId, afterPrimaryKey);
        return;
      }
      if (ahead === 0) {
        // Exactly the last row the previous page scanned; step over it.
        cursor.continue();
        return;
      }
      // Already past the resume point, so this row still needs scanning: fall
      // through and treat the cursor as positioned.
    }
    scanned += 1;
    lastPrimaryKey = cursor.primaryKey;
    if (String(cursor.value?.sourceRevision ?? '') !== appliedRevision) {
      cursor.delete();
      removed += 1;
    }
    cursor.continue();
  };
});

const P6_RETIRE_PHASES = Object.freeze(['GEOMETRY', 'POSTINGS', 'OBSERVATIONS', 'ROAD_WINDOWS']);

/**
 * Terminal work state for a subject whose canonical route can only be read by
 * an explicit operation — today a legacy inline `route_points` array.
 *
 * It is deliberately neither drainable nor finished. `readFirstWork` does not
 * return it, so one such subject cannot stall the queue behind it; and both
 * finalizers count it, so the domains that deferred cannot have their `:all`
 * head promoted to VERIFIED while the hole is still there. D1 is unaffected —
 * its contribution is published before the deferral — which is why the
 * Dashboard's lifetime totals still converge on the lifecycle path.
 */
const P6_EXPLICIT_SOURCE_REQUIRED = 'EXPLICIT_SOURCE_REQUIRED';
const p6WorkOwnsDomain = (work, domain) => !Array.isArray(work?.dirtyDomains)
  || work.dirtyDomains.includes(domain);

const canonicalSourcePresent = async (tripId) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_SOURCE_STORE, 'readonly');
    return Boolean(await requestResult(tx.objectStore(P6_TRIP_SOURCE_STORE).get(tripId)));
  } catch {
    return true;
  } finally { db.close(); }
};

/**
 * The canonical row is there but could not be read. Park the marker so it stops
 * blocking other subjects, revoke this subject's heads so no reader treats the
 * published content as current, and keep the derived rows: the next canonical
 * write, or E1, mints fresh work for the same subject.
 */
const parkUnreadableSource = async (work, error) => {
  for (const domain of Object.values(P6_DOMAIN_KEYS)) {
    for (const subject of [work.tripId, 'all']) {
      await setP6TripDomainReadiness({
        domain, subject, sourceBinding: 'browser',
        requiredVersion: work.desiredRevision,
        state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
        reason: 'SOURCE_READ_FAILED',
      });
    }
  }
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readwrite');
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      ...work, state: 'SOURCE_UNREADABLE', cursor: null,
      failureReason: String(error?.message || error || 'SOURCE_READ_FAILED'),
      updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return { state: 'SOURCE_READ_FAILED', itemsWorked: 1, bytesWorked: 0, hasMore: true };
};

/**
 * Replacement is replacement: once a new revision is published and the heads
 * point at it, the rows of the superseded revision are retired. Leaving them
 * behind made every trip edit add a whole extra copy of that trip's derived
 * state for the life of the installation, which no reclamation pass claims and
 * which the frozen `E(N,P,S)` envelope has no room for.
 */
const retireSupersededTurn = async (work) => {
  const phase = P6_RETIRE_PHASES.includes(work.cursor?.retirePhase)
    ? work.cursor.retirePhase
    : P6_RETIRE_PHASES[0];
  const byPhase = {
    GEOMETRY: P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
    POSTINGS: P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
    OBSERVATIONS: P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
    ROAD_WINDOWS: P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
  };
  const applied = String(work.appliedRevision ?? work.desiredRevision ?? '');
  const storeName = byPhase[phase];
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([storeName, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
    const result = await deleteSupersededPage(
      tx.objectStore(storeName).index('by_trip'), work.tripId, applied,
      work.cursor?.retireAfterPrimaryKey ?? null,
    );
    const nextPhase = result.hasMore ? phase : P6_RETIRE_PHASES[P6_RETIRE_PHASES.indexOf(phase) + 1];
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put(nextPhase
      ? { ...work, state: 'RETIRE_SUPERSEDED', cursor: {
        retirePhase: nextPhase,
        ...(result.hasMore ? { retireAfterPrimaryKey: result.lastPrimaryKey } : {}),
      }, updatedAt: Date.now() }
      // Retirement is bounded GC, not a verdict: a subject that parked itself
      // for an explicit pass still retires its superseded rows, then lands in
      // the state it asked for rather than in COMPLETE.
      : { ...work, state: String(work.retireTerminalState || 'COMPLETE'),
        cursor: null, updatedAt: Date.now() });
    await transactionDone(tx);
    return {
      state: 'RETIRE_SUPERSEDED', phase, itemsWorked: result.scanned + 1, bytesWorked: 0, hasMore: true,
    };
  } finally { db.close(); }
};

const readFirstWork = async () => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readonly');
    const index = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).index('by_desired_seq');
    return await new Promise((resolve, reject) => {
      const request = index.openCursor();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(null);
        if (['DIRTY', 'BUILDING', 'PREVIEW_BUILD', 'RETIRE_SUPERSEDED'].includes(cursor.value?.state)) {
          return resolve(cursor.value);
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
};

const hashP6Source = async (value) => {
  const bytes = encoder.encode(JSON.stringify(value));
  if (globalThis.crypto?.subtle) return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)));
  let hash = 2166136261;
  bytes.forEach((item) => { hash = Math.imul(hash ^ item, 16777619) >>> 0; });
  return `fnv1a-${hash.toString(16)}-${bytes.byteLength}`;
};

const P6_ANALYTICS_SETTINGS_REPAIR_KEY = 'analytics-settings-repair';

/**
 * Settings the analytics version must ignore.
 *
 * `settings` mixes durable user preferences with observed runtime status. The
 * status fields change with no user action — `rasp_checked_at` is rewritten on
 * *every launch* — so hashing the whole object made the analytics
 * settings-version unstable, and `invalidateP6AnalyticsForSettings` demoted
 * `D1_ANALYTICS:all` to REBUILD_REQUIRED on every launch. Because that state
 * clears only when an explicit repair completes against a *matching* version,
 * the match could never hold: derived analytics were permanently unavailable
 * and every repair was undone by the next launch.
 *
 * DPD-033 replaced the exclusion approach with a positive projection (below), which
 * cannot contain any of these keys; the set remains as the DPD-028 record and is
 * asserted by its tests. Consent timestamps no longer invalidate either: the D1
 * contribution does not read them, and what it does read is pinned by
 * `p6AnalyticsInvalidationContract.test.js`.
 */
const ANALYTICS_VOLATILE_SETTINGS_KEYS = new Set([
  // Device integrity telemetry, rewritten every launch.
  'rasp_checked_at', 'rasp_secure', 'rasp_threats', 'rasp_native',
  // OSRM reachability probe results.
  'osrm_health_status', 'osrm_last_health_checked_at',
  'osrm_last_health_error', 'osrm_last_reachable_at',
  // Native privacy-zone sync progress. The zones themselves still count.
  'privacy_zones_native_sync_status', 'privacy_zones_native_sync_failed_at',
  'privacy_zones_native_sync_zone_count',
]);

/**
 * The analytics-relevant projection of settings: a **positive** list of the keys
 * the D1 contribution actually reads (`CARBON_ANALYTICS_SETTINGS_KEYS`), in a fixed
 * order, missing values as `null`.
 *
 * DPD-033. The version used to hash every key except `ANALYTICS_VOLATILE_SETTINGS_KEYS`,
 * so dark mode, a map pan (`last_map_center`), experience mode or units demoted
 * `D1_ANALYTICS:all` and re-swept all history — 73 ms after a dark-mode switch on
 * the 3,000-trip A54. None of those is read by the contribution. The volatile set
 * above is now the record of DPD-028: none of its keys is an analytics input, so
 * the positive projection cannot contain them.
 */
const analyticsSettingsProjection = (settings) => Object.fromEntries(
  CARBON_ANALYTICS_SETTINGS_KEYS.map((key) => [key, settings?.[key] ?? null])
);

/**
 * DPD-032. The vehicle fields the contribution reads (`CARBON_ANALYTICS_VEHICLE_FIELDS`),
 * ordered by id (`getAllForReference` makes no ordering promise). Hashing whole
 * vehicle objects made an odometer auto-sync, or restoring an unchanged fleet,
 * re-sweep all history.
 */
const analyticsVehicleProjection = (vehicles) => [...(Array.isArray(vehicles) ? vehicles : [])]
  .sort((left, right) => String(left?.id ?? '').localeCompare(String(right?.id ?? '')))
  .map((vehicle) => Object.fromEntries(
    CARBON_ANALYTICS_VEHICLE_FIELDS.map((field) => [field, vehicle?.[field] ?? null])
  ));

const readAnalyticsSettingsSnapshot = async () => {
  const [{ localSettings }, { localVehicleRepository }] = await Promise.all([
    import('@/lib/trackingStore'),
    import('@/lib/localVehicleRepository'),
  ]);
  const settings = localSettings.get();
  // HPR-003. Derived analytics resolve a trip's vehicle by reference, so the
  // authority has to be the complete collection: a 500-row prefix silently made
  // a beyond-prefix vehicle unavailable and zeroed its carbon contribution.
  const vehicles = await localVehicleRepository.getAllForReference();
  return {
    settings,
    vehicles,
    settingsVersion: await hashP6Source({
      settings: analyticsSettingsProjection(settings),
      vehicles: analyticsVehicleProjection(vehicles),
    }),
  };
};

export const __testables = {
  analyticsSettingsProjection,
  analyticsVehicleProjection,
  ANALYTICS_VOLATILE_SETTINGS_KEYS,
  // Exposed so the paged-retirement resume can be exercised directly. Driving
  // it through a whole trip build made the fixture, not the paging, the subject
  // of the test — and the paging is what failed on device (DPD-015).
  deleteSupersededPage,
  compareIndexedDbKeys,
};

/**
 * Keyset page over canonical subject identities that materializes no record.
 *
 * `openKeyCursor` yields primary keys, so a page of 32 costs 32 keys instead of
 * 32 whole trip rows. That distinction is half of DPD-015B: the settings
 * rediscovery turn used to walk 33 *values* to learn 33 *identities*, and at
 * 500 trips those values are megabytes of `encrypted_payload`.
 */
export async function listP6BrowserCanonicalSubjectKeyPage({ afterKey = null, maxItems = 32 } = {}) {
  const limit = Math.max(1, Math.min(64, Number(maxItems) || 32));
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_SOURCE_STORE, 'readonly');
    const store = tx.objectStore(P6_TRIP_SOURCE_STORE);
    const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
    const keys = await new Promise((resolve, reject) => {
      const found = [];
      // `openKeyCursor` is the point of this function; the value cursor is only
      // a fallback for a store double that does not implement it.
      const request = store.openKeyCursor ? store.openKeyCursor(range) : store.openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || found.length >= limit + 1) return resolve(found);
        found.push(String(cursor.primaryKey));
        cursor.continue();
      };
    });
    await transactionDone(tx);
    const page = keys.slice(0, limit);
    return {
      ids: page,
      nextCursor: keys.length > limit ? page.at(-1) || null : null,
      itemsWorked: page.length,
    };
  } finally { db.close(); }
}

/** Terminal work states a re-queued analytics-only subject may be restored to. */
const P6_ANALYTICS_ONLY_RESTORABLE_STATES = Object.freeze(['COMPLETE', P6_EXPLICIT_SOURCE_REQUIRED]);

/**
 * Return an analytics-only re-queue to the terminal state it was queued from.
 *
 * DPD-020. The restore is fenced the same way the park is: the compare and the
 * write stay inside native request callbacks, and a row whose revision or
 * disposition moved while D1 was publishing is left alone — a canonical write
 * that landed during the turn owns the row, and re-parking it would discard a
 * revision nothing would come back for. `false` means "not restored", and the
 * caller then takes the ordinary build path.
 *
 * @returns {Promise<boolean>}
 */
const restoreAnalyticsOnlyTerminalState = async (work) => {
  const terminal = String(work?.analyticsOnlyTerminalState || '');
  if (!P6_ANALYTICS_ONLY_RESTORABLE_STATES.includes(terminal)) return false;
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    let restored = false;
    const request = store.get(work.tripId);
    request.onsuccess = () => {
      const current = request.result;
      if (!current || current.disposition === 'TOMBSTONE') return;
      if (String(current.desiredRevision ?? '') !== String(work.desiredRevision ?? '')) return;
      if (String(current.analyticsOnlyTerminalState || '') !== terminal) return;
      // The marker rides a `{...work}` spread, so another writer can re-dirty
      // this row and carry it forward — derived-storage reclamation does exactly
      // that when it reclaims a geometry chunk. Restoring then would put the row
      // straight back to its terminal state and silently abandon the rebuild that
      // writer asked for. A row still narrowed to D1 alone is one this turn owns;
      // anything wider belongs to whoever widened it.
      const owned = Array.isArray(current.dirtyDomains)
        && current.dirtyDomains.length === 1
        && current.dirtyDomains[0] === P6_DOMAIN_KEYS.ANALYTICS;
      if (!owned) return;
      const { analyticsOnlyTerminalState: _consumed, ...rest } = current;
      store.put({
        ...rest,
        state: terminal,
        cursor: null,
        appliedRevision: work.desiredRevision,
        updatedAt: Date.now(),
      });
      restored = true;
    };
    await transactionDone(tx);
    return restored;
  } finally { db.close(); }
};

/**
 * Re-queue canonical subjects for a bounded rebuild.
 *
 * **DPD-015B — bounded bytes.** The old implementation read every subject's
 * whole source row (`encrypted_payload` and all) twice, plus a third read for
 * the revision fence, purely to recompute a content token. At 500 trips one
 * turn reported `bytesWorked` 7,739,924 against a declared
 * `P6_TURN_BUDGET.bytes` of 4,194,304; the coordinator treats a budget overrun
 * as a *contract violation*, so it skipped retry-with-backoff, installed no
 * wake and destroyed the job instance — one external lifecycle trigger bought
 * exactly one burst. The canonical writer mints the work row and the source row
 * in the same transaction, so a work row standing at the subject's current
 * revision already carries a `sourceHash` over exactly those bytes. Reusing it
 * is not an accounting trick: the payload is genuinely not read.
 *
 * When the payload *is* genuinely needed the turn stops **before** the read if
 * less than `P6_SOURCE_READ_RESERVE_BYTES` of its budget remains, persists its
 * position and continues on the next turn. A single indivisible unit larger
 * than the whole budget still runs when nothing else has been charged to the
 * turn — that is the only way to guarantee forward progress — and the turn then
 * ends, reporting a fully consumed budget with the true figure disclosed in
 * `oversizedUnitBytes` rather than a cheap-looking understatement.
 *
 * **DPD-020 — parked debt stays parked.** `EXPLICIT_SOURCE_REQUIRED` means the
 * point-derived domains defer to an explicit pass. The old implementation wrote
 * `state: 'DIRTY'` blindly over whatever the work row said, so a settings
 * rediscovery — which invalidates D1 and nothing else — dragged 32 parked
 * subjects back into general dirty debt on every pass (the observed
 * DIRTY 1 → 32 / parked 499 → 468 movement). Under `parkedPolicy: 'PRESERVE'`
 * a parked subject is re-queued for D1 alone and carries the terminal state it
 * must return to, so its D2/D3/D4 debt is never re-derived and never lost.
 * The explicit repair keeps `parkedPolicy: 'REMINT'`: re-minting parked
 * subjects is precisely what it exists to do.
 *
 * @param {Array<string|{id?: string, tripId?: string, source_revision?: unknown}>} rows
 * @param {string[]} domains
 * @param {{maxBytes?: number, parkedPolicy?: 'REMINT'|'PRESERVE'}} [options]
 */
export async function queueP6ExplicitTripSubjects(
  rows = [],
  domains = Object.values(P6_DOMAIN_KEYS),
  options = {},
) {
  const requestedDomains = [...new Set((domains || []).filter((domain) => Object.values(P6_DOMAIN_KEYS).includes(domain)))];
  const declaredBytes = Number(options?.maxBytes);
  const maxBytes = Number.isFinite(declaredBytes) ? Math.max(0, declaredBytes) : Infinity;
  const preserveParked = options?.parkedPolicy === 'PRESERVE';
  const analyticsOnly = requestedDomains.length === 1
    && requestedDomains[0] === P6_DOMAIN_KEYS.ANALYTICS;
  let queued = 0;
  let examined = 0;
  /** Parked subjects left untouched, and parked subjects re-queued for D1 and
   * carrying the park forward. Two different outcomes, counted apart so a
   * caller cannot mistake one for the other. */
  let parkedLeftAlone = 0;
  let parkedRequeued = 0;
  let alreadyInFlight = 0;
  let bytesWorked = 0;
  let payloadReads = 0;
  let oversizedUnitBytes = 0;
  /** The last identity this call is answerable for; the caller resumes after it. */
  let lastKey = null;
  let deferred = false;

  // The page cap belongs to the caller, and silently dropping a tail here would
  // strand subjects: `stepAnalyticsSettingsRediscovery` advances `afterKey` to
  // the page's own `nextCursor` when the queue reports it drained the page, so a
  // dropped tail would never be revisited for that settings version.
  const pageLimit = Math.max(1, Math.min(64, Number(options?.maxItems) || 32));
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, pageLimit)) {
    const tripId = typeof row === 'string' ? row : String(row?.id || row?.tripId || '');
    if (!tripId) continue;

    const db = await openP6TripDerivedDatabase();
    let existing;
    try {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readonly');
      existing = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).get(tripId));
      await transactionDone(tx);
    } finally { db.close(); }

    const declaredRevision = row && typeof row === 'object' && row.source_revision != null
      ? String(row.source_revision)
      : null;
    const reusable = Boolean(existing)
      && existing.disposition !== 'TOMBSTONE'
      && Boolean(existing.sourceHash)
      && (declaredRevision === null || String(existing.desiredRevision ?? '') === declaredRevision);

    // A subject already in flight is going to be rebuilt across every domain it
    // owns, and its D1 contribution is re-published as the first step of that
    // build. Narrowing such a row to D1 would silently drop the geometry work it
    // was already carrying, so rediscovery leaves in-flight rows alone.
    //
    // This is decided BEFORE any payload read, because the test needs only the
    // work row. Deciding it afterwards read a whole `encrypted_payload` and threw
    // it away, and the early exit skipped the overrun cap below — so the wasted
    // read was also reported uncapped, which is the contract violation this
    // function exists to remove.
    const inFlight = Boolean(existing)
      && !P6_ANALYTICS_ONLY_RESTORABLE_STATES.includes(String(existing.state ?? ''));
    if (preserveParked && inFlight) {
      examined += 1;
      alreadyInFlight += 1;
      lastKey = tripId;
      bytesWorked += existing ? encodedJsonBytes(existing) : 0;
      continue;
    }

    let desiredRevision = reusable ? String(existing.desiredRevision ?? '') : null;
    let sourceHash = reusable ? existing.sourceHash : null;
    let unitBytes = existing ? encodedJsonBytes(existing) : 0;
    let sourceRevisionFence = null;

    if (!reusable) {
      // A turn may take at most ONE read of unknown size.
      //
      // A byte reserve is not enough on its own, and the first version of this
      // fix got that wrong: with a 4 MiB budget and a 1 MiB reserve, two 1.5 MB
      // rows leave 1.19 MB "available", so a third 1.5 MB row is read and the
      // turn reports 4.5 MB — the same contract violation this change exists to
      // remove. The reserve cannot bound an accumulation of rows whose sizes are
      // only knowable after reading them. One read per turn can, because the
      // turn's payload cost is then exactly one row, and a single row too big
      // for the whole budget is handled by the oversized-unit rule below.
      //
      // Deferring with nothing charged yet would be a zero-progress
      // continuation, so the first unit of a turn always runs.
      if (payloadReads >= 1 || (bytesWorked > 0 && maxBytes - bytesWorked < P6_SOURCE_READ_RESERVE_BYTES)) {
        deferred = true;
        break;
      }
      let source;
      const readDb = await openP6TripDerivedDatabase();
      try {
        const tx = readDb.transaction(P6_TRIP_SOURCE_STORE, 'readonly');
        source = await requestResult(tx.objectStore(P6_TRIP_SOURCE_STORE).get(tripId));
        await transactionDone(tx);
      } finally { readDb.close(); }
      if (!source) { examined += 1; lastKey = tripId; continue; }
      payloadReads += 1;
      const sourceBytes = encodedJsonBytes(source);
      unitBytes += sourceBytes;
      desiredRevision = String(source.source_revision ?? declaredRevision ?? '');
      sourceHash = await hashP6Source(source);
      sourceRevisionFence = String(source.source_revision ?? '');
    }

    const parked = existing?.state === P6_EXPLICIT_SOURCE_REQUIRED;
    const restoreTerminalState = preserveParked
      && analyticsOnly
      && P6_ANALYTICS_ONLY_RESTORABLE_STATES.includes(String(existing?.state ?? ''))
      ? String(existing.state)
      : null;

    const writeDb = await openP6TripDerivedDatabase();
    try {
      const stores = sourceRevisionFence === null
        ? [P6_TRIP_DERIVED_STORES.WORK]
        : [P6_TRIP_SOURCE_STORE, P6_TRIP_DERIVED_STORES.WORK];
      const tx = writeDb.transaction(stores, 'readwrite');
      // The fence compares what this call decided against on re-read. With a
      // reused hash that is the work row itself, which the canonical writer
      // rewrites in the same transaction as the source row; with a fresh hash
      // it is the source revision the hash was taken over.
      const current = sourceRevisionFence === null
        ? await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).get(tripId))
        : await requestResult(tx.objectStore(P6_TRIP_SOURCE_STORE).get(tripId));
      const fenceHolds = sourceRevisionFence === null
        ? Boolean(current)
          && current.disposition !== 'TOMBSTONE'
          && String(current.desiredRevision ?? '') === desiredRevision
          && String(current.state ?? '') === String(existing?.state ?? '')
        : Boolean(current) && String(current.source_revision) === sourceRevisionFence;
      if (fenceHolds) {
        if (preserveParked && parked && !analyticsOnly) {
          // Rediscovery is not an explicit pass and may not un-park a subject
          // for domains only an explicit pass can rebuild. Today's PRESERVE
          // caller is always analytics-only, so this is a rail rather than a
          // live path — and it is the rail that keeps DPD-020 fixed if a wider
          // invalidation is ever routed through the lifecycle.
          parkedLeftAlone += 1;
        } else {
          tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
            tripId,
            desiredRevision,
            sourceHash,
            desiredSeq: Date.now() + queued,
            disposition: 'UPSERT',
            dirtyDomains: requestedDomains,
            reevaluateCapacityBlocked: requestedDomains.includes(P6_DOMAIN_KEYS.ROAD_LEARNING),
            state: 'DIRTY',
            cursor: null,
            ...(restoreTerminalState ? { analyticsOnlyTerminalState: restoreTerminalState } : {}),
            updatedAt: Date.now(),
          });
          queued += 1;
          if (parked) parkedRequeued += 1;
        }
      }
      await transactionDone(tx);
    } finally { writeDb.close(); }

    examined += 1;
    lastKey = tripId;
    bytesWorked += unitBytes;
    // The subject is queued and `lastKey` is set before this check, so an
    // overrun still ends the turn having made forward progress. The report is
    // capped at the budget rather than understated to look cheap, and the true
    // figure travels in `oversizedUnitBytes`.
    if (bytesWorked > maxBytes) {
      oversizedUnitBytes = bytesWorked;
      deferred = true;
      break;
    }
    if (!reusable) { deferred = true; break; }
  }

  return {
    queued,
    examined,
    parkedLeftAlone,
    parkedRequeued,
    alreadyInFlight,
    // An oversized indivisible unit reports a fully consumed turn rather than
    // an understatement; `oversizedUnitBytes` carries what it actually cost.
    bytesWorked: oversizedUnitBytes ? Math.min(bytesWorked, maxBytes) : bytesWorked,
    payloadReads,
    oversizedUnitBytes,
    lastKey,
    deferred,
  };
}

/** Keyset page over canonical browser source identities. It reads no trip
 * payload and is valid even when the optional projection cache is absent. */
export async function listP6BrowserCanonicalSubjectPage({ afterKey = null, maxItems = 32 } = {}) {
  const limit = Math.max(1, Math.min(64, Number(maxItems) || 32));
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_SOURCE_STORE, 'readonly');
    const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
    const rows = await new Promise((resolve, reject) => {
      const found = []; const request = tx.objectStore(P6_TRIP_SOURCE_STORE).openCursor(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || found.length >= limit + 1) return resolve(found);
        found.push({ id: String(cursor.primaryKey), source_revision: cursor.value?.source_revision ?? null });
        cursor.continue();
      };
    });
    await transactionDone(tx);
    const page = rows.slice(0, limit);
    return {
      rows: page,
      nextCursor: rows.length > limit ? page.at(-1)?.id || null : null,
      itemsWorked: page.length,
    };
  } finally { db.close(); }
}

/** Explicit E1/E2 final publication. The operation's durable keyset cursor
 * proves discovery; this transaction serializes the drained-work proof and
 * all requested domain heads against any concurrent canonical mutation. */
export async function finalizeP6BrowserExplicitTripBuild(options = false) {
  const includeRoad = typeof options === 'boolean' ? options : options?.includeRoad === true;
  const defaultDomains = [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY,
    P6_DOMAIN_KEYS.SPATIAL_SELECTION, ...(includeRoad ? [P6_DOMAIN_KEYS.ROAD_LEARNING] : [])];
  const requestedDomains = typeof options === 'object' && Array.isArray(options?.domains)
    ? [...new Set(options.domains.filter((domain) => Object.values(P6_DOMAIN_KEYS).includes(domain)))]
    : defaultDomains;
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([P6_TRIP_DERIVED_STORES.WORK, P6_TRIP_DERIVED_STORES.MANIFESTS], 'readwrite');
    const index = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).index('by_state');
    const activeStates = ['DIRTY', 'BUILDING', 'PREVIEW_BUILD', 'TOMBSTONE_CLEANUP',
      'RETIRE_SUPERSEDED', 'SOURCE_UNREADABLE', P6_EXPLICIT_SOURCE_REQUIRED];
    if (includeRoad) activeStates.push('COMPLETE');
    return await new Promise((resolve, reject) => {
      const counts = new Array(activeStates.length).fill(0);
      let remaining = activeStates.length;
      let pending = 0;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        pending = counts.reduce((sum, value) => sum + Number(value || 0), 0);
        if (!pending) {
          const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
          requestedDomains.forEach((domain) => manifests.put({
            key: `${domain}:all`, domain, subject: 'all',
            sourceBinding: domain === P6_DOMAIN_KEYS.ROAD_LEARNING ? 'browser-v2' : 'browser',
            state: P6_READINESS_STATES.VERIFIED, complete: true, updatedAt: Date.now(),
          }));
        }
      };
      activeStates.forEach((state, stateIndex) => {
        const request = index.count(state);
        request.onerror = () => reject(request.error || new Error('P6_EXPLICIT_FINALIZE_COUNT_FAILED'));
        request.onsuccess = () => { counts[stateIndex] = request.result; apply(); };
      });
      tx.oncomplete = () => resolve({
        state: pending ? P6_READINESS_STATES.PARTIAL : P6_READINESS_STATES.VERIFIED,
        complete: pending === 0, pending, itemsWorked: counts.length,
        bytesWorked: 0, hasMore: pending > 0,
      });
      tx.onerror = () => reject(tx.error || new Error('P6_EXPLICIT_FINALIZE_FAILED'));
      tx.onabort = () => reject(tx.error || new Error('P6_EXPLICIT_FINALIZE_ABORTED'));
    });
  } finally { db.close(); }
}

export async function readP6TripDomainReadiness(domain, subject = 'all') {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.MANIFESTS, 'readonly');
    return await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).get(`${domain}:${subject}`)) || {
      key: `${domain}:${subject}`,
      domain,
      subject,
      state: P6_READINESS_STATES.REBUILD_REQUIRED,
      complete: false,
    };
  } finally {
    db.close();
  }
}

export async function setP6TripDomainReadiness(value) {
  const record = { ...value, key: `${value.domain}:${value.subject || 'all'}`, updatedAt: Date.now() };
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.MANIFESTS, 'readwrite');
    tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put(record);
    await transactionDone(tx);
    return record;
  } finally {
    db.close();
  }
}

export async function invalidateP6AnalyticsForSettings(reason = 'SETTINGS_OR_VEHICLE_CHANGED') {
  const { settingsVersion } = await readAnalyticsSettingsSnapshot();
  if (nativeDerivedStateSelected()) {
    const result = await nativeTripArchive.invalidateP6AnalyticsForSettings(settingsVersion, reason);
    const { admitP6ReviewedWork } = await import('@/lib/appLifecycleWork');
    admitP6ReviewedWork(P6_JOB_KEYS.TRIP_DERIVED_UPDATES, { wake: { type: 'settings', key: settingsVersion } });
    admitP6ReviewedWork(P6_JOB_KEYS.ROAD_MEMORY_UPDATES, { wake: { type: 'settings', key: settingsVersion } });
    return result;
  }
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([P6_TRIP_DERIVED_STORES.CONTROL, P6_TRIP_DERIVED_STORES.MANIFESTS], 'readwrite');
    const control = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
    const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
    // The compare and the revocation it implies must stay inside native request
    // callbacks. Issuing the writes from a promise continuation let a strict
    // user agent auto-commit the idle transaction first, so a settings or
    // vehicle change could leave the D1 head VERIFIED under the old settings -
    // a stale answer with no rediscovery, which is the one outcome the
    // readiness vocabulary forbids.
    const current = await new Promise((resolve, reject) => {
      const repairRequest = control.get(P6_ANALYTICS_SETTINGS_REPAIR_KEY);
      const headRequest = manifests.get(`${P6_DOMAIN_KEYS.ANALYTICS}:all`);
      let remaining = 2;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const existing = repairRequest.result;
        const head = headRequest.result;
        if (existing?.settingsVersion !== settingsVersion) {
          control.put({
            key: P6_ANALYTICS_SETTINGS_REPAIR_KEY,
            state: 'DIRTY',
            settingsVersion,
            afterKey: null,
            reason,
            updatedAt: Date.now(),
          });
          manifests.put({
            ...(head || {}),
            key: `${P6_DOMAIN_KEYS.ANALYTICS}:all`,
            domain: P6_DOMAIN_KEYS.ANALYTICS,
            subject: 'all',
            sourceBinding: 'browser',
            state: P6_READINESS_STATES.REBUILD_REQUIRED,
            complete: false,
            settingsVersion,
            reason,
            updatedAt: Date.now(),
          });
        }
        resolve(existing);
      };
      for (const request of [repairRequest, headRequest]) {
        request.onsuccess = apply;
        request.onerror = () => reject(request.error || new Error('P6_SETTINGS_INVALIDATION_READ_FAILED'));
      }
    });
    await transactionDone(tx);
    const { admitP6ReviewedWork } = await import('@/lib/appLifecycleWork');
    admitP6ReviewedWork(P6_JOB_KEYS.TRIP_DERIVED_UPDATES, { wake: { type: 'settings', key: settingsVersion } });
    admitP6ReviewedWork(P6_JOB_KEYS.ROAD_MEMORY_UPDATES, { wake: { type: 'settings', key: settingsVersion } });
    // DPD-042. Once the derived-update job has settled for the epoch, the reviewed
    // admission above answers `already_admitted` and creates nothing: on the A54 a
    // fuel-economy change left the D1 re-sweep unstarted (cursor never moved) until
    // the app was reopened. A new settings version changes every D1-backed answer,
    // so it is a P7 source change; publishing it (durably, after the commit above)
    // brings the derived-update follow-up the source-commit subscription requests.
    if (current?.settingsVersion !== settingsVersion) publishP7SourceChange('p6_analytics_settings_invalidated');
    return { settingsVersion, state: current?.settingsVersion === settingsVersion ? current.state : 'DIRTY' };
  } finally { db.close(); }
}

/**
 * One bounded page of the analytics settings rediscovery.
 *
 * DPD-015B. This turn is the one that threw
 * `AppWorkBudgetExceededError: 7739924 > 4194304` on the 500-trip device. Two
 * changes keep it inside its declared budget without hiding anything:
 *
 *  - it walks **identities**, not records, so learning which subjects exist no
 *    longer deserializes a page of `encrypted_payload`; and
 *  - it hands `queueP6ExplicitTripSubjects` the turn's remaining byte budget,
 *    so a page that genuinely has to read payloads stops before overrunning it,
 *    persists `afterKey`, and resumes on the next turn.
 *
 * DPD-020. A settings change invalidates D1 and only D1, so the page is queued
 * for `ANALYTICS` alone under `parkedPolicy: 'PRESERVE'`. Compatibility-parked
 * subjects therefore get their contribution re-published under the new settings
 * without their D2/D3/D4 debt being re-derived or lost.
 */
const stepAnalyticsSettingsRediscovery = async (limit = 32) => {
  const db = await openP6TripDerivedDatabase();
  let repair;
  try {
    const controlTx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    repair = await requestResult(controlTx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL)
      .get(P6_ANALYTICS_SETTINGS_REPAIR_KEY));
    await transactionDone(controlTx);
    if (repair?.state !== 'DIRTY') return { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };
  } finally { db.close(); }

  const page = await listP6BrowserCanonicalSubjectKeyPage({
    afterKey: repair.afterKey ?? null,
    maxItems: limit,
  });
  const queued = await queueP6ExplicitTripSubjects(page.ids, [P6_DOMAIN_KEYS.ANALYTICS], {
    maxBytes: P6_TURN_BUDGET.bytes,
    maxItems: limit,
    parkedPolicy: 'PRESERVE',
  });
  // The page is only finished when the queue drained all of it. A deferral is a
  // continuation from the last identity this turn is answerable for, so no
  // subject is skipped and none is re-queued twice.
  const pageComplete = !queued.deferred;
  const more = pageComplete ? Boolean(page.nextCursor) : true;
  const afterKey = pageComplete ? page.nextCursor : (queued.lastKey ?? repair.afterKey ?? null);

  const writeDb = await openP6TripDerivedDatabase();
  try {
    const writeTx = writeDb.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
    const control = writeTx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
    const latest = await requestResult(control.get(P6_ANALYTICS_SETTINGS_REPAIR_KEY));
    if (latest?.settingsVersion === repair.settingsVersion) {
      control.put({
        ...latest,
        state: more ? 'DIRTY' : 'COMPLETE',
        afterKey: more ? afterKey : null,
        updatedAt: Date.now(),
      });
    }
    await transactionDone(writeTx);
  } finally { writeDb.close(); }

  return {
    state: more ? 'SETTINGS_REDISCOVERY' : 'SETTINGS_REDISCOVERY_COMPLETE',
    itemsWorked: Number(page.itemsWorked || 0) + 1 + Number(queued.queued || 0),
    bytesWorked: Number(queued.bytesWorked || 0),
    // A capped report without its companion figure is an understatement, so the
    // disclosure travels with it rather than dying inside the queue.
    ...(queued.oversizedUnitBytes ? { oversizedUnitBytes: queued.oversizedUnitBytes } : {}),
    hasMore: true,
  };
};

const finalizeP6BrowserIncrementalDomains = async () => {
  const db = await openP6TripDerivedDatabase();
  try {
    const stores = [P6_TRIP_DERIVED_STORES.WORK, P6_TRIP_DERIVED_STORES.MANIFESTS,
      P6_TRIP_DERIVED_STORES.CONTROL];
    const tx = db.transaction(stores, 'readwrite');
    const work = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).index('by_state');
    const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
    const domains = [P6_DOMAIN_KEYS.ANALYTICS, P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION];
    // The debt counts and the dependent head writes must stay inside native
    // IndexedDB request callbacks. A promise continuation may run after a
    // strict user agent has auto-committed an otherwise idle readwrite
    // transaction, which would either lose the head write or split the compare
    // from it and let a concurrent turn dirty a domain in between.
    const verified = await new Promise((resolve, reject) => {
      const requests = [
        work.count('DIRTY'),
        work.count('BUILDING'),
        work.count('PREVIEW_BUILD'),
        work.count('TOMBSTONE_CLEANUP'),
        work.count('RETIRE_SUPERSEDED'),
        work.count('SOURCE_UNREADABLE'),
        work.count(P6_EXPLICIT_SOURCE_REQUIRED),
        tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).get(P6_ANALYTICS_SETTINGS_REPAIR_KEY),
        ...domains.map((domain) => manifests.get(`${domain}:all`)),
      ];
      let remaining = requests.length;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const [dirty, building, preview, cleanup, retiring, unreadable, deferred, repair,
          ...heads] = requests.map((item) => item.result);
        // An unreadable subject is outstanding work, not a finished domain: a
        // head must never read VERIFIED while a subject it covers is unread.
        if (dirty + building + preview + cleanup + retiring + unreadable > 0) { resolve(null); return; }
        let count = 0;
        domains.forEach((domain, index) => {
          const head = heads[index];
          // A subject parked for an explicit pass is settled for D1 and unbuilt
          // for the point-derived domains. Promoting D2/D3 here would claim
          // coverage the derived store does not have and, worse, would withdraw
          // the legal v1 compatibility route those trips are still served by.
          if (deferred > 0 && domain !== P6_DOMAIN_KEYS.ANALYTICS) return;
          const incremental = [P6_READINESS_STATES.DIRTY, P6_READINESS_STATES.PARTIAL].includes(head?.state);
          const settingsRepair = domain === P6_DOMAIN_KEYS.ANALYTICS
            && head?.state === P6_READINESS_STATES.REBUILD_REQUIRED
            && repair?.state === 'COMPLETE'
            && head?.settingsVersion === repair?.settingsVersion;
          if (!incremental && !settingsRepair) return;
          manifests.put({
            ...head,
            key: `${domain}:all`, domain, subject: 'all', sourceBinding: 'browser',
            state: P6_READINESS_STATES.VERIFIED, complete: true,
            ...(domain === P6_DOMAIN_KEYS.ANALYTICS && repair?.settingsVersion
              ? { settingsVersion: repair.settingsVersion } : {}),
            updatedAt: Date.now(),
          });
          count += 1;
        });
        resolve(count);
      };
      requests.forEach((request) => {
        request.onsuccess = apply;
        request.onerror = () => reject(request.error || new Error('P6_FINALIZE_READ_FAILED'));
      });
    });
    await transactionDone(tx);
    if (verified === null) return { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };
    // DPD-024: a `:all` head only reaches VERIFIED here from DIRTY, PARTIAL or a
    // settings rebuild, so a non-zero count is a real transition rather than an
    // idempotent rewrite. That transition is the moment the lifetime aggregate
    // becomes authoritative, and it is the only moment the Dashboard's cached
    // aggregate is wrong. Publish on the existing source-change channel so the
    // query cache invalidates itself; every other publisher is a trip write, so
    // background convergence had no way to say it had finished.
    if (verified > 0) publishP7SourceChange('p6_domain_head_verified');
    return { state: verified ? P6_READINESS_STATES.VERIFIED : 'IDLE', itemsWorked: verified,
      bytesWorked: 0, hasMore: false };
  } finally { db.close(); }
};

/** One bounded E1 reset turn. Contributions are removed with their exact D1
 * receipts and order membership before aggregate buckets are discarded. */
/**
 * AUD-007 round 5: this turn captures the outgoing key version, encrypts, and commits
 * durably — so it holds admission for the whole span. Without it a finalizer sees no
 * admitted writer, proves zero, deletes the version, and the turn then publishes durable
 * ciphertext under a destroyed key. The turn is bounded, so the token is held briefly.
 */
export async function resetP6BrowserAnalyticsDerivedTurn(phase = 'CONTRIBUTIONS', limit = 64) {
  return withDurableKeyPublication(async () => {
    const maximum = Math.max(1, Math.min(128, Number(limit) || 64));
    const db = await openP6TripDerivedDatabase();
    try {
      if (phase === 'CONTRIBUTIONS') {
        const stores = [P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, P6_TRIP_DERIVED_STORES.SOURCE_APPLIED,
          P6_TRIP_DERIVED_STORES.RECENT_ORDER, P6_TRIP_DERIVED_STORES.MANIFESTS];
        const tx = db.transaction(stores, 'readwrite');
        const contributions = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS);
        const applied = tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED);
        const recent = tx.objectStore(P6_TRIP_DERIVED_STORES.RECENT_ORDER);
        const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
        const outcome = await new Promise((resolve, reject) => {
          let removed = 0; let bytesWorked = 0;
          const request = contributions.openCursor();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || removed >= maximum) return resolve({ removed, bytesWorked, hasMore: Boolean(cursor) });
            const value = cursor.value || {}; const tripId = String(value.tripId || '');
            bytesWorked += encodedJsonBytes(value);
            if (tripId) {
              applied.delete(`D1:browser:${tripId}`);
              manifests.delete(`${P6_DOMAIN_KEYS.ANALYTICS}:${tripId}`);
            }
            if (value.recentKey) recent.delete(value.recentKey);
            cursor.delete(); removed += 1; cursor.continue();
          };
        });
        await transactionDone(tx);
        return { state: 'RESETTING', phase: outcome.hasMore ? 'CONTRIBUTIONS' : 'BUCKETS',
          itemsWorked: outcome.removed, bytesWorked: outcome.bytesWorked, hasMore: true };
      }
      const tx = db.transaction([P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS,
        P6_TRIP_DERIVED_STORES.MANIFESTS], 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).clear();
      tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
        key: `${P6_DOMAIN_KEYS.ANALYTICS}:all`, domain: P6_DOMAIN_KEYS.ANALYTICS,
        subject: 'all', state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
        reason: 'E1_EXACT_REBUILD', updatedAt: Date.now(),
      });
      await transactionDone(tx);
      return { state: 'RESET_COMPLETE', phase: 'COMPLETE', itemsWorked: 2, bytesWorked: 0, hasMore: false };
    } finally { db.close(); }
  });
}

export const isP6SpatialSelectionReady = async () => {
  const state = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, 'all');
  return state.state === P6_READINESS_STATES.VERIFIED && state.complete === true;
};

const requestId = () => globalThis.crypto?.randomUUID?.()
  || `p6-selection-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const p6GridCellsForDescriptor = async (descriptor) => {
  const { geohashBounds } = await import('@/lib/localSpeedKnowledge');
  const sourcePoints = [
    ...(Array.isArray(descriptor?.sectionPoints) ? descriptor.sectionPoints : []),
    ...(Number.isFinite(Number(descriptor?.lat)) && Number.isFinite(Number(descriptor?.lng))
      ? [{ lat: Number(descriptor.lat), lng: Number(descriptor.lng) }] : []),
  ].filter(finitePoint);
  const cells = new Set();
  const size = 0.00135;
  const latitudeCellCount = Math.ceil(180 / size);
  const longitudeCellCount = Math.ceil(360 / size);
  const addPaddedPoint = (point, radiusM = 45) => {
    // An out-of-range coordinate is not a location. Clamping one into the pole
    // instead made a 45 m radius cover every longitude at cos(90) and expand to
    // millions of cells, so an invalid input is skipped outright.
    const rawLatitude = Number(point.lat);
    const rawLongitude = Number(point.lng);
    if (!Number.isFinite(rawLatitude) || !Number.isFinite(rawLongitude)) return;
    if (Math.abs(rawLatitude) > 90 || Math.abs(rawLongitude) > 180) return;
    const latitude = Math.max(-90, Math.min(90, rawLatitude));
    let longitude = rawLongitude;
    while (longitude < -180) longitude += 360;
    while (longitude >= 180) longitude -= 360;
    const latIndex = Math.floor((latitude + 90) / size);
    const lngIndex = Math.floor((longitude + 180) / size);
    const latPad = Math.max(1, Math.ceil((radiusM / 111320) / size));
    const cosine = Math.max(0.000001, Math.abs(Math.cos(latitude * Math.PI / 180)));
    // Near the poles the padded span wraps the whole globe. One ring is the
    // most that can exist, so the loop can never be asked to walk more.
    const lngPad = Math.min(
      longitudeCellCount,
      Math.max(1, Math.ceil((radiusM / (111320 * cosine)) / size)),
    );
    for (let lat = Math.max(0, latIndex - latPad); lat <= Math.min(latitudeCellCount - 1, latIndex + latPad); lat += 1) {
      for (let offset = -lngPad; offset <= lngPad; offset += 1) {
        const lng = ((lngIndex + offset) % longitudeCellCount + longitudeCellCount) % longitudeCellCount;
        cells.add(`${lat}:${lng}`);
      }
    }
  };
  const matchRadiusM = descriptor?.kind === 'exclusion' && !descriptor?.sectionPoints?.length ? 350 : 45;
  sourcePoints.forEach((point) => addPaddedPoint(point, matchRadiusM));
  for (let index = 1; index < sourcePoints.length; index += 1) {
    const start = sourcePoints[index - 1];
    const end = sourcePoints[index];
    let deltaLng = Number(end.lng) - Number(start.lng);
    if (deltaLng > 180) deltaLng -= 360;
    if (deltaLng < -180) deltaLng += 360;
    const steps = Math.max(1, Math.ceil(Math.max(
      Math.abs(Number(end.lat) - Number(start.lat)), Math.abs(deltaLng),
    ) / (size / 2)));
    for (let step = 1; step < steps; step += 1) addPaddedPoint({
      lat: Number(start.lat) + (Number(end.lat) - Number(start.lat)) * step / steps,
      lng: Number(start.lng) + deltaLng * step / steps,
    }, matchRadiusM);
  }
  let bounds = null;
  if (descriptor?.geohash) {
    try { bounds = geohashBounds(String(descriptor.geohash)); } catch { bounds = null; }
  }
  if (bounds) {
    const padding = 350 / 111320;
    const minLat = Math.floor((Math.max(-90, bounds.minLat - padding) + 90) / size);
    const maxLat = Math.floor((Math.min(90, bounds.maxLat + padding) + 90) / size);
    const minLng = Math.floor((bounds.minLng - padding + 180) / size);
    const maxLng = Math.floor((bounds.maxLng + padding + 180) / size);
    for (let lat = minLat; lat <= maxLat; lat += 1) for (let lng = minLng; lng <= maxLng; lng += 1) {
      cells.add(`${lat}:${((lng % longitudeCellCount) + longitudeCellCount) % longitudeCellCount}`);
    }
  }
  return [...cells];
};

/**
 * D3 retirement boundary.
 *
 * A refusal that names a `reason` is a demotion: the domain had claimed
 * spatial coverage and has now revoked it, so the caller must take the typed
 * disposition rather than re-entering the retired history discovery scan. A
 * refusal with no reason is a domain that never claimed coverage, which is the
 * only case where the bounded compatibility scan is still legal.
 */
/**
 * AUD-007 round 5: this turn captures the outgoing key version, encrypts, and commits
 * durably — so it holds admission for the whole span. Without it a finalizer sees no
 * admitted writer, proves zero, deletes the version, and the turn then publishes durable
 * ciphertext under a destroyed key. The turn is bounded, so the token is held briefly.
 */
export async function createP6AffectedTripSelectionRequest({
  descriptors = [], reason, knowledgeMetadata = {}, continuation = null,
} = {}) {
  return withDurableKeyPublication(async () => {
    const requests = [];
    if (nativeDerivedStateSelected()) {
      const groupId = String(continuation?.groupId || requestId());
      let pageOrdinal = 0;
      for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
        const descriptor = descriptors[descriptorIndex];
        const cells = [...new Set(await p6GridCellsForDescriptor(descriptor))].sort();
        for (let offset = 0; offset < cells.length; offset += 4096) {
          const nativeRequestId = `${groupId}:${pageOrdinal}`;
          let accepted;
          try {
            accepted = await nativeTripArchive.createP6AffectedSelection({
              requestId: nativeRequestId,
              cells: cells.slice(offset, offset + 4096), descriptors: [descriptor], reason, knowledgeMetadata,
            });
          } catch (error) {
            return {
              state: P6_READINESS_STATES.REBUILD_REQUIRED,
              accepted: false,
              reason: 'SPATIAL_SELECTION_REQUEST_PARTIALLY_ACCEPTED',
              partialAcceptance: {
                groupId, committedPages: requests.length, failedDescriptorIndex: descriptorIndex,
                failedOffset: offset, requestIds: requests.map((item) => item?.requestId).filter(Boolean),
                tokenCount: requests.reduce((sum, item) => sum + Number(item?.tokenCount || 0), 0),
                failureCode: error?.code || error?.message || 'NATIVE_SELECTION_REQUEST_FAILED',
              },
            };
          }
          requests.push(accepted);
          if (accepted?.accepted !== true) {
            return {
              state: accepted?.state || P6_READINESS_STATES.REBUILD_REQUIRED,
              accepted: false,
              ...(accepted?.reason ? { reason: accepted.reason } : {}),
              partialAcceptance: {
                groupId, committedPages: requests.filter((item) => item?.accepted === true).length,
                failedDescriptorIndex: descriptorIndex, failedOffset: offset,
                requestIds: requests.filter((item) => item?.accepted === true)
                  .map((item) => item?.requestId).filter(Boolean),
                tokenCount: requests.filter((item) => item?.accepted === true)
                  .reduce((sum, item) => sum + Number(item?.tokenCount || 0), 0),
              },
            };
          }
          pageOrdinal += 1;
        }
      }
      return { state: requests.every((item) => item?.accepted) ? 'READY' : P6_READINESS_STATES.REBUILD_REQUIRED,
        accepted: requests.length > 0 && requests.every((item) => item?.accepted),
        requestIds: requests.map((item) => item?.requestId).filter(Boolean),
        tokenCount: requests.reduce((sum, item) => sum + Number(item?.tokenCount || 0), 0) };
    }
    const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.SPATIAL_SELECTION, 'all');
    if (readiness.state !== P6_READINESS_STATES.VERIFIED || readiness.complete !== true) {
      return { state: readiness.state, accepted: false };
    }
    try {
      return await writeVerifiedP6SelectionRequests(descriptors, reason, knowledgeMetadata, requests);
    } catch (error) {
      // A VERIFIED D3 that cannot record its request has lost the coverage its
      // head advertises. Revoke it here so nothing reads the domain as verified
      // again, and refuse in a named way rather than letting the caller treat
      // the retired all-history scan as the routine steady state.
      await setP6TripDomainReadiness({
        ...readiness,
        domain: P6_DOMAIN_KEYS.SPATIAL_SELECTION,
        subject: 'all',
        state: P6_READINESS_STATES.REBUILD_REQUIRED,
        complete: false,
        storageOutcome: `D3_SELECTION_REQUEST_FAILED:${error?.name || 'Error'}`,
      }).catch(() => {});
      return {
        state: P6_READINESS_STATES.REBUILD_REQUIRED,
        accepted: false,
        reason: 'SPATIAL_SELECTION_UNAVAILABLE',
      };
    }
  });
}

async function writeVerifiedP6SelectionRequests(descriptors, reason, knowledgeMetadata, requests) {
  const secret = await readSpatialSecret();
  const records = [];
  for (const descriptor of descriptors) {
    const cells = [...new Set(await p6GridCellsForDescriptor(descriptor))].sort();
    for (let offset = 0; offset < cells.length; offset += 4096) {
      const tokens = await Promise.all(cells.slice(offset, offset + 4096).map((cell) => hmacCell(secret, cell)));
      const id = requestId();
      const payload = await encryptSensitiveValue({ descriptors: [descriptor], reason, knowledgeMetadata }, `p6:affected-selection:${id}`);
      records.push({
        key: `selection:${id}`, requestId: id, state: 'READY', tokens, payload,
        cursor: { tokenIndex: 0, afterKey: null, candidate: null }, createdAt: Date.now(), updatedAt: Date.now(),
      });
      requests.push({ requestId: id, tokenCount: tokens.length });
    }
  }
  // A descriptor set is one logical rescore obligation. All page records become
  // durable in one transaction, so a page-3 failure cannot leave unreported
  // early pages that a retry would duplicate.
  if (records.length) {
    const db = await openP6TripDerivedDatabase();
    try {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
      const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
      records.forEach((record) => store.put(record));
      await transactionDone(tx);
    } finally { db.close(); }
  }
  return { state: 'READY', accepted: requests.length > 0,
    requestIds: requests.map((item) => item.requestId),
    tokenCount: requests.reduce((sum, item) => sum + item.tokenCount, 0) };
}

const readFirstSelection = async () => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
    return await new Promise((resolve, reject) => {
      const request = store.openCursor(IDBKeyRange.bound('selection:', 'selection:\uffff'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve(null);
        if (['READY', 'BUILDING'].includes(cursor.value?.state)) return resolve(cursor.value);
        cursor.continue();
      };
    });
  } finally { db.close(); }
};

const writeSelection = async (record) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
    tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).put({ ...record, updatedAt: Date.now() });
    await transactionDone(tx);
  } finally { db.close(); }
};

const nextPosting = async (token, afterKey = null) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS, 'readonly');
    const index = tx.objectStore(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS).index('by_cell_trip');
    const lower = afterKey || ['browser', token, '', '', 0];
    const upper = ['browser', token, '\uffff', '\uffff', Number.MAX_SAFE_INTEGER];
    return await new Promise((resolve, reject) => {
      const request = index.openCursor(IDBKeyRange.bound(lower, upper, Boolean(afterKey), false));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ? { value: request.result.value, key: request.result.key } : null);
    });
  } finally { db.close(); }
};

const readGeometryChunk = async (tripId, contentVersion, ordinal) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'readonly');
    const row = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS)
      .get(`${tripId}:${contentVersion}:${ordinal}`));
    if (!row) return null;
    const payload = await decryptSensitiveValue(row.payload, `p6:trip-derived:${tripId}:${contentVersion}:${ordinal}`);
    if (!payload) return payload;
    return { ...payload, points: decodeP6PointBlock(payload.pointBlock ?? payload.points) };
  } finally { db.close(); }
};

/**
 * Revoke the D2 head after a VERIFIED domain failed to serve a bounded page.
 * The head is the only thing that authorises the P6 reader, so a failure that
 * left it VERIFIED would keep offering a result the owner cannot produce.
 */
async function revokeP6GeometryReadiness(readiness, storageOutcome) {
  await setP6TripDomainReadiness({
    ...readiness,
    domain: P6_DOMAIN_KEYS.GEOMETRY,
    subject: 'all',
    state: P6_READINESS_STATES.REBUILD_REQUIRED,
    complete: false,
    storageOutcome,
  }).catch(() => {});
}

export async function queryP6GeometryPreviewPage({ cursor = '', maxTrips = 40 } = {}) {
  if (nativeDerivedStateSelected()) {
    const page = await nativeTripArchive.queryP6GeometryPreviewPage(cursor, maxTrips);
    // A named reason is a demotion of a head that had claimed coverage, so the
    // retired monolithic index is not the steady state the caller falls back
    // to. An unnamed refusal is a domain that never claimed coverage at all.
    return { ...page, compatibilityAllowed: page?.available !== true && !page?.reason };
  }
  const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all');
  if (readiness.state !== P6_READINESS_STATES.VERIFIED || readiness.complete !== true) {
    return {
      state: readiness.state, items: [], nextCursor: null,
      available: false, bounded: true, compatibilityAllowed: true,
    };
  }
  try {
    return await readVerifiedP6GeometryPreviewPage(cursor, maxTrips);
  } catch (error) {
    await revokeP6GeometryReadiness(readiness, `D2_BOUNDED_READ_FAILED:${error?.name || 'Error'}`);
    return {
      state: P6_READINESS_STATES.REBUILD_REQUIRED, items: [], nextCursor: null,
      available: false, bounded: true, compatibilityAllowed: false,
      reason: 'DERIVED_GEOMETRY_UNREADABLE',
    };
  }
}

/**
 * Bounded D2 preview reader used by the existing Speed Limits adapter. The
 * manifest is the visibility head; staged chunks from any other content
 * version are never returned. At most two 128-point chunks are decrypted per
 * trip and the compatibility preview remains capped at 160 points.
 */
async function readVerifiedP6GeometryPreviewPage(cursor, maxTrips) {
  const maximum = Math.max(1, Math.min(80, Number(maxTrips) || 40));
  const prefix = `${P6_DOMAIN_KEYS.GEOMETRY}:`;
  const lower = cursor || prefix;
  const upper = `${P6_DOMAIN_KEYS.GEOMETRY}:\uffff`;
  const db = await openP6TripDerivedDatabase();
  let manifests;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.MANIFESTS, 'readonly');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
    manifests = await new Promise((resolve, reject) => {
      const rows = [];
      const request = store.openCursor(IDBKeyRange.bound(lower, upper, Boolean(cursor), false));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const item = request.result;
        if (!item || rows.length >= maximum + 1) return resolve(rows);
        if (item.value?.subject !== 'all'
          && item.value?.state === P6_READINESS_STATES.VERIFIED
          && item.value?.complete === true) rows.push(item.value);
        item.continue();
      };
    });
  } finally { db.close(); }
  const items = [];
  for (const manifest of manifests.slice(0, maximum)) {
    const points = [];
    for (let ordinal = 0; ordinal < 2 && points.length < 160; ordinal += 1) {
      const chunk = ordinal === 0
        ? await readGeometryChunk(manifest.subject, manifest.contentVersion, -1)
        : null;
      if (!chunk) break;
      points.push(...(chunk.points || []).slice(0, 160 - points.length));
    }
    if (points.length >= 2) items.push({
      id: manifest.subject,
      status: 'completed',
      start_time: manifest.startTime || null,
      end_time: manifest.endTime || null,
      route_points: points,
      geometry_indexed: true,
      p6ContentVersion: manifest.contentVersion,
    });
  }
  return {
    state: P6_READINESS_STATES.VERIFIED,
    items,
    nextCursor: manifests.length > maximum ? manifests[maximum - 1].key : null,
    available: true,
    bounded: true,
    compatibilityAllowed: false,
  };
}

const pointMatchesDescriptors = async (point, descriptors) => {
  const { correctionMatchesPoint, geohashEncode } = await import('@/lib/localSpeedKnowledge');
  return descriptors.some((descriptor) => {
    if (descriptor?.kind === 'cell') return geohashEncode(Number(point.lat), Number(point.lng)) === descriptor.geohash;
    return correctionMatchesPoint(descriptor, Number(point.lat), Number(point.lng), undefined, {
      timestampMs: point.timestamp ?? null, headingDeg: point.heading ?? null, allowLegacyCellMatch: descriptor?.kind === 'exclusion',
    });
  });
};

export async function stepP6AffectedTripSelection() {
  const request = await readFirstSelection();
  if (!request) return { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };
  const detail = await decryptSensitiveValue(request.payload, `p6:affected-selection:${request.requestId}`);
  const cursor = request.cursor || { tokenIndex: 0, afterKey: null, candidate: null };
  if (cursor.candidate) {
    const activeGeometry = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, cursor.candidate.tripId);
    if (activeGeometry.state !== P6_READINESS_STATES.VERIFIED
      || activeGeometry.complete !== true
      || activeGeometry.contentVersion !== cursor.candidate.contentVersion) {
      await writeSelection({ ...request, state: 'BUILDING', cursor: { ...cursor, candidate: null } });
      return { state: 'BUILDING', itemsWorked: 2, bytesWorked: 0, hasMore: true };
    }
    const payload = await readGeometryChunk(cursor.candidate.tripId, cursor.candidate.contentVersion, cursor.candidate.ordinal);
    let matched = false;
    for (const point of payload?.points || []) {
      if (await pointMatchesDescriptors(point, detail.descriptors || [])) { matched = true; break; }
    }
    if (payload && matched) {
      const { enqueueRescoreJob } = await import('@/lib/rescoringQueue');
      await enqueueRescoreJob({
        reason: detail.reason || 'speed_knowledge_rules_changed', tripIds: [cursor.candidate.tripId],
        knowledgeRevision: detail.knowledgeMetadata?.knowledgeRevision,
        knowledgeSchemaVersion: detail.knowledgeMetadata?.schemaVersion,
      });
      // One queue effect per matched subject per request. A trip touches many
      // cells, so without this the same trip was enqueued once per matching
      // posting - a duplicate queue effect the frozen law forbids. The record is
      // written after the queue accepts, so a kill in between can repeat at most
      // the one job the queue itself is the dedupe boundary for.
      await writeSelection({
        ...request,
        state: 'BUILDING',
        matchedTripIds: [...new Set([...(request.matchedTripIds || []), cursor.candidate.tripId])],
        cursor: { ...cursor, candidate: null },
      });
      return { state: 'BUILDING', itemsWorked: (payload.points || []).length + 1, bytesWorked: encodedJsonBytes(payload), hasMore: true };
    }
    if (payload) {
      await writeSelection({ ...request, state: 'BUILDING', cursor: { ...cursor, candidate: { ...cursor.candidate, ordinal: cursor.candidate.ordinal + 1 } } });
      return { state: 'BUILDING', itemsWorked: (payload.points || []).length, bytesWorked: encodedJsonBytes(payload), hasMore: true };
    }
    await writeSelection({ ...request, state: 'BUILDING', cursor: { ...cursor, candidate: null } });
    return { state: 'BUILDING', itemsWorked: 1, bytesWorked: 0, hasMore: true };
  }
  if (cursor.tokenIndex >= request.tokens.length) {
    await writeSelection({ ...request, state: 'COMPLETE', cursor: null });
    return { state: 'COMPLETE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
  }
  const posting = await nextPosting(request.tokens[cursor.tokenIndex], cursor.afterKey);
  if (!posting) {
    await writeSelection({ ...request, state: 'BUILDING', cursor: { tokenIndex: cursor.tokenIndex + 1, afterKey: null, candidate: null } });
    return { state: 'BUILDING', itemsWorked: 1, bytesWorked: 0, hasMore: true };
  }
  // A subject already matched under this request needs no second scan and no
  // second queue entry: advance past its posting instead.
  const alreadyMatched = (request.matchedTripIds || []).includes(posting.value.tripId);
  await writeSelection({ ...request, state: 'BUILDING', cursor: {
    tokenIndex: cursor.tokenIndex, afterKey: posting.key,
    candidate: alreadyMatched
      ? null
      : { tripId: posting.value.tripId, contentVersion: posting.value.contentVersion, ordinal: 0 },
  } });
  return { state: 'BUILDING', itemsWorked: 1, bytesWorked: 0, hasMore: true };
}

/** Native D3 pages opaque postings and authenticated geometry. JavaScript keeps
 * the established correction predicate and acknowledges only after the durable
 * rescore queue accepts a match. */
export async function stepP6NativeAffectedTripSelection() {
  const page = await nativeTripArchive.stepP6AffectedSelection();
  if (page?.state !== 'PRECISE_PAGE') return page;
  let matched = false;
  for (const point of page.points || []) {
    if (await pointMatchesDescriptors(point, page.descriptors || [])) { matched = true; break; }
  }
  if (matched) {
    const { enqueueRescoreJob } = await import('@/lib/rescoringQueue');
    await enqueueRescoreJob({
      reason: page.reason || 'speed_knowledge_rules_changed',
      tripIds: [page.tripId],
      knowledgeRevision: page.knowledgeMetadata?.knowledgeRevision,
      knowledgeSchemaVersion: page.knowledgeMetadata?.schemaVersion,
    });
  }
  const acknowledged = await nativeTripArchive.acknowledgeP6AffectedSelection(page.requestId, matched);
  return {
    ...acknowledged,
    itemsWorked: Number(page.itemsWorked || 0) + Number(acknowledged.itemsWorked || 0),
    bytesWorked: Number(page.bytesWorked || 0) + Number(acknowledged.bytesWorked || 0)
      + encodedJsonBytes({ requestId: page.requestId, matched }),
    hasMore: true,
  };
}

const publishContribution = async (work, trip) => {
  const [{ buildAchievementTripContribution }, snapshot] = await Promise.all([
    import('@/lib/achievementAggregates'),
    readAnalyticsSettingsSnapshot(),
  ]);
  const { settings, vehicles, settingsVersion } = snapshot;
  const contribution = {
    ...buildAchievementTripContribution(trip, settings, vehicles),
    harshBrakesCount: Math.max(0, Number(trip?.harsh_brakes_count) || 0),
    _defensiveGrade: String(trip?.defensive_grade || ''),
  };
  const strictDistance = typeof trip?.distance_km === 'number' && Number.isFinite(trip.distance_km)
    ? trip.distance_km : 0;
  const strictScore = trip?.status === 'completed'
    && typeof trip?.score_overall === 'number' && Number.isFinite(trip.score_overall)
    && strictDistance > 0;
  contribution.scoreDistanceProduct = strictScore ? trip.score_overall * strictDistance : 0;
  contribution.scoreDistanceWeight = strictScore ? strictDistance : 0;
  if (vehicles == null && trip?.co2_saved_kg === null) {
    contribution.carbonCo2SavedKg = 0;
    contribution.carbonEligibleTripCount = 0;
  }
  const bucketKeys = analyticsBucketKeys(trip);
  const key = `browser:${work.tripId}:2`;
  const db = await openP6TripDerivedDatabase();
  try {
    const stores = [
      P6_TRIP_SOURCE_STORE,
      P6_TRIP_DERIVED_STORES.CONTRIBUTIONS,
      P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS,
      P6_TRIP_DERIVED_STORES.RECENT_ORDER,
      P6_TRIP_DERIVED_STORES.MANIFESTS,
      P6_TRIP_DERIVED_STORES.SOURCE_APPLIED,
    ];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const read = db.transaction(stores, 'readonly');
      const source = await requestResult(read.objectStore(P6_TRIP_SOURCE_STORE).get(work.tripId));
      const contributionStore = read.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS);
      const old = await requestResult(contributionStore.get(key));
      const priorApplied = await requestResult(read.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED)
        .get(`D1:browser:${work.tripId}`));
      const allBucketKeys = [...new Set([...(old?.bucketKeys || []), ...bucketKeys])];
      const observedBuckets = new Map(await Promise.all(allBucketKeys.map(async (bucketKey) => [
        bucketKey,
        await requestResult(read.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).get(bucketKey)),
      ])));
      await transactionDone(read);
      if (!source || String(source.source_revision ?? '') !== String(work.desiredRevision)) return false;
      if (!old && priorApplied) {
        await setP6TripDomainReadiness({
          domain: P6_DOMAIN_KEYS.ANALYTICS, subject: work.tripId,
          state: P6_READINESS_STATES.DIRTY, complete: false,
          reason: 'PRIOR_CONTRIBUTION_MISSING',
        });
        return false;
      }
      let previous = null;
      try {
        if (old) previous = await decryptAnalyticsContribution(old);
      } catch (_error) {
        await setP6TripDomainReadiness({
          domain: P6_DOMAIN_KEYS.ANALYTICS, subject: work.tripId,
          state: P6_READINESS_STATES.DIRTY, complete: false,
          reason: 'PRIOR_CONTRIBUTION_CORRUPT',
        });
        return false;
      }
      const nextBucketValues = new Map();
      try {
        for (const bucketKey of allBucketKeys) {
          const row = observedBuckets.get(bucketKey);
          nextBucketValues.set(bucketKey, row ? await decryptAnalyticsBucket(row) : {});
        }
      } catch (_error) {
        await setP6TripDomainReadiness({
          domain: P6_DOMAIN_KEYS.ANALYTICS, subject: work.tripId,
          state: P6_READINESS_STATES.DIRTY, complete: false,
          reason: 'ANALYTICS_BUCKET_CORRUPT',
        });
        return false;
      }
      for (const oldBucketKey of old?.bucketKeys || []) {
        nextBucketValues.set(oldBucketKey, addContribution(nextBucketValues.get(oldBucketKey), previous, -1));
      }
      for (const bucketKey of bucketKeys) {
        nextBucketValues.set(bucketKey, addContribution(nextBucketValues.get(bucketKey), contribution, 1));
      }
      const encryptedBuckets = new Map(await Promise.all([...nextBucketValues].map(async ([bucketKey, value]) => {
        const revisionToken = analyticsRevisionToken();
        const row = { key: bucketKey, revisionToken };
        return [bucketKey, { ...row, payload: await encryptSensitiveValue(value, analyticsBucketContext(row)),
          updatedAt: Date.now() }];
      })));
      const contributionRevisionToken = analyticsRevisionToken();
      const contributionRow = {
        key, tripId: work.tripId, sourceRevision: work.desiredRevision,
        revisionToken: contributionRevisionToken, bucketKeys,
        recentKey: `browser:${String(trip.start_time || '')}:${work.tripId}`,
        settingsVersion, updatedAt: Date.now(),
      };
      contributionRow.payload = await encryptSensitiveValue(
        contribution,
        analyticsContributionContext(contributionRow),
      );
      await requireBrowserP6DerivedStorage(encodedJsonBytes(contributionRow)
        + [...encryptedBuckets.values()].reduce((sum, row) => sum + encodedJsonBytes(row), 0));
      const write = db.transaction(stores, 'readwrite');
      // The compare reads and dependent writes must remain inside native IDB
      // request callbacks. A Promise continuation may run after a strict user
      // agent has auto-committed an otherwise idle readwrite transaction.
      const committed = await new Promise((resolve, reject) => {
        let currentSource; let currentOld; let staleAbort = false;
        const currentBuckets = new Map();
        let remaining = 2 + allBucketKeys.length;
        const fail = (request) => reject(request.error || new Error('P6_ANALYTICS_COMPARE_READ_FAILED'));
        const apply = () => {
          remaining -= 1;
          if (remaining !== 0) return;
          const stale = !currentSource
            || String(currentSource.source_revision ?? '') !== String(work.desiredRevision)
            || !sameAnalyticsRevision(currentOld, old)
            || allBucketKeys.some((bucketKey) => !sameAnalyticsRevision(
              currentBuckets.get(bucketKey), observedBuckets.get(bucketKey),
            ));
          if (stale) { staleAbort = true; write.abort(); return; }
          const writeBuckets = write.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
          encryptedBuckets.forEach((row) => writeBuckets.put(row));
          const recentStore = write.objectStore(P6_TRIP_DERIVED_STORES.RECENT_ORDER);
          if (old?.recentKey) recentStore.delete(old.recentKey);
          if (Number(contribution.completedCount) > 0) recentStore.put({
            key: contributionRow.recentKey, sourceBinding: 'browser',
            startTime: String(trip.start_time || ''), tripId: work.tripId,
            sourceRevision: work.desiredRevision,
          });
          write.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS).put(contributionRow);
          write.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED).put({
            key: `D1:browser:${work.tripId}`, domain: P6_DOMAIN_KEYS.ANALYTICS,
            tripId: work.tripId, sourceRevision: work.desiredRevision,
            sourceHash: work.sourceHash, settingsVersion, appliedAt: Date.now(),
          });
          write.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
            key: `${P6_DOMAIN_KEYS.ANALYTICS}:${work.tripId}`,
            domain: P6_DOMAIN_KEYS.ANALYTICS, subject: work.tripId, sourceBinding: 'browser',
            requiredVersion: work.desiredRevision, appliedVersion: work.desiredRevision,
            state: P6_READINESS_STATES.VERIFIED, complete: true, settingsVersion, updatedAt: Date.now(),
          });
        };
        const sourceRequest = write.objectStore(P6_TRIP_SOURCE_STORE).get(work.tripId);
        sourceRequest.onerror = () => fail(sourceRequest);
        sourceRequest.onsuccess = () => { currentSource = sourceRequest.result; apply(); };
        const oldRequest = write.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS).get(key);
        oldRequest.onerror = () => fail(oldRequest);
        oldRequest.onsuccess = () => { currentOld = oldRequest.result; apply(); };
        allBucketKeys.forEach((bucketKey) => {
          const request = write.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).get(bucketKey);
          request.onerror = () => fail(request);
          request.onsuccess = () => { currentBuckets.set(bucketKey, request.result); apply(); };
        });
        write.oncomplete = () => resolve(true);
        write.onerror = () => { if (!staleAbort) reject(write.error || new Error('P6_ANALYTICS_PUBLISH_FAILED')); };
        write.onabort = () => { if (staleAbort) resolve(false);
          else reject(write.error || new Error('P6_ANALYTICS_PUBLISH_ABORTED')); };
      });
      if (!committed) continue;
      return true;
    }
    return false;
  } finally {
    db.close();
  }
};

const readRecentAnalyticsRows = async ({ lower = null, upper = null, limit = null } = {}) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.RECENT_ORDER, 'readonly');
    const index = tx.objectStore(P6_TRIP_DERIVED_STORES.RECENT_ORDER).index('by_source_start_id');
    const range = lower || upper
      ? IDBKeyRange.bound(
          ['browser', lower || '', ''],
          ['browser', upper || '\uffff', '\uffff'],
          false,
          false
        )
      : IDBKeyRange.bound(['browser', '', ''], ['browser', '\uffff', '\uffff']);
    return await new Promise((resolve, reject) => {
      const rows = [];
      const request = index.openCursor(range, 'prev');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || (limit != null && rows.length >= limit)) return resolve(rows);
        rows.push(cursor.value);
        cursor.continue();
      };
    });
  } finally { db.close(); }
};

/** Revision-exact D1 facade. Returns null until the all-history D1 head is verified. */
export async function readP6AchievementStats({ now = Date.now() } = {}) {
  if (nativeDerivedStateSelected()) {
    const result = await nativeTripArchive.queryP6AchievementStats(now);
    if (result?.available !== true || result?.state !== P6_READINESS_STATES.VERIFIED) return null;
    const { available: _available, state: _state, ...stats } = result;
    return stats;
  }
  try {
  const readiness = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, 'all');
  if (readiness.state !== P6_READINESS_STATES.VERIFIED || readiness.complete !== true) return null;
  const db = await openP6TripDerivedDatabase();
  let global = null;
  const fullHourBucketRows = [];
  const cutoff = now - 7 * 86400000;
  const firstFullHour = Math.ceil(cutoff / 3600000) * 3600000;
  const lastHour = Math.floor(now / 3600000) * 3600000;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readonly');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
    const globalRow = await requestResult(store.get('browser:global:2'));
    const rowRequests = [];
    for (let hour = firstFullHour; hour <= lastHour; hour += 3600000) {
      const key = `browser:utc-hour:${new Date(hour).toISOString().slice(0, 13)}:2`;
      rowRequests.push(requestResult(store.get(key)));
    }
    fullHourBucketRows.push(...(await Promise.all(rowRequests)).filter(Boolean));
    await transactionDone(tx);
    global = globalRow ? await decryptAnalyticsBucket(globalRow) : null;
  } finally { db.close(); }
  if (!global) throw new Error('P6_ANALYTICS_GLOBAL_BUCKET_MISSING');
  const fullHourBuckets = await Promise.all(fullHourBucketRows.map(decryptAnalyticsBucket));
  const boundaryStartMs = Math.floor(cutoff / 3600000) * 3600000;
  const boundaryRows = firstFullHour > boundaryStartMs
    ? await readRecentAnalyticsRows({
        lower: new Date(boundaryStartMs).toISOString(),
        upper: new Date(firstFullHour - 1).toISOString(),
      })
    : [];
  const boundaryTripIds = new Set(boundaryRows
    .filter((row) => new Date(row.startTime).getTime() >= cutoff)
    .map((row) => row.tripId));
  let weekTripCount = 0;
  let weekHarshBrakes = 0;
  for (const bucket of fullHourBuckets) {
    weekTripCount += Number(bucket.completedCount) || 0;
    weekHarshBrakes += Number(bucket.harshBrakesCount) || 0;
  }
  if (boundaryTripIds.size) {
    const readDb = await openP6TripDerivedDatabase();
    try {
      const tx = readDb.transaction(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'readonly');
      const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS);
      const rows = await Promise.all([...boundaryTripIds]
        .map((tripId) => requestResult(store.get(`browser:${tripId}:2`))));
      await transactionDone(tx);
      for (const row of rows) {
        if (!row) throw new Error('P6_ANALYTICS_RECENT_CONTRIBUTION_MISSING');
        const value = await decryptAnalyticsContribution(row);
        weekTripCount += Number(value?.completedCount) || 0;
        weekHarshBrakes += Number(value?.harshBrakesCount) || 0;
      }
    } finally { readDb.close(); }
  }
  const recentOrder = await readRecentAnalyticsRows({ limit: 10 });
  const recentWindow = [];
  if (recentOrder.length) {
    const readDb = await openP6TripDerivedDatabase();
    try {
      const tx = readDb.transaction(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS, 'readonly');
      const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS);
      const rows = await Promise.all(recentOrder
        .map((order) => requestResult(store.get(`browser:${order.tripId}:2`))));
      await transactionDone(tx);
      for (const row of rows) {
        if (!row) throw new Error('P6_ANALYTICS_RECENT_CONTRIBUTION_MISSING');
        recentWindow.push(await decryptAnalyticsContribution(row));
      }
    } finally { readDb.close(); }
  }
  const recentFive = recentWindow.slice(0, 5);
  let recentProduct = 0;
  let recentWeight = 0;
  for (const row of recentFive) {
    recentProduct += Number(row.scoreDistanceProduct) || 0;
    recentWeight += Number(row.scoreDistanceWeight) || 0;
  }
  return {
    ...global,
    weekTripCount,
    weekHarshBrakes,
    recentFiveCount: recentFive.length,
    recentFiveAvg: recentWeight > 0 ? recentProduct / recentWeight : 0,
    avgScore: Number(global.scoreDistanceWeight) > 0
      ? Number(global.scoreDistanceProduct) / Number(global.scoreDistanceWeight)
      : 0,
    defensiveStreak: recentWindow.length >= 10 && recentWindow.every((row) => (
      ['defensive', 'exemplary'].includes(row._defensiveGrade)
    )),
    defensiveRecentCount: recentWindow.filter((row) => (
      ['defensive', 'exemplary'].includes(row._defensiveGrade)
    )).length,
    source: 'p6_revision_exact',
  };
  } catch (_error) {
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.ANALYTICS, subject: 'all', sourceBinding: 'browser',
      state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
      reason: 'ANALYTICS_CORRUPT_REBUILD_REQUIRED',
    });
    return null;
  }
}

const routePage = async (trip, cursor, explicit) => {
  // The same eligibility the existing speed-map reader applies: a private
  // summary-only trip and a trip whose route has expired have no public
  // geometry, so D2 publishes none and D3 indexes none. Reading their points
  // here would put route detail into derived state that no canonical reader is
  // allowed to show.
  if (trip?.privacy_mode === 'summary_only' || trip?.route_data_expired_at) {
    return { points: [], done: true, cursor: null, bytesWorked: 0 };
  }
  if (trip?.route_payload_storage === 'browser_rsas_v1' && trip?.rsas_session_id) {
    return browserActiveTripSpool.readPointsPage(trip.rsas_session_id, { ...(cursor || {}), maxPoints: 128 });
  }
  if (!Array.isArray(trip?.route_points) || !trip.route_points.length) {
    return { points: [], done: true, cursor: null, bytesWorked: 0 };
  }
  if (!explicit) return { points: [], done: false, cursor, compatibilityRequired: true, bytesWorked: 0 };
  const offset = Math.max(0, Number(cursor?.legacyOffset) || 0);
  const points = trip.route_points.slice(offset, offset + 128);
  const next = offset + points.length;
  return {
    points,
    done: next >= trip.route_points.length,
    cursor: next >= trip.route_points.length ? null : { legacyOffset: next },
    bytesWorked: encoder.encode(JSON.stringify(points)).byteLength,
  };
};

const stageGeometryPage = async (work, trip, page, secret) => {
  const points = page.points.filter(publicPoint).map(compactPoint);
  const ordinal = Math.max(0, Number(work.cursor?.outputOrdinal) || 0);
  const contentVersion = `${work.desiredRevision}:geometry-v1`;
  const payload = await encryptSensitiveValue({ pointBlock: encodeP6PointBlock(points) },
    `p6:trip-derived:${work.tripId}:${contentVersion}:${ordinal}`);
  // This is the encrypted shared-source spill consumed by J2. Building a road
  // observation per source page would change p85/median and window boundaries.
  // J2 therefore owns exact cross-page window reduction over these rows.
  const observationPayload = await encryptSensitiveValue({ sourcePointBlock: encodeP6PointBlock(points) },
    `p6:road-observations:${work.tripId}:${work.desiredRevision}:${ordinal}`);
  const proposedBytes = encoder.encode(JSON.stringify(payload)).byteLength
    + encoder.encode(JSON.stringify(observationPayload)).byteLength + points.length * 256;
  await requireBrowserP6DerivedStorage(proposedBytes);
  const tokens = await Promise.all(points.map((point) => hmacCell(secret, cellFor(point))));
  const db = await openP6TripDerivedDatabase();
  try {
    const stores = [
      P6_TRIP_SOURCE_STORE,
      P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
      P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
      P6_TRIP_DERIVED_STORES.WORK,
      P6_TRIP_DERIVED_STORES.MANIFESTS,
    ];
    const tx = db.transaction(stores, 'readwrite');
    const source = await requestResult(tx.objectStore(P6_TRIP_SOURCE_STORE).get(work.tripId));
    if (!source || String(source.source_revision ?? '') !== String(work.desiredRevision)) {
      tx.abort();
      return { stale: true };
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).put({
      key: `${work.tripId}:${contentVersion}:${ordinal}`,
      tripId: work.tripId,
      sourceBinding: 'browser',
      sourceRevision: work.desiredRevision,
      contentVersion,
      ordinal,
      payload,
      pointCount: points.length,
      encodedBytes: proposedBytes,
      // A chunk is durable but invisible until the manifest names the complete
      // contentVersion. This avoids an O(chunks) state flip for a huge trip.
      commitState: 'STAGED',
      updatedAt: Date.now(),
    });
    const postingStore = tx.objectStore(P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS);
    // D3 asks only whether a trip revision touched a cell, and every reader
    // resolves a posting to (tripId, contentVersion) before rereading the
    // block. Consecutive points inside one 150 m cell therefore share a single
    // posting: writing one row per point multiplied this store and its three
    // indexes by the sampling rate for no additional selection power, and the
    // frozen 224-byte per-point envelope has no room for that.
    new Set(tokens).forEach((token) => postingStore.put({
      key: `browser:${token}:${work.tripId}:${work.desiredRevision}:${ordinal}`,
      sourceBinding: 'browser',
      cellToken: token,
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      contentVersion,
      blockOrdinal: ordinal,
    }));
    tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS).put({
      key: `${work.tripId}:${work.desiredRevision}:${ordinal}`,
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      ordinal,
      contentVersion,
      payload: observationPayload,
      recordKind: 'SOURCE_POINT_SPILL',
      pointStartOrdinal: Math.max(0, Number(work.cursor?.publicPointCount) || 0),
      pointCount: points.length,
      commitState: 'STAGED',
    });
    const nextWork = {
      ...work,
      state: page.done ? 'PREVIEW_BUILD' : 'BUILDING',
      cursor: page.done
        ? {
            previewOrdinal: 0,
            previewPointOffset: 0,
            outputOrdinal: ordinal + 1,
            publicPointCount: (Number(work.cursor?.publicPointCount) || 0) + points.length,
          }
        : {
            ...page.cursor,
            outputOrdinal: ordinal + 1,
            publicPointCount: (Number(work.cursor?.publicPointCount) || 0) + points.length,
          },
      appliedRevision: work.appliedRevision,
      updatedAt: Date.now(),
    };
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put(nextWork);
    await transactionDone(tx);
    return { stale: false, pointCount: points.length, proposedBytes };
  } finally {
    db.close();
  }
};

const previewAccumulatorContext = (work, contentVersion) => (
  `p6:geometry-preview:${work.tripId}:${contentVersion}`
);

const stepPreviewBuild = async (work, trip) => {
  const contentVersion = `${work.desiredRevision}:geometry-v1`;
  const chunkCount = Math.max(0, Number(work.cursor?.outputOrdinal) || 0);
  const ordinal = Math.max(0, Number(work.cursor?.previewOrdinal) || 0);
  const totalPoints = Math.max(0, Number(work.cursor?.publicPointCount) || 0);
  const accumulatorKey = `preview:${work.tripId}:${contentVersion}`;
  if (ordinal < chunkCount) {
    const chunk = await readGeometryChunk(work.tripId, contentVersion, ordinal);
    if (!chunk) {
      await setP6TripDomainReadiness({
        domain: P6_DOMAIN_KEYS.GEOMETRY, subject: work.tripId,
        state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
        reason: 'DERIVED_CHUNK_MISSING',
      });
      return { state: P6_READINESS_STATES.REBUILD_REQUIRED, itemsWorked: 1, bytesWorked: 0, hasMore: false };
    }
    const db = await openP6TripDerivedDatabase();
    let existing = { points: [] };
    try {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
      const row = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).get(accumulatorKey));
      if (row?.value) existing = await decryptSensitiveValue(row.value, previewAccumulatorContext(work, contentVersion));
    } finally { db.close(); }
    const globalStart = Math.max(0, Number(work.cursor?.previewPointOffset) || 0);
    const targetIndices = totalPoints <= 160
      ? new Set(Array.from({ length: totalPoints }, (_, index) => index))
      : new Set(Array.from({ length: 160 }, (_, index) => Math.round(index * (totalPoints - 1) / 159)));
    const selected = (chunk.points || []).filter((_point, index) => targetIndices.has(globalStart + index));
    const nextValue = { points: [...(existing.points || []), ...selected].slice(0, 160) };
    const value = await encryptSensitiveValue(nextValue, previewAccumulatorContext(work, contentVersion));
    await requireBrowserP6DerivedStorage(encodedJsonBytes(value));
    const writeDb = await openP6TripDerivedDatabase();
    try {
      const tx = writeDb.transaction([P6_TRIP_DERIVED_STORES.CONTROL, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
      tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).put({ key: accumulatorKey, value, updatedAt: Date.now() });
      tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
        ...work,
        cursor: {
          ...work.cursor,
          previewOrdinal: ordinal + 1,
          previewPointOffset: globalStart + (chunk.points || []).length,
        },
        updatedAt: Date.now(),
      });
      await transactionDone(tx);
    } finally { writeDb.close(); }
    return {
      state: 'PREVIEW_BUILD', itemsWorked: (chunk.points || []).length + 2,
      bytesWorked: encodedJsonBytes(chunk) + encodedJsonBytes(value), hasMore: true,
    };
  }
  const db = await openP6TripDerivedDatabase();
  let preview = { points: [] };
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    const row = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).get(accumulatorKey));
    if (row?.value) preview = await decryptSensitiveValue(row.value, previewAccumulatorContext(work, contentVersion));
  } finally { db.close(); }
  const payload = await encryptSensitiveValue({ pointBlock: encodeP6PointBlock(preview.points || []) },
    `p6:trip-derived:${work.tripId}:${contentVersion}:-1`);
  await requireBrowserP6DerivedStorage(encodedJsonBytes(payload));
  const writeDb = await openP6TripDerivedDatabase();
  try {
    const tx = writeDb.transaction([
      P6_TRIP_SOURCE_STORE,
      P6_TRIP_DERIVED_STORES.CONTROL,
      P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
      P6_TRIP_DERIVED_STORES.WORK,
      P6_TRIP_DERIVED_STORES.MANIFESTS,
    ], 'readwrite');
    const source = await requestResult(tx.objectStore(P6_TRIP_SOURCE_STORE).get(work.tripId));
    if (!source || String(source.source_revision ?? '') !== String(work.desiredRevision)) {
      tx.abort();
      return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS).put({
      key: `${work.tripId}:${contentVersion}:-1`, tripId: work.tripId,
      sourceBinding: 'browser', sourceRevision: work.desiredRevision,
      contentVersion, ordinal: -1, payload, pointCount: preview.points?.length || 0,
      encodedBytes: encodedJsonBytes(payload), commitState: 'STAGED', chunkType: 'PREVIEW', updatedAt: Date.now(),
    });
    tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).delete(accumulatorKey);
    // The heads now point at this revision, so the superseded rows are retired
    // next, in bounded turns, rather than left on disk for the life of the app.
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      ...work, state: 'RETIRE_SUPERSEDED', cursor: { retirePhase: P6_RETIRE_PHASES[0] },
      appliedRevision: work.desiredRevision, updatedAt: Date.now(),
    });
    for (const domain of [P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION, P6_DOMAIN_KEYS.ROAD_LEARNING]
      .filter((candidate) => p6WorkOwnsDomain(work, candidate))) {
      tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS).put({
        key: `${domain}:${work.tripId}`, domain, subject: work.tripId,
        sourceBinding: 'browser', requiredVersion: work.desiredRevision,
        appliedVersion: work.desiredRevision, contentVersion,
        state: domain === P6_DOMAIN_KEYS.ROAD_LEARNING
          ? P6_READINESS_STATES.CONVERSION_REQUIRED
          : P6_READINESS_STATES.VERIFIED,
        complete: domain !== P6_DOMAIN_KEYS.ROAD_LEARNING,
        startTime: trip.start_time || null, endTime: trip.end_time || null, updatedAt: Date.now(),
      });
    }
    await transactionDone(tx);
  } finally { writeDb.close(); }
  return {
    state: 'PUBLISHED', itemsWorked: (preview.points?.length || 0) + 5,
    bytesWorked: encodedJsonBytes(payload), hasMore: true,
  };
};

/**
 * AUD-007 REDESIGN: re-encrypts rows and commits them, so the pair is ONE publication.
 * The module-level rule was satisfied by other admitted functions in the same file
 * while this one encrypted outside admission entirely.
 */
const cleanupAnalyticsContributionTurn = async (work) => withDurableKeyPublication(async () => {
  const key = `browser:${work.tripId}:2`;
  const db = await openP6TripDerivedDatabase();
  try {
    const read = db.transaction([
      P6_TRIP_DERIVED_STORES.CONTRIBUTIONS,
      P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS,
    ], 'readonly');
    const old = await requestResult(read.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS).get(key));
    const observedBuckets = new Map(await Promise.all((old?.bucketKeys || []).map(async (bucketKey) => [
      bucketKey,
      await requestResult(read.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).get(bucketKey)),
    ])));
    await transactionDone(read);
    let previous = null;
    const nextBuckets = new Map();
    let corrupt = false;
    try {
      if (old) previous = await decryptAnalyticsContribution(old);
      for (const bucketKey of old?.bucketKeys || []) {
        const row = observedBuckets.get(bucketKey);
        if (!row) throw new Error('P6_ANALYTICS_BUCKET_MISSING');
        nextBuckets.set(bucketKey, addContribution(await decryptAnalyticsBucket(row), previous, -1));
      }
    } catch (_error) { corrupt = true; }
    const encryptedBuckets = corrupt ? new Map() : new Map(await Promise.all([...nextBuckets].map(
      async ([bucketKey, value]) => {
        const row = { key: bucketKey, revisionToken: analyticsRevisionToken(), updatedAt: Date.now() };
        row.payload = await encryptSensitiveValue(value, analyticsBucketContext(row));
        return [bucketKey, row];
      },
    )));
    if (!corrupt) await requireBrowserP6DerivedStorage(
      [...encryptedBuckets.values()].reduce((sum, row) => sum + encodedJsonBytes(row), 0),
    );
    const write = db.transaction([
      P6_TRIP_DERIVED_STORES.CONTRIBUTIONS,
      P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS,
      P6_TRIP_DERIVED_STORES.WORK,
      P6_TRIP_DERIVED_STORES.MANIFESTS,
    ], 'readwrite');
    const committed = await new Promise((resolve, reject) => {
      let currentWork; let currentOld; let staleAbort = false;
      const currentBuckets = new Map();
      const bucketKeys = old?.bucketKeys || [];
      let remaining = 2 + bucketKeys.length;
      const apply = () => {
        remaining -= 1;
        if (remaining !== 0) return;
        const stale = String(currentWork?.desiredRevision ?? '') !== String(work.desiredRevision)
          || currentWork?.sourceHash !== work.sourceHash
          || !sameAnalyticsRevision(currentOld, old)
          || bucketKeys.some((bucketKey) => !sameAnalyticsRevision(
            currentBuckets.get(bucketKey), observedBuckets.get(bucketKey),
          ));
        if (stale) { staleAbort = true; write.abort(); return; }
        if (old) write.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS).delete(key);
        if (!corrupt) {
          const buckets = write.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
          encryptedBuckets.forEach((row) => buckets.put(row));
        } else {
          const manifests = write.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
          for (const subject of ['all', work.tripId]) {
            manifests.put({
              key: `${P6_DOMAIN_KEYS.ANALYTICS}:${subject}`,
              domain: P6_DOMAIN_KEYS.ANALYTICS, subject, sourceBinding: 'browser',
              state: P6_READINESS_STATES.DIRTY, complete: false,
              reason: 'PRIOR_CONTRIBUTION_OR_BUCKET_CORRUPT', updatedAt: Date.now(),
            });
          }
        }
        write.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
          ...work, state: 'BUILDING', cursor: { cleanupPhase: 'RECENT' }, updatedAt: Date.now(),
        });
      };
      const fail = (request) => reject(request.error || new Error('P6_ANALYTICS_DELETE_COMPARE_FAILED'));
      const workRequest = write.objectStore(P6_TRIP_DERIVED_STORES.WORK).get(work.tripId);
      workRequest.onerror = () => fail(workRequest);
      workRequest.onsuccess = () => { currentWork = workRequest.result; apply(); };
      const oldRequest = write.objectStore(P6_TRIP_DERIVED_STORES.CONTRIBUTIONS).get(key);
      oldRequest.onerror = () => fail(oldRequest);
      oldRequest.onsuccess = () => { currentOld = oldRequest.result; apply(); };
      bucketKeys.forEach((bucketKey) => {
        const request = write.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS).get(bucketKey);
        request.onerror = () => fail(request);
        request.onsuccess = () => { currentBuckets.set(bucketKey, request.result); apply(); };
      });
      write.oncomplete = () => resolve(true);
      write.onerror = () => { if (!staleAbort) reject(write.error || new Error('P6_ANALYTICS_DELETE_FAILED')); };
      write.onabort = () => { if (staleAbort) resolve(false);
        else reject(write.error || new Error('P6_ANALYTICS_DELETE_ABORTED')); };
    });
    if (!committed) return {
      state: 'STALE_SOURCE', phase: 'CONTRIBUTION', itemsWorked: 1, bytesWorked: 0, hasMore: true,
    };
    return { state: corrupt ? 'TOMBSTONE_ANALYTICS_DIRTY' : 'TOMBSTONE_CLEANUP',
      phase: 'CONTRIBUTION', itemsWorked: old ? 2 + encryptedBuckets.size : 1,
      bytesWorked: [...encryptedBuckets.values()].reduce((sum, row) => sum + encodedJsonBytes(row), 0),
      hasMore: true };
  } finally { db.close(); }
});

const cleanupTombstonedTripTurn = async (work) => {
  const phases = ['CONTRIBUTION', 'RECENT', 'GEOMETRY', 'POSTINGS', 'OBSERVATIONS', 'ROAD_WINDOWS', 'MANIFEST'];
  const phase = phases.includes(work.cursor?.cleanupPhase) ? work.cursor.cleanupPhase : phases[0];
  if (phase === 'CONTRIBUTION') return cleanupAnalyticsContributionTurn(work);
  const db = await openP6TripDerivedDatabase();
  try {
    if (phase !== 'MANIFEST') {
      const byPhase = {
        RECENT: P6_TRIP_DERIVED_STORES.RECENT_ORDER,
        GEOMETRY: P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS,
        POSTINGS: P6_TRIP_DERIVED_STORES.SPATIAL_POSTINGS,
        OBSERVATIONS: P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS,
        ROAD_WINDOWS: P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
      };
      const storeName = byPhase[phase];
      const tx = db.transaction([storeName, P6_TRIP_DERIVED_STORES.WORK], 'readwrite');
      const result = await deleteIndexPage(tx.objectStore(storeName).index('by_trip'), work.tripId);
      const nextPhase = result.hasMore ? phase : phases[phases.indexOf(phase) + 1];
      tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
        ...work, state: 'BUILDING', cursor: { cleanupPhase: nextPhase }, updatedAt: Date.now(),
      });
      await transactionDone(tx);
      return { state: 'TOMBSTONE_CLEANUP', phase, itemsWorked: result.removed + 1, bytesWorked: 0, hasMore: true };
    }
    const tx = db.transaction([P6_TRIP_DERIVED_STORES.MANIFESTS, P6_TRIP_DERIVED_STORES.WORK,
      P6_TRIP_DERIVED_STORES.SOURCE_APPLIED], 'readwrite');
    const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
    for (const domain of Object.values(P6_DOMAIN_KEYS)) {
      manifests.put({
        key: `${domain}:${work.tripId}`,
        domain,
        subject: work.tripId,
        sourceBinding: 'browser',
        requiredVersion: work.desiredRevision,
        appliedVersion: work.desiredRevision,
        state: domain === P6_DOMAIN_KEYS.GEOMETRY
          ? P6_READINESS_STATES.NO_PUBLIC_GEOMETRY
          : P6_READINESS_STATES.VERIFIED,
        complete: true,
        reason: 'SOURCE_TOMBSTONED',
        updatedAt: Date.now(),
      });
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
      ...work, state: 'COMPLETE', cursor: null, appliedRevision: work.desiredRevision, updatedAt: Date.now(),
    });
    tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED).delete(`D1:browser:${work.tripId}`);
    await transactionDone(tx);
    return { state: 'TOMBSTONE_COMPLETE', phase, itemsWorked: 5, bytesWorked: 0, hasMore: true };
  } finally {
    db.close();
  }
};

/**
 * AUD-007 round 5: this turn captures the outgoing key version, encrypts, and commits
 * durably — so it holds admission for the whole span. Without it a finalizer sees no
 * admitted writer, proves zero, deletes the version, and the turn then publishes durable
 * ciphertext under a destroyed key. The turn is bounded, so the token is held briefly.
 */
export async function stepP6BrowserTripDerivedUpdate({ explicit = false } = {}) {
  return withDurableKeyPublication(async () => {
    const work = await readFirstWork();
    if (!work) {
      const discovery = await stepAnalyticsSettingsRediscovery();
      if (discovery.state !== 'IDLE') return discovery;
      return finalizeP6BrowserIncrementalDomains();
    }
    if (work.disposition === 'TOMBSTONE') {
      return cleanupTombstonedTripTurn(work);
    }
    // Retirement follows a completed publication and needs no source read.
    if (work.state === 'RETIRE_SUPERSEDED') return retireSupersededTurn(work);
    let trip;
    try {
      trip = await localTripRepository.getFullById(work.tripId);
    } catch (error) {
      // Absence is a tombstone; a failed read is not. Treating a decrypt, quota or
      // IO failure as deletion would erase a live trip's derived history and
      // subtract it from the user's analytics, with nothing to restore it from.
      if (await canonicalSourcePresent(work.tripId)) return parkUnreadableSource(work, error);
      return cleanupTombstonedTripTurn({ ...work, disposition: 'TOMBSTONE' });
    }
    let analyticsPublished;
    try {
      analyticsPublished = await publishContribution(work, trip);
    } catch (error) {
      // The reserve refusal is a state this domain reports, not a lifecycle
      // failure: the geometry path already returns it typed, and D1 must do the
      // same rather than throwing the turn out of the coordinator.
      if (error?.code !== P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED) throw error;
      await setP6TripDomainReadiness({
        domain: P6_DOMAIN_KEYS.ANALYTICS, subject: work.tripId,
        state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, complete: false,
        storageOutcome: error.details,
      });
      return {
        state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, itemsWorked: 1, bytesWorked: 0, hasMore: false,
      };
    }
    if (!analyticsPublished) return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    if (work.state === 'PREVIEW_BUILD') return stepPreviewBuild(work, trip);
    // DPD-020. A settings rediscovery re-queues a settled subject for D1 alone.
    // Its contribution has just been re-published under the new settings and no
    // point-derived domain is dirty, so there is nothing to rebuild and nothing
    // to retire: the subject returns to the terminal state it came from in this
    // one turn. Walking the geometry path instead would rebuild derived rows
    // that are already current, and — for a compatibility-parked subject — spend
    // four further retirement turns deleting rows that are already gone.
    if (work.analyticsOnlyTerminalState) {
      const restored = await restoreAnalyticsOnlyTerminalState(work);
      if (restored) {
        // The canonical read is this turn's real cost and it is the whole
        // accounting for the turn, so it is clamped to the declared budget: one
        // pathological row must not be able to turn an honest report into the
        // contract violation this change exists to remove. The clamp is
        // disclosed rather than silent, the same way an oversized indivisible
        // unit is in `queueP6ExplicitTripSubjects` — a capped number with no
        // companion figure is an understatement, not a bounded report.
        const readBytes = encodedJsonBytes(trip || {});
        return {
          state: 'ANALYTICS_SETTINGS_REFRESHED',
          itemsWorked: 1,
          bytesWorked: Math.min(readBytes, P6_TURN_BUDGET.bytes),
          ...(readBytes > P6_TURN_BUDGET.bytes ? { oversizedUnitBytes: readBytes } : {}),
          hasMore: true,
        };
      }
    }
    const page = await routePage(trip, work.cursor, explicit);
    if (page.compatibilityRequired) {
      // A legacy inline `route_points` source is read only by an explicit pass,
      // so the point-derived domains defer to one. D1 is already published
      // above, which is what the Dashboard's lifetime totals read.
      //
      // This branch used to return `hasMore: false`, which the coordinator maps
      // straight to DONE — it means "the queue is finished", not "this subject
      // is finished". One legacy-shaped trip at the head of `by_desired_seq`
      // therefore stopped the drain for every trip behind it, on every launch,
      // and a backup-restored history is legacy-shaped throughout, so it never
      // converged at all.
      //
      // The subject is parked instead of finished: the domains that defer read
      // REBUILD_REQUIRED at both the subject and the head, the row leaves the
      // drainable states so the queue moves past it exactly once, and it stays
      // countable as explicit debt so no incremental finalizer can promote a
      // head whose coverage now has a hole. Only the explicit repair re-queues
      // it — its DISCOVER phase walks canonical source and re-mints the row.
      const deferred = [P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION,
        P6_DOMAIN_KEYS.ROAD_LEARNING].filter((candidate) => p6WorkOwnsDomain(work, candidate));
      for (const domain of deferred) {
        for (const subject of [work.tripId, 'all']) {
          await setP6TripDomainReadiness({
            domain, subject, sourceBinding: 'browser',
            requiredVersion: work.desiredRevision,
            state: P6_READINESS_STATES.REBUILD_REQUIRED, complete: false,
            reason: 'EXPLICIT_LEGACY_SOURCE_REQUIRED',
          });
        }
      }
      const db = await openP6TripDerivedDatabase();
      try {
        const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readwrite');
        const store = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
        // A parked row is never re-examined, so a blind put would permanently
        // drop a revision that a canonical write landed during this turn. The
        // compare and the park stay inside the request callback for the same
        // reason the finalizers do: a strict user agent may auto-commit an
        // idle readwrite transaction at a promise continuation.
        const request = store.get(work.tripId);
        request.onsuccess = () => {
          const current = request.result;
          if (!current || current.disposition === 'TOMBSTONE') return;
          if (String(current.desiredRevision ?? '') !== String(work.desiredRevision ?? '')) return;
          store.put({
            ...current, state: 'RETIRE_SUPERSEDED',
            cursor: { retirePhase: P6_RETIRE_PHASES[0] },
            retireTerminalState: P6_EXPLICIT_SOURCE_REQUIRED,
            appliedRevision: work.desiredRevision, updatedAt: Date.now(),
          });
        };
        await transactionDone(tx);
      } finally { db.close(); }
      return { state: 'EXPLICIT_LEGACY_SOURCE_REQUIRED', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    if (!page.points.length && page.done) {
      for (const domain of [P6_DOMAIN_KEYS.GEOMETRY, P6_DOMAIN_KEYS.SPATIAL_SELECTION, P6_DOMAIN_KEYS.ROAD_LEARNING]
        .filter((candidate) => p6WorkOwnsDomain(work, candidate))) {
        await setP6TripDomainReadiness({
          domain,
          subject: work.tripId,
          state: domain === P6_DOMAIN_KEYS.ROAD_LEARNING
            ? P6_READINESS_STATES.VERIFIED
            : P6_READINESS_STATES.NO_PUBLIC_GEOMETRY,
          complete: true,
          appliedVersion: work.desiredRevision,
        });
      }
      const db = await openP6TripDerivedDatabase();
      try {
        const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readwrite');
        tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).put({
          ...work, state: 'RETIRE_SUPERSEDED', cursor: { retirePhase: P6_RETIRE_PHASES[0] },
          appliedRevision: work.desiredRevision, updatedAt: Date.now(),
        });
        await transactionDone(tx);
      } finally { db.close(); }
      return { state: P6_READINESS_STATES.NO_PUBLIC_GEOMETRY, itemsWorked: 1, bytesWorked: page.bytesWorked, hasMore: true };
    }
    try {
      const staged = await stageGeometryPage(work, trip, page, await readSpatialSecret());
      return {
        state: staged.stale ? 'STALE_SOURCE' : page.done ? 'PUBLISHED' : 'BUILDING',
        itemsWorked: page.points.length + 1,
        bytesWorked: page.bytesWorked + (staged.proposedBytes || 0),
        hasMore: true,
      };
    } catch (error) {
      if (error?.code === P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED) {
        await setP6TripDomainReadiness({
          domain: P6_DOMAIN_KEYS.GEOMETRY,
          subject: work.tripId,
          state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED,
          complete: false,
          storageOutcome: error.details,
        });
        return { state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED, itemsWorked: page.points.length + 1, bytesWorked: page.bytesWorked, hasMore: false };
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// P7 Q4 / Q5 — read facades over the **existing** P6 D1 analytics buckets.
//
// These are read facades, not a second ledger: no writer, no store, no schema
// and no D1 contribution field is added, and every value comes from a bucket
// P6 J1 already maintains. Q4 and Q5 are two of the only four paths allowed to
// carry a P6 readiness object, and they carry it **verbatim** — the raw stored
// manifest record is normalized through `normalizeP6Readiness` first, because
// `readP6TripDomainReadiness` returns the raw record rather than the envelope.
// ---------------------------------------------------------------------------

/**
 * The day-bucket ceiling for one ranged request.
 *
 * Reusing the frozen public page limit keeps the output bound identical on both
 * authorities and avoids inventing a second ceiling. A range wider than this is
 * not silently truncated: Q4 refuses it (`FILTER_UNSUPPORTED`, no data, no
 * continuation) and Q5 returns `PARTIAL` with the next bucket range.
 */
const P7_MAX_DAY_BUCKETS = P7_PUBLIC_PAGE_LIMIT.max;

const utcDayKeys = (fromMs, toMs) => {
  const keys = [];
  const first = Math.floor(fromMs / 86400000) * 86400000;
  // Half-open [from, to): a `to` that lands exactly on a day boundary does not
  // pull that day in.
  for (let day = first; day < toMs; day += 86400000) {
    keys.push(`browser:utc-day:${new Date(day).toISOString().slice(0, 10)}:2`);
  }
  return keys;
};

const readAnalyticsBuckets = async (keys) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS, 'readonly');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS);
    const rows = await Promise.all(keys.map((key) => requestResult(store.get(key))));
    await transactionDone(tx);
    return rows;
  } finally { db.close(); }
};

const analyticsEnvelope = (readiness, extra = {}) => ({
  authority: 'browser',
  p6Readiness: readiness,
  ...extra,
});

/**
 * Gate a D1 read on a `VERIFIED && complete` analytics domain.
 * @returns {Promise<{readiness: object, ready: boolean}>}
 */
const analyticsReadiness = async (subject) => {
  const readiness = normalizeP6Readiness({
    ...(await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ANALYTICS, subject)),
    domain: P6_DOMAIN_KEYS.ANALYTICS,
  });
  return { readiness, ready: readiness.state === P6_READINESS_STATES.VERIFIED && readiness.complete };
};

/**
 * **Q4** — an exact aggregate from a total or bucket the D1 owner already keys.
 *
 * Lifetime is O(1) (`browser:global:2`), per-vehicle is O(1)
 * (`browser:vehicle:<id>:2`), and a date range is O(A) over day buckets. Q4
 * owns **no continuation**: a filter the owner cannot express exactly within an
 * output bound is `FILTER_UNSUPPORTED` with no data, and the page composition
 * then selects the Q10 reducer its Annex C row names.
 *
 * Population is `P-COMPLETED` — D1 contributions are gated on
 * `status === 'completed'` by construction, and no aggregate owner can express
 * `P-DRIVER`, so a `P-DRIVER` row may never be served from here.
 *
 * @param {{scope?: 'global'|'vehicle', vehicleId?: string|null,
 *          fromMs?: number|null, toMs?: number|null}} [request]
 */
export async function queryP6AnalyticsAggregate(request = {}) {
  const { scope = 'global', vehicleId = null, fromMs = null, toMs = null } = request;
  const subject = scope === 'vehicle' && vehicleId ? String(vehicleId) : 'all';
  const { readiness, ready } = await analyticsReadiness('all');
  if (!ready) {
    return analyticsEnvelope(readiness, {
      data: null,
      completeness: null,
      continuation: null,
      unavailable: { code: 'OWNER_NOT_READY', reason: readiness.state },
    });
  }

  const ranged = Number.isFinite(fromMs) && Number.isFinite(toMs);
  let keys;
  if (ranged) {
    keys = utcDayKeys(Number(fromMs), Number(toMs));
    if (keys.length > P7_MAX_DAY_BUCKETS) {
      // Not output-bounded for this owner. Refused, not silently truncated and
      // not turned into a generic PARTIAL Q4 has no continuation for.
      return analyticsEnvelope(readiness, {
        data: null,
        completeness: null,
        continuation: null,
        unavailable: { code: 'FILTER_UNSUPPORTED', reason: 'range_exceeds_bucket_bound' },
      });
    }
  } else if (scope === 'vehicle') {
    if (!vehicleId) {
      return analyticsEnvelope(readiness, {
        data: null,
        completeness: null,
        continuation: null,
        unavailable: { code: 'FILTER_UNSUPPORTED', reason: 'vehicle_scope_requires_id' },
      });
    }
    keys = [`browser:vehicle:${String(vehicleId)}:2`];
  } else {
    keys = ['browser:global:2'];
  }

  const rows = await readAnalyticsBuckets(keys);
  const present = rows.filter(Boolean);
  if (!ranged && !present.length) {
    // A VERIFIED domain that cannot produce its own global bucket is a repair
    // condition, not a zero.
    return analyticsEnvelope(readiness, {
      data: null,
      completeness: null,
      continuation: null,
      unavailable: { code: 'OWNER_NOT_READY', reason: 'P6_ANALYTICS_GLOBAL_BUCKET_MISSING' },
    });
  }

  const buckets = await Promise.all(present.map(decryptAnalyticsBucket));
  const totals = {};
  for (const bucket of buckets) {
    for (const [field, value] of Object.entries(bucket || {})) {
      if (field === 'updatedAt') continue;
      if (typeof value === 'number' && Number.isFinite(value)) {
        totals[field] = (totals[field] || 0) + value;
      }
    }
  }

  return analyticsEnvelope(readiness, {
    data: { scope, subject, bucketsRead: present.length, totals },
    completeness: 'EXACT',
    continuation: null,
  });
}

/**
 * **Q5** — a bounded range of day buckets for trend charts.
 *
 * Unlike Q4, Q5 does own a continuation: when the output limit truncates the
 * requested range, the result is `PARTIAL` and the continuation names the next
 * bucket range, which is a real advancing continuation rather than a fabricated
 * one.
 *
 * The bucket basis is **UTC**, because that is what `analyticsBucketKeys`
 * already keys. A surface that groups by local day may not be silently re-based
 * onto it (Annex C C3 rule 3).
 *
 * @param {{fromMs: number, toMs: number, limit?: number}} request
 */
export async function queryP6AnalyticsDayBuckets(request = {}) {
  const { fromMs, toMs } = request;
  const limit = Math.min(Number(request.limit) || P7_MAX_DAY_BUCKETS, P7_MAX_DAY_BUCKETS);
  const { readiness, ready } = await analyticsReadiness('all');
  if (!ready) {
    return analyticsEnvelope(readiness, {
      data: null,
      completeness: null,
      continuation: null,
      unavailable: { code: 'OWNER_NOT_READY', reason: readiness.state },
    });
  }
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return analyticsEnvelope(readiness, {
      data: null,
      completeness: null,
      continuation: null,
      unavailable: { code: 'FILTER_UNSUPPORTED', reason: 'range_required' },
    });
  }

  const allKeys = utcDayKeys(Number(fromMs), Number(toMs));
  const served = allKeys.slice(0, limit);
  const rows = await readAnalyticsBuckets(served);
  const decoded = await Promise.all(rows.map((row) => (row ? decryptAnalyticsBucket(row) : null)));

  const truncated = allKeys.length > served.length;
  const nextFromMs = truncated
    ? Math.floor(Number(fromMs) / 86400000) * 86400000 + served.length * 86400000
    : null;

  return analyticsEnvelope(readiness, {
    data: served.map((key, index) => ({
      key,
      day: key.slice('browser:utc-day:'.length, -2),
      // A day with no bucket contributed no completed trip. It is reported as an
      // absent bucket rather than as a zero measurement.
      bucket: decoded[index],
    })),
    completeness: truncated ? 'PARTIAL' : 'EXACT',
    continuation: truncated ? { fromMs: nextFromMs, toMs: Number(toMs) } : null,
  });
}

// ---------------------------------------------------------------------------
// P7 Q8 step B — the read-only P6 D2 **by-ID batch** read facade.
//
// The defect this corrects: D2 pages are derived by the manifest's own key
// (`D2:<tripId>`), not by canonical trip recency and not by page
// status/filter/viewport. Wrapping `queryP6GeometryPreviewPage` directly
// therefore exposes no requested IDs, chronology, status, filter or viewport
// binding, and client culling may have to traverse every D2 page before finding
// a route in the visible region.
//
// Q8 is a bounded composition: **Q1 selects** a chronological, filter-correct
// page of trip IDs, and this facade **hydrates exactly that fixed page**.
//
// It is a read facade and nothing else. It creates no D2 writer, no D2 store,
// no geometry authority and no spatial index; D2 remains the sole derived
// geometry owner and the sole readiness owner, and the existing preview
// semantics are unchanged (one committed preview chunk per trip, at most two
// chunk reads, at most 160 points).
//
// Authority crossings are **constant in k**: one transaction reads every
// manifest for the fixed id set, one transaction reads every preview chunk. It
// is never `k` detail calls and never `N x Q2`.
// ---------------------------------------------------------------------------

/** The frozen D2 compatibility preview cap. Never widened by a caller. */
const P6_GEOMETRY_PREVIEW_MAX_POINTS = 160;
/** The frozen per-trip chunk-read ceiling the existing page reader applies. */
const P6_GEOMETRY_PREVIEW_MAX_CHUNKS = 2;

/**
 * **Q8 step B** — bounded D2 previews for exactly the ids Q1 selected.
 *
 * A trip the domain has no committed preview for is reported with
 * `coverage: 'unknown'` — **never** as zero coverage and never as an empty
 * route, because "the owner has nothing for this id" and "this trip has no
 * geometry" are different facts.
 *
 * A D2 refusal is **not** generic PARTIAL: the real readiness object and a typed
 * `unavailable` are surfaced with no fabricated progress.
 *
 * @param {Array<string|number>} ids the fixed Q1 id page, in Q1's order
 * @param {{maxPoints?: number}} [options]
 * @returns {Promise<object>} the generic P7 query envelope, with `p6Readiness`
 */
export async function queryP6GeometryByIds(ids = [], options = {}) {
  const requested = (Array.isArray(ids) ? ids : []).map((id) => String(id));
  const maxPoints = Math.max(
    2,
    Math.min(P6_GEOMETRY_PREVIEW_MAX_POINTS, Number(options.maxPoints) || P6_GEOMETRY_PREVIEW_MAX_POINTS)
  );

  if (nativeDerivedStateSelected()) {
    // The native D2 reader selects manifests by their own key
    // (`subject_id > ? ORDER BY subject_id`), so hydrating a fixed,
    // chronologically-selected id page would mean paging the whole manifest
    // table — exactly the unbounded shape Q8 exists to remove. Until the
    // read-only by-ids selection lands with the Stage 2 native change, this
    // reports the truthful typed state.
    //
    // It deliberately does **not** claim the owner is unready (it may be
    // perfectly VERIFIED), does not fabricate a readiness object, and does not
    // silently fall back to a whole-history path.
    return {
      authority: 'native',
      data: null,
      completeness: null,
      continuation: null,
      unavailable: { code: 'AUTHORITY_UNAVAILABLE', reason: 'native_d2_by_id_batch_unimplemented' },
      compatibilityAllowed: false,
    };
  }

  const raw = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.GEOMETRY, 'all');
  const readiness = normalizeP6Readiness({ ...raw, domain: P6_DOMAIN_KEYS.GEOMETRY });
  const envelope = (extra) => ({ authority: 'browser', p6Readiness: readiness, ...extra });
  const refused = (reason, compatibilityAllowed) => envelope({
    data: null,
    completeness: null,
    continuation: null,
    unavailable: { code: 'OWNER_NOT_READY', reason },
    // Preserved from the existing D2 contract: an unnamed refusal is a domain
    // that never claimed coverage, so a legacy compatibility route stays legal;
    // a named refusal is a demotion of a head that *had* claimed coverage, and
    // falling back there would be the silent reversion the release law forbids.
    compatibilityAllowed,
  });

  if (readiness.state !== P6_READINESS_STATES.VERIFIED || readiness.complete !== true) {
    return refused(readiness.state, true);
  }
  if (!requested.length) {
    return envelope({ data: [], completeness: 'EXACT', continuation: null, compatibilityAllowed: false });
  }

  let manifests;
  let chunks;
  try {
    // Crossing 1 of 2 — every manifest for the fixed id set, one transaction.
    const db = await openP6TripDerivedDatabase();
    try {
      const tx = db.transaction(P6_TRIP_DERIVED_STORES.MANIFESTS, 'readonly');
      const store = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
      manifests = await Promise.all(requested.map((id) => (
        requestResult(store.get(`${P6_DOMAIN_KEYS.GEOMETRY}:${id}`))
      )));
      await transactionDone(tx);
    } finally { db.close(); }

    const covered = requested
      .map((id, index) => ({ id, manifest: manifests[index] }))
      .filter(({ manifest }) => (
        manifest?.state === P6_READINESS_STATES.VERIFIED && manifest?.complete === true
      ));

    // Crossing 2 of 2 — every preview chunk for the covered ids, one
    // transaction. The ceiling is per trip, so the batch reads at most
    // `k * P6_GEOMETRY_PREVIEW_MAX_CHUNKS` rows and never more.
    const chunkDb = await openP6TripDerivedDatabase();
    try {
      const tx = chunkDb.transaction(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS, 'readonly');
      const store = tx.objectStore(P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS);
      chunks = await Promise.all(covered.map(({ id, manifest }) => (
        requestResult(store.get(`${id}:${manifest.contentVersion}:-1`))
      )));
      await transactionDone(tx);
    } finally { chunkDb.close(); }

    const previewById = new Map();
    for (let index = 0; index < covered.length; index += 1) {
      const { id, manifest } = covered[index];
      const row = chunks[index];
      if (!row) continue;
      const payload = await decryptSensitiveValue(
        row.payload, `p6:trip-derived:${id}:${manifest.contentVersion}:-1`
      );
      if (!payload) continue;
      const points = decodeP6PointBlock(payload.pointBlock ?? payload.points) || [];
      if (points.length < 2) continue;
      previewById.set(id, {
        manifest,
        points: points.slice(0, maxPoints),
      });
    }

    // Q1's order is the answer's order: chronology is the selection step's
    // property, and re-sorting here would discard it.
    const data = requested.map((id) => {
      const preview = previewById.get(id);
      if (!preview) {
        return { id, coverage: 'unknown', route_points: null, geometry_indexed: false };
      }
      return {
        id,
        coverage: 'covered',
        status: 'completed',
        start_time: preview.manifest.startTime || null,
        end_time: preview.manifest.endTime || null,
        route_points: preview.points,
        geometry_indexed: true,
        p6ContentVersion: preview.manifest.contentVersion,
        preview_point_cap: maxPoints,
        preview_chunk_cap: P6_GEOMETRY_PREVIEW_MAX_CHUNKS,
      };
    });

    return envelope({
      // The batch answers the whole fixed page it was given. Whether a *further*
      // Q1 page exists is the composition's question, not this facade's, so it
      // reports EXACT for its own contract and owns no continuation.
      data,
      completeness: 'EXACT',
      continuation: null,
      compatibilityAllowed: false,
    });
  } catch (error) {
    // A VERIFIED head that cannot serve a bounded read is demoted, exactly as
    // the existing page reader does: the head is the only thing authorising the
    // reader, so leaving it VERIFIED would keep offering a result the owner
    // cannot produce.
    await revokeP6GeometryReadiness(raw, `D2_BATCH_READ_FAILED:${error?.name || 'Error'}`);
    return refused('DERIVED_GEOMETRY_UNREADABLE', false);
  }
}

// ─── AUD-007: P6 derived state as a registered key-reference domain ──────────
//
// The P6 stores hold their own `encryptSensitiveValue()` payloads — geometry chunks,
// road observations, analytics contributions and buckets, the spatial secret. Rotation
// never visited them, so a superseded root key could be destroyed while they still
// depended on it. They are registered here, at the module that writes them, rather than
// in a list somewhere else that the next author will not find.
//
// This domain reports references but does NOT yet rewrap them. That is deliberate and
// safe in the only direction that matters: a non-zero count RETAINS the old key, so the
// data stays readable. Rewrapping (or an authorized rebuild-under-the-new-key
// disposition) is the follow-up that lets rotation complete; losing the key is not.

/**
 * Resolved at CALL time, not at module load.
 *
 * As a module-level array this dereferenced `P6_TRIP_DERIVED_STORES` while the module was
 * still being evaluated, so importing this module threw outright wherever
 * `@/lib/localTripRepository` is partially mocked -- which took down an unrelated
 * achievement-aggregates path that only wanted to read stats. A registration helper must
 * never be able to break the import of the module it is registering.
 */
const p6KeyReferenceStores = () => [
  P6_TRIP_DERIVED_STORES?.CONTROL,
  P6_TRIP_DERIVED_STORES?.CONTRIBUTIONS,
  P6_TRIP_DERIVED_STORES?.ANALYTICS_BUCKETS,
  P6_TRIP_DERIVED_STORES?.GEOMETRY_CHUNKS,
  P6_TRIP_DERIVED_STORES?.ROAD_OBSERVATIONS,
  P6_TRIP_DERIVED_STORES?.ROAD_WINDOWS,
].filter(Boolean);

/** Bounded examination budget so one proof turn never scans the whole archive. */
const P6_KEY_REFERENCE_SCAN_LIMIT = 256;

const referencesKeyVersion = (value, version) => {
  if (!value || typeof value !== 'object') return false;
  if (Number(value.key_version) === version && value.encrypted === true) return true;
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object' && referencesKeyVersion(nested, version)) return true;
  }
  return false;
};


/**
 * Round 4. The zero-reference PROOF has to make progress too.
 *
 * A bounded examination budget makes one turn cheap, but "zero references" is a statement
 * about the whole store set — so with more rows than the budget the sweep could never
 * finish, the answer was permanently UNKNOWN, and a converged key could never be retired.
 * Bounded-but-never-finishing is not fail-safe, it is a leak.
 *
 * So the proof carries a durable watermark of its own. Each turn resumes where the last
 * stopped; finding a reference answers immediately and resets the watermark; reaching the
 * end of the last store answers zero and clears it; exhausting the budget mid-sweep
 * persists the watermark and reports UNKNOWN, which retains the key until a later turn
 * finishes the sweep.
 *
 * A row written during a sweep is sealed under the CURRENT version, not the outgoing one,
 * so it is not a reference to the version being proven; the admission fence covers the
 * writer that captured the outgoing version before the sweep began.
 */
const P6_PROOF_CURSOR_KEY = (version) => `key-proof-cursor:${version}`;

const readP6ControlCursor = async (db, key) => {
  if (!db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.CONTROL)) return null;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    return (await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL).get(key)))?.cursor ?? null;
  } catch {
    return null;
  }
};

const writeP6ControlCursor = async (db, key, cursor) => {
  if (!db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.CONTROL)) return;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
    if (cursor) store.put({ key, cursor, updatedAt: Date.now() });
    else store.delete(key);
    await transactionDone(tx);
  } catch {
    // A watermark that will not persist costs a repeated sweep, never a false zero.
  }
};

/**
 * @throws when the bounded budget is exhausted without a conclusive answer — the caller
 *   treats that as UNKNOWN and retains the key. Unknown is never absence.
 */
export async function countP6KeyVersionReferences(version) {
  const target = Math.max(0, Number(version) || 0);
  if (!target) return 0;
  // A store that cannot exist holds no references. This is provably empty, NOT unknown:
  // without an IndexedDB substrate there is nowhere for P6 ciphertext to live, so
  // reporting UNKNOWN here would retain every key forever on platforms that never had
  // the store in the first place.
  if (!globalThis.indexedDB) return 0;
  const stores = p6KeyReferenceStores();
  // An empty list here means the store names could not be resolved -- a broken import,
  // not a provably empty database. Reporting zero would authorise deleting a key these
  // stores may still depend on, so this is UNKNOWN, which retains.
  if (!stores.length) throw new Error('P6_KEY_REFERENCE_STORES_UNAVAILABLE');

  const db = await openP6TripDerivedDatabase();
  const cursorKey = P6_PROOF_CURSOR_KEY(target);
  try {
    // Round 6: the stamp is a per-process identity, not a counter. A counter restarts at
    // the same value after a process restart, so a watermark persisted before the restart
    // could alias as current and authorise skipping rows a writer inserted behind it.
    const stamp = getBrowserKeyProofGeneration();
    const stored = await readP6ControlCursor(db, cursorKey);
    // A watermark from an older epoch proved a state a later writer may have invalidated
    // behind it. Discard it and sweep again rather than trust progress that is no longer
    // causally valid.
    const saved = isBrowserKeyProofGenerationCurrent(stored) ? stored : null;
    let storeIndex = Math.max(0, stores.indexOf(saved?.store));
    let afterKey = saved?.store === stores[storeIndex] ? saved?.afterKey ?? null : null;
    let budget = P6_KEY_REFERENCE_SCAN_LIMIT;

    while (storeIndex < stores.length) {
      const page = await scanP6StoreFrom(db, stores[storeIndex], afterKey,
        (row) => referencesKeyVersion(row, target), 1, budget);
      budget -= page.examined;

      if (page.matched.length) {
        // Definitive: one reference is enough. The next epoch starts clean.
        await writeP6ControlCursor(db, cursorKey, null);
        return 1;
      }
      if (page.exhausted) {
        storeIndex += 1;
        afterKey = null;
        continue;
      }
      // Budget spent mid-store: remember exactly where, and report UNKNOWN.
      await writeP6ControlCursor(db, cursorKey, {
        store: stores[storeIndex], afterKey: page.lastKey, ...stamp,
      });
      throw new Error('P6_KEY_REFERENCE_SCAN_BUDGET_EXHAUSTED');
    }

    // Every store swept to the end with no reference found.
    await writeP6ControlCursor(db, cursorKey, null);
    return 0;
  } finally {
    db.close();
  }
}

// ─── Round 3: real, bounded rewrap convergence ───────────────────────────────
//
// Counting alone meant the retention could never resolve: the old version stayed live
// for as long as any derived row referenced it, so rotation retired nothing and the app
// kept depending on a key it had decided to retire. These rows are rewrapped for real.
//
// Every P6 envelope's AAD is derivable from the row that carries it — that is what makes
// an exact rewrap possible without decrypting anything the row did not already own. A
// row whose context cannot be derived, or whose rewrap fails, is LEFT ALONE: its
// reference then keeps the key retained, which is the safe direction. Nothing here
// deletes derived data to make a rotation finish.

/** Bounded page: a larger archive produces more turns, not a larger turn. */
const P6_KEY_REWRAP_ROWS_PER_TURN = 64;

const previewKeyContext = (key) => {
  const suffix = String(key).slice('preview:'.length);
  return suffix ? `p6:geometry-preview:${suffix}` : null;
};

/** The road reducer keys its rows `"<kind>:<tripId>:<revision>:<ordinal>"`. */
const roadWindowContext = (key) => {
  const parts = String(key).split(':');
  if (parts.length < 3) return null;
  const [kind, tripId, revision, ordinal] = parts;
  if (!['window', 'reducer', 'output'].includes(kind)) return null;
  return `p6:road-reducer:${kind}:${tripId}:${revision}:${Number(ordinal) || 0}`;
};

/**
 * Where a row keeps its ciphertext, and the exact AAD it was sealed with.
 * @returns {{field: string, context: string}|null}
 */
const p6RowRewrapTarget = (storeName, row) => {
  const key = String(row?.key ?? '');
  if (storeName === P6_TRIP_DERIVED_STORES.CONTROL) {
    if (key === 'spatial-secret-v1') return { field: 'value', context: spatialSecretContext };
    if (key.startsWith('preview:')) {
      const context = previewKeyContext(key);
      return context ? { field: 'value', context } : null;
    }
    if (key.startsWith('selection:') && row?.requestId) {
      return { field: 'payload', context: `p6:affected-selection:${row.requestId}` };
    }
    return null;
  }
  if (storeName === P6_TRIP_DERIVED_STORES.CONTRIBUTIONS) {
    if (!row?.tripId || !row?.revisionToken) return null;
    return { field: 'payload', context: analyticsContributionContext(row) };
  }
  if (storeName === P6_TRIP_DERIVED_STORES.ANALYTICS_BUCKETS) {
    if (!row?.revisionToken) return null;
    return { field: 'payload', context: analyticsBucketContext(row) };
  }
  if (storeName === P6_TRIP_DERIVED_STORES.GEOMETRY_CHUNKS) {
    if (!row?.tripId || !row?.contentVersion) return null;
    return {
      field: 'payload',
      context: `p6:trip-derived:${row.tripId}:${row.contentVersion}:${Number(row.ordinal) || 0}`,
    };
  }
  if (storeName === P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS) {
    if (!row?.tripId || !row?.sourceRevision) return null;
    return {
      field: 'payload',
      context: `p6:road-observations:${row.tripId}:${row.sourceRevision}:${Number(row.ordinal) || 0}`,
    };
  }
  if (storeName === P6_TRIP_DERIVED_STORES.ROAD_WINDOWS) {
    const context = roadWindowContext(key);
    return context ? { field: 'payload', context } : null;
  }
  return null;
};

/**
 * Durable rewrap continuation.
 *
 * Round 3 had cursor-bounded ACQUISITION but no cursor-bounded PROGRESS: every turn
 * restarted at the first key, so a turn's examination budget was spent re-walking rows it
 * had already migrated and the tail was never reached. CODEX reproduced this with 321
 * rows -- four turns of 64, and the fifth exhausted the budget on the migrated prefix.
 *
 * The continuation is a durable `(store, afterKey)` pair, not an IndexedDB cursor object:
 * a key survives the transaction, the connection, and the process, and it stays valid
 * even if the row it names is deleted between turns.
 */
const P6_REWRAP_CURSOR_KEY = (from, to) => `key-rewrap-cursor:${from}:${to}`;

const readP6RewrapCursor = async (db, from, to) => {
  if (!db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.CONTROL)) return null;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readonly');
    const row = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL)
      .get(P6_REWRAP_CURSOR_KEY(from, to)));
    return row?.cursor ?? null;
  } catch {
    return null;   // an unreadable cursor restarts the sweep; it never skips rows
  }
};

const writeP6RewrapCursor = async (db, from, to, cursor) => {
  if (!db.objectStoreNames.contains(P6_TRIP_DERIVED_STORES.CONTROL)) return;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.CONTROL, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.CONTROL);
    if (cursor) store.put({ key: P6_REWRAP_CURSOR_KEY(from, to), cursor, updatedAt: Date.now() });
    else store.delete(P6_REWRAP_CURSOR_KEY(from, to));
    await transactionDone(tx);
  } catch {
    // A cursor that will not persist costs a repeated scan, never a skipped row.
  }
};

/**
 * Scan one store from `afterKey` (exclusive), collecting up to `limit` matches.
 * @returns {Promise<{matched: any[], lastKey: any, exhausted: boolean}>}
 */
const scanP6StoreFrom = async (db, storeName, afterKey, accept, limit,
  examineBudget = P6_KEY_REFERENCE_SCAN_LIMIT) => {
  if (!db.objectStoreNames.contains(storeName)) {
    return { matched: [], lastKey: afterKey ?? null, examined: 0, exhausted: true };
  }
  const tx = db.transaction(storeName, 'readonly');
  const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
  return new Promise((resolve, reject) => {
    const matched = [];
    let examined = 0;
    let lastKey = afterKey ?? null;
    const request = tx.objectStore(storeName).openCursor(range);
    request.onerror = () => reject(request.error || new Error('P6 rewrap scan failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { resolve({ matched, lastKey, examined, exhausted: true }); return; }
      lastKey = cursor.primaryKey;
      if (accept(cursor.value)) matched.push({ key: cursor.primaryKey, value: cursor.value });
      examined += 1;
      if (matched.length >= limit || examined >= examineBudget) {
        resolve({ matched, lastKey, examined, exhausted: false });
        return;
      }
      cursor.continue();
    };
  });
};

/**
 * Rewrap one bounded page of P6 references from `version` onto `targetVersion`, resuming
 * where the previous turn stopped.
 *
 * @returns {Promise<{rewrapped: number, examined: number, cursor: any, hasMore: boolean}>}
 */
export async function rewrapP6KeyVersion(version, targetVersion, options = {}) {
  const from = Math.max(0, Number(version) || 0);
  const to = Math.max(1, Number(targetVersion) || 1);
  const empty = { rewrapped: 0, examined: 0, cursor: null, hasMore: false };
  if (!from || from === to || !globalThis.indexedDB) return empty;

  const stores = p6KeyReferenceStores();
  if (!stores.length) throw new Error('P6_KEY_REFERENCE_STORES_UNAVAILABLE');

  const rowBudget = Math.max(1, Number(options.rowBudget) || P6_KEY_REWRAP_ROWS_PER_TURN);
  const db = await openP6TripDerivedDatabase();
  let rewrapped = 0;
  let examined = 0;
  let hasMore = false;
  let cursor = options.cursor !== undefined ? options.cursor : await readP6RewrapCursor(db, from, to);

  try {
    let storeIndex = Math.max(0, stores.indexOf(cursor?.store));
    let afterKey = cursor?.store === stores[storeIndex] ? cursor?.afterKey ?? null : null;
    let budget = rowBudget;

    while (storeIndex < stores.length && budget > 0) {
      const storeName = stores[storeIndex];
      const page = await scanP6StoreFrom(db, storeName, afterKey,
        (row) => referencesKeyVersion(row, from), budget);
      examined += page.matched.length;

      for (const { value: row } of page.matched) {
        const target = p6RowRewrapTarget(storeName, row);
        const payload = target ? row[target.field] : null;
        if (!target || !isEncryptedPayload(payload) || Number(payload.key_version) !== from) {
          continue;   // unknown shape => leave it => the key stays retained
        }
        try {
          const plain = await decryptSensitiveValue(payload, target.context);
          const resealed = await encryptSensitiveValue(plain, target.context, { keyVersion: to });
          const writeTx = db.transaction(storeName, 'readwrite');
          writeTx.objectStore(storeName).put({ ...row, [target.field]: resealed });
          await transactionDone(writeTx);
          rewrapped += 1;
        } catch {
          // Leave the row on the old version: the reference keeps the key alive.
        }
      }

      budget -= page.matched.length;
      afterKey = page.lastKey;
      if (page.exhausted) {
        storeIndex += 1;
        afterKey = null;
      } else if (budget <= 0) {
        hasMore = true;
      }
    }

    cursor = storeIndex < stores.length
      ? { store: stores[storeIndex], afterKey }
      : null;
    if (storeIndex < stores.length) hasMore = true;
    await writeP6RewrapCursor(db, from, to, cursor);
  } finally {
    db.close();
  }

  return { rewrapped, examined, cursor, hasMore };
}

registerBrowserKeyReferenceDomain({
  id: 'p6_trip_derived_state',
  countReferences: countP6KeyVersionReferences,
  rewrapStep: async ({ fromVersion, toVersion, cursor, rowBudget }) => {
    const step = await rewrapP6KeyVersion(fromVersion, toVersion, { cursor, rowBudget });
    return {
      rewrapped: step.rewrapped,
      examined: step.examined,
      cursor: step.cursor,
      hasMore: step.hasMore,
    };
  },
});

/** Test seam: the analytics snapshot exactly as production builds it. */
export const readAnalyticsSettingsSnapshotForTests = () => readAnalyticsSettingsSnapshot();
