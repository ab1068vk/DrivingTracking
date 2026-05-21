import { getJson, setJson } from '@/lib/mobileStorage';

const CACHE_KEY = 'drivesense_map_matching_cache_v2';
const MAX_MATCH_POINTS = 100;
const OSRM_TIMEOUT_MS = 12000;

const round = (value, places = 5) => Number(value).toFixed(places);

function routeCacheKey(points = []) {
  const first = points[0];
  const last = points[points.length - 1];
  return [
    round(first?.lat, 3),
    round(first?.lng, 3),
    round(last?.lat, 3),
    round(last?.lng, 3),
    points.length,
  ].join(',');
}

function samplePoints(points = []) {
  if (points.length <= MAX_MATCH_POINTS) return points.map((point, index) => ({ point, index }));
  const step = (points.length - 1) / (MAX_MATCH_POINTS - 1);
  return Array.from({ length: MAX_MATCH_POINTS }, (_, sampleIndex) => {
    const index = Math.round(sampleIndex * step);
    return { point: points[index], index };
  });
}

function osrmMatchUrl(points = [], baseUrl) {
  const url = new URL('/match/v1/driving/' + points.map(({ point }) => `${point.lng},${point.lat}`).join(';'), baseUrl);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('radiuses', points.map(({ point }) => Math.max(10, Math.min(75, Number(point.accuracy) || 25))).join(';'));
  return url.toString();
}

function nearestMatchedPoint(original, geometry = []) {
  if (!geometry.length) return null;
  let best = null;
  for (const coord of geometry) {
    const lng = Number(coord[0]);
    const lat = Number(coord[1]);
    const score = Math.abs(lat - original.lat) + Math.abs(lng - original.lng);
    if (!best || score < best.score) best = { lat, lng, score };
  }
  return best;
}

export async function mapMatchRoute(routePoints = [], settings = {}) {
  if (settings.map_matching_enabled === false) {
    return { routePoints, status: 'disabled', provider: 'osrm' };
  }
  if (!settings.osrm_map_matching_url) {
    return { routePoints, status: 'disabled', provider: 'osrm' };
  }
  const valid = (routePoints || []).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (valid.length < 3) return { routePoints, status: 'not_enough_points', provider: 'osrm' };

  const key = routeCacheKey(valid);
  const cache = await getJson(CACHE_KEY, {});
  if (cache[key]) return { ...cache[key], status: 'cache_hit', provider: 'osrm' };

  try {
    const sampled = samplePoints(valid);
    const endpoint = settings.osrm_map_matching_url;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    const response = await fetch(osrmMatchUrl(sampled, endpoint), { signal: controller.signal })
      .finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error(`OSRM match failed (${response.status})`);
    const data = await response.json();
    const matching = data.matchings?.[0];
    const geometry = matching?.geometry?.coordinates || [];
    if (!geometry.length) throw new Error(data.message || 'No matched geometry returned');

    let snappedCount = 0;
    const matched = valid.map((point) => {
      const nearest = nearestMatchedPoint(point, geometry);
      if (!nearest) return point;
      snappedCount++;
      return {
        ...point,
        original_lat: point.original_lat ?? point.lat,
        original_lng: point.original_lng ?? point.lng,
        matched_lat: nearest.lat,
        matched_lng: nearest.lng,
        map_matched: true,
        map_matching_provider: 'osrm',
      };
    });
    const result = {
      routePoints: matched,
      status: 'matched',
      provider: 'osrm',
      confidence: Math.round((matching.confidence ?? snappedCount / valid.length) * 100) / 100,
      snapped_coverage: Math.round((snappedCount / valid.length) * 100),
    };
    await setJson(CACHE_KEY, { ...cache, [key]: result });
    return result;
  } catch (error) {
    return {
      routePoints,
      status: 'unavailable',
      provider: 'osrm',
      error: error?.message || 'Map matching unavailable',
    };
  }
}
