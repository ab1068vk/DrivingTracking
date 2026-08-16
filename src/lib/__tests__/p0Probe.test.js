import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** @type {Map<string, string>} */
let storage;
/** @type {any} */
let probe;

const loadProbe = async ({ arm = 'A', debug = true } = {}) => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', debug ? 'true' : 'false');
  vi.stubEnv('DEV', debug ? 'true' : '');
  storage.set('roadsage_p0_arm', arm);
  probe = await import('@/lib/p0Probe');
  return probe;
};

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  });
  vi.stubGlobal('PerformanceObserver', undefined);
});

afterEach(() => {
  probe?.__resetP0ProbeForTests?.();
  probe = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('p0 probe activation', () => {
  it('is inert in a release build', async () => {
    const p0 = await loadProbe({ arm: 'B', debug: false });
    expect(p0.initializeP0Probe()).toBe(false);
    expect(p0.isP0ProbeActive()).toBe(false);

    // Every entry point must be a safe no-op when the probe is off.
    const span = p0.openP0Span('secure_call');
    expect(span).toBeNull();
    expect(() => p0.recordP0Phase(span, 'req_json', 1, 2)).not.toThrow();
    expect(() => p0.closeP0Span(span, 'success')).not.toThrow();
    expect(() => p0.recordP0Lifecycle('visibilitychange', 'hidden')).not.toThrow();
    expect(p0.exportP0Trace()).toBeNull();
  });

  it('is inert in arm D so CDP is the only measurement source', async () => {
    const p0 = await loadProbe({ arm: 'D' });
    expect(p0.initializeP0Probe()).toBe(false);
    expect(p0.isP0ProbeActive()).toBe(false);
  });

  it('activates in arms A/B/C', async () => {
    const p0 = await loadProbe({ arm: 'C' });
    expect(p0.initializeP0Probe({ buildHash: 'abc123' })).toBe(true);
    expect(p0.isP0ProbeActive()).toBe(true);
    expect(p0.exportP0Trace().meta.build_hash).toBe('abc123');
  });
});

describe('spans and phases', () => {
  it('records raw un-rounded performance values', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.tagP0SecureSpan(span, 'SecureBridge', 'decryptSensitivePayload');
    p0.recordP0Phase(span, 'res_b64_data', span.perf_start + 1.234567, span.perf_start + 3.891011);
    p0.closeP0Span(span, 'success');

    const trace = p0.exportP0Trace();
    expect(trace.spans).toHaveLength(1);
    expect(trace.phases).toHaveLength(1);

    const phase = trace.phases[0];
    // Microsecond offsets, but no rounding applied by the probe itself.
    expect(phase.rel_start_us).toBeCloseTo(1234.567, 3);
    expect(phase.dur_us).toBeCloseTo(2656.444, 3);
    expect(phase.sync).toBe(1);
    expect(Number.isInteger(trace.spans[0].perf_start)).toBe(false);
  });

  it('marks latency phases as non-synchronous', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.recordP0Phase(span, 'queue_wait', 10, 40);
    p0.recordP0Phase(span, 'native_await', 40, 90);
    p0.recordP0Phase(span, 'native_invoke', 39, 40);
    p0.closeP0Span(span, 'success');

    const { phases } = p0.exportP0Trace();
    const syncFlags = phases.map((row) => row.sync);
    // queue_wait and native_await are latency; only native_invoke owns CPU.
    expect(syncFlags).toEqual([0, 0, 1]);
  });

  it('keeps a partial record when a call fails mid-phase', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.recordP0Phase(span, 'req_json', 1, 2);
    p0.closeP0Span(span, 'error');

    const trace = p0.exportP0Trace();
    expect(trace.spans[0].outcome).toBe(1);
    expect(trace.phases).toHaveLength(1);
  });

  it('allocates monotonic call ids', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    const first = p0.nextP0CallId();
    const second = p0.nextP0CallId();
    expect(second).toBe(first + 1);
  });
});

describe('clock suspicion', () => {
  const closeSpanWithGap = (p0, gapMs) => {
    const span = p0.openP0Span('secure_call');
    // Simulate wall time advancing further than the monotonic clock, which is
    // what a suspension or clock change looks like.
    span.wall_start_ms -= gapMs;
    p0.closeP0Span(span, 'success');
  };

  it('does not flag a span below the threshold', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    closeSpanWithGap(p0, 100);
    expect(p0.exportP0Trace().spans[0].clock_suspect).toBe(0);
  });

  it('does not flag a span exactly at the threshold', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    closeSpanWithGap(p0, 250);
    // Strictly greater-than, so the boundary itself is still trusted.
    expect(p0.exportP0Trace().spans[0].clock_suspect).toBe(0);
  });

  it('flags a span above the threshold', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    closeSpanWithGap(p0, 400);
    const span = p0.exportP0Trace().spans[0];
    expect(span.clock_suspect).toBe(1);
    expect(span.clock_gap_ms).toBeGreaterThan(250);
  });
});

describe('effective foreground epochs', () => {
  it('advances once for a physical transition that fires both sources', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    expect(p0.p0ForegroundEpoch()).toBe(0);

    // A single physical background transition fires both callbacks.
    p0.recordP0Lifecycle('visibilitychange', 'hidden');
    p0.recordP0Lifecycle('appStateChange', 'inactive');

    expect(p0.p0ForegroundEpoch()).toBe(1);
    expect(p0.p0EffectiveForeground()).toBe(false);

    const { lifecycle_events: events } = p0.exportP0Trace();
    // Both raw events stay separately visible even though they share one epoch.
    expect(events).toHaveLength(2);
    expect(events[0].source).not.toBe(events[1].source);
    expect(events.every((event) => event.epoch === 1)).toBe(true);
  });

  it('requires both document visibility and native activity for foreground', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    p0.recordP0Lifecycle('appStateChange', 'inactive');
    expect(p0.p0EffectiveForeground()).toBe(false);

    // Document still visible, but the app is not active: still background.
    p0.recordP0Lifecycle('visibilitychange', 'visible');
    expect(p0.p0EffectiveForeground()).toBe(false);
    expect(p0.p0ForegroundEpoch()).toBe(1);

    p0.recordP0Lifecycle('appStateChange', 'active');
    expect(p0.p0EffectiveForeground()).toBe(true);
    expect(p0.p0ForegroundEpoch()).toBe(2);
  });

  it('stamps spans with their start and end epoch', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.recordP0Lifecycle('visibilitychange', 'hidden');
    p0.recordP0Lifecycle('appStateChange', 'inactive');
    p0.closeP0Span(span, 'success');

    const row = p0.exportP0Trace().spans[0];
    expect(row.start_epoch).toBe(0);
    expect(row.end_epoch).toBe(1);
    expect(row.start_state).toBe(1);
    expect(row.end_state).toBe(0);
  });
});

describe('ring budgets', () => {
  it('overwrites oldest rows and reports the drop so the run is visibly invalid', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const rings = p0.__p0RingStateForTests();
    const capacity = rings.lifecycle.capacity;
    for (let index = 0; index < capacity + 5; index += 1) {
      p0.recordP0Lifecycle('visibilitychange', index % 2 === 0 ? 'hidden' : 'visible');
    }

    const trace = p0.exportP0Trace();
    expect(trace.lifecycle_events).toHaveLength(capacity);
    expect(trace.dropped.lifecycle_events).toBe(5);
    expect(trace.budget.lifecycle_events_peak).toBe(capacity);
  });

  it('reports zero drops for a run within budget', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    p0.recordP0Lifecycle('visibilitychange', 'hidden');

    const trace = p0.exportP0Trace();
    expect(trace.dropped.lifecycle_events).toBe(0);
    expect(trace.dropped.spans).toBe(0);
    expect(trace.dropped.phases).toBe(0);
  });
});

describe('export hygiene', () => {
  it('freezes collection before serializing and reports serialization separately', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.closeP0Span(span, 'success');
    const trace = p0.exportP0Trace();

    expect(p0.isP0ProbeActive()).toBe(false);
    // This path only materializes rows, so that is the only cost it may claim.
    // Serialization did not happen here and must not report as zero.
    expect(trace.probe_overhead.export_materialize_ms).toBeGreaterThanOrEqual(0);
    expect(trace.probe_overhead.export_serialize_ms).toBeNull();

    // Post-freeze activity must not enter the trace.
    p0.recordP0Lifecycle('visibilitychange', 'hidden');
    expect(p0.exportP0Trace().lifecycle_events).toHaveLength(0);
  });

  it('rejects run markers that are not strict experiment tokens', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    expect(p0.setP0RunMarker('boot-1000-arma')).toBe(true);
    expect(p0.setP0RunMarker('bad marker')).toBe(false);
    expect(p0.exportP0Trace().meta.run_marker).toBe('boot-1000-arma');
  });

  it('accounts for its own write cost', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    for (let index = 0; index < 64; index += 1) {
      p0.recordP0Phase(span, 'req_json', index, index + 1);
    }
    p0.closeP0Span(span, 'success');

    const overhead = p0.exportP0Trace().probe_overhead;
    expect(overhead.write_count).toBeGreaterThanOrEqual(64);
    expect(overhead.self_time_samples).toBeGreaterThan(0);
    expect(overhead.sample_rate).toBe(32);
  });
});

describe('native block ingestion', () => {
  it('records the authoritative entry-to-ready total and the named-phase residual', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.closeP0Span(span, 'success');
    p0.recordP0NativeBlock(span, {
      native_entry_wall_ms: 1000,
      response_ready_wall_ms: 1050,
      native_total_internal_us: 50000,
      transport_b64_decode_us: 1000,
      transport_aes_decrypt_us: 2000,
      envelope_json_parse_us: 500,
      method_work_us: 30000,
      response_json_us: 400,
      response_utf8_us: 300,
      response_aes_encrypt_us: 1500,
      response_b64_encode_us: 800,
    }, 990, 60);

    const block = p0.exportP0Trace().native_blocks[0];
    expect(block.native_total_internal_us).toBe(50000);
    expect(block.named_phase_total_us).toBe(36500);
    // Unnamed native work must remain visible rather than vanishing.
    expect(block.named_phase_residual_us).toBe(13500);
    expect(block.pre_native_dispatch_ms).toBe(10);
  });

  it('cannot be thrown by hostile or missing native data', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    p0.closeP0Span(span, 'success');

    expect(() => p0.recordP0NativeBlock(span, null, 0)).not.toThrow();
    expect(() => p0.recordP0NativeBlock(span, 'not-an-object', 0)).not.toThrow();
    expect(() => p0.recordP0NativeBlock(span, {
      native_entry_wall_ms: { toString() { throw new Error('hostile'); } },
      method_work_us: 'NaN',
      transport_b64_decode_us: Infinity,
    }, 0)).not.toThrow();

    const blocks = p0.exportP0Trace().native_blocks;
    // Unavailable measurements export as `null`, never as a number an analyzer
    // could average into a real duration.
    expect(blocks.at(-1).method_work_us).toBeNull();
    expect(blocks.at(-1).transport_b64_decode_us).toBeNull();
  });

  it('cannot be thrown by a native block whose property reads are traps', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    // The *property read* is the hostile surface, not just the coercion: a
    // getter or proxy trap throws before any value exists to coerce.
    const hostileBlock = {
      get native_entry_wall_ms() { throw new Error('getter trap'); },
      get method_work_us() { throw new Error('getter trap'); },
      response_ready_wall_ms: 5,
    };
    expect(() => p0.recordP0NativeBlock(span, hostileBlock, 0)).not.toThrow();

    const proxyBlock = new Proxy({}, {
      get() { throw new Error('proxy trap'); },
      has() { throw new Error('proxy trap'); },
    });
    expect(() => p0.recordP0NativeBlock(span, proxyBlock, 0)).not.toThrow();

    p0.closeP0Span(span, 'success');
    const blocks = p0.exportP0Trace().native_blocks;
    expect(blocks.at(-1).method_work_us).toBeNull();
    expect(blocks.at(-1).native_entry_wall_ms).toBeNull();
  });

  it('finalizes the cross-clock verdict at span close, not at ingestion', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    // A suspension *after* the native block is ingested still invalidates the
    // cross-clock estimate. Recording the verdict at ingestion would leave it
    // falsely valid.
    const span = p0.openP0Span('secure_call');
    span.wall_post_native_ms = Date.now();
    p0.recordP0NativeBlock(span, {
      native_entry_wall_ms: Date.now(),
      response_ready_wall_ms: Date.now(),
      native_total_internal_us: 1000,
    }, Date.now());

    // Simulate the clock jumping between ingestion and close.
    span.wall_start_ms -= 5000;
    p0.closeP0Span(span, 'success');

    const trace = p0.exportP0Trace();
    expect(trace.spans.at(-1).clock_suspect).toBe(1);
    expect(trace.native_blocks.at(-1).cross_clock_invalid).toBe(1);
  });

  it('keeps a trusted cross-clock verdict when the span closes cleanly', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    const span = p0.openP0Span('secure_call');
    span.wall_post_native_ms = Date.now() + 4;
    p0.recordP0NativeBlock(span, {
      native_entry_wall_ms: Date.now(),
      response_ready_wall_ms: Date.now() + 2,
      native_total_internal_us: 1500,
    }, Date.now());
    p0.closeP0Span(span, 'success');

    const trace = p0.exportP0Trace();
    expect(trace.spans.at(-1).clock_suspect).toBe(0);
    expect(trace.native_blocks.at(-1).cross_clock_invalid).toBe(0);
    // Post-native delivery is a direct difference of two wall samples, not a
    // residual backed out of the total.
    expect(trace.native_blocks.at(-1).post_native_delivery_ms).toBe(
      span.wall_post_native_ms - trace.native_blocks.at(-1).response_ready_wall_ms
    );
  });
});

describe('export contract', () => {
  it('carries the frozen thresholds the collector actually used', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    const meta = p0.exportP0Trace().meta;
    expect(meta.clock_suspect_threshold_ms).toBe(250);
    expect(meta.scheduling_gap_threshold_ms).toBe(250);
  });

  it('constrains build_hash to the build-token grammar', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe({ buildHash: 'a'.repeat(200) });
    expect(p0.exportP0Trace().meta.build_hash).toBe('');
  });

  it('accepts a well-formed build token', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe({ buildHash: '285a0788-dirty.2' });
    expect(p0.exportP0Trace().meta.build_hash).toBe('285a0788-dirty.2');
  });

  it('rejects a build hash carrying arbitrary content', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe({ buildHash: '<div>https://evil.example/secret</div>' });
    expect(p0.exportP0Trace().meta.build_hash).toBe('');
  });

  it('reports materialization and serialization as separate costs', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();
    const span = p0.openP0Span('secure_call');
    p0.closeP0Span(span, 'success');

    const json = p0.serializeP0Trace();
    const parsed = JSON.parse(json);
    // Both keys exist and are independently reported; row materialization can
    // no longer masquerade as serialization cost.
    expect(parsed.probe_overhead).toHaveProperty('export_materialize_ms');
    expect(parsed.probe_overhead).toHaveProperty('export_serialize_ms');
    expect(parsed.probe_overhead.export_serialize_ms).toBeGreaterThanOrEqual(0);
    expect(parsed.probe_overhead.init_alloc_ms).toBeGreaterThanOrEqual(0);
  });

  it('charges span allocation to the writer self-time budget', async () => {
    const p0 = await loadProbe();
    p0.initializeP0Probe();

    // Sample rate is 1-in-32, so allocate enough spans that the counter must
    // advance if span opening is charged at all.
    for (let index = 0; index < 64; index += 1) {
      const span = p0.openP0Span('secure_call');
      p0.closeP0Span(span, 'success');
    }
    const overhead = p0.exportP0Trace().probe_overhead;
    // 64 opens + 64 closes = 128 writes; batching only closes would give 64.
    expect(overhead.write_count).toBeGreaterThanOrEqual(128);
  });
});
