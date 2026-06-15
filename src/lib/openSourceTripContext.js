import {
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits, speedLimitDefaultCountryKey } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';
import { PUBLIC_OSRM_DEMO_URL, isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { getPrivacyZones, maskEventsForPrivacy, maskRoutePointsForPrivacy } from '@/lib/privacyZones';
import { isAndroid } from '@/lib/nativePlatform';

const stage = (onProgress, message) => {
  if (typeof onProgress === 'function') onProgress(message);
};

const PRIVACY_DELAYED_LOOKUP_TIMEOUT_MS = 11 * 60 * 1000;
export const ROAD_CONTEXT_QUEUED_STATUS = isAndroid()
  ? 'Queued privately with a randomized delay; continues after swipe-away'
  : 'Queued privately with a randomized delay';

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error(message)), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(id));
});

export { PUBLIC_OSRM_DEMO_URL };

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
  settings.external_context_auto_fetch_enabled === true &&
  typeof settings.external_context_auto_fetch_consented_at === 'string' &&
  settings.external_context_auto_fetch_consented_at.trim().length > 0
);

export const isRoadDataLookupConfigured = (settings = {}) => (
  settings.speed_limit_lookup_enabled !== false ||
  settings.weather_context_enabled !== false ||
  isOsrmMapMatchingConfigured(settings)
);

export function buildRoadDataDisabledMessage(settings = {}) {
  const osrmState = settings.map_matching_enabled === false
    ? 'Snap route to roads is off.'
    : settings.osrm_map_matching_url && settings.osrm_data_sharing_consented !== true
      ? 'Snap route to roads needs OSRM consent.'
      : settings.osrm_map_matching_url
        ? 'Snap route to roads needs a trusted, non-demo OSRM endpoint.'
        : 'Snap route to roads needs a trusted OSRM endpoint and consent.';
  return [
    'Nothing to get right now.',
    '',
    'All online road-data lookups are off or not ready:',
    `- Speed limits: ${settings.speed_limit_lookup_enabled === false ? 'off' : 'on'}`,
    `- Weather: ${settings.weather_context_enabled === false ? 'off' : 'on'}`,
    `- ${osrmState}`,
    '',
    'Turn on Speed limits, Weather, or Snap route to roads in Settings > Speed & Road Data, then tap Get Road Data again.',
  ].join('\n');
}

export function buildPrivacySafeOsrmRoute(routePoints = [], settings = {}) {
  const zones = getPrivacyZones(settings);
  if (!zones.length) return routePoints;

  const masked = maskRoutePointsForPrivacy(routePoints, {
    ...settings,
    privacy_zones: zones,
  });
  return masked.reduce((safePoints, point) => {
    const previous = safePoints.at(-1);
    if (point?.privacy_boundary || point?.masked_for_privacy || !Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lng))) {
      if (!previous?.privacy_gap) {
        safePoints.push({
          lat: null,
          lng: null,
          masked_for_privacy: true,
          privacy_gap: true,
          privacy_zone_id: point?.privacy_zone_id || previous?.privacy_zone_id,
          privacy_zone_label: point?.privacy_zone_label || previous?.privacy_zone_label,
        });
      }
      return safePoints;
    }
    safePoints.push(point);
    return safePoints;
  }, []);
}

const routePointKey = (point = {}) => (
  point.timestamp
    ? `time:${point.timestamp}`
    : Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
      ? `coord:${Number(point.lat).toFixed(7)},${Number(point.lng).toFixed(7)}`
      : null
);

function mergePublicMapMatchingMetadata(originalPoints = [], matchedPoints = []) {
  const matchedByKey = new Map();
  matchedPoints.forEach((point) => {
    if (point?.privacy_boundary || point?.privacy_gap || point?.map_matched !== true) return;
    const key = routePointKey(point);
    if (key) matchedByKey.set(key, point);
  });

  return originalPoints.map((point) => {
    const matched = matchedByKey.get(routePointKey(point));
    if (!matched) return point;
    return {
      ...point,
      original_lat: matched.original_lat,
      original_lng: matched.original_lng,
      matched_lat: matched.matched_lat,
      matched_lng: matched.matched_lng,
      map_matched: true,
      map_matching_provider: matched.map_matching_provider,
    };
  });
}

export function buildRoadContextPrivacyMessage(settings = {}) {
  const lines = [
    'Get Road Data will run the enabled online lookups for this selected trip only.',
    'Privacy-zone coordinates are excluded before anything leaves the app.',
    '',
  ];
  if (settings.speed_limit_lookup_enabled !== false) {
    lines.push('- Speed limits: send privacy-filtered public road boxes to OpenStreetMap for road names and posted maxspeed limits. Missing maxspeed tags may use labeled road-type estimates, not official legal data.');
  }
  if (settings.weather_context_enabled !== false) {
    lines.push('- Weather: send one privacy-safe route point and the trip date to Open-Meteo.');
  }
  if (isOsrmMapMatchingConfigured(settings)) {
    const zones = getPrivacyZones(settings);
    lines.push(`- Snap route to roads: exclude ${zones.length} privacy zone(s), then send sampled public GPS segments to your OSRM endpoint.`);
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
  const { onProgress, immediateRequests = false } = options;
  const requestSettings = immediateRequests
    ? { ...settings, request_obfuscation_enabled: false }
    : settings;
  const lookupStatus = immediateRequests ? 'Getting privacy-filtered road data' : ROAD_CONTEXT_QUEUED_STATUS;

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
  stage(onProgress, lookupStatus);
  const weatherPromise = timeout(
    fetchWeatherContextForTrip(originalPoints, trip.start_time, trip.end_time, requestSettings),
    PRIVACY_DELAYED_LOOKUP_TIMEOUT_MS,
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
  const osrmRoutePoints = buildPrivacySafeOsrmRoute(originalPoints, settings);
  const osrmValidPointCount = osrmRoutePoints.filter((point) => (
    Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng))
  )).length;
  stage(onProgress, osrmConfigured ? 'Snapping route to roads with OSRM' : 'Skipping route snapping');
  const mapMatchingContext = osrmConfigured && privacyZones.length > 0 && osrmValidPointCount < 2
    ? {
      routePoints: originalPoints,
      status: 'privacy_zones_excluded',
      provider: 'osrm',
      error: 'OSRM was skipped because the route has no public segment outside privacy zones.',
      confidence: null,
      snapped_coverage: 0,
      privacy_gap_count: osrmRoutePoints.filter((point) => point?.privacy_gap).length,
      osrm_exposed_privacy_zone_count: 0,
    }
    : await timeout(
      mapMatchRoute(osrmRoutePoints, settings),
      16000,
      'OSRM route snapping timed out'
    ).catch((error) => ({
      routePoints: originalPoints,
      status: 'unavailable',
      provider: 'osrm',
      error: error?.message || 'Map matching unavailable',
      confidence: null,
      snapped_coverage: 0,
    }));
  let routePoints = mergePublicMapMatchingMetadata(
    originalPoints,
    mapMatchingContext.routePoints || []
  );
  stage(onProgress, lookupStatus);
  const speedLimitContext = await timeout(
    annotateRouteSpeedLimits(routePoints, requestSettings),
    PRIVACY_DELAYED_LOOKUP_TIMEOUT_MS,
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
      skipped_reason: speedLimitContext.skipped_reason,
    },
    map_matching_context: {
      provider: mapMatchingContext.provider,
      status: mapMatchingContext.status,
      confidence: mapMatchingContext.confidence ?? null,
      snapped_coverage: mapMatchingContext.snapped_coverage ?? 0,
      privacy_gap_count: mapMatchingContext.privacy_gap_count ?? 0,
      privacy_zone_count: privacyZones.length,
      osrm_exposed_privacy_zone_count: 0,
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
  if (context.status === 'manual_required') return 'Speed limits have not been fetched. Tap Get Road Data when you want to send privacy-filtered public road boxes to OpenStreetMap.';
  if (context.status === 'disabled') return 'OpenStreetMap speed-limit lookup is disabled in Settings.';
  if (context.status === 'empty_route' && context.skipped_reason === 'all_points_private') {
    return 'OpenStreetMap speed-limit lookup was skipped because every usable route point is inside a privacy-zone guard.';
  }
  if (context.status === 'empty_route' && context.skipped_reason === 'privacy_bounds_overlap') {
    return 'OpenStreetMap speed-limit lookup was skipped because the route query area would overlap a privacy-zone guard.';
  }
  if (context.status === 'empty_route') return 'This trip does not have enough usable GPS coordinates to fetch OpenStreetMap speed limits.';
  if (context.status === 'bbox_too_large') return 'This route is too large for one Overpass speed-limit request. Split the trip or refresh a shorter route.';
  if (context.status === 'no_tagged_ways') return 'OpenStreetMap did not return usable road tags near this route, so GPS fallback thresholds are used.';
  if (context.status === 'unavailable') return context.error || 'OpenStreetMap speed-limit lookup is unavailable. Check internet access and try refresh again.';
  if (context.status === 'partial_fetched' && context.coverage === 0) return 'OpenStreetMap partially responded, but no route points matched usable road-limit data.';
  if (context.status === 'partial_fetched') return `${context.coverage}% of route points have speed limits from partial OpenStreetMap results.`;
  if (context.coverage === 0) return 'OpenStreetMap was checked, but no route points matched usable road-limit data.';
  return `${context.coverage}% of route points have OpenStreetMap maxspeed or labeled road-type estimates.`;
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
  if (context.status === 'privacy_zones_excluded') {
    return context.error || 'OSRM was skipped because the route is entirely inside privacy zones.';
  }
  if (context.status === 'unavailable') {
    return context.error || 'OSRM road matching was unavailable, so the original GPS route was kept.';
  }
  return `OSRM road matching status: ${String(context.status).replace(/_/g, ' ')}.`;
}
