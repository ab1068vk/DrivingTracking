/**
 * Group nearby points into clusters by actual distance, not by grid luck.
 *
 * The repeated-event-area engine used to decide membership with a rounded
 * lat/lng grid: `Math.round(lat / step) * step`. Two events a few metres apart
 * but on opposite sides of a rounding boundary landed in different cells, so a
 * real cluster of three events spanning twelve metres split into counts of two
 * and one and never reached the "repeated" threshold. The driver was told there
 * was no evidence at a place they braked hard at every week.
 *
 * Here the grid is only an *index*. Membership is decided by a real distance
 * test, so no boundary can separate two points that are genuinely close, and the
 * result does not change if the whole world is translated slightly.
 *
 * The algorithm — union-find plus a 3x3 neighbour sweep — is lifted from
 * `privacyZoneSuggestions.clusterEndpoints`, which has run in production on the
 * privacy-zone suggestion path. It is extracted rather than copied because
 * `routeRiskIndex` already has a third variant of the same bucket sweep, and a
 * clustering rule that drifts between the privacy surface and the hazard surface
 * is the kind of difference nobody notices until it matters.
 *
 * Cost is O(n) buckets with a bounded neighbourhood scan, not O(n^2).
 */

const EARTH_RADIUS_M = 6371000;

/**
 * Strict coordinate parsing, and the whole reason this helper exists rather than
 * a bare `Number()`: `Number(null)` and `Number('')` are both 0, and 0,0 is a
 * real place in the Gulf of Guinea. Privacy masking nulls coordinates in place,
 * so a lenient parse turns every masked event into a cluster at Null Island.
 */
const coord = (value) => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The {lat, lng} of a position, or null if either component is unusable.
 * Exported because every caller that reads a coordinate off a stored record hits
 * the same trap, and a second lenient parse anywhere puts records back at (0, 0).
 */
export const positionOrNull = (value) => {
  const lat = coord(value?.lat);
  const lng = coord(value?.lng);
  return lat == null || lng == null ? null : { lat, lng };
};

/** Metres between two {lat, lng} points. Infinity when either is unusable, so it can never join a cluster. */
export function haversineMeters(a, b) {
  const from = positionOrNull(a);
  const to = positionOrNull(b);
  if (!from || !to) return Number.POSITIVE_INFINITY;
  const { lat: aLat, lng: aLng } = from;
  const { lat: bLat, lng: bLng } = to;

  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/**
 * @param {Array<any>} items
 * @param {{radiusM: number, positionOf?: (item: any) => {lat: number, lng: number},
 *          distanceM?: (a: any, b: any) => number}} options
 * @returns {Array<Array<any>>} clusters, each an array of the original items
 */
export function clusterByProximity(items = [], {
  radiusM,
  positionOf = (item) => item,
  distanceM = haversineMeters,
} = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0 || !(Number(radiusM) > 0)) return [];

  const parents = list.map((_, index) => index);
  const ranks = list.map(() => 0);
  const buckets = new Map();

  const find = (index) => {
    let root = index;
    while (parents[root] !== root) root = parents[root];
    // Path compression, so a long chain of merges stays cheap to resolve.
    while (parents[index] !== index) {
      const next = parents[index];
      parents[index] = root;
      index = next;
    }
    return root;
  };

  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (ranks[rootA] < ranks[rootB]) parents[rootA] = rootB;
    else if (ranks[rootA] > ranks[rootB]) parents[rootB] = rootA;
    else {
      parents[rootB] = rootA;
      ranks[rootA] += 1;
    }
  };

  // Bucket edge equals the join radius, so any point within the radius is
  // guaranteed to be in this cell or one of the eight around it.
  const cellOf = (position) => {
    const usable = positionOrNull(position);
    if (!usable) return null;
    const { lat, lng } = usable;
    const latitudeRadians = (lat * Math.PI) / 180;
    return {
      // Longitude degrees shrink toward the poles, so the scan stays square in
      // metres rather than becoming a narrow sliver at high latitude.
      x: Math.floor((lng * 111320 * Math.cos(latitudeRadians)) / radiusM),
      y: Math.floor((lat * 111320) / radiusM),
    };
  };

  const positions = list.map((item) => positionOf(item));

  list.forEach((item, index) => {
    const cell = cellOf(positions[index]);
    // A point with no usable position clusters with nothing, including itself.
    if (!cell) return;
    for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        const nearby = buckets.get(`${cell.x + xOffset}:${cell.y + yOffset}`) || [];
        for (const candidate of nearby) {
          if (distanceM(positions[index], positions[candidate]) <= radiusM) union(index, candidate);
        }
      }
    }
    const key = `${cell.x}:${cell.y}`;
    buckets.set(key, [...(buckets.get(key) || []), index]);
  });

  const groups = new Map();
  list.forEach((item, index) => {
    if (!cellOf(positions[index])) return;
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  });
  return [...groups.values()];
}

/** Mean position of a cluster. Its members are within `radiusM`, so the mean is inside the cluster. */
export function clusterCenter(positions = []) {
  const usable = (Array.isArray(positions) ? positions : []).map(positionOrNull).filter(Boolean);
  if (usable.length === 0) return null;
  return {
    lat: usable.reduce((sum, p) => sum + p.lat, 0) / usable.length,
    lng: usable.reduce((sum, p) => sum + p.lng, 0) / usable.length,
  };
}
