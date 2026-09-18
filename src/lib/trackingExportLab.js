import { createTripCsvWriter, tripsToCSV } from '@/lib/tripEngine';
import { createPrivacyExportSalt, maskTripForPrivacyExport } from '@/lib/privacyZones';
import { normalizeTrackingEventRows } from '@/lib/trackingEvents';
import { buildTrackingSpeedConsoleData } from '@/lib/trackingSpeedConsole';
import { formatScoreWithProvenance, SCORE_ESTIMATE_NOTICE } from '@/lib/scoreDisplay';
import { EVIDENCE_NOT_INCLUDED } from '@/lib/trackingEvidenceExport';

export const TECHNICAL_EXPORT_FORMAT = 'road-sage-tracking-technical-export';
export const TECHNICAL_EXPORT_VERSION = 1;

const UNAVAILABLE = 'unavailable';
const NOT_INCLUDED = 'not included';

/**
 * HPR-019 — which representation of a trip this record is.
 *
 * `FULL` is a canonical detail record: the payload-only fields are present, so
 * `route_points.length === 0` is a measurement. `SUMMARY` is a P7 projection row,
 * which carries aggregate counters and no payload at all, so the same expression
 * is not a measurement — it is the absence of the question. `EXTERNAL` is a
 * record whose route payload is held outside it (`browser_rsas_v1`), so an inline
 * read cannot see it either.
 *
 * `in` rather than a truthiness check, because an empty array and a missing key
 * are exactly the two cases this distinguishes.
 */
export const TRIP_EVIDENCE_REPRESENTATION = Object.freeze({
  FULL: 'full',
  SUMMARY: 'summary',
  EXTERNAL: 'external',
});

export function tripEvidenceRepresentation(trip = {}) {
  if (!trip || typeof trip !== 'object') return TRIP_EVIDENCE_REPRESENTATION.SUMMARY;
  if (trip.route_payload_storage === 'browser_rsas_v1') return TRIP_EVIDENCE_REPRESENTATION.EXTERNAL;
  return 'route_points' in trip
    ? TRIP_EVIDENCE_REPRESENTATION.FULL
    : TRIP_EVIDENCE_REPRESENTATION.SUMMARY;
}

const carriesRouteEvidence = (trip) => (
  tripEvidenceRepresentation(trip) === TRIP_EVIDENCE_REPRESENTATION.FULL
);
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
    // HPR-019: emitting nothing for a record that never carried events reads as
    // "this trip had no events". One explicit row says what actually happened, so
    // a reader of this file alone cannot mistake absence for evidence.
    carriesRouteEvidence(trip) ? normalizeTrackingEventRows(trip).map((row, index) => ({
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
    })) : [{
      row_id: 'event-not-included',
      trip_id: trip.id || UNAVAILABLE,
      trip_label: trip.nickname || trip.tag || trip.id || 'Completed trip',
      timestamp: trip.start_time || UNAVAILABLE,
      event_type: EVIDENCE_NOT_INCLUDED,
      event_label: 'Event evidence was not read for this trip',
      value: NOT_INCLUDED,
      speed_kmh: NOT_INCLUDED,
      limit_source: NOT_INCLUDED,
      confidence: NOT_INCLUDED,
      severity: NOT_INCLUDED,
      source: tripEvidenceRepresentation(trip),
      privacy_status: NOT_INCLUDED,
      scoring_status: NOT_INCLUDED,
      metric_key: NOT_INCLUDED,
      related_route_point: NOT_INCLUDED,
      related_route_point_privacy: NOT_INCLUDED,
    }]
  ));
}

export const TRIP_EVENT_CSV_HEADERS = Object.freeze([
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
]);

export function buildTripEventCsv(trips = [], settings = {}) {
  return rowsToCsv(TRIP_EVENT_CSV_HEADERS, buildTripEventExportRows(trips, settings));
}

export function buildRouteQualityRows(trips = [], settings = {}) {
  const safeTrips = privacySafeTripsForTechnicalExport(trips, settings);
  return safeTrips.map((trip) => {
    const measured = carriesRouteEvidence(trip);
    const points = measured && Array.isArray(trip.route_points) ? trip.route_points : [];
    const privacyPlaceholderCount = points.filter((point) => point?.privacy_export_placeholder === true).length;
    const privacyMaskedCount = points.filter(isPrivacyMaskedPoint).length;
    const speedSamples = points.filter((point) => finiteNumber(point?.speed_kmh ?? point?.speedKmh) != null).length;
    const speedLimitSamples = points.filter((point) => finiteNumber(point?.speed_limit_kmh ?? point?.limitKmh) != null).length;
    // HPR-019: a row built from a representation that does not carry the route
    // reports that fact. Printing `0` here was the defect: it is indistinguishable
    // from a trip whose route really was empty, and it was never a measurement.
    const countOrNotIncluded = (value) => (measured ? value : NOT_INCLUDED);
    return {
      trip_id: trip.id || UNAVAILABLE,
      start_time: trip.start_time || UNAVAILABLE,
      route_evidence: measured ? 'recorded' : NOT_INCLUDED,
      retained_route_points: countOrNotIncluded(points.length),
      raw_route_points: formatNumber(trip.route_points_raw_count ?? trip.raw_gps_point_count),
      map_playback_points: measured
        ? formatNumber(trip.route_points_map_count ?? points.length)
        : formatNumber(trip.route_points_map_count),
      route_gap_count: countOrNotIncluded(routeGapCount(points)),
      privacy_masked_samples: countOrNotIncluded(privacyMaskedCount),
      privacy_export_placeholders: countOrNotIncluded(privacyPlaceholderCount),
      speed_samples: countOrNotIncluded(speedSamples),
      speed_limit_samples: countOrNotIncluded(speedLimitSamples),
      score_estimate: formatScoreWithProvenance(trip.score_overall, trip.score_provenance, { empty: UNAVAILABLE }),
      score_label: SCORE_ESTIMATE_NOTICE,
      scoring_version: trip.score_provenance?.scoring_version || trip.scoring_version || UNAVAILABLE,
      privacy_status: measured
        ? (privacyMaskedCount > 0 ? 'privacy masked' : 'retained')
        : NOT_INCLUDED,
    };
  });
}

export const ROUTE_QUALITY_CSV_HEADERS = Object.freeze([
  { key: 'route_evidence', label: 'route_evidence' },
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
]);

export function buildRouteQualityCsv(trips = [], settings = {}) {
  return rowsToCsv(ROUTE_QUALITY_CSV_HEADERS, buildRouteQualityRows(trips, settings));
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

/**
 * HPR-019 — the per-trip half of the speed-source audit.
 *
 * `buildSpeedSourceAuditRows` maps `buildTrackingSpeedConsoleData().rows`, which
 * are built **only** from the speed-knowledge base — saved rules, learned cells
 * and road-memory candidates. The `trips` it was handed never reached its output,
 * so the page ran a whole-history scan whose result it discarded, and the file
 * named "speed-source audit" carried no per-trip speed-source evidence at all.
 * The console already computes exactly that evidence and already distinguishes
 * "coverage known" from "coverage not prepared"; this exposes those rows.
 *
 * It is representation-aware for the same reason the route rows are: coverage is
 * derived from `route_points`, so a record that does not carry them yields
 * "not included", never a confident zero.
 */
export function buildSpeedSourceCoverageRows(trips = [], settings = {}) {
  const safeTrips = privacySafeTripsForTechnicalExport(trips, settings);
  const data = buildTrackingSpeedConsoleData({ trips: safeTrips });
  const byId = new Map(data.tripCoverageRows.map((row) => [String(row.tripId), row]));
  return safeTrips.map((trip, index) => {
    const measured = carriesRouteEvidence(trip);
    const row = byId.get(String(trip.id)) || {};
    const known = measured && row.coverageKnown === true;
    const value = (input) => {
      if (!measured) return NOT_INCLUDED;
      if (!known || input == null) return UNAVAILABLE;
      return input;
    };
    return {
      row_id: `speed-coverage-${index + 1}`,
      row_kind: 'trip_coverage',
      section_label: safeSectionLabel({ tripLabel: row.tripLabel || trip.nickname || trip.tag || trip.id }),
      trip_id: trip.id || UNAVAILABLE,
      limit_kmh: UNAVAILABLE,
      source_key: 'trip_speed_limit_coverage',
      source_label: measured
        ? (known ? 'Recorded trip speed-limit coverage' : 'Coverage not prepared for this trip')
        : 'Trip speed-source evidence was not read',
      source_group: known ? 'posted' : 'review',
      confidence_label: value(row.recommendation),
      confidence_percent: value(row.coveragePercent),
      authority: measured ? (known ? 'trip_route_evidence' : UNAVAILABLE) : NOT_INCLUDED,
      needs_review: known && Number(row.lowConfidencePointCount) > 0 ? 'yes' : 'no',
      fallback_reason: value(row.verifiedCoveragePercent == null
        ? UNAVAILABLE
        : `verified ${row.verifiedCoveragePercent}% / estimated ${row.estimatedCoveragePercent}%`),
    };
  });
}

export const SPEED_SOURCE_CSV_HEADERS = Object.freeze([
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
]);

export function buildSpeedSourceAuditCsv(options = {}) {
  return rowsToCsv(SPEED_SOURCE_CSV_HEADERS, [
    ...buildSpeedSourceAuditRows(options),
    ...buildSpeedSourceCoverageRows(options.trips, options.settings),
  ]);
}

export function buildVoiceAlertLogRows({ systemLogs = [], nativeDiagnostics = {} } = {}) {
  const webRows = (Array.isArray(systemLogs) ? systemLogs : [])
    .filter((event) => /voice_alert/i.test(`${event.operation || ''} ${event.title || ''}`))
    .map((event, index) => ({
      row_id: `voice-web-${index + 1}`,
      source: event.source || 'web',
      type: event.operation || 'voice_alert',
      title: event.title || event.operation || 'Voice alert',
      detail: event.message || event.details?.reason || event.details?.channel || 'recorded',
      timestamp: event.timestamp || UNAVAILABLE,
    }));
  const nativeRows = (Array.isArray(nativeDiagnostics?.events) ? nativeDiagnostics.events : [])
    .filter((event) => /voice_alert|phone_use|speed/i.test(`${event.type || ''} ${event.title || ''}`))
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

/**
 * HPR-019 - the same trip table, written one bounded chunk at a time.
 *
 * `tripsToCSV` takes the whole array, which forced its caller to hold the whole
 * population before a single line could be written. The writer underneath it
 * already emits a header and then a line per trip, so a streaming caller keeps
 * only the lines it has produced - the file it is building - and never the trips.
 */
export function buildTechnicalTripCsvStream(settings = {}) {
  const writer = createTripCsvWriter();
  const lines = [...writer.headerLines()];
  return {
    addChunk(trips = []) {
      privacySafeTripsForTechnicalExport(trips, settings)
        .forEach((trip) => lines.push(writer.rowLine(trip)));
    },
    csv: () => lines.join('\n'),
  };
}

/** The artifact kinds this schema can describe, and what each one promises. */
export const TECHNICAL_ARTIFACT_KIND = Object.freeze({
  /** Aggregate totals over the whole population, plus a bounded row extract. */
  POPULATION_SUMMARY: 'population_summary',
  /** Every supplied trip's evidence rows are embedded in full. */
  SUPPLIED_ROWS: 'supplied_rows',
});

export const EXTRACT_ROW_LIMIT = 250;

/**
 * HPR-019 - the technical report payload, and the population it may claim.
 *
 * THE DEFECT. This was called with a literal `trips: []` from the Reports Lab
 * render path, so every count in it was zero, while the card offering the signed
 * manifest advertised the real `lifetimeTripCount`. The signature authenticated
 * the zeros. A reader holding the file and the screen was told two different
 * things about one export, and only one of them was signed.
 *
 * THE RULE. The payload states what it represents, and the statement is inside
 * the signed bytes. `population.represented_trip_count` comes from whatever
 * actually supplied the evidence - the bounded stream's own count, or the length
 * of the supplied array - and `counts.trip_count` is that same number. No path
 * lets them disagree, and the surface that displays a count reads it from here,
 * so no unsigned claim can sit beside them.
 *
 * THE BOUND. A population of any size is described by O(1) totals plus a bounded
 * extract. `route_quality_rows` used to be embedded in full; at a million trips
 * that is a million rows inside one signed JSON document. The summary path
 * embeds at most `EXTRACT_ROW_LIMIT` rows of each kind and says so.
 *
 * @param {{
 *   trips?: object[],
 *   summary?: {population: object, totals: object, extracts: object}|null,
 *   settings?: object, speedKnowledgeData?: object, systemLogs?: object[],
 *   nativeDiagnostics?: object, now?: string,
 * }} [options]
 */
export function buildTechnicalReportPayload({
  trips = [],
  summary = null,
  settings = {},
  speedKnowledgeData = {},
  systemLogs = [],
  nativeDiagnostics = {},
  now = new Date().toISOString(),
} = {}) {
  const voiceAlertRows = buildVoiceAlertLogRows({ systemLogs, nativeDiagnostics });
  const base = {
    format: TECHNICAL_EXPORT_FORMAT,
    version: TECHNICAL_EXPORT_VERSION,
    generated_at: now,
    score_notice: SCORE_ESTIMATE_NOTICE,
  };

  if (summary) {
    const { population, totals, extracts } = summary;
    const knowledgeRows = buildSpeedSourceAuditRows({ trips: [], settings, speedKnowledgeData });
    return {
      ...base,
      artifact: {
        kind: TECHNICAL_ARTIFACT_KIND.POPULATION_SUMMARY,
        evidence_source: 'canonical trip records, read one bounded chunk at a time',
        embeds_every_trip: false,
        extract_row_limit: extracts.extract_row_limit,
        route_quality_extract_truncated: extracts.route_quality_extract_truncated,
        event_extract_truncated: extracts.event_extract_truncated,
      },
      population: {
        represented_trip_count: totals.trip_count,
        complete: population.complete === true,
        source_authority: population.source?.authority ?? null,
        source_generation: population.source?.generation ?? null,
        source_revision: population.source?.revision ?? null,
      },
      evidence_totals: { ...totals },
      privacy: {
        transform: 'maskTripForPrivacyExport',
        coordinate_columns_exported: [],
        private_zone_geometry_exported: false,
        private_coordinates_exported: false,
        privacy_masked_trip_count: totals.privacy_masked_trip_count,
      },
      counts: {
        trip_count: totals.trip_count,
        event_row_count: totals.event_row_count,
        route_quality_row_count: totals.trip_count,
        speed_source_row_count: knowledgeRows.length,
        voice_alert_row_count: voiceAlertRows.length,
      },
      route_quality_rows: extracts.route_quality_rows,
      event_rows: extracts.event_rows,
      speed_source_rows: knowledgeRows.slice(0, EXTRACT_ROW_LIMIT),
      voice_alert_rows: voiceAlertRows,
    };
  }

  const routeQualityRows = buildRouteQualityRows(trips, settings);
  const eventRows = buildTripEventExportRows(trips, settings);
  const speedSourceRows = buildSpeedSourceAuditRows({ trips, settings, speedKnowledgeData });
  const privacyMaskedTrips = routeQualityRows.filter((row) => row.privacy_status === 'privacy masked').length;
  return {
    ...base,
    artifact: {
      kind: TECHNICAL_ARTIFACT_KIND.SUPPLIED_ROWS,
      evidence_source: 'trip records supplied by the caller',
      embeds_every_trip: true,
      extract_row_limit: EXTRACT_ROW_LIMIT,
      route_quality_extract_truncated: false,
      event_extract_truncated: eventRows.length > EXTRACT_ROW_LIMIT,
    },
    // A supplied array describes itself and nothing more. It never claims to be
    // the whole history, because it was not read from the population.
    population: {
      represented_trip_count: routeQualityRows.length,
      complete: false,
      source_authority: null,
      source_generation: null,
      source_revision: null,
    },
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
    event_rows: eventRows.slice(0, EXTRACT_ROW_LIMIT),
    speed_source_rows: speedSourceRows.slice(0, EXTRACT_ROW_LIMIT),
    voice_alert_rows: voiceAlertRows,
  };
}
