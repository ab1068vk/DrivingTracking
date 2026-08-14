/**
 * The public entry point: what, if anything, is worth saying about the road ahead.
 *
 * This replaces a radius check. The old path took every stored zone within 300 m
 * of the vehicle in any direction, called the nearest one "ahead", and spoke.
 * Here every hazard is placed on a projected corridor, ranked by how much of the
 * warning window it has already consumed, and every rejection is recorded with a
 * named reason — because the first question about a warning system this quiet is
 * "why did it not warn me", and that has to be answerable.
 *
 * Nothing here decides to *speak*. Ranking and gating are separate on purpose:
 * this function is pure and re-runs per fix, while the gate carries state across
 * fixes (sustained approach, one-shot per drive, cooldown).
 */
import { clamp } from '@/lib/mathUtils';
import { isPointInPrivacyZone } from '@/lib/privacyZones';
import {
  buildHazardCandidates,
  rankHazardCandidates,
} from '@/lib/hazard/hazardCandidates';
import {
  projectHazardPath,
  resolveTravelHeading,
} from '@/lib/hazard/hazardPathProjection';
import { queryHazardCorridor } from '@/lib/hazard/hazardHorizonSnapshot';
import {
  HAZARD_HORIZON_ALERT_SECONDS,
  HAZARD_HORIZON_MAX_SECONDS,
  HAZARD_HORIZON_MIN_SECONDS,
  HAZARD_HORIZON_MIN_SECONDS_SETTING,
  HAZARD_MAX_ACCURACY_M,
  HAZARD_MIN_HEADING_CONFIDENCE,
  HAZARD_MIN_SPEED_KMH,
} from '@/lib/appConstants';

const numeric = (value) => {
  if (value == null || value === '') return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

/** Clamped here as well as at the settings boundary: an imported blob can carry anything. */
export function resolveHorizonSeconds(settings = {}) {
  const configured = numeric(settings?.hazard_horizon_seconds);
  if (!Number.isFinite(configured)) return HAZARD_HORIZON_ALERT_SECONDS;
  return clamp(configured, HAZARD_HORIZON_MIN_SECONDS_SETTING, HAZARD_HORIZON_MAX_SECONDS);
}

const empty = (reason, diagnostics = {}) => ({
  path: null,
  hazards: [],
  top: null,
  suppressed: [{ id: null, reason }],
  diagnostics: { stopReason: reason, ...diagnostics },
});

/**
 * @param {{point: any, recentPoints?: Array<any>, snapshot: any, settings?: any,
 *          privacyZones?: Array<any>, nowMs?: number}} input
 * @returns {{path: any, hazards: Array<any>, top: any, suppressed: Array<{id, reason}>, diagnostics: any}}
 */
export function buildHazardHorizon({
  point, recentPoints = [], snapshot, settings = {}, privacyZones = [], nowMs = Date.now(),
} = {}) {
  const lat = numeric(point?.lat);
  const lng = numeric(point?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return empty('no_position');

  const speedKmh = numeric(point?.speed_kmh ?? point?.speedKmh);
  if (!Number.isFinite(speedKmh) || speedKmh < HAZARD_MIN_SPEED_KMH) return empty('below_min_speed');

  // A 50 m fix cannot support a claim about which road you are on, so the gate
  // here is tighter than the trip-level GPS filter.
  const accuracyM = numeric(point?.accuracy);
  if (Number.isFinite(accuracyM) && accuracyM > HAZARD_MAX_ACCURACY_M) return empty('low_accuracy');

  // Checked before the snapshot is touched: inside a private place the app does
  // not read hazard knowledge at all, let alone speak about it.
  if (isPointInPrivacyZone({ lat, lng }, privacyZones)) return empty('inside_privacy_zone');

  const points = Array.isArray(recentPoints) && recentPoints.length
    ? recentPoints
    : [point];
  const heading = resolveTravelHeading(points, { speedKmh, nowMs });
  if (heading.source === 'none') {
    return empty('no_heading', { headingSource: heading.source });
  }
  if (heading.confidence < HAZARD_MIN_HEADING_CONFIDENCE) {
    return empty('low_heading_confidence', {
      headingSource: heading.source,
      headingConfidence: heading.confidence,
    });
  }

  const alertSeconds = resolveHorizonSeconds(settings);
  const path = projectHazardPath({
    lat,
    lng,
    headingDeg: heading.headingDeg,
    speedKmh,
    horizonSeconds: alertSeconds,
    turnRateDegPerS: heading.turnRateDegPerS,
    spreadDeg: heading.spreadDeg,
    accuracyM: Number.isFinite(accuracyM) ? accuracyM : 0,
    confidence: heading.confidence,
  });
  if (!path) return empty('no_path', { headingSource: heading.source });

  const records = queryHazardCorridor(snapshot, path);
  const { candidates, rejected } = buildHazardCandidates({
    records,
    path,
    pathConfidence: heading.confidence,
    speedKmh,
    alertSeconds,
    minSeconds: HAZARD_HORIZON_MIN_SECONDS,
  });
  const hazards = rankHazardCandidates(candidates);

  const reasonCounts = rejected.reduce((counts, entry) => ({
    ...counts,
    [entry.reason]: (counts[entry.reason] || 0) + 1,
  }), {});

  return {
    path,
    hazards,
    top: hazards[0] || null,
    suppressed: rejected,
    diagnostics: {
      stopReason: null,
      headingSource: heading.source,
      headingConfidence: heading.confidence,
      turnRateDegPerS: heading.turnRateDegPerS,
      alertSeconds,
      corridorLengthM: path.lengthM,
      recordsQueried: records.length,
      candidateCount: hazards.length,
      reasonCounts,
      knownZones: snapshot?.stats?.zoneCount ?? 0,
      knownSegments: snapshot?.stats?.segmentCount ?? 0,
    },
  };
}
