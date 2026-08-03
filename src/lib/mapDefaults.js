const validCoordinate = (lat, lng) => {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  return Number.isFinite(parsedLat) &&
    Number.isFinite(parsedLng) &&
    parsedLat >= -90 &&
    parsedLat <= 90 &&
    parsedLng >= -180 &&
    parsedLng <= 180
    ? { lat: parsedLat, lng: parsedLng }
    : null;
};

export const configuredMapCenter = () => validCoordinate(
  import.meta.env.VITE_DEFAULT_MAP_LAT,
  import.meta.env.VITE_DEFAULT_MAP_LNG
);

// Preserves the existing deployment behavior when an older build has not yet
// provided environment configuration. New deployments should set both values.
const LEGACY_DEPLOYMENT_FALLBACK = Object.freeze({ lat: 43.6532, lng: -79.3832 });

export const DEFAULT_MAP_CENTER = Object.freeze(
  configuredMapCenter() || LEGACY_DEPLOYMENT_FALLBACK
);
export const DEFAULT_MAP_CENTER_ARRAY = Object.freeze([
  DEFAULT_MAP_CENTER.lat,
  DEFAULT_MAP_CENTER.lng,
]);
