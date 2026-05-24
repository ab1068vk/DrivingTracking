import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { calculateSegmentMetrics, cleanRoutePoints, haversineDistance } from '@/lib/tripEngine';

export const GRID_PRECISION = 3;
export const ROUTE_RISK_SNAP_DISTANCE_M = 15;
export const ROUTE_RISK_INDEX_KEY = 'drivesense_route_risk_index';
const MAX_SERIALIZED_LENGTH = 2_000_000;
const MAX_STORED_SEGMENTS = 5000;
const HARSH_EVENT_TYPES = new Set(['harsh_brake', 'near_miss', 'close_proximity', 'aggressive_overtake']);
const SPEED_RISK_START_KMH = 100;
const SPEED_RISK_FULL_KMH = 160;
const SPEED_RISK_MAX_POINTS = 15;
const SNAP_BUCKET_DEGREES = ROUTE_RISK_SNAP_DISTANCE_M / 80000;

const roundCoord = (value) => Number(value).toFixed(GRID_PRECISION);
const snapBucketKey = (lat, lng) => `${Math.floor(Number(lat) / SNAP_BUCKET_DEGREES)},${Math.floor(Number(lng) / SNAP_BUCKET_DEGREES)}`;

const neighboringBucketKeys = (lat, lng) => {
  const [row, col] = snapBucketKey(lat, lng).split(',').map(Number);
  const keys = [];
  for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
    for (let colOffset = -1; colOffset <= 1; colOffset++) {
      keys.push(`${row + rowOffset},${col + colOffset}`);
    }
  }
  return keys;
};

export function segmentKey(lat1, lng1, lat2, lng2) {
  const a = `${roundCoord(lat1)},${roundCoord(lng1)}`;
  const b = `${roundCoord(lat2)},${roundCoord(lng2)}`;
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

const dominantEventType = (eventTypes = {}) => (
  Object.entries(eventTypes).sort((a, b) => b[1] - a[1])[0]?.[0] || null
);

const nearestSegmentKey = (lat, lng, midpoints = []) => {
  let best = null;
  for (const midpoint of midpoints) {
    const distanceM = haversineDistance(lat, lng, midpoint.lat, midpoint.lng) * 1000;
    if (!best || distanceM < best.distanceM) best = { key: midpoint.key, distanceM };
  }
  return best?.key || null;
};

export const speedRiskBonus = (avgSpeedKmh = 0) => {
  const speed = Number(avgSpeedKmh) || 0;
  if (speed <= SPEED_RISK_START_KMH) return 0;
  const ratio = Math.min(1, (speed - SPEED_RISK_START_KMH) / (SPEED_RISK_FULL_KMH - SPEED_RISK_START_KMH));
  return Math.round(ratio * SPEED_RISK_MAX_POINTS);
};

export function buildRouteRiskIndex(trips = []) {
  const index = new Map();

  for (const trip of trips || []) {
    if (trip?.status !== 'completed') continue;
    const points = cleanRoutePoints(trip.route_points || []);
    if (points.length < 2) continue;
    const midpoints = [];

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const key = segmentKey(prev.lat, prev.lng, curr.lat, curr.lng);
      const segment = calculateSegmentMetrics(prev, curr);
      const item = index.get(key) || {
        tripCount: 0,
        totalEvents: 0,
        eventTypes: {},
        avgSpeed: 0,
        speedSum: 0,
        harshCount: 0,
        riskScore: 0,
        riskLevel: 'low',
        lat: (Number(prev.lat) + Number(curr.lat)) / 2,
        lng: (Number(prev.lng) + Number(curr.lng)) / 2,
      };
      item.tripCount += 1;
      item.speedSum += Number(segment.reliableSpeedKmh) || 0;
      index.set(key, item);
      midpoints.push({ key, lat: item.lat, lng: item.lng });
    }

    for (const event of trip.driving_events || []) {
      const lat = Number(event.lat);
      const lng = Number(event.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = nearestSegmentKey(lat, lng, midpoints);
      if (!key || !index.has(key)) continue;
      const item = index.get(key);
      item.totalEvents += 1;
      item.eventTypes[event.type] = (item.eventTypes[event.type] || 0) + 1;
      if (HARSH_EVENT_TYPES.has(event.type)) item.harshCount += 1;
    }
  }

  for (const item of index.values()) {
    item.avgSpeed = item.tripCount ? item.speedSum / item.tripCount : 0;
    const eventRate = item.totalEvents / Math.max(1, item.tripCount);
    const harshRate = item.harshCount / Math.max(1, item.tripCount);
    item.riskScore = Math.min(100, Math.round(
      eventRate * 20 +
      harshRate * 40 +
      speedRiskBonus(item.avgSpeed)
    ));
    item.riskLevel = item.riskScore >= 60 ? 'high' : item.riskScore >= 30 ? 'moderate' : 'low';
  }

  return index;
}

export function getSegmentsForTrip(trip, riskIndex = new Map()) {
  const points = cleanRoutePoints(trip?.route_points || []);
  const segments = [];
  const bucketIndex = new Map();
  for (const risk of riskIndex.values()) {
    if (!Number.isFinite(Number(risk?.lat)) || !Number.isFinite(Number(risk?.lng))) continue;
    const key = snapBucketKey(risk.lat, risk.lng);
    const bucket = bucketIndex.get(key) || [];
    bucket.push(risk);
    bucketIndex.set(key, bucket);
  }
  for (let i = 1; i < points.length; i++) {
    const key = segmentKey(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    const midpoint = {
      lat: (Number(points[i - 1].lat) + Number(points[i].lat)) / 2,
      lng: (Number(points[i - 1].lng) + Number(points[i].lng)) / 2,
    };
    const nearbyCandidates = neighboringBucketKeys(midpoint.lat, midpoint.lng)
      .flatMap((bucketKey) => bucketIndex.get(bucketKey) || []);
    const risk = riskIndex.get(key) || nearbyCandidates.find((candidate) => (
      haversineDistance(midpoint.lat, midpoint.lng, candidate.lat, candidate.lng) * 1000 <= ROUTE_RISK_SNAP_DISTANCE_M
    ));
    if (!risk || risk.tripCount < 2) continue;
    segments.push({
      from: { lat: points[i - 1].lat, lng: points[i - 1].lng },
      to: { lat: points[i].lat, lng: points[i].lng },
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      tripCount: risk.tripCount,
      totalEvents: risk.totalEvents,
      dominantEventType: dominantEventType(risk.eventTypes),
    });
  }
  return segments;
}

export async function saveRouteRiskIndex(index = new Map()) {
  let entries = [...index.entries()];
  if (JSON.stringify(entries).length > MAX_SERIALIZED_LENGTH) {
    entries = entries
      .sort((a, b) => (b[1].tripCount || 0) - (a[1].tripCount || 0))
      .slice(0, MAX_STORED_SEGMENTS);
  }
  await setJson(ROUTE_RISK_INDEX_KEY, entries);
}

export async function loadRouteRiskIndex() {
  const entries = await getJson(ROUTE_RISK_INDEX_KEY, []);
  const merged = new Map();
  const bucketIndex = new Map();
  for (const [key, item] of Array.isArray(entries) ? entries : []) {
    const hasMidpoint = Number.isFinite(Number(item?.lat)) && Number.isFinite(Number(item?.lng));
    const nearby = hasMidpoint
      ? neighboringBucketKeys(item.lat, item.lng)
        .flatMap((bucketKey) => bucketIndex.get(bucketKey) || [])
        .find(([, candidate]) => (
          haversineDistance(item.lat, item.lng, candidate.lat, candidate.lng) * 1000 <= ROUTE_RISK_SNAP_DISTANCE_M
        ))
      : null;
    if (!nearby) {
      merged.set(key, item);
      if (hasMidpoint) {
        const bucketKey = snapBucketKey(item.lat, item.lng);
        const bucket = bucketIndex.get(bucketKey) || [];
        bucket.push([key, item]);
        bucketIndex.set(bucketKey, bucket);
      }
      continue;
    }
    const [targetKey, target] = nearby;
    const totalTrips = (target.tripCount || 0) + (item.tripCount || 0);
    const combined = {
      ...target,
      tripCount: totalTrips,
      totalEvents: (target.totalEvents || 0) + (item.totalEvents || 0),
      harshCount: (target.harshCount || 0) + (item.harshCount || 0),
      speedSum: (target.speedSum || 0) + (item.speedSum || 0),
      avgSpeed: totalTrips ? ((target.speedSum || 0) + (item.speedSum || 0)) / totalTrips : 0,
      riskScore: Math.max(target.riskScore || 0, item.riskScore || 0),
      riskLevel: (target.riskScore || 0) >= (item.riskScore || 0) ? target.riskLevel : item.riskLevel,
      eventTypes: Object.entries(item.eventTypes || {}).reduce((all, [type, count]) => ({
        ...all,
        [type]: (all[type] || 0) + count,
      }), { ...(target.eventTypes || {}) }),
    };
    merged.set(targetKey, combined);
    const bucketKey = snapBucketKey(target.lat, target.lng);
    const bucket = bucketIndex.get(bucketKey) || [];
    const bucketPosition = bucket.findIndex(([candidateKey]) => candidateKey === targetKey);
    if (bucketPosition >= 0) bucket[bucketPosition] = [targetKey, combined];
  }
  return merged;
}

export async function invalidateRouteRiskIndex() {
  await removeJson(ROUTE_RISK_INDEX_KEY);
}
