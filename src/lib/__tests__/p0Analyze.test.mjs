import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PHASE_NAMES,
  aggregateRuns,
  analyzeTrace,
  bootstrapReductionCI,
  buildSyncIntervals,
  byteBuckets,
  classifyLongTask,
  classifyPhase,
  decideNextPhase,
  exclusiveOverlap,
  foregroundIntervals,
  foregroundMs,
  parseAnalyzerArgs,
  spearman,
  tbtSeriesFromCdpFiles,
  totalBlockingTime,
} from '../../../scripts/p0-analyze.mjs';
import {
  RETENTION_MS,
  buildDiagnosticStores,
  retentionSafeTimestamps,
} from '../../../scripts/p0-seed-dataset.mjs';

const schema = { phaseNames: DEFAULT_PHASE_NAMES };
const phaseIndex = (name) => DEFAULT_PHASE_NAMES.indexOf(name);

/** Build a minimal trace: one span with the given phases. */
const traceWith = ({ spans = [], phases = [], longTasks = [], lifecycle = [], dropped = {} } = {}) => ({
  meta: { arm: 'A' },
  spans,
  phases,
  long_tasks: longTasks,
  lifecycle_events: lifecycle,
  dropped,
});

const span = (id, start, end, extra = {}) => ({
  call_id: id,
  perf_start: start,
  perf_end: end,
  clock_suspect: 0,
  // Unavailable measurements arrive as `null`, matching the export contract.
  res_ciphertext_bytes: null,
  ...extra,
});

const phase = (callId, name, relStartUs, durUs, sync = 1) => ({
  call_id: callId,
  phase: phaseIndex(name),
  rel_start_us: relStartUs,
  dur_us: durUs,
  sync,
});

describe('phase classification', () => {
  it('routes each phase to its class and excludes latency phases', () => {
    expect(classifyPhase('res_b64_data')).toBe('secure_sync');
    expect(classifyPhase('native_invoke')).toBe('secure_sync');
    expect(classifyPhase('logical_parse')).toBe('logical_json');
    expect(classifyPhase('diag_prune_a')).toBe('diagnostics_sync');
    // Awaited time never owns CPU.
    expect(classifyPhase('native_await')).toBeNull();
    expect(classifyPhase('queue_wait')).toBeNull();
    expect(classifyPhase('wc_encrypt_await')).toBeNull();
  });
});

describe('interval reconstruction', () => {
  it('rebuilds absolute intervals from span anchor plus microsecond offsets', () => {
    const { intervals } = buildSyncIntervals(
      traceWith({
        spans: [span(1, 100, 200)],
        phases: [phase(1, 'res_b64_data', 5000, 2000)],
      }),
      schema
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0].start).toBeCloseTo(105, 6);
    expect(intervals[0].end).toBeCloseTo(107, 6);
    expect(intervals[0].klass).toBe('secure_sync');
  });

  it('drops phases from a clock-suspect span and reports the count', () => {
    const { intervals, droppedClockSuspect } = buildSyncIntervals(
      traceWith({
        spans: [span(1, 100, 200, { clock_suspect: 1 }), span(2, 300, 400)],
        phases: [phase(1, 'res_b64_data', 0, 1000), phase(2, 'req_json', 0, 1000)],
      }),
      schema
    );
    // A span whose clocks diverged cannot be trusted to sit where it claims.
    expect(intervals).toHaveLength(1);
    expect(intervals[0].callId).toBe(2);
    expect(droppedClockSuspect).toBe(1);
  });

  it('ignores phases marked as latency even if they carry a known id', () => {
    const { intervals } = buildSyncIntervals(
      traceWith({
        spans: [span(1, 0, 10)],
        phases: [phase(1, 'native_await', 0, 5000, 0)],
      }),
      schema
    );
    expect(intervals).toHaveLength(0);
  });
});

describe('exclusive overlap', () => {
  it('assigns each blocked millisecond to at most one class', () => {
    const window = { start: 0, end: 10 };
    const intervals = [
      { start: 0, end: 6, klass: 'secure_sync' },
      { start: 4, end: 8, klass: 'diagnostics_sync' },
    ];
    const overlap = exclusiveOverlap(window, intervals);

    // Inclusive double-counts the 4–6 ms shared region: 6 + 4 = 10 of a 10 ms task.
    expect(overlap.inclusive.secure_sync).toBeCloseTo(6, 6);
    expect(overlap.inclusive.diagnostics_sync).toBeCloseTo(4, 6);

    // Exclusive splits it: 0–4 secure, 4–6 mixed, 6–8 diagnostics, 8–10 uncovered.
    expect(overlap.exclusive.secure_sync).toBeCloseTo(4, 6);
    expect(overlap.exclusive.mixed).toBeCloseTo(2, 6);
    expect(overlap.exclusive.diagnostics_sync).toBeCloseTo(2, 6);
    expect(overlap.unattributed).toBeCloseTo(2, 6);

    const totalExclusive = overlap.exclusive.secure_sync
      + overlap.exclusive.diagnostics_sync
      + overlap.exclusive.logical_json
      + overlap.exclusive.mixed
      + overlap.unattributed;
    expect(totalExclusive).toBeCloseTo(overlap.duration, 6);
  });

  it('clips intervals to the task window', () => {
    const overlap = exclusiveOverlap({ start: 10, end: 20 }, [
      { start: 0, end: 15, klass: 'secure_sync' },
      { start: 18, end: 40, klass: 'secure_sync' },
    ]);
    expect(overlap.exclusive.secure_sync).toBeCloseTo(7, 6);
    expect(overlap.unattributed).toBeCloseTo(3, 6);
  });

  it('reports a fully uncovered task as entirely unattributed', () => {
    const overlap = exclusiveOverlap({ start: 0, end: 12 }, []);
    expect(overlap.unattributed).toBeCloseTo(12, 6);
    expect(classifyLongTask(overlap)).toBe('unattributed');
  });

  it('leaves the response-AAD encode visible as unattributed residual', () => {
    // The response AAD `TextEncoder.encode` sits between `res_b64_iv` and
    // `res_b64_data` and deliberately has no phase id — adding another clock
    // pair could cost more than the constant-size encode it would measure.
    // The analyzer must leave that residual visible rather than folding it into
    // either neighbouring phase, which would silently inflate a secure_sync
    // interval with time it did not measure.
    const { intervals } = buildSyncIntervals(
      traceWith({
        spans: [span(1, 0, 10)],
        phases: [
          phase(1, 'res_b64_iv', 0, 2000),
          // 2 ms gap: the unmeasured AAD encode.
          phase(1, 'res_b64_data', 4000, 2000),
        ],
      }),
      schema
    );

    expect(intervals).toHaveLength(2);
    // Neither interval was stretched to close the gap.
    expect(intervals[0].end).toBeCloseTo(2, 6);
    expect(intervals[1].start).toBeCloseTo(4, 6);

    const overlap = exclusiveOverlap({ start: 0, end: 6 }, intervals);
    expect(overlap.exclusive.secure_sync).toBeCloseTo(4, 6);
    expect(overlap.unattributed).toBeCloseTo(2, 6);
  });
});

describe('long task classification', () => {
  it('requires 60% exclusive coverage to name a class', () => {
    const dominant = exclusiveOverlap({ start: 0, end: 10 }, [{ start: 0, end: 7, klass: 'secure_sync' }]);
    expect(classifyLongTask(dominant)).toBe('secure_sync');

    const weak = exclusiveOverlap({ start: 0, end: 10 }, [{ start: 0, end: 5, klass: 'secure_sync' }]);
    expect(classifyLongTask(weak)).toBe('unattributed');
  });

  it('classifies a jointly covered task as mixed rather than picking a winner', () => {
    const overlap = exclusiveOverlap({ start: 0, end: 10 }, [
      { start: 0, end: 10, klass: 'secure_sync' },
      { start: 0, end: 10, klass: 'diagnostics_sync' },
    ]);
    expect(overlap.exclusive.mixed).toBeCloseTo(10, 6);
    expect(classifyLongTask(overlap)).toBe('mixed');
  });
});

describe('foreground intersection', () => {
  it('treats time before the first transition as foreground', () => {
    const intervals = foregroundIntervals(traceWith({ lifecycle: [] }), 100);
    expect(intervals).toEqual([{ start: 0, end: 100 }]);
  });

  it('splits foreground around a hidden period', () => {
    const intervals = foregroundIntervals(
      traceWith({
        lifecycle: [
          { perf_ms: 50, effective_foreground: 0 },
          { perf_ms: 80, effective_foreground: 1 },
        ],
      }),
      100
    );
    expect(intervals).toEqual([{ start: 0, end: 50 }, { start: 80, end: 100 }]);
  });

  it('computes foreground-only time for a span crossing two hidden periods', () => {
    const intervals = [{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 100 }];
    // A span spanning 0–50 was only foreground for 10 + 10 + 10 = 30 ms.
    expect(foregroundMs({ start: 0, end: 50 }, intervals)).toBeCloseTo(30, 6);
  });

  it('excludes unmeasured byte fields from the payload-size correlation', () => {
    // A span whose ciphertext size was never measured exports `null`. It must be
    // dropped from the correlation, not coerced into a data point — a sentinel
    // treated as a real byte count would drag the discriminator toward a
    // conclusion no measurement supports.
    const analysis = analyzeTrace(
      traceWith({
        spans: [
          span(1, 0, 10, { res_ciphertext_bytes: null }),
          span(2, 20, 30, { res_ciphertext_bytes: 1000 }),
          span(3, 40, 50, { res_ciphertext_bytes: 100000 }),
        ],
        phases: [
          phase(1, 'res_b64_data', 0, 1000),
          phase(2, 'res_b64_data', 0, 2000),
          phase(3, 'res_b64_data', 0, 200000),
        ],
      }),
      schema
    );
    // Two usable pairs, not three: the null span contributed nothing.
    expect(analysis.res_b64_pairs).toBe(2);
  });

  it('marks a span that spanned background', () => {
    const analysis = analyzeTrace(
      traceWith({
        spans: [span(1, 0, 100)],
        lifecycle: [
          { perf_ms: 10, effective_foreground: 0 },
          { perf_ms: 60, effective_foreground: 1 },
        ],
      }),
      schema
    );
    const row = analysis.span_foreground[0];
    expect(row.total_ms).toBe(100);
    expect(row.hidden_ms).toBeCloseTo(50, 6);
    expect(row.foreground_ms).toBeCloseTo(50, 6);
    expect(row.spanned_background).toBe(true);
  });
});

describe('statistics', () => {
  it('computes Spearman rho for a monotonic relationship', () => {
    expect(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).toBeCloseTo(1, 6);
    expect(spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });

  it('returns zero rho for a constant series', () => {
    expect(spearman([1, 2, 3], [5, 5, 5])).toBe(0);
  });

  it('produces a reproducible bootstrap interval', () => {
    const armA = [100, 110, 105, 98, 102];
    const armB = [50, 52, 48, 55, 51];
    const first = bootstrapReductionCI(armA, armB, { seed: 7 });
    const second = bootstrapReductionCI(armA, armB, { seed: 7 });

    expect(first).toEqual(second);
    expect(first.point).toBeGreaterThan(0.4);
    expect(first.excludesZero).toBe(true);
  });

  it('does not exclude zero when the arms are indistinguishable', () => {
    const armA = [100, 101, 99, 100, 100];
    const armB = [100, 99, 101, 100, 100];
    const result = bootstrapReductionCI(armA, armB, { seed: 3 });
    expect(result.excludesZero).toBe(false);
  });

  it('buckets durations by byte decade', () => {
    const buckets = byteBuckets([
      { bytes: 500, durationMs: 1 },
      { bytes: 900, durationMs: 3 },
      { bytes: 5000, durationMs: 10 },
      { bytes: 50000, durationMs: 100 },
    ]);
    expect(buckets.map((bucket) => bucket.decade)).toEqual([2, 3, 4]);
    expect(buckets[0].count).toBe(2);
    expect(buckets[0].p50_ms).toBe(1);
  });
});

describe('decision gates', () => {
  const baseAnalysis = (overrides = {}) => ({
    exclusive_share: {
      secure_sync: 0, logical_json: 0, logical_json_unjoined: 0, diagnostics_sync: 0, mixed: 0, unattributed: 0,
    },
    res_b64_spearman: 0,
    populated_decades: 0,
    valid_for_causal_percentages: true,
    ...overrides,
  });

  /**
   * A fully replicated arm: five repeated P0 traces, as the committed rule
   * requires. These tests exercise the *gates*, so they must clear the
   * replication precondition first rather than relying on CDP count to imply it.
   */
  const replicatedArm = (overrides = {}) => Array.from({ length: 5 }, () => baseAnalysis(overrides));
  const fiveCdp = [1, 2, 3, 4, 5];

  it('stops when unattributed blocked time is at least 40%', () => {
    const decision = decideNextPhase(replicatedArm({
      exclusive_share: { secure_sync: 0.5, logical_json: 0, diagnostics_sync: 0.1, mixed: 0, unattributed: 0.4 },
      res_b64_spearman: 0.9,
      populated_decades: 4,
    }), null, { blockedArmA: fiveCdp });

    // Even with a passing secure gate, a large unattributed share wins: both
    // hypotheses are insufficient and P0 must be allowed to say so.
    expect(decision.decision).toBe('stop_p0b');
    expect(decision.rationale).toContain('insufficient');
  });

  it('stops when neither gate passes', () => {
    const decision = decideNextPhase(replicatedArm({
      exclusive_share: { secure_sync: 0.2, logical_json: 0.05, diagnostics_sync: 0.2, mixed: 0.25, unattributed: 0.3 },
    }), null, { blockedArmA: fiveCdp });
    expect(decision.decision).toBe('stop_p0b');
  });

  it('picks P2 when secure sync dominates with a monotonic size correlation', () => {
    const decision = decideNextPhase(replicatedArm({
      exclusive_share: { secure_sync: 0.45, logical_json: 0.05, diagnostics_sync: 0.1, mixed: 0.1, unattributed: 0.3 },
      res_b64_spearman: 0.85,
      populated_decades: 3,
    }), null, { blockedArmA: fiveCdp });
    expect(decision.decision).toBe('p2_first');
  });

  it('refuses P2 when the correlation lacks three populated decades', () => {
    const decision = decideNextPhase(replicatedArm({
      exclusive_share: { secure_sync: 0.5, logical_json: 0, diagnostics_sync: 0.1, mixed: 0.1, unattributed: 0.3 },
      res_b64_spearman: 0.95,
      populated_decades: 2,
    }), null, { blockedArmA: fiveCdp });
    expect(decision.decision).toBe('stop_p0b');
  });

  it('picks P1 first when both gates pass', () => {
    const decision = decideNextPhase(replicatedArm({
      exclusive_share: { secure_sync: 0.45, logical_json: 0, diagnostics_sync: 0.45, mixed: 0.05, unattributed: 0.05 },
      res_b64_spearman: 0.9,
      populated_decades: 3,
    }), null, { blockedArmA: fiveCdp });
    expect(decision.decision).toBe('p1_first');
    expect(decision.rationale).toContain('lower risk');
  });

  it('warns when the data is unreplicated or dropped rows', () => {
    const decision = decideNextPhase(baseAnalysis({
      exclusive_share: { secure_sync: 0, logical_json: 0, diagnostics_sync: 0.5, mixed: 0, unattributed: 0.1 },
      valid_for_causal_percentages: false,
    }), null, { blockedArmA: [1] });

    expect(decision.replicated).toBe(false);
    expect(decision.warnings.join(' ')).toContain('repeated P0 traces per arm');
    expect(decision.warnings.join(' ')).toContain('invalid for causal percentages');
    // And it is a hard stop, not merely a warning attached to an ordering.
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });
});

describe('end-to-end trace analysis', () => {
  it('attributes a long task covered by diagnostics work', () => {
    const analysis = analyzeTrace(
      traceWith({
        spans: [span(1, 1000, 1020)],
        phases: [phase(1, 'diag_stringify', 0, 18000)],
        longTasks: [{ lt_id: 1, start_time: 1000, duration: 20 }],
      }),
      schema
    );
    expect(analysis.long_task_classes.diagnostics_sync).toBe(1);
    expect(analysis.exclusive_share.diagnostics_sync).toBeCloseTo(0.9, 6);
    expect(analysis.blocked_ms).toBe(20);
  });

  it('flags a run with dropped rows as invalid for causal percentages', () => {
    const analysis = analyzeTrace(
      traceWith({ spans: [], phases: [], longTasks: [], dropped: { spans: 5, phases: 0 } }),
      schema
    );
    expect(analysis.valid_for_causal_percentages).toBe(false);
  });

  it('reports a clean run as valid', () => {
    const analysis = analyzeTrace(
      traceWith({ dropped: { spans: 0, phases: 0, long_tasks: 0 } }),
      schema
    );
    expect(analysis.valid_for_causal_percentages).toBe(true);
  });
});

describe('replication is an absolute precondition', () => {
  const passingSecureAnalysis = () => ({
    exclusive_share: {
      secure_sync: 0.6, logical_json: 0.1, logical_json_unjoined: 0,
      diagnostics_sync: 0.05, mixed: 0.05, unattributed: 0.2,
    },
    res_b64_spearman: 0.95,
    populated_decades: 4,
    valid_for_causal_percentages: true,
  });

  it('refuses to order P1/P2 from a single repetition', () => {
    // The shares here pass the secure gate emphatically. It must still not
    // produce an ordering: one run is not replicated evidence, and an ordering
    // derived from it looks identical to a real one downstream.
    const decision = decideNextPhase(passingSecureAnalysis(), null, { blockedArmA: [1000] });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.replicated).toBe(false);
    expect(decision.warnings.join(' ')).toContain('repetitions');
  });

  it.each([1, 2, 3, 4])('refuses to order P1/P2 from %i repetitions', (count) => {
    const decision = decideNextPhase(passingSecureAnalysis(), null, {
      blockedArmA: Array.from({ length: count }, (_, index) => 1000 + index),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });

  it('allows an ordering once five traces and five CDP captures are present', () => {
    const decision = decideNextPhase(
      Array.from({ length: 5 }, passingSecureAnalysis),
      null,
      { blockedArmA: [1000, 1010, 990, 1005, 995] }
    );
    expect(decision.trace_replicated).toBe(true);
    expect(decision.cdp_replicated).toBe(true);
    expect(decision.replicated).toBe(true);
    expect(decision.decision).toBe('p2_first');
  });

  it('refuses when arm B is under-replicated even though arm A is not', () => {
    const armB = passingSecureAnalysis();
    const decision = decideNextPhase(passingSecureAnalysis(), armB, {
      blockedArmA: [1000, 1010, 990, 1005, 995],
      blockedArmB: [500, 510],
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });

  it('refuses when the arms have mismatched repetition counts', () => {
    const armB = passingSecureAnalysis();
    const decision = decideNextPhase(passingSecureAnalysis(), armB, {
      blockedArmA: [1000, 1010, 990, 1005, 995, 1002],
      blockedArmB: [500, 510, 490, 505, 495],
    });
    // Unequal counts mean the pairs cannot be matched, so the A/B comparison is
    // not the one the design specified.
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('differ');
  });
});

describe('logical JSON only counts toward the secure share when joined', () => {
  it('classifies unparented logical JSON separately', () => {
    // A logical span with no secure child: real JSON work, but nothing about it
    // supports the secure-bridge hypothesis.
    const { intervals } = buildSyncIntervals(
      traceWith({
        spans: [span(1, 0, 10, { parent_op_id: 0 })],
        phases: [phase(1, 'logical_stringify', 0, 5000)],
      }),
      schema
    );
    expect(intervals[0].klass).toBe('logical_json_unjoined');
  });

  it('counts logical JSON that a secure call explicitly claims as its parent', () => {
    const { intervals } = buildSyncIntervals(
      traceWith({
        spans: [
          span(1, 0, 10),
          // The secure call names span 1 as its logical parent.
          span(2, 2, 8, { parent_op_id: 1 }),
        ],
        phases: [phase(1, 'logical_stringify', 0, 5000)],
      }),
      schema
    );
    expect(intervals[0].klass).toBe('logical_json');
  });

  it('keeps orphan logical JSON out of the secure gate', () => {
    const analysis = {
      exclusive_share: {
        secure_sync: 0.2, logical_json: 0, logical_json_unjoined: 0.5,
        diagnostics_sync: 0.05, mixed: 0.05, unattributed: 0.2,
      },
      res_b64_spearman: 0.95,
      populated_decades: 4,
      valid_for_causal_percentages: true,
    };
    const decision = decideNextPhase(analysis, null, { blockedArmA: [1, 2, 3, 4, 5] });

    // 0.2 + 0.5 would clear the 0.4 secure gate if orphan logical JSON counted.
    expect(decision.secure_sync_share).toBeCloseTo(0.2, 6);
    expect(decision.decision).not.toBe('p2_first');
    expect(decision.logical_json_unjoined_share).toBeCloseTo(0.5, 6);
  });
});

describe('matched A/B bootstrap', () => {
  it('preserves pairing rather than resampling the arms independently', () => {
    // Perfectly paired data: every repetition halves. The matched resample sees
    // the same 50% in every draw, so the interval is tight around 0.5.
    const armA = [100, 200, 300, 400, 500];
    const armB = [50, 100, 150, 200, 250];
    const result = bootstrapReductionCI(armA, armB, { seed: 11 });

    expect(result.matched).toBe(true);
    expect(result.pairs).toBe(5);
    expect(result.point).toBeCloseTo(0.5, 6);
    // Independent resampling would mix a low-A draw with a high-B draw and
    // widen this interval; matched pairing keeps it exact.
    expect(result.low).toBeCloseTo(0.5, 6);
    expect(result.high).toBeCloseTo(0.5, 6);
    expect(result.excludesZero).toBe(true);
  });

  it('refuses to compute a matched interval from unequal arms', () => {
    const result = bootstrapReductionCI([1, 2, 3, 4, 5], [1, 2, 3], { seed: 5 });
    expect(result.matched).toBe(false);
    expect(result.excludesZero).toBe(false);
  });
});

describe('total blocking time', () => {
  it('counts only the part of each task beyond 50 ms', () => {
    expect(totalBlockingTime([{ duration: 50 }])).toBe(0);
    expect(totalBlockingTime([{ duration: 60 }])).toBe(10);
    expect(totalBlockingTime([{ duration: 250 }, { duration: 40 }])).toBe(200);
  });

  it('accepts the CDP capture row shape as well as the probe row shape', () => {
    expect(totalBlockingTime([{ duration_ms: 90 }])).toBe(40);
  });

  it('differs from raw long-task duration, which is why the gate uses it', () => {
    const tasks = [{ duration: 60 }, { duration: 60 }, { duration: 60 }];
    const raw = tasks.reduce((sum, task) => sum + task.duration, 0);
    expect(raw).toBe(180);
    // Three barely-blocking tasks are 30 ms of blocking, not 180.
    expect(totalBlockingTime(tasks)).toBe(30);
  });

  it('reads a precomputed CDP total in preference to recomputing it', () => {
    const series = tbtSeriesFromCdpFiles(['a', 'b'], (file) => (
      file === 'a'
        ? { total_blocking_time_ms: 1234 }
        : { long_tasks: [{ duration_ms: 150 }] }
    ));
    expect(series).toEqual([1234, 100]);
  });
});

describe('analyzer CLI argument parsing', () => {
  it('collects repeated artifacts per arm', () => {
    const parsed = parseAnalyzerArgs([
      '--arm-a', 'a1.json', 'a2.json', 'a3.json',
      '--arm-b', 'b1.json', 'b2.json',
      '--cdp-a', 'ca1.json',
      '--cdp-b', 'cb1.json',
      '--json',
    ]);
    expect(parsed.armAFiles).toEqual(['a1.json', 'a2.json', 'a3.json']);
    expect(parsed.armBFiles).toEqual(['b1.json', 'b2.json']);
    expect(parsed.cdpAFiles).toEqual(['ca1.json']);
    expect(parsed.cdpBFiles).toEqual(['cb1.json']);
    expect(parsed.json).toBe(true);
  });

  it('treats bare positional arguments as arm A traces', () => {
    expect(parseAnalyzerArgs(['a1.json', 'a2.json']).armAFiles).toEqual(['a1.json', 'a2.json']);
  });

  it('rejects an unknown option instead of silently ignoring it', () => {
    expect(() => parseAnalyzerArgs(['--arm-c', 'x.json'])).toThrow('Unknown option');
  });
});

describe('deterministic fixture behaviour', () => {
  it('dates diagnostic entries inside their retention window, not outside it', () => {
    const epochMs = Date.UTC(2026, 7, 15, 8, 0, 0);
    const stores = buildDiagnosticStores(true, epochMs);

    // The defect this covers: a fixed calendar epoch produced a "saturated"
    // store whose every entry was already past the 90-day cutoff, so the first
    // prune emptied it and the saturated cell measured an empty store.
    const checks = [
      ['roadsage_performance_history_v1', (row) => row.at],
      ['drivesense_system_logs_v1', (row) => row.timestamp],
      ['roadsage_app_experience_events_v1', (row) => row.timestamp],
    ];
    checks.forEach(([key, readStamp]) => {
      const rows = stores[key];
      expect(rows.length).toBeGreaterThan(0);
      const cutoff = epochMs - RETENTION_MS[key];
      rows.forEach((row) => {
        const at = Date.parse(readStamp(row));
        expect(at).toBeGreaterThan(cutoff);
        expect(at).toBeLessThanOrEqual(epochMs);
      });
    });
  });

  it('keeps the short system-log window in mind, not just the 90-day ones', () => {
    const epochMs = Date.UTC(2026, 7, 15, 8, 0, 0);
    const logs = buildDiagnosticStores(true, epochMs).drivesense_system_logs_v1;
    // System logs are retained for three days, so a fixture spread over 45 days
    // would be almost entirely pruned on load.
    const oldest = Date.parse(logs[0].timestamp);
    expect(epochMs - oldest).toBeLessThan(RETENTION_MS.drivesense_system_logs_v1);
  });

  it('spreads timestamps deterministically for the same epoch', () => {
    const epochMs = Date.UTC(2026, 7, 15, 8, 0, 0);
    expect(retentionSafeTimestamps(5, epochMs, 90 * 24 * 60 * 60 * 1000))
      .toEqual(retentionSafeTimestamps(5, epochMs, 90 * 24 * 60 * 60 * 1000));
  });

  it('places the newest entry at the epoch and the oldest inside the window', () => {
    const epochMs = Date.UTC(2026, 7, 15, 8, 0, 0);
    const retention = 90 * 24 * 60 * 60 * 1000;
    const stamps = retentionSafeTimestamps(10, epochMs, retention);

    expect(Date.parse(stamps.at(-1))).toBe(epochMs);
    expect(Date.parse(stamps[0])).toBeGreaterThan(epochMs - retention);
  });

  it('produces an empty store set when not saturated', () => {
    const stores = buildDiagnosticStores(false, Date.UTC(2026, 7, 15));
    expect(stores.roadsage_performance_history_v1).toEqual([]);
    expect(stores.drivesense_system_logs_v1).toEqual([]);
    expect(stores.roadsage_app_experience_events_v1).toEqual([]);
  });
});

/**
 * Chunk 12: repeated P0 *trace* evidence must participate in replication.
 *
 * The defect: the CLI loaded every repeated trace but analyzed only `runs[0]`,
 * and replication was derived from the CDP arrays. One trace plus five CDP
 * artifacts therefore looked like five replicated runs and could return an
 * ordering.
 */
describe('trace replication participates in the precondition', () => {
  const strongSecure = () => ({
    exclusive_share: {
      secure_sync: 0.6, logical_json: 0.1, logical_json_unjoined: 0,
      diagnostics_sync: 0.05, mixed: 0.05, unattributed: 0.2,
    },
    res_b64_spearman: 0.95,
    populated_decades: 4,
    valid_for_causal_percentages: true,
  });
  const strongDiagnostics = () => ({
    exclusive_share: {
      secure_sync: 0.05, logical_json: 0, logical_json_unjoined: 0,
      diagnostics_sync: 0.6, mixed: 0.05, unattributed: 0.3,
    },
    res_b64_spearman: 0,
    populated_decades: 0,
    valid_for_causal_percentages: true,
  });
  const times = (n, make) => Array.from({ length: n }, make);
  const series = (n, base) => Array.from({ length: n }, (_, index) => base + index);

  it('does not treat one Arm-A trace plus five Arm-A CDP artifacts as five runs', () => {
    const decision = decideNextPhase([strongSecure()], null, {
      blockedArmA: series(5, 1000),
    });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_a).toBe(1);
    expect(decision.cdp_repetitions_arm_a).toBe(5);
    expect(decision.trace_replicated).toBe(false);
    // CDP count must not manufacture the missing trace replication.
    expect(decision.cdp_replicated).toBe(true);
    expect(decision.replicated).toBe(false);
    expect(decision.warnings.join(' ')).toContain('repeated P0 traces per arm');
  });

  it('does not treat one Arm-B trace plus five Arm-B CDP artifacts as five runs', () => {
    const decision = decideNextPhase(times(5, strongDiagnostics), [strongDiagnostics()], {
      blockedArmA: series(5, 1000),
      blockedArmB: series(5, 400),
    });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_a).toBe(5);
    expect(decision.trace_repetitions_arm_b).toBe(1);
    expect(decision.trace_replicated).toBe(false);
  });

  it('stops when both arms are short of repeated traces', () => {
    const decision = decideNextPhase([strongSecure()], [strongSecure()], {
      blockedArmA: series(5, 1000),
      blockedArmB: series(5, 400),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });

  it('proceeds to the normal gates with five traces and matched CDP on both arms', () => {
    const decision = decideNextPhase(times(5, strongDiagnostics), times(5, strongDiagnostics), {
      blockedArmA: series(5, 1000),
      blockedArmB: series(5, 400),
    });

    expect(decision.trace_replicated).toBe(true);
    expect(decision.cdp_replicated).toBe(true);
    expect(decision.replicated).toBe(true);
    // Replication satisfied, so the gates actually run and produce an ordering.
    expect(decision.decision).toBe('p1_first');
  });

  it('still requires CDP replication when the traces are replicated', () => {
    // Trace evidence alone does not substitute for the approved blocking metric.
    const decision = decideNextPhase(times(5, strongSecure), null, { blockedArmA: [] });
    expect(decision.trace_replicated).toBe(true);
    expect(decision.cdp_replicated).toBe(false);
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });
});

describe('every repeated trace contributes to the aggregate', () => {
  const run = (secure, diagnostics, unattributed) => ({
    exclusive_share: {
      secure_sync: secure, logical_json: 0, logical_json_unjoined: 0,
      diagnostics_sync: diagnostics, mixed: 0, unattributed,
    },
    res_b64_spearman: 0.95,
    populated_decades: 4,
    valid_for_causal_percentages: true,
  });
  const cdp = [1000, 1010, 990, 1005, 995];

  it('averages shares across repetitions rather than reading index 0', () => {
    const runs = [run(1, 0, 0), run(0, 0, 1), run(0, 0, 1), run(0, 0, 1), run(0, 0, 1)];
    const aggregate = aggregateRuns(runs);

    expect(aggregate.repetitions).toBe(5);
    expect(aggregate.exclusive_share.secure_sync).toBeCloseTo(0.2, 6);
    expect(aggregate.exclusive_share.unattributed).toBeCloseTo(0.8, 6);
  });

  it('lets a later repetition change the decision, not just the first', () => {
    // Run 0 is identical in both sets and on its own would clear the secure gate.
    const secureFirst = run(0.7, 0.05, 0.2);

    const consistent = [secureFirst, run(0.7, 0.05, 0.2), run(0.7, 0.05, 0.2), run(0.7, 0.05, 0.2), run(0.7, 0.05, 0.2)];
    const contradicted = [secureFirst, run(0, 0, 1), run(0, 0, 1), run(0, 0, 1), run(0, 0, 1)];

    expect(decideNextPhase(consistent, null, { blockedArmA: cdp }).decision).toBe('p2_first');
    // Four repetitions that are almost entirely unattributed must overturn the
    // first run's verdict. Index 0 controlling the outcome is the defect.
    expect(decideNextPhase(contradicted, null, { blockedArmA: cdp }).decision).toBe('stop_p0b');
  });

  it('takes the minimum populated decades so one lucky run cannot pass the gate', () => {
    const rich = { ...run(0.6, 0.05, 0.2), populated_decades: 4 };
    const poor = { ...run(0.6, 0.05, 0.2), populated_decades: 1 };
    const aggregate = aggregateRuns([rich, poor, rich, rich, rich]);

    expect(aggregate.populated_decades).toBe(1);
    expect(decideNextPhase([rich, poor, rich, rich, rich], null, { blockedArmA: cdp }).decision)
      .not.toBe('p2_first');
  });

  it('invalidates the set when any single repetition dropped rows', () => {
    const clean = run(0.6, 0.05, 0.2);
    const dropped = { ...clean, valid_for_causal_percentages: false };
    const aggregate = aggregateRuns([clean, clean, dropped, clean, clean]);

    expect(aggregate.valid_for_causal_percentages).toBe(false);
    expect(decideNextPhase([clean, clean, dropped, clean, clean], null, { blockedArmA: cdp })
      .warnings.join(' ')).toContain('invalid for causal percentages');
  });

  it('accepts a single analysis as a one-repetition arm', () => {
    // Back-compatible shape, but it is one repetition and cannot decide.
    const aggregate = aggregateRuns(run(0.6, 0.05, 0.2));
    expect(aggregate.repetitions).toBe(1);
  });
});

describe('unpairable repeated artifacts fail conservatively', () => {
  const ok = () => ({
    exclusive_share: {
      secure_sync: 0.05, logical_json: 0, logical_json_unjoined: 0,
      diagnostics_sync: 0.6, mixed: 0.05, unattributed: 0.3,
    },
    res_b64_spearman: 0,
    populated_decades: 0,
    valid_for_causal_percentages: true,
  });
  const times = (n) => Array.from({ length: n }, ok);
  const series = (n, base) => Array.from({ length: n }, (_, index) => base + index);

  it('stops when an arm has more traces than CDP captures', () => {
    const decision = decideNextPhase(times(6), null, { blockedArmA: series(5, 1000) });
    // Six traces and five captures cannot be paired into six runs; dropping the
    // extra trace would quietly change the measured set.
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('cannot be matched');
  });

  it('stops when an arm has more CDP captures than traces', () => {
    const decision = decideNextPhase(times(5), null, { blockedArmA: series(6, 1000) });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('cannot be matched');
  });

  it('stops when the two arms have different repetition counts', () => {
    const decision = decideNextPhase(times(6), times(5), {
      blockedArmA: series(6, 1000),
      blockedArmB: series(5, 400),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('repetition counts differ');
  });

  it('never truncates to the shorter series to force a decision', () => {
    const decision = decideNextPhase(times(9), times(5), {
      blockedArmA: series(9, 1000),
      blockedArmB: series(5, 400),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_a).toBe(9);
    expect(decision.trace_repetitions_arm_b).toBe(5);
  });
});

describe('stop_p0b and stop_insufficient_evidence stay distinct', () => {
  const times = (n, make) => Array.from({ length: n }, make);
  const cdp = [1, 2, 3, 4, 5];

  it('reports insufficient evidence when the run set is inadequate', () => {
    const decision = decideNextPhase([{
      exclusive_share: {
        secure_sync: 0.1, logical_json: 0, logical_json_unjoined: 0,
        diagnostics_sync: 0.1, mixed: 0, unattributed: 0.8,
      },
      res_b64_spearman: 0,
      populated_decades: 0,
      valid_for_causal_percentages: true,
    }], null, { blockedArmA: cdp });

    // Unattributed is 80%, but that is not the finding here: there is not
    // enough evidence to make any finding at all.
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.rationale).toContain('Replicated evidence is absent');
  });

  it('reports stop_p0b when the evidence is adequate but explains nothing', () => {
    const decision = decideNextPhase(times(5, () => ({
      exclusive_share: {
        secure_sync: 0.1, logical_json: 0, logical_json_unjoined: 0,
        diagnostics_sync: 0.1, mixed: 0, unattributed: 0.8,
      },
      res_b64_spearman: 0,
      populated_decades: 0,
      valid_for_causal_percentages: true,
    })), null, { blockedArmA: cdp });

    // Fully replicated, and the answer is a real finding: both hypotheses are
    // insufficient. That is a different conclusion from "we cannot tell yet".
    expect(decision.decision).toBe('stop_p0b');
    expect(decision.replicated).toBe(true);
    expect(decision.rationale).toContain('Unattributed');
  });
});

/**
 * Chunk 13: an arm represented on only one side of the trace/CDP pair.
 *
 * The defect: arm representation was keyed off the aggregate analysis object.
 * With zero Arm-B traces that aggregate is null, every `!armB` guard
 * short-circuits, and supplied Arm-B CDP captures are silently discarded — the
 * run then decides as though it were an A-only experiment and can return
 * `p1_first` with no warning at all.
 *
 * The invariant: an arm is represented when `traces > 0 || cdp > 0`, and every
 * represented arm must have a valid matched trace/CDP set.
 */
describe('asymmetric artifact arms fail conservatively', () => {
  const diagnosticsHeavy = () => ({
    exclusive_share: {
      secure_sync: 0.05, logical_json: 0, logical_json_unjoined: 0,
      diagnostics_sync: 0.6, mixed: 0.05, unattributed: 0.3,
    },
    res_b64_spearman: 0,
    populated_decades: 0,
    valid_for_causal_percentages: true,
  });
  const traces = (n) => Array.from({ length: n }, diagnosticsHeavy);
  const cdp = (n, base) => Array.from({ length: n }, (_, index) => base + index);

  it('stops when arm B has CDP captures but no traces', () => {
    const decision = decideNextPhase(traces(5), [], {
      blockedArmA: cdp(5, 1000),
      blockedArmB: cdp(5, 400),
    });

    // This is the exact case that previously returned p1_first with no warning.
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_b).toBe(0);
    expect(decision.cdp_repetitions_arm_b).toBe(5);
    expect(decision.warnings.join(' ')).toContain('Arm B supplied 5 CDP capture(s) but no P0 traces');
  });

  it('stops when arm B has CDP captures but a null trace set', () => {
    // `null` rather than `[]`: the CLI passes null when no --arm-b files were
    // given, and the B CDP captures must still not be ignored.
    const decision = decideNextPhase(traces(5), null, {
      blockedArmA: cdp(5, 1000),
      blockedArmB: cdp(5, 400),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('no P0 traces');
  });

  it('stops when arm B has traces but no CDP captures', () => {
    const decision = decideNextPhase(traces(5), traces(5), {
      blockedArmA: cdp(5, 1000),
      blockedArmB: [],
    });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_b).toBe(5);
    expect(decision.cdp_repetitions_arm_b).toBe(0);
    expect(decision.warnings.join(' ')).toContain('Arm B supplied P0 traces but no CDP captures');
  });

  it('stops when arm A has CDP captures but no traces', () => {
    const decision = decideNextPhase([], null, { blockedArmA: cdp(5, 1000) });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_a).toBe(0);
    expect(decision.cdp_repetitions_arm_a).toBe(5);
    // The orphaned captures are reported, not silently dropped.
    expect(decision.warnings.join(' ')).toContain('5 CDP capture(s) with no P0 traces');
  });

  it('stops when arm A has traces but no CDP captures', () => {
    const decision = decideNextPhase(traces(5), null, { blockedArmA: [] });

    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_a).toBe(5);
    expect(decision.cdp_repetitions_arm_a).toBe(0);
    expect(decision.warnings.join(' ')).toContain('Arm A supplied P0 traces but no CDP captures');
  });

  it('stops when only a single stray arm-B CDP capture is supplied', () => {
    // Even one orphan artifact represents arm B and must not be ignored.
    const decision = decideNextPhase(traces(5), null, {
      blockedArmA: cdp(5, 1000),
      blockedArmB: [400],
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.cdp_repetitions_arm_b).toBe(1);
  });

  it('stops when only a single stray arm-B trace is supplied', () => {
    const decision = decideNextPhase(traces(5), traces(1), {
      blockedArmA: cdp(5, 1000),
      blockedArmB: [],
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.trace_repetitions_arm_b).toBe(1);
  });

  it('still decides normally for a valid matched A-only run', () => {
    // Arm B genuinely absent from both sides: not represented, so it imposes no
    // requirement and the A-only decision behaviour is unchanged.
    const decision = decideNextPhase(traces(5), null, { blockedArmA: cdp(5, 1000) });

    expect(decision.decision).toBe('p1_first');
    expect(decision.replicated).toBe(true);
    expect(decision.trace_repetitions_arm_b).toBe(0);
    expect(decision.cdp_repetitions_arm_b).toBe(0);
    expect(decision.warnings).toEqual([]);
  });

  it('still decides normally for a valid matched A+B run', () => {
    const decision = decideNextPhase(traces(5), traces(5), {
      blockedArmA: cdp(5, 1000),
      blockedArmB: cdp(5, 400),
    });

    expect(decision.decision).toBe('p1_first');
    expect(decision.replicated).toBe(true);
    expect(decision.warnings).toEqual([]);
  });

  it('keeps the within-arm trace == cdp rule for arm B as well as arm A', () => {
    const decision = decideNextPhase(traces(5), traces(5), {
      blockedArmA: cdp(5, 1000),
      blockedArmB: cdp(6, 400),
    });
    expect(decision.decision).toBe('stop_insufficient_evidence');
    expect(decision.warnings.join(' ')).toContain('cannot be matched');
  });

  it('reports every supplied artifact count rather than discarding any', () => {
    const decision = decideNextPhase(traces(3), traces(2), {
      blockedArmA: cdp(4, 1000),
      blockedArmB: cdp(1, 400),
    });

    // Nothing is truncated or ignored: all four counts survive into the result.
    expect(decision.trace_repetitions_arm_a).toBe(3);
    expect(decision.trace_repetitions_arm_b).toBe(2);
    expect(decision.cdp_repetitions_arm_a).toBe(4);
    expect(decision.cdp_repetitions_arm_b).toBe(1);
    expect(decision.decision).toBe('stop_insufficient_evidence');
  });
});
