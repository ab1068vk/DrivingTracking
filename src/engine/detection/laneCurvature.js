import {
  calculateBearing,
  calculateSegmentMetrics,
  headingDiff,
  timestampMs,
} from '../utils/gps.js';

export const DEFAULT_CURVE_SUPPRESSION_DEG_PER_100M = 12;
export const DEFAULT_CURVE_SUPPRESSION_SECONDS = 6;

const segmentHeading = (prev, curr) => {
  const heading = Number(curr?.heading ?? curr?.bearing);
  return Number.isFinite(heading) ? heading : calculateBearing(prev.lat, prev.lng, curr.lat, curr.lng);
};

const curvatureForTurn = (before, after, distanceM) => {
  if (!Number.isFinite(before) || !Number.isFinite(after) || distanceM <= 0) return 0;
  return headingDiff(before, after) / Math.max(0.01, distanceM / 100);
};

const curveThreshold = (thresholds = {}) => (
  Number(thresholds.LANE_CHANGE_CURVE_SUPPRESSION_DEG_PER_100M) ||
  DEFAULT_CURVE_SUPPRESSION_DEG_PER_100M
);

const minimumCurveSeconds = (thresholds = {}) => (
  Number(thresholds.LANE_CHANGE_CURVE_SUPPRESSION_SECONDS) ||
  DEFAULT_CURVE_SUPPRESSION_SECONDS
);

export function buildLaneChangeSuppressionWindows(points = [], thresholds = {}) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const windows = [];
  const threshold = curveThreshold(thresholds);
  const minSeconds = minimumCurveSeconds(thresholds);
  let active = null;

  for (let index = 1; index < points.length - 1; index++) {
    const prev = points[index - 1];
    const curr = points[index];
    const next = points[index + 1];
    const inSegment = calculateSegmentMetrics(prev, curr, thresholds);
    const outSegment = calculateSegmentMetrics(curr, next, thresholds);
    if (inSegment.dt <= 0 || outSegment.dt <= 0 || inSegment.isNoise || outSegment.isNoise) {
      if (active) windows.push(active);
      active = null;
      continue;
    }

    const before = segmentHeading(prev, curr);
    const after = segmentHeading(curr, next);
    const curvature = curvatureForTurn(before, after, inSegment.distanceM + outSegment.distanceM);
    const startMs = timestampMs(prev);
    const endMs = timestampMs(next);
    const isCurved = curvature >= threshold;

    if (!isCurved) {
      if (active) windows.push(active);
      active = null;
      continue;
    }

    if (!active) {
      active = { startMs, endMs, peakCurvatureDegPer100m: curvature };
    } else {
      active.endMs = endMs;
      active.peakCurvatureDegPer100m = Math.max(active.peakCurvatureDegPer100m, curvature);
    }
  }
  if (active) windows.push(active);

  return windows.filter((window) => (window.endMs - window.startMs) / 1000 >= minSeconds);
}

export function isInsideLaneChangeSuppressionWindow(timestamp, windows = []) {
  const ms = Number(timestamp);
  if (!Number.isFinite(ms)) return false;
  return windows.some((window) => ms >= window.startMs && ms <= window.endMs);
}
