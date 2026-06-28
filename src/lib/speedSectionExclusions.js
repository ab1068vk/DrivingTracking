export const EXCLUDED_SPEED_SECTIONS_STORAGE_KEY = 'roadsage_excluded_speed_sections_v1';

const cleanGeometry = (points = []) => (Array.isArray(points) ? points : [])
  .map((point) => ({ lat: Number(point?.lat), lng: Number(point?.lng) }))
  .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));

const roundedPointKey = (point = {}, decimals = 5) => (
  `${Number(point.lat).toFixed(decimals)},${Number(point.lng).toFixed(decimals)}`
);

const unique = (values = []) => [...new Set(values.filter(Boolean).map(String))];

export function speedSectionExclusionKeys(section = {}) {
  const points = cleanGeometry(section.sectionPoints || []);
  const stableIds = [
    section.exclusionKey,
    section.correctionId,
    section.id,
    section.ruleId,
    section.sectionKey,
  ].filter(Boolean).map((value) => `rule:${value}`);

  if (points.length >= 2) {
    const first = points[0];
    const middle = points[Math.floor(points.length / 2)];
    const last = points[points.length - 1];
    const geometryKey = `geom:${[first, middle, last].map((point) => roundedPointKey(point)).join('|')}`;
    const endpointsKey = `ends:${[first, last].map((point) => roundedPointKey(point, 4)).join('|')}`;
    return unique([...stableIds, geometryKey, endpointsKey]);
  }

  return unique(stableIds);
}

export function readExcludedSpeedSectionKeys() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? unique(parsed) : [];
  } catch {
    return [];
  }
}

export function writeExcludedSpeedSectionKeys(keys = []) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY, JSON.stringify(unique(keys).slice(-1000)));
}

export function isSpeedSectionExcluded(section = {}, excludedKeys = new Set()) {
  const keySet = excludedKeys instanceof Set ? excludedKeys : new Set(excludedKeys || []);
  if (!keySet.size) return false;
  return speedSectionExclusionKeys(section).some((key) => keySet.has(key));
}
