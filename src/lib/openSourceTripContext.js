import {
  buildDrivingThresholds,
  calculateTripScores,
} from '@/lib/scoring/componentScores';
import { calculateTripStats } from '@/lib/gps/routeSummary';
import { detectDrivingEvents } from '@/lib/detection/harshEvents';
import { localSettings } from '@/lib/trackingStore';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits, speedLimitDefaultCountryKey } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';
import { PUBLIC_OSRM_DEMO_URL, isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { getPrivacyZones, maskEventsForPrivacy } from '@/lib/privacyZones';

const stage = (onProgress, message) => {
  if (typeof onProgress === 'function') onProgress(message);
};

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error(message)), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(id));
});

export { PUBLIC_OSRM_DEMO_URL };

function skippedMapMatchingContext(originalPoints = [], settings = {}) {
  const isOsrmDemoUrl = isPublicOsrmDemoUrl(settings.osrm_map_matching_url);
  if (settings.map_matching_enabled === false) {
    return { routePoints: originalPoints, status: 'disabled', provider: 'osrm', isOsrmDemoUrl };
  }
  if (isOsrmDemoUrl) {
    return {
      routePoints: originalPoints,
      status: 'public_demo_blocked',
      provider: 'osrm',
      error: 'The public OSRM demo is reference-only in Road Sage. Configure a private or trusted OSRM endpoint before route snapping.',
      isOsrmDemoUrl,
    };
  }
  if (!settings.osrm_map_matching_url) {
    return {
      routePoints: originalPoints,
      status: 'needs_endpoint',
      provider: 'osrm',
      error: 'Route snapping is optional and needs a private or trusted OSRM endpoint before sampled GPS coordinate pairs are sent.',
      isOsrmDemoUrl,
    };
  }
  return {
    routePoints: originalPoints,
    status: 'needs_consent',
    provider: 'osrm',
    error: 'Route snapping needs explicit OSRM data-sharing consent before sampled GPS coordinate pairs are sent.',
    isOsrmDemoUrl,
  };
}

export const isOsrmMapMatchingConfigured = (settings = {}) => (
  settings.map_matching_enabled !== false &&
  Boolean(settings.osrm_map_matching_url) &&
  settings.osrm_data_sharing_consented === true &&
  !isPublicOsrmDemoUrl(settings.osrm_map_matching_url)
);

export const isOsrmMapMatchingEnabled = (settings = {}) => (
  settings.map_matching_enabled !== false
);

export const isExternalContextAutoFetchEnabled = (settings = {}) => (
  settings.external_context_auto_fetch_enabled !== false
);

export function buildRoadContextPrivacyMessage(settings = {}) {
  const lines = [
    'Get Road Data will check online services for this selected trip:',
    '',
  ];
  if (settings.speed_limit_lookup_enabled !== false) {
    lines.push('- Speed limits: sends route-area boxes to OpenStreetMap Overpass and gets road names, road geometry, and maxspeed tags.');
  }
  if (settings.weather_context_enabled !== false) {
    lines.push('- Weather: sends a privacy-safe route latitude/longitude rounded to 4 decimals plus the trip date to Open-Meteo; skips weather if every route point is inside a privacy zone buffer.');
  }
  if (isOsrmMapMatchingConfigured(settings)) {
    lines.push('- Snap route to roads: sends sampled GPS coordinate pairs to your configured OSRM endpoint, one request per continuous route segment.');
  } else if (settings.map_matching_enabled !== false && isPublicOsrmDemoUrl(settings.osrm_map_matching_url)) {
    lines.push('- Snap route to roads is blocked because the public OSRM demo is help text only, not a usable endpoint.');
  } else if (settings.map_matching_enabled !== false && settings.osrm_map_matching_url && settings.osrm_data_sharing_consented !== true) {
    lines.push('- Snap route to roads has an endpoint but will be skipped until OSRM data-sharing consent is saved.');
  } else if (isOsrmMapMatchingEnabled(settings)) {
    lines.push('- Snap route to roads is on but has no endpoint, so OSRM will be skipped until a link is added.');
  } else {
    lines.push('- Snap route to roads is off, so GPS points are not sent to OSRM.');
  }
  lines.push('', 'Continue?');
  return lines.join('\n');
}

export async function buildOpenSourceTripContextPatch(trip, settings = localSettings.get(), options = {}) {
  if (!trip) throw new Error('Trip not loaded');
  const { onProgress } = options;

  const originalPoints = trip.route_points || [];
  const recordedPointCount = Number(trip.route_points_raw_count) || originalPoints.length;
  if (originalPoints.length < 2) {
    return {
      speed_limit_context: {
        provider: 'openstreetmap_overpass',
        status: 'empty_route',
        coverage: 0,
        source: 'openstreetmap_overpass',
        error: 'Trip needs at least two GPS points before OSM speed limits can be matched.',
      },
      route_points_raw_count: recordedPointCount,
      route_points_map_count: originalPoints.length,
      needs_rescore: false,
    };
  }

  const thresholds = buildDrivingThresholds(settings);
  const privacyZones = getPrivacyZones(settings);
  stage(onProgress, 'Getting weather');
  const weatherPromise = timeout(
    fetchWeatherContextForTrip(originalPoints, trip.start_time, trip.end_time, settings),
    12000,
    'Weather lookup timed out'
  ).catch((error) => ({
    provider: 'open-meteo',
    status: 'unavailable',
    riskLevel: null,
    riskScore: null,
    riskMultiplier: 1,
    error: error?.message || 'Weather lookup unavailable',
  }));

  const osrmConfigured = isOsrmMapMatchingConfigured(settings);
  stage(onProgress, osrmConfigured ? 'Snapping route to roads with OSRM' : 'Skipping route snapping');
  const mapMatchingContext = (await timeout(
    mapMatchRoute(originalPoints, settings),
    16000,
    'OSRM route snapping timed out'
  ).catch((error) => ({
    routePoints: originalPoints,
    status: 'unavailable',
    provider: 'osrm',
    error: error?.message || 'Map matching unavailable',
    confidence: null,
    snapped_coverage: 0,
  }))) || skippedMapMatchingContext(originalPoints, settings);
  let routePoints = mapMatchingContext.routePoints || originalPoints;
  stage(onProgress, 'Getting speed limits from OpenStreetMap');
  const speedLimitContext = await timeout(
    annotateRouteSpeedLimits(routePoints, settings),
    18000,
    'OpenStreetMap speed-limit lookup timed out'
  ).catch((error) => ({
    routePoints,
    coverage: 0,
    status: 'unavailable',
    source: 'openstreetmap_overpass',
    fallback_country: speedLimitDefaultCountryKey(settings),
    error: error?.message || 'Speed limit lookup unavailable',
  }));
  routePoints = speedLimitContext.routePoints || routePoints;
  stage(onProgress, 'Recalculating trip scores');
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds, {
    ...trip,
    raw_route_points: originalPoints,
  });
  const { events: detectedEvents, phoneUse: detectedPhoneUse } = detectDrivingEvents(routePoints, thresholds, trip.end_time, privacyZones);
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    routePoints,
    stats.duration_seconds,
    detectedPhoneUse
  );
  const weatherContext = await weatherPromise;
  let scores = calculateTripScores(detectedEvents, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time, privacyZones });
  scores = applyWeatherRiskToScores(scores, weatherContext);
  const events = maskEventsForPrivacy(
    mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || detectedEvents, phoneUse),
    { privacy_zones: privacyZones }
  );

  return {
    ...stats,
    ...scores,
    route_points: routePoints,
    route_points_raw_count: recordedPointCount,
    route_points_map_count: routePoints.length,
    driving_events: events,
    speed_limit_context: {
      provider: 'openstreetmap_overpass',
      status: speedLimitContext.status,
      coverage: speedLimitContext.coverage,
      source: speedLimitContext.source,
      fallback_country: speedLimitContext.fallback_country,
      query_count: speedLimitContext.query_count,
      error: speedLimitContext.error,
    },
    map_matching_context: {
      provider: mapMatchingContext.provider,
      status: mapMatchingContext.status,
      confidence: mapMatchingContext.confidence ?? null,
      snapped_coverage: mapMatchingContext.snapped_coverage ?? 0,
      error: mapMatchingContext.error,
      isOsrmDemoUrl: mapMatchingContext.isOsrmDemoUrl === true || isPublicOsrmDemoUrl(settings.osrm_map_matching_url),
    },
    weather_context: weatherContext?.weather_skipped_reason ? null : weatherContext,
    weather_skipped_reason: weatherContext?.weather_skipped_reason || null,
    needs_rescore: false,
  };
}

export function describeOsmSpeedLimitStatus(context = {}) {
  if (!context || !context.status) {
    return 'OpenStreetMap speed limits have not been fetched for this trip yet.';
  }
  if (context.status === 'manual_required') return 'Speed limits have not been fetched. Tap Get Road Data when you want to send route-area boxes to OpenStreetMap.';
  if (context.status === 'disabled') return 'OpenStreetMap speed-limit lookup is disabled in Settings.';
  if (context.status === 'empty_route') return 'This trip does not have enough GPS points to fetch OpenStreetMap speed limits.';
  if (context.status === 'bbox_too_large') return 'This route is too large for one Overpass speed-limit request. Split the trip or refresh a shorter route.';
  if (context.status === 'no_tagged_ways') return 'OpenStreetMap did not return usable road tags near this route, so GPS fallback thresholds are used.';
  if (context.status === 'unavailable') return context.error || 'OpenStreetMap speed-limit lookup is unavailable. Check internet access and try refresh again.';
  if (context.status === 'partial_fetched' && context.coverage === 0) return 'OpenStreetMap partially responded, but no route points matched usable road-limit data.';
  if (context.status === 'partial_fetched') return `${context.coverage}% of route points have speed limits from partial OpenStreetMap results.`;
  if (context.coverage === 0) return 'OpenStreetMap was checked, but no route points matched usable road-limit data.';
  return `${context.coverage}% of route points have OpenStreetMap maxspeed or road-type default limits.`;
}

export function describeMapMatchingStatus(context = {}) {
  if (!context || !context.status || context.status === 'not_fetched') {
    return 'OSRM road matching has not been run for this trip.';
  }
  if (context.status === 'manual_required') {
    return 'Route snapping is configured but waits for Get Road Data before sending sampled GPS points to OSRM.';
  }
  if (context.status === 'disabled') {
    return 'Route snapping was skipped. Add an OSRM endpoint in Settings only if you want sampled GPS points sent there.';
  }
  if (context.status === 'needs_endpoint') {
    return context.error || 'Route snapping is on, but no OSRM endpoint is set. Add a private or trusted OSRM endpoint in Settings.';
  }
  if (context.status === 'needs_consent') {
    return context.error || 'Route snapping needs OSRM data-sharing consent before sampled GPS coordinate pairs are sent.';
  }
  if (context.status === 'public_demo_blocked') {
    return context.error || 'The public OSRM demo is shown only as an example. Configure a private or trusted OSRM endpoint.';
  }
  if (context.status === 'matched' || context.status === 'partial_matched') {
    const prefix = context.status === 'partial_matched' ? 'OSRM partially snapped' : 'OSRM snapped';
    if (context.isOsrmDemoUrl) {
      return `${prefix} ${context.snapped_coverage ?? 0}% of route points to roads using the public OSRM demo.`;
    }
    return `${prefix} ${context.snapped_coverage ?? 0}% of route points to roads.`;
  }
  if (context.status === 'not_enough_points') {
    return 'OSRM road matching needs at least three GPS points.';
  }
  if (context.status === 'unavailable') {
    return context.error || 'OSRM road matching was unavailable, so the original GPS route was kept.';
  }
  return `OSRM road matching status: ${String(context.status).replace(/_/g, ' ')}.`;
}
