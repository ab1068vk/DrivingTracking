import { getJson, setJson } from '@/lib/mobileStorage';
import { haversineDistance } from '@/lib/tripEngine';

const CACHE_KEY = 'drivesense_map_matching_cache_v2';
const DEFAULT_OSRM_URL = 'https://router.project-osrm.org';
const MAX_MATCH_POINTS = 100;
const OSRM_TIMEOUT_MS = 12000;
const MAX_RETURNED_GEOMETRY_POINTS = 900;
const MAX_SNAP_DISTANCE_M = 110;
const MEDIUM_SNAP_DISTANCE_M = 35;
const LOW_SNAP_DISTANCE_M = 70;

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

function osrmMatchUrl(points = [], baseUrl = DEFAULT_OSRM_URL) {
  const url = new URL('/match/v1/driving/' + points.map(({ point }) => `${point.lng},${point.lat}`).join(';'), baseUrl);
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('annotations', 'duration,distance,speed');
  url.searchParams.set('tidy', 'true');
  url.searchParams.set('radiuses', points.map(({ point }) => Math.max(10, Math.min(75, Number(point.accuracy) || 25))).join(';'));
  return url.toString();
}

function sampleGeometry(points = [], maxPoints = MAX_RETURNED_GEOMETRY_POINTS) {
  if (points.length <= maxPoints) return points;
  const step = (points.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => points[Math.round(index * step)]);
}

function coordinateToPoint(coord = []) {
  const lng = Number(coord[0]);
  const lat = Number(coord[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function geometryPoints(matchings = []) {
  return matchings
    .flatMap((matching) => matching?.geometry?.coordinates || [])
    .map(coordinateToPoint)
    .filter(Boolean);
}

function pointToSegmentProjection(point, start, end) {
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
  if (dx === 0 && dy === 0) {
    return {
      lat: start.lat,
      lng: start.lng,
      ratio: 0,
      distanceM: haversineDistance(point.lat, point.lng, start.lat, start.lng) * 1000,
    };
  }
  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const lat = start.lat + (end.lat - start.lat) * ratio;
  const lng = start.lng + (end.lng - start.lng) * ratio;
  return {
    lat,
    lng,
    ratio,
    distanceM: haversineDistance(point.lat, point.lng, lat, lng) * 1000,
  };
}

function nearestMatchedPoint(original, geometry = []) {
  if (geometry.length === 1) {
    return {
      ...geometry[0],
      geometryIndex: 0,
      distanceM: haversineDistance(original.lat, original.lng, geometry[0].lat, geometry[0].lng) * 1000,
    };
  }
  if (geometry.length < 2) return null;
  let best = null;
  for (let i = 1; i < geometry.length; i++) {
    const projected = pointToSegmentProjection(original, geometry[i - 1], geometry[i]);
    if (!best || projected.distanceM < best.distanceM) {
      best = { ...projected, geometryIndex: i };
    }
  }
  return best;
}

function snapQuality(distanceM, tracepoint) {
  if (!tracepoint) return distanceM <= MEDIUM_SNAP_DISTANCE_M ? 'medium' : 'gap';
  if (distanceM <= MEDIUM_SNAP_DISTANCE_M) return 'high';
  if (distanceM <= LOW_SNAP_DISTANCE_M) return 'medium';
  return 'low';
}

function stepSegments(matchings = []) {
  return matchings.flatMap((matching, matchingIndex) => (
    (matching?.legs || []).flatMap((leg, legIndex) => (
      (leg?.steps || []).map((step, stepIndex) => {
        const geometry = (step.geometry?.coordinates || []).map(coordinateToPoint).filter(Boolean);
        return {
          id: `osrm-${matchingIndex}-${legIndex}-${stepIndex}`,
          roadName: step.name || step.ref || 'Unnamed road',
          ref: step.ref || null,
          mode: step.mode || 'driving',
          distanceM: Math.round(Number(step.distance) || 0),
          durationSeconds: Math.round(Number(step.duration) || 0),
          geometry,
        };
      })
    ))
  )).filter((segment) => segment.geometry.length > 1);
}

function nearestStep(point, segments = []) {
  let best = null;
  for (const segment of segments) {
    const nearest = nearestMatchedPoint(point, segment.geometry);
    if (nearest && (!best || nearest.distanceM < best.distanceM)) {
      best = { ...segment, distanceM: nearest.distanceM };
    }
  }
  return best && best.distanceM <= MAX_SNAP_DISTANCE_M ? best : null;
}

function geometryCoverage(routePoints = []) {
  const matched = routePoints.filter((point) => point.map_matched).length;
  const low = routePoints.filter((point) => point.map_match_quality === 'low' || point.map_match_quality === 'gap').length;
  return {
    snapped_coverage: routePoints.length ? Math.round((matched / routePoints.length) * 100) : 0,
    low_confidence_points: low,
  };
}

export async function mapMatchRoute(routePoints = [], settings = {}) {
  if (settings.map_matching_enabled === false) {
    return { routePoints, status: 'disabled', provider: 'osrm' };
  }
  const valid = (routePoints || []).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (valid.length < 3) return { routePoints, status: 'not_enough_points', provider: 'osrm' };

  const key = routeCacheKey(valid);
  const cache = await getJson(CACHE_KEY, {});
  if (cache[key]) return { ...cache[key], status: 'cache_hit', provider: 'osrm' };

  try {
    const sampled = samplePoints(valid);
    const endpoint = settings.osrm_map_matching_url || DEFAULT_OSRM_URL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    const response = await fetch(osrmMatchUrl(sampled, endpoint), { signal: controller.signal })
      .finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error(`OSRM match failed (${response.status})`);
    const data = await response.json();
    const matchings = Array.isArray(data.matchings) ? data.matchings : [];
    const matching = matchings[0];
    const geometry = geometryPoints(matchings);
    if (!geometry.length) throw new Error(data.message || 'No matched geometry returned');

    const tracepoints = Array.isArray(data.tracepoints) ? data.tracepoints : [];
    const sampledTracepointByIndex = new Map(sampled.map(({ index }, sampleIndex) => [index, tracepoints[sampleIndex] || null]));
    const segments = stepSegments(matchings);
    let snappedCount = 0;
    const matched = valid.map((point, pointIndex) => {
      const tracepoint = sampledTracepointByIndex.has(pointIndex)
        ? sampledTracepointByIndex.get(pointIndex)
        : null;
      const nearest = nearestMatchedPoint(point, geometry);
      if (!nearest || nearest.distanceM > MAX_SNAP_DISTANCE_M) {
        return {
          ...point,
          map_matched: false,
          map_matching_provider: 'osrm',
          map_match_quality: tracepoint ? 'low' : 'gap',
          map_match_distance_m: nearest ? Math.round(nearest.distanceM) : null,
        };
      }
      snappedCount++;
      const road = nearestStep(nearest, segments);
      const quality = snapQuality(nearest.distanceM, tracepoint);
      return {
        ...point,
        original_lat: point.lat,
        original_lng: point.lng,
        lat: nearest.lat,
        lng: nearest.lng,
        map_matched: true,
        map_matching_provider: 'osrm',
        map_match_quality: quality,
        map_match_distance_m: Math.round(nearest.distanceM),
        map_match_geometry_index: nearest.geometryIndex,
        map_match_confidence: matching.confidence ?? null,
        matched_road_name: road?.roadName || null,
        matched_road_ref: road?.ref || null,
        matched_road_distance_m: road ? Math.round(road.distanceM) : null,
      };
    });
    const coverage = geometryCoverage(matched);
    const result = {
      routePoints: matched,
      status: 'matched',
      provider: 'osrm',
      confidence: Math.round((matching.confidence ?? snappedCount / valid.length) * 100) / 100,
      snapped_coverage: coverage.snapped_coverage,
      low_confidence_points: coverage.low_confidence_points,
      route_geometry: sampleGeometry(geometry),
      road_segments: sampleGeometry(segments, 80),
      tracepoint_count: tracepoints.filter(Boolean).length,
      gap_count: tracepoints.filter((tracepoint) => !tracepoint).length,
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
