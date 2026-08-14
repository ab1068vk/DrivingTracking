import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { calculateSegmentMetrics, cleanRoutePoints, haversineDistance } from '@/lib/tripEngine';
import { eventPosition } from '@/lib/dangerZone/eventPositions';
import { scoringValue } from '@/lib/scoringConstants';

export const GRID_PRECISION = 3;
export const ROUTE_RISK_SNAP_DISTANCE_M = 15;
/**
 * How far an event may sit from the nearest segment midpoint and still be
 * attributed to it.
 *
 * There used to be no ceiling at all: `nearestSegmentKey` returned the closest
 * midpoint however far away it was, so an event with no real position — a
 * privacy-masked one read as (0, 0), say — was attached to whichever road
 * happened to be nearest, and the segment's event rate was wrong from then on.
 *
 * The 15 m merge distance is far too tight to reuse here. Midpoints sit up to
 * half a sampling interval from the event's own fix, which at motorway speed
 * with a 2 s interval is nearly 30 m before any GPS error. 120 m is loose
 * enough for sparse sampling and still an order of magnitude short of
 * attributing an event to a road the driver was never on.
 */
export const ROUTE_RISK_EVENT_SNAP_DISTANCE_M = 120;
export const ROUTE_RISK_INDEX_KEY = 'drivesense_route_risk_index';
export const ROUTE_RISK_PRIVACY_ZONE_GUARD_M = 50;
/**
 * Internal segment-risk weighting policy. These weights identify repeated
 * driving-event patterns; they are not calibrated to collision or casualty data.
 */
export const ROUTE_RISK_CONSTANTS = Object.freeze({
  ROUTE_RISK_EVENT_WEIGHT: scoringValue('ROUTE_RISK_EVENT_WEIGHT'),
  ROUTE_RISK_HARSH_WEIGHT: scoringValue('ROUTE_RISK_HARSH_WEIGHT'),
});
const MAX_SERIALIZED_LENGTH = 2_000_000;
const MAX_STORED_SEGMENTS = 5000;
const HARSH_EVENT_TYPES = new Set(['harsh_brake']);
const EXCLUDED_PROXY_EVENT_TYPES = new Set(['near_miss', 'close_proximity', 'tailgate_cycle', 'stop_start_pattern']);
const SPEED_RISK_START_KMH = scoringValue('ROUTE_RISK_SPEED_START_KMH');
const SPEED_RISK_FULL_KMH = scoringValue('ROUTE_RISK_SPEED_FULL_KMH');
const SPEED_RISK_MAX_POINTS = scoringValue('ROUTE_RISK_SPEED_MAX_POINTS');
const SNAP_BUCKET_DEGREES = ROUTE_RISK_SNAP_DISTANCE_M / 80000;

const finiteCoord = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const pointMetadataKey = (point) => {
  const lat = finiteCoord(point?.lat ?? point?.coords?.latitude);
  const lng = finiteCoord(point?.lng ?? point?.coords?.longitude);
  const timestampValue = point?.timestamp ?? point?.time;
  const timestamp = timestampValue ? new Date(timestampValue).getTime() : NaN;
  return `${lat ?? ''},${lng ?? ''},${Number.isFinite(timestamp) ? timestamp : ''}`;
};
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

const nearestSegmentKey = (lat, lng, midpoints = [], ceilingM = ROUTE_RISK_EVENT_SNAP_DISTANCE_M) => {
  let best = null;
  for (const midpoint of midpoints) {
    const distanceM = haversineDistance(lat, lng, midpoint.lat, midpoint.lng) * 1000;
    if (!Number.isFinite(distanceM) || distanceM > ceilingM) continue;
    if (!best || distanceM < best.distanceM) best = { key: midpoint.key, distanceM };
  }
  return best?.key || null;
};

const isPrivacyMaskedPoint = (point) => (
  point?.masked_for_privacy === true ||
  point?.privacy_masked === true ||
  point?.privacy_boundary === true ||
  point?.is_privacy_boundary === true ||
  point?.privacy_zone_id != null
);

const isNearPrivacyZone = (lat, lng, privacyZones = [], guardM = ROUTE_RISK_PRIVACY_ZONE_GUARD_M) => {
  const pointLat = finiteCoord(lat);
  const pointLng = finiteCoord(lng);
  if (pointLat == null || pointLng == null) return true;
  return (privacyZones || []).some((zone) => {
    const zoneLat = finiteCoord(zone?.lat);
    const zoneLng = finiteCoord(zone?.lng);
    const radiusM = Number(zone?.radius_m);
    if (zoneLat == null || zoneLng == null || !Number.isFinite(radiusM) || radiusM <= 0) return false;
    return haversineDistance(pointLat, pointLng, zoneLat, zoneLng) * 1000 <= radiusM + guardM;
  });
};

const cleanRoutePointsWithPrivacyMetadata = (routePoints = []) => {
  const metadataByKey = new Map();
  for (const rawPoint of routePoints || []) {
    if (finiteCoord(rawPoint?.lat ?? rawPoint?.coords?.latitude) == null ||
      finiteCoord(rawPoint?.lng ?? rawPoint?.coords?.longitude) == null) {
      continue;
    }
    const key = pointMetadataKey(rawPoint);
    const bucket = metadataByKey.get(key) || [];
    bucket.push(rawPoint);
    metadataByKey.set(key, bucket);
  }

  return cleanRoutePoints(routePoints).map((point) => {
    const bucket = metadataByKey.get(pointMetadataKey(point));
    const rawPoint = bucket?.shift();
    return rawPoint ? { ...point, ...rawPoint } : point;
  });
};

export const speedRiskBonus = (avgSpeedKmh = 0) => {
  const speed = Number(avgSpeedKmh) || 0;
  if (speed <= SPEED_RISK_START_KMH) return 0;
  const ratio = Math.min(1, (speed - SPEED_RISK_START_KMH) / (SPEED_RISK_FULL_KMH - SPEED_RISK_START_KMH));
  return Math.round(ratio * SPEED_RISK_MAX_POINTS);
};

export function buildRouteRiskIndex(trips = [], privacyZones = []) {
  const index = new Map();

  for (const trip of trips || []) {
    if (trip?.status !== 'completed') continue;
    const points = cleanRoutePointsWithPrivacyMetadata(trip.route_points || []);
    if (points.length < 2) continue;
    const midpoints = [];
    // One trip can contribute many consecutive segments to the same ~110 m
    // cell. Counting each of those as a separate pass inflated "you have
    // driven through this area N times" and deflated every per-trip rate
    // derived from it, so each cell is counted once per trip.
    const cellsVisitedThisTrip = new Set();

    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const prevLat = finiteCoord(prev?.lat);
      const prevLng = finiteCoord(prev?.lng);
      const currLat = finiteCoord(curr?.lat);
      const currLng = finiteCoord(curr?.lng);
      if (prevLat == null || prevLng == null || currLat == null || currLng == null) continue;
      if (isPrivacyMaskedPoint(prev) || isPrivacyMaskedPoint(curr)) continue;
      const midpoint = {
        lat: (prevLat + currLat) / 2,
        lng: (prevLng + currLng) / 2,
      };
      if (isNearPrivacyZone(midpoint.lat, midpoint.lng, privacyZones)) continue;
      const key = segmentKey(prev.lat, prev.lng, curr.lat, curr.lng);
      const segment = calculateSegmentMetrics(prev, curr);
      const item = index.get(key) || {
        tripCount: 0,
        totalEvents: 0,
        eventTypes: {},
        avgSpeed: 0,
        speedSum: 0,
        speedSampleCount: 0,
        harshCount: 0,
        riskScore: 0,
        riskLevel: 'low',
        lat: midpoint.lat,
        lng: midpoint.lng,
      };
      if (!cellsVisitedThisTrip.has(key)) {
        cellsVisitedThisTrip.add(key);
        item.tripCount += 1;
      }
      item.speedSum += Number(segment.reliableSpeedKmh) || 0;
      item.speedSampleCount += 1;
      index.set(key, item);
      midpoints.push({ key, lat: item.lat, lng: item.lng });
    }

    for (const event of trip.driving_events || []) {
      if (event?.diagnostic_only === true || EXCLUDED_PROXY_EVENT_TYPES.has(event?.type)) continue;
      // `Number(null)` is 0 and passes `Number.isFinite`, so the old check let a
      // privacy-masked event through as a position on the equator. Shared with
      // the danger-zone clustering so both agree on what counts as a position.
      const position = eventPosition(event);
      if (!position) continue;
      const { lat, lng } = position;
      const key = nearestSegmentKey(lat, lng, midpoints);
      if (!key || !index.has(key)) continue;
      const item = index.get(key);
      item.totalEvents += 1;
      item.eventTypes[event.type] = (item.eventTypes[event.type] || 0) + 1;
      if (HARSH_EVENT_TYPES.has(event.type)) item.harshCount += 1;
    }
  }

  for (const item of index.values()) {
    // Average over the segments actually sampled, not over trips.
    item.avgSpeed = item.speedSampleCount ? item.speedSum / item.speedSampleCount : 0;
    const eventRate = item.totalEvents / Math.max(1, item.tripCount);
    const harshRate = item.harshCount / Math.max(1, item.tripCount);
    item.riskScore = Math.min(100, Math.round(
      eventRate * ROUTE_RISK_CONSTANTS.ROUTE_RISK_EVENT_WEIGHT +
      harshRate * ROUTE_RISK_CONSTANTS.ROUTE_RISK_HARSH_WEIGHT +
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
  await setEncryptedJson(ROUTE_RISK_INDEX_KEY, entries);
  await notifyHazardKnowledge('save_route_risk_index');
}

export async function loadRouteRiskIndex(privacyZones = []) {
  const entries = await getEncryptedJson(ROUTE_RISK_INDEX_KEY, []);
  const merged = new Map();
  const bucketIndex = new Map();
  for (const [key, item] of Array.isArray(entries) ? entries : []) {
    const hasMidpoint = Number.isFinite(Number(item?.lat)) && Number.isFinite(Number(item?.lng));
    if (hasMidpoint && isNearPrivacyZone(item.lat, item.lng, privacyZones)) continue;
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
  await removeEncryptedJson(ROUTE_RISK_INDEX_KEY);
  await notifyHazardKnowledge('invalidate_route_risk_index');
}

/**
 * The live hazard warning holds a memoized index of these segments for the whole
 * drive, so every write has to tell it to rebuild. Imported lazily because the
 * snapshot module imports this one for its guard constants.
 */
async function notifyHazardKnowledge(action) {
  try {
    const { notifyHazardKnowledgeChanged } = await import('@/lib/hazard/hazardHorizonSnapshot');
    await notifyHazardKnowledgeChanged(action);
  } catch {
    // A stale snapshot is recoverable; failing the write is not.
  }
}
