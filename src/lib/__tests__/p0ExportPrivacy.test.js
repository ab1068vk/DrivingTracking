import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ARMS,
  DIAGNOSTICS_JOBS,
  EXPORT_LIFECYCLE_KEYS,
  EXPORT_LONG_TASK_KEYS,
  EXPORT_META_KEYS,
  EXPORT_NATIVE_BLOCK_KEYS,
  EXPORT_PHASE_KEYS,
  EXPORT_PROBE_OVERHEAD_KEYS,
  EXPORT_SCHEDULING_GAP_KEYS,
  EXPORT_SPAN_KEYS,
  EXPORT_TOP_LEVEL_KEYS,
  LONG_TASK_CONTAINER_TYPES,
  LONG_TASK_NAMES,
  PAYLOAD_KINDS,
  PHASE_IDS,
  SECURE_METHODS,
  SPAN_KINDS,
} from '@/lib/p0Schema';

/** @type {Map<string, string>} */
let storage;
/** @type {any} */
let probe;

const loadProbe = async () => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  vi.stubEnv('DEV', 'true');
  storage.set('roadsage_p0_arm', 'A');
  probe = await import('@/lib/p0Probe');
  probe.initializeP0Probe({ buildHash: 'deadbeef' });
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

/** Values that must never appear anywhere in a P0 export, in any form. */
const FORBIDDEN_SUBSTRINGS = [
  'trip_abc123',
  '51.5074',
  '-0.1278',
  'Dentist appointment',
  'drivesense_active_trip',
  'drivesense_trips',
  'trip-summary:',
  'indexeddb:',
  'privacy-intelligence:',
  'secret-token',
  '<div',
  'https://',
];

const assertKeys = (row, allowed, label) => {
  Object.keys(row).forEach((key) => {
    expect(allowed, `${label} exposed unexpected key ${key}`).toContain(key);
  });
};

describe('p0 export schema conformance', () => {
  it('emits only allowlisted keys at every level', async () => {
    const p0 = await loadProbe();

    const span = p0.openP0Span('secure_call');
    p0.tagP0SecureSpan(span, 'SecureBridge', 'decryptSensitivePayload');
    p0.tagP0PayloadKind(span, 'trip_summary');
    p0.recordP0Phase(span, 'res_b64_data', span.perf_start, span.perf_start + 1);
    p0.closeP0Span(span, 'success');
    p0.recordP0NativeBlock(span, { native_entry_wall_ms: 1, response_ready_wall_ms: 2 }, 0, 1);
    p0.recordP0Lifecycle('visibilitychange', 'hidden');

    const trace = p0.exportP0Trace();

    assertKeys(trace, EXPORT_TOP_LEVEL_KEYS, 'export root');
    assertKeys(trace.meta, EXPORT_META_KEYS, 'meta');
    trace.spans.forEach((row) => assertKeys(row, EXPORT_SPAN_KEYS, 'span'));
    trace.phases.forEach((row) => assertKeys(row, EXPORT_PHASE_KEYS, 'phase'));
    trace.long_tasks.forEach((row) => assertKeys(row, EXPORT_LONG_TASK_KEYS, 'long task'));
    trace.scheduling_gaps.forEach((row) => assertKeys(row, EXPORT_SCHEDULING_GAP_KEYS, 'scheduling gap'));
    trace.lifecycle_events.forEach((row) => assertKeys(row, EXPORT_LIFECYCLE_KEYS, 'lifecycle event'));
    trace.native_blocks.forEach((row) => assertKeys(row, EXPORT_NATIVE_BLOCK_KEYS, 'native block'));
  });

  it('emits only allowlisted values, not just allowlisted keys', async () => {
    const p0 = await loadProbe();

    const span = p0.openP0Span('secure_call');
    p0.tagP0SecureSpan(span, 'SecureBridge', 'decryptSensitivePayload');
    p0.tagP0PayloadKind(span, 'trip_detail');
    p0.tagP0DiagnosticsJob(span, 'system_log_flush');
    p0.recordP0Phase(span, 'logical_parse', span.perf_start, span.perf_start + 1);
    p0.closeP0Span(span, 'success');

    const trace = p0.exportP0Trace();
    const row = trace.spans[0];

    // Enum columns are indices; every one must resolve inside its frozen table.
    expect(SPAN_KINDS[row.kind]).toBe('secure_call');
    expect(SECURE_METHODS[row.method]).toBe('decryptSensitivePayload');
    expect(PAYLOAD_KINDS[row.payload_kind]).toBe('trip_detail');
    expect(DIAGNOSTICS_JOBS[row.diagnostics_job]).toBe('system_log_flush');
    expect(PHASE_IDS[trace.phases[0].phase]).toBe('logical_parse');
    expect(ARMS).toContain(trace.meta.arm);

    // Every non-meta value in the export is a number, or `null` where the
    // measurement does not exist on that path. Strings only exist in meta, and
    // meta strings are the session id, build hash, arm and run marker.
    const numericSections = ['spans', 'phases', 'long_tasks', 'scheduling_gaps', 'lifecycle_events', 'native_blocks'];
    numericSections.forEach((section) => {
      trace[section].forEach((sectionRow) => {
        Object.entries(sectionRow).forEach(([key, value]) => {
          expect(
            value === null || typeof value === 'number',
            `${section}.${key} was neither numeric nor null`
          ).toBe(true);
        });
      });
    });
  });

  it('exports an absent measurement as null, never as a number', async () => {
    const p0 = await loadProbe();

    const span = p0.openP0Span('secure_call');
    span.req_plaintext_bytes = 42;
    p0.closeP0Span(span, 'success');

    const row = p0.exportP0Trace().spans[0];
    // A measurement that was taken survives as a number...
    expect(row.req_plaintext_bytes).toBe(42);
    // ...and one that was never taken is null, so no analyzer can average the
    // sentinel into a real byte count.
    expect(row.at_rest_plaintext_bytes).toBeNull();
    expect(row.at_rest_ciphertext_bytes).toBeNull();
    expect(row.serialized_code_units).toBeNull();
  });

  it('keeps the probe_overhead section inside its own key allowlist', async () => {
    const p0 = await loadProbe();
    const trace = p0.exportP0Trace();
    assertKeys(trace.probe_overhead, EXPORT_PROBE_OVERHEAD_KEYS, 'probe_overhead');
  });

  it('collapses unknown enum inputs instead of echoing them', async () => {
    const p0 = await loadProbe();

    const span = p0.openP0Span('secure_call');
    p0.tagP0SecureSpan(span, 'AttackerPlugin', 'exfiltrateEverything');
    p0.tagP0PayloadKind(span, 'trip:abc123');
    p0.tagP0DiagnosticsJob(span, '<img src=x>');
    p0.closeP0Span(span, 'success');

    const row = p0.exportP0Trace().spans[0];
    // Unknown inputs collapse to an explicit `other` member. They must never
    // land on index 0 of a real-value table, which would file them as a genuine
    // method/job and corrupt the breakdown.
    expect(SECURE_METHODS[row.method]).toBe('other');
    expect(PAYLOAD_KINDS[row.payload_kind]).toBe('other');
    expect(DIAGNOSTICS_JOBS[row.diagnostics_job]).toBe('other');
    expect(SECURE_METHODS[0]).toBe('other');
    expect(DIAGNOSTICS_JOBS[0]).toBe('other');
  });
});

describe('p0 export privacy fuzzing', () => {
  it('cannot be made to carry trip, location, note, key or DOM content', async () => {
    const p0 = await loadProbe();

    const hostileStrings = [
      'trip_abc123',
      'trip-summary:trip_abc123',
      'storage:drivesense_active_trip',
      'indexeddb:drivesense_speed_knowledge/knowledge:x',
      'privacy-intelligence:self-test',
      '51.5074,-0.1278',
      'Dentist appointment',
      '<div id="secret-token">https://example.com/secret-token</div>',
      'secret-token',
    ];

    hostileStrings.forEach((hostile) => {
      const span = p0.openP0Span(hostile);
      p0.tagP0SecureSpan(span, hostile, hostile);
      p0.tagP0PayloadKind(span, hostile);
      p0.tagP0DiagnosticsJob(span, hostile);
      p0.recordP0Phase(span, hostile, 1, 2);
      p0.closeP0Span(span, hostile);
      p0.recordP0NativeBlock(span, {
        native_entry_wall_ms: hostile,
        method_work_us: hostile,
        extra_attacker_field: hostile,
      }, 0, 0);
      p0.recordP0Lifecycle(hostile, hostile);
    });

    p0.setP0RunMarker('trip_abc123 51.5074');

    const serialized = JSON.stringify(p0.exportP0Trace());
    FORBIDDEN_SUBSTRINGS.forEach((forbidden) => {
      expect(serialized, `export leaked ${forbidden}`).not.toContain(forbidden);
    });
  });

  it('rejects a hostile run marker rather than exporting it', async () => {
    const p0 = await loadProbe();
    expect(p0.setP0RunMarker('trip_abc123 51.5074')).toBe(false);
    expect(p0.exportP0Trace().meta.run_marker).toBe('');
  });

  it('never exports long task container names, sources or URLs', async () => {
    // The observer is the only place DOM-derived data could enter. The schema
    // has no key for container name/src/id at all, which is the guarantee.
    expect(EXPORT_LONG_TASK_KEYS).not.toContain('container_name');
    expect(EXPORT_LONG_TASK_KEYS).not.toContain('container_src');
    expect(EXPORT_LONG_TASK_KEYS).not.toContain('container_id');
    expect(EXPORT_LONG_TASK_KEYS).toEqual([
      'lt_id',
      'start_time',
      'duration',
      'name',
      'container_type',
      'attribution_count',
    ]);
    expect(LONG_TASK_NAMES).toContain('unknown');
    expect(LONG_TASK_CONTAINER_TYPES).toContain('unknown');
  });
});
