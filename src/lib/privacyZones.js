import { localSettings } from '@/lib/trackingStore';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { clearMapMatchingCache } from '@/lib/mapMatching';
import { encryptSensitiveValue, getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';
import { secureSetPreference } from '@/lib/secureBridge';
import { appendPrivacyEvent } from '@/lib/hashChainLog';
import { SecureGpsBuffer } from '@/lib/SecureGpsBuffer';
import { applyDifferentialPrivacyToAggregates } from '@/lib/differentialPrivacy';
import { effectivePrivacyZones } from '@/lib/privacyMode';

const EARTH_RADIUS_M = 6371000;
const DISPLAY_CIRCLE_OFFSET_M = 35;
const EXPORT_NOISE_MIN_M = 10;
const EXPORT_NOISE_MAX_M = 35;
const TIMESTAMP_FUZZ_RANGE_MS = 3 * 60 * 1000;
const PRIVACY_CELL_SIZE_M = 50;
const PRIVACY_CELL_SCHEMA = 'global_grid_v1';
// The encrypted recovery region is deliberately coarse (about 6.4 km wide)
// so maps can rediscover one-way cell hashes without storing the private center.
const PRIVACY_DISPLAY_REGION_CELLS = 128;
const PRIVACY_DISPLAY_REGION_SCHEMA = 'coarse_grid_v1';
const EXPORT_PRIVACY_ZONE_ID = 'private_area';
const EXPORT_PRIVACY_ZONE_LABEL = 'Private area';
export const PRIVACY_RADIUS_MIN_M = 50;
export const PRIVACY_RADIUS_MAX_M = 1000;
export const PRIVACY_RADIUS_DEFAULT_M = 180;
export const PRIVACY_ZONE_TYPES = Object.freeze(['circle', 'corridor']);
export const PRIVACY_ZONE_SENSITIVITIES = Object.freeze(['standard', 'high']);
export const PRIVACY_CORRIDOR_MIN_WAYPOINTS = 2;
export const PRIVACY_CORRIDOR_MAX_WAYPOINTS = 20;
export const ZONE_STATS_KEY = 'drivesense_privacy_zone_stats_v1';
export const ZONE_EVENT_GUARD_M = 50;
const PRIVACY_CELL_STORAGE_GUARD_M = 0;
export const KINEMATIC_FIELDS = Object.freeze([
  'speed',
  'speed_kmh',
  'speedKmh',
  'speed_mps',
  'speedMps',
  'speed_accuracy',
  'speedAccuracy',
  'obd_speed_kmh',
  'heading',
  'heading_accuracy',
  'headingAccuracy',
  'bearing',
  'bearing_accuracy',
  'bearingAccuracy',
  'course',
  'altitude',
  'altitude_m',
  'altitude_accuracy',
  'altitudeAccuracy',
  'vertical_speed',
  'verticalSpeed',
  'vertical_accuracy',
  'verticalAccuracy',
  'accuracy',
  'horizontal_accuracy',
  'horizontalAccuracy',
  'accel_ms2',
  'acceleration_ms2',
  'acceleration_x',
  'acceleration_y',
  'acceleration_z',
  'accelerationX',
  'accelerationY',
  'accelerationZ',
]);
export const PRIVACY_ZONES_SECURE_KEY = 'drivesense_privacy_zones_config_v1';
export const NATIVE_PRIVACY_ZONES_KEY = 'privacy_zones_v1';
export const NATIVE_PRIVACY_ZONES_CONTEXT = 'native:privacy_zones_v1';
export const NATIVE_PRIVACY_SYNC_FAILED_EVENT = 'drivesense:privacy-native-sync-failed';
export const PRIVACY_ZONES_CHANGED_EVENT = 'drivesense:privacy-zones-changed';
export const NATIVE_PRIVACY_SYNC_STATUS_OK = 'ok';
export const NATIVE_PRIVACY_SYNC_STATUS_FAILED = 'failed';
let privacyZonesMemory = null;
let privacyZonesRevision = 0;
let privacyZonesStorageLoadPromise = null;
let zoneStatsWriteQueue = Promise.resolve();

const appendPrivacyAuditEvent = (event) => {
  void appendPrivacyEvent(event).catch((error) => {
    logSystemFailure('privacy_audit_log_append', error, {
      operation: event?.op || event?.operation || event?.type,
    });
  });
};

const notifyPrivacyZonesChanged = (reason = 'changed', zones = privacyZonesMemory) => {
  privacyZonesRevision += 1;
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return privacyZonesRevision;
  window.dispatchEvent(new CustomEvent(PRIVACY_ZONES_CHANGED_EVENT, {
    detail: {
      reason,
      revision: privacyZonesRevision,
      zone_count: Array.isArray(zones) ? zones.length : 0,
    },
  }));
  return privacyZonesRevision;
};

export const getPrivacyZonesRevision = () => privacyZonesRevision;

const startOfDay = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const startOfWeek = () => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - date.getDay());
  return date.getTime();
};

const defaultZoneStats = () => ({
  hiddenAllTime: 0,
  hiddenToday: 0,
  hiddenWeek: 0,
  eventsAllTime: 0,
  eventsToday: 0,
  eventsWeek: 0,
  addressesLeaked: 0,
  lastActive: null,
  dailyReset: startOfDay(),
  weeklyReset: startOfWeek(),
});

const readZoneStats = async () => {
  try {
    const stats = await getEncryptedJson(ZONE_STATS_KEY, {});
    return stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
  } catch {
    return {};
  }
};

export async function incrementZoneStats(zoneId, field, count = 1) {
  const safeId = String(zoneId || '').trim();
  const safeField = field === 'events' ? 'events' : field === 'addressesLeaked' ? 'addressesLeaked' : 'hidden';
  const amount = Math.max(0, Math.round(Number(count) || 0));
  if (!safeId || amount <= 0) return null;

  zoneStatsWriteQueue = zoneStatsWriteQueue.catch(() => {}).then(async () => {
    const stats = await readZoneStats();
    const item = { ...defaultZoneStats(), ...(stats[safeId] || {}) };
    const today = startOfDay();
    const week = startOfWeek();
    if (Number(item.dailyReset) < today) {
      item.hiddenToday = 0;
      item.eventsToday = 0;
      item.dailyReset = today;
    }
    if (Number(item.weeklyReset) < week) {
      item.hiddenWeek = 0;
      item.eventsWeek = 0;
      item.weeklyReset = week;
    }

    if (safeField === 'hidden') {
      item.hiddenToday += amount;
      item.hiddenWeek += amount;
      item.hiddenAllTime += amount;
    } else if (safeField === 'events') {
      item.eventsToday += amount;
      item.eventsWeek += amount;
      item.eventsAllTime += amount;
    } else {
      item.addressesLeaked += amount;
    }
    item.lastActive = Date.now();

    const nextStats = { ...stats, [safeId]: item };
    await setEncryptedJson(ZONE_STATS_KEY, nextStats);
    return item;
  });

  return zoneStatsWriteQueue;
}

const zoneStatsTimestampMs = (value, fallback = null) => {
  const parsed = new Date(value ?? fallback ?? 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeZoneMetadataLabel = (value) => String(value || '').trim().toLowerCase();

const zoneMetadataId = (item = {}) => String(item?.privacy_zone_id ?? item?.zone_id ?? '').trim();

const zoneMetadataLabel = (item = {}) => normalizeZoneMetadataLabel(
  item?.privacy_zone_label ?? item?.zone_label ?? item?.privacy_zone_name ?? item?.zone_name
);

const zoneMetadataRadiusM = (item = {}) => {
  const value = Number(
    item?.privacy_zone_radius_m ?? item?.zone_radius_m ?? item?.privacy_radius_m ?? item?.radius_m
  );
  return Number.isFinite(value) && value > 0 ? value : null;
};

const metadataMatchesZone = (item = {}, zone = {}) => {
  const itemLabel = zoneMetadataLabel(item);
  const zoneLabel = normalizeZoneMetadataLabel(zone?.label);
  if (!itemLabel || !zoneLabel || itemLabel !== zoneLabel) return false;

  const itemRadius = zoneMetadataRadiusM(item);
  const zoneRadius = Number(zone?.radius_m);
  return itemRadius == null || !Number.isFinite(zoneRadius) || Math.abs(itemRadius - zoneRadius) <= 5;
};

const zoneFromPrivacyMetadata = (item = {}, statsByZone = new Map(), zones = []) => {
  const itemZoneId = zoneMetadataId(item);
  if (itemZoneId && statsByZone.has(itemZoneId)) return statsByZone.get(itemZoneId) || null;

  const matchedZone = zones.find((zone) => metadataMatchesZone(item, zone));
  return matchedZone ? statsByZone.get(matchedZone.id) || null : null;
};

export function deriveZoneStatsFromTrips(trips = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  const today = startOfDay();
  const week = startOfWeek();
  const statsByZone = new Map(zones.map((zone) => [zone.id, {
    ...zone,
    today: { hidden: 0, events: 0, addresses: 0 },
    week: { hidden: 0, events: 0, addresses: 0 },
    allTime: { hidden: 0, events: 0 },
    riskLevel: 'Low',
    lastActive: null,
  }]));
  const protectedZoneForRoutePoint = (point) => {
    if (point?.privacy_boundary === true) return null;
    if (
      point?.masked_for_privacy === true ||
      point?.privacy_gap === true ||
      point?.privacy_purged === true ||
      point?.privacy_live_redacted === true ||
      point?.privacy_zone_id ||
      point?.privacy_zone_label
    ) {
      const metadataZone = zoneFromPrivacyMetadata(point, statsByZone, zones);
      if (metadataZone) return metadataZone;
    }
    const zone = isPointInPrivacyZone(point, zones);
    if (zone) return statsByZone.get(zone.id) || null;
    const fallbackZone = zones.find((candidate) => isRoutePointInsidePrivacyZone(point, candidate));
    return fallbackZone ? statsByZone.get(fallbackZone.id) || null : null;
  };
  const protectedZoneForEvent = (event) => {
    if (
      event?.privacy_event_redacted === true ||
      event?.masked_for_privacy === true ||
      event?.privacy_zone_id ||
      event?.privacy_zone_label
    ) {
      const metadataZone = zoneFromPrivacyMetadata(event, statsByZone, zones);
      if (metadataZone) return metadataZone;
    }
    const zone = isPointInPrivacyZone(event, zones, ZONE_EVENT_GUARD_M);
    if (zone) return statsByZone.get(zone.id) || null;
    const fallbackZone = zones.find((candidate) => isRoutePointInsidePrivacyZone(event, candidate, ZONE_EVENT_GUARD_M));
    return fallbackZone ? statsByZone.get(fallbackZone.id) || null : null;
  };

  for (const trip of Array.isArray(trips) ? trips : []) {
    const tripTime = zoneStatsTimestampMs(trip?.end_time, trip?.start_time);
    const countProtected = (items, field, zoneForItem) => {
      for (const item of Array.isArray(items) ? items : []) {
        const zone = zoneForItem(item);
        if (!zone) continue;
        const itemTime = zoneStatsTimestampMs(item?.timestamp ?? item?.time, tripTime);
        zone.allTime[field] += 1;
        if (itemTime >= week) zone.week[field] += 1;
        if (itemTime >= today) zone.today[field] += 1;
        zone.lastActive = Math.max(Number(zone.lastActive) || 0, itemTime || tripTime) || null;
      }
    };

    countProtected(trip?.route_points, 'hidden', protectedZoneForRoutePoint);
    countProtected(trip?.driving_events, 'events', protectedZoneForEvent);
  }

  return Array.from(statsByZone.values());
}

export async function getZoneStatsSnapshot(settings = localSettings.get(), trips = null) {
  if (Array.isArray(trips)) return deriveZoneStatsFromTrips(trips, settings);
  const zones = getPrivacyZones(settings);
  let snapshot = [];
  zoneStatsWriteQueue = zoneStatsWriteQueue.catch(() => {}).then(async () => {
    const stats = await readZoneStats();
    const today = startOfDay();
    const week = startOfWeek();
    let changed = false;
    const normalizedStats = { ...stats };

    snapshot = zones.map((zone) => {
      const item = { ...defaultZoneStats(), ...(stats[zone.id] || {}) };
      if (Number(item.dailyReset) < today) {
        item.hiddenToday = 0;
        item.eventsToday = 0;
        item.dailyReset = today;
        changed = true;
      }
      if (Number(item.weeklyReset) < week) {
        item.hiddenWeek = 0;
        item.eventsWeek = 0;
        item.weeklyReset = week;
        changed = true;
      }
      normalizedStats[zone.id] = item;

      return {
        ...zone,
        today: {
          hidden: item.hiddenToday || 0,
          events: item.eventsToday || 0,
          addresses: item.addressesLeaked || 0,
        },
        week: {
          hidden: item.hiddenWeek || 0,
          events: item.eventsWeek || 0,
          addresses: item.addressesLeaked || 0,
        },
        allTime: {
          hidden: item.hiddenAllTime || 0,
          events: item.eventsAllTime || 0,
        },
        riskLevel: 'Low',
        lastActive: item.lastActive || null,
      };
    });

    if (changed) await setEncryptedJson(ZONE_STATS_KEY, normalizedStats);
  });
  await zoneStatsWriteQueue;
  return snapshot;
}

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizeExpiry = (value) => {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export const isPrivacyZoneExpired = (zone, now = Date.now()) => {
  const expiresAt = normalizeExpiry(zone?.expiresAt);
  return Boolean(expiresAt && new Date(expiresAt).getTime() <= Number(now));
};

const normalizeCorridorWaypoints = (waypoints = []) => (
  (Array.isArray(waypoints) ? waypoints : [])
    .map((point) => ({
      lat: finiteNumber(point?.lat),
      lng: finiteNumber(point?.lng),
    }))
    .filter((point) => (
      point.lat != null &&
      point.lng != null &&
      point.lat >= -90 &&
      point.lat <= 90 &&
      point.lng >= -180 &&
      point.lng <= 180
    ))
);

export function corridorWaypointsFromRoute(routePoints = []) {
  const valid = normalizeCorridorWaypoints(routePoints);
  if (valid.length <= PRIVACY_CORRIDOR_MAX_WAYPOINTS) return valid;
  const step = (valid.length - 1) / (PRIVACY_CORRIDOR_MAX_WAYPOINTS - 1);
  return Array.from({ length: PRIVACY_CORRIDOR_MAX_WAYPOINTS }, (_, index) => (
    valid[Math.round(index * step)]
  ));
}

export function privacyZoneDistanceM(a, b) {
  const aLat = finiteNumber(a?.lat);
  const aLng = finiteNumber(a?.lng);
  const bLat = finiteNumber(b?.lat);
  const bLng = finiteNumber(b?.lng);
  if (aLat == null || aLng == null || bLat == null || bLng == null) return Number.POSITIVE_INFINITY;

  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

const distanceM = privacyZoneDistanceM;

const projectPointMeters = (point, referenceLat) => {
  const latitude = finiteNumber(point?.lat);
  const longitude = finiteNumber(point?.lng);
  if (latitude == null || longitude == null) return null;
  const latRadians = Number(referenceLat) * Math.PI / 180;
  return {
    x: longitude * 111320 * Math.max(0.01, Math.abs(Math.cos(latRadians))),
    y: latitude * 111320,
  };
};

const pointToSegmentDistanceM = (point, start, end) => {
  const referenceLat = (
    Number(point?.lat) +
    Number(start?.lat) +
    Number(end?.lat)
  ) / 3;
  const projectedPoint = projectPointMeters(point, referenceLat);
  const projectedStart = projectPointMeters(start, referenceLat);
  const projectedEnd = projectPointMeters(end, referenceLat);
  if (!projectedPoint || !projectedStart || !projectedEnd) return Number.POSITIVE_INFINITY;

  const dx = projectedEnd.x - projectedStart.x;
  const dy = projectedEnd.y - projectedStart.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return privacyZoneDistanceM(point, start);
  const ratio = Math.max(0, Math.min(1, (
    (projectedPoint.x - projectedStart.x) * dx +
    (projectedPoint.y - projectedStart.y) * dy
  ) / lengthSquared));
  return Math.hypot(
    projectedPoint.x - (projectedStart.x + dx * ratio),
    projectedPoint.y - (projectedStart.y + dy * ratio)
  );
};

export function privacyZoneGeometryDistanceM(point, zone) {
  if (zone?.type === 'corridor') {
    const waypoints = normalizeCorridorWaypoints(zone?.waypoints);
    if (waypoints.length < PRIVACY_CORRIDOR_MIN_WAYPOINTS) return Number.POSITIVE_INFINITY;
    let nearest = Number.POSITIVE_INFINITY;
    for (let index = 1; index < waypoints.length; index++) {
      nearest = Math.min(nearest, pointToSegmentDistanceM(point, waypoints[index - 1], waypoints[index]));
    }
    return nearest;
  }
  return distanceM(point, zone);
}

const zoneWidthM = (zone) => Math.max(
  PRIVACY_RADIUS_MIN_M,
  Math.min(
    PRIVACY_RADIUS_MAX_M,
    finiteNumber(zone?.type === 'corridor' ? zone?.width_m ?? zone?.widthM : zone?.radius_m) ??
      PRIVACY_RADIUS_DEFAULT_M
  )
);

const hasExactCircleGeometry = (zone = {}) => (
  finiteNumber(zone?.lat) != null &&
  finiteNumber(zone?.lng) != null &&
  Number(zone?.radius_m) > 0
);

const hasExactCorridorGeometry = (zone = {}) => (
  zone?.type === 'corridor' &&
  normalizeCorridorWaypoints(zone?.waypoints).length >= PRIVACY_CORRIDOR_MIN_WAYPOINTS &&
  Number(zone?.width_m ?? zone?.widthM) > 0
);

const hasExactZoneGeometry = (zone = {}) => (
  hasExactCircleGeometry(zone) || hasExactCorridorGeometry(zone)
);

export function getZoneEffectiveness(zone, trips = []) {
  const radiusM = zoneWidthM(zone);
  const outerRadiusM = Math.min(
    PRIVACY_RADIUS_MAX_M,
    radiusM + ZONE_EVENT_GUARD_M * 2
  );
  let nearMissCount = 0;
  let farthestNearMissM = radiusM;

  const inspect = (item) => {
    if (
      finiteNumber(item?.lat) == null ||
      finiteNumber(item?.lng) == null ||
      item?.masked_for_privacy === true ||
      item?.privacy_gap === true ||
      item?.privacy_boundary === true ||
      item?.privacy_purged === true ||
      item?.privacy_event_redacted === true
    ) return;
    const pointDistanceM = privacyZoneGeometryDistanceM(item, zone);
    if (pointDistanceM <= radiusM || pointDistanceM > outerRadiusM) return;
    nearMissCount += 1;
    farthestNearMissM = Math.max(farthestNearMissM, pointDistanceM);
  };

  (Array.isArray(trips) ? trips : []).forEach((trip) => {
    (Array.isArray(trip?.route_points) ? trip.route_points : []).forEach(inspect);
    (Array.isArray(trip?.driving_events) ? trip.driving_events : []).forEach(inspect);
  });

  return {
    nearMissCount,
    suggestedRadiusM: nearMissCount
      ? Math.min(PRIVACY_RADIUS_MAX_M, Math.ceil(farthestNearMissM))
      : null,
  };
}

const timestampMs = (point) => {
  const value = point?.timestamp ?? point?.time;
  if (value == null) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const interpolateValue = (a, b, ratio) => {
  const start = finiteNumber(a);
  const end = finiteNumber(b);
  return start != null && end != null ? start + (end - start) * ratio : undefined;
};

const interpolateTimestamp = (a, b, ratio) => {
  const start = timestampMs(a);
  const end = timestampMs(b);
  if (start == null || end == null) return a?.timestamp ?? b?.timestamp ?? null;
  return new Date(start + (end - start) * ratio).toISOString();
};

const privacyMetadata = (zone, boundary = false) => ({
  masked_for_privacy: true,
  privacy_zone_id: zone.id,
  privacy_zone_label: zone.label,
  ...(boundary ? { privacy_boundary: true } : {}),
});

const normalizePrivacyDisplayRegion = (zone = {}) => {
  const y = Number(zone?.privacy_display_region_y);
  const x = Number(zone?.privacy_display_region_x);
  const span = Number(zone?.privacy_display_region_span);
  if (!Number.isInteger(y) || !Number.isInteger(x)) return null;
  return { privacy_display_region_schema: PRIVACY_DISPLAY_REGION_SCHEMA, privacy_display_region_y: y, privacy_display_region_x: x, privacy_display_region_span: Number.isInteger(span) && span >= 32 && span <= 512 ? span : PRIVACY_DISPLAY_REGION_CELLS };
};
const privacyDisplayRegionForPoint = (point = {}, cellSizeM = PRIVACY_CELL_SIZE_M) => {
  const lat = finiteNumber(point?.lat); const lng = finiteNumber(point?.lng);
  if (lat == null || lng == null) return {};
  const size = Math.max(25, finiteNumber(cellSizeM) ?? PRIVACY_CELL_SIZE_M); const step = size / 111320;
  const y = Math.floor((lat + 90) / step); const x = Math.floor((lng + 180) / step);
  return { privacy_display_region_schema: PRIVACY_DISPLAY_REGION_SCHEMA, privacy_display_region_y: Math.floor(y / PRIVACY_DISPLAY_REGION_CELLS), privacy_display_region_x: Math.floor(x / PRIVACY_DISPLAY_REGION_CELLS), privacy_display_region_span: PRIVACY_DISPLAY_REGION_CELLS };
};

const normalizePrivacyCellHashes = (zone = {}) => (
  Array.isArray(zone.privacy_cell_hashes)
    ? Array.from(new Set(zone.privacy_cell_hashes
      .filter((cell) => typeof cell === 'string' && cell.startsWith('pzc_'))))
      .slice(0, 50000)
    : []
);

const hasCellZoneGeometry = (zone = {}) => normalizePrivacyCellHashes(zone).length > 0;

const normalizePrivacyZones = (zones = []) => (
  Array.isArray(zones)
    ? zones
      .map((zone) => {
        const type = zone?.type === 'corridor' ? 'corridor' : 'circle';
        const radiusM = Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, Number(
          type === 'corridor'
            ? zone?.width_m ?? zone?.widthM ?? zone?.radius_m
            : zone?.radius_m
        ) || PRIVACY_RADIUS_DEFAULT_M));
        const sensitivity = zone?.sensitivity === 'high' ? 'high' : 'standard';
        const expiresAt = normalizeExpiry(zone?.expiresAt);
        const base = {
          id: String(zone?.id || `pz_${Date.now().toString(36)}`),
          label: String(zone?.label || 'Private place').trim() || 'Private place',
          type,
          radius_m: radiusM,
          ...(type === 'corridor' ? { width_m: radiusM } : {}),
          sensitivity,
          ...(expiresAt ? { expiresAt } : {}),
          exclude_from_osrm: true,
          privacy_cell_schema: zone?.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
          privacy_cell_size_m: Number(zone?.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
          privacy_cell_hashes: normalizePrivacyCellHashes(zone),
          ...(normalizePrivacyDisplayRegion(zone) || {}),
          masked_for_privacy: zone?.masked_for_privacy === true,
        };
        const corridorWaypoints = type === 'corridor'
          ? normalizeCorridorWaypoints(zone?.waypoints).slice(0, PRIVACY_CORRIDOR_MAX_WAYPOINTS)
          : [];
        if (hasExactZoneGeometry({
          ...zone,
          type,
          radius_m: radiusM,
          width_m: radiusM,
          waypoints: corridorWaypoints,
        })) {
          const withGeometry = {
            ...base,
            ...(type === 'corridor' ? {
              waypoints: corridorWaypoints,
            } : {
              lat: Number(zone.lat),
              lng: Number(zone.lng),
            }),
          };
          return {
            ...withGeometry,
            privacy_cell_schema: PRIVACY_CELL_SCHEMA,
            privacy_cell_size_m: PRIVACY_CELL_SIZE_M,
            privacy_cell_hashes: createPrivacyCellHashes(withGeometry),
            ...(type === 'circle' ? privacyDisplayRegionForPoint(withGeometry) : {}),
            masked_for_privacy: false,
          };
        }
        return base.privacy_cell_hashes.length ? base : null;
      })
      .filter(Boolean)
    : []
);

const redactedPrivacyZones = (zones = []) => (
  (Array.isArray(zones) ? zones : []).map((zone) => ({
    id: String(zone.id || ''),
    label: String(zone.label || 'Private place'),
    type: zone?.type === 'corridor' ? 'corridor' : 'circle',
    radius_m: Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, Number(zone.radius_m) || PRIVACY_RADIUS_DEFAULT_M)),
    ...(zone?.type === 'corridor' ? {
      width_m: Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, Number(zone.width_m) || PRIVACY_RADIUS_DEFAULT_M)),
    } : {}),
    sensitivity: zone?.sensitivity === 'high' ? 'high' : 'standard',
    ...(normalizeExpiry(zone?.expiresAt) ? { expiresAt: normalizeExpiry(zone.expiresAt) } : {}),
    exclude_from_osrm: true,
    masked_for_privacy: true,
  }))
);

const cellOnlyPrivacyZones = (zones = []) => (
  normalizePrivacyZones(zones).map((zone) => ({
    id: zone.id,
    label: zone.label,
    type: zone.type,
    radius_m: zone.radius_m,
    ...(zone.type === 'corridor' ? { width_m: zone.width_m } : {}),
    sensitivity: zone.sensitivity,
    ...(zone.expiresAt ? { expiresAt: zone.expiresAt } : {}),
    exclude_from_osrm: true,
    privacy_cell_schema: zone.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
    privacy_cell_size_m: Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
    privacy_cell_hashes: normalizePrivacyCellHashes(zone),
    ...(normalizePrivacyDisplayRegion(zone) || {}),
    masked_for_privacy: true,
  }))
);

export function getPrivacyZones(settings = localSettings.get()) {
  const settingsZones = normalizePrivacyZones(settings?.privacy_zones);
  if (settingsZones.length) {
    return effectivePrivacyZones(settingsZones, settings);
  }
  if (Array.isArray(settings?.privacy_zones) && settings.privacy_zones.length === 0) return [];
  return effectivePrivacyZones(Array.isArray(privacyZonesMemory) ? privacyZonesMemory : [], settings);
}

export async function getHydratedPrivacyZones(settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (zones.length) return zones;
  if (!Array.isArray(settings?.privacy_zones) || settings.privacy_zones.length === 0) return [];

  const secureZones = normalizePrivacyZones(await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []));
  if (secureZones.length) {
    privacyZonesMemory = secureZones;
    notifyPrivacyZonesChanged('hydrated', secureZones);
  }
  return secureZones;
}

async function persistPrivacyZones(zones = []) {
  const normalized = normalizePrivacyZones(zones);
  privacyZonesMemory = normalized;
  await setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, cellOnlyPrivacyZones(normalized));
  await syncZonesToNative(normalized);
  notifyPrivacyZonesChanged('persisted', normalized);
  return normalized;
}

export async function savePrivacyZonesToStorage(zones = [], settings = localSettings.get()) {
  const normalized = await persistPrivacyZones(zones);
  localSettings.update({ privacy_zones: redactedPrivacyZones(normalized) });
  return {
    ...settings,
    ...localSettings.get(),
    privacy_zones: redactedPrivacyZones(normalized),
  };
}

export async function loadPrivacyZonesFromStorage(settings = localSettings.get()) {
  const secureZones = normalizePrivacyZones(await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []));
  const legacyPlaintextZones = normalizePrivacyZones(settings?.privacy_zones);
  const zones = secureZones.length ? secureZones : legacyPlaintextZones;

  if (zones.length) {
    await persistPrivacyZones(zones);
  } else {
    privacyZonesMemory = [];
    notifyPrivacyZonesChanged('loaded_empty', []);
  }

  if (legacyPlaintextZones.length || JSON.stringify(settings?.privacy_zones || []) !== JSON.stringify(redactedPrivacyZones(zones))) {
    localSettings.update({ privacy_zones: redactedPrivacyZones(zones) });
  }

  return zones;
}

export function ensurePrivacyZonesLoaded(settings = localSettings.get()) {
  if (!privacyZonesStorageLoadPromise) {
    privacyZonesStorageLoadPromise = loadPrivacyZonesFromStorage(settings).catch((error) => {
      privacyZonesStorageLoadPromise = null;
      throw error;
    });
  }
  return privacyZonesStorageLoadPromise;
}

export async function syncZonesToNative(zones = getPrivacyZones()) {
  const zoneCount = Array.isArray(zones) ? zones.length : 0;
  if (typeof window === 'undefined') return { status: 'unavailable', native: false, zoneCount };
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return { status: 'not_native', native: false, zoneCount };

    const nativeZones = normalizePrivacyZones(zones)
      .filter((zone) => hasCellZoneGeometry(zone))
      .map((zone) => ({
        id: String(zone.id || ''),
        label: String(zone.label || 'Private place'),
        radius_m: Number(zone.radius_m),
        sensitivity: zone?.sensitivity === 'high' ? 'high' : 'standard',
        ...(zone.expiresAt ? { expiresAt: zone.expiresAt } : {}),
        privacy_cell_schema: zone.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
        privacy_cell_size_m: Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
        privacy_cell_hashes: normalizePrivacyCellHashes(zone),
      }));

    if (zoneCount > 0 && nativeZones.length === 0) {
      throw new Error('No privacy-zone cell guard is available for native sync.');
    }

    const serializedNativeZones = JSON.stringify(nativeZones);
    if (Capacitor.getPlatform() === 'android') {
      await secureSetPreference({
        key: NATIVE_PRIVACY_ZONES_KEY,
        value: serializedNativeZones,
        context: NATIVE_PRIVACY_ZONES_CONTEXT,
        encryptAtRest: true,
      });
    } else {
      const encryptedNativeZones = await encryptSensitiveValue(nativeZones, NATIVE_PRIVACY_ZONES_CONTEXT);
      const { Preferences } = await import('@capacitor/preferences');
      await Preferences.set({
        key: NATIVE_PRIVACY_ZONES_KEY,
        value: JSON.stringify(encryptedNativeZones),
      });
    }
    localSettings.update({
      privacy_zones_native_sync_status: NATIVE_PRIVACY_SYNC_STATUS_OK,
      privacy_zones_native_sync_failed_at: '',
      privacy_zones_native_sync_zone_count: nativeZones.length,
    });
    return { status: NATIVE_PRIVACY_SYNC_STATUS_OK, native: true, zoneCount: nativeZones.length };
  } catch (error) {
    logSystemFailure('privacy_zones_native_sync_failed', error, {
      zone_count: zoneCount,
    });
    await failClosedAfterNativePrivacySyncFailure(error, zoneCount);
    return { status: NATIVE_PRIVACY_SYNC_STATUS_FAILED, native: true, zoneCount };
  }
}

async function failClosedAfterNativePrivacySyncFailure(error, zoneCount) {
  const failedAt = new Date().toISOString();
  let nativeTrackingStopped = false;

  localSettings.update({
    privacy_zones_native_sync_status: NATIVE_PRIVACY_SYNC_STATUS_FAILED,
    privacy_zones_native_sync_failed_at: failedAt,
    privacy_zones_native_sync_zone_count: zoneCount,
    tracking_mode: 'manual',
    auto_tracking_enabled: false,
    background_tracking_enabled: false,
    tracking_paused: false,
  });

  try {
    const { stopNativeAutoTracking } = await import('@/lib/activityRecognition');
    nativeTrackingStopped = await stopNativeAutoTracking();
  } catch (stopError) {
    logSystemFailure('privacy_zones_native_sync_stop_tracking_failed', stopError, {
      zone_count: zoneCount,
    });
  }

  recordSystemEvent('privacy_zones_native_sync_fail_closed', {
    zone_count: zoneCount,
    native_tracking_stopped: nativeTrackingStopped === true,
  }, {
    category: 'privacy',
    severity: 'warn',
    title: 'Native privacy-zone sync failed closed',
    message: 'Background auto tracking was turned off until Android receives the privacy-zone guard.',
  });
  appendPrivacyAuditEvent({
    op: 'PRIVACY_ZONES_NATIVE_SYNC_FAIL_CLOSED',
    details: {
      zone_count: zoneCount,
      native_tracking_stopped: nativeTrackingStopped === true,
    },
  });

  if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent?.(new CustomEvent(NATIVE_PRIVACY_SYNC_FAILED_EVENT, {
      detail: {
        zoneCount,
        failedAt,
        message: error?.message || 'Native privacy-zone sync failed.',
      },
    }));
  }
}

const hashCode = (value) => {
  let hash = 0;
  const text = String(value || 'privacy-zone');
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
};

const cellCoordinate = (lat, lng, cellSizeM = PRIVACY_CELL_SIZE_M) => {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lng);
  const safeCellSizeM = Math.max(25, finiteNumber(cellSizeM) ?? PRIVACY_CELL_SIZE_M);
  if (latitude == null || longitude == null) return null;

  const latStep = safeCellSizeM / 111320;
  const lngStep = safeCellSizeM / 111320;
  return {
    y: Math.floor((latitude + 90) / latStep),
    x: Math.floor((longitude + 180) / lngStep),
    latStep,
    lngStep,
    cellSizeM: safeCellSizeM,
  };
};

const privacyCellHash = (y, x, cellSizeM = PRIVACY_CELL_SIZE_M) => (
  `pzc_${hashCode(`${Math.round(cellSizeM)}:${y}:${x}`).toString(36)}`
);

const cellCenterPoint = (y, x, latStep, lngStep) => ({
  lat: ((y + 0.5) * latStep) - 90,
  lng: ((x + 0.5) * lngStep) - 180,
});

function recoverPrivacyZoneCenter(zone = {}, referencePoints = []) {
  const hashes = new Set(normalizePrivacyCellHashes(zone));
  if (!hashes.size) return null;

  const cellSizeM = Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M;
  const savedMapCenter = localSettings.get()?.last_map_center;
  const references = [...(Array.isArray(referencePoints) ? referencePoints : []), savedMapCenter]
    .filter((point) => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null);
  const visited = new Set();
  let seed = null;

  for (const reference of references.slice(0, 600)) {
    const cell = cellCoordinate(reference.lat, reference.lng, cellSizeM);
    if (!cell) continue;
    const searchCells = Math.max(4, Math.ceil((Number(zone.radius_m) || PRIVACY_RADIUS_DEFAULT_M) / cell.cellSizeM) + 4);

    for (let y = cell.y - searchCells; y <= cell.y + searchCells && !seed; y++) {
      for (let x = cell.x - searchCells; x <= cell.x + searchCells; x++) {
        const key = `${y}:${x}`;
        if (visited.has(key)) continue;
        visited.add(key);
        if (hashes.has(privacyCellHash(y, x, cell.cellSizeM))) {
          seed = { ...cell, y, x };
          break;
        }
      }
    }
    if (seed) break;
  }

  const savedRegion = normalizePrivacyDisplayRegion(zone);
  if (!seed && savedRegion) {
    const span = savedRegion.privacy_display_region_span; const startY = savedRegion.privacy_display_region_y * span; const startX = savedRegion.privacy_display_region_x * span;
    for (let y = startY; y < startY + span && !seed; y++) for (let x = startX; x < startX + span; x++) if (hashes.has(privacyCellHash(y, x, cellSizeM))) { const latStep = cellSizeM / 111320; seed = { y, x, latStep, lngStep: latStep, cellSizeM }; break; }
  }
  if (!seed) return null;
  if (!savedRegion) {
    const region = privacyDisplayRegionForPoint(cellCenterPoint(seed.y, seed.x, seed.latStep, seed.lngStep), seed.cellSizeM); Object.assign(zone, region);
    if (Array.isArray(privacyZonesMemory)) { privacyZonesMemory = privacyZonesMemory.map((item) => item?.id === zone?.id ? { ...item, ...region } : item); void setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, cellOnlyPrivacyZones(privacyZonesMemory)).catch((error) => logSystemFailure('privacy_zone_display_region_backfill', error, { zone_id: zone?.id })); }
  }

  const queue = [{ y: seed.y, x: seed.x }];
  const matched = [];
  const explored = new Set();
  while (queue.length && matched.length <= hashes.size) {
    const current = queue.shift();
    const key = `${current.y}:${current.x}`;
    if (explored.has(key)) continue;
    explored.add(key);
    if (!hashes.has(privacyCellHash(current.y, current.x, seed.cellSizeM))) continue;

    matched.push(cellCenterPoint(current.y, current.x, seed.latStep, seed.lngStep));
    for (let y = current.y - 1; y <= current.y + 1; y++) {
      for (let x = current.x - 1; x <= current.x + 1; x++) {
        if (y !== current.y || x !== current.x) queue.push({ y, x });
      }
    }
  }

  if (!matched.length) return null;
  return {
    lat: matched.reduce((sum, point) => sum + point.lat, 0) / matched.length,
    lng: matched.reduce((sum, point) => sum + point.lng, 0) / matched.length,
  };
}

export function createPrivacyCellHashes(zone = {}, cellSizeM = PRIVACY_CELL_SIZE_M) {
  if (zone?.type === 'corridor') {
    const waypoints = normalizeCorridorWaypoints(zone?.waypoints);
    const widthM = zoneWidthM(zone);
    if (waypoints.length < PRIVACY_CORRIDOR_MIN_WAYPOINTS) return [];

    const latitudes = waypoints.map((point) => point.lat);
    const longitudes = waypoints.map((point) => point.lng);
    const midLat = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
    const latitudeCosine = Math.max(0.01, Math.abs(Math.cos(midLat * Math.PI / 180)));
    const latPad = widthM / 111320;
    const lngPad = widthM / (111320 * latitudeCosine);
    const southWest = cellCoordinate(
      Math.max(-90, Math.min(...latitudes) - latPad),
      Math.max(-180, Math.min(...longitudes) - lngPad),
      cellSizeM
    );
    const northEast = cellCoordinate(
      Math.min(90, Math.max(...latitudes) + latPad),
      Math.min(180, Math.max(...longitudes) + lngPad),
      cellSizeM
    );
    if (!southWest || !northEast) return [];

    const cellDiagonalM = Math.SQRT2 * southWest.cellSizeM;
    const hashes = new Set();
    for (let y = Math.min(southWest.y, northEast.y); y <= Math.max(southWest.y, northEast.y); y++) {
      for (let x = Math.min(southWest.x, northEast.x); x <= Math.max(southWest.x, northEast.x); x++) {
        const cellCenter = cellCenterPoint(y, x, southWest.latStep, southWest.lngStep);
        if (privacyZoneGeometryDistanceM(cellCenter, zone) <= widthM + (cellDiagonalM / 2)) {
          hashes.add(privacyCellHash(y, x, southWest.cellSizeM));
        }
      }
    }
    return [...hashes].sort();
  }

  const lat = finiteNumber(zone?.lat);
  const lng = finiteNumber(zone?.lng);
  const radiusM = finiteNumber(zone?.radius_m);
  if (lat == null || lng == null || radiusM == null || radiusM <= 0) return [];

  const center = cellCoordinate(lat, lng, cellSizeM);
  if (!center) return [];

  const protectedRadiusM = radiusM + PRIVACY_CELL_STORAGE_GUARD_M;
  const latitudeCosine = Math.max(0.2, Math.abs(Math.cos(lat * Math.PI / 180)));
  const latCells = Math.max(1, Math.ceil(protectedRadiusM / center.cellSizeM) + 1);
  const lngCells = Math.max(1, Math.ceil(protectedRadiusM / (center.cellSizeM * latitudeCosine)) + 1);
  const cellDiagonalM = Math.SQRT2 * center.cellSizeM;
  const hashes = new Set();

  for (let y = center.y - latCells; y <= center.y + latCells; y++) {
    for (let x = center.x - lngCells; x <= center.x + lngCells; x++) {
      const cellCenter = cellCenterPoint(y, x, center.latStep, center.lngStep);
      if (distanceM({ lat, lng }, cellCenter) <= protectedRadiusM + (cellDiagonalM / 2)) {
        hashes.add(privacyCellHash(y, x, center.cellSizeM));
      }
    }
  }

  return [...hashes].sort();
}

function findCellPrivacyZoneForPoint(point, zones = []) {
  const lat = finiteNumber(point?.lat);
  const lng = finiteNumber(point?.lng);
  if (lat == null || lng == null) return null;

  for (const zone of Array.isArray(zones) ? zones : []) {
    const hashes = normalizePrivacyCellHashes(zone);
    if (!hashes.length) continue;

    const cell = cellCoordinate(lat, lng, zone.privacy_cell_size_m || PRIVACY_CELL_SIZE_M);
    if (!cell) continue;
    if (new Set(hashes).has(privacyCellHash(cell.y, cell.x, cell.cellSizeM))) return zone;
  }

  return null;
}

export function createPrivacyExportSalt() {
  try {
    const bytes = new Uint32Array(2);
    globalThis.crypto?.getRandomValues?.(bytes);
    if (bytes[0] || bytes[1]) return `${bytes[0].toString(36)}${bytes[1].toString(36)}`;
  } catch {}
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export function getBoundaryTimestampFuzz(zoneId = 'privacy-zone', exportSalt = '') {
  const seed = hashCode(`tf_${zoneId}_${exportSalt}`);
  const normalized = ((seed >>> 0) % 2000) / 2000;
  return Math.round((normalized - 0.5) * 2 * TIMESTAMP_FUZZ_RANGE_MS);
}

function fuzzBoundaryTimestamp(timestamp, zoneId, exportSalt) {
  if (timestamp == null) return null;
  const ms = timestampMs({ timestamp });
  if (ms == null) return timestamp;

  const fuzzMs = getBoundaryTimestampFuzz(zoneId, exportSalt);
  const fuzzedMs = ms + fuzzMs;
  return typeof timestamp === 'number' ? fuzzedMs : new Date(fuzzedMs).toISOString();
}

export function addExportNoise(lat, lng, zoneId = 'privacy-zone', exportSalt = createPrivacyExportSalt(), pointKey = '') {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lng);
  if (latitude == null || longitude == null) return { lat, lng };

  const seed = hashCode(`${zoneId}:${exportSalt}:${pointKey}:${latitude.toFixed(6)}:${longitude.toFixed(6)}`);
  const angle = (seed % 62832) / 10000;
  const distanceM = EXPORT_NOISE_MIN_M + ((seed >>> 10) % (EXPORT_NOISE_MAX_M - EXPORT_NOISE_MIN_M + 1));
  const latitudeCosine = Math.max(0.01, Math.abs(Math.cos(latitude * Math.PI / 180)));
  const dLat = (distanceM * Math.cos(angle)) / 111320;
  const dLng = (distanceM * Math.sin(angle)) / (111320 * latitudeCosine);

  return {
    lat: Math.max(-90, Math.min(90, latitude + dLat)),
    lng: Math.max(-180, Math.min(180, longitude + dLng)),
  };
}

export function getPrivacyZoneDisplayCircle(zone, offsetM = DISPLAY_CIRCLE_OFFSET_M, referencePoints = []) {
  if (zone?.type === 'corridor') return null;
  const exactLat = finiteNumber(zone?.lat);
  const exactLng = finiteNumber(zone?.lng);
  const recoveredCenter = exactLat == null || exactLng == null
    ? recoverPrivacyZoneCenter(zone, referencePoints)
    : null;
  const lat = exactLat ?? recoveredCenter?.lat ?? null;
  const lng = exactLng ?? recoveredCenter?.lng ?? null;
  if (lat == null || lng == null) return null;

  const safeOffsetM = Math.max(1, finiteNumber(offsetM) ?? DISPLAY_CIRCLE_OFFSET_M);
  const angle = (hashCode(zone?.id || zone?.label) % 62832) / 10000;
  const latitudeCosine = Math.max(0.01, Math.abs(Math.cos(lat * Math.PI / 180)));
  const dLat = (safeOffsetM * Math.cos(angle)) / 111320;
  const dLng = (safeOffsetM * Math.sin(angle)) / (111320 * latitudeCosine);
  const radiusM = Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, finiteNumber(zone?.radius_m) ?? PRIVACY_RADIUS_DEFAULT_M));

  return {
    ...zone,
    lat: Math.max(-90, Math.min(90, lat + dLat)),
    lng: Math.max(-180, Math.min(180, lng + dLng)),
    radius_m: radiusM + safeOffsetM,
    source_radius_m: radiusM,
  };
}

export function isPointInPrivacyZone(point, zones = getPrivacyZones(), guardM = 0) {
  if (finiteNumber(point?.lat) == null || finiteNumber(point?.lng) == null) return null;
  let bestZone = null;
  let bestDepth = Number.NEGATIVE_INFINITY;
  const cellOnlyZones = [];

  for (const zone of Array.isArray(zones) ? zones : []) {
    if (isPrivacyZoneExpired(zone)) continue;
    if (isPrivacyZoneExpired(zone)) continue;
    if (!hasExactZoneGeometry(zone)) {
      if (hasCellZoneGeometry(zone)) cellOnlyZones.push(zone);
      continue;
    }
    const radius = zoneWidthM(zone) + guardM;
    const depth = radius - privacyZoneGeometryDistanceM(point, zone);
    if (depth >= 0 && depth > bestDepth) {
      bestZone = zone;
      bestDepth = depth;
    }
  }

  return bestZone || findCellPrivacyZoneForPoint(point, cellOnlyZones);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function boundsToCellRange(bounds, cellSizeM = PRIVACY_CELL_SIZE_M, guardM = 0) {
  const south = clampNumber(bounds?.south, -90, 90);
  const west = clampNumber(bounds?.west, -180, 180);
  const north = clampNumber(bounds?.north, -90, 90);
  const east = clampNumber(bounds?.east, -180, 180);
  if (south == null || west == null || north == null || east == null) return null;

  const minLat = Math.min(south, north);
  const maxLat = Math.max(south, north);
  const minLng = Math.min(west, east);
  const maxLng = Math.max(west, east);
  const midLat = (minLat + maxLat) / 2;
  const latitudeCosine = Math.max(0.01, Math.abs(Math.cos(midLat * Math.PI / 180)));
  const latPad = Math.max(0, Number(guardM) || 0) / 111320;
  const lngPad = Math.max(0, Number(guardM) || 0) / (111320 * latitudeCosine);
  const southWest = cellCoordinate(minLat - latPad, minLng - lngPad, cellSizeM);
  const northEast = cellCoordinate(maxLat + latPad, maxLng + lngPad, cellSizeM);
  if (!southWest || !northEast) return null;

  return {
    minY: Math.min(southWest.y, northEast.y),
    maxY: Math.max(southWest.y, northEast.y),
    minX: Math.min(southWest.x, northEast.x),
    maxX: Math.max(southWest.x, northEast.x),
    cellSizeM: southWest.cellSizeM,
  };
}

export function boundsOverlapPrivacyZone(bounds, zones = getPrivacyZones(), guardM = 0) {
  if (!bounds || typeof bounds !== 'object') return false;
  const south = clampNumber(bounds.south, -90, 90);
  const west = clampNumber(bounds.west, -180, 180);
  const north = clampNumber(bounds.north, -90, 90);
  const east = clampNumber(bounds.east, -180, 180);
  if (south == null || west == null || north == null || east == null) return false;

  const minLat = Math.min(south, north);
  const maxLat = Math.max(south, north);
  const minLng = Math.min(west, east);
  const maxLng = Math.max(west, east);
  const guard = Math.max(0, Number(guardM) || 0);

  for (const zone of Array.isArray(zones) ? zones : []) {
    if (isPrivacyZoneExpired(zone)) continue;
    if (hasExactCircleGeometry(zone)) {
      const nearest = {
        lat: Math.max(minLat, Math.min(maxLat, Number(zone.lat))),
        lng: Math.max(minLng, Math.min(maxLng, Number(zone.lng))),
      };
      if (distanceM(nearest, zone) <= Number(zone.radius_m || PRIVACY_RADIUS_DEFAULT_M) + guard) return true;
      continue;
    }

    const hashes = hasExactCorridorGeometry(zone)
      ? createPrivacyCellHashes({
        ...zone,
        width_m: zoneWidthM(zone) + guard,
        radius_m: zoneWidthM(zone) + guard,
      })
      : normalizePrivacyCellHashes(zone);
    if (!hashes.length) return true;

    const range = boundsToCellRange(bounds, zone.privacy_cell_size_m || PRIVACY_CELL_SIZE_M, guard);
    if (!range) return true;
    const cellCount = (range.maxY - range.minY + 1) * (range.maxX - range.minX + 1);
    if (cellCount > 20000) return true;

    const zoneHashes = new Set(hashes);
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        if (zoneHashes.has(privacyCellHash(y, x, range.cellSizeM))) return true;
      }
    }
  }

  return false;
}

export function isInsidePrivacyZone(lat, lng, zones = getPrivacyZones()) {
  return Boolean(isPointInPrivacyZone({ lat, lng }, zones));
}

/**
 * @param {Record<string, any>} point
 * @returns {Record<string, any>}
 */
export function sanitizeKinematics(point = {}) {
  const safe = { ...point };
  KINEMATIC_FIELDS.forEach((field) => {
    if (field in safe) safe[field] = null;
  });
  return safe;
}

export function redactRoutePointForPrivacyStorage(point = {}, zones = getPrivacyZones(), guardM = 0) {
  const zone = isPointInPrivacyZone(point, zones, guardM);
  if (!zone) return point;

  return redactCoordinateFieldsForPrivacy(point, zone, {
    privacy_gap: true,
    privacy_live_redacted: true,
    timestamp: point?.timestamp ?? point?.time ?? new Date().toISOString(),
  });
}

/**
 * @param {Record<string, any>} value
 * @param {Record<string, any>} zone
 * @param {Record<string, any>} extra
 */
function redactCoordinateFieldsForPrivacy(value = {}, zone, extra = {}) {
  const {
    lat,
    lng,
    latitude,
    longitude,
    original_lat,
    original_lng,
    matched_lat,
    matched_lng,
    ...rest
  } = sanitizeKinematics(value || {});

  return {
    ...rest,
    ...extra,
    lat: null,
    lng: null,
    masked_for_privacy: true,
    privacy_zone_id: zone.id,
    privacy_zone_label: zone.label,
  };
}

/**
 * @param {Record<string, any>} trip
 * @param {Record<string, any>} settings
 */
export function sanitizeTripForPrivacyStorage(trip = {}, settings = localSettings.get()) {
  if (!trip || typeof trip !== 'object') return trip;
  const zones = getPrivacyZones(settings);
  if (!zones.length) return trip;

  const routePoints = Array.isArray(trip.route_points)
    ? trip.route_points.map((point) => redactRoutePointForPrivacyStorage(point, zones))
    : trip.route_points;
  const drivingEvents = Array.isArray(trip.driving_events)
    ? trip.driving_events.map((event) => {
      const zone = isPointInPrivacyZone(event, zones, ZONE_EVENT_GUARD_M);
      return zone
        ? redactCoordinateFieldsForPrivacy(event, zone, { privacy_event_redacted: true })
        : event;
    })
    : trip.driving_events;

  return {
    ...trip,
    ...(Array.isArray(routePoints) ? {
      route_points: routePoints,
      route_points_raw_count: Number(trip.route_points_raw_count) || trip.route_points.length,
      route_points_map_count: routePoints.filter((point) => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null).length,
    } : {}),
    ...(Array.isArray(drivingEvents) ? { driving_events: drivingEvents } : {}),
  };
}

/**
 * @param {Record<string, any>} trip
 * @param {Record<string, any>} settings
 */
export async function sanitizeTripForPrivacyStorageAsync(trip = {}, settings = localSettings.get()) {
  if (!trip || typeof trip !== 'object') return trip;
  const zones = await getHydratedPrivacyZones(settings);
  if (!zones.length) return trip;
  return sanitizeTripForPrivacyStorage(trip, { ...settings, privacy_zones: zones });
}

export function findOverlappingZones(zones = getPrivacyZones()) {
  const validZones = Array.isArray(zones) ? zones.filter((zone) => (
    finiteNumber(zone?.lat) != null &&
    finiteNumber(zone?.lng) != null &&
    Number(zone?.radius_m) > 0
  )) : [];
  const overlaps = [];

  for (let i = 0; i < validZones.length; i++) {
    for (let j = i + 1; j < validZones.length; j++) {
      const a = validZones[i];
      const b = validZones[j];
      const overlapMeters = Number(a.radius_m) + Number(b.radius_m) - distanceM(a, b);
      if (overlapMeters > 0) {
        overlaps.push({ a, b, overlapMeters });
      }
    }
  }

  return overlaps;
}

export function mergePrivacyZones(a, b) {
  if (!a || !b) return null;
  const aLat = finiteNumber(a.lat);
  const aLng = finiteNumber(a.lng);
  const bLat = finiteNumber(b.lat);
  const bLng = finiteNumber(b.lng);
  if (aLat == null || aLng == null || bLat == null || bLng == null) return null;

  const aRadius = Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, finiteNumber(a.radius_m) ?? PRIVACY_RADIUS_DEFAULT_M));
  const bRadius = Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, finiteNumber(b.radius_m) ?? PRIVACY_RADIUS_DEFAULT_M));
  const d = distanceM(a, b);
  const base = {
    id: `pz_merge_${Date.now().toString(36)}`,
    label: `${a.label || 'Zone'} + ${b.label || 'Zone'}`,
    exclude_from_osrm: true,
  };

  if (d + bRadius <= aRadius) {
    const merged = { ...base, lat: aLat, lng: aLng, radius_m: aRadius };
    return { ...merged, privacy_cell_hashes: createPrivacyCellHashes(merged) };
  }
  if (d + aRadius <= bRadius) {
    const merged = { ...base, lat: bLat, lng: bLng, radius_m: bRadius };
    return { ...merged, privacy_cell_hashes: createPrivacyCellHashes(merged) };
  }

  const ratio = d > 0 ? Math.max(0, Math.min(1, (d + aRadius - bRadius) / (2 * d))) : 0.5;
  const radiusM = Math.ceil((d + aRadius + bRadius) / 2);
  const merged = {
    ...base,
    lat: aLat + (bLat - aLat) * ratio,
    lng: aLng + (bLng - aLng) * ratio,
    radius_m: radiusM,
  };

  return {
    ...merged,
    privacy_cell_hashes: createPrivacyCellHashes(merged),
  };
}

const pointCoordinatePairs = (point = {}) => ([
  [point.lat, point.lng],
  [point.latitude, point.longitude],
  [point.original_lat, point.original_lng],
  [point.matched_lat, point.matched_lng],
]);

export function isRoutePointInsidePrivacyZone(point, zone, guardM = 0) {
  if (!zone) return false;
  return pointCoordinatePairs(point).some(([lat, lng]) => (
    finiteNumber(lat) != null &&
    finiteNumber(lng) != null &&
    isPointInPrivacyZone({ lat, lng }, [zone], guardM)
  ));
}

export function countTripsAffectedByPrivacyZone(trips = [], zone) {
  return tripIdsAffectedByPrivacyZone(trips, zone).length;
}

export function tripIdsAffectedByPrivacyZone(trips = [], zone) {
  if (!zone || !Array.isArray(trips)) return [];
  return trips.filter((trip) => (
    (Array.isArray(trip?.route_points) && trip.route_points.some((point) => isRoutePointInsidePrivacyZone(point, zone))) ||
    (Array.isArray(trip?.driving_events) && trip.driving_events.some((event) => isRoutePointInsidePrivacyZone(event, zone)))
  )).map((trip) => trip.id).filter((id) => id != null);
}

const privacyPurgePlaceholder = (point, zone) => ({
  ...Object.fromEntries(
    KINEMATIC_FIELDS
      .filter((field) => field in (point || {}))
      .map((field) => [field, null])
  ),
  lat: null,
  lng: null,
  timestamp: point?.timestamp ?? point?.time ?? null,
  masked_for_privacy: true,
  privacy_purged: true,
  privacy_zone_id: zone.id,
  privacy_zone_label: zone.label,
});

/**
 * @param {Record<string, any>} trip
 * @param {Record<string, any>} zone
 */
export function purgeTripGpsWithinPrivacyZone(trip = {}, zone) {
  if (!zone || !trip || typeof trip !== 'object') {
    return { trip, changed: false, purgedPoints: 0, purgedEvents: 0 };
  }

  let changed = false;
  let purgedPoints = 0;
  let previousPurged = false;
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  const nextRoutePoints = [];

  routePoints.forEach((point) => {
    if (!isRoutePointInsidePrivacyZone(point, zone)) {
      nextRoutePoints.push(point);
      previousPurged = false;
      return;
    }

    changed = true;
    purgedPoints += 1;
    if (!previousPurged) {
      nextRoutePoints.push(privacyPurgePlaceholder(point, zone));
      previousPurged = true;
    }
  });

  let purgedEvents = 0;
  const drivingEvents = Array.isArray(trip.driving_events) ? trip.driving_events : [];
  const nextDrivingEvents = drivingEvents.filter((event) => {
    const inside = isRoutePointInsidePrivacyZone(event, zone);
    if (inside) {
      changed = true;
      purgedEvents += 1;
    }
    return !inside;
  });

  if (!changed) return { trip, changed: false, purgedPoints: 0, purgedEvents: 0 };

  return {
    changed: true,
    purgedPoints,
    purgedEvents,
    trip: {
      ...trip,
      route_points: nextRoutePoints,
      route_points_raw_count: routePoints.length,
      route_points_map_count: nextRoutePoints.filter((point) => finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null).length,
      driving_events: nextDrivingEvents,
      privacy_purged_zone_ids: Array.from(new Set([
        ...(Array.isArray(trip.privacy_purged_zone_ids) ? trip.privacy_purged_zone_ids : []),
        zone.id,
      ])),
      privacy_purged_at: new Date().toISOString(),
      needs_rescore: true,
    },
  };
}

export async function purgeGpsWithinPrivacyZone(trips = [], zone, updateTrip) {
  let tripsAffected = 0;
  let pointsPurged = 0;
  let eventsPurged = 0;
  const tripIdsAffected = [];
  const updates = [];

  for (const trip of Array.isArray(trips) ? trips : []) {
    const result = purgeTripGpsWithinPrivacyZone(trip, zone);
    if (!result.changed) continue;

    tripsAffected += 1;
    pointsPurged += result.purgedPoints;
    eventsPurged += result.purgedEvents;
    tripIdsAffected.push(trip.id);
    if (typeof updateTrip === 'function') {
      updates.push(() => updateTrip(trip.id, {
        route_points: result.trip.route_points,
        route_points_raw_count: result.trip.route_points_raw_count,
        route_points_map_count: result.trip.route_points_map_count,
        driving_events: result.trip.driving_events,
        privacy_purged_zone_ids: result.trip.privacy_purged_zone_ids,
        privacy_purged_at: result.trip.privacy_purged_at,
        needs_rescore: result.trip.needs_rescore,
      }));
    }
  }

  // Bound concurrent storage writes so cleanup is fast without overwhelming IndexedDB.
  const concurrency = 6;
  for (let index = 0; index < updates.length; index += concurrency) {
    await Promise.all(updates.slice(index, index + concurrency).map((run) => run()));
  }

  if (tripsAffected > 0) {
    appendPrivacyAuditEvent({
      op: 'PRIVATE_GPS_PURGED',
      zoneId: zone?.id,
      zoneLabel: zone?.label,
      hiddenCount: pointsPurged + eventsPurged,
      details: {
        affected_trip_count: tripsAffected,
        purged_point_count: pointsPurged,
        purged_event_count: eventsPurged,
      },
    });
  }

  return { tripsAffected, pointsPurged, eventsPurged, tripIdsAffected };
}

export function shouldMaskEventForPrivacy(event, zones = getPrivacyZones(), guardM = ZONE_EVENT_GUARD_M) {
  return Boolean(isPointInPrivacyZone(event, zones, guardM));
}

export function maskEventCoordinatesForPrivacy(event, zones = getPrivacyZones(), guardM = ZONE_EVENT_GUARD_M) {
  const zone = isPointInPrivacyZone(event, zones, guardM);
  return zone
    ? redactCoordinateFieldsForPrivacy(event, zone, { privacy_event_redacted: true })
    : event;
}

export function privacyZonesForRoute(routePoints = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length || !Array.isArray(routePoints) || !routePoints.length) return [];
  return zones.filter((zone) => routePoints.some((point) => (
    point?.privacy_zone_id === zone.id ||
    isPointInPrivacyZone(point, [zone])
  )));
}

export function privacyBoundaryPoint(insidePoint, outsidePoint, zone) {
  if (!insidePoint || !outsidePoint || !zone) return null;
  if (isPointInPrivacyZone(outsidePoint, [zone])) return null;
  let low = 0;
  let high = 1;
  let mid = 1;

  for (let i = 0; i < 24; i++) {
    mid = (low + high) / 2;
    const candidate = {
      lat: interpolateValue(insidePoint.lat, outsidePoint.lat, mid),
      lng: interpolateValue(insidePoint.lng, outsidePoint.lng, mid),
    };
    if (isPointInPrivacyZone(candidate, [zone])) low = mid;
    else high = mid;
  }

  const ratio = high;
  const lat = interpolateValue(insidePoint.lat, outsidePoint.lat, ratio);
  const lng = interpolateValue(insidePoint.lng, outsidePoint.lng, ratio);
  if (lat == null || lng == null) return null;

  return sanitizeKinematics({
    ...outsidePoint,
    lat,
    lng,
    timestamp: interpolateTimestamp(insidePoint, outsidePoint, ratio),
    ...privacyMetadata(zone, true),
  });
}

const pushBoundary = (masked, insidePoint, outsidePoint, zone) => {
  const boundary = privacyBoundaryPoint(insidePoint, outsidePoint, zone);
  if (!boundary) return;
  const previous = masked.at(-1);
  if (
    previous &&
    previous.privacy_boundary &&
    previous.privacy_zone_id === boundary.privacy_zone_id &&
    distanceM(previous, boundary) < 0.5
  ) return;
  masked.push(boundary);
};

const pushPrivacyGap = (masked, point, zone) => {
  const previous = masked.at(-1);
  if (previous?.privacy_gap && previous.privacy_zone_id === zone?.id) return;
  masked.push(redactCoordinateFieldsForPrivacy(point, zone, {
    timestamp: point?.timestamp ?? point?.time ?? null,
    privacy_gap: true,
  }));
};

export function maskRoutePointsForPrivacy(routePoints = [], settings = localSettings.get()) {
  // Display, storage, export, and scoring-input masking. Score pipelines call
  // this before calculating aggregate scores so private-zone gaps protect both
  // the map and the score inputs.
  const zones = getPrivacyZones(settings);
  if (!zones.length) {
    return (Array.isArray(routePoints) ? routePoints : [])
      .map((point) => point?.masked_for_privacy === true ? sanitizeKinematics(point) : point);
  }

  const masked = [];
  const points = Array.isArray(routePoints) ? routePoints : [];
  const coordinateBuffer = new SecureGpsBuffer(points);

  try {
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (point?.masked_for_privacy === true && point?.privacy_boundary !== true) {
        masked.push(sanitizeKinematics(point));
        continue;
      }

      const zone = isPointInPrivacyZone(coordinateBuffer.get(index), zones);
      const previous = index > 0 ? points[index - 1] : null;
      const previousZone = previous ? isPointInPrivacyZone(coordinateBuffer.get(index - 1), zones) : null;

      if (!zone && previousZone) {
        if (hasExactZoneGeometry(previousZone)) pushBoundary(masked, previous, point, previousZone);
      }

      if (!zone) {
        masked.push(point);
        continue;
      }

      if (previous && !previousZone) {
        if (hasExactZoneGeometry(zone)) pushBoundary(masked, point, previous, zone);
        else pushPrivacyGap(masked, point, zone);
        continue;
      }

      if (!hasExactZoneGeometry(zone)) {
        pushPrivacyGap(masked, point, zone);
      }
    }

    return masked;
  } finally {
    coordinateBuffer.zero();
  }
}

export function maskEventsForPrivacy(events = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return events;
  const sourceEvents = Array.isArray(events) ? events : [];
  const coordinateBuffer = new SecureGpsBuffer(sourceEvents);

  try {
    const filtered = sourceEvents.filter((event, index) => (
      !shouldMaskEventForPrivacy(coordinateBuffer.get(index), zones)
    ));
    return filtered;
  } finally {
    coordinateBuffer.zero();
  }
}

function publicSpeedSummaryForTrip(trip = {}, zones = []) {
  const rawRoutePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  const coordinateBuffer = new SecureGpsBuffer(rawRoutePoints);

  try {
    const touchesPrivacyZone = rawRoutePoints.some((point, index) => (
      point?.masked_for_privacy === true ||
      point?.privacy_boundary === true ||
      Boolean(isPointInPrivacyZone(coordinateBuffer.get(index), zones))
    ));
    if (!touchesPrivacyZone) return {};

    const publicSpeedSamples = rawRoutePoints
      .filter((point, index) => (
        point?.masked_for_privacy !== true &&
        point?.privacy_boundary !== true &&
        !isPointInPrivacyZone(coordinateBuffer.get(index), zones)
      ))
      .map(publicPointSpeedKmh)
      .filter(Number.isFinite);
    const publicRunningSpeedSamples = publicSpeedSamples.filter((speed) => speed > 0);

    return {
      avg_speed_kmh: averageSpeed(publicSpeedSamples),
      avg_running_speed_kmh: averageSpeed(publicRunningSpeedSamples),
      max_speed_kmh: publicSpeedSamples.length ? roundSpeed(Math.max(...publicSpeedSamples)) : null,
    };
  } finally {
    coordinateBuffer.zero();
  }
}

function privacyZoneForExportEndpoint(point, zones = []) {
  if (!point) return null;
  const metadataZoneId = point.privacy_zone_id || point.zone_id;
  if (point.masked_for_privacy === true && metadataZoneId) {
    return { id: metadataZoneId };
  }
  const coordinateBuffer = new SecureGpsBuffer([point]);
  try {
    return isPointInPrivacyZone(coordinateBuffer.get(0), zones);
  } finally {
    coordinateBuffer.zero();
  }
}

/** @param {Record<string, any>} point */
const stripExportBoundaryGeometry = (point = {}) => {
  const {
    radius,
    radius_m,
    source_radius_m,
    zone_radius_m,
    privacy_radius_m,
    privacy_zone_radius_m,
    zone_id,
    zone_label,
    privacy_zone_id,
    privacy_zone_label,
    privacy_zone_name,
    ...rest
  } = point;
  return rest;
};

const sanitizePrivacyPointForExport = (point = {}) => ({
  ...sanitizeKinematics(stripExportBoundaryGeometry(point)),
  privacy_zone_id: EXPORT_PRIVACY_ZONE_ID,
  privacy_zone_label: EXPORT_PRIVACY_ZONE_LABEL,
});

export function addExportNoiseToPrivacyBoundaries(routePoints = [], exportSalt = createPrivacyExportSalt()) {
  return (Array.isArray(routePoints) ? routePoints : []).map((point, index) => {
    if (!point?.privacy_boundary) return point;
    const boundary = stripExportBoundaryGeometry(point);
    const zoneId = boundary.privacy_zone_id || boundary.zone_id || 'privacy-zone';
    const noisy = addExportNoise(
      boundary.lat,
      boundary.lng,
      zoneId,
      exportSalt,
      `${index}:${boundary.timestamp || boundary.time || ''}`
    );
    return {
      ...boundary,
      lat: noisy.lat,
      lng: noisy.lng,
      timestamp: fuzzBoundaryTimestamp(boundary.timestamp ?? boundary.time ?? null, zoneId, exportSalt),
      export_noised_for_privacy: true,
    };
  });
}

/**
 * @param {Array<Record<string, any>>} routePoints
 */
export function replacePrivacyBoundariesWithExportGaps(routePoints = [], exportSalt = createPrivacyExportSalt()) {
  const output = [];
  (Array.isArray(routePoints) ? routePoints : []).forEach((point) => {
    if (!point?.privacy_boundary) {
      output.push(point?.masked_for_privacy === true || point?.privacy_gap === true
        ? sanitizePrivacyPointForExport(point)
        : point);
      return;
    }

    const previous = output.at(-1);
    const zoneId = point.privacy_zone_id || point.zone_id || 'privacy-zone';
    if (previous?.privacy_export_placeholder) return;

    output.push(sanitizePrivacyPointForExport({
      lat: null,
      lng: null,
      timestamp: fuzzBoundaryTimestamp(point.timestamp ?? point.time ?? null, zoneId, exportSalt),
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
    }));
  });
  return output;
}

export function maskRoutePointsForPrivacyExport(routePoints = [], settings = localSettings.get(), exportSalt = createPrivacyExportSalt()) {
  return replacePrivacyBoundariesWithExportGaps(maskRoutePointsForPrivacy(routePoints, settings), exportSalt);
}

export function maskTripForPrivacy(trip = {}, settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  const rawRoutePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  return {
    ...trip,
    ...publicSpeedSummaryForTrip(trip, zones),
    route_points: maskRoutePointsForPrivacy(rawRoutePoints, settings),
    driving_events: maskEventsForPrivacy(Array.isArray(trip.driving_events) ? trip.driving_events : [], settings),
    start_address: trip.start_address && privacyZoneForExportEndpoint(rawRoutePoints[0], zones) ? null : trip.start_address,
    end_address: trip.end_address && privacyZoneForExportEndpoint(rawRoutePoints.at?.(-1), zones) ? null : trip.end_address,
  };
}

export function maskTripForPrivacyExport(trip = {}, settings = localSettings.get(), exportSalt = createPrivacyExportSalt()) {
  const zones = getPrivacyZones(settings);
  const rawRoutePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  const hasStoredPrivacyMarkers = rawRoutePoints.some((point) => (
    point?.masked_for_privacy === true ||
    point?.privacy_boundary === true ||
    point?.privacy_gap === true ||
    Boolean(point?.privacy_zone_id)
  ));
  if (!zones.length && !hasStoredPrivacyMarkers) return trip;

  const startZone = privacyZoneForExportEndpoint(rawRoutePoints[0], zones);
  const endZone = privacyZoneForExportEndpoint(rawRoutePoints.at?.(-1), zones);
  const masked = /** @type {Record<string, any>} */ (maskTripForPrivacy(trip, settings));
  const exportTrip = (startZone || endZone || rawRoutePoints.some((point) => (
    point?.masked_for_privacy === true ||
    point?.privacy_boundary === true ||
    point?.privacy_gap === true ||
    Boolean(point?.privacy_zone_id) ||
    Boolean(isPointInPrivacyZone(point, zones))
  )))
    ? applyDifferentialPrivacyToAggregates(masked)
    : masked;
  const shiftedFields = [
    ...(startZone && exportTrip.start_time != null ? ['start_time'] : []),
    ...(endZone && exportTrip.end_time != null ? ['end_time'] : []),
  ];
  return {
    ...exportTrip,
    ...(startZone && exportTrip.start_time != null ? {
      start_time: fuzzBoundaryTimestamp(exportTrip.start_time, startZone.id, exportSalt),
    } : {}),
    ...(endZone && exportTrip.end_time != null ? {
      end_time: fuzzBoundaryTimestamp(exportTrip.end_time, endZone.id, exportSalt),
    } : {}),
    ...(shiftedFields.length ? {
      privacy_time_shifted: true,
      privacy_time_shifted_fields: shiftedFields,
      privacy_time_shift_policy: 'bounded_private_zone_noise',
    } : {}),
    route_points: replacePrivacyBoundariesWithExportGaps(
      Array.isArray(exportTrip.route_points) ? exportTrip.route_points : [],
      exportSalt
    ),
  };
}

function publicPointSpeedKmh(point = {}) {
  const speedKmh = finiteNumber(point.speed_kmh ?? point.speedKmh);
  if (speedKmh != null) return Math.max(0, speedKmh);
  const speedMps = finiteNumber(point.speed_mps ?? point.speedMps);
  if (speedMps != null) return Math.max(0, speedMps * 3.6);
  const legacySpeed = finiteNumber(point.speed);
  return legacySpeed == null ? null : Math.max(0, legacySpeed);
}

function averageSpeed(speeds = []) {
  if (!speeds.length) return null;
  return roundSpeed(speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length);
}

const roundSpeed = (speed) => Math.round(speed * 10) / 10;

const segmentsIntersect = (a, b, c, d) => {
  const cross = (p, q, r) => (
    (q.x - p.x) * (r.y - p.y) -
    (q.y - p.y) * (r.x - p.x)
  );
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  return (
    ((abC >= 0 && abD <= 0) || (abC <= 0 && abD >= 0)) &&
    ((cdA >= 0 && cdB <= 0) || (cdA <= 0 && cdB >= 0))
  );
};

const segmentToSegmentDistanceM = (a, b, c, d) => {
  const referenceLat = (Number(a?.lat) + Number(b?.lat) + Number(c?.lat) + Number(d?.lat)) / 4;
  const pa = projectPointMeters(a, referenceLat);
  const pb = projectPointMeters(b, referenceLat);
  const pc = projectPointMeters(c, referenceLat);
  const pd = projectPointMeters(d, referenceLat);
  if (!pa || !pb || !pc || !pd) return Number.POSITIVE_INFINITY;
  if (segmentsIntersect(pa, pb, pc, pd)) return 0;
  return Math.min(
    pointToSegmentDistanceM(a, c, d),
    pointToSegmentDistanceM(b, c, d),
    pointToSegmentDistanceM(c, a, b),
    pointToSegmentDistanceM(d, a, b)
  );
};

const routeSegmentTouchesExactZone = (start, end, zone, guardM = 0) => {
  const threshold = zoneWidthM(zone) + Math.max(0, Number(guardM) || 0);
  if (zone?.type === 'corridor') {
    const waypoints = normalizeCorridorWaypoints(zone?.waypoints);
    for (let index = 1; index < waypoints.length; index++) {
      if (segmentToSegmentDistanceM(start, end, waypoints[index - 1], waypoints[index]) <= threshold) {
        return true;
      }
    }
    return false;
  }
  return pointToSegmentDistanceM(zone, start, end) <= threshold;
};

export function routeTouchesPrivacyZone(routePoints = [], zone, guardM = 0) {
  if (!zone || isPrivacyZoneExpired(zone)) return false;
  const points = (Array.isArray(routePoints) ? routePoints : []).filter((point) => (
    finiteNumber(point?.lat) != null && finiteNumber(point?.lng) != null
  ));
  if (!points.length) return false;
  if (points.some((point) => Boolean(isPointInPrivacyZone(point, [zone], guardM)))) return true;

  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    if (hasExactZoneGeometry(zone)) {
      if (routeSegmentTouchesExactZone(start, end, zone, guardM)) return true;
      continue;
    }

    const lengthM = privacyZoneDistanceM(start, end);
    const sampleCount = Math.max(1, Math.ceil(lengthM / Math.max(25, Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M)));
    for (let sample = 1; sample < sampleCount; sample++) {
      const ratio = sample / sampleCount;
      if (isPointInPrivacyZone({
        lat: start.lat + (end.lat - start.lat) * ratio,
        lng: start.lng + (end.lng - start.lng) * ratio,
      }, [zone], guardM)) return true;
    }
  }
  return false;
}

async function purgeZoneFromTripRepository(zone) {
  const [{ tripService }, { enqueueRescoreJob }, { rescoreTripForQueue }] = await Promise.all([
    import('@/api/trips'),
    import('@/lib/rescoringQueue'),
    import('@/lib/rescoringWorker'),
  ]);
  const trips = await tripService.listAll({ sort: '-start_time' });
  const purgeZone = { ...zone };
  delete purgeZone.expiresAt;
  const result = await purgeGpsWithinPrivacyZone(
    trips,
    purgeZone,
    (id, patch) => tripService.update(id, patch)
  );
  if (result.tripIdsAffected.length) {
    void enqueueRescoreJob({
      reason: 'privacy_zone_purged',
      zoneId: zone.id,
      tripIds: result.tripIdsAffected,
    }, { rescoreTrip: rescoreTripForQueue });
  }
  return result;
}

export async function purgeExistingGpsForHeightenedPrivacy(settings = localSettings.get()) {
  const zones = await getHydratedPrivacyZones(settings);
  const totals = {
    zoneCount: zones.length,
    tripsAffected: 0,
    pointsPurged: 0,
    eventsPurged: 0,
  };

  for (const zone of zones) {
    const result = await purgeZoneFromTripRepository(zone);
    totals.tripsAffected += result.tripsAffected;
    totals.pointsPurged += result.pointsPurged;
    totals.eventsPurged += result.eventsPurged;
  }

  return totals;
}

export async function upsertPrivacyZone(zone, settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  const type = zone?.type === 'corridor' ? 'corridor' : 'circle';
  const widthM = Math.max(PRIVACY_RADIUS_MIN_M, Math.min(PRIVACY_RADIUS_MAX_M, Number(
    type === 'corridor'
      ? zone?.width_m ?? zone?.widthM ?? zone?.radius_m
      : zone?.radius_m
  ) || PRIVACY_RADIUS_DEFAULT_M));
  const proposed = {
    id: zone.id || `pz_${Date.now().toString(36)}`,
    label: String(zone.label || 'Private place').trim() || 'Private place',
    type,
    radius_m: widthM,
    ...(type === 'corridor' ? {
      width_m: widthM,
      waypoints: normalizeCorridorWaypoints(zone?.waypoints),
    } : {}),
    sensitivity: zone?.sensitivity === 'high' ? 'high' : 'standard',
    ...(normalizeExpiry(zone?.expiresAt) ? { expiresAt: normalizeExpiry(zone.expiresAt) } : {}),
    exclude_from_osrm: true,
    ...(type === 'circle' && finiteNumber(zone.lat) != null && finiteNumber(zone.lng) != null ? {
      lat: Number(zone.lat),
      lng: Number(zone.lng),
    } : {}),
    ...(Array.isArray(zone.privacy_cell_hashes) ? {
      privacy_cell_hashes: zone.privacy_cell_hashes,
      privacy_cell_schema: zone.privacy_cell_schema,
      privacy_cell_size_m: zone.privacy_cell_size_m,
    } : {}),
  };
  const previous = zones.find((item) => item.id === proposed.id);
  if (!hasExactZoneGeometry(proposed) && previous && Number(proposed.radius_m) !== Number(previous.radius_m)) {
    throw new Error('Re-add this privacy zone to change its radius or width because the exact geometry is no longer stored.');
  }
  const normalized = normalizePrivacyZones([proposed])[0];
  if (!normalized) throw new Error('Privacy zone needs a location before it can be saved.');
  const proposedLat = finiteNumber(zone?.lat);
  const proposedLng = finiteNumber(zone?.lng);
  const zoneChanged = !previous ||
    previous.type !== normalized.type ||
    previous.lat !== proposedLat ||
    previous.lng !== proposedLng ||
    previous.radius_m !== normalized.radius_m ||
    previous.sensitivity !== normalized.sensitivity ||
    previous.expiresAt !== normalized.expiresAt ||
    previous.exclude_from_osrm !== normalized.exclude_from_osrm ||
    JSON.stringify(previous.privacy_cell_hashes || []) !== JSON.stringify(normalized.privacy_cell_hashes || []);
  const next = zones.filter((item) => item.id !== normalized.id).concat(normalized);
  const consentInvalidated = zoneChanged && settings.osrm_data_sharing_consented === true;
  const shouldPurgeExistingGps = zoneChanged && zone?.purge_existing_gps !== false;
  if (zoneChanged) void clearMapMatchingCache();
  await persistPrivacyZones(next);
  const updated = localSettings.update({
    privacy_zones: redactedPrivacyZones(next),
    ...(consentInvalidated ? {
      osrm_data_sharing_consented: false,
      osrm_data_sharing_consented_at: '',
      osrm_consent_invalidated_reason: 'privacy_zone_changed',
      osrm_consent_invalidated_at: new Date().toISOString(),
      osrm_consent_invalidated_zone_label: normalized.label,
    } : {}),
  });
  const purgeResult = shouldPurgeExistingGps
    ? await purgeZoneFromTripRepository(normalized)
    : null;
  recordSystemEvent('privacy_zone_saved', {
    zone_id: normalized.id,
    label: normalized.label,
    radius_m: normalized.radius_m,
    zone_type: normalized.type,
    sensitivity: normalized.sensitivity,
    zone_count: next.length,
    purged_existing_gps: purgeResult != null,
    purged_trip_count: purgeResult?.tripsAffected || 0,
    purged_point_count: purgeResult?.pointsPurged || 0,
    purged_event_count: purgeResult?.eventsPurged || 0,
  }, { category: 'privacy', title: 'Privacy zone saved' });
  appendPrivacyAuditEvent({
    op: previous ? 'ZONE_UPDATED' : 'ZONE_SAVED',
    zoneId: normalized.id,
    zoneLabel: normalized.label,
    details: {
      zone_count: next.length,
      purged_existing_gps: purgeResult != null,
      purged_point_count: purgeResult?.pointsPurged || 0,
      purged_event_count: purgeResult?.eventsPurged || 0,
    },
  });
  if (consentInvalidated) {
    recordSystemEvent('osrm_consent_invalidated', {
      reason: 'privacy_zone_changed',
      zone_id: normalized.id,
      zone_label: normalized.label,
    }, { category: 'osrm', severity: 'warn', title: 'OSRM consent needs review' });
    appendPrivacyAuditEvent({
      op: 'OSRM_CONSENT_INVALIDATED',
      zoneId: normalized.id,
      zoneLabel: normalized.label,
      details: {
        reason: 'privacy_zone_changed',
      },
    });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('osrm-consent-required', {
        detail: { reason: 'new_privacy_zone', zoneLabel: normalized.label },
      }));
    }
  }
  return updated;
}

export async function removePrivacyZone(id, settings = localSettings.get()) {
  const next = getPrivacyZones(settings).filter((zone) => zone.id !== id);
  await persistPrivacyZones(next);
  const updated = localSettings.update({ privacy_zones: redactedPrivacyZones(next) });
  recordSystemEvent('privacy_zone_removed', {
    zone_id: id,
    zone_count: next.length,
  }, { category: 'privacy', title: 'Privacy zone removed' });
  appendPrivacyAuditEvent({
    op: 'ZONE_DELETED',
    zoneId: id,
    details: {
      zone_count: next.length,
    },
  });
  return updated;
}

export async function sweepExpiredPrivacyZones(now = Date.now()) {
  const settings = localSettings.get();
  const zones = await getHydratedPrivacyZones(settings);
  const expired = zones.filter((zone) => isPrivacyZoneExpired(zone, now));
  if (!expired.length) return { expiredCount: 0, purgedTrips: 0, purgedPoints: 0, purgedEvents: 0 };

  let purgedTrips = 0;
  let purgedPoints = 0;
  let purgedEvents = 0;
  for (const zone of expired) {
    const result = await purgeZoneFromTripRepository(zone);
    purgedTrips += result.tripsAffected;
    purgedPoints += result.pointsPurged;
    purgedEvents += result.eventsPurged;
  }

  const remaining = zones.filter((zone) => !isPrivacyZoneExpired(zone, now));
  await persistPrivacyZones(remaining);
  localSettings.update({ privacy_zones: redactedPrivacyZones(remaining) });
  expired.forEach((zone) => {
    recordSystemEvent('privacy_zone_expired', {
      zone_id: zone.id,
      label: zone.label,
      purge_raw_gps: true,
    }, { category: 'privacy', severity: 'warn', title: 'Temporary privacy zone expired and private GPS erased' });
    appendPrivacyAuditEvent({
      op: 'ZONE_DELETED',
      zoneId: zone.id,
      zoneLabel: zone.label,
      details: { reason: 'expired', zone_count: remaining.length },
    });
  });
  void clearMapMatchingCache();
  return {
    expiredCount: expired.length,
    purgedTrips,
    purgedPoints,
    purgedEvents,
  };
}
