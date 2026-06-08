import { localSettings } from '@/lib/trackingStore';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';
import { clearMapMatchingCache } from '@/lib/mapMatching';
import { encryptSensitiveValue, getEncryptedJson, setEncryptedJson } from '@/lib/securePayloadCrypto';

const EARTH_RADIUS_M = 6371000;
const DISPLAY_CIRCLE_OFFSET_M = 35;
const EXPORT_NOISE_MIN_M = 10;
const EXPORT_NOISE_MAX_M = 35;
const PRIVACY_CELL_SIZE_M = 100;
const PRIVACY_CELL_SCHEMA = 'global_grid_v1';
export const ZONE_EVENT_GUARD_M = 50;
const PRIVACY_CELL_STORAGE_GUARD_M = ZONE_EVENT_GUARD_M;
export const PRIVACY_ZONES_SECURE_KEY = 'drivesense_privacy_zones_config_v1';
export const NATIVE_PRIVACY_ZONES_KEY = 'privacy_zones_v1';
export const NATIVE_PRIVACY_ZONES_CONTEXT = 'native:privacy_zones_v1';
export const NATIVE_PRIVACY_SYNC_FAILED_EVENT = 'drivesense:privacy-native-sync-failed';
export const NATIVE_PRIVACY_SYNC_STATUS_OK = 'ok';
export const NATIVE_PRIVACY_SYNC_STATUS_FAILED = 'failed';
let privacyZonesMemory = null;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function distanceM(a, b) {
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

const normalizePrivacyCellHashes = (zone = {}) => (
  Array.isArray(zone.privacy_cell_hashes)
    ? Array.from(new Set(zone.privacy_cell_hashes
      .filter((cell) => typeof cell === 'string' && cell.startsWith('pzc_'))))
      .slice(0, 2000)
    : []
);

const hasExactZoneGeometry = (zone = {}) => (
  finiteNumber(zone?.lat) != null &&
  finiteNumber(zone?.lng) != null &&
  Number(zone?.radius_m) > 0
);

const hasCellZoneGeometry = (zone = {}) => normalizePrivacyCellHashes(zone).length > 0;

const normalizePrivacyZones = (zones = []) => (
  Array.isArray(zones)
    ? zones
      .map((zone) => {
        const radiusM = Math.max(50, Math.min(1000, Number(zone?.radius_m) || 150));
        const base = {
          id: String(zone?.id || `pz_${Date.now().toString(36)}`),
          label: String(zone?.label || 'Private place').trim() || 'Private place',
          radius_m: radiusM,
          exclude_from_osrm: zone?.exclude_from_osrm !== false,
          privacy_cell_schema: zone?.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
          privacy_cell_size_m: Number(zone?.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
          privacy_cell_hashes: normalizePrivacyCellHashes(zone),
          masked_for_privacy: zone?.masked_for_privacy === true,
        };
        if (hasExactZoneGeometry({ ...zone, radius_m: radiusM })) {
          const withGeometry = {
            ...base,
            lat: Number(zone.lat),
            lng: Number(zone.lng),
          };
          return {
            ...withGeometry,
            privacy_cell_schema: PRIVACY_CELL_SCHEMA,
            privacy_cell_size_m: PRIVACY_CELL_SIZE_M,
            privacy_cell_hashes: createPrivacyCellHashes(withGeometry),
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
    radius_m: Math.max(50, Math.min(1000, Number(zone.radius_m) || 150)),
    exclude_from_osrm: zone.exclude_from_osrm !== false,
    masked_for_privacy: true,
  }))
);

const cellOnlyPrivacyZones = (zones = []) => (
  normalizePrivacyZones(zones).map((zone) => ({
    id: zone.id,
    label: zone.label,
    radius_m: zone.radius_m,
    exclude_from_osrm: zone.exclude_from_osrm !== false,
    privacy_cell_schema: zone.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
    privacy_cell_size_m: Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
    privacy_cell_hashes: normalizePrivacyCellHashes(zone),
    masked_for_privacy: true,
  }))
);

export function getPrivacyZones(settings = localSettings.get()) {
  const settingsZones = normalizePrivacyZones(settings?.privacy_zones);
  if (settingsZones.length) {
    privacyZonesMemory = settingsZones;
    return settingsZones;
  }
  if (Array.isArray(settings?.privacy_zones) && settings.privacy_zones.length === 0) return [];
  return Array.isArray(privacyZonesMemory) ? privacyZonesMemory : [];
}

export async function getHydratedPrivacyZones(settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (zones.length) return zones;
  if (!Array.isArray(settings?.privacy_zones) || settings.privacy_zones.length === 0) return [];

  const secureZones = normalizePrivacyZones(await getEncryptedJson(PRIVACY_ZONES_SECURE_KEY, []));
  if (secureZones.length) privacyZonesMemory = secureZones;
  return secureZones;
}

async function persistPrivacyZones(zones = []) {
  const normalized = normalizePrivacyZones(zones);
  privacyZonesMemory = normalized;
  await setEncryptedJson(PRIVACY_ZONES_SECURE_KEY, cellOnlyPrivacyZones(normalized));
  await syncZonesToNative(normalized);
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
  }

  if (legacyPlaintextZones.length || JSON.stringify(settings?.privacy_zones || []) !== JSON.stringify(redactedPrivacyZones(zones))) {
    localSettings.update({ privacy_zones: redactedPrivacyZones(zones) });
  }

  return zones;
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
        privacy_cell_schema: zone.privacy_cell_schema || PRIVACY_CELL_SCHEMA,
        privacy_cell_size_m: Number(zone.privacy_cell_size_m) || PRIVACY_CELL_SIZE_M,
        privacy_cell_hashes: normalizePrivacyCellHashes(zone),
      }));

    if (zoneCount > 0 && nativeZones.length === 0) {
      throw new Error('No privacy-zone cell guard is available for native sync.');
    }

    const encryptedNativeZones = await encryptSensitiveValue(nativeZones, NATIVE_PRIVACY_ZONES_CONTEXT);
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.set({
      key: NATIVE_PRIVACY_ZONES_KEY,
      value: JSON.stringify(encryptedNativeZones),
    });
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

export function createPrivacyCellHashes(zone = {}, cellSizeM = PRIVACY_CELL_SIZE_M) {
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

export function getPrivacyZoneDisplayCircle(zone, offsetM = DISPLAY_CIRCLE_OFFSET_M) {
  const lat = finiteNumber(zone?.lat);
  const lng = finiteNumber(zone?.lng);
  if (lat == null || lng == null) return null;

  const safeOffsetM = Math.max(1, finiteNumber(offsetM) ?? DISPLAY_CIRCLE_OFFSET_M);
  const angle = (hashCode(zone?.id || zone?.label) % 62832) / 10000;
  const latitudeCosine = Math.max(0.01, Math.abs(Math.cos(lat * Math.PI / 180)));
  const dLat = (safeOffsetM * Math.cos(angle)) / 111320;
  const dLng = (safeOffsetM * Math.sin(angle)) / (111320 * latitudeCosine);
  const radiusM = Math.max(50, Math.min(1000, finiteNumber(zone?.radius_m) ?? 150));

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
    if (!hasExactZoneGeometry(zone)) {
      if (hasCellZoneGeometry(zone)) cellOnlyZones.push(zone);
      continue;
    }
    const radius = Number(zone?.radius_m || 150) + guardM;
    const depth = radius - distanceM(point, zone);
    if (depth >= 0 && depth > bestDepth) {
      bestZone = zone;
      bestDepth = depth;
    }
  }

  return bestZone || findCellPrivacyZoneForPoint(point, cellOnlyZones);
}

export function isInsidePrivacyZone(lat, lng, zones = getPrivacyZones()) {
  return Boolean(isPointInPrivacyZone({ lat, lng }, zones));
}

export function redactRoutePointForPrivacyStorage(point = {}, zones = getPrivacyZones(), guardM = 0) {
  const zone = isPointInPrivacyZone(point, zones, guardM);
  if (!zone) return point;

  return redactCoordinateFieldsForPrivacy(point, zone, {
    privacy_gap: true,
    privacy_live_redacted: true,
    timestamp: point?.timestamp ?? point?.time ?? new Date().toISOString(),
    speed_kmh: point?.speed_kmh ?? point?.speed ?? null,
  });
}

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
  } = value || {};

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

  const aRadius = Math.max(50, Math.min(1000, finiteNumber(a.radius_m) ?? 150));
  const bRadius = Math.max(50, Math.min(1000, finiteNumber(b.radius_m) ?? 150));
  const d = distanceM(a, b);
  const base = {
    id: `pz_merge_${Date.now().toString(36)}`,
    label: `${a.label || 'Zone'} + ${b.label || 'Zone'}`,
    exclude_from_osrm: a.exclude_from_osrm !== false && b.exclude_from_osrm !== false,
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
  lat: null,
  lng: null,
  timestamp: point?.timestamp ?? point?.time ?? null,
  masked_for_privacy: true,
  privacy_purged: true,
  privacy_zone_id: zone.id,
  privacy_zone_label: zone.label,
});

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

  for (const trip of Array.isArray(trips) ? trips : []) {
    const result = purgeTripGpsWithinPrivacyZone(trip, zone);
    if (!result.changed) continue;

    tripsAffected += 1;
    pointsPurged += result.purgedPoints;
    eventsPurged += result.purgedEvents;
    tripIdsAffected.push(trip.id);
    if (typeof updateTrip === 'function') {
      await updateTrip(trip.id, {
        route_points: result.trip.route_points,
        route_points_raw_count: result.trip.route_points_raw_count,
        route_points_map_count: result.trip.route_points_map_count,
        driving_events: result.trip.driving_events,
        privacy_purged_zone_ids: result.trip.privacy_purged_zone_ids,
        privacy_purged_at: result.trip.privacy_purged_at,
        needs_rescore: result.trip.needs_rescore,
      });
    }
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
  const radius = Number(zone.radius_m || 150);
  let low = 0;
  let high = 1;
  let mid = 1;

  for (let i = 0; i < 24; i++) {
    mid = (low + high) / 2;
    const candidate = {
      lat: interpolateValue(insidePoint.lat, outsidePoint.lat, mid),
      lng: interpolateValue(insidePoint.lng, outsidePoint.lng, mid),
    };
    if (distanceM(candidate, zone) <= radius) low = mid;
    else high = mid;
  }

  const ratio = high;
  const lat = interpolateValue(insidePoint.lat, outsidePoint.lat, ratio);
  const lng = interpolateValue(insidePoint.lng, outsidePoint.lng, ratio);
  if (lat == null || lng == null) return null;

  return {
    ...outsidePoint,
    lat,
    lng,
    speed_kmh: interpolateValue(insidePoint.speed_kmh, outsidePoint.speed_kmh, ratio) ?? outsidePoint.speed_kmh,
    heading: interpolateValue(insidePoint.heading, outsidePoint.heading, ratio) ?? outsidePoint.heading,
    bearing: interpolateValue(insidePoint.bearing, outsidePoint.bearing, ratio) ?? outsidePoint.bearing,
    accuracy: interpolateValue(insidePoint.accuracy, outsidePoint.accuracy, ratio) ?? outsidePoint.accuracy,
    timestamp: interpolateTimestamp(insidePoint, outsidePoint, ratio),
    ...privacyMetadata(zone, true),
  };
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
  masked.push({
    lat: null,
    lng: null,
    timestamp: point?.timestamp ?? point?.time ?? null,
    speed_kmh: point?.speed_kmh ?? point?.speed ?? null,
    masked_for_privacy: true,
    privacy_gap: true,
    privacy_zone_id: zone?.id || 'privacy-zone',
    privacy_zone_label: zone?.label || 'Private place',
  });
};

export function maskRoutePointsForPrivacy(routePoints = [], settings = localSettings.get()) {
  // Display/export masking only. Scoring that depends on continuous movement
  // windows, including intersection-stop behavior, should run before this on
  // raw local points and persist aggregate scores rather than private coords.
  const zones = getPrivacyZones(settings);
  if (!zones.length) return routePoints;

  const masked = [];
  const points = Array.isArray(routePoints) ? routePoints : [];
  points.forEach((point, index) => {
    const zone = isPointInPrivacyZone(point, zones);
    const previous = index > 0 ? points[index - 1] : null;
    const previousZone = previous ? isPointInPrivacyZone(previous, zones) : null;

    if (!zone && previousZone) {
      if (hasExactZoneGeometry(previousZone)) pushBoundary(masked, previous, point, previousZone);
    }

    if (!zone) {
      masked.push(point);
      return;
    }

    if (previous && !previousZone) {
      if (hasExactZoneGeometry(zone)) pushBoundary(masked, point, previous, zone);
      else pushPrivacyGap(masked, point, zone);
      return;
    }

    if (!hasExactZoneGeometry(zone)) {
      pushPrivacyGap(masked, point, zone);
    }
  });

  const hiddenCount = points.length - masked.filter((point) => !point?.privacy_boundary).length;
  if (hiddenCount > 0) {
    recordSystemEvent('privacy_route_masked', {
      route_point_count: points.length,
      hidden_point_count: hiddenCount,
      privacy_zone_count: zones.length,
    }, { category: 'privacy', title: 'Privacy zone masked route points' });
  }
  return masked;
}

const stripExportBoundaryGeometry = (point = {}) => {
  const {
    radius,
    radius_m,
    source_radius_m,
    zone_radius_m,
    privacy_radius_m,
    privacy_zone_radius_m,
    ...rest
  } = point;
  return rest;
};

export function addExportNoiseToPrivacyBoundaries(routePoints = [], exportSalt = createPrivacyExportSalt()) {
  return (Array.isArray(routePoints) ? routePoints : []).map((point, index) => {
    if (!point?.privacy_boundary) return point;
    const boundary = stripExportBoundaryGeometry(point);
    const noisy = addExportNoise(
      boundary.lat,
      boundary.lng,
      boundary.privacy_zone_id || boundary.zone_id || 'privacy-zone',
      exportSalt,
      `${index}:${boundary.timestamp || boundary.time || ''}`
    );
    return {
      ...boundary,
      lat: noisy.lat,
      lng: noisy.lng,
      export_noised_for_privacy: true,
    };
  });
}

export function replacePrivacyBoundariesWithExportGaps(routePoints = []) {
  const output = [];
  (Array.isArray(routePoints) ? routePoints : []).forEach((point) => {
    if (!point?.privacy_boundary) {
      output.push(point);
      return;
    }

    const previous = output.at(-1);
    const zoneId = point.privacy_zone_id || point.zone_id || 'privacy-zone';
    if (previous?.privacy_export_placeholder && previous.privacy_zone_id === zoneId) return;

    output.push({
      lat: null,
      lng: null,
      timestamp: point.timestamp ?? point.time ?? null,
      masked_for_privacy: true,
      privacy_gap: true,
      privacy_export_placeholder: true,
      privacy_zone_id: zoneId,
      privacy_zone_label: point.privacy_zone_label || point.zone_label || 'Private place',
    });
  });
  return output;
}

export function maskRoutePointsForPrivacyExport(routePoints = [], settings = localSettings.get(), exportSalt = createPrivacyExportSalt()) {
  return replacePrivacyBoundariesWithExportGaps(maskRoutePointsForPrivacy(routePoints, settings), exportSalt);
}

export function maskEventsForPrivacy(events = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return events;
  const filtered = events.filter((event) => !shouldMaskEventForPrivacy(event, zones));
  const hiddenCount = events.length - filtered.length;
  if (hiddenCount > 0) {
    recordSystemEvent('privacy_events_masked', {
      event_count: events.length,
      hidden_event_count: hiddenCount,
      privacy_zone_count: zones.length,
    }, { category: 'privacy', title: 'Privacy zone masked driving events' });
  }
  return filtered;
}

export function maskTripForPrivacy(trip = {}, settings = localSettings.get()) {
  return {
    ...trip,
    route_points: maskRoutePointsForPrivacy(Array.isArray(trip.route_points) ? trip.route_points : [], settings),
    driving_events: maskEventsForPrivacy(Array.isArray(trip.driving_events) ? trip.driving_events : [], settings),
    start_address: trip.start_address && isPointInPrivacyZone((trip.route_points || [])[0], getPrivacyZones(settings)) ? null : trip.start_address,
    end_address: trip.end_address && isPointInPrivacyZone((trip.route_points || []).at?.(-1), getPrivacyZones(settings)) ? null : trip.end_address,
  };
}

export function maskTripForPrivacyExport(trip = {}, settings = localSettings.get(), exportSalt = createPrivacyExportSalt()) {
  const masked = maskTripForPrivacy(trip, settings);
  return {
    ...masked,
    route_points: replacePrivacyBoundariesWithExportGaps(
      Array.isArray(masked.route_points) ? masked.route_points : [],
      exportSalt
    ),
  };
}

export async function upsertPrivacyZone(zone, settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  const proposed = {
    id: zone.id || `pz_${Date.now().toString(36)}`,
    label: String(zone.label || 'Private place').trim() || 'Private place',
    radius_m: Math.max(50, Math.min(1000, Number(zone.radius_m) || 150)),
    exclude_from_osrm: zone.exclude_from_osrm !== false,
    ...(finiteNumber(zone.lat) != null && finiteNumber(zone.lng) != null ? {
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
    throw new Error('Re-add this privacy zone to change its radius because the exact center is no longer stored.');
  }
  const normalized = normalizePrivacyZones([proposed])[0];
  if (!normalized) throw new Error('Privacy zone needs a location before it can be saved.');
  const zoneChanged = !previous ||
    previous.lat !== normalized.lat ||
    previous.lng !== normalized.lng ||
    previous.radius_m !== normalized.radius_m ||
    previous.exclude_from_osrm !== normalized.exclude_from_osrm ||
    JSON.stringify(previous.privacy_cell_hashes || []) !== JSON.stringify(normalized.privacy_cell_hashes || []);
  const next = zones.filter((item) => item.id !== normalized.id).concat(normalized);
  const consentInvalidated = zoneChanged && settings.osrm_data_sharing_consented === true;
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
  recordSystemEvent('privacy_zone_saved', {
    zone_id: normalized.id,
    label: normalized.label,
    radius_m: normalized.radius_m,
    zone_count: next.length,
  }, { category: 'privacy', title: 'Privacy zone saved' });
  if (consentInvalidated) {
    recordSystemEvent('osrm_consent_invalidated', {
      reason: 'privacy_zone_changed',
      zone_id: normalized.id,
      zone_label: normalized.label,
    }, { category: 'osrm', severity: 'warn', title: 'OSRM consent needs review' });
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
  return updated;
}
