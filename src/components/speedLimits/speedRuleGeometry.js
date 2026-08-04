// @ts-check
// Road-section geometry helpers extracted verbatim from
// src/pages/SpeedLimits.jsx. Pure math over {lat, lng} point lists.

export const normalizePointForCompare = (point = {}) => {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) }
    : null;
};

export const normalizeSectionPointsForCompare = (section = {}) => {
  const points = Array.isArray(section.sectionPoints) && section.sectionPoints.length
    ? section.sectionPoints
    : [section];
  return points
    .map(normalizePointForCompare)
    .filter(Boolean);
};

export const sectionGeometryCompareKey = (section = {}) => JSON.stringify(normalizeSectionPointsForCompare(section));

export const hasTracedRoadGeometry = (section = {}) => {
  const points = (Array.isArray(section.sectionPoints) ? section.sectionPoints : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => (
      Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 &&
      Number.isFinite(point.lng) && point.lng >= -180 && point.lng <= 180
    ));
  if (points.length < 2) return false;
  const first = points[0];
  return points.some((point) => point.lat !== first.lat || point.lng !== first.lng);
};

/**
 * `Number(null)`, `Number('')` and `Number([])` are all 0, so a redacted or
 * absent coordinate would otherwise read as a real position at 0,0 instead of
 * as missing data. Only an actual number or a non-blank numeric string counts.
 * @param {unknown} value
 * @returns {number} the coordinate, or NaN when there isn't a usable one
 */
const coordinate = (value) => (
  typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value)
    : NaN
);

export const distanceMeters = (a, b) => {
  const lat1 = coordinate(a?.lat) * Math.PI / 180;
  const lat2 = coordinate(b?.lat) * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (coordinate(b?.lng) - coordinate(a?.lng)) * Math.PI / 180;
  if (![lat1, lat2, dLat, dLng].every(Number.isFinite)) return Infinity;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
};

export const sectionLengthMeters = (points = []) => points.reduce((sum, point, index) => (
  index === 0 ? 0 : sum + distanceMeters(points[index - 1], point)
), 0);

export const sectionMidpoint = (points = []) => {
  const clean = (Array.isArray(points) ? points : [])
    .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  return clean[Math.floor(clean.length / 2)] || null;
};
