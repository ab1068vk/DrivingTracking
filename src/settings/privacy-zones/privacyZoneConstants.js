export const ZONE_RADIUS_MIN_M = 50;
export const ZONE_RADIUS_MAX_M = 500;
export const ZONE_RADIUS_DEFAULT_M = 200;

export const EMPTY_ZONE_DRAFT = Object.freeze({
  name: '',
  lat: null,
  lng: null,
  radius: ZONE_RADIUS_DEFAULT_M,
  locating: false,
});

export function clampZoneRadius(radius) {
  const value = Number(radius);
  if (!Number.isFinite(value)) return ZONE_RADIUS_DEFAULT_M;
  return Math.max(ZONE_RADIUS_MIN_M, Math.min(ZONE_RADIUS_MAX_M, Math.round(value)));
}

export function createZoneDraft(zone = null) {
  if (!zone) return { ...EMPTY_ZONE_DRAFT };
  return {
    name: String(zone.name || ''),
    lat: Number.isFinite(Number(zone.lat)) ? Number(zone.lat) : null,
    lng: Number.isFinite(Number(zone.lng)) ? Number(zone.lng) : null,
    radius: clampZoneRadius(zone.radius),
    locating: false,
  };
}

export function zoneFromDraft(draft) {
  return {
    name: String(draft.name || '').trim(),
    lat: Number(draft.lat),
    lng: Number(draft.lng),
    radius: clampZoneRadius(draft.radius),
  };
}
