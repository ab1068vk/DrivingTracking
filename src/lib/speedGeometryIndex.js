import { getEncryptedJson, removeEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';

export const SPEED_GEOMETRY_INDEX_KEY = 'drivesense_speed_geometry_index_v1';
export const SPEED_GEOMETRY_INDEX_CHANGED_EVENT = 'roadsage-speed-geometry-index-changed';
const MAX_POINTS_PER_TRIP = 160;
const MAX_INDEXED_TRIPS = 5000;
let activeBuild = null;
let buildGeneration = 0;

const finiteCoordinate = (point = {}) => (
  Number.isFinite(Number(point.lat)) &&
  Number.isFinite(Number(point.lng)) &&
  Math.abs(Number(point.lat)) <= 90 &&
  Math.abs(Number(point.lng)) <= 180 &&
  point.privacy_masked !== true &&
  point.masked_for_privacy !== true &&
  point.privacy_gap !== true &&
  point.privacy_live_redacted !== true
);

const compactPoint = (point = {}) => {
  const heading = Number(point.heading ?? point.bearing ?? point.course);
  const speedLimitKmh = Number(point.speed_limit_kmh ?? point.limitKmh);
  const actualSpeedKmh = Number(point.speed_kmh ?? point.speedKmh);
  const timestamp = point.timestamp ?? point.timestampMs ?? point.timestamp_ms ?? point.recorded_at;
  const utcOffsetMinutes = Number(point.utc_offset_minutes ?? point.utcOffsetMinutes);
  return {
    lat: Number(point.lat),
    lng: Number(point.lng),
    ...(Number.isFinite(heading) ? { heading } : {}),
    ...(Number.isFinite(speedLimitKmh) && speedLimitKmh > 0 ? { speed_limit_kmh: speedLimitKmh } : {}),
    // Impact previews need the observed speed, not only the historical limit.
    ...(Number.isFinite(actualSpeedKmh) && actualSpeedKmh >= 0 ? { speed_kmh: actualSpeedKmh } : {}),
    ...(point.speed_limit_source ? { speed_limit_source: String(point.speed_limit_source).slice(0, 80) } : {}),
    ...(timestamp != null ? { timestamp } : {}),
    ...(Number.isFinite(utcOffsetMinutes) ? { utc_offset_minutes: utcOffsetMinutes } : {}),
    ...(point.timezone_id ? { timezone_id: String(point.timezone_id).slice(0, 100) } : {}),
  };
};

const samplePoints = (points = [], maxPoints = MAX_POINTS_PER_TRIP) => {
  const clean = points.filter(finiteCoordinate);
  if (clean.length <= maxPoints) return clean.map(compactPoint);
  const last = clean.length - 1;
  return Array.from({ length: maxPoints }, (_, index) => (
    compactPoint(clean[Math.round(index * last / (maxPoints - 1))])
  ));
};

export function compactTripForSpeedGeometry(trip = {}) {
  const routePoints = samplePoints(Array.isArray(trip.route_points) ? trip.route_points : []);
  if (!trip?.id || routePoints.length < 2) return null;
  return {
    id: String(trip.id),
    status: 'completed',
    start_time: trip.start_time || null,
    end_time: trip.end_time || null,
    route_points: routePoints,
    geometry_indexed: true,
  };
}

const emitChanged = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SPEED_GEOMETRY_INDEX_CHANGED_EVENT, { detail }));
};

export async function readSpeedGeometryIndex() {
  const stored = await getEncryptedJson(SPEED_GEOMETRY_INDEX_KEY, null);
  if (!stored || stored.version !== 1 || !Array.isArray(stored.trips)) {
    return { version: 1, builtAt: 0, totalAvailable: 0, indexedTripCount: 0, trips: [] };
  }
  return {
    version: 1,
    builtAt: Number(stored.builtAt) || 0,
    totalAvailable: Math.max(0, Number(stored.totalAvailable) || 0),
    indexedTripCount: stored.trips.length,
    truncated: stored.truncated === true,
    trips: stored.trips.map(compactTripForSpeedGeometry).filter(Boolean),
  };
}

export function rebuildSpeedGeometryIndex({
  batchSize = 80,
  maxTrips = MAX_INDEXED_TRIPS,
  loadBatch = null,
} = {}) {
  if (activeBuild) return activeBuild;
  const generation = buildGeneration;
  activeBuild = (async () => {
    const loader = loadBatch || (async (options) => {
      const { localTripRepository } = await import('@/lib/localTripRepository');
      return localTripRepository.listForSpeedMap(options);
    });
    const safeBatchSize = Math.max(20, Math.min(200, Math.floor(Number(batchSize) || 80)));
    const safeMaxTrips = Math.max(safeBatchSize, Math.min(MAX_INDEXED_TRIPS, Math.floor(Number(maxTrips) || MAX_INDEXED_TRIPS)));
    const byId = new Map();
    let offset = 0;
    let totalAvailable = 0;

    while (offset < safeMaxTrips) {
      const result = await loader({
        sort: '-start_time',
        offset,
        limit: Math.min(safeBatchSize, safeMaxTrips - offset),
      });
      const batch = Array.isArray(result?.trips) ? result.trips : [];
      totalAvailable = Math.max(totalAvailable, Number(result?.totalAvailable) || 0, offset + batch.length);
      batch.forEach((trip) => {
        const compact = compactTripForSpeedGeometry(trip);
        if (compact) byId.set(compact.id, compact);
      });
      const nextOffset = Math.max(offset + batch.length, Number(result?.nextOffset) || 0);
      if (!batch.length || nextOffset <= offset || nextOffset >= totalAvailable) break;
      offset = nextOffset;
    }

    const index = {
      version: 1,
      builtAt: Date.now(),
      totalAvailable,
      indexedTripCount: byId.size,
      truncated: totalAvailable > byId.size,
      trips: [...byId.values()],
    };
    if (generation !== buildGeneration) {
      return { ...index, invalidated: true, trips: [], indexedTripCount: 0 };
    }
    await setEncryptedJson(SPEED_GEOMETRY_INDEX_KEY, index);
    emitChanged({
      indexedTripCount: index.indexedTripCount,
      totalAvailable: index.totalAvailable,
      truncated: index.truncated,
    });
    return index;
  })().finally(() => {
    activeBuild = null;
  });
  return activeBuild;
}

export async function clearSpeedGeometryIndex(reason = 'source_data_changed') {
  buildGeneration += 1;
  await removeEncryptedJson(SPEED_GEOMETRY_INDEX_KEY);
  emitChanged({
    indexedTripCount: 0,
    totalAvailable: 0,
    truncated: false,
    cleared: true,
    reason,
  });
}
