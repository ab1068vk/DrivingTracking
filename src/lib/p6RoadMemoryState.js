import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import {
  acknowledgeP6BrowserComponentRepair,
  beginP6BrowserComponentRepair,
  isP6BrowserSpeedV2Authority,
  speedKnowledgeStore,
  stepP6BrowserComponentRepair,
} from '@/lib/speedKnowledgeRepository';
import { withDurableKeyPublication } from '@/lib/browserKeyReferences';
import { openP6TripDerivedDatabase, P6_TRIP_DERIVED_STORES } from '@/lib/localTripRepository';

/**
 * Which P6 implementation owns this process's trips.
 *
 * P6 follows the **authority**, not the platform: on Android under browser
 * authority the trips live in IndexedDB, so routing on `isAndroid()` alone
 * reaches a native archive that holds none of them.
 */
const nativeDerivedStateSelected = () => isAndroid() && import.meta.env.VITE_P35_NATIVE_AUTHORITY === 'true';

import { decryptSensitiveValue, encryptSensitiveValue } from '@/lib/securePayloadCrypto';
import { requireBrowserP6DerivedStorage } from '@/lib/p6DerivedStorage';
import { P6_DOMAIN_KEYS, P6_READINESS_STATES } from '@/lib/p6Contracts';
import {
  createP6AffectedTripSelectionRequest,
  readP6TripDomainReadiness,
  setP6TripDomainReadiness,
} from '@/lib/p6TripDerivedState';
import { nativeTripArchive } from '@/lib/nativeTripArchive';
import { isAndroid } from '@/lib/nativePlatform';
import {
  finalizeP6RoadMemoryWindow,
  mergeCompatibleP6RoadMemoryObservations,
  roadMemoryDistanceMeters,
} from '@/lib/localRoadMemory';
import { decodeP6PointBlock } from '@/lib/p6PointBlockCodec';

const WINDOW_TARGET_M = 220;
const MAX_POINT_GAP_M = 250;
const MAX_ACCURACY_M = 50;
const MIN_SPEED_KMH = 5;
const MAX_SPEED_KMH = 180;
const encoder = new TextEncoder();
const bytesOf = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error('P6 road transaction aborted'));
});

const firstCompletedWork = async () => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readonly');
    return await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).index('by_state').get('COMPLETE')) || null;
  } finally { db.close(); }
};

const spillAt = async (work, ordinal) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS, 'readonly');
    return await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_OBSERVATIONS)
      .get(`${work.tripId}:${work.desiredRevision}:${ordinal}`)) || null;
  } finally { db.close(); }
};

const windowKey = (work, ordinal) => `window:${work.tripId}:${work.desiredRevision}:${ordinal}`;
const reducerKey = (work) => `reducer:${work.tripId}:${work.desiredRevision}`;
const outputKey = (work, ordinal) => `output:${work.tripId}:${work.desiredRevision}:${ordinal}`;
const context = (work, kind, ordinal = 0) => (
  `p6:road-reducer:${kind}:${work.tripId}:${work.desiredRevision}:${ordinal}`
);

const readRow = async (key, encryptionContext) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS, 'readonly');
    const row = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS).get(key));
    return row?.payload
      ? { row, value: await decryptSensitiveValue(row.payload, encryptionContext) }
      : null;
  } finally { db.close(); }
};

const updateWork = async (work, roadCursor, state = 'COMPLETE') => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(store.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return false;
    }
    store.put({
      ...work, state, roadCursor, updatedAt: Date.now(),
    });
    await transactionDone(tx);
    return true;
  } finally { db.close(); }
};

const workStillCurrent = async (work) => {
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.WORK, 'readonly');
    const current = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).get(work.tripId));
    return String(current?.desiredRevision ?? '') === String(work.desiredRevision)
      && current?.sourceHash === work.sourceHash;
  } finally { db.close(); }
};

const timestampMs = (point) => {
  const raw = point?.timestamp ?? point?.timestampMs ?? point?.recorded_at;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};
const radians = (value) => Number(value) * Math.PI / 180;
const bearing = (a, b) => {
  const lat1 = radians(a?.lat);
  const lat2 = radians(b?.lat);
  const dLng = radians(Number(b?.lng) - Number(a?.lng));
  if (![lat1, lat2, dLng].every(Number.isFinite)) return null;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};
const angleDifference = (a, b) => Math.abs((((Number(a) - Number(b)) + 540) % 360) - 180);
// The shared source spill is stored as a columnar public-point block so the
// derived footprint stays inside the frozen per-point envelope. Every reducer
// pass reads it through one decoder, and a block written before the codec is a
// plain array that decodes unchanged.
const spillPointCache = new WeakMap();
const spillPointsCache = (decoded) => {
  if (!decoded || typeof decoded !== 'object') return [];
  const cached = spillPointCache.get(decoded);
  if (cached) return cached;
  const points = decodeP6PointBlock(decoded.sourcePointBlock ?? decoded.sourcePoints ?? []);
  spillPointCache.set(decoded, points);
  return points;
};

const roadUsable = (point) => Number.isFinite(Number(point?.lat))
  && Number.isFinite(Number(point?.lng))
  && (!Number.isFinite(Number(point?.accuracy)) || Number(point.accuracy) <= MAX_ACCURACY_M);

const emptySummary = () => ({
  startOrdinal: null,
  endOrdinal: null,
  usableCount: 0,
  speedCount: 0,
  speedSum: 0,
  speedSquareSum: 0,
  rawSpeedCount: 0,
  stopCount: 0,
  lowSpeedCount: 0,
  accuracyCount: 0,
  distanceM: 0,
  largestTimestampGapMs: 0,
  headingChangeDeg: 0,
  lastPoint: null,
  lastBearing: null,
  recordedAt: null,
  utcOffsetMinutes: null,
  timezoneId: '',
  estimatedLimitCounts: {},
});

const addPoint = (summary, point, globalOrdinal) => {
  const next = { ...summary, estimatedLimitCounts: { ...(summary.estimatedLimitCounts || {}) } };
  const previous = next.lastPoint;
  const gap = previous ? roadMemoryDistanceMeters(previous, point) : 0;
  if (previous) next.distanceM += gap;
  next.startOrdinal ??= globalOrdinal;
  next.endOrdinal = globalOrdinal;
  next.usableCount += 1;
  const rawSpeed = Number(point.speedKmh ?? point.speed_kmh);
  if (Number.isFinite(rawSpeed)) {
    next.rawSpeedCount += 1;
    if (rawSpeed < MIN_SPEED_KMH) next.stopCount += 1;
    if (rawSpeed < 12) next.lowSpeedCount += 1;
    if (rawSpeed >= MIN_SPEED_KMH && rawSpeed <= MAX_SPEED_KMH) {
      next.speedCount += 1;
      next.speedSum += rawSpeed;
      next.speedSquareSum += rawSpeed ** 2;
    }
  }
  const accuracy = Number(point.accuracy);
  if (Number.isFinite(accuracy) && accuracy >= 0) next.accuracyCount += 1;
  const previousTime = timestampMs(previous);
  const currentTime = timestampMs(point);
  if (Number.isFinite(previousTime) && Number.isFinite(currentTime)) {
    next.largestTimestampGapMs = Math.max(next.largestTimestampGapMs, Math.max(0, currentTime - previousTime));
  }
  const nextBearing = previous ? bearing(previous, point) : null;
  if (Number.isFinite(next.lastBearing) && Number.isFinite(nextBearing)) {
    next.headingChangeDeg += angleDifference(next.lastBearing, nextBearing);
  }
  if (Number.isFinite(nextBearing)) next.lastBearing = nextBearing;
  const source = String(point.limitSource ?? point.speed_limit_source ?? '');
  const estimated = Number(point.speedLimitKmh ?? point.speed_limit_kmh);
  if (['inferred', 'region_default_estimate'].includes(source) && Number.isFinite(estimated) && estimated > 0) {
    const rung = String(Math.round(estimated / 10) * 10);
    next.estimatedLimitCounts[rung] = (Number(next.estimatedLimitCounts[rung]) || 0) + 1;
  }
  next.recordedAt = point.timestamp ?? point.timestampMs ?? point.recorded_at ?? next.recordedAt;
  next.utcOffsetMinutes = point.utcOffsetMinutes ?? point.utc_offset_minutes ?? next.utcOffsetMinutes;
  next.timezoneId = String(point.timezoneId ?? point.timezone_id ?? next.timezoneId ?? '');
  next.lastPoint = point;
  return next;
};

const flushWindow = (windows, summary, ordinal) => {
  if (!summary.usableCount) return { summary, ordinal };
  windows.push({ ordinal, summary });
  return { summary: emptySummary(), ordinal: ordinal + 1 };
};

/**
 * AUD-007 REDESIGN: encrypts and then commits, so the pair is ONE publication. The old
 * module-level rule only asked whether SOME function here was admitted; the call-site
 * rule requires every persistent encryption to sit inside one.
 */
const scanTurn = async (work, cursor) => withDurableKeyPublication(async () => {
  const sourceOrdinal = Math.max(0, Number(cursor.sourceOrdinal) || 0);
  const spill = await spillAt(work, sourceOrdinal);
  const reducer = await readRow(reducerKey(work), context(work, 'reducer'));
  let summary = reducer?.value?.summary || emptySummary();
  let ordinal = Math.max(0, Number(reducer?.value?.windowOrdinal) || 0);
  const windows = [];
  let decoded = null;
  if (spill) {
    decoded = await decryptSensitiveValue(
      spill.payload,
      `p6:road-observations:${work.tripId}:${work.desiredRevision}:${sourceOrdinal}`,
    );
    for (let index = 0; index < spillPointsCache(decoded).length; index += 1) {
      const point = spillPointsCache(decoded)[index];
      if (!roadUsable(point)) continue;
      const gap = summary.lastPoint ? roadMemoryDistanceMeters(summary.lastPoint, point) : 0;
      if (summary.lastPoint && gap > MAX_POINT_GAP_M) {
        ({ summary, ordinal } = flushWindow(windows, summary, ordinal));
      }
      summary = addPoint(summary, point, Number(spill.pointStartOrdinal) + index);
      if (summary.distanceM >= WINDOW_TARGET_M) {
        ({ summary, ordinal } = flushWindow(windows, summary, ordinal));
      }
    }
  } else {
    ({ summary, ordinal } = flushWindow(windows, summary, ordinal));
  }
  const reducerPayload = await encryptSensitiveValue(
    { summary, windowOrdinal: ordinal },
    context(work, 'reducer'),
  );
  const windowPayloads = await Promise.all(windows.map(async (window) => ({
    ...window,
    payload: await encryptSensitiveValue(
      { summary: window.summary },
      context(work, 'window', window.ordinal),
    ),
  })));
  const proposedBytes = bytesOf(reducerPayload) +
    windowPayloads.reduce((sum, value) => sum + bytesOf(value.payload), 0);
  await requireBrowserP6DerivedStorage(proposedBytes);
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const store = tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS);
    const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(workStore.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: bytesOf(decoded || {}), hasMore: true };
    }
    store.put({
      key: reducerKey(work),
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      windowOrdinal: -1,
      state: 'ACCUMULATOR',
      payload: reducerPayload,
      updatedAt: Date.now(),
    });
    windowPayloads.forEach((window) => store.put({
      key: windowKey(work, window.ordinal),
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      windowOrdinal: window.ordinal,
      state: 'SELECT',
      payload: window.payload,
      updatedAt: Date.now(),
    }));
    workStore.put({
      ...work,
      roadCursor: spill
        ? { phase: 'SCAN', sourceOrdinal: sourceOrdinal + 1 }
        : { phase: 'SELECT', windowOrdinal: 0, bit: 0, sourceOrdinal: 0, targets: null },
      updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return {
    state: spill ? 'WINDOW_SCAN' : 'WINDOW_SCAN_COMPLETE',
    itemsWorked: (spill?.pointCount || 0) + windowPayloads.length + 2,
    bytesWorked: bytesOf(decoded || {}) + proposedBytes,
    hasMore: true,
  };
});

const percentileRanks = (count, ratio) => {
  if (count <= 0) return [];
  const index = (count - 1) * ratio;
  return [Math.floor(index), Math.ceil(index)];
};
const initialTargets = (summary) => [
  ...percentileRanks(summary.speedCount, 0.85).map((rank, index) => ({ id: `p85_${index}`, field: 'speed', rank })),
  ...percentileRanks(summary.speedCount, 0.5).map((rank, index) => ({ id: `median_${index}`, field: 'speed', rank })),
  ...percentileRanks(summary.accuracyCount, 0.5).map((rank, index) => ({ id: `accuracy_${index}`, field: 'accuracy', rank })),
].map((value) => ({ ...value, remainingRank: value.rank, prefix: '', zeroCount: 0 }));

const bitsFor = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Number(value), false);
  return view.getBigUint64(0, false).toString(2).padStart(64, '0');
};
const valueForBits = (bits) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0b${bits}`), false);
  return view.getFloat64(0, false);
};
const valuesFor = (spill, decoded, summary, field) => {
  const out = [];
  for (let index = 0; index < spillPointsCache(decoded).length; index += 1) {
    const globalOrdinal = Number(spill.pointStartOrdinal) + index;
    if (globalOrdinal < summary.startOrdinal || globalOrdinal > summary.endOrdinal) continue;
    const point = spillPointsCache(decoded)[index];
    if (!roadUsable(point)) continue;
    const value = field === 'speed' ? Number(point.speedKmh ?? point.speed_kmh) : Number(point.accuracy);
    if (field === 'speed' && (!Number.isFinite(value) || value < MIN_SPEED_KMH || value > MAX_SPEED_KMH)) continue;
    if (field === 'accuracy' && (!Number.isFinite(value) || value < 0)) continue;
    out.push(value);
  }
  return out;
};
const obviousRejection = (summary) => summary.distanceM < 90
  || summary.speedCount < 4
  || summary.stopCount / Math.max(1, summary.rawSpeedCount) > 0.20
  || summary.lowSpeedCount / Math.max(1, summary.rawSpeedCount) > 0.32
  || summary.largestTimestampGapMs > 15000
  || summary.headingChangeDeg > 105;

/**
 * AUD-007 REDESIGN: encrypts and then commits, so the pair is ONE publication. The old
 * module-level rule only asked whether SOME function here was admitted; the call-site
 * rule requires every persistent encryption to sit inside one.
 */
const saveWindowAndWork = async (work, ordinal, value, state, roadCursor) => withDurableKeyPublication(async () => {
  const payload = await encryptSensitiveValue(value, context(work, 'window', ordinal));
  await requireBrowserP6DerivedStorage(bytesOf(payload));
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(workStore.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return 0;
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS).put({
      key: windowKey(work, ordinal),
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      windowOrdinal: ordinal,
      state,
      payload,
      updatedAt: Date.now(),
    });
    workStore.put({
      ...work, roadCursor, updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return bytesOf(payload);
});

const selectTurn = async (work, cursor) => {
  const ordinal = Math.max(0, Number(cursor.windowOrdinal) || 0);
  const record = await readRow(windowKey(work, ordinal), context(work, 'window', ordinal));
  if (!record) {
    await updateWork(work, { phase: 'REDUCE', windowOrdinal: 0, outputOrdinal: 0 });
    return { state: 'ORDER_STATS_COMPLETE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
  }
  const window = record.value;
  if (obviousRejection(window.summary)) {
    const bytesWorked = await saveWindowAndWork(
      work,
      ordinal,
      { ...window, observation: null },
      'FINALIZED',
      { phase: 'SELECT', windowOrdinal: ordinal + 1, bit: 0, sourceOrdinal: 0, targets: null },
    );
    return { state: 'WINDOW_REJECTED', itemsWorked: 2, bytesWorked, hasMore: true };
  }
  const targets = cursor.targets || initialTargets(window.summary);
  const bit = Math.max(0, Number(cursor.bit) || 0);
  const sourceOrdinal = Math.max(0, Number(cursor.sourceOrdinal) || 0);
  if (bit < 64) {
    const spill = await spillAt(work, sourceOrdinal);
    if (spill) {
      const decoded = await decryptSensitiveValue(
        spill.payload,
        `p6:road-observations:${work.tripId}:${work.desiredRevision}:${sourceOrdinal}`,
      );
      const nextTargets = targets.map((target) => {
        let zeroCount = Number(target.zeroCount) || 0;
        for (const value of valuesFor(spill, decoded, window.summary, target.field)) {
          const bits = bitsFor(value);
          if (bits.startsWith(target.prefix) && bits[bit] === '0') zeroCount += 1;
        }
        return { ...target, zeroCount };
      });
      await updateWork(work, {
        phase: 'SELECT',
        windowOrdinal: ordinal,
        bit,
        sourceOrdinal: sourceOrdinal + 1,
        targets: nextTargets,
      });
      return {
        state: 'ORDER_STATS_SCAN',
        // The spill page is scanned once while the fixed six selectors are
        // updated in the same pass. Account source rows and selector state
        // mutations without multiplying the physical page read.
        itemsWorked: (spill.pointCount || 0) + targets.length,
        bytesWorked: bytesOf(decoded || {}),
        hasMore: true,
      };
    }
    const nextTargets = targets.map((target) => {
      const chooseZero = target.remainingRank < target.zeroCount;
      return {
        ...target,
        prefix: `${target.prefix}${chooseZero ? '0' : '1'}`,
        remainingRank: chooseZero ? target.remainingRank : target.remainingRank - target.zeroCount,
        zeroCount: 0,
      };
    });
    await updateWork(work, {
      phase: 'SELECT',
      windowOrdinal: ordinal,
      bit: bit + 1,
      sourceOrdinal: 0,
      targets: nextTargets,
    });
    return {
      state: 'ORDER_STATS_BIT_COMPLETE',
      itemsWorked: targets.length + 1,
      bytesWorked: 0,
      hasMore: true,
    };
  }
  const selected = Object.fromEntries(targets.map((target) => [target.id, valueForBits(target.prefix)]));
  const index85 = (window.summary.speedCount - 1) * 0.85;
  const index50 = (window.summary.speedCount - 1) * 0.5;
  const accuracyIndex = (window.summary.accuracyCount - 1) * 0.5;
  const interpolate = (a, b, index) => a + (b - a) * (index - Math.floor(index));
  const statistics = {
    p85Kmh: interpolate(selected.p85_0, selected.p85_1, index85),
    medianKmh: interpolate(selected.median_0, selected.median_1, index50),
    medianAccuracyM: window.summary.accuracyCount
      ? interpolate(selected.accuracy_0, selected.accuracy_1, accuracyIndex)
      : null,
    explicitEstimatedLimit: Object.entries(window.summary.estimatedLimitCounts || {})
      .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0]?.[0] ?? null,
  };
  const bytesWorked = await saveWindowAndWork(
    work,
    ordinal,
    { ...window, statistics, sectionPoints: [] },
    'GEOMETRY',
    { phase: 'GEOMETRY', windowOrdinal: ordinal, sourceOrdinal: 0, usableOrdinal: 0 },
  );
  return {
    state: 'ORDER_STATS_EXACT',
    itemsWorked: targets.length + 1,
    bytesWorked,
    hasMore: true,
  };
};

const geometryTurn = async (work, cursor) => {
  const ordinal = Math.max(0, Number(cursor.windowOrdinal) || 0);
  const record = await readRow(windowKey(work, ordinal), context(work, 'window', ordinal));
  if (!record) {
    await updateWork(work, {
      phase: 'SELECT', windowOrdinal: ordinal + 1, bit: 0, sourceOrdinal: 0, targets: null,
    });
    return { state: 'WINDOW_MISSING', itemsWorked: 1, bytesWorked: 0, hasMore: true };
  }
  const window = record.value;
  const sourceOrdinal = Math.max(0, Number(cursor.sourceOrdinal) || 0);
  const spill = await spillAt(work, sourceOrdinal);
  if (spill) {
    const decoded = await decryptSensitiveValue(
      spill.payload,
      `p6:road-observations:${work.tripId}:${work.desiredRevision}:${sourceOrdinal}`,
    );
    let usableOrdinal = Math.max(0, Number(cursor.usableOrdinal) || 0);
    const targets = window.summary.usableCount <= 24
      ? new Set(Array.from({ length: window.summary.usableCount }, (_value, index) => index))
      : new Set(Array.from({ length: 24 }, (_value, index) => (
          Math.round(index * (window.summary.usableCount - 1) / 23)
        )));
    const sectionPoints = [...(window.sectionPoints || [])];
    for (let index = 0; index < spillPointsCache(decoded).length; index += 1) {
      const globalOrdinal = Number(spill.pointStartOrdinal) + index;
      if (globalOrdinal < window.summary.startOrdinal || globalOrdinal > window.summary.endOrdinal) continue;
      const point = spillPointsCache(decoded)[index];
      if (!roadUsable(point)) continue;
      if (targets.has(usableOrdinal)) sectionPoints.push({ lat: Number(point.lat), lng: Number(point.lng) });
      usableOrdinal += 1;
    }
    const bytesWorked = await saveWindowAndWork(
      work,
      ordinal,
      { ...window, sectionPoints },
      'GEOMETRY',
      { phase: 'GEOMETRY', windowOrdinal: ordinal, sourceOrdinal: sourceOrdinal + 1, usableOrdinal },
    );
    return {
      state: 'WINDOW_GEOMETRY_SCAN',
      itemsWorked: spill.pointCount || 0,
      bytesWorked: bytesOf(decoded || {}) + bytesWorked,
      hasMore: true,
    };
  }
  const observation = finalizeP6RoadMemoryWindow({
    summary: window.summary,
    sectionPoints: window.sectionPoints || [],
    statistics: window.statistics || {},
    trip: { id: work.tripId },
  });
  const bytesWorked = await saveWindowAndWork(
    work,
    ordinal,
    { ...window, observation },
    'FINALIZED',
    { phase: 'SELECT', windowOrdinal: ordinal + 1, bit: 0, sourceOrdinal: 0, targets: null },
  );
  return {
    state: 'WINDOW_FINALIZED',
    itemsWorked: (window.sectionPoints || []).length + 2,
    bytesWorked,
    hasMore: true,
  };
};

/**
 * AUD-007 REDESIGN: encrypts and then commits, so the pair is ONE publication. The old
 * module-level rule only asked whether SOME function here was admitted; the call-site
 * rule requires every persistent encryption to sit inside one.
 */
const writeOutput = async (work, ordinal, observation) => withDurableKeyPublication(async () => {
  const payload = await encryptSensitiveValue({ observation }, context(work, 'output', ordinal));
  await requireBrowserP6DerivedStorage(bytesOf(payload));
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const current = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return 0;
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS).put({
      key: outputKey(work, ordinal),
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      windowOrdinal: ordinal,
      state: 'OUTPUT',
      payload,
      updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return bytesOf(payload);
});

/**
 * AUD-007 REDESIGN: encrypts and then commits, so the pair is ONE publication. The old
 * module-level rule only asked whether SOME function here was admitted; the call-site
 * rule requires every persistent encryption to sit inside one.
 */
const reduceTurn = async (work, cursor) => withDurableKeyPublication(async () => {
  const ordinal = Math.max(0, Number(cursor.windowOrdinal) || 0);
  let outputOrdinal = Math.max(0, Number(cursor.outputOrdinal) || 0);
  const window = await readRow(windowKey(work, ordinal), context(work, 'window', ordinal));
  const reducer = await readRow(reducerKey(work), context(work, 'reducer'));
  let pending = reducer?.value?.pendingObservation || null;
  let bytesWorked = 0;
  if (!window) {
    if (pending) bytesWorked += await writeOutput(work, outputOrdinal, pending);
    const payload = await encryptSensitiveValue(
      { summary: emptySummary(), windowOrdinal: 0, pendingObservation: null },
      context(work, 'reducer'),
    );
    const db = await openP6TripDerivedDatabase();
    try {
      const tx = db.transaction([
        P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
        P6_TRIP_DERIVED_STORES.WORK,
      ], 'readwrite');
      const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
      const current = await requestResult(workStore.get(work.tripId));
      if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
        || current?.sourceHash !== work.sourceHash) {
        tx.abort();
        return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
      }
      tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS).put({
        key: reducerKey(work),
        tripId: work.tripId,
        sourceRevision: work.desiredRevision,
        windowOrdinal: -1,
        state: 'REDUCED',
        payload,
        updatedAt: Date.now(),
      });
      workStore.put({
        ...work, roadCursor: { phase: 'APPLY', outputOrdinal: 0 }, updatedAt: Date.now(),
      });
      await transactionDone(tx);
    } finally { db.close(); }
    return {
      state: 'WINDOW_REDUCE_COMPLETE',
      itemsWorked: pending ? 3 : 2,
      bytesWorked: bytesWorked + bytesOf(payload),
      hasMore: true,
    };
  }
  const observation = window.value.observation || null;
  if (observation) {
    const merged = pending
      ? mergeCompatibleP6RoadMemoryObservations(pending, observation)
      : null;
    if (merged) {
      pending = merged;
    } else {
      if (pending) {
        bytesWorked += await writeOutput(work, outputOrdinal, pending);
        outputOrdinal += 1;
      }
      pending = observation;
    }
  }
  const payload = await encryptSensitiveValue(
    { ...(reducer?.value || {}), pendingObservation: pending },
    context(work, 'reducer'),
  );
  await requireBrowserP6DerivedStorage(bytesOf(payload));
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.ROAD_WINDOWS,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(workStore.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.ROAD_WINDOWS).put({
      key: reducerKey(work),
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      windowOrdinal: -1,
      state: 'REDUCING',
      payload,
      updatedAt: Date.now(),
    });
    workStore.put({
      ...work,
      roadCursor: { phase: 'REDUCE', windowOrdinal: ordinal + 1, outputOrdinal },
      updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  return {
    state: 'WINDOW_REDUCE',
    itemsWorked: 3,
    bytesWorked: bytesWorked + bytesOf(payload),
    hasMore: true,
  };
});

const receiptKey = (work, ordinal) => (
  `D4:browser:${work.tripId}:${work.desiredRevision}:${ordinal}`
);

const capacityTarget = (work, ordinal, error = {}) => ({
  targetId: `${work.tripId}:${String(work.desiredRevision)}:${String(work.sourceHash || '')}:${ordinal}`,
  tripId: work.tripId,
  sourceRevision: work.desiredRevision,
  sourceHash: work.sourceHash || '',
  outputOrdinal: ordinal,
  bucketId: String(error.bucketId || ''),
  partitionKind: String(error.partitionKind || 'AUTOMATIC'),
  encodedBytes: Math.max(0, Number(error.encodedBytes) || 0),
});

const persistCapacityBlocked = async (work, ordinal, error) => {
  const blockedTarget = capacityTarget(work, ordinal, error);
  const db = await openP6TripDerivedDatabase();
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.SOURCE_APPLIED,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(workStore.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return null;
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED).put({
      key: receiptKey(work, ordinal),
      domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
      tripId: work.tripId,
      sourceRevision: work.desiredRevision,
      ordinal,
      state: P6_READINESS_STATES.CAPACITY_BLOCKED,
      blockedTarget,
      appliedAt: Date.now(),
    });
    workStore.put({
      ...work,
      roadCursor: { phase: 'APPLY', outputOrdinal: ordinal + 1 },
      updatedAt: Date.now(),
    });
    await transactionDone(tx);
  } finally { db.close(); }
  for (const subject of [work.tripId, 'all']) {
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
      subject,
      sourceBinding: 'browser-v2',
      requiredVersion: work.desiredRevision,
      state: P6_READINESS_STATES.CAPACITY_BLOCKED,
      complete: false,
      blockedTarget,
    });
  }
  return blockedTarget;
};

/** Retires a D4 capacity disposition that no longer describes a live target.
 * A head naming a different blocked target keeps its terminal state exactly. */
const clearCapacityDisposition = async (work, matches) => {
  for (const subject of [work.tripId, 'all']) {
    const head = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, subject);
    if (head?.state !== P6_READINESS_STATES.CAPACITY_BLOCKED) continue;
    if (!matches(head.blockedTarget || {})) continue;
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
      subject,
      sourceBinding: 'browser-v2',
      requiredVersion: work.desiredRevision,
      state: P6_READINESS_STATES.PARTIAL,
      complete: false,
    });
  }
};

/** Explicit E2 is the only authority that may retire a terminal capacity
 * disposition on an unchanged target. The retirement is one durable transition:
 * it deletes that target's blocked receipt, consumes the one-shot
 * re-evaluation grant on the work row so an unchanged target cannot loop, and
 * clears only the D4 heads naming that exact target. Every other receipt keeps
 * its ordinary exactly-once dedupe. */
const retireCapacityBlockedTarget = async (work, ordinal, receipt) => {
  const db = await openP6TripDerivedDatabase();
  let retired = null;
  try {
    const tx = db.transaction([
      P6_TRIP_DERIVED_STORES.SOURCE_APPLIED,
      P6_TRIP_DERIVED_STORES.WORK,
    ], 'readwrite');
    const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
    const current = await requestResult(workStore.get(work.tripId));
    if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
      || current?.sourceHash !== work.sourceHash) {
      tx.abort();
      return null;
    }
    tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED).delete(receiptKey(work, ordinal));
    retired = { ...work, reevaluateCapacityBlocked: false, updatedAt: Date.now() };
    workStore.put(retired);
    await transactionDone(tx);
  } finally { db.close(); }
  const retiredId = String(receipt?.blockedTarget?.targetId || '');
  if (retiredId) {
    await clearCapacityDisposition(work, (target) => String(target?.targetId || '') === retiredId);
  }
  return retired;
};

const applyTurn = async (work, cursor) => {
  const ordinal = Math.max(0, Number(cursor.outputOrdinal) || 0);
  const output = await readRow(outputKey(work, ordinal), context(work, 'output', ordinal));
  if (!output) {
    if (!await updateWork(work, null, 'ROAD_COMPLETE')) {
      return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    const existing = await readP6TripDomainReadiness(P6_DOMAIN_KEYS.ROAD_LEARNING, work.tripId);
    if (existing?.state === P6_READINESS_STATES.CAPACITY_BLOCKED
      && String(existing?.requiredVersion ?? '') === String(work.desiredRevision)) {
      return {
        state: P6_READINESS_STATES.CAPACITY_BLOCKED,
        blockedTarget: existing.blockedTarget || null,
        itemsWorked: 1, bytesWorked: 0, hasMore: false,
      };
    }
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
      subject: work.tripId,
      sourceBinding: 'browser-v2',
      requiredVersion: work.desiredRevision,
      appliedVersion: work.desiredRevision,
      state: P6_READINESS_STATES.VERIFIED,
      complete: true,
    });
    return { state: 'COMPLETE', itemsWorked: 2, bytesWorked: 0, hasMore: true };
  }
  const db = await openP6TripDerivedDatabase();
  let receipt = null;
  try {
    const tx = db.transaction(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED, 'readonly');
    receipt = await requestResult(tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED)
      .get(receiptKey(work, ordinal)));
  } finally { db.close(); }
  if (receipt?.state === P6_READINESS_STATES.CAPACITY_BLOCKED) {
    if (work.reevaluateCapacityBlocked !== true) {
      await updateWork(work, { phase: 'APPLY', outputOrdinal: ordinal + 1 });
      return {
        state: P6_READINESS_STATES.CAPACITY_BLOCKED,
        blockedTarget: receipt.blockedTarget,
        itemsWorked: 1, bytesWorked: 0, hasMore: false,
      };
    }
    const retired = await retireCapacityBlockedTarget(work, ordinal, receipt);
    if (!retired) return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    work = retired;
    receipt = null;
  }
  let result = { changedCandidates: [] };
  if (!receipt) {
    if (!await workStillCurrent(work)) {
      return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true };
    }
    const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
    result = await knowledge.applyP6RoadMemoryObservations(
      [output.value.observation],
      { sourceAuthority: 'browser', tripId: work.tripId, sourceRevision: work.desiredRevision },
    );
    const writeDb = await openP6TripDerivedDatabase();
    try {
      const tx = writeDb.transaction([
        P6_TRIP_DERIVED_STORES.SOURCE_APPLIED,
        P6_TRIP_DERIVED_STORES.WORK,
      ], 'readwrite');
      const workStore = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK);
      const current = await requestResult(workStore.get(work.tripId));
      if (String(current?.desiredRevision ?? '') !== String(work.desiredRevision)
        || current?.sourceHash !== work.sourceHash) {
        tx.abort();
        return { state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: bytesOf(output.value), hasMore: true };
      }
      tx.objectStore(P6_TRIP_DERIVED_STORES.SOURCE_APPLIED).put({
        key: receiptKey(work, ordinal),
        domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
        tripId: work.tripId,
        sourceRevision: work.desiredRevision,
        ordinal,
        appliedAt: Date.now(),
      });
      workStore.put({
        ...work,
        roadCursor: { phase: 'APPLY', outputOrdinal: ordinal + 1 },
        updatedAt: Date.now(),
      });
      await transactionDone(tx);
    } finally { writeDb.close(); }
  } else {
    await updateWork(work, { phase: 'APPLY', outputOrdinal: ordinal + 1 });
  }
  if (result.changedCandidates?.length) {
    await beginP6BrowserComponentRepair(result.changedCandidates.map((value) => value.id));
    await createP6AffectedTripSelectionRequest({
      descriptors: result.changedCandidates.map((value) => ({ ...value, kind: 'correction' })),
      reason: 'p6_road_memory_changed',
    });
  }
  return {
    state: 'APPLY',
    itemsWorked: 3,
    bytesWorked: bytesOf(output.value),
    hasMore: true,
  };
};

async function stepP6RoadMemoryUpdateInternal() {
  const work = await firstCompletedWork();
  if (!work) {
    const db = await openP6TripDerivedDatabase();
    try {
      const tx = db.transaction([P6_TRIP_DERIVED_STORES.WORK, P6_TRIP_DERIVED_STORES.MANIFESTS], 'readwrite');
      const workIndex = tx.objectStore(P6_TRIP_DERIVED_STORES.WORK).index('by_state');
      const manifests = tx.objectStore(P6_TRIP_DERIVED_STORES.MANIFESTS);
      const [dirty, building, preview, cleanup, complete, deferred, head] = await Promise.all([
        requestResult(workIndex.count('DIRTY')),
        requestResult(workIndex.count('BUILDING')),
        requestResult(workIndex.count('PREVIEW_BUILD')),
        requestResult(workIndex.count('TOMBSTONE_CLEANUP')),
        requestResult(workIndex.count('COMPLETE')),
        // A subject parked for an explicit pass has no road observations to
        // reduce, so D4 owes it a rebuild just as D2 and D3 do. Without this
        // the head could still be promoted by a later, unrelated trip.
        requestResult(workIndex.count('EXPLICIT_SOURCE_REQUIRED')),
        requestResult(manifests.get(`${P6_DOMAIN_KEYS.ROAD_LEARNING}:all`)),
      ]);
      const pending = dirty + building + preview + cleanup + complete + deferred;
      const eligible = [P6_READINESS_STATES.DIRTY, P6_READINESS_STATES.PARTIAL].includes(head?.state);
      if (!pending && eligible) manifests.put({
        ...head,
        key: `${P6_DOMAIN_KEYS.ROAD_LEARNING}:all`,
        domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
        subject: 'all',
        sourceBinding: 'browser-v2',
        state: P6_READINESS_STATES.VERIFIED,
        complete: true,
        updatedAt: Date.now(),
      });
      await transactionDone(tx);
      if (!pending && eligible) return { state: P6_READINESS_STATES.VERIFIED,
        itemsWorked: 1, bytesWorked: 0, hasMore: false };
      return { state: 'IDLE', itemsWorked: 0, bytesWorked: 0, hasMore: false };
    } finally { db.close(); }
  }
  if (!await isP6BrowserSpeedV2Authority()) {
    await setP6TripDomainReadiness({
      domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
      subject: work.tripId,
      sourceBinding: 'browser-v1',
      requiredVersion: work.desiredRevision,
      state: P6_READINESS_STATES.CONVERSION_REQUIRED,
      complete: false,
    });
    return {
      state: P6_READINESS_STATES.CONVERSION_REQUIRED,
      itemsWorked: 1,
      bytesWorked: 0,
      hasMore: false,
    };
  }
  const cursor = work.roadCursor || { phase: 'SCAN', sourceOrdinal: 0 };
  if (cursor.phase === 'SCAN') return scanTurn(work, cursor);
  if (cursor.phase === 'SELECT') return selectTurn(work, cursor);
  if (cursor.phase === 'GEOMETRY') return geometryTurn(work, cursor);
  if (cursor.phase === 'REDUCE') return reduceTurn(work, cursor);
  return applyTurn(work, cursor);
}

/**
 * AUD-007 round 5: this turn captures the outgoing key version, encrypts, and commits
 * durably — so it holds admission for the whole span. Without it a finalizer sees no
 * admitted writer, proves zero, deletes the version, and the turn then publishes durable
 * ciphertext under a destroyed key. The turn is bounded, so the token is held briefly.
 */
export async function stepP6RoadMemoryUpdate() {
  return withDurableKeyPublication(async () => {
    try {
      return await stepP6RoadMemoryUpdateInternal();
    } catch (error) {
      if (error?.code === P6_READINESS_STATES.CAPACITY_BLOCKED) {
        const work = await firstCompletedWork();
        const ordinal = Math.max(0, Number(work?.roadCursor?.outputOrdinal) || 0);
        const blockedTarget = work ? await persistCapacityBlocked(work, ordinal, error) : null;
        if (!blockedTarget) return {
          state: 'STALE_SOURCE', itemsWorked: 1, bytesWorked: 0, hasMore: true,
        };
        return {
          state: P6_READINESS_STATES.CAPACITY_BLOCKED,
          blockedTarget,
          itemsWorked: 1,
          bytesWorked: Math.max(0, Number(error.encodedBytes) || 0),
          hasMore: false,
        };
      }
      if (error?.code !== P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED) throw error;
      const work = await firstCompletedWork();
      await setP6TripDomainReadiness({
        domain: P6_DOMAIN_KEYS.ROAD_LEARNING,
        subject: work?.tripId || 'all',
        sourceBinding: 'browser-v2',
        requiredVersion: work?.desiredRevision || 0,
        state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED,
        complete: false,
        storageOutcome: error.details || { reason: 'DERIVED_RESERVE_WOULD_BE_VIOLATED' },
      });
      return { state: P6_READINESS_STATES.DERIVED_STORAGE_BLOCKED,
        itemsWorked: 1, bytesWorked: Number(error?.details?.proposedBytes) || 0, hasMore: false };
    }
  });
}

/** Native J2 keeps all restart state and sensitive windows in the native owner;
 * JS only executes the existing pure acceptance law and scoped speed mutation. */
/**
 * AUD-007 round 5: this turn captures the outgoing key version, encrypts, and commits
 * durably — so it holds admission for the whole span. Without it a finalizer sees no
 * admitted writer, proves zero, deletes the version, and the turn then publishes durable
 * ciphertext under a destroyed key. The turn is bounded, so the token is held briefly.
 */
export async function stepP6NativeRoadMemoryUpdate() {
  return withDurableKeyPublication(async () => {
    const outcome = await nativeTripArchive.stepP6RoadMemory();
    if (outcome?.state === 'FINALIZE_PAGE') {
      const observation = finalizeP6RoadMemoryWindow({
        summary: outcome.summary || {},
        sectionPoints: outcome.sectionPoints || [],
        statistics: outcome.statistics || {},
        trip: { id: outcome.tripId },
      });
      return nativeTripArchive.acknowledgeP6RoadMemory({
        tripId: outcome.tripId,
        observation,
      });
    }
    if (outcome?.state === 'APPLY_PAGE') {
      const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
      let applied;
      try {
        applied = await knowledge.applyP6RoadMemoryObservations(
          [{ ...outcome.observation, p6ObservationOrdinal: outcome.observationOrdinal }],
          { sourceAuthority: 'native', tripId: outcome.tripId, sourceRevision: outcome.sourceRevision },
        );
      } catch (error) {
        if (error?.code !== P6_READINESS_STATES.CAPACITY_BLOCKED) throw error;
        return nativeTripArchive.acknowledgeP6RoadMemory({
          tripId: outcome.tripId,
          disposition: P6_READINESS_STATES.CAPACITY_BLOCKED,
          blockedTarget: {
            targetId: `${outcome.tripId}:${outcome.sourceRevision}:${outcome.observationOrdinal}`,
            tripId: outcome.tripId,
            sourceRevision: outcome.sourceRevision,
            observationOrdinal: outcome.observationOrdinal,
            bucketId: String(error.bucketId || ''),
            partitionKind: String(error.partitionKind || 'AUTOMATIC'),
            encodedBytes: Math.max(0, Number(error.encodedBytes) || 0),
          },
        });
      }
      const metadata = await speedKnowledgeStore.getMetadata();
      const acknowledged = await nativeTripArchive.acknowledgeP6RoadMemory({
        tripId: outcome.tripId,
        speedGeneration: metadata?.speedGeneration || 'native',
        bucketRevision: Number(metadata?.knowledgeRevision) || 0,
        bucketId: 'scoped',
      });
      if (applied.changedCandidates?.length) {
        await nativeTripArchive.beginP6ComponentRepair(applied.changedCandidates.map((value) => value.id));
        await createP6AffectedTripSelectionRequest({
          descriptors: applied.changedCandidates.map((value) => ({ ...value, kind: 'correction' })),
          reason: 'p6_road_memory_changed',
        });
      }
      return acknowledged;
    }
    return outcome;
  });
}

export async function stepP6ComponentRepair() {
  const native = nativeDerivedStateSelected();
  const outcome = native
    ? await nativeTripArchive.stepP6ComponentRepair()
    : await stepP6BrowserComponentRepair();
  if (outcome?.state !== 'REPAIR_PAGE') return outcome;
  const repaired = await new LocalSpeedKnowledge(speedKnowledgeStore)
    .repairP6ComponentCandidate(outcome.candidateId);
  const discoveredCandidateIds = Number(outcome.round) === 0 ? repaired.discoveredCandidateIds : [];
  const acknowledged = native
    ? await nativeTripArchive.acknowledgeP6ComponentRepair({
      repairOperationId: outcome.repairOperationId, candidateId: outcome.candidateId,
      round: outcome.round, discoveredCandidateIds,
    })
    : await acknowledgeP6BrowserComponentRepair({
      repairOperationId: outcome.repairOperationId, candidateId: outcome.candidateId,
      round: outcome.round, discoveredCandidateIds,
    });
  if (repaired.changedCandidates?.length) await createP6AffectedTripSelectionRequest({
    descriptors: repaired.changedCandidates.map((value) => ({ ...value, kind: 'correction' })),
    reason: 'p6_component_repair',
  });
  return { ...acknowledged,
    itemsWorked: Number(acknowledged.itemsWorked || 0) + Number(repaired.itemsWorked || 0),
    bytesWorked: Number(acknowledged.bytesWorked || 0) + Number(repaired.bytesWorked || 0),
  };
}
