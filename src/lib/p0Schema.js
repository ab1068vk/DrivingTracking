/**
 * P0 instrumentation schema — the single allowlist for keys *and* values.
 *
 * Everything the P0 probe can export is declared here. `p0ExportPrivacy.test.js`
 * validates the serialized export against these tables, so schema and test cannot
 * drift apart.
 *
 * This module is imported by `p0Probe.js`, which `main.jsx` initializes before
 * anything else. It therefore deliberately has **no imports**: pulling
 * `trackingStore` / `privacyZones` / `speedKnowledgeRepository` in here just to
 * read a key constant would drag those modules into the probe's startup graph and
 * perturb the very boot path P0 measures. The storage-key literals below are
 * mirrored from their owning modules and `p0Schema.test.js`-style assertions in
 * `p0ProbeArms.test.js` pin them to the real exports so they cannot drift.
 */

export const P0_SCHEMA_VERSION = 1;

/**
 * Whole-span wall/performance divergence beyond this marks every phase in the
 * span `clock_suspect` and excludes it from Long Task correlation. Frozen and
 * exported so the boundary is testable (below / at / above).
 */
export const CLOCK_SUSPECT_THRESHOLD_MS = 250;

/** Scheduling gaps below this are not recorded at all. */
export const SCHEDULING_GAP_THRESHOLD_MS = 250;

/** Probe writer / observer self-timing sample rate (1-in-N). */
export const SELF_TIME_SAMPLE_RATE = 32;

export const RUN_MARKER_PATTERN = /^[a-z0-9_-]{1,64}$/;

/** @param {unknown} value */
export const isValidRunMarker = (value) => (
  typeof value === 'string' && RUN_MARKER_PATTERN.test(value)
);

/**
 * Build tokens are commit-ish/version-ish identifiers only. Constrained to a
 * grammar so the export's single key-and-value allowlist cannot be used to
 * smuggle arbitrary caller-supplied content through `meta.build_hash`.
 */
export const BUILD_HASH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** @param {unknown} value */
export const isValidBuildHash = (value) => (
  typeof value === 'string' && BUILD_HASH_PATTERN.test(value)
);

/**
 * Column stores are typed arrays, so "not measured" cannot be stored as `null`
 * in the ring. It is stored as this sentinel and converted to `null` at the
 * export boundary for every field listed in the nullable tables below — a
 * measurement that does not exist must never export as a number that looks like
 * one.
 */
export const UNAVAILABLE_SENTINEL = -1;

// ---------------------------------------------------------------------------
// Enumerations. Anything not listed collapses to a fallback rather than being
// echoed into the export.
// ---------------------------------------------------------------------------

export const SPAN_KINDS = Object.freeze([
  'secure_call',
  'logical_payload',
  'diagnostics_job',
  'watchdog_checkpoint',
  'measure',
]);

/** Synchronous phases — eligible for Long Task blocked-time coverage. */
export const SYNC_PHASE_IDS = Object.freeze([
  'logical_stringify',
  'req_json',
  'req_encode',
  'wc_encrypt_invoke',
  'req_b64_iv',
  'req_b64_data',
  'native_invoke',
  'res_b64_iv',
  'res_b64_data',
  'wc_decrypt_invoke',
  'res_decode',
  'res_json',
  'logical_parse',
  // Diagnostics-store synchronous work.
  'diag_get',
  'diag_parse',
  'diag_transform',
  'diag_prune_a',
  'diag_prune_b',
  'diag_stringify',
  'diag_set',
]);

/** Latency phases — never assigned CPU ownership. */
export const LATENCY_PHASE_IDS = Object.freeze([
  'queue_wait',
  'session_wait',
  'wc_encrypt_await',
  'native_await',
  'wc_decrypt_await',
]);

export const PHASE_IDS = Object.freeze([...SYNC_PHASE_IDS, ...LATENCY_PHASE_IDS]);

const SYNC_PHASE_SET = new Set(SYNC_PHASE_IDS);
const PHASE_SET = new Set(PHASE_IDS);

/** @param {string} phaseId */
export const isSyncPhase = (phaseId) => SYNC_PHASE_SET.has(phaseId);
/** @param {string} phaseId */
export const isKnownPhase = (phaseId) => PHASE_SET.has(phaseId);

/**
 * Secure-bridge methods we are willing to name in an export. Anything else is
 * recorded as `other` so a future plugin method name cannot leak through.
 */
// `other` is a real member, not an index-0 fallback: collapsing an unknown
// method onto the first entry would silently file it as `initSession` and
// corrupt the per-method breakdown.
export const SECURE_METHODS = Object.freeze([
  'other',
  'initSession',
  'echo',
  'setPreference',
  'encryptSensitivePayload',
  'decryptSensitivePayload',
  'ensureSensitivePayloadKey',
  'deleteSensitivePayloadKey',
]);

const SECURE_METHOD_SET = new Set(SECURE_METHODS);

/** @param {unknown} method */
export const safeSecureMethod = (method) => (
  typeof method === 'string' && SECURE_METHOD_SET.has(method) ? method : 'other'
);

export const SECURE_PLUGINS = Object.freeze(['other', 'SecureBridge']);
const SECURE_PLUGIN_SET = new Set(SECURE_PLUGINS);

/** @param {unknown} pluginName */
export const safeSecurePlugin = (pluginName) => (
  typeof pluginName === 'string' && SECURE_PLUGIN_SET.has(pluginName) ? pluginName : 'other'
);

export const PAYLOAD_KINDS = Object.freeze([
  'trip_summary',
  'trip_detail',
  'active_trip',
  'speed_geometry',
  'speed_knowledge',
  'privacy',
  'other',
]);

// Mirrored storage-key / context literals. See the module comment above for why
// these are not imported. Pinned to their owning exports by test.
const ACTIVE_TRIP_KEY = 'drivesense_active_trip';                          // trackingStore.js
const SPEED_GEOMETRY_INDEX_KEY = 'drivesense_speed_geometry_index_v1';     // speedGeometryIndex.js
const SPEED_KNOWLEDGE_KEY_PREFIX = 'speed_knowledge_';                     // speedKnowledgeRepository.js
const SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY = 'speed_knowledge_native_mirror_v1';
const SPEED_KNOWLEDGE_DB_PREFIX = 'indexeddb:drivesense_speed_knowledge/'; // speedKnowledgeRepository.js
const NATIVE_PRIVACY_ZONES_CONTEXT = 'native:privacy_zones_v1';            // privacyZones.js

/**
 * Collapse an encryption context to a fixed enum. The caller derives this and
 * then **discards the raw context** — contexts embed trip ids and storage keys
 * and must never reach the export.
 *
 * @param {unknown} context
 * @returns {string} one of PAYLOAD_KINDS
 */
export function payloadKindForContext(context) {
  const value = typeof context === 'string' ? context : '';
  if (!value) return 'other';

  // Order matters: `trip-summary:` must be tested before `trip:` would ever be
  // reached, and both are exact prefixes rather than substring matches.
  if (value.startsWith('trip-summary:')) return 'trip_summary';
  if (value.startsWith('trip:')) return 'trip_detail';

  if (value.startsWith(SPEED_KNOWLEDGE_DB_PREFIX)) return 'speed_knowledge';

  if (value.startsWith('storage:')) {
    const key = value.slice('storage:'.length);
    if (key === ACTIVE_TRIP_KEY) return 'active_trip';
    if (key === SPEED_GEOMETRY_INDEX_KEY) return 'speed_geometry';
    if (key === SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY) return 'speed_knowledge';
    if (key.startsWith(SPEED_KNOWLEDGE_KEY_PREFIX)) return 'speed_knowledge';
    return 'other';
  }

  if (value === NATIVE_PRIVACY_ZONES_CONTEXT || value.startsWith('privacy-intelligence:')) {
    return 'privacy';
  }

  return 'other';
}

/**
 * Long Task `name` and container type are echoed only from these fixed sets.
 * Container *name*, *src*, *id* and attribution URLs are never recorded — they
 * can carry arbitrary DOM content.
 */
export const LONG_TASK_NAMES = Object.freeze([
  'self',
  'same-origin',
  'same-origin-ancestor',
  'same-origin-descendant',
  'cross-origin-ancestor',
  'cross-origin-descendant',
  'cross-origin-unreachable',
  'multiple-contexts',
  'unknown',
]);

const LONG_TASK_NAME_SET = new Set(LONG_TASK_NAMES);

/** @param {unknown} name */
export const safeLongTaskName = (name) => (
  typeof name === 'string' && LONG_TASK_NAME_SET.has(name) ? name : 'unknown'
);

export const LONG_TASK_CONTAINER_TYPES = Object.freeze([
  'window',
  'iframe',
  'embed',
  'object',
  'unknown',
]);

const LONG_TASK_CONTAINER_TYPE_SET = new Set(LONG_TASK_CONTAINER_TYPES);

/** @param {unknown} containerType */
export const safeLongTaskContainerType = (containerType) => (
  typeof containerType === 'string' && LONG_TASK_CONTAINER_TYPE_SET.has(containerType)
    ? containerType
    : 'unknown'
);

export const LIFECYCLE_SOURCES = Object.freeze(['visibilitychange', 'appStateChange']);
export const LIFECYCLE_STATES = Object.freeze(['visible', 'hidden', 'active', 'inactive']);

export const DIAGNOSTICS_JOBS = Object.freeze([
  'other',
  'performance_triage_persist',
  'system_log_flush',
  'system_log_get',
  'system_log_write',
  'experience_events_read',
  'experience_events_flush',
  'watchdog_checkpoint',
]);

const DIAGNOSTICS_JOB_SET = new Set(DIAGNOSTICS_JOBS);

/** @param {unknown} job */
export const safeDiagnosticsJob = (job) => (
  typeof job === 'string' && DIAGNOSTICS_JOB_SET.has(job) ? job : 'other'
);

export const ARMS = Object.freeze(['A', 'B', 'C', 'D']);

// ---------------------------------------------------------------------------
// Ring budgets. Fixed circular buffers — never `Array.shift`, never whole-array
// spreading. Overflow drops the oldest row and increments an exported counter.
// ---------------------------------------------------------------------------

export const RING_CAPACITY = Object.freeze({
  spans: 20000,
  phases: 60000,
  longTasks: 5000,
  schedulingGaps: 5000,
  lifecycleEvents: 2000,
  nativeBlocks: 20000,
});

/**
 * Per-job capacity of the volatile suppressed-work buffers used by arms B/C.
 *
 * Arms B/C never persist new diagnostics, so the already-collected batch is
 * moved into a bounded in-memory buffer instead. The buffer is volatile by
 * design — never written to storage, never serialized into the export. Only its
 * *counters* are exported, because the entries themselves are real user
 * diagnostics (log messages, page paths, event details) and have no place in a
 * P0 trace.
 *
 * Bounded, and overflow is counted rather than silently dropped: a suppressed
 * run that overflowed is not the same as one that did not, and the analyzer has
 * to be able to tell.
 */
export const SUPPRESSED_BUFFER_CAPACITY = Object.freeze({
  performance_triage_persist: 4000,
  system_log_flush: 4000,
  system_log_get: 1000,
  system_log_write: 1000,
  experience_events_read: 1000,
  experience_events_flush: 4000,
  watchdog_checkpoint: 4000,
  other: 1000,
});

/** Per-job counters the export is permitted to carry for suppressed work. */
export const EXPORT_SUPPRESSED_KEYS = Object.freeze([
  'invocations',
  'entries_seen',
  'buffered',
  'capacity',
  'dropped',
]);

/**
 * Top-level keys the raw export is permitted to contain. The privacy test walks
 * the serialized object against this and the per-row tables below.
 */
export const EXPORT_TOP_LEVEL_KEYS = Object.freeze([
  'schema_version',
  'meta',
  'spans',
  'phases',
  'long_tasks',
  'scheduling_gaps',
  'lifecycle_events',
  'native_blocks',
  'probe_overhead',
  'budget',
  'suppressed',
  'dropped',
]);

export const EXPORT_META_KEYS = Object.freeze([
  'probe_session_id',
  'build_hash',
  'arm',
  'arm_config_id',
  'run_marker',
  'process_start_wall_ms',
  'process_start_perf_ms',
  'probe_enabled',
  // Frozen thresholds travel with the trace so the analyzer applies the same
  // boundary the collector used, rather than a hardcoded copy that can drift.
  'clock_suspect_threshold_ms',
  'scheduling_gap_threshold_ms',
]);

export const EXPORT_PROBE_OVERHEAD_KEYS = Object.freeze([
  'write_count',
  'self_time_samples',
  'self_time_total_ms',
  'self_time_max_ms',
  'self_time_mean_ms',
  'sample_rate',
  'init_alloc_ms',
  'export_materialize_ms',
  'export_serialize_ms',
]);

export const EXPORT_SPAN_KEYS = Object.freeze([
  'call_id',
  'kind',
  'parent_op_id',
  'plugin_name',
  'method',
  'payload_kind',
  'diagnostics_job',
  'perf_start',
  'perf_end',
  'wall_start_ms',
  'wall_end_ms',
  'wall_pre_native_ms',
  'wall_post_native_ms',
  'clock_gap_ms',
  'clock_suspect',
  'start_epoch',
  'end_epoch',
  'start_state',
  'end_state',
  'queue_depth_at_enqueue',
  'outcome',
  'req_plaintext_bytes',
  'req_ciphertext_bytes',
  'req_b64_chars',
  'res_b64_chars',
  'res_ciphertext_bytes',
  'res_plaintext_bytes',
  'at_rest_ciphertext_b64_chars',
  'at_rest_ciphertext_bytes',
  'at_rest_plaintext_bytes',
  'entry_count_before',
  'serialized_code_units',
]);

/**
 * Span columns whose sentinel means "this measurement does not exist on this
 * path" — e.g. the Android at-rest byte sizes, which cannot be obtained without
 * adding a payload traversal the contract forbids. Exported as `null`.
 */
export const NULLABLE_SPAN_FIELDS = Object.freeze([
  'req_plaintext_bytes',
  'req_ciphertext_bytes',
  'req_b64_chars',
  'res_b64_chars',
  'res_ciphertext_bytes',
  'res_plaintext_bytes',
  'at_rest_ciphertext_b64_chars',
  'at_rest_ciphertext_bytes',
  'at_rest_plaintext_bytes',
  'entry_count_before',
  'serialized_code_units',
]);

export const EXPORT_PHASE_KEYS = Object.freeze([
  'call_id',
  'phase',
  'rel_start_us',
  'dur_us',
  'sync',
]);

export const EXPORT_LONG_TASK_KEYS = Object.freeze([
  'lt_id',
  'start_time',
  'duration',
  'name',
  'container_type',
  'attribution_count',
]);

export const EXPORT_SCHEDULING_GAP_KEYS = Object.freeze([
  'perf_start',
  'perf_end',
  'lateness_ms',
  'visibility_state',
  'effective_state',
  'epoch',
]);

export const EXPORT_LIFECYCLE_KEYS = Object.freeze([
  'source',
  'state',
  'effective_foreground',
  'epoch',
  'perf_ms',
  'wall_ms',
]);

export const EXPORT_NATIVE_BLOCK_KEYS = Object.freeze([
  'call_id',
  'native_entry_wall_ms',
  'response_ready_wall_ms',
  'native_total_internal_us',
  'named_phase_total_us',
  'named_phase_residual_us',
  'transport_b64_decode_us',
  'transport_aes_decrypt_us',
  'envelope_json_parse_us',
  'method_work_us',
  'response_json_us',
  'response_utf8_us',
  'response_aes_encrypt_us',
  'response_b64_encode_us',
  'pre_native_dispatch_ms',
  'post_native_delivery_ms',
  'cross_clock_invalid',
]);

/**
 * Native-block columns that are absent whenever the native side did not report
 * the field, or whenever a cross-clock estimate could not be formed. `null`
 * rather than `-1`, so an analyzer cannot average a sentinel into a duration.
 */
export const NULLABLE_NATIVE_FIELDS = Object.freeze([
  'native_entry_wall_ms',
  'response_ready_wall_ms',
  'native_total_internal_us',
  'named_phase_total_us',
  'named_phase_residual_us',
  'transport_b64_decode_us',
  'transport_aes_decrypt_us',
  'envelope_json_parse_us',
  'method_work_us',
  'response_json_us',
  'response_utf8_us',
  'response_aes_encrypt_us',
  'response_b64_encode_us',
  'pre_native_dispatch_ms',
  'post_native_delivery_ms',
]);
