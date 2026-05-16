import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { haversineDistance } from '@/lib/tripEngine';

export const DANGER_ZONES_KEY = 'drivesense_danger_zones';
const EARTH_M_PER_DEG = 111320;
const DEFAULT_EVENT_TYPES = ['harsh_brake', 'near_miss', 'sharp_turn', 'aggressive_overtake'];
const SEVERITY_POINTS = { high: 3, medium: 2, low: 1 };

const hashKey = (key) => {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `dz_${Math.abs(hash).toString(36)}`;
};

const formatCellKey = (lat, lng, cellSizeM) => {
  const latStep = cellSizeM / EARTH_M_PER_DEG;
  const lngDenominator = EARTH_M_PER_DEG * Math.max(0.01, Math.cos(lat * Math.PI / 180));
  const lngStep = cellSizeM / lngDenominator;
  const cellLat = Math.round(lat / latStep) * latStep;
  const cellLng = Math.round(lng / lngStep) * lngStep;
  return `${cellLat.toFixed(6)},${cellLng.toFixed(6)}`;
};

const riskLevelForSeverity = (severityScore) => {
  if (severityScore >= 15) return 'critical';
  if (severityScore >= 8) return 'high';
  if (severityScore >= 4) return 'medium';
  return 'low';
};

const dominantType = (breakdown = {}) => (
  Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null
);

export function buildDangerZones(trips = [], options = {}) {
  const cellSizeM = Number(options.cellSizeM) || 80;
  const minEvents = Number(options.minEvents) || 3;
  const eventTypes = new Set(options.eventTypes || DEFAULT_EVENT_TYPES);
  const groups = new Map();

  for (const trip of trips || []) {
    if (trip?.status !== 'completed') continue;
    for (const event of trip.driving_events || []) {
      const lat = Number(event?.lat);
      const lng = Number(event?.lng);
      if (!eventTypes.has(event?.type) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const key = formatCellKey(lat, lng, cellSizeM);
      const current = groups.get(key) || {
        key,
        count: 0,
        latSum: 0,
        lngSum: 0,
        severityScore: 0,
        typeBreakdown: {},
        lastSeen: null,
      };

      current.count += 1;
      current.latSum += lat;
      current.lngSum += lng;
      current.severityScore += SEVERITY_POINTS[event.severity] || 1;
      current.typeBreakdown[event.type] = (current.typeBreakdown[event.type] || 0) + 1;
      const eventTime = event.timestamp || event.startTime || trip.end_time || trip.start_time;
      if (eventTime && (!current.lastSeen || new Date(eventTime) > new Date(current.lastSeen))) {
        current.lastSeen = new Date(eventTime).toISOString();
      }
      groups.set(key, current);
    }
  }

  return [...groups.values()]
    .filter((group) => group.count >= minEvents)
    .map((group) => ({
      id: hashKey(group.key),
      lat: group.latSum / group.count,
      lng: group.lngSum / group.count,
      radiusM: cellSizeM * 1.2,
      eventCount: group.count,
      severityScore: group.severityScore,
      riskLevel: riskLevelForSeverity(group.severityScore),
      dominantType: dominantType(group.typeBreakdown),
      typeBreakdown: group.typeBreakdown,
      lastSeen: group.lastSeen,
    }))
    .sort((a, b) => b.severityScore - a.severityScore || b.eventCount - a.eventCount);
}

export function checkDangerZoneProximity(currentLat, currentLng, zones = [], alertRadiusM = 200) {
  const lat = Number(currentLat);
  const lng = Number(currentLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Array.isArray(zones)) return [];

  return zones
    .map((zone) => ({
      ...zone,
      distanceM: haversineDistance(lat, lng, Number(zone.lat), Number(zone.lng)) * 1000,
    }))
    .filter((zone) => Number.isFinite(zone.distanceM) && zone.distanceM <= alertRadiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export async function saveDangerZones(zones = []) {
  await setJson(DANGER_ZONES_KEY, Array.isArray(zones) ? zones : []);
}

export async function loadDangerZones() {
  const zones = await getJson(DANGER_ZONES_KEY, []);
  return Array.isArray(zones) ? zones : [];
}

export async function invalidateDangerZoneCache() {
  await removeJson(DANGER_ZONES_KEY);
}
