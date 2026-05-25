import { getJson, setJson } from '@/lib/mobileStorage';
import { haversineDistance } from '@/lib/tripEngine';
import { withRetry } from '@/lib/retry';

const SPEED_LIMIT_CACHE_KEY = 'drivesense_osm_speed_limit_cache_v2';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FALLBACK_OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
];
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BBOX_SPAN_DEG = 0.8;
const MAX_GEOMETRY_POINTS = 900;
const DIRECT_BBOX_SPAN_DEG = 0.08;
const MAX_CORRIDOR_QUERIES = 6;
const MAX_CORRIDOR_SAMPLE_POINTS = 180;
const CORRIDOR_PAD_DEG = 0.006;
export const DEFAULT_SPEED_LIMIT_COUNTRY = 'global';
export const OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH = Object.freeze({
  global: Object.freeze({
    living_street: 20,
    service: 30,
    residential: 40,
    unclassified: 50,
    road: 50,
    tertiary: 50,
    tertiary_link: 50,
    secondary: 60,
    secondary_link: 60,
    primary: 60,
    primary_link: 60,
    trunk_link: 80,
    motorway_link: 80,
    trunk: 100,
    motorway: 100,
  }),
  gb: Object.freeze({
    residential: 48,
    unclassified: 48,
    road: 48,
    trunk: 113,
    motorway: 113,
  }),
  uk: Object.freeze({
    residential: 48,
    unclassified: 48,
    road: 48,
    trunk: 113,
    motorway: 113,
  }),
  us: Object.freeze({
    motorway: 113,
    trunk: 105,
    motorway_link: 89,
    trunk_link: 89,
    residential: 40,
  }),
  ca: Object.freeze({
    motorway: 100,
    trunk: 90,
    residential: 40,
  }),
});

const round = (value, places = 4) => Number(value).toFixed(places);

export function parseMaxspeedKmh(value) {
  if (value == null) return null;
  const raw = String(value).toLowerCase().trim();
  if (!raw || ['none', 'signals', 'walk', 'variable'].includes(raw)) return null;
  const mph = raw.includes('mph');
  const match = raw.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(mph ? parsed * 1.60934 : parsed);
}

function routeBounds(points = [], pad = 0.01) {
  const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!valid.length) return null;
  const lats = valid.map((point) => point.lat);
  const lngs = valid.map((point) => point.lng);
  return {
    south: Math.min(...lats) - pad,
    west: Math.min(...lngs) - pad,
    north: Math.max(...lats) + pad,
    east: Math.max(...lngs) + pad,
  };
}

function cacheKeyForBounds(bounds) {
  return [
    round(bounds.south, 2),
    round(bounds.west, 2),
    round(bounds.north, 2),
    round(bounds.east, 2),
  ].join(',');
}

export function speedLimitDefaultCountryKey(settings = {}) {
  const raw = typeof settings === 'string'
    ? settings
    : settings?.configurable_country_defaults ?? settings?.speed_limit_default_country ?? DEFAULT_SPEED_LIMIT_COUNTRY;
  const value = String(raw || DEFAULT_SPEED_LIMIT_COUNTRY).toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH, value)
    ? value
    : DEFAULT_SPEED_LIMIT_COUNTRY;
}

export function speedLimitDefaultsForCountry(settings = {}) {
  const country = speedLimitDefaultCountryKey(settings);
  return {
    ...OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH.global,
    ...(OSM_HIGHWAY_DEFAULT_SPEED_LIMITS_KMH[country] || {}),
  };
}

function bboxSpan(bounds) {
  return {
    lat: bounds ? bounds.north - bounds.south : 0,
    lng: bounds ? bounds.east - bounds.west : 0,
  };
}

function uniqueBy(items = [], keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sampleRoutePoints(points = [], maxPoints = MAX_CORRIDOR_SAMPLE_POINTS) {
  const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (valid.length <= maxPoints) return valid;
  const step = (valid.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => valid[Math.round(index * step)]);
}

function corridorBounds(routePoints = []) {
  const sampled = sampleRoutePoints(routePoints);
  if (!sampled.length) return [];
  const chunkSize = Math.max(8, Math.ceil(sampled.length / MAX_CORRIDOR_QUERIES));
  const chunks = [];
  for (let start = 0; start < sampled.length; start += chunkSize) {
    const end = Math.min(sampled.length, start + chunkSize + 1);
    const bounds = routeBounds(sampled.slice(start, end), CORRIDOR_PAD_DEG);
    if (bounds) chunks.push(bounds);
  }
  return uniqueBy(chunks, cacheKeyForBounds);
}

function overpassQuery(bounds) {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `
    [out:json][timeout:25];
    (
      way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${bbox});
    );
    out tags geom;
  `;
}

async function fetchOverpassWays(bounds, settings = {}) {
  const urls = uniqueBy([
    settings.overpass_speed_limit_url,
    OVERPASS_URL,
    ...FALLBACK_OVERPASS_URLS,
  ].filter(Boolean), (url) => url);
  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchOverpassWaysFromUrl(bounds, url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Overpass request failed');
}

async function fetchOverpassWaysFromUrl(bounds, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await withRetry(`overpass-speed-limit:${url}`, () => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: overpassQuery(bounds) }),
      signal: controller.signal,
    }));
    if (!response.ok) throw new Error(`Overpass request failed (${response.status})`);
    const data = await response.json();
    return Array.isArray(data?.elements) ? data.elements : [];
  } finally {
    clearTimeout(timeout);
  }
}

async function loadCachedWaysForBounds(bounds, settings, cache, nextCache) {
  const defaultCountry = speedLimitDefaultCountryKey(settings);
  const key = `${cacheKeyForBounds(bounds)}:${defaultCountry}`;
  const cached = cache[key];
  if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
    return { ways: cached.ways || [], status: 'cache_hit', error: null };
  }
  try {
    const ways = normalizeWays(await fetchOverpassWays(bounds, settings), settings);
    nextCache[key] = { savedAt: Date.now(), ways };
    return { ways, status: ways.length ? 'fetched' : 'no_tagged_ways', error: null };
  } catch (error) {
    return {
      ways: [],
      status: 'unavailable',
      error: error?.name === 'AbortError' ? 'OpenStreetMap speed-limit lookup timed out.' : error?.message,
    };
  }
}

export function defaultSpeedLimitKmhForOsmHighway(highway, settings = {}) {
  const value = String(highway || '').toLowerCase().trim();
  if (!value) return null;
  return speedLimitDefaultsForCountry(settings)[value] ?? null;
}

function normalizeWays(elements = [], settings = {}) {
  const defaultCountry = speedLimitDefaultCountryKey(settings);
  return elements
    .map((element) => {
      const taggedLimitKmh = parseMaxspeedKmh(
        element.tags?.maxspeed ?? element.tags?.['maxspeed:forward'] ?? element.tags?.['maxspeed:backward']
      );
      const highway = element.tags?.highway || null;
      const defaultLimitKmh = taggedLimitKmh ? null : defaultSpeedLimitKmhForOsmHighway(highway, settings);
      const limitKmh = taggedLimitKmh ?? defaultLimitKmh;
      const geometry = Array.isArray(element.geometry)
        ? element.geometry
          .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
          .slice(0, MAX_GEOMETRY_POINTS)
          .map((point) => ({ lat: point.lat, lng: point.lon }))
        : [];
      if (!limitKmh || geometry.length < 2) return null;
      return {
        id: element.id,
        limitKmh,
        limitSource: taggedLimitKmh ? 'openstreetmap' : 'osm_highway_default',
        limitDefaultCountry: taggedLimitKmh ? null : defaultCountry,
        highway,
        name: element.tags?.name || element.tags?.ref || null,
        geometry,
      };
    })
    .filter(Boolean);
}

function pointToSegmentDistanceM(point, start, end) {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((Number(point.lat) || 0) * Math.PI / 180);
  const px = point.lng * lngScale;
  const py = point.lat * latScale;
  const ax = start.lng * lngScale;
  const ay = start.lat * latScale;
  const bx = end.lng * lngScale;
  const by = end.lat * latScale;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return haversineDistance(point.lat, point.lng, start.lat, start.lng) * 1000;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const nearestX = ax + t * dx;
  const nearestY = ay + t * dy;
  return Math.sqrt((px - nearestX) ** 2 + (py - nearestY) ** 2);
}

function nearestWayLimit(point, ways = [], maxDistanceM = 75) {
  let best = null;
  for (const way of ways) {
    for (let i = 1; i < way.geometry.length; i++) {
      const prev = way.geometry[i - 1];
      const curr = way.geometry[i];
      const distanceM = pointToSegmentDistanceM(point, prev, curr);
      if (distanceM <= maxDistanceM && (!best || distanceM < best.distanceM)) {
        best = { ...way, distanceM };
      }
    }
  }
  return best;
}

export async function loadOsmSpeedLimitWays(routePoints = [], settings = {}) {
  if (settings.speed_limit_lookup_enabled === false) {
    return { ways: [], status: 'disabled', source: 'openstreetmap_overpass' };
  }
  const bounds = routeBounds(routePoints);
  if (!bounds) return { ways: [], status: 'empty_route', source: 'openstreetmap_overpass' };
  if ((bounds.north - bounds.south) > MAX_BBOX_SPAN_DEG || (bounds.east - bounds.west) > MAX_BBOX_SPAN_DEG) {
    return { ways: [], status: 'bbox_too_large', source: 'openstreetmap_overpass' };
  }

  const cache = await getJson(SPEED_LIMIT_CACHE_KEY, {});
  const nextCache = { ...cache };
  const span = bboxSpan(bounds);
  const queryBounds = span.lat <= DIRECT_BBOX_SPAN_DEG && span.lng <= DIRECT_BBOX_SPAN_DEG
    ? [bounds]
    : corridorBounds(routePoints);

  if (!queryBounds.length) {
    return { ways: [], status: 'empty_route', source: 'openstreetmap_overpass' };
  }

  const results = await Promise.all(queryBounds.map((item) => loadCachedWaysForBounds(item, settings, cache, nextCache)));
  await setJson(SPEED_LIMIT_CACHE_KEY, nextCache);

  const ways = uniqueBy(results.flatMap((result) => result.ways), (way) => `${way.id}:${way.limitKmh}`);
  const failures = results.filter((result) => result.status === 'unavailable');
  const cacheHits = results.filter((result) => result.status === 'cache_hit');
  const fetched = results.filter((result) => result.status === 'fetched');
  const noTags = results.filter((result) => result.status === 'no_tagged_ways');
  const error = failures.map((result) => result.error).find(Boolean) || null;

  if (ways.length) {
    return {
      ways,
      status: failures.length ? 'partial_fetched' : cacheHits.length && !fetched.length ? 'cache_hit' : 'fetched',
      source: 'openstreetmap_overpass',
      query_count: queryBounds.length,
      error,
    };
  }
  if (failures.length === results.length) {
    return { ways: [], status: 'unavailable', source: 'openstreetmap_overpass', query_count: queryBounds.length, error };
  }
  return {
    ways: [],
    status: noTags.length || cacheHits.length ? 'no_tagged_ways' : 'unavailable',
    source: 'openstreetmap_overpass',
    query_count: queryBounds.length,
    error,
  };
}

export async function annotateRouteSpeedLimits(routePoints = [], settings = {}) {
  try {
    const result = await loadOsmSpeedLimitWays(routePoints, settings);
    if (!result.ways.length) {
      return {
        routePoints,
        coverage: 0,
        status: result.status,
        source: result.source,
        query_count: result.query_count,
        error: result.error,
      };
    }

    let matched = 0;
    const annotated = routePoints.map((point) => {
      if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return point;
      const match = nearestWayLimit(point, result.ways);
      if (!match) return point;
      matched++;
      return {
        ...point,
        speed_limit_kmh: match.limitKmh,
        speed_limit_source: match.limitSource,
        speed_limit_default_country: match.limitDefaultCountry,
        speed_limit_way_id: match.id,
        speed_limit_road_name: match.name,
        speed_limit_highway: match.highway,
      };
    });

    return {
      routePoints: annotated,
      coverage: routePoints.length ? Math.round((matched / routePoints.length) * 100) : 0,
      status: result.status,
      source: result.source,
      query_count: result.query_count,
      error: result.error,
    };
  } catch (error) {
    return {
      routePoints,
      coverage: 0,
      status: 'unavailable',
      source: 'openstreetmap_overpass',
      error: error?.message || 'Speed limit lookup unavailable',
    };
  }
}
