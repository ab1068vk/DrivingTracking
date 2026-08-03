import { summarizePerformanceTriage } from '@/lib/performanceTriage';

export const APP_EXPERIENCE_REPORT_KIND = 'roadsage_app_experience_diagnostics';
export const APP_EXPERIENCE_REPORT_VERSION = 1;
export const MAX_APP_EXPERIENCE_IMPORT_BYTES = 5 * 1024 * 1024;
const IMPORTED_REPORTS_KEY = 'roadsage_imported_experience_reports_v1';
const EXPERIENCE_EVENTS_KEY = 'roadsage_app_experience_events_v1';
const MAX_IMPORTED_REPORTS = 5;
const MAX_EXPERIENCE_EVENTS = 4000;
const EXPERIENCE_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
let pendingExperienceEvents = [];
let experienceFlushTimer = null;

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const round = (value, digits = 1) => {
  const number = finite(value) || 0;
  const multiplier = 10 ** digits;
  return Math.round(number * multiplier) / multiplier;
};

const percentile = (values, ratio) => {
  const sorted = values.map(finite).filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
};

const durationSecondsForTrip = (trip = {}) => {
  const stored = finite(trip.duration_seconds) ?? finite(trip.wall_clock_duration_seconds);
  if (stored != null) return Math.max(0, stored);
  const start = new Date(trip.start_time || 0).getTime();
  const end = new Date(trip.end_time || 0).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : 0;
};

const routePointCountForTrip = (trip = {}) => Math.max(0, Math.floor(
  finite(trip.route_points_map_count) ??
  finite(trip.route_points_raw_count) ??
  finite(trip.route_point_count) ??
  0
));

const distanceBucket = (distanceKm) => {
  if (distanceKm < 1) return 'under_1_km';
  if (distanceKm < 5) return '1_to_5_km';
  if (distanceKm < 20) return '5_to_20_km';
  if (distanceKm < 50) return '20_to_50_km';
  return '50_km_plus';
};

const safeMode = (trip = {}) => {
  const value = String(trip.start_source || trip.tracking_mode || '').toLowerCase();
  if (value.includes('auto') || value.includes('native') || value.includes('background')) return 'automatic';
  if (value.includes('manual')) return 'manual';
  return 'unknown';
};

const anonymousTripShape = (trip = {}) => ({
  distance_km: round(Math.max(0, finite(trip.distance_km) || 0), 1),
  duration_minutes: Math.round(durationSecondsForTrip(trip) / 60),
  route_point_count: routePointCountForTrip(trip),
  route_replay_available: trip.route_replay_available === true,
  summary_only: trip.privacy_mode === 'summary_only',
  collection_mode: safeMode(trip),
  advanced_evidence: Boolean(
    trip.sensor_fusion_summary ||
    trip.motion_sample_count ||
    trip.obd_data_available ||
    trip.lane_change_score_enabled ||
    trip.advanced_safety_detection_enabled
  ),
});

export function buildTripDataProfile(trips = []) {
  const completed = (Array.isArray(trips) ? trips : []).filter((trip) => trip?.status === 'completed');
  const shapes = completed.map(anonymousTripShape).sort((a, b) => (
    a.distance_km - b.distance_km || a.duration_minutes - b.duration_minutes || a.route_point_count - b.route_point_count
  ));
  const distances = shapes.map((shape) => shape.distance_km);
  const durations = shapes.map((shape) => shape.duration_minutes);
  const pointCounts = shapes.map((shape) => shape.route_point_count);
  const distanceBuckets = shapes.reduce((counts, shape) => {
    const bucket = distanceBucket(shape.distance_km);
    counts[bucket] = (counts[bucket] || 0) + 1;
    return counts;
  }, {
    under_1_km: 0,
    '1_to_5_km': 0,
    '5_to_20_km': 0,
    '20_to_50_km': 0,
    '50_km_plus': 0,
  });
  const serializedSize = completed.reduce((sum, trip) => {
    try {
      return sum + new Blob([JSON.stringify(trip)]).size;
    } catch {
      return sum;
    }
  }, 0);

  return {
    trip_count: (Array.isArray(trips) ? trips : []).length,
    completed_trip_count: completed.length,
    total_distance_km: round(distances.reduce((sum, value) => sum + value, 0), 1),
    median_distance_km: round(percentile(distances, 0.5), 1),
    p95_distance_km: round(percentile(distances, 0.95), 1),
    total_duration_hours: round(durations.reduce((sum, value) => sum + value, 0) / 60, 1),
    median_duration_minutes: Math.round(percentile(durations, 0.5)),
    total_route_point_count: pointCounts.reduce((sum, value) => sum + value, 0),
    p95_route_point_count: Math.round(percentile(pointCounts, 0.95)),
    approximate_summary_bytes: serializedSize,
    replayable_trip_count: shapes.filter((shape) => shape.route_replay_available).length,
    summary_only_trip_count: shapes.filter((shape) => shape.summary_only).length,
    advanced_evidence_trip_count: shapes.filter((shape) => shape.advanced_evidence).length,
    automatic_trip_count: shapes.filter((shape) => shape.collection_mode === 'automatic').length,
    manual_trip_count: shapes.filter((shape) => shape.collection_mode === 'manual').length,
    distance_buckets: distanceBuckets,
    anonymous_trip_shapes: shapes.slice(0, 2000),
  };
}

const eventGroups = {
  crashes_and_failures: /(crash|error|failed|failure|unhandled|rejection|possible_incident|section_crash)/i,
  freezes_and_anrs: /(anr|stall|freeze|unresponsive|previous_session_interrupted)/i,
  resource_pressure: /(low_memory|memory_pressure|thermal|storage_pressure|excessive_resource)/i,
  trip_deletions: /(trip.*delet|delet.*trip|trip_data_retention|secure_trip_deletion)/i,
  settings_changes: /(settings?_.*(change|update)|setting_changed|settings_changed)/i,
  imports_and_exports: /(import|export|backup|download)/i,
  network_responses: /(fetch|request|response|network|osrm|weather)/i,
  coaching_experience: /(coach|coaching|program|goal)/i,
  advanced_tracking: /(advanced|tracking|native|sensor|motion|obd|auto_start|auto_stop)/i,
};

const eventMatchesGroup = (key, pattern, searchable) => {
  if (key === 'freezes_and_anrs' && /android_ui_stall_recovered/i.test(searchable)) return false;
  return pattern.test(searchable);
};

const safePage = (value) => {
  const page = String(value || '').split(/[?#]/)[0];
  if (!page.startsWith('/')) return '';
  const segments = page.split('/');
  return segments.map((segment, index) => (
    index > 0 && segments[index - 1] === 'trips' ? ':id' : segment
  )).join('/').slice(0, 160);
};

const safeOperation = (value) => String(value || 'app_event')
  .replace(/[^a-zA-Z0-9._:-]/g, '_')
  .slice(0, 140);

const safeEventDetail = (details = {}) => {
  const allowedKeys = [
    'status', 'statusCode', 'duration_ms', 'result', 'count', 'trip_count', 'deleted_trip_count',
    'record_found', 'native', 'format', 'byte_count', 'log_count', 'requested_key_count',
    'persisted_matches_request', 'changed_keys', 'applied_keys', 'failed_keys', 'mode', 'source',
    'duration_ms', 'reason_code', 'reason_label', 'trim_level', 'critical', 'importance',
    'memory_available_bytes', 'memory_total_bytes', 'memory_threshold_bytes', 'memory_low',
    'heap_used_bytes', 'heap_max_bytes', 'pss_kb', 'rss_kb', 'storage_usable_bytes',
    'storage_free_bytes', 'storage_total_bytes', 'thermal_status', 'thermal_label',
    'battery_temperature_c', 'last_heartbeat_age_ms', 'previous_state', 'last_operation',
    'storage_low', 'thermal_high',
  ];
  return allowedKeys.reduce((safe, key) => {
    const value = details?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else if (typeof value === 'boolean') safe[key] = value;
    else if (Array.isArray(value) && /_keys$/.test(key)) {
      safe[key] = value.slice(0, 60).map((item) => safeOperation(item));
    } else if (typeof value === 'string' && ['status', 'result', 'format', 'mode', 'source', 'reason_label', 'thermal_label', 'previous_state'].includes(key)) {
      safe[key] = safeOperation(value);
    } else if (key === 'last_operation' && value && typeof value === 'object') {
      safe[key] = {
        operation: safeOperation(value.operation),
        phase: safeOperation(value.phase),
        pathname: safePage(value.pathname),
        timestamp: Number.isFinite(new Date(value.timestamp).getTime()) ? new Date(value.timestamp).toISOString() : null,
      };
    }
    return safe;
  }, {});
};

export function buildAppActivityProfile(events = []) {
  const normalizedEvents = (Array.isArray(events) ? events : [])
    .filter((event) => event && Number.isFinite(new Date(event.timestamp).getTime()))
    .map((event) => ({
      timestamp: new Date(event.timestamp).toISOString(),
      severity: ['error', 'warn', 'info'].includes(event.severity) ? event.severity : 'info',
      category: safeOperation(event.category || 'app'),
      source: safeOperation(event.source || 'web'),
      operation: safeOperation(event.operation || event.type),
      page: safePage(event.page),
      details: safeEventDetail(event.details || event),
    }));
  const uniqueEvents = new Map();
  normalizedEvents.forEach((event) => {
    const key = `${event.timestamp}:${event.operation}`;
    if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
  });
  const safeEvents = [...uniqueEvents.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const counts = Object.fromEntries(Object.keys(eventGroups).map((key) => [key, 0]));
  const operationCounts = {};
  safeEvents.forEach((event) => {
    const searchable = `${event.operation} ${event.category}`;
    Object.entries(eventGroups).forEach(([key, pattern]) => {
      if (eventMatchesGroup(key, pattern, searchable)) counts[key] += 1;
    });
    operationCounts[event.operation] = (operationCounts[event.operation] || 0) + 1;
  });
  const topOperations = Object.entries(operationCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25)
    .map(([operation, count]) => ({ operation, count }));
  return {
    event_count: safeEvents.length,
    error_count: safeEvents.filter((event) => event.severity === 'error').length,
    warning_count: safeEvents.filter((event) => event.severity === 'warn').length,
    counts,
    top_operations: topOperations,
    recent_important_events: safeEvents
      .filter((event) => event.severity !== 'info' || Object.values(eventGroups).some((pattern) => pattern.test(event.operation)))
      .slice(0, 300),
  };
}

const performanceDailySeries = (entries = []) => {
  const days = new Map();
  entries.forEach((entry) => {
    const date = new Date(entry?.at);
    if (!Number.isFinite(date.getTime())) return;
    const day = date.toISOString().slice(0, 10);
    const current = days.get(day) || [];
    current.push(Math.max(0, finite(entry.durationMs) || 0));
    days.set(day, current);
  });
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([day, values]) => ({
    day,
    samples: values.length,
    median_ms: round(percentile(values, 0.5), 1),
    p95_ms: round(percentile(values, 0.95), 1),
  }));
};

export function buildPerformanceProfile(entries = []) {
  const summary = summarizePerformanceTriage(entries, { limit: 40 });
  return {
    sample_count: entries.length,
    slow_operation_count: summary.filter((item) => item.status === 'slow').length,
    watch_operation_count: summary.filter((item) => item.status === 'watch').length,
    operations: summary,
    daily_series: performanceDailySeries(entries),
  };
}

const healthFromProfiles = (performance, activity) => {
  const failures = activity?.counts?.crashes_and_failures || 0;
  const freezes = activity?.counts?.freezes_and_anrs || 0;
  const resourcePressure = activity?.counts?.resource_pressure || 0;
  const slow = performance?.slow_operation_count || 0;
  const watch = performance?.watch_operation_count || 0;
  const score = Math.max(0, 100
    - Math.min(50, slow * 14)
    - Math.min(25, watch * 5)
    - Math.min(35, failures * 4)
    - Math.min(40, freezes * 12)
    - Math.min(24, resourcePressure * 6));
  const status = score >= 85 ? 'good' : score >= 65 ? 'watch' : 'slow';
  const topSlow = performance?.operations?.find((item) => item.status === 'slow');
  const headline = freezes
    ? `${freezes} Android freeze or ANR signal${freezes === 1 ? '' : 's'} need review.`
    : topSlow
    ? `${topSlow.name} is the clearest slowdown (${Math.round(topSlow.p95Ms || topSlow.maxMs)} ms p95).`
    : failures
      ? `${failures} failure event${failures === 1 ? '' : 's'} need review.`
      : performance?.sample_count
        ? 'No sustained slowdown is visible in the retained samples.'
        : 'Use the app normally to establish a performance baseline.';
  return { score, status, headline };
};

export function buildRuntimeProfile(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return { available: false };
  const numericKeys = [
    'memory_available_bytes', 'memory_total_bytes', 'memory_threshold_bytes',
    'heap_used_bytes', 'heap_max_bytes', 'pss_kb', 'storage_usable_bytes',
    'storage_free_bytes', 'storage_total_bytes', 'thermal_status',
    'battery_temperature_c', 'last_main_heartbeat_age_ms', 'last_heartbeat_at',
  ];
  const profile = { available: true };
  numericKeys.forEach((key) => {
    const value = finite(snapshot[key]);
    if (value != null) profile[key] = Math.max(0, value);
  });
  profile.memory_low = snapshot.memory_low === true;
  profile.foreground = snapshot.foreground === true;
  profile.ui_stall_active = snapshot.ui_stall_active === true;
  profile.thermal_label = safeOperation(snapshot.thermal_label || 'unknown');
  profile.last_state = safeOperation(snapshot.last_state || 'unknown');
  profile.last_operation = safeEventDetail({ last_operation: snapshot.last_operation }).last_operation || null;
  return profile;
}

export function buildAppExperienceReport({
  trips = [],
  performanceEntries = [],
  systemEvents = [],
  settings = {},
  buildInfo = {},
  nativeWatchdog = null,
} = {}) {
  const data = buildTripDataProfile(trips);
  const performance = buildPerformanceProfile(performanceEntries);
  const activity = buildAppActivityProfile(systemEvents);
  return {
    report_kind: APP_EXPERIENCE_REPORT_KIND,
    schema_version: APP_EXPERIENCE_REPORT_VERSION,
    generated_at: new Date().toISOString(),
    privacy: {
      precise_locations_included: false,
      route_geometry_included: false,
      trip_ids_included: false,
      trip_dates_included: false,
      notes_or_names_included: false,
      setting_values_included: false,
      crash_messages_or_stacks_included: false,
      anonymous_trip_shapes_are_rounded: true,
    },
    app: {
      version: String(import.meta.env?.VITE_APP_VERSION || '1.0.0').slice(0, 40),
      build_hash: String(buildInfo?.buildHash || '').slice(0, 128),
      experience_mode: settings?.experience_mode === 'tracking' ? 'tracking' : 'coaching',
      tracking_mode: settings?.tracking_paused === true
        ? 'paused'
        : ['manual', 'auto_detect', 'background_auto'].includes(settings?.tracking_mode)
          ? settings.tracking_mode
          : 'manual',
    },
    health: healthFromProfiles(performance, activity),
    data,
    performance,
    activity,
    runtime: buildRuntimeProfile(nativeWatchdog),
  };
}

const sanitizeImportedReport = (report) => {
  const regenerated = {
    report_kind: APP_EXPERIENCE_REPORT_KIND,
    schema_version: APP_EXPERIENCE_REPORT_VERSION,
    generated_at: Number.isFinite(new Date(report.generated_at).getTime())
      ? new Date(report.generated_at).toISOString()
      : new Date().toISOString(),
    privacy: report.privacy && typeof report.privacy === 'object' ? report.privacy : {},
    app: {
      version: String(report.app?.version || '').slice(0, 40),
      build_hash: String(report.app?.build_hash || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 128),
      experience_mode: report.app?.experience_mode === 'tracking' ? 'tracking' : 'coaching',
      tracking_mode: ['manual', 'auto_detect', 'background_auto', 'paused'].includes(report.app?.tracking_mode)
        ? report.app.tracking_mode
        : 'manual',
    },
    health: {
      score: Math.max(0, Math.min(100, Math.round(finite(report.health?.score) || 0))),
      status: ['good', 'watch', 'slow'].includes(report.health?.status) ? report.health.status : 'watch',
      headline: String(report.health?.headline || '').slice(0, 240),
    },
    data: buildTripDataProfile([]),
    performance: buildPerformanceProfile([]),
    activity: buildAppActivityProfile([]),
    runtime: buildRuntimeProfile(report.runtime),
  };
  const numericDataKeys = Object.keys(regenerated.data).filter((key) => typeof regenerated.data[key] === 'number');
  numericDataKeys.forEach((key) => {
    regenerated.data[key] = Math.max(0, finite(report.data?.[key]) || 0);
  });
  regenerated.data.distance_buckets = Object.fromEntries(
    Object.keys(regenerated.data.distance_buckets).map((key) => [key, Math.max(0, Math.floor(finite(report.data?.distance_buckets?.[key]) || 0))])
  );
  regenerated.data.anonymous_trip_shapes = [];
  regenerated.performance.sample_count = Math.max(0, Math.floor(finite(report.performance?.sample_count) || 0));
  regenerated.performance.slow_operation_count = Math.max(0, Math.floor(finite(report.performance?.slow_operation_count) || 0));
  regenerated.performance.watch_operation_count = Math.max(0, Math.floor(finite(report.performance?.watch_operation_count) || 0));
  regenerated.performance.operations = Array.isArray(report.performance?.operations)
    ? report.performance.operations.slice(0, 40).map((item) => ({
      name: safeOperation(item?.name),
      pathname: safePage(item?.pathname),
      count: Math.max(0, Math.floor(finite(item?.count) || 0)),
      averageMs: Math.max(0, round(item?.averageMs, 1)),
      p95Ms: Math.max(0, round(item?.p95Ms, 1)),
      maxMs: Math.max(0, round(item?.maxMs, 1)),
      status: ['good', 'watch', 'slow'].includes(item?.status) ? item.status : 'watch',
    }))
    : [];
  regenerated.performance.daily_series = [];
  regenerated.activity.event_count = Math.max(0, Math.floor(finite(report.activity?.event_count) || 0));
  regenerated.activity.error_count = Math.max(0, Math.floor(finite(report.activity?.error_count) || 0));
  regenerated.activity.warning_count = Math.max(0, Math.floor(finite(report.activity?.warning_count) || 0));
  regenerated.activity.counts = Object.fromEntries(Object.keys(eventGroups).map((key) => (
    [key, Math.max(0, Math.floor(finite(report.activity?.counts?.[key]) || 0))]
  )));
  regenerated.activity.top_operations = [];
  regenerated.activity.recent_important_events = [];
  return regenerated;
};

export function parseAppExperienceReport(text) {
  if (typeof text !== 'string') throw new Error('Choose a Road Sage diagnostics JSON file.');
  if (new Blob([text]).size > MAX_APP_EXPERIENCE_IMPORT_BYTES) throw new Error('Diagnostics files must be 5 MB or smaller.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('This diagnostics file is not valid JSON.');
  }
  if (parsed?.report_kind !== APP_EXPERIENCE_REPORT_KIND) throw new Error('This is not a Road Sage app-experience diagnostics file.');
  if (Number(parsed?.schema_version) !== APP_EXPERIENCE_REPORT_VERSION) throw new Error('This diagnostics version is not supported yet.');
  return sanitizeImportedReport(parsed);
}

const canUseStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const readStoredExperienceEvents = (nowMs = Date.now()) => {
  if (!canUseStorage()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(EXPERIENCE_EVENTS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    const cutoff = nowMs - EXPERIENCE_EVENT_RETENTION_MS;
    return parsed
      .filter((event) => Number.isFinite(new Date(event?.timestamp).getTime()))
      .filter((event) => new Date(event.timestamp).getTime() >= cutoff)
      .slice(0, MAX_EXPERIENCE_EVENTS)
      .map((event) => ({
        timestamp: new Date(event.timestamp).toISOString(),
        severity: ['error', 'warn', 'info'].includes(event.severity) ? event.severity : 'info',
        category: safeOperation(event.category || 'app'),
        source: safeOperation(event.source || 'web'),
        operation: safeOperation(event.operation),
        page: safePage(event.page),
        details: safeEventDetail(event.details),
      }));
  } catch {
    return [];
  }
};

const flushHistoricalAppExperienceEvents = () => {
  experienceFlushTimer = null;
  if (!canUseStorage() || !pendingExperienceEvents.length) return;
  const batch = pendingExperienceEvents;
  pendingExperienceEvents = [];
  try {
    localStorage.setItem(EXPERIENCE_EVENTS_KEY, JSON.stringify(
      [...batch, ...readStoredExperienceEvents()].slice(0, MAX_EXPERIENCE_EVENTS)
    ));
  } catch {
    // Historical diagnostics are best-effort and must not interfere with the app.
  }
};

export function getHistoricalAppExperienceEvents(nowMs = Date.now()) {
  const cutoff = nowMs - EXPERIENCE_EVENT_RETENTION_MS;
  return [...pendingExperienceEvents, ...readStoredExperienceEvents(nowMs)]
    .filter((event) => new Date(event.timestamp).getTime() >= cutoff)
    .slice(0, MAX_EXPERIENCE_EVENTS);
}

export function recordHistoricalAppExperienceEvent(event = {}) {
  if (!canUseStorage()) return null;
  const safe = {
    timestamp: Number.isFinite(new Date(event.timestamp).getTime())
      ? new Date(event.timestamp).toISOString()
      : new Date().toISOString(),
    severity: ['error', 'warn', 'info'].includes(event.severity) ? event.severity : 'info',
    category: safeOperation(event.category || 'app'),
    source: safeOperation(event.source || 'web'),
    operation: safeOperation(event.operation || event.type),
    page: safePage(event.page),
    details: safeEventDetail(event.details || event),
  };
  if (safe.category === 'user_action' || /^user_(input|focusin|focusout|keydown|copy|cut|paste|click)$/.test(safe.operation)) return null;
  pendingExperienceEvents.unshift(safe);
  if (pendingExperienceEvents.length > 250) pendingExperienceEvents.length = 250;
  if (!experienceFlushTimer) experienceFlushTimer = setTimeout(flushHistoricalAppExperienceEvents, 1000);
  return safe;
}

export function clearHistoricalAppExperienceEvents() {
  pendingExperienceEvents = [];
  if (experienceFlushTimer) {
    clearTimeout(experienceFlushTimer);
    experienceFlushTimer = null;
  }
  if (canUseStorage()) localStorage.removeItem(EXPERIENCE_EVENTS_KEY);
}

export function getImportedAppExperienceReports() {
  if (!canUseStorage()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(IMPORTED_REPORTS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, MAX_IMPORTED_REPORTS).map(sanitizeImportedReport) : [];
  } catch {
    return [];
  }
}

export function saveImportedAppExperienceReport(report) {
  const safe = sanitizeImportedReport(report);
  const next = [safe, ...getImportedAppExperienceReports()
    .filter((item) => item.generated_at !== safe.generated_at)]
    .slice(0, MAX_IMPORTED_REPORTS);
  if (canUseStorage()) localStorage.setItem(IMPORTED_REPORTS_KEY, JSON.stringify(next));
  return next;
}

export function clearImportedAppExperienceReports() {
  if (canUseStorage()) localStorage.removeItem(IMPORTED_REPORTS_KEY);
}
