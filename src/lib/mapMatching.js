import { getJson, setJson } from '@/lib/mobileStorage';
import { withRetry } from '@/lib/retry';
import { isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { logSystemFailure, recordSystemEvent } from '@/lib/systemLog';

const CACHE_KEY = 'drivesense_map_matching_cache_v2';
const MAX_MATCH_POINTS = 100;
export const DEFAULT_OSRM_TIMEOUT_MS = 12000;
export const OSRM_TIMEOUT_MS = Number(import.meta.env.VITE_OSRM_TIMEOUT_MS) || DEFAULT_OSRM_TIMEOUT_MS;
const OSRM_HEALTH_TIMEOUT_MS = 5000;

const round = (value, places = 5) => +Number(value).toFixed(places);
const isValidRoutePoint = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);

const endpointOrigin = (endpoint) => {
  try {
    return new URL(String(endpoint || '')).origin;
  } catch {
    return '';
  }
};

function routeCacheKey(segments = []) {
  const parts = segments.map((points) => {
    const first = points[0];
    const last = points[points.length - 1];
    return [
      round(first?.lat, 3),
      round(first?.lng, 3),
      round(last?.lat, 3),
      round(last?.lng, 3),
      points.length,
    ].join(',');
  });
  return [
    `segments:${segments.length}`,
    ...parts,
  ].join('|');
}

function splitAtNullPoints(points = []) {
  const items = Array.isArray(points) ? points : [];
  const segments = [];
  const mergedTemplate = [];
  let current = [];
  let gapPending = false;
  let gapPoint = null;

  items.forEach((point) => {
    if (isValidRoutePoint(point)) {
      if (gapPending) {
        if (current.length) {
          segments.push(current);
          mergedTemplate.push({ type: 'segment', index: segments.length - 1 });
          current = [];
        }
        mergedTemplate.push({ type: 'gap', point: gapPoint || point });
        gapPending = false;
        gapPoint = null;
      }
      current.push(point);
      return;
    }

    if (!gapPending) {
      gapPoint = point;
      gapPending = true;
    }
  });

  if (current.length) {
    segments.push(current);
    mergedTemplate.push({ type: 'segment', index: segments.length - 1 });
  }

  return { segments, mergedTemplate, gapCount: mergedTemplate.filter((item) => item.type === 'gap').length };
}

function privacyGapPoint(point = {}) {
  return {
    ...point,
    lat: null,
    lng: null,
    privacy_gap: true,
    masked_for_privacy: point?.masked_for_privacy ?? true,
  };
}

function mergeMatchedSegments(template = [], segmentResults = []) {
  return template.flatMap((item) => {
    if (item.type === 'gap') return [privacyGapPoint(item.point)];
    const result = segmentResults[item.index];
    return result?.routePoints || [];
  });
}

function originalSegmentResults(segments = []) {
  return segments.map((segment) => ({
    routePoints: segment,
    snappedCount: 0,
    confidence: null,
    status: 'skipped',
  }));
}

function routeCacheKeyForFlatPoints(points = []) {
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

function osrmHealthCheckUrl(baseUrl) {
  const url = new URL('/route/v1/driving/13.388860,52.517037;13.397634,52.529407', baseUrl);
  url.searchParams.set('overview', 'false');
  url.searchParams.set('steps', 'false');
  return url.toString();
}

export async function checkOsrmEndpointHealth(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint || '').trim());
  } catch {
    recordSystemEvent('osrm_health_invalid_endpoint', {
      reason: 'The OSRM endpoint is not a valid URL.',
    }, { category: 'osrm', severity: 'warn', title: 'OSRM health check failed' });
    return {
      status: 'unreachable',
      ok: false,
      checked_at: new Date().toISOString(),
      error: 'The OSRM endpoint is not a valid URL.',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OSRM_HEALTH_TIMEOUT_MS);
    const response = await fetch(osrmHealthCheckUrl(url.toString()), { signal: controller.signal })
      .finally(() => clearTimeout(timeout));
    if (!response.ok) {
      recordSystemEvent('osrm_health_unreachable', {
        status: response.status,
        statusText: response.statusText,
        endpoint_origin: url.origin,
      }, { category: 'osrm', severity: 'warn', title: 'OSRM health check failed' });
      return {
        status: 'unreachable',
        ok: false,
        checked_at: new Date().toISOString(),
        error: `OSRM health check failed (${response.status}).`,
      };
    }
    return {
      status: 'connected',
      ok: true,
      checked_at: new Date().toISOString(),
      error: '',
    };
  } catch (error) {
    logSystemFailure('osrm_health_check', error, { endpoint_origin: url.origin });
    return {
      status: 'unreachable',
      ok: false,
      checked_at: new Date().toISOString(),
      error: error?.name === 'AbortError'
        ? 'OSRM health check timed out.'
        : error?.message || 'OSRM health check failed.',
    };
  }
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

const osrmTimeoutMs = (settings = {}) => {
  const userTimeout = Number(settings.osrm_timeout_ms);
  return Number.isFinite(userTimeout) && userTimeout > 0 ? userTimeout : OSRM_TIMEOUT_MS;
};

async function fetchMatchedSegment(segment = [], endpoint, timeoutMs = OSRM_TIMEOUT_MS) {
  const sampled = samplePoints(segment);
  const response = await withRetry('osrm-map-matching', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(osrmMatchUrl(sampled, endpoint), { signal: controller.signal })
      .finally(() => clearTimeout(timeout));
  });
  if (!response.ok) throw new Error(`OSRM match failed (${response.status})`);
  const data = await response.json();
  const matching = data.matchings?.[0];
  const geometry = matching?.geometry?.coordinates || [];
  if (!geometry.length) throw new Error(data.message || 'No matched geometry returned');

  let snappedCount = 0;
  const routePoints = segment.map((point) => {
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

  const matchedConfidence = Number(matching.confidence);
  return {
    routePoints,
    snappedCount,
    confidence: Number.isFinite(matchedConfidence) ? matchedConfidence : snappedCount / segment.length,
    status: 'matched',
  };
}

export async function mapMatchRoute(routePoints = [], settings = {}) {
  const isOsrmDemoUrl = isPublicOsrmDemoUrl(settings.osrm_map_matching_url);
  if (settings.map_matching_enabled === false) {
    recordSystemEvent('osrm_map_matching_skipped', { status: 'disabled' }, { category: 'osrm' });
    return { routePoints, status: 'disabled', provider: 'osrm', isOsrmDemoUrl };
  }
  if (!settings.osrm_map_matching_url) {
    recordSystemEvent('osrm_map_matching_failed', {
      status: 'needs_endpoint',
      reason: 'Route snapping is on, but no OSRM endpoint is set.',
    }, { category: 'osrm', severity: 'warn', title: 'Operation failed: osrm_map_matching' });
    return {
      routePoints,
      status: 'needs_endpoint',
      provider: 'osrm',
      error: 'Route snapping is on, but no OSRM endpoint is set.',
      isOsrmDemoUrl,
    };
  }
  if (isOsrmDemoUrl) {
    recordSystemEvent('osrm_map_matching_failed', {
      status: 'public_demo_blocked',
      endpoint_origin: endpointOrigin(settings.osrm_map_matching_url),
      reason: 'The public OSRM demo is reference-only in Road Sage.',
    }, { category: 'osrm', severity: 'warn', title: 'Operation failed: osrm_map_matching' });
    return {
      routePoints,
      status: 'public_demo_blocked',
      provider: 'osrm',
      error: 'The public OSRM demo is reference-only in Road Sage. Configure a private or trusted OSRM endpoint before route snapping.',
      isOsrmDemoUrl,
    };
  }
  if (settings.osrm_data_sharing_consented !== true) {
    recordSystemEvent('osrm_map_matching_failed', {
      status: 'needs_consent',
      endpoint_origin: endpointOrigin(settings.osrm_map_matching_url),
      reason: 'Route snapping needs OSRM data-sharing consent.',
    }, { category: 'osrm', severity: 'warn', title: 'Operation failed: osrm_map_matching' });
    return {
      routePoints,
      status: 'needs_consent',
      provider: 'osrm',
      error: 'Route snapping needs OSRM data-sharing consent before sampled GPS coordinate pairs are sent.',
      isOsrmDemoUrl,
    };
  }
  const { segments, mergedTemplate, gapCount } = splitAtNullPoints(routePoints);
  const matchableSegments = segments.filter((segment) => segment.length >= 2);
  const validCount = segments.reduce((count, segment) => count + segment.length, 0);
  if (!matchableSegments.length) {
    recordSystemEvent('osrm_map_matching_failed', {
      status: 'not_enough_points',
      point_count: validCount,
    }, { category: 'osrm', severity: 'warn', title: 'Operation failed: osrm_map_matching' });
    return { routePoints, status: 'not_enough_points', provider: 'osrm', isOsrmDemoUrl };
  }

  const key = gapCount ? routeCacheKey(segments) : routeCacheKeyForFlatPoints(segments[0] || []);
  const cache = await getJson(CACHE_KEY, {});
  if (cache[key]) return { ...cache[key], status: 'cache_hit', provider: 'osrm', isOsrmDemoUrl };

  try {
    const endpoint = settings.osrm_map_matching_url;
    const timeoutMs = osrmTimeoutMs(settings);
    try {
      new URL(endpoint);
    } catch {
      recordSystemEvent('osrm_map_matching_failed', {
        status: 'needs_endpoint',
        reason: 'The OSRM endpoint is not a valid URL.',
      }, { category: 'osrm', severity: 'warn', title: 'Operation failed: osrm_map_matching' });
      return {
        routePoints,
        status: 'needs_endpoint',
        provider: 'osrm',
        error: 'The OSRM endpoint is not a valid URL.',
        isOsrmDemoUrl,
      };
    }

    const segmentResults = originalSegmentResults(segments);
    const failures = [];
    await Promise.all(segments.map(async (segment, index) => {
      if (segment.length < 2) return;
      try {
        segmentResults[index] = await fetchMatchedSegment(segment, endpoint, timeoutMs);
      } catch (error) {
        logSystemFailure('osrm_map_matching_segment', error, {
          endpoint_origin: endpointOrigin(endpoint),
          segment_index: index,
          segment_points: segment.length,
        });
        failures.push(error);
      }
    }));

    const matchedSegments = segmentResults.filter((result) => result.status === 'matched');
    if (!matchedSegments.length) throw failures[0] || new Error('No matched geometry returned');

    const snappedCount = segmentResults.reduce((count, result) => count + (result.snappedCount || 0), 0);
    const confidenceValues = segmentResults
      .map((result) => result.confidence)
      .filter(Number.isFinite);
    const rawConfidence = confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : snappedCount / validCount;
    const result = {
      routePoints: gapCount ? mergeMatchedSegments(mergedTemplate, segmentResults) : segmentResults[0].routePoints,
      status: failures.length ? 'partial_matched' : 'matched',
      provider: 'osrm',
      confidence: Math.round(rawConfidence * 100) / 100,
      snapped_coverage: Math.round((snappedCount / validCount) * 100),
      segment_count: segments.length,
      privacy_gap_count: gapCount,
      isOsrmDemoUrl,
    };
    await setJson(CACHE_KEY, { ...cache, [key]: result });
    recordSystemEvent('osrm_map_matching_completed', {
      status: result.status,
      snapped_coverage: result.snapped_coverage,
      segment_count: result.segment_count,
      privacy_gap_count: result.privacy_gap_count,
      failure_count: failures.length,
    }, { category: 'osrm', severity: failures.length ? 'warn' : 'info' });
    return result;
  } catch (error) {
    logSystemFailure('osrm_map_matching', error, {
      endpoint_origin: endpointOrigin(settings.osrm_map_matching_url),
      point_count: Array.isArray(routePoints) ? routePoints.length : 0,
    });
    const detail = error?.message ? ` ${error.message}` : '';
    return {
      routePoints,
      status: 'unavailable',
      provider: 'osrm',
      error: `OSRM could not snap this route. The original GPS route was kept.${detail}`,
      isOsrmDemoUrl,
    };
  }
}
