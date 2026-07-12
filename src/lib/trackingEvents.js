import { METRIC_REGISTRY, formatDataSourceLabel } from '@/lib/metricRegistry';
import { pointTimeMs, prepareMapRoutePoints } from '@/lib/mapPlaybackInsights';
import { maskEventsForPrivacy, maskRoutePointsForPrivacy } from '@/lib/privacyZones';

const ROUTE_GAP_SECONDS = 120;
const EVENT_METRIC_KEYS = Object.freeze({
  harsh_brake: 'harsh_brakes_count',
  rapid_acceleration: 'rapid_accel_count',
  sharp_turn: 'sharp_turns_count',
  speeding: 'speeding_events_count',
  idle: 'eco_driving_score',
  heading_deviation: 'heading_deviation_count',
  heading_deviation_legacy: 'heading_deviation_legacy_count',
  stop_start_pattern: 'stop_start_pattern_count',
  tailgate_cycle: 'stop_start_pattern_count',
  erratic_speed: 'distraction_events_count',
  near_miss: 'close_proximity_count',
  close_proximity: 'close_proximity_count',
  aggressive_overtake: 'overtake_event_count',
  phone_use: 'phone_use_window_count',
  possible_crash: 'possible_crash_count',
  voice_speed_limit_marker: 'speed_limit_sources',
  route_gap: 'gps_point_count',
  privacy_gap: 'gps_point_count',
});

const EVENT_LABELS = Object.freeze({
  harsh_brake: 'Hard braking event',
  rapid_acceleration: 'Acceleration threshold exceeded',
  sharp_turn: 'Cornering threshold exceeded',
  speeding: 'Speed threshold exceeded',
  idle: 'Idle threshold exceeded',
  heading_deviation: 'GPS heading pattern recorded',
  heading_deviation_legacy: 'GPS heading pattern recorded',
  stop_start_pattern: 'Stop-start pattern recorded',
  tailgate_cycle: 'Stop-start pattern recorded',
  erratic_speed: 'Erratic speed pattern recorded',
  near_miss: 'Brake-turn manoeuvre pattern recorded',
  close_proximity: 'Brake-turn manoeuvre pattern recorded',
  aggressive_overtake: 'Overtake pattern recorded',
  phone_use: 'Phone-use window detected',
  possible_crash: 'Possible incident signal recorded',
  voice_speed_limit_marker: 'Voice speed marker recorded',
  route_gap: 'Route gap recorded',
  privacy_gap: 'Privacy gap recorded',
});

const THRESHOLD_NOTES = Object.freeze({
  harsh_brake: 'Deceleration exceeded the configured harsh-brake threshold while vehicle speed was above the minimum gate.',
  rapid_acceleration: 'Acceleration exceeded the configured rapid-acceleration threshold while vehicle speed was above the minimum gate.',
  sharp_turn: 'Lateral-g and heading-change thresholds were exceeded in the route window.',
  speeding: 'Speed exceeded the effective limit plus configured alert margin, or the fallback speed threshold.',
  idle: 'Low-speed samples continued beyond the configured idle duration threshold.',
  heading_deviation: 'GPS heading variance matched the beta heading-pattern detector.',
  heading_deviation_legacy: 'Legacy GPS heading-pattern event retained for audit.',
  stop_start_pattern: 'Speed drop and cruise windows matched the stop-start detector.',
  tailgate_cycle: 'Speed drop and cruise windows matched the stop-start detector.',
  erratic_speed: 'Speed oscillation pattern matched the GPS diagnostic detector.',
  near_miss: 'Brake and turn thresholds occurred in the same manoeuvre window.',
  close_proximity: 'Brake and turn thresholds occurred in the same manoeuvre window.',
  aggressive_overtake: 'Acceleration and straight-road gates matched the beta overtake detector.',
  phone_use: 'Foreground app evidence or GPS proxy evidence overlapped a moving trip window.',
  possible_crash: 'Impact-like motion and post-event movement signals were recorded by the incident workflow.',
  voice_speed_limit_marker: 'Voice speed marker was stored for speed-limit review.',
  route_gap: 'Timestamp gap or route-gap marker exceeded the retained-route continuity threshold.',
  privacy_gap: 'Privacy masking redacted or replaced route/event location detail.',
});

const SOURCE_FALLBACKS = Object.freeze({
  harsh_brake: 'gps_events',
  rapid_acceleration: 'gps_events',
  sharp_turn: 'gps_events',
  speeding: 'gps_events',
  idle: 'gps_events',
  heading_deviation: 'gps_events',
  heading_deviation_legacy: 'gps_events',
  stop_start_pattern: 'gps_events',
  tailgate_cycle: 'gps_events',
  erratic_speed: 'gps_events',
  near_miss: 'gps_events',
  close_proximity: 'gps_events',
  aggressive_overtake: 'gps_events',
  possible_crash: 'device_motion_imu',
  phone_use: 'phone_use_usage_access',
  voice_speed_limit_marker: 'gps_events',
  route_gap: 'gps',
  privacy_gap: 'gps',
});

const DIAGNOSTIC_TYPES = new Set([
  'aggressive_overtake',
  'heading_deviation',
  'heading_deviation_legacy',
  'route_gap',
  'privacy_gap',
]);

const titleCase = (value) => String(value || 'event')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (char) => char.toUpperCase());

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const eventTimeMs = (event = {}) => {
  const ms = new Date(event.timestamp || event.startTime || event.time || event.recorded_at || 0).getTime();
  return Number.isFinite(ms) ? ms : null;
};

const formatSpeed = (value) => {
  const speed = finiteNumber(value);
  return speed == null ? 'source unavailable' : `${Math.round(speed)} km/h`;
};

const formatValue = (event = {}) => {
  if (event.type === 'phone_use') {
    const seconds = finiteNumber(event.durationS ?? event.duration_seconds ?? event.value);
    return seconds == null ? 'window recorded' : `${Math.round(seconds)} s`;
  }
  if (event.type === 'idle') {
    const seconds = finiteNumber(event.duration_seconds ?? event.value);
    return seconds == null ? 'threshold exceeded' : `${Math.round(seconds)} s`;
  }
  if (event.type === 'speeding') return formatSpeed(event.speed_kmh ?? event.value);
  if (event.type === 'voice_speed_limit_marker') {
    const limit = finiteNumber(event.limit_kmh ?? event.speed_limit_kmh ?? event.value);
    return limit == null ? 'marker recorded' : `${Math.round(limit)} km/h`;
  }
  if (event.type === 'route_gap' || event.type === 'privacy_gap') return event.valueLabel || 'gap recorded';
  const value = finiteNumber(event.value ?? event.accel_ms2 ?? event.lateral_g);
  if (value == null) return 'event recorded';
  if (event.type === 'harsh_brake' || event.type === 'rapid_acceleration') return `${Math.round(value * 10) / 10} m/s2`;
  if (event.type === 'sharp_turn') return `${Math.round(value * 100) / 100} g`;
  return String(Math.round(value * 100) / 100);
};

const isPrivacyMasked = (item = {}) => (
  item.privacy_event_redacted === true ||
  item.masked_for_privacy === true ||
  item.privacy_gap === true ||
  item.privacy_live_redacted === true ||
  item.privacy_purged === true ||
  item.privacy_boundary === true ||
  Boolean(item.privacy_zone_id || item.privacy_zone_label) ||
  item.type === 'privacy_gap' ||
  item.lat === null ||
  item.lng === null
);

const eventSource = (event = {}) => {
  if (event.type === 'phone_use' && event.source === 'android_usage_access') return 'android_usage_access';
  if (event.type === 'phone_use' && (event.source === 'gps_proxy' || event.diagnostic_only === true)) return 'gps_proxy';
  if (event.source) return event.source;
  if (event.speed_limit_source) return event.speed_limit_source;
  return SOURCE_FALLBACKS[event.type] || 'gps_events';
};

const isDiagnosticEvent = (event = {}) => (
  event.diagnostic_only === true ||
  event.type === 'route_gap' ||
  event.type === 'privacy_gap' ||
  (event.type === 'phone_use' && eventSource(event) !== 'android_usage_access') ||
  DIAGNOSTIC_TYPES.has(event.type)
);

const confidenceLabel = (event = {}) => {
  if (event.diagnostic_only === true) return 'diagnostic';
  if (event.confidence_level) return event.confidence_level;
  if (event.zone_confidence) return event.zone_confidence;
  const confidence = finiteNumber(event.confidence ?? event.value);
  if (confidence == null || confidence <= 0) return 'source unavailable';
  if (confidence >= 0.8) return 'high';
  if (confidence >= 0.55) return 'medium';
  return 'low';
};

const limitLabel = (event = {}) => {
  const limit = finiteNumber(event.speed_limit_kmh ?? event.limit_kmh ?? event.inferred_zone_kmh);
  if (limit == null) return 'source unavailable';
  const source = event.speed_limit_source || event.limit_source || event.source;
  return `${Math.round(limit)} km/h${source ? ` / ${formatDataSourceLabel(source)}` : ''}`;
};

const relatedRoutePointForEvent = (event = {}, routePoints = []) => {
  if (!Array.isArray(routePoints) || !routePoints.length) return null;
  const explicitIndex = finiteNumber(event.point_index);
  if (explicitIndex != null && routePoints[explicitIndex]) {
    return { index: explicitIndex, point: routePoints[explicitIndex], deltaSeconds: 0 };
  }
  const targetMs = eventTimeMs(event);
  if (targetMs == null) return null;
  let best = null;
  routePoints.forEach((point, index) => {
    const ms = pointTimeMs(point);
    if (ms == null) return;
    const delta = Math.abs(ms - targetMs);
    if (!best || delta < best.deltaMs) best = { index, point, deltaMs: delta };
  });
  return best ? { index: best.index, point: best.point, deltaSeconds: Math.round(best.deltaMs / 1000) } : null;
};

const evidenceNoteForMetric = (metricKey) => {
  const metric = METRIC_REGISTRY[metricKey];
  if (!metric) return 'Evidence metadata unavailable.';
  const sources = (metric.dataSources || []).map(formatDataSourceLabel).join(', ');
  return `${metric.label}. ${metric.calibrationNote}${sources ? ` Sources: ${sources}.` : ''}`;
};

const normalizeEvent = (event = {}, index = 0, trip = {}, routePoints = []) => {
  const type = event.type || 'event';
  const source = eventSource({ ...event, type });
  const metricKey = EVENT_METRIC_KEYS[type] || null;
  const related = relatedRoutePointForEvent(event, routePoints);
  const relatedPoint = related?.point || {};
  const speed = finiteNumber(event.speed_kmh ?? event.speedKmh ?? relatedPoint.speed_kmh);
  const diagnostic = isDiagnosticEvent({ ...event, type });
  const privacyMasked = isPrivacyMasked(event);
  return {
    id: `${trip.id || 'trip'}-${type}-${event.timestamp || event.startTime || index}`,
    tripId: trip.id || '',
    tripLabel: trip.nickname || trip.tag || trip.id || 'Selected trip',
    type,
    label: EVENT_LABELS[type] || `${titleCase(type)} event recorded`,
    timestamp: event.timestamp || event.startTime || event.time || null,
    timestampMs: eventTimeMs(event) ?? Number.MAX_SAFE_INTEGER,
    value: event.value ?? event.durationS ?? event.duration_seconds ?? null,
    valueLabel: formatValue({ ...event, type }),
    speedKmh: speed,
    speedLabel: speed == null ? 'source unavailable' : `${Math.round(speed)} km/h`,
    limitLabel: limitLabel(event),
    severity: event.severity || event.risk || (diagnostic ? 'diagnostic' : 'medium'),
    confidence: confidenceLabel(event),
    source,
    sourceLabel: formatDataSourceLabel(source),
    privacyStatus: privacyMasked ? 'privacy masked' : 'retained',
    diagnostic,
    scoringStatus: diagnostic ? 'diagnostic / not scored' : 'scored evidence',
    metricKey,
    metricLabel: metricKey ? (METRIC_REGISTRY[metricKey]?.label || titleCase(metricKey)) : 'Event metric',
    evidenceNote: evidenceNoteForMetric(metricKey),
    thresholdNote: event.threshold_note || THRESHOLD_NOTES[type] || 'Event threshold metadata unavailable.',
    detectionReason: event.reason || event.detection_reason || THRESHOLD_NOTES[type] || 'Event recorded by telemetry processing.',
    dataSourceNote: source === 'gps_proxy'
      ? 'GPS diagnostic proxy; not Android Usage Access evidence.'
      : source === 'android_usage_access'
        ? 'Android Usage Access evidence recorded for the trip.'
        : `${formatDataSourceLabel(source)} telemetry.`,
    relatedRoutePoint: related ? {
      index: related.index,
      timestamp: relatedPoint.timestamp || null,
      speedKmh: finiteNumber(relatedPoint.speed_kmh),
      privacyStatus: isPrivacyMasked(relatedPoint) ? 'privacy masked' : 'retained',
      deltaSeconds: related.deltaSeconds,
    } : null,
    rawEvent: event,
  };
};

const voiceMarkerEvents = (trip = {}) => (
  (Array.isArray(trip.voice_speed_limit_markers) ? trip.voice_speed_limit_markers : []).map((marker, index) => ({
    ...marker,
    type: 'voice_speed_limit_marker',
    timestamp: marker.timestamp || marker.created_at || marker.recorded_at || marker.startTime,
    value: marker.limit_kmh ?? marker.speed_limit_kmh ?? marker.spoken_limit_kmh,
    source: marker.source || 'gps_events',
    point_index: marker.point_index ?? marker.route_point_index ?? null,
    id: marker.id || `voice-marker-${index}`,
  }))
);

const phoneEvidenceEvents = (trip = {}) => ([
  ...(Array.isArray(trip.phone_use_events) ? trip.phone_use_events : []),
  ...(Array.isArray(trip.phone_proxy_events) ? trip.phone_proxy_events : []),
]).map((event) => ({ ...event, type: 'phone_use' }));

const eventKey = (event = {}) => [
  event.type,
  event.timestamp || event.startTime || '',
  event.source || '',
  Math.round(Number(event.durationS ?? event.duration_seconds ?? event.value) || 0),
].join('|');

const uniqueEvents = (events = []) => {
  const seen = new Set();
  return events.filter((event) => {
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const routeGapEvents = (routePoints = [], trip = {}) => {
  const events = [];
  routePoints.forEach((point, index) => {
    if (index === 0) return;
    const previous = routePoints[index - 1];
    const previousMs = pointTimeMs(previous);
    const currentMs = pointTimeMs(point);
    const gapSeconds = previousMs != null && currentMs != null && currentMs > previousMs
      ? Math.round((currentMs - previousMs) / 1000)
      : null;
    const routeGap = point.tracking_gap === true || point.route_gap === true || (gapSeconds != null && gapSeconds > ROUTE_GAP_SECONDS);
    if (!routeGap) return;
    events.push({
      type: 'route_gap',
      timestamp: point.timestamp || point.time || trip.start_time,
      value: gapSeconds,
      valueLabel: gapSeconds == null ? 'route gap recorded' : `${gapSeconds} s`,
      source: 'gps',
      point_index: index,
      diagnostic_only: true,
    });
  });
  return events;
};

const privacyGapEvents = (routePoints = [], trip = {}) => (
  routePoints
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => isPrivacyMasked(point))
    .map(({ point, index }) => ({
      type: 'privacy_gap',
      timestamp: point.timestamp || point.time || trip.start_time,
      valueLabel: point.privacy_zone_label ? `privacy masked: ${point.privacy_zone_label}` : 'privacy masked',
      source: 'gps',
      point_index: index,
      diagnostic_only: true,
      masked_for_privacy: true,
      privacy_zone_label: point.privacy_zone_label,
    }))
);

export function normalizeTrackingEventRows(trip = {}, options = {}) {
  const settings = options.settings || null;
  const routePoints = settings
    ? maskRoutePointsForPrivacy(trip.route_points || [], settings)
    : (Array.isArray(trip.route_points) ? trip.route_points : []);
  const visualRoutePoints = prepareMapRoutePoints(routePoints, { maxPoints: null, smooth: false });
  const mergedEvents = uniqueEvents([
    ...(Array.isArray(trip.driving_events) ? trip.driving_events : []),
    ...phoneEvidenceEvents(trip),
    ...voiceMarkerEvents(trip),
  ]);
  const maskedEvents = settings ? maskEventsForPrivacy(mergedEvents, settings) : mergedEvents;
  return [
    ...maskedEvents.map((event, index) => normalizeEvent(event, index, trip, visualRoutePoints)),
    ...routeGapEvents(visualRoutePoints, trip).map((event, index) => normalizeEvent(event, `route-gap-${index}`, trip, visualRoutePoints)),
    ...privacyGapEvents(routePoints, trip).map((event, index) => normalizeEvent(event, `privacy-gap-${index}`, trip, visualRoutePoints)),
  ].sort((a, b) => a.timestampMs - b.timestampMs);
}

export function filterTrackingEventRows(rows = [], filters = {}) {
  const {
    eventType = 'all',
    severity = 'all',
    source = 'all',
    privacy = 'all',
    date = '',
  } = filters;
  return rows.filter((row) => {
    if (eventType !== 'all' && row.type !== eventType) return false;
    if (severity === 'diagnostic' && !row.diagnostic) return false;
    if (severity !== 'all' && severity !== 'diagnostic' && row.severity !== severity && row.confidence !== severity) return false;
    if (source !== 'all' && row.source !== source) return false;
    if (privacy === 'masked' && row.privacyStatus !== 'privacy masked') return false;
    if (privacy === 'retained' && row.privacyStatus !== 'retained') return false;
    if (date) {
      const rowDate = row.timestamp ? new Date(row.timestamp) : null;
      if (!rowDate || Number.isNaN(rowDate.getTime()) || rowDate.toISOString().slice(0, 10) !== date) return false;
    }
    return true;
  });
}

export function trackingEventTypeOptions(rows = []) {
  return [...new Set(rows.map((row) => row.type).filter(Boolean))]
    .sort()
    .map((type) => ({ value: type, label: EVENT_LABELS[type] || titleCase(type) }));
}

export function trackingEventSourceOptions(rows = []) {
  return [...new Set(rows.map((row) => row.source).filter(Boolean))]
    .sort()
    .map((source) => ({ value: source, label: formatDataSourceLabel(source) }));
}

export function formatTrackingEventTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date)
    : 'source unavailable';
}
