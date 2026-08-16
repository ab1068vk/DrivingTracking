/**
 * P0 measurement probe.
 *
 * Design constraints that shape every decision in this file:
 *
 * - **The instrument must not perturb what it measures.** Nothing here is ever
 *   written to storage on a timer. Trace data lives in fixed circular buffers and
 *   is serialized only by an explicit debug-gated export.
 * - **No allocation on the hot path.** Phases, Long Tasks, scheduling gaps and
 *   native blocks are written into pre-allocated typed-array columns via
 *   positional pushes. Only one small object per *secure call* is allocated (to
 *   carry in-flight state from enqueue to settle), never one per phase.
 * - **Never `Array.shift`, never whole-array spreading.** Rings overwrite the
 *   oldest slot and increment a `dropped` counter, because a run with dropped
 *   rows is invalid for causal percentages and must be visibly invalid.
 * - **Enum-only strings.** Every string that reaches the export is an index into
 *   a frozen table in `p0Schema.js`.
 */

import {
  CLOCK_SUSPECT_THRESHOLD_MS,
  DIAGNOSTICS_JOBS,
  LIFECYCLE_SOURCES,
  LIFECYCLE_STATES,
  LONG_TASK_CONTAINER_TYPES,
  LONG_TASK_NAMES,
  NULLABLE_NATIVE_FIELDS,
  NULLABLE_SPAN_FIELDS,
  P0_SCHEMA_VERSION,
  PAYLOAD_KINDS,
  PHASE_IDS,
  RING_CAPACITY,
  SCHEDULING_GAP_THRESHOLD_MS,
  SECURE_METHODS,
  SECURE_PLUGINS,
  SELF_TIME_SAMPLE_RATE,
  SPAN_KINDS,
  SUPPRESSED_BUFFER_CAPACITY,
  UNAVAILABLE_SENTINEL,
  isSyncPhase,
  isValidBuildHash,
  isValidRunMarker,
  safeDiagnosticsJob,
  safeLongTaskContainerType,
  safeLongTaskName,
  safeSecureMethod,
  safeSecurePlugin,
} from '@/lib/p0Schema';
import {
  P0_RUN_MARKER_STORAGE_KEY,
  isProbeEnabled,
  p0ArmConfigId,
  resolveP0Arm,
} from '@/lib/p0ProbeArms';

const now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const indexOfOrZero = (table, value) => {
  const index = table.indexOf(value);
  return index >= 0 ? index : 0;
};

// ---------------------------------------------------------------------------
// Column-store ring. Fixed capacity, power-of-two masking, oldest-overwritten.
// ---------------------------------------------------------------------------

const nextPowerOfTwo = (value) => {
  let size = 1;
  while (size < value) size *= 2;
  return size;
};

const COLUMN_TYPES = { f64: Float64Array, i32: Int32Array, u8: Uint8Array };

/**
 * @param {number} requestedCapacity
 * @param {Record<string, 'f64' | 'i32' | 'u8'>} columns
 */
function createRing(requestedCapacity, columns) {
  const capacity = nextPowerOfTwo(Math.max(1, requestedCapacity));
  const mask = capacity - 1;
  const names = Object.keys(columns);
  /** @type {Record<string, any>} */
  const data = {};
  names.forEach((name) => {
    data[name] = new COLUMN_TYPES[columns[name]](capacity);
  });

  return {
    capacity,
    mask,
    names,
    data,
    write: 0,
    count: 0,
    dropped: 0,
    peak: 0,
  };
}

const ringSlot = (ring) => {
  const slot = ring.write & ring.mask;
  ring.write += 1;
  if (ring.count < ring.capacity) {
    ring.count += 1;
    if (ring.count > ring.peak) ring.peak = ring.count;
  } else {
    ring.dropped += 1;
  }
  return slot;
};

const NULLABLE_SPAN_SET = new Set(NULLABLE_SPAN_FIELDS);
const NULLABLE_NATIVE_SET = new Set(NULLABLE_NATIVE_FIELDS);

/**
 * Materialize a ring into plain rows, oldest first. Export path only.
 *
 * Typed-array columns cannot hold `null`, so an unavailable measurement is
 * stored as `UNAVAILABLE_SENTINEL` and converted here. Exporting the sentinel
 * as a number would let an analyzer average `-1` into a real duration.
 *
 * @param {any} ring
 * @param {Set<string> | null} [nullable]
 */
const ringRows = (ring, nullable = null) => {
  const rows = [];
  const start = ring.count < ring.capacity ? 0 : ring.write;
  for (let index = 0; index < ring.count; index += 1) {
    const slot = (start + index) & ring.mask;
    /** @type {Record<string, number | null>} */
    const row = {};
    for (let n = 0; n < ring.names.length; n += 1) {
      const name = ring.names[n];
      const value = ring.data[name][slot];
      row[name] = value === UNAVAILABLE_SENTINEL && nullable?.has(name) ? null : value;
    }
    rows.push(row);
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Probe state
// ---------------------------------------------------------------------------

let enabled = false;
let initialized = false;
let frozen = false;

let probeSessionId = '';
let buildHash = '';
let runMarker = '';
let processStartWallMs = 0;
let processStartPerfMs = 0;

let nextCallId = 1;
let nextLtId = 1;
let nextOpId = 1;

let documentVisible = true;
let nativeActive = true;
let effectiveForeground = true;
let foregroundEpoch = 0;

let heartbeatTimer = null;
let longTaskObserver = null;

let selfTimeSampleCounter = 0;
let selfTimeSamples = 0;
let selfTimeTotalMs = 0;
let selfTimeMaxMs = 0;
let writeCount = 0;
let initAllocMs = 0;

/** @type {any} */ let spanRing = null;
/** @type {any} */ let phaseRing = null;
/** @type {any} */ let longTaskRing = null;
/** @type {any} */ let gapRing = null;
/** @type {any} */ let lifecycleRing = null;
/** @type {any} */ let nativeRing = null;

const SPAN_COLUMNS = {
  call_id: 'i32',
  kind: 'u8',
  parent_op_id: 'i32',
  plugin_name: 'u8',
  method: 'u8',
  payload_kind: 'u8',
  diagnostics_job: 'u8',
  perf_start: 'f64',
  perf_end: 'f64',
  wall_start_ms: 'f64',
  wall_end_ms: 'f64',
  wall_pre_native_ms: 'f64',
  wall_post_native_ms: 'f64',
  clock_gap_ms: 'f64',
  clock_suspect: 'u8',
  start_epoch: 'i32',
  end_epoch: 'i32',
  start_state: 'u8',
  end_state: 'u8',
  queue_depth_at_enqueue: 'i32',
  outcome: 'u8',
  req_plaintext_bytes: 'i32',
  req_ciphertext_bytes: 'i32',
  req_b64_chars: 'i32',
  res_b64_chars: 'i32',
  res_ciphertext_bytes: 'i32',
  res_plaintext_bytes: 'i32',
  at_rest_ciphertext_b64_chars: 'i32',
  at_rest_ciphertext_bytes: 'i32',
  at_rest_plaintext_bytes: 'i32',
  entry_count_before: 'i32',
  serialized_code_units: 'i32',
};

const PHASE_COLUMNS = {
  call_id: 'i32',
  phase: 'u8',
  rel_start_us: 'f64',
  dur_us: 'f64',
  sync: 'u8',
};

const LONG_TASK_COLUMNS = {
  lt_id: 'i32',
  start_time: 'f64',
  duration: 'f64',
  name: 'u8',
  container_type: 'u8',
  attribution_count: 'i32',
};

const GAP_COLUMNS = {
  perf_start: 'f64',
  perf_end: 'f64',
  lateness_ms: 'f64',
  visibility_state: 'u8',
  effective_state: 'u8',
  epoch: 'i32',
};

const LIFECYCLE_COLUMNS = {
  source: 'u8',
  state: 'u8',
  effective_foreground: 'u8',
  epoch: 'i32',
  perf_ms: 'f64',
  wall_ms: 'f64',
};

const NATIVE_COLUMNS = {
  call_id: 'i32',
  native_entry_wall_ms: 'f64',
  response_ready_wall_ms: 'f64',
  native_total_internal_us: 'f64',
  named_phase_total_us: 'f64',
  named_phase_residual_us: 'f64',
  transport_b64_decode_us: 'f64',
  transport_aes_decrypt_us: 'f64',
  envelope_json_parse_us: 'f64',
  method_work_us: 'f64',
  response_json_us: 'f64',
  response_utf8_us: 'f64',
  response_aes_encrypt_us: 'f64',
  response_b64_encode_us: 'f64',
  pre_native_dispatch_ms: 'f64',
  post_native_delivery_ms: 'f64',
  cross_clock_invalid: 'u8',
};

export const P0_OUTCOMES = Object.freeze(['success', 'error', 'unknown']);

// ---------------------------------------------------------------------------
// Overhead self-accounting
// ---------------------------------------------------------------------------

const beginSelfTime = () => {
  selfTimeSampleCounter += 1;
  writeCount += 1;
  if (selfTimeSampleCounter % SELF_TIME_SAMPLE_RATE !== 0) return 0;
  return now();
};

const endSelfTime = (startedAt) => {
  if (!startedAt) return;
  const elapsed = now() - startedAt;
  selfTimeSamples += 1;
  selfTimeTotalMs += elapsed;
  if (elapsed > selfTimeMaxMs) selfTimeMaxMs = elapsed;
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const recomputeEffectiveForeground = () => {
  const next = documentVisible && nativeActive;
  if (next !== effectiveForeground) {
    effectiveForeground = next;
    foregroundEpoch += 1;
  }
  return effectiveForeground;
};

/**
 * Record a raw lifecycle event. Raw `visibilitychange` and `appStateChange`
 * events are stored **separately and unmerged** so the duplicated resume work is
 * still visible, but the epoch advances only when the *effective* state changes,
 * so one physical transition never yields two epochs.
 *
 * @param {'visibilitychange'|'appStateChange'} source
 * @param {'visible'|'hidden'|'active'|'inactive'} state
 */
export function recordP0Lifecycle(source, state) {
  if (!enabled || frozen) return;
  const startedAt = beginSelfTime();
  if (source === 'visibilitychange') documentVisible = state === 'visible';
  else if (source === 'appStateChange') nativeActive = state === 'active';
  const foreground = recomputeEffectiveForeground();

  const slot = ringSlot(lifecycleRing);
  const data = lifecycleRing.data;
  data.source[slot] = indexOfOrZero(LIFECYCLE_SOURCES, source);
  data.state[slot] = indexOfOrZero(LIFECYCLE_STATES, state);
  data.effective_foreground[slot] = foreground ? 1 : 0;
  data.epoch[slot] = foregroundEpoch;
  data.perf_ms[slot] = now();
  data.wall_ms[slot] = Date.now();
  endSelfTime(startedAt);
}

export const p0ForegroundEpoch = () => foregroundEpoch;
export const p0EffectiveForeground = () => effectiveForeground;

// ---------------------------------------------------------------------------
// Suppressed-work counters (arms B/C)
// ---------------------------------------------------------------------------

/**
 * Volatile per-job suppressed-work buffers.
 *
 * Each buffer is a fixed-size circular slot array with a write cursor — not a
 * growing array with `shift()`. Suppression runs on the hot path of the very
 * arm being measured, and an O(n) shift per overflow entry would inject cost
 * into the measurement it exists to isolate.
 *
 * @type {Record<string, {
 *   invocations: number,
 *   entriesSeen: number,
 *   capacity: number,
 *   dropped: number,
 *   buffered: number,
 *   write: number,
 *   slots: any[],
 * }>}
 */
let suppressedBuffers = {};

const suppressedBufferFor = (job) => {
  let buffer = suppressedBuffers[job];
  if (!buffer) {
    const capacity = SUPPRESSED_BUFFER_CAPACITY[job] ?? SUPPRESSED_BUFFER_CAPACITY.other;
    buffer = {
      invocations: 0,
      entriesSeen: 0,
      capacity,
      dropped: 0,
      buffered: 0,
      write: 0,
      slots: new Array(capacity),
    };
    suppressedBuffers[job] = buffer;
  }
  return buffer;
};

/**
 * Move a short-circuited recurring persistence job's already-collected batch
 * into a bounded volatile buffer.
 *
 * Arms B/C skip the storage read, the full-history transform, the stringify and
 * the write — but the batch they were called with still exists, and throwing it
 * away unrecorded would make a suppressed run indistinguishable from a quiet
 * one. So the entries are kept in memory, bounded, and the counters are
 * exported.
 *
 * The entries themselves are **never** exported or persisted: they are real
 * diagnostics containing log messages, page paths and event details. Only
 * `invocations` / `entries_seen` / `buffered` / `capacity` / `dropped` reach the
 * trace.
 *
 * Overflow drops the oldest entry and increments `dropped`, so overflow is
 * visible rather than silent.
 *
 * @param {string} job one of DIAGNOSTICS_JOBS
 * @param {any[]} [entries] the already-collected batch, if this job had one
 */
export function bufferSuppressedDiagnostics(job, entries) {
  // Frozen means the scenario is over and the trace is being exported; a
  // suppressed job arriving after that is not part of the measured run and must
  // not be able to change its counters.
  if (!enabled || frozen) return;
  const startedAt = beginSelfTime();
  const safeJob = safeDiagnosticsJob(job);
  const buffer = suppressedBufferFor(safeJob);
  buffer.invocations += 1;

  if (Array.isArray(entries) && entries.length > 0) {
    buffer.entriesSeen += entries.length;
    for (let index = 0; index < entries.length; index += 1) {
      const slot = buffer.write % buffer.capacity;
      if (buffer.buffered < buffer.capacity) buffer.buffered += 1;
      else buffer.dropped += 1;
      buffer.slots[slot] = entries[index];
      buffer.write += 1;
    }
  }
  endSelfTime(startedAt);
}

/** Test-only view of the volatile buffers. Never exported. */
export const __p0SuppressedBuffersForTests = () => suppressedBuffers;

// ---------------------------------------------------------------------------
// Spans and phases
// ---------------------------------------------------------------------------

export const nextP0CallId = () => {
  const id = nextCallId;
  nextCallId += 1;
  return id;
};

export const nextP0OpId = () => {
  const id = nextOpId;
  nextOpId += 1;
  return id;
};

/**
 * Open an in-flight span record. One small object per secure call / logical
 * operation — never one per phase.
 *
 * @param {string} kind one of SPAN_KINDS
 */
export function openP0Span(kind) {
  if (!enabled || frozen) return null;
  // Span allocation is real probe work on the hot path and is charged to the
  // writer self-time budget like every other write, so the exported overhead
  // cannot understate the instrument.
  const startedAt = beginSelfTime();
  const span = {
    call_id: nextP0CallId(),
    kind: indexOfOrZero(SPAN_KINDS, kind),
    parent_op_id: 0,
    plugin_name: 0,
    method: 0,
    payload_kind: 0,
    diagnostics_job: 0,
    perf_start: now(),
    perf_end: 0,
    wall_start_ms: Date.now(),
    wall_end_ms: 0,
    wall_pre_native_ms: 0,
    wall_post_native_ms: 0,
    start_epoch: foregroundEpoch,
    end_epoch: 0,
    start_state: effectiveForeground ? 1 : 0,
    end_state: 0,
    queue_depth_at_enqueue: 0,
    outcome: 2,
    req_plaintext_bytes: UNAVAILABLE_SENTINEL,
    req_ciphertext_bytes: UNAVAILABLE_SENTINEL,
    req_b64_chars: UNAVAILABLE_SENTINEL,
    res_b64_chars: UNAVAILABLE_SENTINEL,
    res_ciphertext_bytes: UNAVAILABLE_SENTINEL,
    res_plaintext_bytes: UNAVAILABLE_SENTINEL,
    at_rest_ciphertext_b64_chars: UNAVAILABLE_SENTINEL,
    at_rest_ciphertext_bytes: UNAVAILABLE_SENTINEL,
    at_rest_plaintext_bytes: UNAVAILABLE_SENTINEL,
    entry_count_before: UNAVAILABLE_SENTINEL,
    serialized_code_units: UNAVAILABLE_SENTINEL,
    // Native ring slot, filled in by `recordP0NativeBlock` so `closeP0Span` can
    // finalize the cross-clock verdict once the span's own clock gap is known.
    native_slot: -1,
    // Set by `markP0SpanFailure` when the measured work failed but the
    // application swallowed the error.
    p0_failed: false,
  };
  endSelfTime(startedAt);
  return span;
}

/** @param {any} span @param {string} pluginName @param {string} method */
export function tagP0SecureSpan(span, pluginName, method) {
  if (!span) return;
  span.plugin_name = indexOfOrZero(SECURE_PLUGINS, safeSecurePlugin(pluginName));
  span.method = indexOfOrZero(SECURE_METHODS, safeSecureMethod(method));
}

/** @param {any} span @param {string} payloadKind */
export function tagP0PayloadKind(span, payloadKind) {
  if (!span) return;
  span.payload_kind = indexOfOrZero(PAYLOAD_KINDS, PAYLOAD_KINDS.includes(payloadKind) ? payloadKind : 'other');
}

/**
 * Mark that the work this span measures failed, even though the application
 * swallowed the error and continued.
 *
 * The diagnostics stores are deliberately best-effort: a corrupt parse returns
 * `[]`, a failed write is retried at half size. That is correct application
 * behaviour and P0 does not change it — but the *measurement* must still say
 * the work failed. `closeP0Span` downgrades a `success` outcome to `error`
 * whenever this flag is set, so a caller cannot forget to propagate it.
 *
 * @param {any} span
 */
export function markP0SpanFailure(span) {
  if (!span) return;
  span.p0_failed = true;
}

/** @param {any} span @param {string} job */
export function tagP0DiagnosticsJob(span, job) {
  if (!span) return;
  span.diagnostics_job = indexOfOrZero(DIAGNOSTICS_JOBS, safeDiagnosticsJob(job));
}

/**
 * Record one phase interval against a span. Positional args only — no object is
 * allocated per phase.
 *
 * @param {any} span
 * @param {string} phaseId
 * @param {number} startPerfMs
 * @param {number} endPerfMs
 */
export function recordP0Phase(span, phaseId, startPerfMs, endPerfMs) {
  if (!enabled || frozen || !span) return;
  const startedAt = beginSelfTime();
  const slot = ringSlot(phaseRing);
  const data = phaseRing.data;
  data.call_id[slot] = span.call_id;
  data.phase[slot] = indexOfOrZero(PHASE_IDS, phaseId);
  data.rel_start_us[slot] = (startPerfMs - span.perf_start) * 1000;
  data.dur_us[slot] = (endPerfMs - startPerfMs) * 1000;
  data.sync[slot] = isSyncPhase(phaseId) ? 1 : 0;
  endSelfTime(startedAt);
}

/**
 * Close a span and flush it into the column store.
 *
 * @param {any} span
 * @param {'success'|'error'|'unknown'} outcome
 */
export function closeP0Span(span, outcome = 'unknown') {
  if (!enabled || frozen || !span) return;
  const startedAt = beginSelfTime();
  span.perf_end = now();
  span.wall_end_ms = Date.now();
  span.end_epoch = foregroundEpoch;
  span.end_state = effectiveForeground ? 1 : 0;
  // A swallowed failure inside the measured work still makes this an error
  // span. See `markP0SpanFailure`.
  const effectiveOutcome = span.p0_failed && outcome === 'success' ? 'error' : outcome;
  span.outcome = indexOfOrZero(P0_OUTCOMES, effectiveOutcome);

  const perfElapsed = span.perf_end - span.perf_start;
  const wallElapsed = span.wall_end_ms - span.wall_start_ms;
  const clockGap = wallElapsed - perfElapsed;

  const clockSuspect = Math.abs(clockGap) > CLOCK_SUSPECT_THRESHOLD_MS ? 1 : 0;

  const slot = ringSlot(spanRing);
  const data = spanRing.data;
  const names = spanRing.names;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (name === 'clock_gap_ms') data[name][slot] = clockGap;
    else if (name === 'clock_suspect') data[name][slot] = clockSuspect;
    else data[name][slot] = span[name];
  }

  // The native block is ingested mid-call, before the span's total wall/perf
  // divergence is known. A suspension *after* ingestion still invalidates the
  // cross-clock estimates, so the verdict is finalized here — the first moment
  // the whole-span gap exists. The call-id guard skips rows the ring has since
  // overwritten.
  if (span.native_slot >= 0 && nativeRing.data.call_id[span.native_slot] === span.call_id) {
    nativeRing.data.cross_clock_invalid[span.native_slot] = clockSuspect;
  }
  endSelfTime(startedAt);
}

/**
 * Record the native `_p0` diagnostic block. The block is unauthenticated and
 * diagnostic-only; nothing here influences crypto or control flow, and every
 * value is coerced to a finite number before it is stored.
 *
 * @param {any} span
 * @param {Record<string, any>} block
 * @param {number} sendWallMs wall time sampled immediately before the native invoke
 */
export function recordP0NativeBlock(span, block, sendWallMs) {
  if (!enabled || frozen || !span || !block || typeof block !== 'object') return;
  const startedAt = beginSelfTime();
  // `_p0` is unauthenticated attacker-influenceable data. The *property read*
  // itself is hostile surface — a getter or proxy trap can throw — so the read
  // is guarded before coercion. Only primitives are then coerced, because
  // `Number(object)` would invoke a `valueOf`/`toString` trap.
  const num = (key) => {
    let value;
    try {
      value = block[key];
    } catch {
      return UNAVAILABLE_SENTINEL;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : UNAVAILABLE_SENTINEL;
    if (typeof value !== 'string') return UNAVAILABLE_SENTINEL;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : UNAVAILABLE_SENTINEL;
  };

  const entryWall = num('native_entry_wall_ms');
  const readyWall = num('response_ready_wall_ms');
  const totalInternalUs = num('native_total_internal_us');
  const named = [
    num('transport_b64_decode_us'),
    num('transport_aes_decrypt_us'),
    num('envelope_json_parse_us'),
    num('method_work_us'),
    num('response_json_us'),
    num('response_utf8_us'),
    num('response_aes_encrypt_us'),
    num('response_b64_encode_us'),
  ];
  const namedTotal = named.reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  const preDispatch = entryWall >= 0 && sendWallMs >= 0
    ? entryWall - sendWallMs
    : UNAVAILABLE_SENTINEL;
  // Post-native delivery is the wall interval between native declaring the
  // response ready and JS observing it — a direct difference of two wall
  // samples, not a residual backed out of the total. A residual would silently
  // absorb every other estimation error in the chain.
  const postDelivery = readyWall >= 0 && span.wall_post_native_ms > 0
    ? span.wall_post_native_ms - readyWall
    : UNAVAILABLE_SENTINEL;

  const slot = ringSlot(nativeRing);
  const data = nativeRing.data;
  data.call_id[slot] = span.call_id;
  data.native_entry_wall_ms[slot] = entryWall;
  data.response_ready_wall_ms[slot] = readyWall;
  data.native_total_internal_us[slot] = totalInternalUs;
  data.named_phase_total_us[slot] = namedTotal;
  data.named_phase_residual_us[slot] = totalInternalUs >= 0
    ? totalInternalUs - namedTotal
    : UNAVAILABLE_SENTINEL;
  data.transport_b64_decode_us[slot] = named[0];
  data.transport_aes_decrypt_us[slot] = named[1];
  data.envelope_json_parse_us[slot] = named[2];
  data.method_work_us[slot] = named[3];
  data.response_json_us[slot] = named[4];
  data.response_utf8_us[slot] = named[5];
  data.response_aes_encrypt_us[slot] = named[6];
  data.response_b64_encode_us[slot] = named[7];
  data.pre_native_dispatch_ms[slot] = preDispatch;
  data.post_native_delivery_ms[slot] = postDelivery;
  // Provisionally valid. `closeP0Span` overwrites this with the whole-span
  // verdict, which is the only point at which the span's wall/perf divergence
  // is fully known; a span that never closes keeps the conservative default.
  data.cross_clock_invalid[slot] = 1;
  span.native_slot = slot;
  endSelfTime(startedAt);
}

// ---------------------------------------------------------------------------
// Long Tasks and scheduling gaps
// ---------------------------------------------------------------------------

const recordLongTask = (entry) => {
  const slot = ringSlot(longTaskRing);
  const data = longTaskRing.data;
  const attribution = Array.isArray(entry.attribution) ? entry.attribution : [];
  const first = attribution[0];
  data.lt_id[slot] = nextLtId;
  nextLtId += 1;
  data.start_time[slot] = entry.startTime;
  data.duration[slot] = entry.duration;
  data.name[slot] = indexOfOrZero(LONG_TASK_NAMES, safeLongTaskName(first?.name ?? entry.name));
  data.container_type[slot] = indexOfOrZero(
    LONG_TASK_CONTAINER_TYPES,
    safeLongTaskContainerType(first?.containerType)
  );
  data.attribution_count[slot] = attribution.length;
};

const startLongTaskObserver = () => {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      if (!enabled || frozen) return;
      const startedAt = beginSelfTime();
      const entries = list.getEntries();
      for (let index = 0; index < entries.length; index += 1) recordLongTask(entries[index]);
      endSelfTime(startedAt);
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    // Long Task support is device-dependent; absence is reported by an empty ring.
  }
};

const startHeartbeat = () => {
  if (typeof setInterval !== 'function') return;
  let expected = now() + 1000;
  heartbeatTimer = setInterval(() => {
    if (!enabled || frozen) return;
    const actual = now();
    const lateness = actual - expected;
    if (lateness > SCHEDULING_GAP_THRESHOLD_MS) {
      const startedAt = beginSelfTime();
      const slot = ringSlot(gapRing);
      const data = gapRing.data;
      data.perf_start[slot] = expected;
      data.perf_end[slot] = actual;
      data.lateness_ms[slot] = lateness;
      data.visibility_state[slot] = documentVisible ? 1 : 0;
      data.effective_state[slot] = effectiveForeground ? 1 : 0;
      data.epoch[slot] = foregroundEpoch;
      endSelfTime(startedAt);
    }
    expected = actual + 1000;
  }, 1000);
};

// ---------------------------------------------------------------------------
// Init / export
// ---------------------------------------------------------------------------

const randomId = () => {
  try {
    const api = globalThis.crypto;
    if (api && typeof api.getRandomValues === 'function') {
      const bytes = new Uint8Array(8);
      api.getRandomValues(bytes);
      let out = '';
      for (let index = 0; index < bytes.length; index += 1) out += bytes[index].toString(36);
      return out.slice(0, 12);
    }
  } catch {
    // fall through
  }
  return Math.random().toString(36).slice(2, 14);
};

const readRunMarker = () => {
  try {
    if (typeof localStorage === 'undefined') return '';
    const stored = localStorage.getItem(P0_RUN_MARKER_STORAGE_KEY) || '';
    return isValidRunMarker(stored) ? stored : '';
  } catch {
    return '';
  }
};

/**
 * @param {{ buildHash?: string }} [options]
 * @returns {boolean} whether the probe is active
 */
export function initializeP0Probe(options = {}) {
  if (initialized) return enabled;
  initialized = true;
  enabled = isProbeEnabled();
  if (!enabled) return false;

  probeSessionId = `p0_${Date.now().toString(36)}_${randomId()}`;
  // Constrained to the build-token grammar: an unconstrained 128-character
  // string would be a hole in the single key-and-value allowlist.
  buildHash = isValidBuildHash(options.buildHash) ? options.buildHash : '';
  runMarker = readRunMarker();
  processStartWallMs = Date.now();
  processStartPerfMs = now();

  // The rings are ~10 MB allocated during instrumented cold boot, i.e. *inside*
  // the window P0 measures, and the Long Task observer does not exist yet to
  // self-report the block. The cost is measured and exported so the A/D CDP
  // overhead gate can account for it instead of it hiding in boot numbers.
  const allocStart = now();
  spanRing = createRing(RING_CAPACITY.spans, SPAN_COLUMNS);
  phaseRing = createRing(RING_CAPACITY.phases, PHASE_COLUMNS);
  longTaskRing = createRing(RING_CAPACITY.longTasks, LONG_TASK_COLUMNS);
  gapRing = createRing(RING_CAPACITY.schedulingGaps, GAP_COLUMNS);
  lifecycleRing = createRing(RING_CAPACITY.lifecycleEvents, LIFECYCLE_COLUMNS);
  nativeRing = createRing(RING_CAPACITY.nativeBlocks, NATIVE_COLUMNS);
  initAllocMs = now() - allocStart;

  if (typeof document !== 'undefined' && document.visibilityState) {
    documentVisible = document.visibilityState === 'visible';
  }
  effectiveForeground = documentVisible && nativeActive;

  startLongTaskObserver();
  startHeartbeat();
  return true;
}

export const isP0ProbeActive = () => enabled && !frozen;

/** @param {string} value */
export function setP0RunMarker(value) {
  if (!isValidRunMarker(value)) return false;
  runMarker = value;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(P0_RUN_MARKER_STORAGE_KEY, value);
  } catch {
    // best effort
  }
  return true;
}

/** Stop collecting so export serialization cannot contaminate the trace. */
export function freezeP0Trace() {
  frozen = true;
}

export function unfreezeP0Trace() {
  frozen = false;
}

/**
 * Materialize the raw trace as a plain object. Freezes collection first, so
 * nothing this function does can land in the trace it is exporting.
 *
 * The cost reported here is `export_materialize_ms` — turning column stores
 * into rows — which is all this function does. `JSON.stringify` happens in
 * `serializeP0Trace()` and is reported under its own key; conflating the two
 * would have let row materialization masquerade as serialization cost.
 */
export function exportP0Trace() {
  if (!enabled) return null;
  freezeP0Trace();
  const startedAt = now();

  const payload = {
    schema_version: P0_SCHEMA_VERSION,
    meta: {
      probe_session_id: probeSessionId,
      build_hash: buildHash,
      arm: resolveP0Arm(),
      arm_config_id: p0ArmConfigId(),
      run_marker: runMarker,
      process_start_wall_ms: processStartWallMs,
      process_start_perf_ms: processStartPerfMs,
      probe_enabled: enabled,
      clock_suspect_threshold_ms: CLOCK_SUSPECT_THRESHOLD_MS,
      scheduling_gap_threshold_ms: SCHEDULING_GAP_THRESHOLD_MS,
    },
    spans: ringRows(spanRing, NULLABLE_SPAN_SET),
    phases: ringRows(phaseRing),
    long_tasks: ringRows(longTaskRing),
    scheduling_gaps: ringRows(gapRing),
    lifecycle_events: ringRows(lifecycleRing),
    native_blocks: ringRows(nativeRing, NULLABLE_NATIVE_SET),
    probe_overhead: {
      write_count: writeCount,
      self_time_samples: selfTimeSamples,
      self_time_total_ms: selfTimeTotalMs,
      self_time_max_ms: selfTimeMaxMs,
      self_time_mean_ms: selfTimeSamples ? selfTimeTotalMs / selfTimeSamples : 0,
      sample_rate: SELF_TIME_SAMPLE_RATE,
      init_alloc_ms: initAllocMs,
      export_materialize_ms: 0,
      // Only `serializeP0Trace()` stringifies, so on this path the cost does
      // not exist. `null` rather than `0`: a zero here would read as
      // "serialization was free", which is a claim nothing measured.
      export_serialize_ms: null,
    },
    budget: {
      spans: spanRing.capacity,
      phases: phaseRing.capacity,
      long_tasks: longTaskRing.capacity,
      scheduling_gaps: gapRing.capacity,
      lifecycle_events: lifecycleRing.capacity,
      native_blocks: nativeRing.capacity,
      spans_peak: spanRing.peak,
      phases_peak: phaseRing.peak,
      long_tasks_peak: longTaskRing.peak,
      scheduling_gaps_peak: gapRing.peak,
      lifecycle_events_peak: lifecycleRing.peak,
      native_blocks_peak: nativeRing.peak,
    },
    // Counters only. The buffered entries are real user diagnostics and never
    // leave memory.
    suppressed: Object.keys(suppressedBuffers).reduce((out, job) => {
      const buffer = suppressedBuffers[job];
      out[job] = {
        invocations: buffer.invocations,
        entries_seen: buffer.entriesSeen,
        buffered: buffer.buffered,
        capacity: buffer.capacity,
        dropped: buffer.dropped,
      };
      return out;
    }, /** @type {Record<string, any>} */ ({})),
    dropped: {
      spans: spanRing.dropped,
      phases: phaseRing.dropped,
      long_tasks: longTaskRing.dropped,
      scheduling_gaps: gapRing.dropped,
      lifecycle_events: lifecycleRing.dropped,
      native_blocks: nativeRing.dropped,
    },
  };

  payload.probe_overhead.export_materialize_ms = now() - startedAt;
  return payload;
}

/**
 * Serialize the raw trace to JSON and report what the serialization actually
 * cost.
 *
 * `export_serialize_ms` cannot be measured and embedded in a single pass — the
 * measurement would have to exist before the string that contains it. So the
 * payload is stringified once to time it, the timing is written into the
 * payload, and it is stringified again to produce the returned string. The
 * reported figure is therefore the first pass over a payload identical to the
 * returned one except for that single number. Both passes run after
 * `freezeP0Trace()`, so neither can contaminate the trace.
 *
 * @returns {string | null}
 */
export function serializeP0Trace() {
  const payload = exportP0Trace();
  if (!payload) return null;
  const startedAt = now();
  JSON.stringify(payload);
  payload.probe_overhead.export_serialize_ms = now() - startedAt;
  return JSON.stringify(payload);
}

/** Test-only teardown. */
export function __resetP0ProbeForTests() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  try {
    longTaskObserver?.disconnect?.();
  } catch {
    // ignore
  }
  longTaskObserver = null;
  enabled = false;
  initialized = false;
  frozen = false;
  nextCallId = 1;
  nextLtId = 1;
  nextOpId = 1;
  documentVisible = true;
  nativeActive = true;
  effectiveForeground = true;
  foregroundEpoch = 0;
  selfTimeSampleCounter = 0;
  selfTimeSamples = 0;
  selfTimeTotalMs = 0;
  selfTimeMaxMs = 0;
  writeCount = 0;
  initAllocMs = 0;
  suppressedBuffers = {};
  spanRing = null;
  phaseRing = null;
  longTaskRing = null;
  gapRing = null;
  lifecycleRing = null;
  nativeRing = null;
}

/** Test-only introspection. */
export const __p0RingStateForTests = () => ({
  spans: spanRing,
  phases: phaseRing,
  longTasks: longTaskRing,
  gaps: gapRing,
  lifecycle: lifecycleRing,
  native: nativeRing,
});
