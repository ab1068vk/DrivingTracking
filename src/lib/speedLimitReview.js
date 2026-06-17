import { geohashEncode } from '@/lib/localSpeedKnowledge';

const POSTED_SPEED_LIMIT_SOURCES = new Set([
  'openstreetmap',
  'user_confirmed_posted_sign',
]);

const REVIEWABLE_SPEED_LIMIT_SOURCES = new Set([
  'user_entered_estimate',
  'trip_consensus',
  'learned_local',
  'time_of_day_bucket',
  'osm_highway_default',
  'region_default_estimate',
  'inferred',
]);

function pointSource(point = {}) {
  return point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? null;
}

function pointLimit(point = {}) {
  const limit = Number(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);
  return Number.isFinite(limit) && limit > 0 ? Math.round(limit) : null;
}

function validPublicPoint(point = {}) {
  const lat = Number(point.lat);
  const lng = Number(point.lng);
  return Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    point.privacy_export_placeholder !== true &&
    point.masked_for_privacy !== true &&
    point.privacy_gap !== true &&
    point.privacy_live_redacted !== true;
}

function mostCommon(values = []) {
  const counts = new Map();
  for (const value of values.filter((item) => item != null)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}

function reviewReasonForTrip(trip = {}, hasMissingLimit, hasEstimatedSource) {
  if (trip.speed_limit_review_reason) return trip.speed_limit_review_reason;
  if (trip.start_source === 'native_auto' || trip.imported_from_native === true) {
    return 'Background tracking cannot confirm posted signs while driving.';
  }
  if (hasMissingLimit) return 'No posted-speed source was confirmed during this part of the trip.';
  if (hasEstimatedSource) return 'This part of the trip used an estimated speed limit.';
  return 'Review this speed limit after the trip.';
}

export function speedLimitReviewNeededForTrip(trip = {}) {
  if (trip.speed_limit_review_required === true) return true;
  return buildTripSpeedLimitReviewCells(trip, { maxCells: 1 }).length > 0;
}

export function buildTripSpeedLimitReviewCells(trip = {}, { maxCells = 8 } = {}) {
  const points = Array.isArray(trip.route_points) ? trip.route_points.filter(validPublicPoint) : [];
  if (!points.length) return [];

  const groups = new Map();
  for (const point of points) {
    const geohash = geohashEncode(point.lat, point.lng);
    if (!groups.has(geohash)) {
      groups.set(geohash, {
        geohash,
        sampleCount: 0,
        sampleLat: Number(point.lat),
        sampleLng: Number(point.lng),
        sampleTimestamp: point.timestamp ?? point.recorded_at ?? point.timestamp_ms ?? null,
        limits: [],
        sources: new Set(),
        roads: new Set(),
      });
    }
    const group = groups.get(geohash);
    group.sampleCount += 1;
    const limit = pointLimit(point);
    if (limit != null) group.limits.push(limit);
    const source = pointSource(point);
    if (source) group.sources.add(source);
    if (point.speed_limit_road_name) group.roads.add(point.speed_limit_road_name);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const sources = [...group.sources];
    const hasPostedSource = sources.some((source) => POSTED_SPEED_LIMIT_SOURCES.has(source));
    const hasEstimatedSource = sources.some((source) => REVIEWABLE_SPEED_LIMIT_SOURCES.has(source));
    const hasMissingLimit = group.limits.length === 0 || sources.length === 0;
    const nativeDeferred = trip.speed_limit_review_required === true ||
      trip.start_source === 'native_auto' ||
      trip.imported_from_native === true;
    if (hasPostedSource && !nativeDeferred) continue;
    if (!hasEstimatedSource && !hasMissingLimit && !nativeDeferred) continue;

    candidates.push({
      geohash: group.geohash,
      lat: group.sampleLat,
      lng: group.sampleLng,
      coordinateSource: 'driven_route_sample',
      sampleTimestamp: group.sampleTimestamp,
      limitKmh: mostCommon(group.limits),
      suggestedLimitKmh: mostCommon(group.limits),
      source: hasMissingLimit ? 'missing_posted_review' : sources[0],
      sampleCount: group.sampleCount,
      limits: [...new Set(group.limits)].sort((a, b) => a - b),
      sources,
      roads: [...group.roads].slice(0, 3),
      tripReview: true,
      conflict: false,
      reviewReason: reviewReasonForTrip(trip, hasMissingLimit, hasEstimatedSource),
    });
  }

  return candidates
    .sort((a, b) => b.sampleCount - a.sampleCount)
    .slice(0, maxCells);
}
