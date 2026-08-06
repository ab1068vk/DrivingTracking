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
  const carriedKeys = Array.isArray(section.exclusionKeys)
    ? section.exclusionKeys
    : [];
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
    return unique([...carriedKeys, ...stableIds, geometryKey, endpointsKey]);
  }

  return unique([...carriedKeys, ...stableIds]);
}

/**
 * Read the legacy exclusion cache without consuming it.
 *
 * This used to erase the cache as a side effect of reading it. The read is the
 * first step of migrating the keys into the atomic speed-knowledge store, so a
 * throw anywhere between the read and the commit destroyed the user's
 * exclusions with nothing written in their place — and an exclusion is the user
 * asking us not to learn from a private place. Erasing is now a separate,
 * explicit step for the caller to take once the migration has committed.
 */
export function readExcludedSpeedSectionKeys() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? unique(parsed) : [];
  } catch {
    // Unparseable content carries no recoverable exclusions, so dropping it
    // loses nothing and stops the same failure repeating on every read.
    window.localStorage.removeItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY);
    return [];
  }
}

/**
 * Erase the legacy cache. Call only after the keys are durably stored elsewhere.
 * The cache can hold rounded route coordinates in plaintext, so it should not
 * outlive the migration.
 */
export function clearExcludedSpeedSectionKeys() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY);
}

export function writeExcludedSpeedSectionKeys(_keys = []) {
  if (typeof window === 'undefined') return;
  // The versioned speed-knowledge repository is the source of truth. Never
  // duplicate precise geometry keys into plaintext localStorage.
  window.localStorage.removeItem(EXCLUDED_SPEED_SECTIONS_STORAGE_KEY);
}

export function isSpeedSectionExcluded(section = {}, excludedKeys = new Set()) {
  const keySet = excludedKeys instanceof Set ? excludedKeys : new Set(excludedKeys || []);
  if (!keySet.size) return false;
  return speedSectionExclusionKeys(section).some((key) => keySet.has(key));
}
