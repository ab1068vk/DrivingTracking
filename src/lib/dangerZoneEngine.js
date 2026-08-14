/**
 * Repeated event areas: places the driver's own history says they keep having
 * the same trouble.
 *
 * Two things were wrong with how these were built, and both made the feature
 * quietly claim there was no evidence when there was.
 *
 * First, membership was decided by a rounded lat/lng grid. Events twelve metres
 * apart could fall either side of a rounding boundary and be counted as two
 * separate places, neither reaching the threshold. Clustering is now by real
 * distance (`clusterByProximity`), so no invisible line can split a cluster.
 *
 * Second, "repeated" was never checked. The gate was a raw event count, so a
 * single drive with three harsh brakes at one junction — entirely possible given
 * the 4 s event cooldown — produced a "repeated event area" from one occurrence.
 * Repetition is now counted in distinct drives, the same way `routeRiskIndex`
 * already counts passes.
 *
 * Where exposure is known, it is used: braking at a corner on four of five
 * passes is a different fact from four times in fifty, and only the first is
 * worth telling someone about. Exposure is optional so this stays a pure
 * function of trips for callers that have no index.
 *
 * Speeding is deliberately not clustered here. One continuous over-limit run
 * emits a single event placed at whichever GPS fix happened to be fastest, so
 * the same road driven twice puts its events nowhere near each other. Habitual
 * speeding is a property of a stretch, and `speedingStretches.js` derives it
 * from route-risk segments where exposure is already counted.
 */
import {
  getEncryptedJson,
  removeEncryptedJson,
  setEncryptedJson,
} from '@/lib/securePayloadCrypto';
import { haversineDistance } from '@/lib/tripEngine';
import { clusterByProximity, clusterCenter } from '@/lib/geo/proximityClusters';
import { eventPosition } from '@/lib/dangerZone/eventPositions';
import { zoneId } from '@/lib/dangerZone/zoneIdentity';
import {
  DANGER_ZONE_CLUSTER_RADIUS_M,
  DANGER_ZONE_MIN_TRIPS,
} from '@/lib/appConstants';

export const DANGER_ZONES_KEY = 'drivesense_danger_zones';
/**
 * `rapid_acceleration` was missing here with no stated reason while being a
 * scored safety event, so a junction the driver repeatedly launches away from
 * was invisible. `speeding` is absent by design — see the header.
 */
const DEFAULT_EVENT_TYPES = ['harsh_brake', 'sharp_turn', 'rapid_acceleration'];
const PROXY_EVENT_TYPES = new Set(['near_miss', 'close_proximity', 'tailgate_cycle', 'stop_start_pattern']);
const SEVERITY_POINTS = { high: 3, medium: 2, low: 1 };
/** Retained for the stored-record radius and for callers that still read it. Clustering no longer uses a grid. */
export const DANGER_ZONE_CELL_SIZE_M = 80;
export const DANGER_ZONE_MIN_EVENTS = 3;

const riskLevelForSeverity = (severityScore) => {
  if (severityScore >= 15) return 'critical';
  if (severityScore >= 8) return 'high';
  if (severityScore >= 4) return 'medium';
  return 'low';
};

const dominantType = (breakdown = {}) => (
  Object.entries(breakdown).sort((a, b) => b[1] - a[1])[0]?.[0] || null
);

/**
 * How many times the driver has passed through this place, when a route-risk
 * index is available. Without it, exposure is unknown rather than assumed.
 * @returns {number | null}
 */
const passesNear = (center, routeRiskIndex, radiusM) => {
  if (!routeRiskIndex) return null;
  const segments = routeRiskIndex instanceof Map ? [...routeRiskIndex.values()] : routeRiskIndex;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  let best = 0;
  for (const segment of segments) {
    const lat = Number(segment?.lat);
    const lng = Number(segment?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (haversineDistance(center.lat, center.lng, lat, lng) * 1000 > radiusM) continue;
    best = Math.max(best, Number(segment?.tripCount) || 0);
  }
  return best > 0 ? best : null;
};

/**
 * @param {Array<any>} trips
 * @param {{minEvents?: number, minTrips?: number, eventTypes?: Array<string>,
 *          clusterRadiusM?: number, routeRiskIndex?: Map<string, any> | Array<any>}} options
 */
export function buildDangerZones(trips = [], options = {}) {
  const minEvents = Number(options.minEvents) || DANGER_ZONE_MIN_EVENTS;
  const minTrips = Number.isFinite(Number(options.minTrips))
    ? Number(options.minTrips)
    : DANGER_ZONE_MIN_TRIPS;
  const radiusM = Number(options.clusterRadiusM) || DANGER_ZONE_CLUSTER_RADIUS_M;
  const eventTypes = new Set(options.eventTypes || DEFAULT_EVENT_TYPES);
  const routeRiskIndex = options.routeRiskIndex || null;

  const located = [];
  for (const trip of trips || []) {
    if (trip?.status !== 'completed') continue;
    for (const event of trip.driving_events || []) {
      if (event?.diagnostic_only === true) continue;
      if (PROXY_EVENT_TYPES.has(event?.type) || !eventTypes.has(event?.type)) continue;
      // Rejects privacy-masked events outright rather than letting Number(null)
      // coerce them to a cluster at (0, 0).
      const position = eventPosition(event);
      if (!position) continue;
      located.push({
        position,
        event,
        // Falling back to a per-trip identity keeps a trip without an id from
        // merging with every other one and faking repetition.
        tripId: String(trip.id ?? trip.start_time ?? `trip_${located.length}`),
        at: event.timestamp || event.startTime || trip.end_time || trip.start_time || null,
      });
    }
  }

  return clusterByProximity(located, { radiusM, positionOf: (item) => item.position })
    .map((members) => {
      const center = clusterCenter(members.map((m) => m.position));
      if (!center) return null;
      const tripIds = new Set(members.map((m) => m.tripId));
      const typeBreakdown = {};
      let severityScore = 0;
      let lastSeen = null;
      for (const member of members) {
        typeBreakdown[member.event.type] = (typeBreakdown[member.event.type] || 0) + 1;
        severityScore += SEVERITY_POINTS[member.event.severity] || 1;
        if (member.at && (!lastSeen || new Date(member.at) > new Date(lastSeen))) {
          lastSeen = new Date(member.at).toISOString();
        }
      }
      const passes = passesNear(center, routeRiskIndex, radiusM);
      return {
        id: zoneId(center, 'dz'),
        kind: 'point_area',
        lat: center.lat,
        lng: center.lng,
        radiusM,
        eventCount: members.length,
        tripCount: tripIds.size,
        passes,
        // Events per pass through the area. Null when exposure is unknown, so a
        // consumer cannot mistake "not measured" for "never happens".
        eventRate: passes ? members.length / passes : null,
        severityScore,
        riskLevel: riskLevelForSeverity(severityScore),
        dominantType: dominantType(typeBreakdown),
        typeBreakdown,
        lastSeen,
      };
    })
    .filter((zone) => zone && zone.eventCount >= minEvents && zone.tripCount >= minTrips)
    .sort((a, b) => (
      // Rate first where it is known: a corner that catches you most times you
      // pass it outranks one you have merely passed often.
      (b.eventRate ?? 0) - (a.eventRate ?? 0) ||
      b.severityScore - a.severityScore ||
      b.eventCount - a.eventCount
    ));
}

/**
 * The zone population the live warning reads.
 *
 * Deliberately looser than the display default (2 events rather than 3): this is
 * the set MapScreen and the post-trip rebuild write to storage, and it is what
 * the hazard horizon queries. It lives here, beside the store, because it was
 * previously implicit in one caller in mediumInsights while a different threshold
 * was used for display — so which population the driver was being warned about
 * depended on which page had last written it.
 */
export const DANGER_ZONE_ALERT_MIN_EVENTS = 2;

export function buildAlertDangerZones(trips = [], options = {}) {
  return buildDangerZones(trips, {
    eventTypes: [...DEFAULT_EVENT_TYPES],
    minEvents: DANGER_ZONE_ALERT_MIN_EVENTS,
    ...options,
  });
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

/**
 * The live hazard warning holds a memoized index of these zones for the whole
 * drive, so every write has to tell it to rebuild. Imported lazily because the
 * snapshot module imports this one.
 */
async function notifyHazardKnowledge(action) {
  try {
    const { notifyHazardKnowledgeChanged } = await import('@/lib/hazard/hazardHorizonSnapshot');
    await notifyHazardKnowledgeChanged(action);
  } catch {
    // A stale snapshot is recoverable; failing the write is not.
  }
}

export async function saveDangerZones(zones = []) {
  await setEncryptedJson(DANGER_ZONES_KEY, Array.isArray(zones) ? zones : []);
  await notifyHazardKnowledge('save_danger_zones');
}

export async function loadDangerZones() {
  const zones = await getEncryptedJson(DANGER_ZONES_KEY, []);
  return Array.isArray(zones) ? zones : [];
}

export async function invalidateDangerZoneCache() {
  await removeEncryptedJson(DANGER_ZONES_KEY);
  await notifyHazardKnowledge('invalidate_danger_zones');
}
