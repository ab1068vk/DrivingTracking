import {
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  prefetchLocalKnowledge,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits, speedLimitDefaultCountryKey } from '@/lib/speedLimitSource';
import { LocalSpeedKnowledge } from '@/lib/localSpeedKnowledge';
import { setJson } from '@/lib/mobileStorage';
import { speedKnowledgeStore } from '@/lib/speedKnowledgeRepository';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';
import { PUBLIC_OSRM_DEMO_URL, isPublicOsrmDemoUrl } from '@/lib/osrmPrivacy';
import { getPrivacyZones, maskRoutePointsForPrivacy } from '@/lib/privacyZones';
import { prepareScoreInputsForPrivacy } from '@/lib/scoreInputPrivacy';
import { isAndroid } from '@/lib/nativePlatform';
import { effectivePrivacySettings, isHeightenedPrivacyMode } from '@/lib/privacyMode';

// CHANGES (session):
// - Wired LocalSpeedKnowledge.learnFromTrip after OSM speed-limit enrichment using only openstreetmap-sourced points.
// - Added stronger posted-sign override wording for regional default estimates.

const stage = (onProgress, message) => {
  if (typeof onProgress === 'function') onProgress(message);
};

const PRIVACY_DELAYED_LOOKUP_TIMEOUT_MS = 11 * 60 * 1000;
const MANUAL_WEATHER_LOOKUP_TIMEOUT_MS = 20000;
export const ROAD_CONTEXT_QUEUED_STATUS = isAndroid()
  ? 'Queued privately with a randomized delay; continues after swipe-away'
  : 'Queued privately with a randomized delay';

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error(message)), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(id));
});

export { PUBLIC_OSRM_DEMO_URL };

export const isOsrmMapMatchingConfigured = (settings = {}) => (
  !isHeightenedPrivacyMode(settings) &&
  settings.map_matching_enabled !== false &&
  Boolean(settings.osrm_map_matching_url) &&
  settings.osrm_data_sharing_consented === true &&
  !isPublicOsrmDemoUrl(settings.osrm_map_matching_url)
);

export const isOsrmMapMatchingEnabled = (settings = {}) => (
  !isHeightenedPrivacyMode(settings) &&
  settings.map_matching_enabled !== false
);

export const isExternalContextAutoFetchEnabled = (settings = {}) => (
  settings.external_context_auto_fetch_enabled === true &&
  typeof settings.external_context_auto_fetch_consented_at === 'string' &&
  settings.external_context_auto_fetch_consented_at.trim().length > 0
);

export const isRoadDataLookupConfigured = (settings = {}) => (
  !isHeightenedPrivacyMode(settings) && (
    settings.speed_limit_lookup_enabled !== false ||
    isOsrmMapMatchingConfigured(settings)
  )
);

export const isWeatherContextLookupConfigured = (settings = {}) => (
  !isHeightenedPrivacyMode(settings) &&
  settings.weather_context_enabled !== false
);

export function buildWeatherContextPrivacyMessage(settings = {}) {
  if (isHeightenedPrivacyMode(settings)) {
    return 'Heightened privacy mode is on. Weather lookup is blocked until you turn it off in Settings > Privacy & Data.';
  }
  if (settings.weather_context_enabled === false) {
    return 'Weather lookup is off. Turn on Weather in Settings > Speed & Road Data first.';
  }
  return [
    'Get Weather checks Open-Meteo for this selected trip only.',
    'It sends one route point rounded to 4 decimals plus the trip date.',
    'Points inside privacy zones and the additional 100 m weather guard are excluded.',
    'OpenStreetMap and OSRM will not be contacted.',
    '',
    'Continue?',
  ].join('\n');
}

export function buildRoadDataDisabledMessage(settings = {}) {
  if (isHeightenedPrivacyMode(settings)) {
    return 'Heightened privacy mode is on. OSRM route snapping, Open-Meteo weather, and Overpass speed-limit lookups are skipped until you turn it off in Settings > Privacy & Data.';
  }
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
    'All road-data lookups are off or not ready:',
    `- Speed limits: ${settings.speed_limit_lookup_enabled === false ? 'off' : 'on'}`,
    `- ${osrmState}`,
    '',
    'Turn on Speed limits or configure Snap route to roads in Settings > Speed & Road Data, then tap Get Road Data again.',
    'Weather is separate: use Get Weather or confirm a condition locally.',
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
  if (isHeightenedPrivacyMode(settings)) {
    return [
      'Heightened privacy mode is on.',
      'OSRM route snapping, Open-Meteo weather, and Overpass speed-limit lookups will be skipped for this trip.',
      '',
      'Continue with local-only recalculation?',
    ].join('\n');
  }
  const lines = [
    'Get Road Data can contact only OpenStreetMap and your approved OSRM endpoint for this selected trip.',
    'Privacy-zone coordinates are excluded before anything leaves the app.',
    'Open-Meteo weather is separate and will not run.',
    '',
  ];
  if (settings.speed_limit_lookup_enabled !== false) {
    lines.push('- Speed limits: send privacy-filtered public road boxes to OpenStreetMap for road names and posted maxspeed limits. Missing maxspeed tags may use labeled road-type and regional default estimates. Regional defaults are useful fallback estimates when posted speed data is unavailable, but they are not proof of the posted speed limit; posted signs, school zones, construction zones, temporary limits, municipal bylaws, and road-specific exceptions can override them.');
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
  const { onProgress, immediateRequests = false, weatherContextOverride } = options;
  const effectiveSettings = effectivePrivacySettings(settings);
  const requestSettings = immediateRequests && !isHeightenedPrivacyMode(effectiveSettings)
    ? { ...effectiveSettings, request_obfuscation_enabled: false }
    : effectiveSettings;
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

  const thresholds = buildDrivingThresholds(effectiveSettings);
  const privacyZones = getPrivacyZones(effectiveSettings);
  stage(onProgress, lookupStatus);
  const osrmConfigured = isOsrmMapMatchingConfigured(effectiveSettings);
  const osrmRoutePoints = buildPrivacySafeOsrmRoute(originalPoints, effectiveSettings);
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
      mapMatchRoute(osrmRoutePoints, effectiveSettings),
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
    fallback_country: speedLimitDefaultCountryKey(effectiveSettings),
    error: error?.message || 'Speed limit lookup unavailable',
  }));
  routePoints = speedLimitContext.routePoints || routePoints;
  const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
  try {
    const osmConfirmedPoints = routePoints.filter((point) => (
      point?.speed_limit_source === 'openstreetmap' &&
      Number(point?.speed_limit_kmh) > 0
    ));
    if (osmConfirmedPoints.length) {
      await knowledge.learnFromTrip(osmConfirmedPoints, privacyZones, {
        tripId: trip?.id || trip?.trip_id || trip?.start_time || null,
      });
    }
  } catch (error) {
    console.warn('Local speed knowledge learning skipped.', error);
  }
  const scoreInputPrivacy = prepareScoreInputsForPrivacy({
    routePoints,
    events: [],
    settings: effectiveSettings,
    zones: privacyZones,
  });
  const scoringRoutePoints = scoreInputPrivacy.routePoints;
  const localKnowledgeResults = await prefetchLocalKnowledge(scoringRoutePoints, knowledge);
  const speedKnowledgeMetadata = localKnowledgeResults?.knowledgeMetadata || {};
  stage(onProgress, 'Recalculating trip scores');
  const stats = calculateTripStats(scoringRoutePoints, trip.start_time, trip.end_time, thresholds, {
    ...trip,
    raw_route_points: scoringRoutePoints,
  });
  const { events: detectedEvents, phoneUse: detectedPhoneUse } = detectDrivingEvents(scoringRoutePoints, thresholds, trip.end_time, privacyZones, {
    localKnowledgeResults,
    settings: effectiveSettings,
  });
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    scoringRoutePoints,
    stats.duration_seconds,
    detectedPhoneUse
  );
  const weatherContext = weatherContextOverride !== undefined
    ? weatherContextOverride
    : trip.weather_context || {
      provider: 'open-meteo',
      source: 'unavailable',
      status: trip.weather_skipped_reason ? 'skipped_privacy' : 'manual_required',
      riskLevel: null,
      riskScore: null,
      riskMultiplier: 1,
    };
  let scores = calculateTripScores(detectedEvents, stats, scoringRoutePoints, thresholds, stats.duration_seconds, phoneUse, {
    endTime: trip.end_time,
    privacyZones,
    localKnowledgeResults,
    settings: effectiveSettings,
  });
  scores = applyWeatherRiskToScores(scores, weatherContext);
  if (trip.id && scores.trip_speed_summary_v1) {
    await setJson(`trip_speed_summary_${trip.id}_v1`, scores.trip_speed_summary_v1).catch((error) => {
      console.warn('Trip speed summary storage skipped.', error);
    });
  }
  const events = prepareScoreInputsForPrivacy({
    routePoints: [],
    events:
    mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || detectedEvents, phoneUse),
    settings: effectiveSettings,
    zones: privacyZones,
  }).events;

  return {
    ...stats,
    ...scores,
    route_points: scoringRoutePoints,
    route_points_raw_count: recordedPointCount,
    route_points_map_count: scoringRoutePoints.length,
    score_input_masking_applied: true,
    privacy_zone_touched: scoreInputPrivacy.touchesPrivacyZone,
    privacy_trend_excluded: scoreInputPrivacy.trendExcluded,
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
      isOsrmDemoUrl: mapMatchingContext.isOsrmDemoUrl === true || isPublicOsrmDemoUrl(effectiveSettings.osrm_map_matching_url),
    },
    weather_context: weatherContext?.weather_skipped_reason ? null : weatherContext,
    weather_skipped_reason: weatherContext?.weather_skipped_reason || null,
    speed_knowledge_schema_version: Number(speedKnowledgeMetadata.schemaVersion) || null,
    speed_knowledge_revision: Number(speedKnowledgeMetadata.knowledgeRevision) || 0,
    speed_knowledge_scored_at: new Date().toISOString(),
    needs_rescore: false,
  };
}

/**
 * Fetch and apply weather for one trip without contacting OpenStreetMap or OSRM.
 * Weather still uses the same single rounded, privacy-zone-safe coordinate as
 * the full road-context flow.
 */
export async function buildWeatherOnlyTripContextPatch(trip, settings = localSettings.get(), options = {}) {
  if (!trip) throw new Error('Trip not loaded');
  const effectiveSettings = effectivePrivacySettings(settings);
  const requestSettings = options.immediateRequests === true && !isHeightenedPrivacyMode(effectiveSettings)
    ? { ...effectiveSettings, request_obfuscation_enabled: false }
    : effectiveSettings;
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (!routePoints.length) throw new Error('Trip needs a GPS point before weather can be requested.');

  stage(options.onProgress, 'Getting privacy-filtered weather');
  const controller = new AbortController();
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      const error = new Error('Weather lookup timed out. Check your connection and try again.');
      error.name = 'AbortError';
      reject(error);
    }, MANUAL_WEATHER_LOOKUP_TIMEOUT_MS);
  });
  let weatherContext;
  try {
    weatherContext = await Promise.race([
      fetchWeatherContextForTrip(
        routePoints,
        trip.start_time,
        trip.end_time,
        requestSettings,
        { signal: controller.signal }
      ),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error('Weather lookup timed out. Check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  stage(options.onProgress, 'Applying weather to this trip');
  const isolatedSettings = {
    ...effectiveSettings,
    speed_limit_lookup_enabled: false,
    map_matching_enabled: false,
    osrm_map_matching_url: '',
    osrm_data_sharing_consented: false,
  };
  const patch = await buildOpenSourceTripContextPatch(trip, isolatedSettings, {
    ...options,
    weatherContextOverride: weatherContext,
  });

  // Preserve existing route, OSM and OSRM evidence. The isolated settings above
  // exist only to guarantee that the weather-only action cannot contact them.
  delete patch.route_points;
  delete patch.route_points_raw_count;
  delete patch.route_points_map_count;
  delete patch.speed_limit_context;
  delete patch.map_matching_context;
  return patch;
}

export async function buildLocalSpeedKnowledgeScorePatch(trip, settings = localSettings.get()) {
  if (!trip) throw new Error('Trip not loaded');
  const routePoints = Array.isArray(trip.route_points) ? trip.route_points : [];
  if (routePoints.length < 2) {
    return {
      needs_rescore: false,
      updated_at: new Date().toISOString(),
    };
  }

  const thresholds = buildDrivingThresholds(settings);
  const privacyZones = getPrivacyZones(settings);
  const knowledge = new LocalSpeedKnowledge(speedKnowledgeStore);
  const scoreInputPrivacy = prepareScoreInputsForPrivacy({
    routePoints,
    events: [],
    settings,
    zones: privacyZones,
  });
  const scoringRoutePoints = scoreInputPrivacy.routePoints;
  const localKnowledgeResults = await prefetchLocalKnowledge(scoringRoutePoints, knowledge);
  const speedKnowledgeMetadata = localKnowledgeResults?.knowledgeMetadata || {};
  const stats = calculateTripStats(scoringRoutePoints, trip.start_time, trip.end_time, thresholds, {
    ...trip,
    raw_route_points: scoringRoutePoints,
  });
  const { events: detectedEvents, phoneUse: detectedPhoneUse } = detectDrivingEvents(
    scoringRoutePoints,
    thresholds,
    trip.end_time,
    privacyZones,
    { localKnowledgeResults, settings }
  );
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    scoringRoutePoints,
    stats.duration_seconds,
    detectedPhoneUse
  );
  let scores = calculateTripScores(
    detectedEvents,
    stats,
    scoringRoutePoints,
    thresholds,
    stats.duration_seconds,
    phoneUse,
    {
      endTime: trip.end_time,
      privacyZones,
      localKnowledgeResults,
      settings,
    }
  );
  scores = applyWeatherRiskToScores(scores, trip.weather_context || null);
  if (trip.id && scores.trip_speed_summary_v1) {
    await setJson(`trip_speed_summary_${trip.id}_v1`, scores.trip_speed_summary_v1).catch((error) => {
      console.warn('Trip speed summary storage skipped.', error);
    });
  }
  const events = prepareScoreInputsForPrivacy({
    routePoints: [],
    events:
    mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || detectedEvents, phoneUse),
    settings,
    zones: privacyZones,
  }).events;

  return {
    ...stats,
    ...scores,
    driving_events: events,
    score_input_masking_applied: true,
    privacy_zone_touched: scoreInputPrivacy.touchesPrivacyZone,
    privacy_trend_excluded: scoreInputPrivacy.trendExcluded,
    speed_knowledge_schema_version: Number(speedKnowledgeMetadata.schemaVersion) || null,
    speed_knowledge_revision: Number(speedKnowledgeMetadata.knowledgeRevision) || 0,
    speed_knowledge_scored_at: new Date().toISOString(),
    needs_rescore: false,
    updated_at: new Date().toISOString(),
  };
}

export function describeOsmSpeedLimitStatus(context = {}) {
  if (!context || !context.status) {
    return 'OpenStreetMap speed limits have not been fetched for this trip yet.';
  }
  if (context.status === 'manual_required') return 'Speed limits have not been fetched. Tap Get Road Data when you want to send privacy-filtered public road boxes to OpenStreetMap.';
  if (context.status === 'disabled') return 'OpenStreetMap speed-limit lookup is disabled in Settings.';
  if (context.status === 'empty_route' && context.skipped_reason === 'all_points_private') {
    return 'OpenStreetMap posted speed lookup was skipped because every usable route point is inside a privacy-zone guard. No protected coordinates were sent; regional or GPS estimates are used where available.';
  }
  if (context.status === 'empty_route' && context.skipped_reason === 'privacy_bounds_overlap') {
    return 'OpenStreetMap posted speed lookup was skipped because the safe route query area would overlap a privacy-zone guard. No protected coordinates were sent; regional or GPS estimates are used where available.';
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
