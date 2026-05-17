import {
  buildDrivingThresholds,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
  simplifyRoute,
} from '@/lib/tripEngine';
import { localSettings } from '@/lib/trackingStore';
import { mapMatchRoute } from '@/lib/mapMatching';
import { annotateRouteSpeedLimits } from '@/lib/speedLimitSource';
import { applyWeatherRiskToScores, fetchWeatherContextForTrip } from '@/lib/weatherContext';

export async function buildOpenSourceTripContextPatch(trip, settings = localSettings.get()) {
  if (!trip) throw new Error('Trip not loaded');

  const originalPoints = trip.route_points || [];
  if (originalPoints.length < 2) {
    return {
      speed_limit_context: {
        provider: 'openstreetmap_overpass',
        status: 'empty_route',
        coverage: 0,
        source: 'openstreetmap_overpass',
        error: 'Trip needs at least two GPS points before OSM speed limits can be matched.',
      },
      needs_rescore: false,
    };
  }

  const thresholds = buildDrivingThresholds(settings);
  const mapMatchingContext = await mapMatchRoute(originalPoints, settings);
  let routePoints = mapMatchingContext.routePoints || originalPoints;
  const speedLimitContext = await annotateRouteSpeedLimits(routePoints, settings);
  routePoints = speedLimitContext.routePoints || routePoints;
  const stats = calculateTripStats(routePoints, trip.start_time, trip.end_time, thresholds);
  const detection = detectDrivingEvents(routePoints, thresholds, trip.end_time);
  const detectedEvents = Reflect.get(detection, 'events') ?? detection;
  const phoneUse = Reflect.get(detection, 'phoneUse') ?? {};
  const weatherContext = await fetchWeatherContextForTrip(routePoints, trip.start_time, trip.end_time, settings).catch((error) => ({
    provider: 'open-meteo',
    status: 'unavailable',
    riskLevel: 'low',
    riskScore: 0,
    riskMultiplier: 1,
    error: error?.message || 'Weather lookup unavailable',
  }));
  let scores = calculateTripScores(detectedEvents, stats, routePoints, thresholds, stats.duration_seconds, phoneUse, { endTime: trip.end_time });
  scores = applyWeatherRiskToScores(scores, weatherContext);
  const events = scores.driving_events || detectedEvents;
  const simplifiedPoints = simplifyRoute(routePoints, 10, events);

  return {
    ...stats,
    ...scores,
    route_points: simplifiedPoints,
    route_points_raw_count: routePoints.length,
    driving_events: events,
    speed_limit_context: {
      provider: 'openstreetmap_overpass',
      status: speedLimitContext.status,
      coverage: speedLimitContext.coverage,
      source: speedLimitContext.source,
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
  if (context.status === 'no_tagged_ways') return 'OpenStreetMap did not return maxspeed tags for roads near this route, so fallback thresholds are used.';
  if (context.status === 'unavailable') return context.error || 'OpenStreetMap speed-limit lookup is unavailable. Check internet access and try refresh again.';
  if (context.coverage === 0) return 'OpenStreetMap was checked, but no route points matched tagged speed-limit roads.';
  return `${context.coverage}% of route points have OpenStreetMap speed limits.`;
}
