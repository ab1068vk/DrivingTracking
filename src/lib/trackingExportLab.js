import { tripsToCSV } from '@/lib/tripEngine';
import { createPrivacyExportSalt, maskTripForPrivacyExport } from '@/lib/privacyZones';
import { normalizeTrackingEventRows } from '@/lib/trackingEvents';
import { buildTrackingSpeedConsoleData } from '@/lib/trackingSpeedConsole';
import { formatScoreWithProvenance, SCORE_ESTIMATE_NOTICE } from '@/lib/scoreDisplay';

export const TECHNICAL_EXPORT_FORMAT = 'road-sage-tracking-technical-export';
export const TECHNICAL_EXPORT_VERSION = 1;

const UNAVAILABLE = 'unavailable';
const ROUTE_GAP_SECONDS = 120;

const coordinateKeyPattern = /(^|_)(lat|lng|lon|longitude|latitude|radius|zone_radius|privacy_radius)(_m)?$/i;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const csvEscape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const pointTimeMs = (point = {}) => {
  const ms = new Date(point.timestamp || point.time || 0).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const isPrivacyMaskedPoint = (point = {}) => (
  point.privacy_export_placeholder === true ||
  point.masked_for_privacy === true ||
  point.privacy_gap === true ||
  point.privacy_boundary === true ||
  point.lat == null ||
  point.lng == null
);

const routeGapCount = (points = []) => {
  let count = 0;
  points.forEach((point, index) => {
    if (point?.route_gap === true || point?.tracking_gap === true) count += 1;
    if (index === 0) return;
    const previousMs = pointTimeMs(points[index - 1]);
    const currentMs = pointTimeMs(point);
    if (previousMs != null && currentMs != null && currentMs - previousMs > ROUTE_GAP_SECONDS * 1000) {
      count += 1;
    }
  });
  return count;
};

const formatNumber = (value, decimals = 0) => {
  const number = finiteNumber(value);
  if (number == null) return UNAVAILABLE;
  return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
};

const safeSectionLabel = (row = {}) => {
  if (row.kind === 'cell') return 'Learned local speed cell';
  const label = row.roadName || row.tripLabel || row.id || 'Speed source';
  return /^[0-9bcdefghjkmnpqrstuvwxyz]{5,}$/i.test(String(label)) ? 'Local speed section' : label;
};

export function rowsToCsv(headers = [], rows = []) {
  const keys = headers.map((header) => header.key);
  return [
    headers.map((header) => csvEscape(header.label)).join(','),
    ...rows.map((row) => keys.map((key) => csvEscape(row[key])).join(',')),
  ].join('\n');
}

export function assertNoCoordinateColumns(rows = []) {
  const offending = new Set();
  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      if (coordinateKeyPattern.test(key)) offending.add(key);
    });
  });
  return {
    valid: offending.size === 0,
    offendingKeys: [...offending].sort(),
  };
}

export function privacySafeTripsForTechnicalExport(trips = [], settings = {}) {
  const exportSalt = createPrivacyExportSalt();
  return (Array.isArray(trips) ? trips : [])
    .filter((trip) => trip?.status === 'completed' || trip?.status == null)
    .map((trip) => maskTripForPrivacyExport(trip, settings, exportSalt));
}

export function buildTripEventExportRows(trips = [], settings = {}) {
  const safeTrips = privacySafeTripsForTechnicalExport(trips, settings);
  return safeTrips.flatMap((trip) => (
    normalizeTrackingEventRows(trip).map((row, index) => ({
      row_id: `event-${index + 1}`,
      trip_id: trip.id || row.tripId || UNAVAILABLE,
      trip_label: trip.nickname || trip.tag || trip.id || 'Completed trip',
      timestamp: row.timestamp || UNAVAILABLE,
      event_type: row.type,
      event_label: row.label,
      value: row.valueLabel,
      speed_kmh: row.speedKmh == null ? UNAVAILABLE : Math.round(row.speedKmh),
      limit_source: row.limitLabel,
      confidence: row.confidence,
      severity: row.severity,
      source: row.sourceLabel,
      privacy_status: row.privacyStatus,
      scoring_status: row.scoringStatus,
      metric_key: row.metricKey || UNAVAILABLE,
      related_route_point: row.relatedRoutePoint?.index ?? UNAVAILABLE,
      related_route_point_privacy: row.relatedRoutePoint?.privacyStatus || UNAVAILABLE,
    }))
  ));
}

export function buildTripEventCsv(trips = [], settings = {}) {
  return rowsToCsv([
    { key: 'trip_id', label: 'trip_id' },
    { key: 'timestamp', label: 'timestamp' },
    { key: 'event_type', label: 'event_type' },
    { key: 'event_label', label: 'event_label' },
    { key: 'value', label: 'value' },
    { key: 'speed_kmh', label: 'speed_kmh' },
    { key: 'limit_source', label: 'limit_source' },
    { key: 'confidence', label: 'confidence' },
    { key: 'severity', label: 'severity' },
    { key: 'source', label: 'source' },
    { key: 'privacy_status', label: 'privacy_status' },
    { key: 'scoring_status', label: 'scoring_status' },
    { key: 'metric_key', label: 'metric_key' },
    { key: 'related_route_point', label: 'related_route_point' },
    { key: 'related_route_point_privacy', label: 'related_route_point_privacy' },
  ], buildTripEventExportRows(trips, settings));
}

export function buildRouteQualityRows(trips = [], settings = {}) {
  const safeTrips = privacySafeTripsForTechnicalExport(trips, settings);
  return safeTrips.map((trip) => {
    const points = Array.isArray(trip.route_points) ? trip.route_points : [];
    const privacyPlaceholderCount = points.filter((point) => point?.privacy_export_placeholder === true).length;
    const privacyMaskedCount = points.filter(isPrivacyMaskedPoint).length;
    const speedSamples = points.filter((point) => finiteNumber(point?.speed_kmh ?? point?.speedKmh) != null).length;
    const speedLimitSamples = points.filter((point) => finiteNumber(point?.speed_limit_kmh ?? point?.limitKmh) != null).length;
    return {
      trip_id: trip.id || UNAVAILABLE,
      start_time: trip.start_time || UNAVAILABLE,
      retained_route_points: points.length,
      raw_route_points: formatNumber(trip.route_points_raw_count ?? trip.raw_gps_point_count),
      map_playback_points: formatNumber(trip.route_points_map_count ?? points.length),
      route_gap_count: routeGapCount(points),
      privacy_masked_samples: privacyMaskedCount,
      privacy_export_placeholders: privacyPlaceholderCount,
      speed_samples: speedSamples,
      speed_limit_samples: speedLimitSamples,
      score_estimate: formatScoreWithProvenance(trip.score_overall, trip.score_provenance, { empty: UNAVAILABLE }),
      score_label: SCORE_ESTIMATE_NOTICE,
      scoring_version: trip.score_provenance?.scoring_version || trip.scoring_version || UNAVAILABLE,
      privacy_status: privacyMaskedCount > 0 ? 'privacy masked' : 'retained',
    };
  });
}

export function buildRouteQualityCsv(trips = [], settings = {}) {
  return rowsToCsv([
    { key: 'trip_id', label: 'trip_id' },
    { key: 'start_time', label: 'start_time' },
    { key: 'retained_route_points', label: 'retained_route_points' },
    { key: 'raw_route_points', label: 'raw_route_points' },
    { key: 'map_playback_points', label: 'map_playback_points' },
    { key: 'route_gap_count', label: 'route_gap_count' },
    { key: 'privacy_masked_samples', label: 'privacy_masked_samples' },
    { key: 'privacy_export_placeholders', label: 'privacy_export_placeholders' },
    { key: 'speed_samples', label: 'speed_samples' },
    { key: 'speed_limit_samples', label: 'speed_limit_samples' },
    { key: 'score_estimate', label: 'score_estimate' },
    { key: 'score_label', label: 'score_label' },
    { key: 'scoring_version', label: 'scoring_version' },
    { key: 'privacy_status', label: 'privacy_status' },
  ], buildRouteQualityRows(trips, settings));
}

export function buildSpeedSourceAuditRows({
  trips = [],
  settings = {},
  speedKnowledgeData = {},
  nowMs = Date.now(),
} = {}) {
  const safeTrips = privacySafeTripsForTechnicalExport(trips, settings);
  const data = buildTrackingSpeedConsoleData({ trips: safeTrips, speedKnowledgeData, nowMs });
  return data.rows.map((row, index) => ({
    row_id: `speed-source-${index + 1}`,
    row_kind: row.kind,
    section_label: safeSectionLabel(row),
    trip_id: row.tripId || UNAVAILABLE,
    limit_kmh: row.limitKmh == null ? UNAVAILABLE : Math.round(row.limitKmh),
    source_key: row.source,
    source_label: row.sourceLabel,
    source_group: row.sourceGroup,
    confidence_label: row.confidenceLabel,
    confidence_percent: row.confidencePercent,
    authority: row.authority,
    needs_review: row.needsReview ? 'yes' : 'no',
    fallback_reason: row.fallbackReason,
  }));
}

export function buildSpeedSourceAuditCsv(options = {}) {
  return rowsToCsv([
    { key: 'row_id', label: 'row_id' },
    { key: 'row_kind', label: 'row_kind' },
    { key: 'section_label', label: 'section_label' },
    { key: 'trip_id', label: 'trip_id' },
    { key: 'limit_kmh', label: 'limit_kmh' },
    { key: 'source_key', label: 'source_key' },
    { key: 'source_label', label: 'source_label' },
    { key: 'source_group', label: 'source_group' },
    { key: 'confidence_label', label: 'confidence_label' },
    { key: 'confidence_percent', label: 'confidence_percent' },
    { key: 'authority', label: 'authority' },
    { key: 'needs_review', label: 'needs_review' },
    { key: 'fallback_reason', label: 'fallback_reason' },
  ], buildSpeedSourceAuditRows(options));
}

export function buildVoiceAlertLogRows({ systemLogs = [], nativeDiagnostics = {} } = {}) {
  const webRows = (Array.isArray(systemLogs) ? systemLogs : [])
    .filter((event) => /voice_alert|voice_speed_marker/i.test(`${event.operation || ''} ${event.title || ''}`))
    .map((event, index) => ({
      row_id: `voice-web-${index + 1}`,
      source: event.source || 'web',
      type: event.operation || 'voice_alert',
      title: event.title || event.operation || 'Voice alert',
      detail: event.message || event.details?.reason || event.details?.channel || 'recorded',
      timestamp: event.timestamp || UNAVAILABLE,
    }));
  const nativeRows = (Array.isArray(nativeDiagnostics?.events) ? nativeDiagnostics.events : [])
    .filter((event) => /voice_alert|voice_speed_marker|phone_use|speed/i.test(`${event.type || ''} ${event.title || ''}`))
    .map((event, index) => ({
      row_id: `voice-android-${index + 1}`,
      source: 'android',
      type: event.type || 'native_diagnostic',
      title: event.title || event.type || 'Native diagnostic',
      detail: event.reason || event.detail || event.source || 'recorded',
      timestamp: event.timestamp || event.timestamp_ms || event.time || UNAVAILABLE,
    }));
  return [...webRows, ...nativeRows].slice(0, 200);
}

export function buildVoiceAlertLogCsv(options = {}) {
  return rowsToCsv([
    { key: 'row_id', label: 'row_id' },
    { key: 'timestamp', label: 'timestamp' },
    { key: 'source', label: 'source' },
    { key: 'type', label: 'type' },
    { key: 'title', label: 'title' },
    { key: 'detail', label: 'detail' },
  ], buildVoiceAlertLogRows(options));
}

export function buildTechnicalTripCsv(trips = [], settings = {}) {
  return tripsToCSV(privacySafeTripsForTechnicalExport(trips, settings));
}

export function buildTechnicalReportPayload({
  trips = [],
  settings = {},
  speedKnowledgeData = {},
  systemLogs = [],
  nativeDiagnostics = {},
  now = new Date().toISOString(),
} = {}) {
  const routeQualityRows = buildRouteQualityRows(trips, settings);
  const eventRows = buildTripEventExportRows(trips, settings);
  const speedSourceRows = buildSpeedSourceAuditRows({ trips, settings, speedKnowledgeData });
  const voiceAlertRows = buildVoiceAlertLogRows({ systemLogs, nativeDiagnostics });
  const privacyMaskedTrips = routeQualityRows.filter((row) => row.privacy_status === 'privacy masked').length;
  return {
    format: TECHNICAL_EXPORT_FORMAT,
    version: TECHNICAL_EXPORT_VERSION,
    generated_at: now,
    score_notice: SCORE_ESTIMATE_NOTICE,
    privacy: {
      transform: 'maskTripForPrivacyExport',
      coordinate_columns_exported: [],
      private_zone_geometry_exported: false,
      private_coordinates_exported: false,
      privacy_masked_trip_count: privacyMaskedTrips,
    },
    counts: {
      trip_count: routeQualityRows.length,
      event_row_count: eventRows.length,
      route_quality_row_count: routeQualityRows.length,
      speed_source_row_count: speedSourceRows.length,
      voice_alert_row_count: voiceAlertRows.length,
    },
    route_quality_rows: routeQualityRows,
    event_rows: eventRows.slice(0, 250),
    speed_source_rows: speedSourceRows.slice(0, 250),
    voice_alert_rows: voiceAlertRows,
  };
}
