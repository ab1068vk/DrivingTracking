import { correctionMatchesPoint } from '@/lib/localSpeedKnowledge';
import {
  assessSpeedLimitEvidence,
  speedLimitConfidenceLabel,
} from '@/lib/speedLimitConfidence';

const pointLimit = (point = {}) => {
  const value = Number(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const pointSpeed = (point = {}) => {
  const value = Number(point.speed_kmh ?? point.speedKmh);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const pointSource = (point = {}) => (
  point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? 'unknown'
);

const pointTimestamp = (point = {}) => (
  point.timestampMs ?? point.timestamp_ms ?? point.timestamp ?? point.recorded_at ?? null
);

const pointHeading = (point = {}) => (
  point.headingDeg ?? point.heading ?? point.bearing ?? point.course ?? null
);

const publicPoint = (point = {}) => (
  Number.isFinite(Number(point.lat)) &&
  Number.isFinite(Number(point.lng)) &&
  point.privacy_export_placeholder !== true &&
  point.masked_for_privacy !== true &&
  point.privacy_gap !== true &&
  point.privacy_live_redacted !== true
);

export function speedLimitReviewPriority(item = {}, context = {}) {
  const evidence = assessSpeedLimitEvidence(item);
  const deltaKmh = Math.abs(Number(
    item.conflictDetails?.newLimitKmh -
    item.conflictDetails?.existingLimitKmh
  )) || Math.abs(Number(item.conflict?.deltaKmh)) || 0;
  const affectedTripCount = Math.max(
    0,
    Number(context.affectedTripCount ?? item.affectedTripCount) || 0
  );
  const scoreImpact = Math.abs(Number(context.scoreImpact ?? item.scoreImpact)) || 0;
  const sampleCount = Math.max(0, Number(item.sampleCount) || 0);

  let score = 0;
  if (item.conflict === true || item.conflictDetails) score += 100;
  if (item.source === 'missing_posted_review') score += 75;
  if (evidence.level === 'low') score += 35;
  if (evidence.level === 'unavailable') score += 45;
  if (evidence.stale) score += 25;
  score += Math.min(40, deltaKmh * 2);
  score += Math.min(30, affectedTripCount * 4);
  score += Math.min(25, scoreImpact * 3);
  score += Math.min(15, Math.log2(sampleCount + 1) * 4);

  return {
    score: Math.round(score),
    evidence,
    deltaKmh,
    affectedTripCount,
    scoreImpact,
    label: score >= 120 ? 'Critical review' : score >= 75 ? 'High priority' : score >= 40 ? 'Review soon' : 'Routine review',
  };
}

export function sortSpeedLimitReviewItems(items = [], contextForItem = (_item) => ({})) {
  return [...items].sort((a, b) => {
    const aPriority = speedLimitReviewPriority(a, contextForItem(a));
    const bPriority = speedLimitReviewPriority(b, contextForItem(b));
    return bPriority.score - aPriority.score ||
      (Number(b.sampleCount) || 0) - (Number(a.sampleCount) || 0);
  });
}

export function buildSpeedLimitRecommendation(record = {}, context = {}) {
  const evidence = assessSpeedLimitEvidence(record);
  const currentLimit = Number(record.limitKmh ?? record.speed_limit_kmh);
  const observedLimit = Number(
    context.observedLimitKmh ??
    record.observedLimitKmh ??
    record.conflictDetails?.newLimitKmh
  );
  const deltaKmh = Number.isFinite(currentLimit) && Number.isFinite(observedLimit)
    ? Math.abs(Math.round(currentLimit) - Math.round(observedLimit))
    : 0;

  if (evidence.expired) {
    return { kind: 'expired', action: 'Review rule', text: 'This temporary rule has expired and should no longer affect new trips.' };
  }
  if (evidence.conflict || deltaKmh > 10) {
    return {
      kind: 'conflict',
      action: 'Verify posted sign',
      text: `Saved and observed limits differ by ${Math.round(deltaKmh)} km/h. Confirm the posted sign while parked.`,
    };
  }
  if (record.source === 'missing_posted_review' || evidence.level === 'unavailable') {
    return { kind: 'missing', action: 'Set road speed', text: 'No verified speed limit covers this road section.' };
  }
  if (evidence.stale) {
    return {
      kind: 'stale',
      action: 'Reconfirm',
      text: `This ${speedLimitConfidenceLabel(evidence).toLowerCase()} rule is ${evidence.ageDays} days old.`,
    };
  }
  if (evidence.level === 'low') {
    return {
      kind: 'low_confidence',
      action: 'Confirm or edit',
      text: 'The current limit is estimated and should not be treated as posted-sign evidence.',
    };
  }
  return {
    kind: 'verified',
    action: 'No action needed',
    text: `${speedLimitConfidenceLabel(evidence)} from ${evidence.authority} evidence.`,
  };
}

export function buildCorrectionImpactPreview(trips = [], correction = {}, nextLimitKmh = null, marginKmh = 5) {
  const limit = Number(nextLimitKmh ?? correction.limitKmh);
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      affectedTripCount: 0,
      matchedPointCount: 0,
      pointsOverLimit: 0,
      affectedTrips: [],
      estimatedEventCount: 0,
    };
  }

  const affectedTrips = [];
  let matchedPointCount = 0;
  let pointsOverLimit = 0;
  let severePointCount = 0;

  for (const trip of Array.isArray(trips) ? trips : []) {
    if (trip?.status && trip.status !== 'completed') continue;
    let tripMatchedPoints = 0;
    let tripOverPoints = 0;
    let maxOverKmh = 0;
    for (const point of Array.isArray(trip?.route_points) ? trip.route_points : []) {
      if (!publicPoint(point)) continue;
      if (!correctionMatchesPoint(correction, Number(point.lat), Number(point.lng), undefined, {
        timestampMs: pointTimestamp(point),
        headingDeg: pointHeading(point),
      })) continue;
      tripMatchedPoints += 1;
      const speed = pointSpeed(point);
      if (speed != null && speed > limit + marginKmh) {
        const overKmh = speed - limit;
        tripOverPoints += 1;
        maxOverKmh = Math.max(maxOverKmh, overKmh);
        if (overKmh >= 20) severePointCount += 1;
      }
    }
    if (tripMatchedPoints > 0) {
      matchedPointCount += tripMatchedPoints;
      pointsOverLimit += tripOverPoints;
      affectedTrips.push({
        trip,
        matchedPointCount: tripMatchedPoints,
        pointsOverLimit: tripOverPoints,
        maxOverKmh: Math.round(maxOverKmh),
      });
    }
  }

  return {
    affectedTripCount: affectedTrips.length,
    matchedPointCount,
    pointsOverLimit,
    severePointCount,
    affectedTrips,
    estimatedEventCount: pointsOverLimit > 0 ? Math.max(1, Math.ceil(pointsOverLimit / 4)) : 0,
  };
}

export function summarizeTripSpeedLimitIntelligence(trip = {}, localKnowledgeResults = []) {
  const points = (Array.isArray(trip.route_points) ? trip.route_points : [])
    .map((point, sourceIndex) => ({ point, sourceIndex }))
    .filter(({ point }) => publicPoint(point));
  const sourceCounts = new Map();
  let coveredPointCount = 0;
  let confirmedPointCount = 0;
  let estimatedPointCount = 0;
  let lowConfidencePointCount = 0;
  let overLimitPointCount = 0;
  let maxOverKmh = 0;

  for (const { point, sourceIndex } of points) {
    const local = localKnowledgeResults[sourceIndex];
    const localLimit = pointLimit(local || {});
    const localSource = pointSource(local || {});
    const preferLocal = localLimit != null && ['user_confirmed_posted_sign', 'user_entered_estimate'].includes(localSource);
    const limit = preferLocal ? localLimit : pointLimit(point) ?? localLimit;
    if (limit == null) continue;
    coveredPointCount += 1;
    const source = preferLocal ? localSource : pointSource(point) !== 'unknown' ? pointSource(point) : localSource;
    const evidence = assessSpeedLimitEvidence({
      source,
      confidence: point.speed_limit_confidence,
      verifiedAt: point.speed_limit_verified_at,
    });
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    if (evidence.authority === 'confirmed' || evidence.authority === 'mapped') confirmedPointCount += 1;
    else estimatedPointCount += 1;
    if (evidence.level === 'low' || evidence.level === 'unavailable') lowConfidencePointCount += 1;
    const speed = pointSpeed(point);
    if (speed != null && speed > limit + 5) {
      overLimitPointCount += 1;
      maxOverKmh = Math.max(maxOverKmh, speed - limit);
    }
  }

  const coveragePercent = points.length ? Math.round((coveredPointCount / points.length) * 100) : 0;
  const verifiedCoveragePercent = points.length ? Math.round((confirmedPointCount / points.length) * 100) : 0;
  const recommendations = [];
  if (coveragePercent < 80) recommendations.push('Add or fetch road speeds for uncovered sections.');
  if (lowConfidencePointCount > 0) recommendations.push('Review low-confidence estimated limits before treating events as confirmed speeding.');
  if (overLimitPointCount > 0 && confirmedPointCount === 0) recommendations.push('Confirm posted signs for over-limit areas before relying on score impact.');
  if (recommendations.length === 0) recommendations.push('Speed-limit coverage is strong for this trip.');

  return {
    pointCount: points.length,
    coveredPointCount,
    confirmedPointCount,
    estimatedPointCount,
    lowConfidencePointCount,
    overLimitPointCount,
    maxOverKmh: Math.round(maxOverKmh),
    coveragePercent,
    verifiedCoveragePercent,
    sources: [...sourceCounts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count),
    recommendations,
  };
}
