/**
 * A uniform grid over saved speed records so a lookup touches only the records
 * near the point instead of all of them.
 *
 * Resolving a live GPS fix used to walk every correction and then every Road
 * Memory candidate — up to 2500 of them, each a polyline of up to 24 points —
 * running the full temporal/direction/geometry matcher on each. That is a linear
 * scan per fix, on the UI thread.
 *
 * The index answers a coarser question: which records could *possibly* match
 * here. It is deliberately a superset — each record's own match radius is baked
 * in as padding when it is inserted, so a bucket hit means "close enough to be
 * worth testing", never "matched". The precise matcher still runs on whatever
 * comes back, so results are identical to the linear scan; only the number of
 * candidates tested changes. `speedSpatialIndex.test.js` asserts that
 * equivalence directly.
 *
 * Nothing here is speed-specific — it takes `records`, a `geometryFor` and a
 * per-record padding — so `src/lib/hazard/hazardHorizonSnapshot.js` builds its
 * hazard index from this same function rather than growing a second copy that
 * would drift from the one the live speed resolver depends on. Keep it generic.
 */

const KM_PER_DEG_LAT = 111.32;

/** ~150 m at the equator: one geohash-7 cell, comfortably finer than the 45 m match radius. */
export const DEFAULT_INDEX_CELL_DEG = 0.00135;

/** Below this the longitude scaling explodes, so stop dividing by cos(lat). */
const MIN_COS_LAT = 0.02;

/** Guard against a pathological two-point record spanning half the globe. */
const MAX_SEGMENT_STEPS = 512;

const cellKmLat = (cellDeg) => cellDeg * KM_PER_DEG_LAT;

const cosLatFloor = (lat) => Math.max(MIN_COS_LAT, Math.abs(Math.cos((Number(lat) || 0) * Math.PI / 180)));

const usable = (lat, lng) => (
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
);

export function createSpeedSpatialIndex({ cellDeg = DEFAULT_INDEX_CELL_DEG } = {}) {
  /** @type {Map<string, Set<any>>} */
  const buckets = new Map();
  /** Records with no usable geometry at all: they can match anywhere, so they always come back. */
  const ungeocoded = new Set();
  let recordCount = 0;

  const latIndex = (lat) => Math.floor(lat / cellDeg);
  const lngIndex = (lng) => Math.floor(lng / cellDeg);
  const keyFor = (latIdx, lngIdx) => `${latIdx}:${lngIdx}`;

  function markPath(points, marked) {
    for (let i = 0; i < points.length; i += 1) {
      const current = points[i];
      marked.add(keyFor(latIndex(current.lat), lngIndex(current.lng)));
      const next = points[i + 1];
      if (!next) continue;
      const dLat = next.lat - current.lat;
      const dLng = next.lng - current.lng;
      const span = Math.max(Math.abs(dLat), Math.abs(dLng));
      const steps = Math.min(MAX_SEGMENT_STEPS, Math.ceil(span / (cellDeg / 2)));
      for (let step = 1; step < steps; step += 1) {
        const ratio = step / steps;
        marked.add(keyFor(
          latIndex(current.lat + dLat * ratio),
          lngIndex(current.lng + dLng * ratio)
        ));
      }
    }
  }

  function dilate(marked, paddingKm, referenceLat) {
    if (!(paddingKm > 0)) return marked;
    const padLat = Math.ceil(paddingKm / cellKmLat(cellDeg));
    const padLng = Math.ceil(paddingKm / (cellKmLat(cellDeg) * cosLatFloor(referenceLat)));
    if (padLat <= 0 && padLng <= 0) return marked;
    const dilated = new Set();
    for (const key of marked) {
      const [latIdx, lngIdx] = key.split(':').map(Number);
      for (let dy = -padLat; dy <= padLat; dy += 1) {
        for (let dx = -padLng; dx <= padLng; dx += 1) {
          dilated.add(keyFor(latIdx + dy, lngIdx + dx));
        }
      }
    }
    return dilated;
  }

  return {
    cellDeg,

    /**
     * @param {any} record
     * @param {Array<{lat: number, lng: number}>} points Geometry to rasterize.
     * @param {number} paddingKm The record's own match radius, baked in here so
     *   the query side stays a single bucket lookup.
     */
    insert(record, points = [], paddingKm = 0) {
      recordCount += 1;
      const usablePoints = (Array.isArray(points) ? points : [])
        .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
        .filter((point) => usable(point.lat, point.lng));
      if (!usablePoints.length) {
        // No geometry means the precise matcher decides on its own terms, so it
        // has to be offered for every lookup rather than silently dropped.
        ungeocoded.add(record);
        return;
      }
      const marked = new Set();
      markPath(usablePoints, marked);
      for (const key of dilate(marked, paddingKm, usablePoints[0].lat)) {
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = new Set();
          buckets.set(key, bucket);
        }
        bucket.add(record);
      }
    },

    /** Records whose padded footprint covers this point. A superset of true matches. */
    query(lat, lng) {
      const latitude = Number(lat);
      const longitude = Number(lng);
      if (!usable(latitude, longitude)) return [...ungeocoded];
      const bucket = buckets.get(keyFor(latIndex(latitude), lngIndex(longitude)));
      if (!bucket) return ungeocoded.size ? [...ungeocoded] : [];
      if (!ungeocoded.size) return [...bucket];
      return [...new Set([...bucket, ...ungeocoded])];
    },

    stats() {
      return {
        recordCount,
        bucketCount: buckets.size,
        ungeocodedCount: ungeocoded.size,
        cellDeg,
      };
    },
  };
}

/**
 * Build an index over `records`, deriving each one's geometry and match radius.
 *
 * @param {any[]} records
 * @param {(record: any) => Array<{lat: number, lng: number}>} geometryFor
 * @param {number | ((record: any) => number)} paddingKm
 */
export function buildSpeedSpatialIndex(records = [], geometryFor, paddingKm = 0, options = {}) {
  const index = createSpeedSpatialIndex(options);
  const padFor = typeof paddingKm === 'function' ? paddingKm : () => paddingKm;
  for (const record of Array.isArray(records) ? records : []) {
    index.insert(record, geometryFor(record), padFor(record));
  }
  return index;
}
