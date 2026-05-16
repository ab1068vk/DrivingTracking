import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { calculateSegmentMetrics, cleanRoutePoints, haversineDistance } from '@/lib/tripEngine';

export const GRID_PRECISION = 4;
export const ROUTE_RISK_INDEX_KEY = 'drivesense_route_risk_index';
const MAX_SERIALIZED_LENGTH = 2_000_000;
const MAX_STORED_SEGMENTS = 5000;
const HARSH_EVENT_TYPES = new Set(['harsh_brake', 'near_miss', 'aggressive_overtake']);

const roundCoord = (value) => Number(value).toFixed(GRID_PRECISION);

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
      (item.avgSpeed >= 100 ? 10 : 0)
    ));
    item.riskLevel = item.riskScore >= 60 ? 'high' : item.riskScore >= 30 ? 'moderate' : 'low';
  }

  return index;
}

export function getSegmentsForTrip(trip, riskIndex = new Map()) {
  const points = cleanRoutePoints(trip?.route_points || []);
  const segments = [];
  for (let i = 1; i < points.length; i++) {
    const key = segmentKey(points[i - 1].lat, points[i - 1].lng, points[i].lat, points[i].lng);
    const risk = riskIndex.get(key);
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
  return new Map(Array.isArray(entries) ? entries : []);
}

export async function invalidateRouteRiskIndex() {
  await removeJson(ROUTE_RISK_INDEX_KEY);
}
