// v3 keeps complete driven-road geometry; v2 could contain the removed
// 14-day pruning and overly fragmented estimate sections.
const CACHE_VERSION = 3;
let memoryCache = null;

const geometryIdentity = (item = {}) => {
  const points = item.route_points || item.sectionPoints || [];
  if (!Array.isArray(points) || !points.length) return 'no-geometry';
  const indexes = [...new Set([
    0,
    Math.floor((points.length - 1) / 4),
    Math.floor((points.length - 1) / 2),
    Math.floor((points.length - 1) * 3 / 4),
    points.length - 1,
  ])];
  return indexes.map((index) => {
    const point = points[index] || {};
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    return Number.isFinite(lat) && Number.isFinite(lng)
      ? `${lat.toFixed(5)},${lng.toFixed(5)}`
      : 'invalid';
  }).join(';');
};

const itemIdentity = (item = {}, kind = 'item') => [
  kind,
  item.id ?? item.ruleId ?? item.sectionKey ?? item.geohash ?? '',
  item.updated_at ?? item.updatedAt ?? item.appliedAt ?? item.lastUpdatedAt ?? '',
  item.status ?? item.stage ?? item.source ?? '',
  item.route_points?.length ?? item.sectionPoints?.length ?? 0,
  geometryIdentity(item),
  item.limitKmh ?? item.speed_limit_kmh ?? '',
  item.directionMode ?? '',
  Number.isFinite(Number(item.directionBearing)) ? Math.round(Number(item.directionBearing)) : '',
  item.timeRule?.enabled === true
    ? `${(item.timeRule.days || []).join(',')}:${item.timeRule.startMinutes ?? ''}:${item.timeRule.endMinutes ?? ''}`
    : 'always',
  item.active === true ? 'active' : 'inactive',
  Number.isFinite(Number(item.confidence)) ? Number(item.confidence).toFixed(3) : '',
].join(':');

const hashText = (text = '') => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export function buildSpeedMapModelCacheKey(trips = [], corrections = [], candidates = []) {
  const signature = [
    `v${CACHE_VERSION}`,
    ...(trips || []).map((item) => itemIdentity(item, 'trip')),
    ...(corrections || []).map((item) => itemIdentity(item, 'rule')),
    ...(candidates || []).map((item) => itemIdentity(item, 'memory')),
  ].join('|');
  return `${trips.length}:${corrections.length}:${candidates.length}:${hashText(signature)}`;
}

export function readSpeedMapModelCache(key) {
  if (!key || memoryCache?.key !== key) return null;
  return memoryCache.sections;
}

export function writeSpeedMapModelCache(key, sections = []) {
  if (!key || !Array.isArray(sections)) return;
  memoryCache = { key, sections };
}

export function clearSpeedMapModelCache() {
  memoryCache = null;
}
