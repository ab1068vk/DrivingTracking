import { speedLimitSourceLabel } from '@/lib/speedLimitDisplay';
import { assessSpeedLimitEvidence, speedLimitConfidenceLabel } from '@/lib/speedLimitConfidence';
import { inspectSpeedKnowledgeHealth } from '@/lib/speedKnowledgeHealth';
import { buildSpeedLimitRecommendation, summarizeTripSpeedLimitIntelligence } from '@/lib/speedLimitIntelligence';

export const POSTED_SIGN_OVERRIDE_NOTE = 'Posted signs override app estimates.';

const SOURCE_GROUPS = Object.freeze({
  user_confirmed_posted_sign: 'posted',
  voice_user_posted_sign: 'posted',
  openstreetmap: 'posted',
  user_entered_estimate: 'estimated',
  user_correction: 'estimated',
  voice_user_estimate: 'estimated',
  osm_highway_default: 'estimated',
  region_default_estimate: 'estimated',
  inferred: 'estimated',
  learned_local: 'learned',
  trip_consensus: 'learned',
  time_of_day_bucket: 'learned',
  missing_posted_review: 'review',
  unknown: 'review',
});

const REVIEW_SOON_DAYS = 14;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const sourceGroup = (source) => SOURCE_GROUPS[source] || 'review';

const pointSource = (point = {}) => (
  point.speed_limit_source ?? point.limitSource ?? point.speedLimitSource ?? point.source ?? 'unknown'
);

const pointLimit = (point = {}) => finiteNumber(point.speed_limit_kmh ?? point.limitKmh ?? point.speedLimitKmh);

const correctionKey = (correction = {}, index = 0) => (
  correction.id || correction.ruleId || correction.sectionKey || correction.geohash || `rule-${index}`
);

const cellKey = (key, index = 0) => key || `cell-${index}`;

const markerReviewed = (marker = {}) => (
  marker.review_status === 'saved' ||
  marker.review_status === 'ignored' ||
  marker.reviewed_at
);

const markerLimit = (marker = {}) => finiteNumber(
  marker.limit_kmh ?? marker.limitKmh ?? marker.speed_limit_kmh ?? marker.spoken_limit_kmh
);

function formatExpiry(expiresAt, nowMs) {
  if (!expiresAt) return { status: 'active', label: 'No expiry' };
  const time = new Date(expiresAt).getTime();
  if (!Number.isFinite(time)) return { status: 'review', label: 'Expiry source unavailable' };
  if (time <= nowMs) return { status: 'expired', label: 'Expired' };
  const days = Math.ceil((time - nowMs) / 86400000);
  return {
    status: days <= REVIEW_SOON_DAYS ? 'expiring' : 'active',
    label: days <= REVIEW_SOON_DAYS ? `Expires in ${days} day${days === 1 ? '' : 's'}` : `Expires ${new Date(time).toLocaleDateString()}`,
    days,
  };
}

export function trackingSpeedSourceLabel(source, options = {}) {
  return speedLimitSourceLabel(source, options);
}

export function fallbackReasonForSpeedSource(source) {
  switch (source) {
    case 'user_confirmed_posted_sign':
    case 'voice_user_posted_sign':
      return 'User-confirmed posted sign evidence. Posted signs override app estimates.';
    case 'openstreetmap':
      return 'OpenStreetMap maxspeed evidence. Local posted signs and temporary limits still override app estimates.';
    case 'user_entered_estimate':
    case 'user_correction':
    case 'voice_user_estimate':
      return 'User-entered estimate. Confirm a posted sign when parked to raise source confidence.';
    case 'osm_highway_default':
      return 'OSM road-type estimate used where posted maxspeed was unavailable.';
    case 'region_default_estimate':
      return 'Regional default estimate used where road-specific posted data was unavailable.';
    case 'inferred':
      return 'GPS-inferred estimate used only as fallback context.';
    case 'learned_local':
    case 'trip_consensus':
    case 'time_of_day_bucket':
      return 'Learned local rule derived from local trip evidence and saved knowledge.';
    case 'missing_posted_review':
      return 'No posted-speed source confirmed for this section.';
    default:
      return 'Source unavailable or not yet classified.';
  }
}

export function speedThresholdStatus(point = {}, marginKmh = 5) {
  const speed = finiteNumber(point.speed_kmh ?? point.speedKmh);
  const limit = pointLimit(point);
  if (speed == null || limit == null) return 'source unavailable';
  return speed > limit + marginKmh ? 'threshold exceeded' : 'within recorded threshold';
}

function buildRuleRows(corrections = [], nowMs = Date.now()) {
  return corrections.map((rule, index) => {
    const source = rule.source || 'user_entered_estimate';
    const evidence = assessSpeedLimitEvidence(rule, nowMs);
    const recommendation = buildSpeedLimitRecommendation(rule);
    const expiry = formatExpiry(rule.expiresAt, nowMs);
    return {
      id: correctionKey(rule, index),
      kind: 'rule',
      roadName: rule.roadName || rule.contextLabel || rule.geohash || 'Saved road section',
      limitKmh: finiteNumber(rule.limitKmh),
      source,
      sourceLabel: trackingSpeedSourceLabel(source),
      sourceGroup: sourceGroup(source),
      confidenceLabel: speedLimitConfidenceLabel(evidence),
      confidencePercent: evidence.confidencePercent,
      authority: evidence.authority,
      needsReview: evidence.needsReview || expiry.status === 'expired' || expiry.status === 'expiring',
      expiry,
      recommendation,
      fallbackReason: fallbackReasonForSpeedSource(source),
      editHref: '/speed-limits?view=saved',
    };
  });
}

function buildCellRows(cells = {}, nowMs = Date.now()) {
  return Object.entries(cells || {}).map(([key, cell], index) => {
    const source = cell?.source || 'learned_local';
    const evidence = assessSpeedLimitEvidence(cell, nowMs);
    return {
      id: cellKey(key, index),
      kind: 'cell',
      roadName: cell?.roadName || cell?.contextLabel || key || 'Learned local cell',
      limitKmh: finiteNumber(cell?.limitKmh),
      source,
      sourceLabel: trackingSpeedSourceLabel(source),
      sourceGroup: sourceGroup(source),
      confidenceLabel: speedLimitConfidenceLabel(evidence),
      confidencePercent: evidence.confidencePercent,
      authority: evidence.authority,
      needsReview: evidence.needsReview,
      fallbackReason: fallbackReasonForSpeedSource(source),
      editHref: '/speed-limits?view=review',
    };
  });
}

function buildVoiceMarkerRows(trips = []) {
  const rows = [];
  for (const trip of trips) {
    const markers = Array.isArray(trip?.voice_speed_limit_markers) ? trip.voice_speed_limit_markers : [];
    markers.forEach((marker, index) => {
      const source = marker.source || (marker.posted === true ? 'voice_user_posted_sign' : 'voice_user_estimate');
      rows.push({
        id: `${trip.id || 'trip'}-voice-${marker.id || index}`,
        kind: 'voice_marker',
        tripId: trip.id || '',
        roadName: marker.roadName || marker.road_name || 'Voice speed marker',
        limitKmh: markerLimit(marker),
        source,
        sourceLabel: trackingSpeedSourceLabel(source),
        sourceGroup: sourceGroup(source),
        confidenceLabel: markerReviewed(marker) ? 'Reviewed' : 'Needs review',
        confidencePercent: markerReviewed(marker) ? 90 : 0,
        authority: sourceGroup(source) === 'posted' ? 'confirmed' : 'estimated',
        needsReview: !markerReviewed(marker),
        fallbackReason: fallbackReasonForSpeedSource(source),
        editHref: trip.id ? `/trips/${trip.id}?review=speed-limit-conflicts` : '/speed-limits?view=review',
      });
    });
  }
  return rows;
}

function buildSourceSummary(rows = []) {
  const bySource = new Map();
  rows.forEach((row) => {
    const current = bySource.get(row.source) || {
      source: row.source,
      sourceLabel: row.sourceLabel,
      sourceGroup: row.sourceGroup,
      count: 0,
      needsReview: 0,
      confidenceTotal: 0,
      fallbackReason: row.fallbackReason,
    };
    current.count += 1;
    current.needsReview += row.needsReview ? 1 : 0;
    current.confidenceTotal += Number(row.confidencePercent) || 0;
    bySource.set(row.source, current);
  });
  return [...bySource.values()]
    .map((item) => ({
      ...item,
      averageConfidencePercent: item.count ? Math.round(item.confidenceTotal / item.count) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.sourceLabel.localeCompare(b.sourceLabel));
}

function buildTripCoverageRows(trips = []) {
  return trips
    .filter((trip) => Array.isArray(trip?.route_points) && trip.route_points.length > 0)
    .map((trip) => {
      const summary = summarizeTripSpeedLimitIntelligence(trip);
      return {
        tripId: trip.id || '',
        tripLabel: trip.nickname || trip.tag || trip.id || 'Completed trip',
        startTime: trip.start_time || null,
        coveragePercent: summary.coveragePercent,
        verifiedCoveragePercent: summary.verifiedCoveragePercent,
        estimatedCoveragePercent: Math.max(0, summary.coveragePercent - summary.verifiedCoveragePercent),
        lowConfidencePointCount: summary.lowConfidencePointCount,
        thresholdExceededPointCount: summary.overLimitPointCount,
        maxOverKmh: summary.maxOverKmh,
        sources: summary.sources,
        recommendation: neutralizeSpeedRecommendation(summary.recommendations[0]),
        reviewHref: trip.id ? `/trips/${trip.id}?review=speed-limit-conflicts` : '/speed-limits?view=review',
        analysisHref: trip.id ? `/trips/${trip.id}/speed` : '/speed-limits?view=review',
      };
    })
    .sort((a, b) => new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime());
}

export function neutralizeSpeedRecommendation(text = '') {
  return String(text || 'Source confidence available for review.')
    .replace(/confirmed speeding/gi, 'confirmed threshold evidence')
    .replace(/over-limit areas/gi, 'threshold-exceeded areas')
    .replace(/score impact/gi, 'scoring effect');
}

export function buildTrackingSpeedConsoleData({
  trips = [],
  speedKnowledgeData = {},
  nowMs = Date.now(),
} = {}) {
  const corrections = Array.isArray(speedKnowledgeData?.corrections) ? speedKnowledgeData.corrections : [];
  const cells = speedKnowledgeData?.cells || {};
  const ruleRows = buildRuleRows(corrections, nowMs);
  const cellRows = buildCellRows(cells, nowMs);
  const voiceMarkerRows = buildVoiceMarkerRows(trips);
  const rows = [...ruleRows, ...cellRows, ...voiceMarkerRows];
  const health = inspectSpeedKnowledgeHealth({ cells, corrections }, nowMs);
  const sourceSummary = buildSourceSummary(rows);
  const tripCoverageRows = buildTripCoverageRows(trips);
  const pendingReviewRows = rows.filter((row) => row.needsReview);
  const expiringRules = ruleRows.filter((row) => row.expiry?.status === 'expiring');
  const expiredRules = ruleRows.filter((row) => row.expiry?.status === 'expired');
  const sourceCounts = rows.reduce((counts, row) => {
    counts[row.sourceGroup] = (counts[row.sourceGroup] || 0) + 1;
    return counts;
  }, { posted: 0, estimated: 0, learned: 0, review: 0 });

  return {
    safeWording: POSTED_SIGN_OVERRIDE_NOTE,
    rows,
    ruleRows,
    cellRows,
    voiceMarkerRows,
    sourceSummary,
    tripCoverageRows,
    pendingReviewRows,
    expiringRules,
    expiredRules,
    health,
    counts: {
      savedRuleCount: ruleRows.length,
      learnedCellCount: cellRows.length,
      voiceMarkerCount: voiceMarkerRows.length,
      pendingVoiceMarkerCount: voiceMarkerRows.filter((row) => row.needsReview).length,
      pendingReviewCount: pendingReviewRows.length,
      expiringRuleCount: expiringRules.length,
      expiredRuleCount: expiredRules.length,
      tripCoverageCount: tripCoverageRows.length,
      postedSourceCount: sourceCounts.posted || 0,
      estimatedSourceCount: sourceCounts.estimated || 0,
      learnedSourceCount: sourceCounts.learned || 0,
    },
  };
}
