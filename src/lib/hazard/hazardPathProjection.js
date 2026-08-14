/**
 * Where the vehicle is actually going, and how far off that path a hazard sits.
 *
 * The live hazard warning used to consult no direction at all: every stored
 * repeated-event area within 300 m spoke, and the message asserted "ahead"
 * without checking. Zones behind the car, on the opposite carriageway, and on
 * crossing roads all triggered it.
 *
 * This module supplies the missing half. It resolves a trustworthy travel
 * heading, projects a forward corridor from that heading and the current speed,
 * and decomposes a hazard's position into distance *along* that corridor and
 * offset *across* it. Everything downstream — suppression, time-to-arrival,
 * ranking — is expressed in those two numbers.
 *
 * Two details are load-bearing:
 *
 * - The derived-heading fallback needs a real baseline. `headingForIndex` in
 *   tripEngine takes the bearing from the single previous point, which at a 1 Hz
 *   fix rate and 20 km/h is a 5.5 m baseline — inside GPS noise. Here the walk
 *   goes back until it has HAZARD_HEADING_BASELINE_M of displacement, and
 *   abstains outright rather than pointing confidently at the wrong road.
 * - The projection is an arc, not a ray. A straight ray systematically overshoots
 *   into the outside of a bend, which is exactly where the parallel-road and
 *   crossing-road false positives live.
 */
import { clamp } from '@/lib/mathUtils';
import { corridorDistanceMeters } from '@/lib/localCorridorGraph';
import {
  HAZARD_CORRIDOR_BASE_HALF_WIDTH_M,
  HAZARD_CORRIDOR_MAX_HALF_WIDTH_M,
  HAZARD_CORRIDOR_WIDTH_PER_100M,
  HAZARD_HEADING_BASELINE_M,
  HAZARD_HEADING_MAX_AGE_MS,
  HAZARD_HEADING_MIN_TRUST_SPEED_KMH,
  HAZARD_MAX_TURN_RATE_DEG_S,
  HAZARD_MIN_HEADING_CONFIDENCE,
  HAZARD_PROJECTION_MAX_M,
  HAZARD_PROJECTION_MIN_M,
  HAZARD_PROJECTION_SLACK,
  HAZARD_PROJECTION_STEP_M,
  HAZARD_FORWARD_CONE_DEG,
} from '@/lib/appConstants';

/** Repo convention (dangerZoneEngine, speedSpatialIndex): one degree of latitude is 111320 m. */
const M_PER_DEG = 111320;
const MIN_COS_LAT = 0.02;
/** Consecutive fixes closer than this contribute noise, not direction. */
const MIN_BEARING_STEP_M = 5;
/**
 * Below this much displacement there is no direction to recover, so the caller
 * is told to abstain. Deriving it from the confidence floor keeps the two in
 * step: any heading that survives the walk already clears HAZARD_MIN_HEADING_CONFIDENCE
 * on baseline alone, so the confidence gate only ever fires on jitter.
 */
const MIN_USABLE_BASELINE_M = HAZARD_HEADING_BASELINE_M * HAZARD_MIN_HEADING_CONFIDENCE;

const toRad = (deg) => (Number(deg) * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;
const finite = (value) => Number.isFinite(Number(value));
const coord = (point) => (point && finite(point.lat) && finite(point.lng)
  ? { lat: Number(point.lat), lng: Number(point.lng) }
  : null);

const timeMs = (point) => {
  const raw = point?.timestamp ?? point?.time;
  if (finite(raw)) return Number(raw);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function bearingBetween(from, to) {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Smallest absolute separation, 0-180.
 *
 * Deliberately *not* the fold-at-180 form `localCorridorGraph.bearingDelta` uses:
 * that one treats a reciprocal bearing as aligned, which is right for deciding
 * whether two road segments are the same corridor and catastrophic here, where
 * 180 degrees away is the definition of "behind you".
 */
export function bearingDeltaDeg(a, b) {
  const diff = Math.abs(((Number(a) - Number(b)) % 360 + 360) % 360);
  return diff > 180 ? 360 - diff : diff;
}

/** Signed separation in (-180, 180]: positive is a clockwise turn from `from` to `to`. */
const signedBearingDelta = (from, to) => {
  const diff = ((Number(to) - Number(from)) % 360 + 360) % 360;
  return diff > 180 ? diff - 360 : diff;
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Jitter, not turning. Spread is measured against the *median* bearing change,
 * so a steady curve reads as low spread with a high turn rate rather than as an
 * unreliable heading — otherwise every bend would widen the corridor and mute
 * the warning exactly where hard braking happens.
 */
function bearingStatistics(points) {
  const bearings = [];
  const intervals = [];
  for (let i = points.length - 1; i > 0 && bearings.length < 5; i -= 1) {
    const to = coord(points[i]);
    const from = coord(points[i - 1]);
    if (!to || !from) continue;
    if (corridorDistanceMeters(from, to) < MIN_BEARING_STEP_M) continue;
    bearings.unshift(bearingBetween(from, to));
    const dt = (timeMs(points[i]) ?? 0) - (timeMs(points[i - 1]) ?? 0);
    intervals.unshift(dt > 0 ? dt / 1000 : null);
  }
  if (bearings.length < 2) return { spreadDeg: 0, turnRateDegPerS: 0 };

  const deltas = [];
  const steps = [];
  for (let i = 1; i < bearings.length; i += 1) {
    deltas.push(signedBearingDelta(bearings[i - 1], bearings[i]));
    steps.push(intervals[i]);
  }
  const centre = median(deltas);
  const spreadDeg = deltas.reduce((sum, delta) => sum + Math.abs(delta - centre), 0) / deltas.length;
  const stepSeconds = median(steps.filter((value) => finite(value) && value > 0));
  const turnRateDegPerS = stepSeconds > 0
    ? clamp(centre / stepSeconds, -HAZARD_MAX_TURN_RATE_DEG_S, HAZARD_MAX_TURN_RATE_DEG_S)
    : 0;
  return { spreadDeg, turnRateDegPerS };
}

/**
 * @param {Array<{lat, lng, heading?, timestamp?}>} points Recent fixes, oldest first, current last.
 * @returns {{headingDeg: number|null, source: 'gps'|'derived'|'none', confidence: number,
 *            turnRateDegPerS: number, spreadDeg: number, baselineM: number}}
 */
export function resolveTravelHeading(points = [], { speedKmh = 0, nowMs = Date.now() } = {}) {
  const list = Array.isArray(points) ? points : [];
  const current = coord(list[list.length - 1]);
  const none = {
    headingDeg: null, source: 'none', confidence: 0,
    turnRateDegPerS: 0, spreadDeg: 0, baselineM: 0,
  };
  if (!current) return none;

  // Freshness is measured against the current fix, not the wall clock. Tracking
  // resumes after tunnels, OEM kills, and permission drops, and the points on
  // the far side of that gap describe where the vehicle used to be pointing.
  // Comparing to Date.now() would also make every replayed or imported fix stale.
  const referenceMs = timeMs(list[list.length - 1]) ?? nowMs;
  const fresh = list.filter((point) => {
    const at = timeMs(point);
    return at == null || referenceMs - at <= HAZARD_HEADING_MAX_AGE_MS;
  });
  const { spreadDeg, turnRateDegPerS } = bearingStatistics(fresh);
  // Spread is scored against the forward cone: jitter comparable to the cone
  // half-angle means the corridor could be pointing at the wrong road.
  const spreadFactor = clamp(1 - spreadDeg / HAZARD_FORWARD_CONE_DEG, 0, 1);

  const reported = list[list.length - 1];
  const reportedHeading = reported?.heading ?? reported?.bearing ?? reported?.course;
  if (finite(reportedHeading) && Number(speedKmh) >= HAZARD_HEADING_MIN_TRUST_SPEED_KMH) {
    return {
      headingDeg: ((Number(reportedHeading) % 360) + 360) % 360,
      source: 'gps',
      confidence: spreadFactor,
      turnRateDegPerS,
      spreadDeg,
      baselineM: 0,
    };
  }

  let baselineM = 0;
  let anchor = null;
  for (let i = fresh.length - 2; i >= 0; i -= 1) {
    const candidate = coord(fresh[i]);
    if (!candidate) continue;
    const distance = corridorDistanceMeters(candidate, current);
    if (!Number.isFinite(distance) || distance <= baselineM) continue;
    baselineM = distance;
    anchor = candidate;
    if (baselineM >= HAZARD_HEADING_BASELINE_M) break;
  }
  if (!anchor || baselineM < MIN_USABLE_BASELINE_M) return none;

  return {
    headingDeg: bearingBetween(anchor, current),
    source: 'derived',
    confidence: clamp(baselineM / HAZARD_HEADING_BASELINE_M, 0, 1) * spreadFactor,
    turnRateDegPerS,
    spreadDeg,
    baselineM,
  };
}

const offsetPoint = (origin, bearingDeg, distanceM) => {
  const cosLat = Math.max(MIN_COS_LAT, Math.abs(Math.cos(toRad(origin.lat))));
  const north = Math.cos(toRad(bearingDeg)) * distanceM;
  const east = Math.sin(toRad(bearingDeg)) * distanceM;
  return {
    lat: origin.lat + north / M_PER_DEG,
    lng: origin.lng + east / (M_PER_DEG * cosLat),
  };
};

/**
 * A constant-turn-rate arc from the current fix, long enough to see past the
 * alert band so the gate can watch a hazard approach before it becomes alertable.
 *
 * @returns {{points: Array<{lat, lng, distanceM, etaSeconds}>, lengthM: number,
 *            headingDeg: number, speedMs: number, confidence: number,
 *            halfWidthAt: (distanceM: number) => number}}
 */
export function projectHazardPath({
  lat, lng, headingDeg, speedKmh, horizonSeconds,
  turnRateDegPerS = 0, accuracyM = 0, confidence = 1, spreadDeg = 0,
} = {}) {
  const origin = coord({ lat, lng });
  const speedMs = Math.max(0, Number(speedKmh) || 0) / 3.6;
  if (!origin || !finite(headingDeg) || speedMs <= 0) return null;

  const lengthM = clamp(
    speedMs * Math.max(0, Number(horizonSeconds) || 0) * HAZARD_PROJECTION_SLACK,
    HAZARD_PROJECTION_MIN_M,
    HAZARD_PROJECTION_MAX_M
  );
  const spreadFan = Math.tan(toRad(clamp(spreadDeg, 0, 45)));
  const halfWidthAt = (distanceM) => {
    const forward = Math.max(0, Number(distanceM) || 0);
    return clamp(
      HAZARD_CORRIDOR_BASE_HALF_WIDTH_M +
        Math.max(0, Number(accuracyM) || 0) +
        (forward * HAZARD_CORRIDOR_WIDTH_PER_100M) / 100 +
        forward * spreadFan,
      HAZARD_CORRIDOR_BASE_HALF_WIDTH_M,
      HAZARD_CORRIDOR_MAX_HALF_WIDTH_M
    );
  };

  const points = [{ ...origin, distanceM: 0, etaSeconds: 0 }];
  const turn = clamp(Number(turnRateDegPerS) || 0, -HAZARD_MAX_TURN_RATE_DEG_S, HAZARD_MAX_TURN_RATE_DEG_S);
  let cursor = origin;
  let bearing = ((Number(headingDeg) % 360) + 360) % 360;
  let travelled = 0;
  while (travelled < lengthM) {
    const step = Math.min(HAZARD_PROJECTION_STEP_M, lengthM - travelled);
    cursor = offsetPoint(cursor, bearing, step);
    travelled += step;
    bearing = (bearing + turn * (step / speedMs) + 360) % 360;
    points.push({ ...cursor, distanceM: travelled, etaSeconds: travelled / speedMs });
  }

  return {
    points,
    lengthM,
    headingDeg: ((Number(headingDeg) % 360) + 360) % 360,
    speedMs,
    confidence: clamp(confidence, 0, 1),
    halfWidthAt,
  };
}

/**
 * Decompose a hazard into distance along the corridor and offset across it.
 *
 * Negative `alongTrackM` means the hazard is behind the vehicle: the first
 * segment is extended backwards rather than clamped, so "behind" is a measured
 * quantity instead of an assumption.
 *
 * @returns {{alongTrackM: number, crossTrackM: number, etaSeconds: number,
 *            onPath: boolean, behind: boolean}}
 */
export function relativeToProjectedPath(path, target, { behindToleranceM = 0 } = {}) {
  const point = coord(target);
  const miss = {
    alongTrackM: Infinity, crossTrackM: Infinity,
    etaSeconds: Infinity, onPath: false, behind: false,
  };
  if (!path?.points?.length || !point) return miss;

  const origin = path.points[0];
  const cosLat = Math.max(MIN_COS_LAT, Math.abs(Math.cos(toRad(origin.lat))));
  const local = (value) => ({
    x: (value.lng - origin.lng) * M_PER_DEG * cosLat,
    y: (value.lat - origin.lat) * M_PER_DEG,
  });
  const goal = local(point);

  let best = null;
  for (let i = 1; i < path.points.length; i += 1) {
    const from = local(path.points[i - 1]);
    const to = local(path.points[i]);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq <= 0) continue;
    // The first segment alone may project behind its start; every later segment
    // is clamped so a hazard beside the corridor cannot claim a phantom position
    // off the end of an interior leg.
    const raw = ((goal.x - from.x) * dx + (goal.y - from.y) * dy) / lengthSq;
    const t = i === 1 ? Math.min(1, raw) : clamp(raw, 0, 1);
    const projX = from.x + dx * t;
    const projY = from.y + dy * t;
    const crossTrackM = Math.hypot(goal.x - projX, goal.y - projY);
    if (best && crossTrackM >= best.crossTrackM) continue;
    const segmentLength = Math.sqrt(lengthSq);
    best = {
      crossTrackM,
      alongTrackM: path.points[i - 1].distanceM + segmentLength * t,
    };
  }
  if (!best) return miss;

  const etaSeconds = path.speedMs > 0 ? best.alongTrackM / path.speedMs : Infinity;
  const behind = best.alongTrackM <= -Math.abs(behindToleranceM);
  return {
    alongTrackM: best.alongTrackM,
    crossTrackM: best.crossTrackM,
    etaSeconds,
    behind,
    onPath: !behind && best.crossTrackM <= path.halfWidthAt(best.alongTrackM),
  };
}
