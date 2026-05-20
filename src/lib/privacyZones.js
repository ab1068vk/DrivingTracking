import { localSettings } from '@/lib/trackingStore';

const EARTH_RADIUS_M = 6371000;

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

export function getPrivacyZones(settings = localSettings.get()) {
  return Array.isArray(settings.privacy_zones)
    ? settings.privacy_zones.filter((zone) => (
      Number.isFinite(Number(zone.lat)) &&
      Number.isFinite(Number(zone.lng)) &&
      Number(zone.radius_m) > 0
    ))
    : [];
}

export function isPointInPrivacyZone(point, zones = getPrivacyZones()) {
  if (finiteNumber(point?.lat) == null || finiteNumber(point?.lng) == null) return null;
  return zones.find((zone) => distanceM(point, zone) <= Number(zone.radius_m || 150)) || null;
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

export function maskRoutePointsForPrivacy(routePoints = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return routePoints;

  const masked = [];
  const points = Array.isArray(routePoints) ? routePoints : [];
  points.forEach((point, index) => {
    const zone = isPointInPrivacyZone(point, zones);
    const previous = index > 0 ? points[index - 1] : null;
    const previousZone = previous ? isPointInPrivacyZone(previous, zones) : null;

    if (!zone && previousZone) {
      pushBoundary(masked, previous, point, previousZone);
    }

    if (!zone) {
      masked.push(point);
      return;
    }

    if (previous && !previousZone) {
      pushBoundary(masked, point, previous, zone);
    }
  });

  return masked;
}

export function maskEventsForPrivacy(events = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return events;
  return events.filter((event) => !isPointInPrivacyZone(event, zones));
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

export function upsertPrivacyZone(zone, settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  const normalized = {
    id: zone.id || `pz_${Date.now().toString(36)}`,
    label: String(zone.label || 'Private place').trim() || 'Private place',
    lat: Number(zone.lat),
    lng: Number(zone.lng),
    radius_m: Math.max(50, Math.min(1000, Number(zone.radius_m) || 150)),
  };
  const next = zones.filter((item) => item.id !== normalized.id).concat(normalized);
  return localSettings.update({ privacy_zones: next });
}

export function removePrivacyZone(id, settings = localSettings.get()) {
  const next = getPrivacyZones(settings).filter((zone) => zone.id !== id);
  return localSettings.update({ privacy_zones: next });
}
