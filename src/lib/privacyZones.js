import { localSettings } from '@/lib/trackingStore';

const EARTH_RADIUS_M = 6371000;

function distanceM(a, b) {
  const toRad = (value) => value * Math.PI / 180;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLng = toRad(Number(b.lng) - Number(a.lng));
  const lat1 = toRad(Number(a.lat));
  const lat2 = toRad(Number(b.lat));
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

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
  if (!Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lng))) return null;
  return zones.find((zone) => distanceM(point, zone) <= Number(zone.radius_m || 150)) || null;
}

export function maskRoutePointsForPrivacy(routePoints = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return routePoints;
  return routePoints.map((point) => {
    const zone = isPointInPrivacyZone(point, zones);
    if (!zone) return point;
    return {
      ...point,
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_zone_id: zone.id,
      privacy_zone_label: zone.label,
    };
  });
}

export function maskEventsForPrivacy(events = [], settings = localSettings.get()) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return events;
  return events.map((event) => {
    const zone = isPointInPrivacyZone(event, zones);
    if (!zone) return event;
    return {
      ...event,
      lat: null,
      lng: null,
      masked_for_privacy: true,
      privacy_zone_id: zone.id,
      privacy_zone_label: zone.label,
    };
  });
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
