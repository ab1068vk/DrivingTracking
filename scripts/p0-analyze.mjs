#!/usr/bin/env node
/**
 * P0 offline analyzer.
 *
 * Consumes raw P0 exports and produces the evidence the P1/P2 decision rule
 * needs. Everything here runs off-device: the probe only appends rows, and no
 * join or scan ever happens on the WebView.
 *
 * Usage:
 *   node scripts/p0-analyze.mjs <armA.json> [--arm-b <armB.json>] [--json]
 *
 * The export may be either a raw `p0` payload or a full diagnostics report that
 * contains one.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

export const SECURE_SYNC_PHASES = new Set([
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
]);

export const LOGICAL_JSON_PHASES = new Set(['logical_stringify', 'logical_parse']);

export const DIAGNOSTICS_SYNC_PHASES = new Set([
  'diag_get',
  'diag_parse',
  'diag_transform',
  'diag_prune_a',
  'diag_prune_b',
  'diag_stringify',
  'diag_set',
]);

/** Awaited queue/WebCrypto/native time never counts as synchronous coverage. */
export const LATENCY_PHASES = new Set([
  'queue_wait',
  'session_wait',
  'wc_encrypt_await',
  'native_await',
  'wc_decrypt_await',
]);

/**
 * `logical_json_unjoined` is a separate class on purpose.
 *
 * A logical stringify/parse only supports the secure-path hypothesis when it is
 * explicitly joined to a secure call — i.e. some secure span names it as
 * `parent_op_id`. Logical JSON with no secure child is just JSON work; counting
 * it toward the secure share would let the P2 gate pass on evidence that says
 * nothing about the bridge. Parentage is explicit and never inferred from
 * timing overlap or an async stack.
 */
export const CLASSES = ['secure_sync', 'logical_json', 'logical_json_unjoined', 'diagnostics_sync'];

export function classifyPhase(phaseId) {
  if (SECURE_SYNC_PHASES.has(phaseId)) return 'secure_sync';
  if (LOGICAL_JSON_PHASES.has(phaseId)) return 'logical_json';
  if (DIAGNOSTICS_SYNC_PHASES.has(phaseId)) return 'diagnostics_sync';
  return null;
}

/**
 * Total Blocking Time: the part of each long task beyond 50 ms.
 *
 * This is the approved A/B gate metric. Raw long-task duration counts the first
 * 50 ms of every task, which is not blocking by definition and inflates the
 * apparent reduction when an arm merely produces fewer, shorter tasks.
 *
 * @param {{duration: number}[]} tasks
 */
export function totalBlockingTime(tasks) {
  return (tasks || []).reduce((sum, task) => {
    // `duration` is the probe's own Long Task row; `duration_ms` is the CDP
    // capture's. Both are milliseconds.
    const duration = Number(task?.duration ?? task?.duration_ms) || 0;
    return sum + Math.max(0, duration - 50);
  }, 0);
}

// ---------------------------------------------------------------------------
// Interval reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuild absolute millisecond intervals for every synchronous phase.
 *
 * Phases are stored as integer-microsecond offsets from their span anchor, so
 * the absolute timeline is reconstructed here rather than on-device. Phases
 * belonging to a `clock_suspect` span are dropped: a span whose wall/monotonic
 * divergence exceeded the frozen threshold cannot be trusted to sit where it
 * claims on the shared performance timeline.
 *
 * @param {{spans: any[], phases: any[]}} trace
 * @param {{phaseNames: string[], spanKinds?: string[]}} schema
 */
export function buildSyncIntervals(trace, schema) {
  const spansById = new Map();
  (trace.spans || []).forEach((span) => spansById.set(span.call_id, span));

  // Logical spans that a secure call explicitly claims as its parent. Only these
  // count toward the secure-path share; see the `CLASSES` note.
  const joinedLogicalOps = new Set();
  (trace.spans || []).forEach((span) => {
    if (span.parent_op_id) joinedLogicalOps.add(span.parent_op_id);
  });

  const intervals = [];
  let droppedClockSuspect = 0;

  (trace.phases || []).forEach((phase) => {
    const span = spansById.get(phase.call_id);
    if (!span) return;
    if (!phase.sync) return;
    if (span.clock_suspect) {
      droppedClockSuspect += 1;
      return;
    }
    const phaseId = schema.phaseNames[phase.phase];
    let klass = classifyPhase(phaseId);
    if (!klass) return;
    if (klass === 'logical_json' && !joinedLogicalOps.has(phase.call_id)) {
      klass = 'logical_json_unjoined';
    }
    const start = span.perf_start + phase.rel_start_us / 1000;
    const end = start + phase.dur_us / 1000;
    if (!(end > start)) return;
    intervals.push({ start, end, klass, phaseId, callId: phase.call_id });
  });

  intervals.sort((a, b) => a.start - b.start);
  return { intervals, droppedClockSuspect };
}

// ---------------------------------------------------------------------------
// Exclusive overlap sweep
// ---------------------------------------------------------------------------

/**
 * Assign each blocked millisecond to at most one class.
 *
 * Inclusive overlap double-counts wherever two classes cover the same instant,
 * which would let the shares sum past 100% and let both hypotheses "win". The
 * exclusive sweep splits the window into elementary segments and gives each one
 * to the single class covering it, or to `mixed` when more than one does.
 *
 * @param {{start: number, end: number}} window
 * @param {{start: number, end: number, klass: string}[]} intervals sorted by start
 */
export function exclusiveOverlap(window, intervals) {
  const edges = new Set([window.start, window.end]);
  const clipped = [];
  for (const interval of intervals) {
    if (interval.end <= window.start) continue;
    if (interval.start >= window.end) break;
    const start = Math.max(interval.start, window.start);
    const end = Math.min(interval.end, window.end);
    if (end <= start) continue;
    clipped.push({ start, end, klass: interval.klass });
    edges.add(start);
    edges.add(end);
  }

  const points = [...edges].sort((a, b) => a - b);
  const exclusive = { mixed: 0 };
  CLASSES.forEach((klass) => { exclusive[klass] = 0; });
  const inclusive = {};
  CLASSES.forEach((klass) => { inclusive[klass] = 0; });

  clipped.forEach((interval) => {
    inclusive[interval.klass] += interval.end - interval.start;
  });

  let covered = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const segStart = points[index];
    const segEnd = points[index + 1];
    const width = segEnd - segStart;
    if (width <= 0) continue;
    const mid = segStart + width / 2;
    const classes = new Set();
    for (const interval of clipped) {
      if (interval.start <= mid && interval.end > mid) classes.add(interval.klass);
    }
    if (classes.size === 0) continue;
    covered += width;
    if (classes.size === 1) exclusive[[...classes][0]] += width;
    else exclusive.mixed += width;
  }

  const duration = window.end - window.start;
  return {
    duration,
    inclusive,
    exclusive,
    covered,
    unattributed: Math.max(0, duration - covered),
  };
}

/** Classify a Long Task from its exclusive coverage. */
export function classifyLongTask(overlap, threshold = 0.6) {
  const { duration, exclusive, unattributed } = overlap;
  if (duration <= 0) return 'unattributed';
  for (const klass of CLASSES) {
    if (exclusive[klass] / duration >= threshold) return klass;
  }
  const attributed = duration - unattributed;
  if (attributed / duration >= threshold) return 'mixed';
  return 'unattributed';
}

// ---------------------------------------------------------------------------
// Lifecycle intersection
// ---------------------------------------------------------------------------

/**
 * Derive effective-foreground intervals from the raw lifecycle ledger.
 * Effective foreground is document-visible AND native-app-active; the ledger
 * already stores the resolved flag per event, so this stitches the segments.
 */
export function foregroundIntervals(trace, endPerfMs) {
  const events = [...(trace.lifecycle_events || [])].sort((a, b) => a.perf_ms - b.perf_ms);
  const intervals = [];
  // Before the first recorded transition the app was foreground by definition:
  // the probe initializes during a foreground boot.
  let currentState = 1;
  let currentStart = 0;
  events.forEach((event) => {
    if (event.effective_foreground === currentState) return;
    if (currentState === 1) intervals.push({ start: currentStart, end: event.perf_ms });
    currentState = event.effective_foreground;
    currentStart = event.perf_ms;
  });
  if (currentState === 1) intervals.push({ start: currentStart, end: endPerfMs });
  return intervals.filter((interval) => interval.end > interval.start);
}

/** Milliseconds of [start,end) that fall inside any foreground interval. */
export function foregroundMs({ start, end }, intervals) {
  let total = 0;
  for (const interval of intervals) {
    const overlapStart = Math.max(start, interval.start);
    const overlapEnd = Math.min(end, interval.end);
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Deterministic PRNG so a bootstrap result is reproducible from an export. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);

/**
 * Bootstrap CI for the *relative reduction* from arm A to arm B.
 * Returns the point estimate plus the interval; the decision rule requires the
 * interval to exclude zero, which is what stops an unreplicated run deciding.
 */
export function bootstrapReductionCI(armA, armB, { iterations = 2000, alpha = 0.05, seed = 1 } = {}) {
  if (!armA.length || !armB.length) {
    return { point: 0, low: 0, high: 0, excludesZero: false, pairs: 0, matched: false };
  }
  // The arms are matched by construction: repetition *i* of arm A and
  // repetition *i* of arm B run on the same device, same fixture, same session.
  // Resampling them independently throws that pairing away and widens the
  // interval with between-repetition variance the design already controls for,
  // so the resample draws pair indices, not two independent series.
  if (armA.length !== armB.length) {
    return { point: 0, low: 0, high: 0, excludesZero: false, pairs: 0, matched: false };
  }

  const random = mulberry32(seed);
  const pairs = armA.length;
  const point = mean(armA) === 0 ? 0 : (mean(armA) - mean(armB)) / mean(armA);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < pairs; i += 1) {
      const pick = Math.floor(random() * pairs);
      sumA += armA[pick];
      sumB += armB[pick];
    }
    const meanA = sumA / pairs;
    const meanB = sumB / pairs;
    samples.push(meanA === 0 ? 0 : (meanA - meanB) / meanA);
  }
  samples.sort((a, b) => a - b);
  const low = samples[Math.floor(samples.length * (alpha / 2))];
  const high = samples[Math.min(samples.length - 1, Math.floor(samples.length * (1 - alpha / 2)))];
  return { point, low, high, excludesZero: low > 0 || high < 0, pairs, matched: true };
}

/** Spearman rank correlation, average ranks for ties. */
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const rank = (values) => {
    const indexed = values.map((value, index) => ({ value, index }));
    indexed.sort((a, b) => a.value - b.value);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < indexed.length) {
      let j = i;
      while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
      const averageRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[indexed[k].index] = averageRank;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

/** Group durations by byte decade so size scaling is visible, not assumed. */
export function byteBuckets(pairs) {
  const buckets = new Map();
  pairs.forEach(({ bytes, durationMs }) => {
    if (!(bytes > 0)) return;
    const decade = Math.floor(Math.log10(bytes));
    if (!buckets.has(decade)) buckets.set(decade, []);
    buckets.get(decade).push(durationMs);
  });
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([decade, durations]) => ({
      decade,
      min_bytes: 10 ** decade,
      count: durations.length,
      p50_ms: percentile(durations, 0.5),
      p95_ms: percentile(durations, 0.95),
    }));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeTrace(trace, schema) {
  const { intervals, droppedClockSuspect } = buildSyncIntervals(trace, schema);
  const longTasks = [...(trace.long_tasks || [])].sort((a, b) => a.start_time - b.start_time);

  const totals = { mixed: 0, unattributed: 0 };
  CLASSES.forEach((klass) => { totals[klass] = 0; });
  const inclusiveTotals = {};
  CLASSES.forEach((klass) => { inclusiveTotals[klass] = 0; });

  const classified = { mixed: 0, unattributed: 0 };
  CLASSES.forEach((klass) => { classified[klass] = 0; });

  let blockedMs = 0;
  const perTask = [];
  longTasks.forEach((task) => {
    const window = { start: task.start_time, end: task.start_time + task.duration };
    const overlap = exclusiveOverlap(window, intervals);
    const klass = classifyLongTask(overlap);
    blockedMs += overlap.duration;
    CLASSES.forEach((c) => {
      totals[c] += overlap.exclusive[c];
      inclusiveTotals[c] += overlap.inclusive[c];
    });
    totals.mixed += overlap.exclusive.mixed;
    totals.unattributed += overlap.unattributed;
    classified[klass] += 1;
    perTask.push({ lt_id: task.lt_id, duration: task.duration, klass });
  });

  const share = (value) => (blockedMs > 0 ? value / blockedMs : 0);

  // Payload-size discriminator: response base64 decode vs response ciphertext bytes.
  const b64Pairs = [];
  const spansById = new Map();
  (trace.spans || []).forEach((span) => spansById.set(span.call_id, span));
  (trace.phases || []).forEach((phase) => {
    if (schema.phaseNames[phase.phase] !== 'res_b64_data') return;
    const span = spansById.get(phase.call_id);
    if (!span || span.clock_suspect) return;
    if (!(span.res_ciphertext_bytes > 0)) return;
    b64Pairs.push({ bytes: span.res_ciphertext_bytes, durationMs: phase.dur_us / 1000 });
  });

  const endPerf = Math.max(
    0,
    ...(trace.spans || []).map((span) => span.perf_end || 0),
    ...longTasks.map((task) => task.start_time + task.duration)
  );
  const fgIntervals = foregroundIntervals(trace, endPerf);
  const spanForeground = (trace.spans || []).map((span) => {
    const total = Math.max(0, (span.perf_end || span.perf_start) - span.perf_start);
    const fg = foregroundMs({ start: span.perf_start, end: span.perf_end || span.perf_start }, fgIntervals);
    return {
      call_id: span.call_id,
      total_ms: total,
      foreground_ms: fg,
      hidden_ms: Math.max(0, total - fg),
      spanned_background: total - fg > 0,
      clock_suspect: Boolean(span.clock_suspect),
    };
  });

  const dropped = trace.dropped || {};
  const droppedTotal = Object.values(dropped).reduce((sum, value) => sum + (Number(value) || 0), 0);

  return {
    meta: trace.meta || {},
    valid_for_causal_percentages: droppedTotal === 0,
    dropped,
    dropped_clock_suspect_phases: droppedClockSuspect,
    long_task_count: longTasks.length,
    blocked_ms: blockedMs,
    exclusive_ms: totals,
    inclusive_ms: inclusiveTotals,
    exclusive_share: {
      secure_sync: share(totals.secure_sync),
      logical_json: share(totals.logical_json),
      diagnostics_sync: share(totals.diagnostics_sync),
      mixed: share(totals.mixed),
      unattributed: share(totals.unattributed),
    },
    long_task_classes: classified,
    per_task: perTask,
    res_b64_spearman: spearman(b64Pairs.map((p) => p.bytes), b64Pairs.map((p) => p.durationMs)),
    // How many spans actually carried a measured ciphertext size. Spans whose
    // byte fields are `null` are excluded above, so this is the real n behind
    // the correlation rather than the span count.
    res_b64_pairs: b64Pairs.length,
    res_b64_buckets: byteBuckets(b64Pairs),
    populated_decades: byteBuckets(b64Pairs).filter((bucket) => bucket.count >= 3).length,
    span_foreground: spanForeground,
    suppressed: trace.suppressed || {},
    probe_overhead: trace.probe_overhead || {},
  };
}

/**
 * The pre-committed P1/P2 rule. Deliberately able to return `stop`: P0 is
 * allowed to conclude that both hypotheses are insufficient.
 */
export const REQUIRED_REPETITIONS = 5;

/**
 * Aggregate repeated P0 trace analyses for one arm into the shares the decision
 * rule reads.
 *
 * Every supplied repetition contributes. Reading `runs[0]` and ignoring the rest
 * would let a single unrepresentative trace carry the whole ordering while the
 * repetition count merely *looked* satisfied.
 *
 * - Shares are averaged across repetitions.
 * - `populated_decades` takes the **minimum**: the size-correlation gate should
 *   only pass if every repetition actually covered the required byte decades,
 *   not if one lucky run did.
 * - `valid_for_causal_percentages` is an AND: one repetition with dropped rows
 *   invalidates the set.
 *
 * @param {any|any[]} runs one analysis, or the repeated analyses for an arm
 */
export function aggregateRuns(runs) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : (runs ? [runs] : []);
  if (!list.length) return null;

  const shareKeys = [
    'secure_sync', 'logical_json', 'logical_json_unjoined',
    'diagnostics_sync', 'mixed', 'unattributed',
  ];
  const meanOf = (pick) => list.reduce((sum, run) => sum + (Number(pick(run)) || 0), 0) / list.length;

  const exclusiveShare = {};
  shareKeys.forEach((key) => {
    exclusiveShare[key] = meanOf((run) => run.exclusive_share?.[key] ?? 0);
  });

  return {
    repetitions: list.length,
    exclusive_share: exclusiveShare,
    res_b64_spearman: meanOf((run) => run.res_b64_spearman),
    populated_decades: Math.min(...list.map((run) => Number(run.populated_decades) || 0)),
    valid_for_causal_percentages: list.every((run) => run.valid_for_causal_percentages !== false),
    runs: list,
  };
}

/**
 * @param {any|any[]} armARuns repeated Arm-A trace analyses (or one analysis)
 * @param {any|any[]|null} armBRuns repeated Arm-B trace analyses, when an A/B cell was run
 * @param {{blockedArmA?: number[], blockedArmB?: number[]}} [options]
 *   Matched CDP total-blocking-time series, one value per repetition.
 */
export function decideNextPhase(armARuns, armBRuns = null, { blockedArmA = [], blockedArmB = [] } = {}) {
  const armA = aggregateRuns(armARuns);
  const armB = aggregateRuns(armBRuns);
  if (!armA) {
    // No Arm-A traces, so no shares exist to compute. Any CDP captures that did
    // arrive are still reported rather than quietly dropped — they are evidence
    // that a run happened whose trace half is missing.
    const orphanWarnings = [
      'No Arm-A trace evidence supplied: the attribution shares cannot be computed.',
      ...(blockedArmA.length
        ? [`Arm A supplied ${blockedArmA.length} CDP capture(s) with no P0 traces to pair them with.`]
        : []),
      ...(blockedArmB.length
        ? [`Arm B supplied ${blockedArmB.length} CDP capture(s) with no Arm-A analysis to compare against.`]
        : []),
      ...(armB ? [`Arm B supplied ${armB.repetitions} trace(s) with no Arm-A analysis to compare against.`] : []),
    ];
    return {
      decision: 'stop_insufficient_evidence',
      rationale: 'No Arm-A trace evidence supplied. No P1/P2 ordering may be derived.',
      trace_repetitions_arm_a: 0,
      trace_repetitions_arm_b: armB ? armB.repetitions : 0,
      cdp_repetitions_arm_a: blockedArmA.length,
      cdp_repetitions_arm_b: blockedArmB.length,
      required_repetitions: REQUIRED_REPETITIONS,
      trace_replicated: false,
      cdp_replicated: false,
      replicated: false,
      warnings: orphanWarnings,
    };
  }
  // Only logical JSON explicitly joined to a secure call supports the secure
  // hypothesis. `logical_json_unjoined` is reported but never counted here.
  const secureShare = armA.exclusive_share.secure_sync + armA.exclusive_share.logical_json;
  const diagnosticsShare = armA.exclusive_share.diagnostics_sync;
  const unattributedShare = armA.exclusive_share.unattributed;

  const spearmanOk = armA.res_b64_spearman >= 0.7 && armA.populated_decades >= 3;
  const p2Qualifies = secureShare >= 0.4 && spearmanOk;

  const reduction = armB
    ? bootstrapReductionCI(blockedArmA, blockedArmB)
    : { point: 0, low: 0, high: 0, excludesZero: false, pairs: 0, matched: false };
  const p1Qualifies = (reduction.point >= 0.4 && reduction.excludesZero) || diagnosticsShare >= 0.4;

  const traceRepsA = armA.repetitions;
  const traceRepsB = armB ? armB.repetitions : 0;
  const cdpRepsA = blockedArmA.length;
  const cdpRepsB = blockedArmB.length;

  // An arm is **represented** as soon as *either* of its artifact sets is
  // non-empty. Keying off the aggregate analysis alone was the defect: with
  // zero Arm-B traces the aggregate is null, every `!armB` guard short-circuits
  // to true, and five supplied Arm-B CDP captures are silently discarded — the
  // run then decides as if it were an A-only experiment. A supplied artifact is
  // evidence that an arm was run, whichever side of the pair it arrived on.
  const armARepresented = traceRepsA > 0 || cdpRepsA > 0;
  const armBRepresented = traceRepsB > 0 || cdpRepsB > 0;

  // Replication has two independent halves and neither substitutes for the
  // other. **P0 trace** repetitions carry the attribution shares and the
  // size-correlation gate; **CDP** repetitions carry the approved blocking
  // metric for the A/B gate. Counting CDP artifacts as though they replicated
  // the traces is forbidden: one trace plus five CDP captures is one run.
  const traceReplicated = traceRepsA >= REQUIRED_REPETITIONS
    && (!armBRepresented || traceRepsB >= REQUIRED_REPETITIONS);
  const cdpReplicated = cdpRepsA >= REQUIRED_REPETITIONS
    && (!armBRepresented || cdpRepsB >= REQUIRED_REPETITIONS);

  // Matched-run integrity: a repetition is a trace *and* its CDP capture. Every
  // represented arm must have both sides, in equal number. If they cannot be
  // paired one-to-one, the conservative answer is to stop rather than drop the
  // odd artifacts.
  const pairedA = armARepresented && traceRepsA === cdpRepsA;
  const pairedB = !armBRepresented || traceRepsB === cdpRepsB;
  const armsMatched = !armBRepresented || (traceRepsA === traceRepsB && cdpRepsA === cdpRepsB);
  const pairingOk = pairedA && pairedB && armsMatched;

  const replicated = armARepresented && traceReplicated && cdpReplicated;

  const armLabel = armBRepresented ? `arm A: ${traceRepsA}, arm B: ${traceRepsB}` : `arm A: ${traceRepsA}`;
  const cdpLabel = armBRepresented ? `arm A: ${cdpRepsA}, arm B: ${cdpRepsB}` : `arm A: ${cdpRepsA}`;

  const warnings = [
    ...(armA.valid_for_causal_percentages ? [] : ['Arm A dropped rows: invalid for causal percentages.']),
    ...(armB && !armB.valid_for_causal_percentages ? ['Arm B dropped rows: invalid for causal percentages.'] : []),
    ...(traceReplicated ? [] : [
      `Fewer than ${REQUIRED_REPETITIONS} repeated P0 traces per arm (${armLabel}): cannot decide.`,
    ]),
    ...(cdpReplicated ? [] : [
      `Fewer than ${REQUIRED_REPETITIONS} measured CDP repetitions per arm (${cdpLabel}): cannot decide.`,
    ]),
    ...(pairedA && pairedB ? [] : [
      'Trace and CDP artifact counts differ: repetitions cannot be matched into valid runs '
      + `(${armLabel} traces; ${cdpLabel} CDP captures).`,
    ]),
    ...(armsMatched ? [] : ['Arm A and arm B repetition counts differ: the matched A/B comparison is not valid.']),
    // Named explicitly, because this is the case that used to pass silently.
    ...(armBRepresented && traceRepsB === 0
      ? [`Arm B supplied ${cdpRepsB} CDP capture(s) but no P0 traces: the arm cannot be analyzed and its artifacts must not be ignored.`]
      : []),
    ...(armBRepresented && cdpRepsB === 0
      ? ['Arm B supplied P0 traces but no CDP captures: the approved blocking metric is unavailable for that arm.']
      : []),
    ...(armARepresented && traceRepsA === 0
      ? [`Arm A supplied ${cdpRepsA} CDP capture(s) but no P0 traces.`]
      : []),
    ...(armARepresented && cdpRepsA === 0
      ? ['Arm A supplied P0 traces but no CDP captures: the approved blocking metric is unavailable.']
      : []),
  ];

  let decision;
  let rationale;
  // Replication is an absolute precondition, checked before either gate is
  // evaluated. An ordering derived from a single run is not evidence, however
  // emphatic the shares look, so this must be structurally unable to return an
  // ordering.
  if (!replicated || !pairingOk) {
    decision = 'stop_insufficient_evidence';
    rationale = `Replicated evidence is absent (need ${REQUIRED_REPETITIONS} matched repetitions per arm, `
      + 'each a P0 trace paired with its CDP capture). '
      + 'No P1/P2 ordering may be derived. Collect the full repetition set and re-run.';
  } else if (unattributedShare >= 0.4) {
    decision = 'stop_p0b';
    rationale = 'Unattributed blocked time is at least 40%: both hypotheses are insufficient. Start neither P1 nor P2; run P0.b.';
  } else if (p1Qualifies && p2Qualifies) {
    decision = 'p1_first';
    rationale = 'Both gates pass. P1 goes first: lower risk, no security-sensitive code, independently verifiable.';
  } else if (p1Qualifies) {
    decision = 'p1_first';
    rationale = 'Diagnostics gate passed.';
  } else if (p2Qualifies) {
    decision = 'p2_first';
    rationale = 'Secure-path gate passed with a monotonic payload-size correlation.';
  } else {
    decision = 'stop_p0b';
    rationale = 'Neither gate passed. Start neither P1 nor P2; run P0.b.';
  }

  return {
    decision,
    rationale,
    secure_sync_share: secureShare,
    logical_json_unjoined_share: armA.exclusive_share.logical_json_unjoined,
    diagnostics_share: diagnosticsShare,
    unattributed_share: unattributedShare,
    res_b64_spearman: armA.res_b64_spearman,
    populated_decades: armA.populated_decades,
    ab_reduction: reduction,
    trace_repetitions_arm_a: traceRepsA,
    trace_repetitions_arm_b: traceRepsB,
    cdp_repetitions_arm_a: blockedArmA.length,
    cdp_repetitions_arm_b: blockedArmB.length,
    required_repetitions: REQUIRED_REPETITIONS,
    trace_replicated: traceReplicated,
    cdp_replicated: cdpReplicated,
    replicated,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function extractTrace(parsed) {
  if (parsed && parsed.p0) return parsed.p0;
  return parsed;
}

/** Phase order must match `src/lib/p0Schema.js`; the export carries indices. */
export const DEFAULT_PHASE_NAMES = [
  'logical_stringify', 'req_json', 'req_encode', 'wc_encrypt_invoke', 'req_b64_iv',
  'req_b64_data', 'native_invoke', 'res_b64_iv', 'res_b64_data', 'wc_decrypt_invoke',
  'res_decode', 'res_json', 'logical_parse', 'diag_get', 'diag_parse', 'diag_transform',
  'diag_prune_a', 'diag_prune_b', 'diag_stringify', 'diag_set',
  'queue_wait', 'session_wait', 'wc_encrypt_await', 'native_await', 'wc_decrypt_await',
];

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());

/**
 * Parse repeated-artifact arguments.
 *
 * Every flag takes any number of values, so a five-repetition run reads as
 * `--arm-a a1.json a2.json a3.json a4.json a5.json`. Bare positional arguments
 * are treated as arm-A traces.
 */
export function parseAnalyzerArgs(args) {
  const groups = { 'arm-a': [], 'arm-b': [], 'cdp-a': [], 'cdp-b': [] };
  let current = 'arm-a';
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!(name in groups)) throw new Error(`Unknown option: ${arg}`);
      current = name;
      continue;
    }
    groups[current].push(arg);
  }
  return {
    armAFiles: groups['arm-a'],
    armBFiles: groups['arm-b'],
    cdpAFiles: groups['cdp-a'],
    cdpBFiles: groups['cdp-b'],
    json,
  };
}

/**
 * Total Blocking Time per repetition, read from the independent CDP captures.
 *
 * The A/B gate uses matched CDP TBT rather than the probe's own long-task
 * durations: Arm D has no in-app probe at all, and TBT excludes the
 * non-blocking first 50 ms of every task.
 */
export function tbtSeriesFromCdpFiles(files, read = (file) => JSON.parse(readFileSync(file, 'utf8'))) {
  return files.map((file) => {
    const parsed = read(file);
    // `p0-trace.mjs` already computes TBT over the renderer main thread it
    // identified; recomputing from the rows would silently lose that filtering
    // if the row shape ever changed.
    if (Number.isFinite(parsed?.total_blocking_time_ms)) return parsed.total_blocking_time_ms;
    return totalBlockingTime(parsed?.long_tasks || parsed?.longTasks || []);
  });
}

if (isMain) {
  // Repeated artifacts are the normal case: the committed rule needs five
  // matched repetitions per arm before any ordering may be derived.
  const { armAFiles, armBFiles, cdpAFiles, cdpBFiles, json: asJson } = parseAnalyzerArgs(process.argv.slice(2));

  if (!armAFiles.length) {
    console.error(
      'Usage: node scripts/p0-analyze.mjs --arm-a <a1.json> [a2.json ...]\n'
      + '         [--arm-b <b1.json> ...] [--cdp-a <cdpA1.json> ...] [--cdp-b <cdpB1.json> ...] [--json]\n'
      + `\nThe P1/P2 decision requires ${REQUIRED_REPETITIONS} matched repetitions per arm and matched CDP\n`
      + 'captures for the A/B gate. Fewer inputs yields stop_insufficient_evidence, never an ordering.'
    );
    process.exit(1);
  }

  const schema = { phaseNames: DEFAULT_PHASE_NAMES };
  const loadTrace = (file) => analyzeTrace(extractTrace(JSON.parse(readFileSync(file, 'utf8'))), schema);
  const armARuns = armAFiles.map(loadTrace);
  const armBRuns = armBFiles.map(loadTrace);

  // Prefer matched CDP TBT. Without CDP captures there is no approved blocking
  // metric, so the series stays empty and the decision stops for lack of
  // evidence rather than silently falling back to raw long-task duration.
  const blockedArmA = cdpAFiles.length ? tbtSeriesFromCdpFiles(cdpAFiles) : [];
  const blockedArmB = cdpBFiles.length ? tbtSeriesFromCdpFiles(cdpBFiles) : [];

  // Every loaded repetition is handed to the decision rule. Passing `runs[0]`
  // here was the defect: the CLI read all the traces, then decided from one.
  const decision = decideNextPhase(armARuns, armBRuns.length ? armBRuns : null, {
    blockedArmA,
    blockedArmB,
  });
  const armA = aggregateRuns(armARuns);

  if (asJson) {
    console.log(JSON.stringify({
      arm_a_runs: armARuns,
      arm_b_runs: armBRuns,
      blocked_arm_a_tbt_ms: blockedArmA,
      blocked_arm_b_tbt_ms: blockedArmB,
      decision,
    }, null, 2));
  } else {
    const pct = (value) => `${(value * 100).toFixed(1)}%`;
    // Shares below are the mean across every supplied repetition, not run 0.
    console.log(
      `arm ${armARuns[0]?.meta?.arm ?? '?'} — ${armARuns.length} trace repetition(s), `
      + `${blockedArmA.length} CDP repetition(s)  [means across all repetitions]`
    );
    console.log(`  secure sync           ${pct(armA.exclusive_share.secure_sync)}`);
    console.log(`  logical json (joined) ${pct(armA.exclusive_share.logical_json)}`);
    console.log(`  logical json (orphan) ${pct(armA.exclusive_share.logical_json_unjoined)}  [not counted toward secure]`);
    console.log(`  diagnostics sync      ${pct(armA.exclusive_share.diagnostics_sync)}`);
    console.log(`  mixed                 ${pct(armA.exclusive_share.mixed)}`);
    console.log(`  UNATTRIBUTED          ${pct(armA.exclusive_share.unattributed)}`);
    console.log(
      `  res_b64 spearman ${armA.res_b64_spearman.toFixed(3)} (mean) over `
      + `${armA.populated_decades} populated decades (min across repetitions)`
    );
    console.log(`  per-run long tasks: [${armARuns.map((run) => run.long_task_count).join(', ')}]`);
    console.log(`  CDP TBT arm A: [${blockedArmA.map((v) => v.toFixed(0)).join(', ')}]`);
    console.log(`  CDP TBT arm B: [${blockedArmB.map((v) => v.toFixed(0)).join(', ')}]`);
    if (!armA.valid_for_causal_percentages) console.log('  WARNING: dropped rows — invalid for causal percentages');
    console.log(`\ndecision: ${decision.decision}\n  ${decision.rationale}`);
    decision.warnings.forEach((warning) => console.log(`  WARNING: ${warning}`));
  }
}
