import { getJson, setJson } from '@/lib/mobileStorage';
import { haversineDistance } from '@/lib/tripEngine';

const SPEED_LIMIT_CACHE_KEY = 'drivesense_osm_speed_limit_cache_v1';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BBOX_SPAN_DEG = 0.8;
const MAX_GEOMETRY_POINTS = 900;

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

function routeBounds(points = []) {
  const valid = points.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!valid.length) return null;
  const lats = valid.map((point) => point.lat);
  const lngs = valid.map((point) => point.lng);
  const pad = 0.01;
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

function overpassQuery(bounds) {
  const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `
    [out:json][timeout:25];
    (
      way["highway"]["maxspeed"](${bbox});
      way["highway"]["maxspeed:forward"](${bbox});
      way["highway"]["maxspeed:backward"](${bbox});
    );
    out tags geom;
  `;
}

async function fetchOverpassWays(bounds) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: overpassQuery(bounds) }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Overpass request failed (${response.status})`);
    const data = await response.json();
    return Array.isArray(data?.elements) ? data.elements : [];
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWays(elements = []) {
  return elements
    .map((element) => {
      const limitKmh = parseMaxspeedKmh(
        element.tags?.maxspeed ?? element.tags?.['maxspeed:forward'] ?? element.tags?.['maxspeed:backward']
      );
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

  const key = cacheKeyForBounds(bounds);
  const cache = await getJson(SPEED_LIMIT_CACHE_KEY, {});
  const cached = cache[key];
  if (cached && Date.now() - cached.savedAt < CACHE_MAX_AGE_MS) {
    return { ways: cached.ways || [], status: 'cache_hit', source: 'openstreetmap_overpass' };
  }

  const ways = normalizeWays(await fetchOverpassWays(bounds));
  await setJson(SPEED_LIMIT_CACHE_KEY, {
    ...cache,
    [key]: { savedAt: Date.now(), ways },
  });
  return { ways, status: ways.length ? 'fetched' : 'no_tagged_ways', source: 'openstreetmap_overpass' };
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
        speed_limit_source: 'openstreetmap',
        speed_limit_way_id: match.id,
        speed_limit_road_name: match.name,
      };
    });

    return {
      routePoints: annotated,
      coverage: routePoints.length ? Math.round((matched / routePoints.length) * 100) : 0,
      status: result.status,
      source: result.source,
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
