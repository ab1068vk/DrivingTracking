/**
 * Provisional in-trip score for the live tracking cockpit.
 *
 * The scoring engine was already being run mid-drive: Dashboard rebuilt events,
 * stats, and scores for two ten-minute windows on *every* render and collapsed
 * the whole thing into one fatigue boolean. This module runs that work once on a
 * throttled cadence, caches the result by trip, and returns both the fatigue
 * window comparison and the provisional score the tracking cockpit shows.
 *
 * Honesty contract: a partial trip has no post-hoc speed-limit resolution, no
 * road-context enrichment, and no final distance normalization, so this score is
 * provisional by construction. It is rendered through scoreDisplay's approximate
 * (`~`) path, is never persisted, never exported, and must never be compared
 * against a completed-trip score.
 */

import {
  DEFAULT_THRESHOLDS,
  EVENT_TYPES,
  calculateTripScores,
  calculateTripStats,
  detectDrivingEvents,
} from '@/lib/tripEngine';
import { clamp } from '@/lib/mathUtils';

export const LIVE_SCORE_MIN_INTERVAL_MS = 20000;
export const LIVE_SCORE_MIN_ROUTE_POINTS = 12;
export const LIVE_SCORE_MIN_DISTANCE_KM = 0.3;
/** Matches the ten-minute head/tail windows the Dashboard fatigue check used. */
export const LIVE_SCORE_WINDOW_MS = 10 * 60 * 1000;
export const LIVE_SCORE_WINDOW_MIN_POINTS = 3;
/** The fatigue hint only applies to long drives, as the Dashboard gate did. */
export const LIVE_SCORE_FATIGUE_MIN_SECONDS = 90 * 60;
export const LIVE_SCORE_FATIGUE_DROP_POINTS = 15;

export const LIVE_SCORE_LIMITATION =
  'Provisional in-drive estimate from partial data. Speed limits, road context, and final distance normalization are only resolved after the trip ends, so this will not match the completed trip score.';

const CACHE_LIMIT = 3;
const cache = new Map();

const EVENT_DRIVERS = [
  { key: EVENT_TYPES.HARSH_BRAKE, label: 'Harsh braking' },
  { key: EVENT_TYPES.RAPID_ACCELERATION, label: 'Rapid acceleration' },
  { key: EVENT_TYPES.SHARP_TURN, label: 'Sharp cornering' },
  { key: EVENT_TYPES.SPEEDING, label: 'Speeding' },
  { key: EVENT_TYPES.ERRATIC_SPEED, label: 'Erratic speed' },
];

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const timestampMs = (value) => {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const routePointsOf = (trip) => (Array.isArray(trip?.route_points) ? trip.route_points : []);

function scoreWindow(points, thresholds) {
  if (points.length < LIVE_SCORE_WINDOW_MIN_POINTS) return null;
  // The engine derives every rate from per-point timestamps. A window without a
  // usable start and end is not just unscoreable, it makes the duration-driven
  // passes degenerate, so refuse it before doing any work.
  if (timestampMs(points[0]?.timestamp) == null || timestampMs(points[points.length - 1]?.timestamp) == null) {
    return null;
  }
  const { events, phoneUse } = detectDrivingEvents(points, thresholds);
  const stats = calculateTripStats(points, points[0].timestamp, points[points.length - 1].timestamp, thresholds);
  const scores = calculateTripScores(events, stats, points, thresholds, stats.duration_seconds, phoneUse);
  return {
    events,
    stats,
    scores,
    overall: finite(scores?.component_scores?.overall?.value),
  };
}

function confidenceFor(distanceKm, routePointCount) {
  if (routePointCount < LIVE_SCORE_MIN_ROUTE_POINTS || distanceKm < LIVE_SCORE_MIN_DISTANCE_KM) return 'insufficient_data';
  if (distanceKm < 2) return 'early';
  if (distanceKm < 8) return 'developing';
  return 'strong';
}

function buildTopDrivers(events, distanceKm) {
  const list = Array.isArray(events) ? events : events?.events || [];
  const perDistance = Math.max(distanceKm, LIVE_SCORE_MIN_DISTANCE_KM);
  return EVENT_DRIVERS
    .map(({ key, label }) => {
      const count = list.filter((event) => event?.type === key).length;
      return { key, label, count, per100km: Math.round((count / perDistance) * 100 * 10) / 10 };
    })
    .filter((driver) => driver.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 3);
}

function buildWindowComparison(trip, nowMs, thresholds) {
  const unavailable = { available: false, firstScore: null, lastScore: null, delta: null, declined: false };
  const points = routePointsOf(trip);
  if (points.length < LIVE_SCORE_MIN_ROUTE_POINTS) return unavailable;
  const startMs = timestampMs(trip?.start_time);
  if (startMs == null) return unavailable;

  const firstWindowEnd = startMs + LIVE_SCORE_WINDOW_MS;
  const lastWindowStart = nowMs - LIVE_SCORE_WINDOW_MS;
  const firstPoints = points.filter((point) => {
    const ms = timestampMs(point?.timestamp);
    return ms != null && ms <= firstWindowEnd;
  });
  const lastPoints = points.filter((point) => {
    const ms = timestampMs(point?.timestamp);
    return ms != null && ms >= lastWindowStart;
  });
  if (firstPoints.length < LIVE_SCORE_WINDOW_MIN_POINTS || lastPoints.length < LIVE_SCORE_WINDOW_MIN_POINTS) {
    return unavailable;
  }

  const first = scoreWindow(firstPoints, thresholds);
  const last = scoreWindow(lastPoints, thresholds);
  const firstScore = first?.overall ?? null;
  const lastScore = last?.overall ?? null;
  if (firstScore == null || lastScore == null) return unavailable;

  return {
    available: true,
    firstScore,
    lastScore,
    delta: Math.round((lastScore - firstScore) * 10) / 10,
    declined: lastScore < firstScore - LIVE_SCORE_FATIGUE_DROP_POINTS,
  };
}

function emptyResult(status, nowMs) {
  return {
    status,
    tripId: null,
    confidence: 'insufficient_data',
    provisionalScore: null,
    safetyScore: null,
    smoothnessScore: null,
    distanceKm: 0,
    durationSeconds: 0,
    routePointCount: 0,
    topDrivers: [],
    windowComparison: { available: false, firstScore: null, lastScore: null, delta: null, declined: false },
    fatigueAlert: false,
    computedAtMs: nowMs,
    limitation: LIVE_SCORE_LIMITATION,
  };
}

function compute(trip, nowMs, thresholds) {
  const points = routePointsOf(trip);
  const startMs = timestampMs(trip?.start_time);
  const durationSeconds = startMs == null ? 0 : Math.max(0, (nowMs - startMs) / 1000);
  const windowComparison = buildWindowComparison(trip, nowMs, thresholds);
  const base = {
    ...emptyResult('ok', nowMs),
    tripId: trip?.id || null,
    routePointCount: points.length,
    durationSeconds,
    windowComparison,
    fatigueAlert: durationSeconds > LIVE_SCORE_FATIGUE_MIN_SECONDS && windowComparison.declined,
  };

  const whole = points.length >= LIVE_SCORE_MIN_ROUTE_POINTS
    ? scoreWindow(points, thresholds)
    : null;
  const distanceKm = Math.max(0, finite(whole?.stats?.distance_km) ?? finite(trip?.distance_km) ?? 0);
  const confidence = confidenceFor(distanceKm, points.length);
  if (!whole || confidence === 'insufficient_data') {
    return { ...base, status: 'insufficient_data', confidence: 'insufficient_data', distanceKm };
  }

  const componentScores = whole.scores?.component_scores || {};
  const provisionalScore = finite(componentScores.overall?.value);
  return {
    ...base,
    status: provisionalScore == null ? 'insufficient_data' : 'ok',
    confidence: provisionalScore == null ? 'insufficient_data' : confidence,
    provisionalScore: provisionalScore == null ? null : clamp(provisionalScore, 0, 100),
    safetyScore: finite(componentScores.safety?.value),
    smoothnessScore: finite(componentScores.smoothness?.value),
    distanceKm,
    topDrivers: buildTopDrivers(whole.events, distanceKm),
  };
}

/**
 * @param {any} activeTrip Live trip record, or null when nothing is recording.
 * @param {any} [_settings] Reserved; scoring uses engine defaults as the
 *   Dashboard fatigue check did, so live and completed runs stay comparable.
 * @param {{ nowMs?: number, minIntervalMs?: number, thresholds?: any }} [options]
 */
export function computeLiveTripScore(activeTrip, _settings = {}, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const minIntervalMs = Number.isFinite(options.minIntervalMs) ? options.minIntervalMs : LIVE_SCORE_MIN_INTERVAL_MS;
  const thresholds = options.thresholds || DEFAULT_THRESHOLDS;
  const tripId = activeTrip?.id || null;
  if (!activeTrip || !tripId) return emptyResult('no_active_trip', nowMs);

  const cached = cache.get(tripId);
  if (cached && nowMs - cached.computedAtMs < minIntervalMs && nowMs >= cached.computedAtMs) {
    return cached.result;
  }

  const result = compute(activeTrip, nowMs, thresholds);
  cache.set(tripId, { computedAtMs: nowMs, result });
  while (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  return result;
}

/** Vitest runs with shared module state; tests must clear the throttle cache. */
export function resetLiveTripScoreCache() {
  cache.clear();
}
