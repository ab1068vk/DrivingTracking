import { summarizePerformanceTriage } from '@/lib/performanceTriage';
import { createDiagnosticsHistoryStore } from '@/lib/diagnosticsHistoryStore';
import { exportP0Trace } from '@/lib/p0Probe';
import { createDiagnosticsAttribution, evidenceScopeFor, getCurrentDiagnosticsAttribution, getCurrentDiagnosticsBuildMetadata } from '@/lib/diagnosticsIdentity';
import { sanitizeCampaignExport } from '@/lib/diagnosticsCampaignSchema';

export const APP_EXPERIENCE_REPORT_KIND = 'roadsage_app_experience_diagnostics';
export const APP_EXPERIENCE_REPORT_VERSION = 2;
export const MAX_APP_EXPERIENCE_IMPORT_BYTES = 5 * 1024 * 1024;
const IMPORTED_REPORTS_KEY = 'roadsage_imported_experience_reports_v1';
const EXPERIENCE_EVENTS_KEY = 'roadsage_app_experience_events_v1';
const MAX_IMPORTED_REPORTS = 5;
const MAX_EXPERIENCE_EVENTS = 4000;
const EXPERIENCE_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
let experienceHistoryStore = null;

const finite = (value) => {
  if (value == null || value === '') return null;
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

export const collectionModeForTrip = (trip = {}) => {
  const source = String(trip.start_source || '').toLowerCase();
  const mode = String(trip.tracking_mode || '').toLowerCase();
  if (source === 'native_manual' || trip.native_manual_background === true) return 'native_manual';
  if (source === 'native_auto') return 'native_automatic';
  if (source === 'manual') return 'browser_manual';
  if (source === 'auto') return 'browser_automatic';
  if (mode === 'background_auto') return 'native_automatic';
  if (mode === 'auto_detect') return 'browser_automatic';
  if (mode === 'manual') return 'browser_manual';
  return 'unknown_legacy';
};

export const replayEvidenceStateForTrip = (trip = {}) => {
  if (trip.privacy_mode === 'summary_only') return 'privacy_excluded';
  if (trip.route_data_expired_at) return 'expired';
  if (trip.diagnostics_replay_representation === 'unavailable') return 'unavailable';
  if (trip.route_replay_available === true) return 'present';
  if (trip.projection_status === 'degraded') return 'unavailable';
  if (trip.route_replay_available === false) return 'absent';
  return 'legacy_unknown';
};

const anonymousTripShape = (trip = {}) => ({
  distance_km: round(Math.max(0, finite(trip.distance_km) || 0), 1),
  duration_minutes: Math.round(durationSecondsForTrip(trip) / 60),
  route_point_count: routePointCountForTrip(trip),
  replay_evidence_state: replayEvidenceStateForTrip(trip),
  summary_only: trip.privacy_mode === 'summary_only',
  collection_mode: collectionModeForTrip(trip),
  advanced_evidence: Boolean(
    trip.sensor_fusion_summary ||
    trip.motion_sample_count ||
    trip.obd_data_available ||
    trip.lane_change_score_enabled ||
    trip.advanced_safety_detection_enabled
  ),
});

export function buildTripDataProfile(trips = [], { window: windowInput, population: populationInput } = {}) {
  // A default parameter only covers `undefined`, so an explicit `null` reached
  // `population.available` and threw. Absent and null both mean "no window /
  // population was supplied"; neither may crash the report, and neither
  // fabricates a count — `available` stays false and the counts stay null.
  const window = windowInput ?? {};
  const population = populationInput ?? {};
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
  const replayStates = ['present', 'absent', 'expired', 'privacy_excluded', 'legacy_unknown', 'unavailable'];
  const collectionModes = ['native_automatic', 'native_manual', 'browser_automatic', 'browser_manual', 'unknown_legacy'];

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
    scope: 'bounded_window',
    window: {
      limit: Math.max(0, Math.floor(finite(window.limit) || (Array.isArray(trips) ? trips.length : 0))),
      row_count: (Array.isArray(trips) ? trips : []).length,
      has_more: window.hasMore === true,
      population_complete: window.populationComplete === true,
      page_completeness: ['EXACT', 'PARTIAL'].includes(window.completeness) ? window.completeness : null,
      source: {
        authority: safeOperation(window.snapshot?.authority || 'unknown'),
        generation: String(window.snapshot?.generation ?? '').slice(0, 180) || null,
        revision: finite(window.snapshot?.revision),
        query_id: safeOperation(window.snapshot?.queryId || ''),
      },
    },
    population: {
      available: population.available === true,
      total_trip_count: population.available === true ? Math.max(0, Math.floor(finite(population.totalTripCount) || 0)) : null,
      completed_trip_count: population.completedTripCount == null ? null : Math.max(0, Math.floor(finite(population.completedTripCount) || 0)),
      completed_count_state: safeOperation(population.completedCountState || 'unavailable'),
      reason: population.available === true ? null : safeOperation(population.reason || 'unavailable'),
      source: {
        authority: safeOperation(population.snapshot?.authority || 'unknown'),
        generation: String(population.snapshot?.generation ?? '').slice(0, 180) || null,
        revision: finite(population.snapshot?.revision),
      },
      matches_window_snapshot: population.available === true
        && population.snapshot?.generation != null && window.snapshot?.generation != null
        && population.snapshot?.revision != null && window.snapshot?.revision != null
        && String(population.snapshot?.authority ?? '') === String(window.snapshot?.authority ?? '')
        && String(population.snapshot?.generation ?? '') === String(window.snapshot?.generation ?? '')
        && Number(population.snapshot?.revision) === Number(window.snapshot?.revision),
    },
    replayable_trip_count: shapes.filter((shape) => shape.replay_evidence_state === 'present').length,
    summary_only_trip_count: shapes.filter((shape) => shape.summary_only).length,
    advanced_evidence_trip_count: shapes.filter((shape) => shape.advanced_evidence).length,
    automatic_trip_count: shapes.filter((shape) => shape.collection_mode.endsWith('_automatic')).length,
    manual_trip_count: shapes.filter((shape) => shape.collection_mode.endsWith('_manual')).length,
    replay_evidence_counts: Object.fromEntries(replayStates.map((state) => [state, shapes.filter((shape) => shape.replay_evidence_state === state).length])),
    collection_mode_counts: Object.fromEntries(collectionModes.map((mode) => [mode, shapes.filter((shape) => shape.collection_mode === mode).length])),
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

const isActualFailureEvent = (event = {}) => (
  event.severity === 'error' || ['failure', 'crash'].includes(String(event.category || '').toLowerCase())
);

const eventMatchesGroup = (key, pattern, searchable, event) => {
  if (key === 'crashes_and_failures') return isActualFailureEvent(event);
  if (key === 'freezes_and_anrs') {
    if (event.operation === 'android_ui_stall_recovered') return false;
    return ['android_ui_stall', 'android_previous_session_interrupted'].includes(event.operation)
      || (isActualFailureEvent(event) && pattern.test(searchable));
  }
  if (key === 'resource_pressure') return ['android_memory_pressure', 'android_low_memory', 'android_resource_pressure']
    .includes(event.operation) || event.category === 'resource_pressure'
    || (event.severity !== 'info' && pattern.test(searchable));
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

const safeAttribution = (value) => value ? safeOperation(value) : '';

const safeEventDetail = (details = {}) => {
  const allowedKeys = [
    'status', 'statusCode', 'duration_ms', 'result', 'count', 'trip_count', 'deleted_trip_count',
    'window_row_count',
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
      sessionId: safeAttribution(event.sessionId || event.session_id),
      buildScopeId: safeAttribution(event.buildScopeId || event.build_scope_id),
    }));
  const uniqueEvents = new Map();
  normalizedEvents.forEach((event) => {
    const key = `${event.timestamp}:${event.operation}:${event.sessionId}:${event.buildScopeId}`;
    if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
  });
  const safeEvents = [...uniqueEvents.values()]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const counts = Object.fromEntries(Object.keys(eventGroups).map((key) => [key, 0]));
  const operationCounts = {};
  safeEvents.forEach((event) => {
    const searchable = `${event.operation} ${event.category}`;
    Object.entries(eventGroups).forEach(([key, pattern]) => {
      if (eventMatchesGroup(key, pattern, searchable, event)) counts[key] += 1;
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

const entriesForScope = (entries, scope, current) => (Array.isArray(entries) ? entries : []).filter((entry) => {
  const evidenceScope = evidenceScopeFor(entry, current);
  if (scope === 'current_session') return evidenceScope === 'current_session';
  if (scope === 'current_build') return evidenceScope === 'current_session' || evidenceScope === 'current_build';
  if (scope === 'older_history') return evidenceScope === 'older_build' || evidenceScope === 'unattributed_history';
  return true;
});

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

export function buildRuntimeProfile(input = null) {
  const structured = input && typeof input === 'object'
    && ('watchdog' in input || 'runtime' in input || 'probeState' in input);
  const snapshot = structured ? input.watchdog : input;
  const runtime = structured ? (input.runtime || {}) : {};
  const platform = safeOperation(runtime.platform || input?.platform || 'unknown');
  const probeState = safeOperation(runtime.probeState || input?.probeState || (snapshot ? 'success' : 'unavailable'));
  const bridgeState = runtime.nativeBridgeAvailable === true
    ? 'available'
    : runtime.nativeBridgeAvailable === false
      ? (probeState === 'not_applicable' ? 'not_applicable' : 'unavailable')
      : 'unknown';
  const base = {
    available: Boolean(snapshot && typeof snapshot === 'object'),
    available_means: 'watchdog_snapshot',
    platform,
    native_bridge_state: bridgeState,
    probe_state: probeState,
    probe_reason: safeAttribution(runtime.reasonCode || input?.probeReason) || null,
    trip_authority: safeOperation(input?.tripAuthority || 'unknown'),
    tracking_service_state: input?.serviceEnabled === true ? 'enabled' : input?.serviceEnabled === false ? 'disabled' : 'unknown',
    watchdog_state: snapshot && typeof snapshot === 'object' ? 'available' : 'not_returned',
  };
  if (!snapshot || typeof snapshot !== 'object') return base;
  const numericKeys = [
    'memory_available_bytes', 'memory_total_bytes', 'memory_threshold_bytes',
    'heap_used_bytes', 'heap_max_bytes', 'pss_kb', 'storage_usable_bytes',
    'storage_free_bytes', 'storage_total_bytes', 'thermal_status',
    'battery_temperature_c', 'last_main_heartbeat_age_ms', 'last_heartbeat_at',
  ];
  const profile = { ...base, available: true };
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
  nativeDiagnostics = null,
  tripWindow = {},
  tripPopulation = {},
  campaignState = {},
  includeP0Raw = false,
} = {}) {
  const processAttribution = getCurrentDiagnosticsAttribution();
  const nativeBuild = nativeDiagnostics?.runtime?.build || getCurrentDiagnosticsBuildMetadata() || {};
  const current = createDiagnosticsAttribution({
    sessionId: processAttribution.sessionId,
    nativeSessionId: nativeDiagnostics?.runtime?.processSessionId || processAttribution.nativeSessionId,
    buildScopeId: nativeBuild.artifactId || processAttribution.buildScopeId,
  });
  const data = buildTripDataProfile(trips, { window: tripWindow, population: tripPopulation });
  const currentSessionPerformance = buildPerformanceProfile(entriesForScope(performanceEntries, 'current_session', current));
  const currentBuildPerformance = buildPerformanceProfile(entriesForScope(performanceEntries, 'current_build', current));
  const retainedPerformance = buildPerformanceProfile(performanceEntries);
  const olderPerformance = buildPerformanceProfile(entriesForScope(performanceEntries, 'older_history', current));
  const currentSessionActivity = buildAppActivityProfile(entriesForScope(systemEvents, 'current_session', current));
  const currentBuildActivity = buildAppActivityProfile(entriesForScope(systemEvents, 'current_build', current));
  const retainedActivity = buildAppActivityProfile(systemEvents);
  const olderActivity = buildAppActivityProfile(entriesForScope(systemEvents, 'older_history', current));
  const runtimeInput = nativeDiagnostics || nativeWatchdog;
  // The raw P0 section remains independently opt-in.
  const p0 = includeP0Raw ? exportP0Trace() : null;
  return {
    ...(p0 ? { p0 } : {}),
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
      version: String(nativeBuild.versionName || import.meta.env?.VITE_APP_VERSION || '1.0.0').slice(0, 40),
      version_name: String(nativeBuild.versionName || import.meta.env?.VITE_APP_VERSION || '1.0.0').slice(0, 40),
      version_code: finite(nativeBuild.versionCode),
      platform: safeOperation(nativeDiagnostics?.runtime?.platform || 'web'),
      build_variant: safeOperation([nativeBuild.flavor, nativeBuild.buildType].filter(Boolean).join(':') || 'web'),
      artifact_id: String(nativeBuild.artifactId || buildInfo?.sourceId || '').slice(0, 220),
      artifact_identity_state: nativeBuild.artifactId ? 'complete_packaged_inputs' : buildInfo?.sourceId ? 'source_inputs_only' : 'web_bundle_only',
      build_source_id: String(nativeBuild.sourceId || buildInfo?.sourceId || '').slice(0, 180),
      web_bundle_hash: String(buildInfo?.buildHash || '').slice(0, 128),
      web_bundle_hash_algorithm: safeOperation(buildInfo?.algorithm || ''),
      build_hash: String(buildInfo?.buildHash || '').slice(0, 128),
      experience_mode: settings?.experience_mode === 'tracking' ? 'tracking' : 'coaching',
      tracking_mode: settings?.tracking_paused === true
        ? 'paused'
        : ['manual', 'auto_detect', 'background_auto'].includes(settings?.tracking_mode)
          ? settings.tracking_mode
          : 'manual',
    },
    attribution: {
      current_session_id: current.sessionId,
      current_native_process_session_id: current.nativeSessionId || null,
      current_build_scope_id: current.buildScopeId,
      current_build_scope_kind: nativeBuild.artifactId ? 'complete_artifact' : buildInfo?.sourceId ? 'source_inputs_only' : 'web_bundle',
      retained_history_window_days: 90,
    },
    health: healthFromProfiles(currentSessionPerformance, currentSessionActivity),
    health_scopes: {
      current_session: healthFromProfiles(currentSessionPerformance, currentSessionActivity),
      current_build: healthFromProfiles(currentBuildPerformance, currentBuildActivity),
      retained_history: healthFromProfiles(retainedPerformance, retainedActivity),
    },
    data,
    performance: currentSessionPerformance,
    activity: currentSessionActivity,
    evidence_scopes: {
      current_session: { performance: currentSessionPerformance, activity: currentSessionActivity },
      current_build: { performance: currentBuildPerformance, activity: currentBuildActivity },
      older_history: { performance: olderPerformance, activity: olderActivity },
      retained_history: { performance: retainedPerformance, activity: retainedActivity },
    },
    runtime: buildRuntimeProfile(runtimeInput),
    campaign_state: sanitizeCampaignExport(campaignState),
  };
}

const sanitizeImportedReport = (report) => {
  const regenerated = /** @type {Record<string, any>} */ ({
    report_kind: APP_EXPERIENCE_REPORT_KIND,
    schema_version: APP_EXPERIENCE_REPORT_VERSION,
    generated_at: Number.isFinite(new Date(report.generated_at).getTime())
      ? new Date(report.generated_at).toISOString()
      : new Date().toISOString(),
    privacy: report.privacy && typeof report.privacy === 'object' ? report.privacy : {},
    app: {
      version: String(report.app?.version || '').slice(0, 40),
      version_name: safeAttribution(report.app?.version_name || report.app?.version),
      version_code: finite(report.app?.version_code),
      platform: safeAttribution(report.app?.platform) || 'unknown',
      build_variant: safeAttribution(report.app?.build_variant),
      artifact_id: String(report.app?.artifact_id || '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 220),
      artifact_identity_state: safeAttribution(report.app?.artifact_identity_state) || 'historical_unknown',
      build_source_id: String(report.app?.build_source_id || '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 180),
      web_bundle_hash: String(report.app?.web_bundle_hash || '').replace(/[^a-fA-F0-9]/g, '').slice(0, 128),
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
    runtime: buildRuntimeProfile({
      watchdog: report.runtime?.available === true ? report.runtime : null,
      runtime: {
        platform: report.runtime?.platform || 'unknown',
        nativeBridgeAvailable: report.runtime?.native_bridge_state === 'available' ? true
          : ['not_applicable', 'unavailable'].includes(report.runtime?.native_bridge_state) ? false : null,
        probeState: report.runtime?.probe_state || 'historical_unknown',
        reasonCode: report.runtime?.probe_reason,
      },
      tripAuthority: report.runtime?.trip_authority,
      serviceEnabled: report.runtime?.tracking_service_state === 'enabled' ? true
        : report.runtime?.tracking_service_state === 'disabled' ? false : null,
    }),
  });
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
  if (Number(report.schema_version) === APP_EXPERIENCE_REPORT_VERSION) {
    const safeWindow = buildTripDataProfile([], {
      window: {
        limit: report.data?.window?.limit,
        hasMore: report.data?.window?.has_more === true,
        populationComplete: report.data?.window?.population_complete === true,
        completeness: report.data?.window?.page_completeness,
        snapshot: {
          authority: report.data?.window?.source?.authority,
          generation: report.data?.window?.source?.generation,
          revision: report.data?.window?.source?.revision,
          queryId: report.data?.window?.source?.query_id,
        },
      },
      population: {
        available: report.data?.population?.available === true,
        totalTripCount: report.data?.population?.total_trip_count,
        completedTripCount: report.data?.population?.completed_trip_count,
        completedCountState: report.data?.population?.completed_count_state,
        reason: report.data?.population?.reason,
        snapshot: report.data?.population?.source,
      },
    });
    regenerated.data.window = { ...safeWindow.window, row_count: regenerated.data.trip_count };
    regenerated.data.population = safeWindow.population;
    regenerated.attribution = {
      current_session_id: safeAttribution(report.attribution?.current_session_id),
      current_native_process_session_id: safeAttribution(report.attribution?.current_native_process_session_id) || null,
      current_build_scope_id: String(report.attribution?.current_build_scope_id || '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 180),
      current_build_scope_kind: safeAttribution(report.attribution?.current_build_scope_kind),
      retained_history_window_days: 90,
    };
    regenerated.campaign_state = sanitizeCampaignExport(report.campaign_state);
    regenerated.evidence_scopes = Object.fromEntries(
      ['current_session', 'current_build', 'older_history', 'retained_history'].map((scope) => {
        const safe = sanitizeImportedReport({
          performance: report.evidence_scopes?.[scope]?.performance,
          activity: report.evidence_scopes?.[scope]?.activity,
        });
        return [scope, { performance: safe.performance, activity: safe.activity }];
      })
    );
    regenerated.health_scopes = Object.fromEntries(
      ['current_session', 'current_build', 'retained_history'].map((scope) => [scope,
        healthFromProfiles(regenerated.evidence_scopes[scope].performance, regenerated.evidence_scopes[scope].activity)])
    );
  } else {
    regenerated.data.scope = 'historical_unscoped_report';
  }
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
  if (![1, APP_EXPERIENCE_REPORT_VERSION].includes(Number(parsed?.schema_version))) throw new Error('This diagnostics version is not supported yet.');
  return sanitizeImportedReport(parsed);
}

const canUseStorage = () => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const mapExperienceEvent = (event) => ({
  timestamp: new Date(event.timestamp).toISOString(),
  severity: ['error', 'warn', 'info'].includes(event.severity) ? event.severity : 'info',
  category: safeOperation(event.category || 'app'),
  source: safeOperation(event.source || 'web'),
  operation: safeOperation(event.operation),
  page: safePage(event.page),
  details: safeEventDetail(event.details),
  sessionId: safeAttribution(event.sessionId || event.session_id),
  buildScopeId: safeAttribution(event.buildScopeId || event.build_scope_id),
});

const getExperienceHistoryStore = () => {
  if (experienceHistoryStore) return experienceHistoryStore;
  experienceHistoryStore = createDiagnosticsHistoryStore({
    kind: 'app_experience',
    legacyKey: EXPERIENCE_EVENTS_KEY,
    capacity: MAX_EXPERIENCE_EVENTS,
    pendingCap: 250,
    flushDelayMs: 1000,
    jobName: 'experience_events_flush',
    orderIndex: 'by_kind_ingest_seq',
    orderWidth: 2,
    direction: 'prev',
    mapLegacy: (events, nowMs) => events
      .filter((event) => Number.isFinite(new Date(event?.timestamp).getTime()))
      .filter((event) => new Date(event.timestamp).getTime() >= nowMs - EXPERIENCE_EVENT_RETENTION_MS)
      .slice(0, MAX_EXPERIENCE_EVENTS)
      .map((event) => {
        const payload = mapExperienceEvent(event);
        const payloadTimestampMs = new Date(payload.timestamp).getTime();
        return {
          payload,
          options: { payloadTimestampMs, expiresAtMs: payloadTimestampMs + EXPERIENCE_EVENT_RETENTION_MS },
        };
      })
      .reverse(),
    finalizeRead: (records, nowMs) => records
      .filter((record) => record.payloadTimestampMs >= nowMs - EXPERIENCE_EVENT_RETENTION_MS)
      .sort((left, right) => right.ingestSeq - left.ingestSeq),
  });
  return experienceHistoryStore;
};

export async function getHistoricalAppExperienceEvents(nowMs = Date.now()) {
  try {
    const records = await getExperienceHistoryStore().read({ nowMs });
    return records.map((record) => record.payload).slice(0, MAX_EXPERIENCE_EVENTS);
  } catch {
    return [];
  }
}

export function recordHistoricalAppExperienceEvent(event = {}) {
  const attribution = getCurrentDiagnosticsAttribution();
  const observedAttribution = event.attributionState === 'observed';
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
    sessionId: safeAttribution(event.sessionId || event.session_id || (observedAttribution ? '' : attribution.sessionId)),
    buildScopeId: safeAttribution(event.buildScopeId || event.build_scope_id || (observedAttribution ? '' : attribution.buildScopeId)),
  };
  if (safe.category === 'user_action' || /^user_(input|focusin|focusout|keydown|copy|cut|paste|click)$/.test(safe.operation)) return null;
  try {
    const payloadTimestampMs = new Date(safe.timestamp).getTime();
    getExperienceHistoryStore().enqueue(safe, {
      ...(event.id ? { eventUid: `app_experience:${String(event.id).slice(0, 180)}` } : {}),
      payloadTimestampMs,
      expiresAtMs: payloadTimestampMs + EXPERIENCE_EVENT_RETENTION_MS,
    });
  } catch {}
  return safe;
}

export function clearHistoricalAppExperienceEvents() {
  try {
    getExperienceHistoryStore().clear();
  } catch {}
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
