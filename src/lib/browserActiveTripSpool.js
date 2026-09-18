import { decryptSensitiveValue, encryptSensitiveValue } from '@/lib/securePayloadCrypto';
import {
  registerBrowserKeyReferenceDomain,
  withDurableKeyPublication,
} from '@/lib/browserKeyReferences';

export const RSAS_VERSION = 1;
export const RSAS_SEGMENT_BYTES = 64 * 1024;
export const RSAS_SEGMENT_POINTS = 256;
export const RSAS_SEGMENT_AGE_MS = 10_000;
export const RSAS_RECENT_POINTS = 300;
export const RSAS_OVERVIEW_POINTS = 1_500;
export const RSAS_OVERVIEW_BYTES = 360 * 1024;

const DB_NAME = 'roadsage_active_spool_v1';
const DB_VERSION = 2;
const SEGMENTS = 'segments';
const MANIFESTS = 'manifests';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CANONICAL_METADATA_BYTES = 256 * 1024;
let current = null;
let writeQueue = Promise.resolve();
const canonicalCompletions = new Map();
const memoryFallback = new Map();
const pendingFallback = new Map();
const pendingCompletions = new Map();

const randomId = () => globalThis.crypto?.randomUUID?.() || `rsas_${Date.now()}_${Math.random().toString(16).slice(2)}`;

const terminalLifecycleError = () => {
  const error = new Error('A canonical browser trip lifecycle cannot be reopened.');
  error.code = 'ACTIVE_SPOOL_TERMINAL';
  return error;
};

const finalizationRequiredError = () => {
  const error = new Error('Sealed browser capture requires same-session finalization, not recording.');
  error.code = 'ACTIVE_SPOOL_FINALIZATION_REQUIRED';
  return error;
};

const canonicalView = (session) => ({
  ...(session.canonicalMetadata || {}),
  id: session.canonicalMetadata?.id || session.tripId,
  rsas_version: RSAS_VERSION,
  rsas_session_id: session.sessionId,
  rsas_lifecycle_state: 'CANONICAL',
  route_points: [],
  route_preview: session.overview.slice(0, RSAS_OVERVIEW_POINTS),
  active_route_is_bounded_preview: true,
});

const bytesToBase64 = (bytes) => {
  let binary = '';
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + block)));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

const segmentNonce = (prefixBase64, index) => {
  const prefix = base64ToBytes(prefixBase64);
  if (prefix.length !== 4 || !Number.isSafeInteger(index) || index < 0) throw new Error('ACTIVE_SPOOL_NONCE_INVALID');
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index), false);
  return nonce;
};

const segmentAad = ({ sessionId, tripId, index, plaintextBytes, plaintextHash }) => encoder.encode([
  'roadsage.browser.rsas.v1',
  'trip_stream',
  sessionId,
  tripId,
  String(index),
  String(plaintextBytes),
  plaintextHash,
].join('|'));

const newSessionCrypto = (sessionId) => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(4));
  // AUD-007 round 3. The INITIAL wrapper is a writer, and round 2 left it outside the
  // fence. It reads the active root key version now and publishes a durable manifest
  // sealed under it later; a rotation that finalizes inside that window can destroy the
  // version this manifest is about to name, and the route is unreadable from the moment
  // it is written. The fence is released only once the first manifest is durable — see
  // `begin()`.
  // Round 5: the initial wrapper must ADMIT, not merely count. A counter taken after a
  // finalization has already closed admission would let this session capture a version
  // that is about to be destroyed; awaiting admission makes it capture the survivor.
  // Round 6: one canonical primitive. The token is held from before the version is
  // captured until `begin()`'s first manifest is durable, which is where the publication
  // actually completes — see the `releaseInitialWrite` call in `begin()`.
  let releaseInitialWrite = () => {};
  let wrapResolve;
  let wrapReject;
  const wrappedDekPromise = new Promise((resolve, reject) => {
    wrapResolve = resolve;
    wrapReject = reject;
  });
  withDurableKeyPublication(async () => {
    await new Promise((settleInitialWrite) => {
      releaseInitialWrite = settleInitialWrite;
      encryptSensitiveValue(
        bytesToBase64(raw),
        `browser:active_spool_dek:${sessionId}`,
      ).then(wrapResolve, (error) => { wrapReject(error); settleInitialWrite(); });
    });
  }).catch(() => {});
  return {
    noncePrefix: bytesToBase64(noncePrefix),
    keyPromise: crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    releaseInitialWrite: () => releaseInitialWrite(),
    wrappedDekPromise,
  };
};

const restoreSessionKey = async (manifest) => {
  if (!manifest?.wrappedDek) throw new Error('ACTIVE_SPOOL_DEK_MISSING');
  const rawBase64 = await decryptSensitiveValue(
    manifest.wrappedDek,
    `browser:active_spool_dek:${manifest.sessionId}`,
  );
  const raw = base64ToBytes(rawBase64);
  if (raw.length !== 32) throw new Error('ACTIVE_SPOOL_DEK_INVALID');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

const openDb = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) {
    resolve(null);
    return;
  }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(SEGMENTS)) db.createObjectStore(SEGMENTS, { keyPath: ['sessionId', 'index'] });
    if (!db.objectStoreNames.contains(MANIFESTS)) {
      const manifests = db.createObjectStore(MANIFESTS, { keyPath: 'sessionId' });
      manifests.createIndex('by_trip_id', 'tripId', { unique: true });
      manifests.createIndex('by_state', 'state', { unique: false });
    } else {
      const manifests = request.transaction.objectStore(MANIFESTS);
      if (!manifests.indexNames.contains('by_trip_id')) manifests.createIndex('by_trip_id', 'tripId', { unique: true });
      if (!manifests.indexNames.contains('by_state')) manifests.createIndex('by_state', 'state', { unique: false });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('RSAS browser database open failed'));
});

const put = async (storeName, value) => {
  const db = await openDb();
  if (!db) {
    memoryFallback.set(`${storeName}:${JSON.stringify(storeName === SEGMENTS ? [value.sessionId, value.index] : value.sessionId)}`, value);
    if (storeName === MANIFESTS) {
      if (value.state === 'SEALED') pendingFallback.set(value.sessionId, value);
      else pendingFallback.delete(value.sessionId);
    }
    return;
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('RSAS browser write failed'));
    tx.onabort = () => reject(tx.error || new Error('RSAS browser write aborted'));
  });
  db.close();
};

const get = async (storeName, key) => {
  const db = await openDb();
  if (!db) return memoryFallback.get(`${storeName}:${JSON.stringify(key)}`) || null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('RSAS browser read failed'));
      tx.onabort = () => reject(tx.error || new Error('RSAS browser read aborted'));
    });
  } finally {
    db.close();
  }
};

const deleteSession = async (sessionId) => {
  pendingFallback.delete(sessionId);
  const db = await openDb();
  if (!db) {
    for (const key of [...memoryFallback.keys()]) {
      if (key === `${MANIFESTS}:${JSON.stringify(sessionId)}` || key.startsWith(`${SEGMENTS}:[\"${sessionId}\",`)) {
        memoryFallback.delete(key);
      }
    }
    return;
  }
  await new Promise((resolve, reject) => {
    const tx = db.transaction([SEGMENTS, MANIFESTS], 'readwrite');
    tx.objectStore(MANIFESTS).delete(sessionId);
    const cursor = tx.objectStore(SEGMENTS).openCursor();
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return;
      if (Array.isArray(row.key) && row.key[0] === sessionId) row.delete();
      row.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('RSAS browser delete failed'));
    tx.onabort = () => reject(tx.error || new Error('RSAS browser delete aborted'));
  });
  db.close();
};

const deleteSegmentRange = async (sessionId, fromIndex, limit = 16) => {
  const boundedLimit = Math.max(1, Math.min(16, Number(limit) || 16));
  const db = await openDb();
  if (!db) {
    let removed = 0;
    let bytesWorked = 0;
    for (let index = fromIndex; index < fromIndex + boundedLimit; index += 1) {
      const key = `${SEGMENTS}:${JSON.stringify([sessionId, index])}`;
      const value = memoryFallback.get(key);
      if (value) bytesWorked += segmentRecordBytes(value);
      if (memoryFallback.delete(key)) removed += 1;
    }
    return { removed, bytesWorked };
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SEGMENTS, 'readwrite');
    const store = tx.objectStore(SEGMENTS);
    let removed = 0;
    let bytesWorked = 0;
    for (let index = fromIndex; index < fromIndex + boundedLimit; index += 1) {
      const key = [sessionId, index];
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) {
          bytesWorked += segmentRecordBytes(request.result);
          store.delete(key);
          removed += 1;
        }
      };
    }
    tx.oncomplete = () => { db.close(); resolve({ removed, bytesWorked }); };
    tx.onerror = () => reject(tx.error || new Error('RSAS purge segment transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('RSAS purge segment transaction aborted'));
  });
};

const segmentRecordBytes = (record) => {
  if (!record) return 0;
  const text = (value) => encoder.encode(String(value || '')).byteLength;
  return text(record.sessionId) + text(record.domain) + text(record.plaintextHash) +
    text(record.nonce) + text(record.ciphertext) + (4 * 8);
};

const routeExpiredError = () => {
  const error = new Error('ROUTE_EXPIRED');
  error.code = 'ROUTE_EXPIRED';
  return error;
};

const eraseDatabase = async () => {
  current = null;
  await writeQueue;
  memoryFallback.clear();
  pendingFallback.clear();
  if (!globalThis.indexedDB) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error || new Error('RSAS browser erase failed'));
    request.onblocked = () => reject(new Error('RSAS browser erase blocked'));
  });
};

const decodeManifest = async (record) => {
  if (!record?.sessionId) return null;
  let plaintext;
  if (record.formatVersion === 2 && record.manifestCiphertext && record.manifestNonce && record.wrappedDek) {
    const manifestKey = await restoreSessionKey({ sessionId: record.sessionId, wrappedDek: record.wrappedDek });
    const bytes = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64ToBytes(record.manifestNonce),
      additionalData: encoder.encode(`roadsage.browser.rsas.manifest.v1|${record.sessionId}|${record.tripId}`),
      tagLength: 128,
    }, manifestKey, base64ToBytes(record.manifestCiphertext));
    plaintext = decoder.decode(bytes);
  } else if (record.encrypted) {
    plaintext = await decryptSensitiveValue(
      record.encrypted,
      `browser:active_spool_manifest:${record.sessionId}`,
    );
  } else {
    return null;
  }
  const manifest = JSON.parse(plaintext);
  if (manifest?.version !== RSAS_VERSION || manifest?.domain !== 'trip_stream' || manifest?.sessionId !== record.sessionId) {
    throw new Error('ACTIVE_SPOOL_MANIFEST_INVALID');
  }
  return manifest;
};

const haversineKm = (a, b) => {
  if (![a?.lat, a?.lng, b?.lat, b?.lng].every(Number.isFinite)) return 0;
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};

const nextRollingStats = (stats, point) => {
  const timestampMs = new Date(point?.timestamp || 0).getTime();
  const speedKmh = Number.isFinite(point?.speed_kmh)
    ? Number(point.speed_kmh)
    : Number.isFinite(point?.speed)
      ? Number(point.speed) * 3.6
      : null;
  const distanceKm = stats.lastPoint ? haversineKm(stats.lastPoint, point) : 0;
  return {
    pointCount: stats.pointCount + 1,
    distanceKm: stats.distanceKm + distanceKm,
    firstTimestampMs: stats.firstTimestampMs || (Number.isFinite(timestampMs) ? timestampMs : 0),
    lastTimestampMs: Number.isFinite(timestampMs) ? timestampMs : stats.lastTimestampMs,
    maxSpeedKmh: speedKmh == null ? stats.maxSpeedKmh : Math.max(stats.maxSpeedKmh, speedKmh),
    speedSampleSumKmh: stats.speedSampleSumKmh + (speedKmh == null ? 0 : speedKmh),
    speedSampleCount: stats.speedSampleCount + (speedKmh == null ? 0 : 1),
    minLat: Number.isFinite(point?.lat) ? Math.min(stats.minLat, point.lat) : stats.minLat,
    maxLat: Number.isFinite(point?.lat) ? Math.max(stats.maxLat, point.lat) : stats.maxLat,
    minLng: Number.isFinite(point?.lng) ? Math.min(stats.minLng, point.lng) : stats.minLng,
    maxLng: Number.isFinite(point?.lng) ? Math.max(stats.maxLng, point.lng) : stats.maxLng,
    lastPoint: Number.isFinite(point?.lat) && Number.isFinite(point?.lng)
      ? { lat: point.lat, lng: point.lng }
      : stats.lastPoint,
  };
};

const emptyRollingStats = () => ({
  pointCount: 0,
  distanceKm: 0,
  firstTimestampMs: 0,
  lastTimestampMs: 0,
  maxSpeedKmh: 0,
  speedSampleSumKmh: 0,
  speedSampleCount: 0,
  minLat: Number.POSITIVE_INFINITY,
  maxLat: Number.NEGATIVE_INFINITY,
  minLng: Number.POSITIVE_INFINITY,
  maxLng: Number.NEGATIVE_INFINITY,
  lastPoint: null,
});

const restoreRollingStats = (value, pointCount = 0) => {
  if (!value || pointCount <= 0) return emptyRollingStats();
  const finiteOr = (candidate, fallback) => Number.isFinite(candidate) ? candidate : fallback;
  return {
    pointCount: Math.max(0, Number(value.pointCount) || pointCount),
    distanceKm: Math.max(0, Number(value.distanceKm) || 0),
    firstTimestampMs: Math.max(0, Number(value.firstTimestampMs) || 0),
    lastTimestampMs: Math.max(0, Number(value.lastTimestampMs) || 0),
    maxSpeedKmh: Math.max(0, Number(value.maxSpeedKmh) || 0),
    speedSampleSumKmh: Math.max(0, Number(value.speedSampleSumKmh) || 0),
    speedSampleCount: Math.max(0, Number(value.speedSampleCount) || 0),
    minLat: finiteOr(value.minLat, Number.POSITIVE_INFINITY),
    maxLat: finiteOr(value.maxLat, Number.NEGATIVE_INFINITY),
    minLng: finiteOr(value.minLng, Number.POSITIVE_INFINITY),
    maxLng: finiteOr(value.maxLng, Number.NEGATIVE_INFINITY),
    lastPoint: value.lastPoint || null,
  };
};

const publicRollingStats = (stats = emptyRollingStats()) => ({
  point_count: stats.pointCount,
  distance_km: stats.distanceKm,
  duration_seconds: stats.firstTimestampMs && stats.lastTimestampMs
    ? Math.max(0, Math.round((stats.lastTimestampMs - stats.firstTimestampMs) / 1000))
    : 0,
  max_speed_kmh: stats.maxSpeedKmh,
  avg_speed_kmh: stats.speedSampleCount ? stats.speedSampleSumKmh / stats.speedSampleCount : 0,
  bounds: Number.isFinite(stats.minLat) ? {
    min_lat: stats.minLat,
    max_lat: stats.maxLat,
    min_lng: stats.minLng,
    max_lng: stats.maxLng,
  } : null,
});

const boundedCanonicalMetadata = (metadata = {}) => {
  const {
    route_points: _routePoints,
    raw_route_points: _rawRoutePoints,
    route_preview: _routePreview,
    ...bounded
  } = metadata || {};
  const serialized = JSON.stringify(bounded);
  if (encoder.encode(serialized).byteLength > CANONICAL_METADATA_BYTES) {
    throw new Error('ACTIVE_SPOOL_CANONICAL_METADATA_OVERSIZED');
  }
  return bounded;
};

const readSegment = async (sessionId, index, manifest, key) => {
  const record = await get(SEGMENTS, [sessionId, index]);
  if (!record || record.version !== RSAS_VERSION || record.domain !== 'trip_stream') {
    throw new Error('ACTIVE_SPOOL_SEGMENT_MISSING');
  }
  let plaintext;
  if (record.ciphertext && record.nonce && record.plaintextHash) {
    const plaintextBytes = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64ToBytes(record.nonce),
      additionalData: segmentAad({
        sessionId,
        tripId: manifest.tripId,
        index,
        plaintextBytes: record.plaintextBytes,
        plaintextHash: record.plaintextHash,
      }),
      tagLength: 128,
    }, key, base64ToBytes(record.ciphertext)));
    const actualHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', plaintextBytes)));
    if (actualHash !== record.plaintextHash) throw new Error('ACTIVE_SPOOL_SEGMENT_HASH_MISMATCH');
    plaintext = decoder.decode(plaintextBytes);
  } else {
    // Version-1 pre-session-DEK browser spools remain readable for recovery.
    plaintext = await decryptSensitiveValue(
      record.encrypted,
      `browser:active_spool_segment:${sessionId}:${index}`,
    );
  }
  if (encoder.encode(plaintext).byteLength > RSAS_SEGMENT_BYTES) throw new Error('ACTIVE_SPOOL_SEGMENT_OVERSIZED');
  const lines = plaintext ? plaintext.split('\n') : [];
  if (lines.length !== record.pointCount) throw new Error('ACTIVE_SPOOL_SEGMENT_POINT_COUNT_MISMATCH');
  return lines;
};

const compactOverview = (points) => {
  const compacted = [];
  for (let index = 0; index < points.length; index += 2) compacted.push(points[index]);
  return compacted;
};

const overviewPoint = (point = {}) => ({
  ...(Number.isFinite(point.lat) ? { lat: point.lat } : point.masked_for_privacy === true ? { lat: null } : {}),
  ...(Number.isFinite(point.lng) ? { lng: point.lng } : point.masked_for_privacy === true ? { lng: null } : {}),
  ...(point.timestamp ? { timestamp: point.timestamp } : {}),
  ...(Number.isFinite(point.speed_kmh) ? { speed_kmh: point.speed_kmh } : point.masked_for_privacy === true ? { speed_kmh: null } : {}),
  ...(point.privacy_gap === true ? { privacy_gap: true } : {}),
  ...(point.masked_for_privacy === true ? { masked_for_privacy: true } : {}),
});

const recentPoint = (point = {}) => ({
  ...overviewPoint(point),
  ...(Number.isFinite(point.accuracy) ? { accuracy: point.accuracy } : {}),
  ...(Number.isFinite(point.heading) ? { heading: point.heading } : {}),
  ...(Number.isFinite(point.altitude) ? { altitude: point.altitude } : {}),
  ...(point.privacy_live_redacted === true ? { privacy_live_redacted: true } : {}),
  ...(point.privacy_zone_id ? { privacy_zone_id: point.privacy_zone_id } : {}),
});

const queue = (work) => {
  writeQueue = writeQueue.then(work);
  return writeQueue;
};

const manifestSnapshot = (session = current) => {
  if (!session) return null;
  return {
    version: RSAS_VERSION,
    domain: 'trip_stream',
    ownerKind: 'browser_web',
    ownerToken: session.ownerToken,
    sessionId: session.sessionId,
    tripId: session.tripId,
    state: session.state,
    createdAt: session.createdAt,
    heartbeatAt: Date.now(),
    sealedSegmentCount: session.segmentIndex,
    pointCount: session.pointCount,
    recentPoints: session.recent.slice(-RSAS_RECENT_POINTS),
    overview: session.overview.slice(),
    overviewStride: session.overviewStride,
    rollingStats: session.rollingStats,
    lastPointKey: session.lastPointKey,
    recoveryMetadata: session.recoveryMetadata,
    ...(session.canonicalMetadata ? { canonicalMetadata: session.canonicalMetadata } : {}),
    ...(session.committedAt ? { committedAt: session.committedAt } : {}),
    noncePrefix: session.noncePrefix,
    wrappedDek: session.wrappedDek,
    keyPromise: session.keyPromise,
    wrappedDekPromise: session.wrappedDekPromise,
  };
};

const persistManifest = async (snapshot = manifestSnapshot()) => {
  if (!snapshot) return Promise.resolve();
  if (!snapshot.wrappedDek && snapshot.wrappedDekPromise) snapshot.wrappedDek = await snapshot.wrappedDekPromise;
  const { keyPromise: _keyPromise, wrappedDekPromise: _wrappedDekPromise, ...durable } = snapshot;
  const key = await snapshot.keyPromise;
  const manifestNonce = crypto.getRandomValues(new Uint8Array(12));
  const manifestCiphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: manifestNonce,
    additionalData: encoder.encode(`roadsage.browser.rsas.manifest.v1|${snapshot.sessionId}|${snapshot.tripId}`),
    tagLength: 128,
  }, key, encoder.encode(JSON.stringify(durable)));
  await put(MANIFESTS, {
    sessionId: snapshot.sessionId,
    tripId: snapshot.tripId,
    state: snapshot.state,
    formatVersion: 2,
    wrappedDek: snapshot.wrappedDek,
    noncePrefix: snapshot.noncePrefix,
    manifestNonce: bytesToBase64(manifestNonce),
    manifestCiphertext: bytesToBase64(new Uint8Array(manifestCiphertext)),
  });
};

// Detach the segment from live state synchronously. Encryption and IDB writes
// may then run later without observing points appended to the next segment.
const takeSegmentSnapshot = (session = current) => {
  if (!session || session.buffer.length === 0) return null;
  const snapshot = {
    sessionId: session.sessionId,
    index: session.segmentIndex,
    lines: session.buffer,
    plaintextBytes: session.bufferBytes,
    tripId: session.tripId,
    keyPromise: session.keyPromise,
    noncePrefix: session.noncePrefix,
  };
  session.segmentIndex += 1;
  session.buffer = [];
  session.bufferBytes = 0;
  session.segmentStartedAt = 0;
  return snapshot;
};

const persistSegment = async (snapshot, manifest) => {
  if (!snapshot) return;
  const plaintext = snapshot.lines.join('\n');
  const plaintextBuffer = encoder.encode(plaintext);
  const plaintextBytes = plaintextBuffer.byteLength;
  const plaintextHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', plaintextBuffer)));
  const nonce = segmentNonce(snapshot.noncePrefix, snapshot.index);
  const key = await snapshot.keyPromise;
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: segmentAad({ ...snapshot, plaintextBytes, plaintextHash }),
    tagLength: 128,
  }, key, plaintextBuffer));
  await put(SEGMENTS, {
    sessionId: snapshot.sessionId,
    index: snapshot.index,
    version: RSAS_VERSION,
    domain: 'trip_stream',
    plaintextBytes,
    pointCount: snapshot.lines.length,
    plaintextHash,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  });
  await persistManifest(manifest);
};

const queueSegment = (session = current) => {
  const snapshot = takeSegmentSnapshot(session);
  if (!snapshot) return;
  const manifest = manifestSnapshot(session);
  queue(() => persistSegment(snapshot, manifest));
};

const captureKey = (point) => point
  ? `${point.timestamp || ''}:${point.lat ?? ''}:${point.lng ?? ''}` : null;

const restoreSession = (manifest) => {
  // Legacy initial manifests could advertise an unsegmented tail. No segment
  // means no retained capture; never restore phantom count/rolling/preview data.
  const retained = manifest.sealedSegmentCount > 0 ? Number(manifest.pointCount) || 0 : 0;
  const recent = retained && Array.isArray(manifest.recentPoints)
    ? manifest.recentPoints.slice(-RSAS_RECENT_POINTS) : [];
  return {
    sessionId: manifest.sessionId, tripId: manifest.tripId, ownerToken: manifest.ownerToken,
    state: manifest.state, createdAt: manifest.createdAt,
    segmentIndex: manifest.sealedSegmentCount, segmentStartedAt: 0, buffer: [], bufferBytes: 0,
    pointCount: retained, recent,
    overview: retained && Array.isArray(manifest.overview) ? manifest.overview.slice(0, RSAS_OVERVIEW_POINTS) : [],
    overviewStride: Math.max(1, Number(manifest.overviewStride) || 1), overviewEligible: retained,
    lastPointKey: retained ? manifest.lastPointKey || captureKey(recent.at(-1)) : null,
    rollingStats: restoreRollingStats(manifest.rollingStats, retained),
    recoveryMetadata: manifest.recoveryMetadata || {},
    canonicalMetadata: manifest.canonicalMetadata || null, committedAt: manifest.committedAt || null,
    noncePrefix: manifest.noncePrefix, wrappedDek: manifest.wrappedDek,
    wrappedDekPromise: Promise.resolve(manifest.wrappedDek), keyPromise: restoreSessionKey(manifest),
  };
};

const sessionView = (session, metadata = {}) => ({
  ...metadata, id: session.tripId, rsas_version: RSAS_VERSION,
  rsas_session_id: session.sessionId, rsas_lifecycle_state: session.state,
  route_points: session.recent.slice(-RSAS_RECENT_POINTS), route_preview: session.overview,
  route_point_count: session.pointCount, active_route_point_count: session.pointCount,
  rolling_stats: publicRollingStats(session.rollingStats),
});

export const browserActiveTripSpool = {
  begin(trip = {}) {
    if (trip.rsas_lifecycle_state === 'CANONICAL') throw terminalLifecycleError();
    if (trip.rsas_lifecycle_state === 'SEALED') throw finalizationRequiredError();
    if (trip.rsas_session_id && trip.rsas_session_id !== current?.sessionId) {
      const error = new Error('Persisted browser sessions must pass through lifecycle recovery before recording.');
      error.code = 'ACTIVE_SPOOL_RECOVERY_REQUIRED';
      throw error;
    }
    if (current && current.tripId === String(trip.id || '') && current.state === 'ACTIVE') {
      current.recoveryMetadata = boundedCanonicalMetadata(trip);
      return current.sessionId;
    }
    if (current?.state === 'SEALED' && current.tripId === String(trip.id || '')) {
      throw finalizationRequiredError();
    }
    if (current?.state === 'CANONICAL' && current.tripId === String(trip.id || '')) {
      throw terminalLifecycleError();
    }
    if (current?.state === 'ACTIVE') {
      const error = new Error('Another browser producer owns the active spool.');
      error.code = 'ACTIVE_PRODUCER_NOT_OWNER';
      throw error;
    }
    const recoveryMetadata = boundedCanonicalMetadata(trip);
    const sessionId = randomId();
    current = {
      sessionId,
      tripId: String(trip.id || randomId()),
      ownerToken: randomId(),
      state: 'ACTIVE',
      createdAt: Date.now(),
      segmentIndex: 0,
      segmentStartedAt: 0,
      buffer: [],
      bufferBytes: 0,
      pointCount: 0,
      recent: [],
      overview: [],
      overviewStride: 1,
      overviewEligible: 0,
      lastPointKey: null,
      rollingStats: emptyRollingStats(),
      canonicalMetadata: null,
      recoveryMetadata,
      committedAt: null,
      ...newSessionCrypto(sessionId),
      wrappedDek: null,
    };
    const session = current;
    session.wrappedDekPromise = session.wrappedDekPromise.then((wrappedDek) => {
      session.wrappedDek = wrappedDek;
      return wrappedDek;
    });
    // The fence covers the whole publication, not just the wrap: it is released only
    // after the first manifest is durable (or has definitively failed), so a rotation
    // cannot prove zero references while this session's wrapper is still in flight.
    const initialManifest = manifestSnapshot(session);
    queue(() => persistManifest(initialManifest).finally(() => session.releaseInitialWrite?.()));
    return current.sessionId;
  },
  append(point, trip = {}) {
    if (!point) return;
    if (!current || current.tripId !== String(trip.id || '')) this.begin(trip);
    if (current.state === 'CANONICAL') throw terminalLifecycleError();
    if (current.state === 'SEALED') throw finalizationRequiredError();
    const key = captureKey(point);
    if (current.lastPointKey === key) return;
    const encoded = JSON.stringify(point);
    const bytes = encoder.encode(encoded).byteLength + 1;
    if (bytes > RSAS_SEGMENT_BYTES) throw new Error('ACTIVE_POINT_TOO_LARGE');
    const now = Date.now();
    if (current.buffer.length > 0 && (
      current.bufferBytes + bytes > RSAS_SEGMENT_BYTES ||
      current.buffer.length >= RSAS_SEGMENT_POINTS ||
      now - current.segmentStartedAt >= RSAS_SEGMENT_AGE_MS
    )) queueSegment(current);
    current.lastPointKey = key;
    if (current.buffer.length === 0) current.segmentStartedAt = now;
    current.buffer.push(encoded);
    current.bufferBytes += bytes;
    current.pointCount += 1;
    current.rollingStats = nextRollingStats(current.rollingStats, point);
    current.recent.push(recentPoint(point));
    if (current.recent.length > RSAS_RECENT_POINTS) current.recent.shift();
    const overviewIndex = current.overviewEligible++;
    if (overviewIndex % current.overviewStride === 0) current.overview.push(overviewPoint(point));
    while (
      current.overview.length >= RSAS_OVERVIEW_POINTS ||
      encoder.encode(JSON.stringify(current.overview)).byteLength > RSAS_OVERVIEW_BYTES
    ) {
      current.overview = compactOverview(current.overview);
      current.overviewStride *= 2;
    }
    if (
      current.bufferBytes >= RSAS_SEGMENT_BYTES ||
      current.buffer.length >= RSAS_SEGMENT_POINTS ||
      now - current.segmentStartedAt >= RSAS_SEGMENT_AGE_MS
    ) queueSegment(current);
  },
  view(metadata = {}) {
    if (!current) return { ...metadata, route_points: [] };
    return sessionView(current, metadata);
  },
  async seal() {
    if (!current) return null;
    if (current.state === 'CANONICAL') throw terminalLifecycleError();
    queueSegment(current);
    current.state = 'SEALED';
    const finalManifest = manifestSnapshot(current);
    await queue(() => persistManifest(finalManifest));
    return { sessionId: current.sessionId, tripId: current.tripId, pointCount: current.pointCount };
  },
  async complete(metadata = {}, session = current) {
    if (!session) throw new Error('ACTIVE_SPOOL_NOT_OPEN');
    if ((metadata.id && String(metadata.id) !== session.tripId) ||
        (metadata.rsas_session_id && metadata.rsas_session_id !== session.sessionId)) {
      throw new Error('ACTIVE_PRODUCER_NOT_OWNER');
    }
    if (session.state === 'CANONICAL') return canonicalView(session);
    if (canonicalCompletions.has(session.sessionId)) return canonicalCompletions.get(session.sessionId);
    const promise = (async () => {
      if (session.state === 'ACTIVE') {
        if (session !== current) throw new Error('ACTIVE_PRODUCER_NOT_OWNER');
        await this.seal();
      }
      if (session.state !== 'SEALED') throw new Error('ACTIVE_SPOOL_STATE_INVALID');
      const canonicalMetadata = boundedCanonicalMetadata({
        ...metadata,
        id: metadata.id || session.tripId,
        route_payload_storage: 'browser_rsas_v1',
        rsas_session_id: session.sessionId,
        rsas_lifecycle_state: 'CANONICAL',
        route_points_raw_count: session.pointCount,
        route_points_map_count: session.overview.length,
        ...publicRollingStats(session.rollingStats),
      });
      const committedAt = Date.now();
      const canonical = {
        ...session,
        state: 'CANONICAL',
        canonicalMetadata,
        committedAt,
      };
      // Do not publish CANONICAL in memory until the same state is durable. If the
      // manifest write fails, the live owner remains SEALED and a retry performs the
      // write again instead of mistaking a process-local transition for durability.
      await writeQueue;
      try {
        await queue(() => persistManifest(manifestSnapshot(canonical)));
      } catch (error) {
        // Only this failed terminal-manifest transition is retryable here. Do not
        // swallow an earlier segment failure or publish over missing route data.
        writeQueue = writeQueue.catch(() => undefined);
        throw error;
      }
      session.canonicalMetadata = canonicalMetadata;
      session.state = 'CANONICAL';
      session.committedAt = committedAt;
      return canonicalView(session);
    })();
    canonicalCompletions.set(session.sessionId, promise);
    try {
      return await promise;
    } finally {
      if (canonicalCompletions.get(session.sessionId) === promise) canonicalCompletions.delete(session.sessionId);
    }
  },
  async hydrate(sessionId) {
    if (!sessionId) return null;
    await writeQueue;
    const manifest = await decodeManifest(await get(MANIFESTS, sessionId));
    if (!manifest || !['ACTIVE', 'SEALED', 'CANONICAL'].includes(manifest.state)) return null;
    // Re-reading the active slot in a still-live renderer is not process loss.
    // Keep its uncommitted tail; replacement renderers have no current session.
    if (current?.sessionId === sessionId && current.state === 'ACTIVE' &&
        manifest.state === 'ACTIVE' && current.buffer.length > 0) return this.view({ id: current.tripId });
    current = restoreSession(manifest);
    return current.state === 'CANONICAL'
      ? canonicalView(current)
      : this.view({ id: current.tripId });
  },
  async *readPoints(sessionId = current?.sessionId) {
    if (!sessionId) return;
    await writeQueue;
    const outer = await get(MANIFESTS, sessionId);
    if (outer?.purgeState) throw routeExpiredError();
    const manifest = await decodeManifest(outer);
    if (!manifest || !['ACTIVE', 'SEALED', 'CANONICAL'].includes(manifest.state)) throw new Error('ACTIVE_SPOOL_NOT_READABLE');
    const key = await restoreSessionKey(manifest);
    for (let index = 0; index < manifest.sealedSegmentCount; index += 1) {
      const lines = await readSegment(sessionId, index, manifest, key);
      for (const line of lines) yield JSON.parse(line);
    }
  },
  /** P6 restartable page over one canonical RSAS segment. */
  async readPointsPage(sessionId = current?.sessionId, {
    segmentIndex = 0,
    lineIndex = 0,
    maxPoints = 128,
  } = {}) {
    if (!sessionId) return { points: [], done: true, cursor: null, bytesWorked: 0 };
    await writeQueue;
    const outer = await get(MANIFESTS, sessionId);
    if (outer?.purgeState) throw routeExpiredError();
    const manifest = await decodeManifest(outer);
    if (!manifest || manifest.state !== 'CANONICAL') throw new Error('ACTIVE_SPOOL_NOT_CANONICAL');
    const key = await restoreSessionKey(manifest);
    const limit = Math.max(1, Math.min(128, Math.trunc(Number(maxPoints) || 128)));
    let segment = Math.max(0, Math.trunc(Number(segmentIndex) || 0));
    let line = Math.max(0, Math.trunc(Number(lineIndex) || 0));
    const points = [];
    let bytesWorked = 0;
    while (segment < manifest.sealedSegmentCount && points.length < limit) {
      const lines = await readSegment(sessionId, segment, manifest, key);
      for (; line < lines.length && points.length < limit; line += 1) {
        const encoded = lines[line];
        bytesWorked += encoder.encode(encoded).byteLength;
        points.push(JSON.parse(encoded));
      }
      if (line >= lines.length) {
        segment += 1;
        line = 0;
      }
      // A page reads at most one encrypted segment, preserving the native-like
      // source boundary and keeping bridge/crypto accounting exact.
      if (points.length && segment < manifest.sealedSegmentCount) break;
    }
    const done = segment >= manifest.sealedSegmentCount;
    return {
      points,
      done,
      cursor: done ? null : { segmentIndex: segment, lineIndex: line },
      bytesWorked,
      sourceRevision: manifest.sourceRevision || manifest.committedAt || null,
    };
  },
  // Explicit checkpoints may commit the tail; ordinary capture still batches.
  async flush({ commitBuffer = false } = {}) {
    if (commitBuffer && current?.state === 'ACTIVE') queueSegment(current);
    await writeQueue;
  },
  async pendingFinalization() {
    await writeQueue;
    const db = await openDb();
    let outer;
    if (!db) outer = pendingFallback.values().next().value;
    else {
      try {
        outer = await new Promise((resolve, reject) => {
          const tx = db.transaction(MANIFESTS, 'readonly');
          const request = tx.objectStore(MANIFESTS).index('by_state').get('SEALED');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error('ACTIVE_SPOOL_PENDING_READ_FAILED'));
          tx.onabort = () => reject(tx.error || new Error('ACTIVE_SPOOL_PENDING_READ_ABORTED'));
        });
      } finally { db.close(); }
    }
    const manifest = await decodeManifest(outer);
    if (!manifest || manifest.state !== 'SEALED') return null;
    const session = restoreSession(manifest);
    return sessionView(session, session.recoveryMetadata);
  },
  async completePendingFinalization(metadata) {
    const sessionId = metadata?.rsas_session_id;
    if (!sessionId) throw new Error('ACTIVE_SPOOL_NOT_OPEN');
    if (pendingCompletions.has(sessionId)) return pendingCompletions.get(sessionId);
    const promise = (async () => {
      await writeQueue;
      const manifest = await decodeManifest(await get(MANIFESTS, sessionId));
      if (!manifest || !['SEALED', 'CANONICAL'].includes(manifest.state)) {
        throw new Error('ACTIVE_SPOOL_FINALIZATION_REQUIRED');
      }
      return this.complete(metadata, restoreSession(manifest));
    })();
    pendingCompletions.set(sessionId, promise);
    try { return await promise; }
    finally { pendingCompletions.delete(sessionId); }
  },
  async canonicalMetadata(sessionId) {
    await writeQueue;
    const outer = await get(MANIFESTS, sessionId);
    if (outer?.purgeState) throw routeExpiredError();
    const manifest = await decodeManifest(outer);
    if (manifest?.state !== 'CANONICAL') throw new Error('ACTIVE_SPOOL_NOT_CANONICAL');
    return {
      ...(manifest.canonicalMetadata || {}),
      route_points: [],
      route_preview: Array.isArray(manifest.overview) ? manifest.overview.slice(0, RSAS_OVERVIEW_POINTS) : [],
    };
  },
  async deleteCanonical(sessionId) {
    if (!sessionId) return;
    await writeQueue;
    const manifest = await decodeManifest(await get(MANIFESTS, sessionId));
    if (manifest && manifest.state !== 'CANONICAL') throw new Error('ACTIVE_SPOOL_DELETE_REQUIRES_CANONICAL');
    await deleteSession(sessionId);
    if (current?.sessionId === sessionId) current = null;
  },
  async beginCanonicalPurge(sessionId, { retentionDays = 0, motionRetentionDays = 0, expiredAt = Date.now() } = {}) {
    if (!sessionId) throw new Error('RSAS_PURGE_SESSION_REQUIRED');
    await writeQueue;
    const outer = await get(MANIFESTS, sessionId);
    if (!outer) return { state: 'DONE', itemsWorked: 0, changedItems: 0, bytesWorked: 0, hasMore: false };
    if (outer.purgeState) {
      return { state: outer.purgeState, itemsWorked: 0, changedItems: 0, bytesWorked: 0, hasMore: outer.purgeState !== 'DONE' };
    }
    const manifest = await decodeManifest(outer);
    if (manifest?.state !== 'CANONICAL') throw new Error('RSAS_PURGE_REQUIRES_CANONICAL');
    await put(MANIFESTS, {
      ...outer,
      purgeState: 'PURGE_PREPARED',
      purgeCursor: 0,
      purgeSegmentCount: Math.max(0, Number(manifest.sealedSegmentCount) || 0),
      purgePointCount: Math.max(0, Number(manifest.pointCount) || 0),
      purgeRetentionDays: Math.max(0, Number(retentionDays) || 0),
      purgeMotionRetentionDays: Math.max(0, Number(motionRetentionDays) || 0),
      purgeExpiredAt: Number(expiredAt) || Date.now(),
    });
    // The durable intent itself retires reads. The following bounded turn
    // crypto-shreds the outer DEK before any segment is unlinked.
    return { state: 'PURGE_PREPARED', itemsWorked: 1, changedItems: 1, bytesWorked: 0, hasMore: true };
  },
  async canonicalPurgeState(sessionId) {
    const outer = await get(MANIFESTS, sessionId);
    return outer?.purgeState || null;
  },
  async stepCanonicalPurge(sessionId, { limit = 16 } = {}) {
    if (!sessionId) throw new Error('RSAS_PURGE_SESSION_REQUIRED');
    await writeQueue;
    const outer = await get(MANIFESTS, sessionId);
    if (!outer) return { state: 'DONE', itemsWorked: 0, changedItems: 0, bytesWorked: 0, hasMore: false };
    const state = outer.purgeState;
    if (!state) throw new Error('RSAS_PURGE_NOT_PREPARED');
    if (state === 'DONE') return { state, itemsWorked: 0, changedItems: 0, bytesWorked: 0, hasMore: false };
    if (state === 'PURGE_PREPARED') {
      await put(MANIFESTS, { ...outer, purgeState: 'READ_RETIRED', wrappedDek: null });
      return { state: 'READ_RETIRED', itemsWorked: 1, changedItems: 1, bytesWorked: 0, hasMore: true };
    }
    if (state === 'READ_RETIRED' || state === 'SEGMENT_UNLINKING') {
      const cursor = Math.max(0, Number(outer.purgeCursor) || 0);
      const total = Math.max(0, Number(outer.purgeSegmentCount) || 0);
      const examined = Math.min(Math.max(1, Math.min(16, Number(limit) || 16)), Math.max(0, total - cursor));
      const deletion = examined > 0 ? await deleteSegmentRange(sessionId, cursor, examined) : { removed: 0, bytesWorked: 0 };
      const next = cursor + examined;
      const nextState = state === 'READ_RETIRED'
        ? 'SEGMENT_UNLINKING'
        : (next >= total ? 'TRIP_METADATA_PENDING' : 'SEGMENT_UNLINKING');
      await put(MANIFESTS, { ...outer, purgeState: nextState, purgeCursor: next });
      return { state: nextState, itemsWorked: examined, changedItems: deletion.removed, bytesWorked: deletion.bytesWorked, hasMore: true };
    }
    if (state === 'TRIP_METADATA_PENDING') {
      const { commitRsasRouteExpiry } = await import('@/lib/localTripRepository');
      const metadata = await commitRsasRouteExpiry({
        sessionId, tripId: outer.tripId,
        retentionDays: outer.purgeRetentionDays, expiredAt: outer.purgeExpiredAt,
        pointCount: outer.purgePointCount, motionRetentionDays: outer.purgeMotionRetentionDays,
      });
      if (metadata?.state === 'P6_FREEZE_PARTIAL') {
        return {
          state: 'TRIP_METADATA_PENDING', itemsWorked: Number(metadata.itemsWorked) || 1,
          changedItems: 0, bytesWorked: Number(metadata.bytesWorked) || 0, hasMore: true,
        };
      }
      // Erasure may have removed the session while repository/ledger I/O ran.
      // Never recreate even the DONE marker after that authority disappeared.
      if (!await get(MANIFESTS, sessionId)) {
        return { state: 'DONE', itemsWorked: 1, changedItems: 0, bytesWorked: 0, hasMore: false,
          auditItemsWorked: metadata.auditItemsWorked || 0, auditBytesWorked: metadata.auditBytesWorked || 0 };
      }
      // Keep only the privacy-safe idempotence marker until repository metadata
      // has committed its expired shape. No DEK or encrypted manifest remains.
      await put(MANIFESTS, {
        sessionId,
        tripId: outer.tripId,
        state: 'CANONICAL',
        purgeState: 'DONE',
        purgeCursor: outer.purgeCursor,
        purgeSegmentCount: outer.purgeSegmentCount,
        purgePointCount: outer.purgePointCount,
        purgeRetentionDays: outer.purgeRetentionDays,
        purgeMotionRetentionDays: outer.purgeMotionRetentionDays,
        purgeExpiredAt: outer.purgeExpiredAt,
      });
      return { state: 'DONE', itemsWorked: 1, changedItems: 1, bytesWorked: 0, hasMore: false, ...metadata };
    }
    throw new Error(`RSAS_PURGE_STATE_INVALID:${state}`);
  },
  async eraseAllForDataRights() {
    await eraseDatabase();
  },
  async seedPurgeSegmentsForTests(sessionId, count, ciphertextBytes = 16) {
    const outer = await get(MANIFESTS, sessionId);
    if (!outer?.purgeState) throw new Error('RSAS_PURGE_NOT_PREPARED');
    const total = Math.max(0, Math.floor(Number(count) || 0));
    for (let index = 0; index < total; index += 1) {
      await put(SEGMENTS, {
        sessionId, index, version: RSAS_VERSION, domain: 'trip_stream',
        plaintextBytes: 0, pointCount: 0, plaintextHash: '', nonce: '',
        ciphertext: 'x'.repeat(Math.max(0, Number(ciphertextBytes) || 0)),
      });
    }
    await put(MANIFESTS, { ...outer, purgeCursor: 0, purgeSegmentCount: total });
  },
  resetMemory() { current = null; },
  status() {
    return current ? {
      sessionId: current.sessionId,
      tripId: current.tripId,
      state: current.state,
      pointCount: current.pointCount,
      bufferBytes: current.bufferBytes,
      recentPoints: current.recent.length,
      overviewPoints: current.overview.length,
      segmentCount: current.segmentIndex,
    } : null;
  },
};

// ─── AUD-007: browser key-version reference accounting ───────────────────────
//
// Every current-format manifest holds `wrappedDek` — the AES key for that session's
// route segments — sealed under a ROOT key version. On the browser authority the spool
// IS the route store (`route_points: []` on the canonical record), so destroying that
// root version destroys the route.
//
// Rewrapping is O(1) bytes per session: unwrap the small DEK, re-seal it under the
// target version, rewrite only the outer manifest record. Route segments are never
// decrypted, never expanded, never rewritten — rotation must not become proportional to
// route length.

/** Bounded page so one rotation turn stays bounded regardless of session count. */
export const KEY_REWRAP_SESSIONS_PER_TURN = 25;

/** Bounded examination budget: exhaustion throws => UNKNOWN => the key is retained. */
const SPOOL_KEY_REFERENCE_SCAN_LIMIT = 512;

/**
 * Round 3. `getAll()` then `.slice()` is not a bounded turn: it materialises every
 * manifest first and only then applies the page, so the cost of "one bounded rewrap"
 * still grew with the number of stored sessions. Acquisition itself is now the cursor.
 *
 * Stops as soon as the page is full plus one look-ahead (which is what `hasMore` means),
 * or when the examination budget is exhausted — and exhaustion throws rather than
 * reporting a short answer, because a short answer here reads as "no references".
 *
 * @param {(record: any) => boolean} accept
 * @param {{limit: number, budget?: number}} options
 * @returns {Promise<{matched: any[], hasMore: boolean}>}
 */
const scanManifestRecords = async (accept, { limit, budget = SPOOL_KEY_REFERENCE_SCAN_LIMIT, afterKey = null }) => {
  const db = await openDb();
  if (!db) {
    const matched = [];
    let hasMore = false;
    let lastKey = afterKey;
    for (const [key, value] of memoryFallback.entries()) {
      if (!key.startsWith(`${MANIFESTS}:`)) continue;
      const sessionId = key.slice(MANIFESTS.length + 1);
      if (afterKey != null && sessionId <= afterKey) continue;
      lastKey = sessionId;
      if (!accept(value)) continue;
      if (matched.length >= limit) { hasMore = true; break; }
      matched.push(value);
    }
    return { matched, hasMore, lastKey, exhausted: !hasMore };
  }
  try {
    return await new Promise((resolve, reject) => {
      const matched = [];
      let examined = 0;
      let lastKey = afterKey;
      const tx = db.transaction(MANIFESTS, 'readonly');
      // Round 4: resume AFTER the last key this sweep reached. Restarting at the first
      // key each turn spent the budget re-walking rows already migrated.
      const range = afterKey == null ? null : IDBKeyRange.lowerBound(afterKey, true);
      const request = tx.objectStore(MANIFESTS).openCursor(range);
      request.onerror = () => reject(request.error || new Error('RSAS manifest enumeration failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve({ matched, hasMore: false, lastKey, exhausted: true }); return; }
        lastKey = cursor.primaryKey;
        if (accept(cursor.value)) {
          if (matched.length >= limit) {
            resolve({ matched, hasMore: true, lastKey, exhausted: false });
            return;
          }
          matched.push(cursor.value);
        }
        examined += 1;
        if (examined > budget) {
          reject(new Error('RSAS_KEY_REFERENCE_SCAN_BUDGET_EXHAUSTED'));
          return;
        }
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
};

const manifestKeyVersion = (record) => {
  const version = Number(record?.wrappedDek?.key_version);
  return Number.isFinite(version) ? version : null;
};

/**
 * How many stored sessions still hold a DEK sealed under `version`.
 * A legacy record whose shape we do not recognise counts as a reference: unknown is not
 * absence, and the safe direction is to keep the key.
 */
export async function countSpoolKeyVersionReferences(version) {
  const target = Math.max(0, Number(version) || 0);
  if (!target) return 0;
  // Early exit on the first reference: one is already enough to retain the key, so this
  // never has to visit -- let alone materialise -- the whole store.
  const { matched } = await scanManifestRecords((record) => {
    const declared = manifestKeyVersion(record);
    return declared === null || declared === target;   // unrecognised shape => retain
  }, { limit: 1 });
  return matched.length;
}

/**
 * Rewrap one bounded page of session DEKs from `version` onto `targetVersion`.
 * @returns {Promise<{rewrapped: number, hasMore: boolean}>}
 */
export async function rewrapSpoolKeyVersion(version, targetVersion, options = {}) {
  const from = Math.max(0, Number(version) || 0);
  const to = Math.max(1, Number(targetVersion) || 1);
  if (!from || from === to) return { rewrapped: 0, examined: 0, cursor: null, hasMore: false };

  const { matched: page, hasMore: moreRemaining, lastKey, exhausted } = await scanManifestRecords(
    (record) => manifestKeyVersion(record) === from,
    { limit: Math.max(1, Number(options.rowBudget) || KEY_REWRAP_SESSIONS_PER_TURN),
      afterKey: options.cursor ?? null },
  );

  let rewrapped = 0;
  for (const record of page) {
    // The unwrap/rewrap pair is itself a writer: hold the fence so finalization cannot
    // prove zero references while a DEK is momentarily in flight.
    // The registry already admits the whole rewrap step, so this inner span needs no
    // second token; holding one here would only narrow what the outer token covers.
    const release = () => {};
    try {
      const rawBase64 = await decryptSensitiveValue(
        record.wrappedDek,
        `browser:active_spool_dek:${record.sessionId}`,
      );
      const resealed = await encryptSensitiveValue(
        rawBase64,
        `browser:active_spool_dek:${record.sessionId}`,
        { keyVersion: to },
      );

      // `wrappedDek` is stored TWICE: in the outer record, and again inside the
      // encrypted inner manifest (`persistManifest` seals the whole durable snapshot,
      // which carries its own copy). `readPoints` restores the session key from the
      // INNER copy, so rewrapping only the outer one leaves the read path still asking
      // for the retired version -- the rotation looks complete and the route is still
      // lost. Both copies move together or the rewrap is a no-op where it matters.
      const sessionKey = await restoreSessionKey({
        sessionId: record.sessionId,
        wrappedDek: resealed,
      });
      const inner = await decodeManifest(record);
      let outerRecord = { ...record, wrappedDek: resealed };
      if (inner) {
        const manifestNonce = crypto.getRandomValues(new Uint8Array(12));
        const durable = { ...inner, wrappedDek: resealed };
        const manifestCiphertext = await crypto.subtle.encrypt({
          name: 'AES-GCM',
          iv: manifestNonce,
          additionalData: encoder.encode(
            `roadsage.browser.rsas.manifest.v1|${record.sessionId}|${record.tripId}`
          ),
          tagLength: 128,
        }, sessionKey, encoder.encode(JSON.stringify(durable)));
        outerRecord = {
          ...outerRecord,
          manifestNonce: bytesToBase64(manifestNonce),
          manifestCiphertext: bytesToBase64(new Uint8Array(manifestCiphertext)),
        };
      }
      await put(MANIFESTS, outerRecord);
      // The durable record is not the only copy. If this session is still the live
      // in-memory one, its snapshot still carries the OLD wrapper, and the next
      // `persistManifest()` would write it straight back over the rewrap -- silently
      // re-creating the dangling reference after the key had been retired. Rewrapping
      // must move both copies or neither.
      if (current && current.sessionId === record.sessionId) {
        current.wrappedDek = resealed;
        current.wrappedDekPromise = Promise.resolve(resealed);
      }
      rewrapped += 1;
    } catch {
      // Leave this session on the old version. The reference count stays non-zero, so
      // the key is retained and the route stays readable.
    } finally {
      release();
    }
  }

  // `hasMore` is only claimed when this turn actually MOVED something. A page that fails
  // wholesale would otherwise report "more to do" forever and rotation would never
  // finalize; reporting done instead leaves the references in place, which retains the
  // key. Stalled is safe; livelocked is not.
  return {
    rewrapped,
    examined: page.length,
    cursor: exhausted ? null : lastKey,
    hasMore: moreRemaining && rewrapped > 0,
  };
}

registerBrowserKeyReferenceDomain({
  id: 'browser_active_trip_spool',
  countReferences: countSpoolKeyVersionReferences,
  rewrapStep: async ({ fromVersion, toVersion, cursor, rowBudget }) => {
    const step = await rewrapSpoolKeyVersion(fromVersion, toVersion, { cursor, rowBudget });
    return {
      rewrapped: step.rewrapped,
      examined: step.examined,
      cursor: step.cursor,
      hasMore: step.hasMore,
    };
  },
});
