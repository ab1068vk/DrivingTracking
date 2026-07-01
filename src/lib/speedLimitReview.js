import { geohashEncode } from '@/lib/localSpeedKnowledge';
import { buildRoadSectionIdentity, isPublicPoint } from '@/lib/roadSectionIdentity';
import { assessSpeedLimitEvidence } from '@/lib/speedLimitConfidence';
import { speedLimitReviewPriority } from '@/lib/speedLimitIntelligence';

export const DASHBOARD_SPEED_LIMIT_REVIEW_DISMISSAL_KEY = 'drivesense_dashboard_speed_limit_review_dismissal';

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
  return isPublicPoint(point);
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

function conflictFingerprint(cell = {}) {
  const details = cell.conflictDetails || {};
  return [
    'cell',
    cell.geohash || 'unknown-cell',
    Math.round(Number(cell.limitKmh) || 0),
    Math.round(Number(details.existingLimitKmh) || 0),
    Math.round(Number(details.newLimitKmh) || 0),
  ].join(':');
}

function tripReviewFingerprint(trip = null) {
  if (!trip) return null;
  return [
    'trip',
    trip.id || 'unknown-trip',
    trip.speed_limit_review_required === true ? 'required' : 'derived',
  ].join(':');
}

/**
 * @param {{
 *   conflictedCells?: any[],
 *   reviewTrip?: Record<string, any> | null,
 *   reviewCellCount?: number,
 * }} options
 */
export function buildDashboardSpeedLimitReviewFingerprint({
  conflictedCells = [],
  reviewTrip = null,
} = {}) {
  const affectedItems = [
    ...(Array.isArray(conflictedCells) ? conflictedCells.map(conflictFingerprint) : []),
    tripReviewFingerprint(reviewTrip),
  ].filter(Boolean).sort();

  return affectedItems.length ? affectedItems.join('|') : '';
}

const normalizeSpeedLimitReviewItem = (item) => {
  const raw = String(item || '').trim();
  if (!raw) return '';

  const parts = raw.split(':');
  if (parts[0] === 'cell') {
    const geohash = parts[1] || 'unknown-cell';
    const [limitKmh, existingLimitKmh, newLimitKmh] = parts.slice(-3);
    return [
      'cell',
      geohash,
      Math.round(Number(limitKmh) || 0),
      Math.round(Number(existingLimitKmh) || 0),
      Math.round(Number(newLimitKmh) || 0),
    ].join(':');
  }

  if (parts[0] === 'trip') {
    const last = parts[parts.length - 1];
    const status = /^\d+$/.test(last) ? parts[parts.length - 2] : last;
    const reviewStatus = status === 'required' ? 'required' : 'derived';
    return ['trip', parts[1] || 'unknown-trip', reviewStatus].join(':');
  }

  return '';
};

export function normalizeDashboardSpeedLimitReviewFingerprint(fingerprint = '') {
  return String(fingerprint || '')
    .split('|')
    .map(normalizeSpeedLimitReviewItem)
    .filter(Boolean)
    .sort()
    .join('|');
}

export function isDashboardSpeedLimitReviewDismissed(dismissedFingerprint = '', currentFingerprint = '') {
  const currentItems = normalizeDashboardSpeedLimitReviewFingerprint(currentFingerprint).split('|').filter(Boolean);
  if (!currentItems.length) return false;
  const dismissedItems = new Set(
    normalizeDashboardSpeedLimitReviewFingerprint(dismissedFingerprint).split('|').filter(Boolean)
  );
  return currentItems.every((item) => dismissedItems.has(item));
}

/**
 * @returns {Array<Record<string, any>>}
 */
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

    const identity = buildRoadSectionIdentity(trip, group.geohash);
    const source = hasMissingLimit ? 'missing_posted_review' : sources[0];
    const evidence = assessSpeedLimitEvidence({
      source,
      sampleCount: group.sampleCount,
    });
    const candidate = {
      geohash: group.geohash,
      lat: group.sampleLat,
      lng: group.sampleLng,
      coordinateSource: 'driven_route_sample',
      sampleTimestamp: group.sampleTimestamp,
      limitKmh: mostCommon(group.limits),
      suggestedLimitKmh: mostCommon(group.limits),
      source,
      sampleCount: group.sampleCount,
      limits: [...new Set(group.limits)].sort((a, b) => a - b),
      sources,
      roads: [...group.roads].slice(0, 3),
      tripReview: true,
      conflict: false,
      reviewReason: reviewReasonForTrip(trip, hasMissingLimit, hasEstimatedSource),
      evidence,
      ...(identity || {}),
    };
    candidates.push({
      ...candidate,
      reviewPriority: speedLimitReviewPriority(candidate, {
        affectedTripCount: 1,
      }),
    });
  }

  return candidates
    .sort((a, b) => b.reviewPriority.score - a.reviewPriority.score || b.sampleCount - a.sampleCount)
    .slice(0, maxCells);
}
