// @ts-check
// Local speed-rule planner, extracted from src/pages/Dashboard.jsx.
// Pure: builds the planner view model from stored speed knowledge and the
// current location. Moved byte-identical.
import { geohashCenter } from '@/lib/localSpeedKnowledge';
import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import { formatSpeed, haversineDistance } from '@/lib/tripEngine';
import { formatWatchDistance } from '@/components/dashboard/dashboardHelpers';

export const LOCAL_SPEED_PLANNER_LIMIT = 3;
export const LOCAL_SPEED_NEARBY_RADIUS_M = 750;
export const LOCAL_SPEED_EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

export function safeSpeedPlannerCoordinate(record = {}) {
  const lat = Number(record.lat);
  const lng = Number(record.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (!record.geohash) return null;
  try {
    const center = geohashCenter(record.geohash);
    return Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng))
      ? { lat: Number(center.lat), lng: Number(center.lng) }
      : null;
  } catch {
    return null;
  }
}

export function distanceToCurrentLocationM(record = {}, currentLocation = null) {
  if (!currentLocation) return null;
  const currentLat = Number(currentLocation.lat);
  const currentLng = Number(currentLocation.lng);
  if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng)) return null;

  const sectionPoints = Array.isArray(record.sectionPoints) ? record.sectionPoints : [];
  const pointDistances = sectionPoints
    .map((point) => safeSpeedPlannerCoordinate(point))
    .filter(Boolean)
    .map((point) => haversineDistance(currentLat, currentLng, point.lat, point.lng) * 1000)
    .filter(Number.isFinite);
  if (pointDistances.length) return Math.round(Math.min(...pointDistances));

  const coordinate = safeSpeedPlannerCoordinate(record);
  if (!coordinate) return null;
  const distanceM = haversineDistance(currentLat, currentLng, coordinate.lat, coordinate.lng) * 1000;
  return Number.isFinite(distanceM) ? Math.round(distanceM) : null;
}

export function speedRuleName(record = {}) {
  return String(record.roadName || record.contextLabel || record.directionLabel || 'Saved road area').trim();
}

export function speedRuleLimitLabel(record = {}, units = 'metric') {
  const limit = Number(record.limitKmh);
  return Number.isFinite(limit) && limit > 0 ? formatSpeed(limit, units) : 'speed rule';
}

export function speedRuleExpiryLabel(expiresAt, nowMs = Date.now()) {
  const expiryMs = new Date(expiresAt || 0).getTime();
  if (!Number.isFinite(expiryMs) || expiryMs <= 0) return null;
  const remainingMs = expiryMs - nowMs;
  if (remainingMs <= 0) return 'expired';
  const days = Math.ceil(remainingMs / 86400000);
  return days <= 1 ? 'expires today' : `expires in ${days} days`;
}

export function localSpeedIssueDetail(parts = []) {
  return parts.filter(Boolean).join(' - ');
}

export function buildLocalSpeedPlanner(data = {}, {
  currentLocation = null,
  nowMs = Date.now(),
  units = 'metric',
  activeDecision = null,
} = {}) {
  const cells = Object.entries(data?.cells || {});
  const corrections = Array.isArray(data?.corrections) ? data.corrections : [];
  const issues = [];
  let nearbyRuleCount = 0;
  let reviewCount = 0;

  for (const correction of corrections) {
    const evidence = assessSpeedLimitEvidence(correction, nowMs);
    const distanceM = distanceToCurrentLocationM(correction, currentLocation);
    const isNearby = distanceM != null && distanceM <= LOCAL_SPEED_NEARBY_RADIUS_M && !evidence.expired;
    const expiryMs = new Date(correction.expiresAt || 0).getTime();
    const expiringSoon = Number.isFinite(expiryMs) &&
      expiryMs > nowMs &&
      expiryMs - nowMs <= LOCAL_SPEED_EXPIRING_SOON_MS;
    const expiryLabel = speedRuleExpiryLabel(correction.expiresAt, nowMs);
    const distanceLabel = formatWatchDistance(distanceM, units);
    const confidenceLabel = speedLimitConfidenceLabel(evidence).toLowerCase();
    const name = speedRuleName(correction);
    const limit = speedRuleLimitLabel(correction, units);

    if (isNearby) {
      nearbyRuleCount += 1;
      issues.push({
        key: `nearby:${correction.id || correction.ruleId || correction.geohash || name}`,
        priority: evidence.needsReview ? 95 : 80,
        title: `${limit} local rule nearby`,
        detail: localSpeedIssueDetail([name, distanceLabel, confidenceLabel]),
        tone: evidence.needsReview ? 'warn' : 'ok',
      });
      continue;
    }

    if (evidence.expired) {
      reviewCount += 1;
      issues.push({
        key: `expired:${correction.id || correction.ruleId || correction.geohash || name}`,
        priority: 70,
        title: 'Expired local speed rule',
        detail: localSpeedIssueDetail([name, limit, 'clean up or renew before relying on it']),
        tone: 'warn',
      });
      continue;
    }

    if (expiringSoon) {
      reviewCount += 1;
      issues.push({
        key: `expiring:${correction.id || correction.ruleId || correction.geohash || name}`,
        priority: 62,
        title: 'Temporary speed rule expiring',
        detail: localSpeedIssueDetail([name, limit, expiryLabel]),
        tone: 'warn',
      });
      continue;
    }

    if (evidence.needsReview) {
      reviewCount += 1;
      issues.push({
        key: `review:${correction.id || correction.ruleId || correction.geohash || name}`,
        priority: 50,
        title: 'Saved speed rule needs review',
        detail: localSpeedIssueDetail([name, limit, confidenceLabel]),
        tone: 'warn',
      });
    }
  }

  for (const [geohash, cell] of cells) {
    const evidence = assessSpeedLimitEvidence({ ...cell, geohash }, nowMs);
    const distanceM = distanceToCurrentLocationM({ ...cell, geohash }, currentLocation);
    const distanceLabel = formatWatchDistance(distanceM, units);
    if (cell?.conflict === true || evidence.conflict) {
      reviewCount += 1;
      issues.push({
        key: `cell-conflict:${geohash}`,
        priority: distanceM != null && distanceM <= LOCAL_SPEED_NEARBY_RADIUS_M ? 92 : 78,
        title: 'Conflicting local speed evidence',
        detail: localSpeedIssueDetail([distanceLabel, 'parked review recommended']),
        tone: 'warn',
      });
      continue;
    }
    if (evidence.needsReview && (distanceM == null || distanceM <= LOCAL_SPEED_NEARBY_RADIUS_M)) {
      reviewCount += 1;
      issues.push({
        key: `cell-review:${geohash}`,
        priority: distanceM == null ? 35 : 58,
        title: 'Low-confidence learned speed area',
        detail: localSpeedIssueDetail([distanceLabel, speedLimitConfidenceLabel(evidence).toLowerCase()]),
        tone: 'warn',
      });
    }
  }

  return {
    hasLocation: Boolean(currentLocation),
    activeDecision,
    items: issues
      .sort((a, b) => b.priority - a.priority || String(a.title).localeCompare(String(b.title)))
      .slice(0, LOCAL_SPEED_PLANNER_LIMIT),
    summary: {
      savedRuleCount: corrections.length,
      learnedCellCount: cells.length,
      nearbyRuleCount,
      reviewCount,
      confirmedCorridorCount: corrections.filter((correction) => (
        correction?.source === 'user_confirmed_posted_sign' &&
        correction?.historicalVersion !== true &&
        Array.isArray(correction?.sectionPoints) && correction.sectionPoints.length >= 2
      )).length,
    },
  };
}

export function normalizeLocalSpeedPlanner(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) {
    return {
      hasLocation: false,
      activeDecision: null,
      items: [],
      summary: {
        savedRuleCount: 0,
        learnedCellCount: 0,
        nearbyRuleCount: 0,
        reviewCount: 0,
        confirmedCorridorCount: 0,
      },
    };
  }
  return value;
}

export function buildFallbackPlannerActions(preTripRisk) {
  const actions = [];
  if (preTripRisk.dataQuality?.missingCoreSignals?.length) {
    actions.push('More trips are needed before personal time and trend signals become reliable.');
  }
  if (!preTripRisk.topSignals?.length) {
    actions.push('Mount the phone, wait for GPS to settle, and start the first minute smoothly.');
  }
  return actions.slice(0, 2);
}

