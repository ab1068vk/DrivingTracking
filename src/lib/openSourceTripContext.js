import {
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';
import { buildPhoneUseFromTripEvidence, mergePhoneUseEventsIntoDrivingEvents } from '@/lib/phoneUsageAccess';

const stage = (onProgress, message) => {
  if (typeof onProgress === 'function') onProgress(message);
};

const timeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const id = setTimeout(() => reject(new Error(message)), ms);
  promise.then(resolve, reject).finally(() => clearTimeout(id));
});

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
  stage(onProgress, 'Checking weather context');
  const weatherPromise = timeout(
    fetchWeatherContextForTrip(originalPoints, trip.start_time, trip.end_time, settings),
    12000,
    'Weather lookup timed out'
  ).catch((error) => ({
    provider: 'open-meteo',
    status: 'unavailable',
    riskLevel: 'low',
    riskScore: 0,
    riskMultiplier: 1,
    error: error?.message || 'Weather lookup unavailable',
  }));

  stage(onProgress, 'Matching route to roads');
  const mapMatchingContext = await timeout(
    mapMatchRoute(originalPoints, settings),
    16000,
    'OSRM map matching timed out'
  ).catch((error) => ({
    routePoints: originalPoints,
    status: 'unavailable',
    provider: 'osrm',
    error: error?.message || 'Map matching unavailable',
    confidence: null,
    snapped_coverage: 0,
  }));
  let routePoints = mapMatchingContext.routePoints || originalPoints;
  stage(onProgress, 'Fetching OSM speed limits');
  const speedLimitContext = await timeout(
    annotateRouteSpeedLimits(routePoints, settings),
    18000,
    'OpenStreetMap speed-limit lookup timed out'
  ).catch((error) => ({
    routePoints,
    coverage: 0,
    status: 'unavailable',
    source: 'openstreetmap_overpass',
    error: error?.message || 'Speed limit lookup unavailable',
  }));
  routePoints = speedLimitContext.routePoints || routePoints;
  stage(onProgress, 'Recalculating trip scores');
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
  const detection = detectDrivingEvents(routePoints, thresholds, trip.end_time);
  const detectedEvents = detection.events;
  const phoneUse = buildPhoneUseFromTripEvidence(
    trip,
    routePoints,
    stats.duration_seconds,
    detection.phoneUse ?? {}
  );
  const weatherContext = await weatherPromise;
  let scores = calculateTripScores(detectedEvents, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
  scores = applyWeatherRiskToScores(scores, weatherContext);
  const events = mergePhoneUseEventsIntoDrivingEvents(scores.driving_events || detectedEvents, phoneUse);

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
      query_count: speedLimitContext.query_count,
      error: speedLimitContext.error,
    },
    map_matching_context: {
      provider: mapMatchingContext.provider,
      status: mapMatchingContext.status,
      confidence: mapMatchingContext.confidence ?? null,
      snapped_coverage: mapMatchingContext.snapped_coverage ?? 0,
      error: mapMatchingContext.error,
    },
    weather_context: weatherContext,
    needs_rescore: false,
  };
}

export function describeOsmSpeedLimitStatus(context = {}) {
  if (!context || !context.status) {
    return 'OpenStreetMap speed limits have not been fetched for this trip yet.';
  }
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
