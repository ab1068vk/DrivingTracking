import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The point of these tests is Codex's correction 1: arms B/C must short-circuit
 * at *job entry*, not at `setItem`. Suppressing only the write would leave the
 * parse / prune / sort / stringify work in place and could produce a false
 * negative for the diagnostics hypothesis. So these assert zero calls to
 * `getItem`, `JSON.parse`, `JSON.stringify` and `setItem` — not merely zero
 * `setItem`.
 */

/** @type {Map<string, string>} */
let storage;
/** @type {{ getItem: any, setItem: any, removeItem: any }} */
let storageSpies;

const installStorage = () => {
  storage = new Map();
  storageSpies = {
    getItem: vi.fn((key) => (storage.has(key) ? storage.get(key) : null)),
    setItem: vi.fn((key, value) => storage.set(key, String(value))),
    removeItem: vi.fn((key) => storage.delete(key)),
    clear: vi.fn(() => storage.clear()),
  };
  vi.stubGlobal('localStorage', storageSpies);
};

const loadModules = async (arm) => {
  vi.resetModules();
  // Debug gate via VITE_SHOW_DEBUG_ROUTES only. `DEV` stays falsy so
  // `TRIAGE_LOGS_ENABLED` is off and its per-entry console `JSON.stringify`
  // cannot pollute the strict "no serialization happened" assertions below.
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  vi.stubEnv('DEV', '');
  vi.stubEnv('VITE_PERF_TRIAGE_LOGS', '');
  storage.set('roadsage_p0_arm', arm);
  const p0 = await import('@/lib/p0Probe');
  p0.initializeP0Probe({ buildHash: 'test' });
  const systemLog = await import('@/lib/systemLog');
  const triage = await import('@/lib/performanceTriage');
  const experience = await import('@/lib/appExperienceDiagnostics');
  return { p0, systemLog, triage, experience };
};

const SYSTEM_LOG_KEY = 'drivesense_system_logs_v1';
const TRIAGE_KEY = 'roadsage_performance_history_v1';
const EXPERIENCE_KEY = 'roadsage_app_experience_events_v1';

/** Seed a saturated store so the suppressed work would be expensive if it ran. */
const seedStores = () => {
  const logs = Array.from({ length: 400 }, (_, index) => ({
    id: `log_${index}`,
    timestamp: new Date().toISOString(),
    severity: 'info',
    category: 'app',
    source: 'web',
    operation: 'seeded_event',
    title: 'Seeded',
    message: '',
    page: '/',
    details: { index },
  }));
  storage.set(SYSTEM_LOG_KEY, JSON.stringify(logs));
  storage.set(TRIAGE_KEY, JSON.stringify(
    Array.from({ length: 400 }, (_, index) => ({
      id: `entry_${index}`,
      name: 'seeded',
      durationMs: index,
      at: new Date().toISOString(),
    }))
  ));
  storage.set(EXPERIENCE_KEY, JSON.stringify(
    Array.from({ length: 400 }, (_, index) => ({
      timestamp: new Date().toISOString(),
      severity: 'info',
      category: 'app',
      source: 'web',
      operation: 'seeded_event',
      page: '/',
      details: { index },
    }))
  ));
};

const snapshotStores = () => ({
  logs: storage.get(SYSTEM_LOG_KEY),
  triage: storage.get(TRIAGE_KEY),
  experience: storage.get(EXPERIENCE_KEY),
});

beforeEach(() => {
  installStorage();
  vi.stubGlobal('PerformanceObserver', undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('arm A runs the recurring persistence jobs normally', () => {
  it('reads, transforms and writes, and records the phases', async () => {
    seedStores();
    const { p0, systemLog } = await loadModules('A');
    storageSpies.setItem.mockClear();

    systemLog.recordSystemEvent('probe_arm_a', {}, { category: 'app' });
    await vi.advanceTimersByTimeAsync(1000);

    // The flush genuinely wrote.
    expect(storageSpies.setItem.mock.calls.some(([key]) => key === SYSTEM_LOG_KEY)).toBe(true);

    const trace = p0.exportP0Trace();
    const { DIAGNOSTICS_JOBS, PHASE_IDS } = await import('@/lib/p0Schema');
    const flushSpans = trace.spans.filter(
      (row) => DIAGNOSTICS_JOBS[row.diagnostics_job] === 'system_log_flush'
    );
    expect(flushSpans.length).toBeGreaterThan(0);

    const flushSpan = flushSpans.at(-1);
    expect(flushSpan.entry_count_before).toBe(400);
    // serialized_code_units comes from the string that already existed.
    expect(flushSpan.serialized_code_units).toBeGreaterThan(0);

    const phaseNames = trace.phases
      .filter((row) => row.call_id === flushSpan.call_id)
      .map((row) => PHASE_IDS[row.phase]);
    expect(phaseNames).toEqual(expect.arrayContaining([
      'diag_get', 'diag_parse', 'diag_prune_a', 'diag_prune_b', 'diag_stringify', 'diag_set',
    ]));
    expect(trace.suppressed.system_log_flush ?? 0).toBe(0);
  });
});

describe('arms B/C short-circuit at job entry', () => {
  it.each(['B', 'C'])('performs no read, parse, stringify or write in arm %s', async (arm) => {
    seedStores();
    const before = snapshotStores();
    const { p0, systemLog, triage, experience } = await loadModules(arm);

    const parseSpy = vi.spyOn(JSON, 'parse');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    storageSpies.getItem.mockClear();
    storageSpies.setItem.mockClear();

    // Drive all three recurring persistence jobs.
    systemLog.recordSystemEvent('probe_arm_suppressed', {}, { category: 'app' });
    triage.beginMeasure('probe.arm.suppressed')({ outcome: 'success' });
    experience.recordHistoricalAppExperienceEvent({
      timestamp: new Date().toISOString(),
      severity: 'info',
      category: 'app',
      source: 'web',
      operation: 'probe_arm_suppressed',
      page: '/',
      details: {},
    });
    await vi.advanceTimersByTimeAsync(2000);

    const touched = (key) => (calls) => calls.some(([callKey]) => callKey === key);
    const diagnosticKeys = [SYSTEM_LOG_KEY, TRIAGE_KEY, EXPERIENCE_KEY];

    // Zero writes to all three diagnostic keys.
    diagnosticKeys.forEach((key) => {
      expect(touched(key)(storageSpies.setItem.mock.calls), `wrote ${key}`).toBe(false);
    });
    // And zero *reads* of them, which is the part a setItem-only guard would miss.
    diagnosticKeys.forEach((key) => {
      expect(touched(key)(storageSpies.getItem.mock.calls), `read ${key}`).toBe(false);
    });
    // No full-history parse or serialize happened either.
    expect(parseSpy).not.toHaveBeenCalled();
    expect(stringifySpy).not.toHaveBeenCalled();

    // Pre-existing history is byte-identical.
    expect(snapshotStores()).toEqual(before);

    // The suppressed work is counted, so a suppressed run is never mistaken for
    // a quiet one.
    const { suppressed } = p0.exportP0Trace();
    expect(suppressed.system_log_flush.invocations).toBeGreaterThan(0);
    expect(suppressed.performance_triage_persist.invocations).toBeGreaterThan(0);
    expect(suppressed.experience_events_flush.invocations).toBeGreaterThan(0);
    // The batch each job was carrying was moved into the bounded buffer, not
    // silently discarded.
    expect(suppressed.system_log_flush.entries_seen).toBeGreaterThan(0);
    expect(suppressed.system_log_flush.buffered).toBeGreaterThan(0);
    expect(suppressed.system_log_flush.capacity).toBeGreaterThan(0);
    expect(suppressed.system_log_flush.dropped).toBe(0);
  });

  it('still serves display reads through getSystemLogs without writing', async () => {
    seedStores();
    const before = snapshotStores();
    const { systemLog } = await loadModules('B');
    storageSpies.setItem.mockClear();

    const logs = systemLog.getSystemLogs();

    // The explicitly requested read still returns data.
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    // But it did not rewrite the store.
    expect(storageSpies.setItem.mock.calls.some(([key]) => key === SYSTEM_LOG_KEY)).toBe(false);
    expect(snapshotStores()).toEqual(before);
  });

  it('keeps redaction and zero-hour privacy retention behaviour unchanged', async () => {
    seedStores();
    // Zero-hour privacy retention.
    storage.set('drivesense_settings', JSON.stringify({ privacy_log_retention_hours: 0 }));
    const before = snapshotStores();
    const { systemLog } = await loadModules('B');
    storageSpies.setItem.mockClear();

    const recorded = systemLog.recordSystemLog({
      operation: 'privacy_zone_created',
      category: 'privacy',
      details: { label: 'Home', lat: 51.5074, lng: -0.1278 },
    });

    // The retention policy still drops the event; only the storage write is
    // suppressed.
    expect(recorded).toBeNull();
    expect(storageSpies.setItem.mock.calls.some(([key]) => key === SYSTEM_LOG_KEY)).toBe(false);
    expect(snapshotStores()).toEqual(before);
  });

  it('never suppresses an explicit user clear', async () => {
    seedStores();
    const { systemLog } = await loadModules('B');
    storageSpies.setItem.mockClear();

    systemLog.clearSystemLogs();

    // Clearing is an explicit user action, not a recurring persistence job.
    // Suppressing it would be a functional change, not a measurement one.
    expect(storageSpies.setItem.mock.calls.some(([key]) => key === SYSTEM_LOG_KEY)).toBe(true);
    expect(JSON.parse(storage.get(SYSTEM_LOG_KEY))).toEqual([]);
  });
});

describe('I-1 triage context', () => {
  it('leaves the stored dataset untouched when a caller supplies none', async () => {
    const { triage } = await loadModules('A');

    triage.setPerformanceTriageContext({
      trip_count: 128,
      completed_trip_count: 128,
      route_point_count: 59520,
      data_size_bytes: 5546978,
      experience_mode: 'coaching',
    });

    // This is what the Diagnostics page now sends while its query is loading:
    // mode fields only, no dataset fields at all. The zeroed dataset it used to
    // publish on first render is what poisoned every measurement app-wide.
    const result = triage.setPerformanceTriageContext({ experience_mode: 'tracking' });

    expect(result.trip_count).toBe(128);
    expect(result.route_point_count).toBe(59520);
    expect(result.data_size_bytes).toBe(5546978);
    // Mode fields do not depend on the query and are always applied.
    expect(result.experience_mode).toBe('tracking');
  });

  it('records a resolved zero rather than keeping stale counts forever', async () => {
    const { triage } = await loadModules('A');

    triage.setPerformanceTriageContext({ trip_count: 128, route_point_count: 59520 });

    // A device whose trips were genuinely all deleted reports zero from a
    // *resolved* query. Treating any zero as "still loading" would pin the old
    // counts in place permanently and misattribute every later measurement.
    const result = triage.setPerformanceTriageContext({
      trip_count: 0,
      completed_trip_count: 0,
      total_distance_km: 0,
      route_point_count: 0,
      data_size_bytes: 0,
    });

    expect(result.trip_count).toBe(0);
    expect(result.route_point_count).toBe(0);
  });

  it('keeps the pre-instrumentation return shape', async () => {
    const { triage } = await loadModules('A');

    const result = triage.setPerformanceTriageContext({ trip_count: 500, route_point_count: 1000 });

    expect(result.trip_count).toBe(500);
    // No field was added to the public return value by instrumentation.
    expect(Object.keys(result).sort()).toEqual([
      'completed_trip_count',
      'data_size_bytes',
      'experience_mode',
      'route_point_count',
      'total_distance_km',
      'tracking_mode',
      'trip_count',
    ]);
  });

  it('applies each dataset field independently of the others', async () => {
    const { triage } = await loadModules('A');

    triage.setPerformanceTriageContext({ trip_count: 500, route_point_count: 1000 });
    const result = triage.setPerformanceTriageContext({ trip_count: 501 });

    expect(result.trip_count).toBe(501);
    expect(result.route_point_count).toBe(1000);
  });
});


describe('bounded volatile suppressed-work buffers', () => {
  it('exposes capacity, buffered count and entry count per job', async () => {
    seedStores();
    const { p0, systemLog } = await loadModules('B');

    systemLog.recordSystemEvent('probe_buffer_shape', {}, { category: 'app' });
    await vi.advanceTimersByTimeAsync(2000);

    const job = p0.exportP0Trace().suppressed.system_log_flush;
    // The contract is a bounded buffer with visible accounting, not a bare
    // invocation counter: a suppressed run must be distinguishable from a quiet
    // one *and* from one that overflowed.
    expect(job).toEqual(expect.objectContaining({
      invocations: expect.any(Number),
      entries_seen: expect.any(Number),
      buffered: expect.any(Number),
      capacity: expect.any(Number),
      dropped: expect.any(Number),
    }));
    expect(job.entries_seen).toBeGreaterThan(0);
    expect(job.buffered).toBeGreaterThan(0);
    expect(job.buffered).toBeLessThanOrEqual(job.capacity);
  });

  it('stays bounded and counts overflow instead of losing it silently', async () => {
    const { p0 } = await loadModules('B');
    const { SUPPRESSED_BUFFER_CAPACITY } = await import('@/lib/p0Schema');
    const capacity = SUPPRESSED_BUFFER_CAPACITY.system_log_flush;

    const overshoot = 250;
    for (let index = 0; index < capacity + overshoot; index += 1) {
      p0.bufferSuppressedDiagnostics('system_log_flush', [{ index }]);
    }

    const job = p0.exportP0Trace().suppressed.system_log_flush;
    expect(job.entries_seen).toBe(capacity + overshoot);
    // Bounded at capacity...
    expect(job.buffered).toBe(capacity);
    // ...and the overflow is reported rather than silently discarded.
    expect(job.dropped).toBe(overshoot);
    expect(job.buffered + job.dropped).toBe(job.entries_seen);
  });

  it('never lets buffered entries reach the export', async () => {
    const { p0 } = await loadModules('B');

    p0.bufferSuppressedDiagnostics('system_log_flush', [
      { message: 'Dentist appointment', page: '/tracking/privacy', lat: 51.5074 },
    ]);

    // The buffer holds real diagnostics. Counters are exported; content is not.
    const serialized = JSON.stringify(p0.exportP0Trace());
    expect(serialized).not.toContain('Dentist appointment');
    expect(serialized).not.toContain('51.5074');
    expect(serialized).not.toContain('/tracking/privacy');
  });

  it('stops collecting once the trace is frozen', async () => {
    const { p0 } = await loadModules('B');

    p0.bufferSuppressedDiagnostics('system_log_flush', [{ a: 1 }]);
    const before = p0.exportP0Trace().suppressed.system_log_flush;
    expect(before.invocations).toBe(1);

    // `exportP0Trace` freezes first. Work arriving after that is not part of the
    // measured scenario and must not move the counters.
    p0.bufferSuppressedDiagnostics('system_log_flush', [{ b: 2 }, { c: 3 }]);

    const after = p0.exportP0Trace().suppressed.system_log_flush;
    expect(after.invocations).toBe(1);
    expect(after.entries_seen).toBe(before.entries_seen);
  });

  it('collects nothing at all when the probe is disabled', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'false');
    vi.stubEnv('DEV', '');
    const p0 = await import('@/lib/p0Probe');
    p0.initializeP0Probe({ buildHash: 'test' });

    p0.bufferSuppressedDiagnostics('system_log_flush', [{ a: 1 }]);
    expect(p0.__p0SuppressedBuffersForTests()).toEqual({});
  });
});

describe('diagnostics measurement outcome honesty', () => {
  const diagnosticSpans = (p0) => p0.exportP0Trace().spans.filter((row) => row.diagnostics_job > 0);

  it('records an error span when the stored history fails to parse', async () => {
    seedStores();
    const { p0, triage } = await loadModules('A');
    // A corrupt store: the app still degrades to an empty list, which is correct
    // and unchanged — but the measurement must not report success.
    storage.set(TRIAGE_KEY, '{ this is not json');

    triage.beginMeasure('probe.parse.failure')({ outcome: 'success' });
    await vi.advanceTimersByTimeAsync(2000);

    const spans = diagnosticSpans(p0);
    expect(spans.length).toBeGreaterThan(0);
    expect(p0.P0_OUTCOMES[spans.at(-1).outcome]).toBe('error');
  });

  it('records an error span when the storage write fails', async () => {
    seedStores();
    const { p0, systemLog } = await loadModules('A');
    storageSpies.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    systemLog.recordSystemEvent('probe_quota', {}, { category: 'app' });
    await vi.advanceTimersByTimeAsync(2000);

    const spans = diagnosticSpans(p0);
    expect(spans.length).toBeGreaterThan(0);
    // The half-size retry is preserved application behaviour; the span is still
    // an error, because the write it measured did not succeed.
    expect(p0.P0_OUTCOMES[spans.at(-1).outcome]).toBe('error');
  });

  it('still records success when the job genuinely completes', async () => {
    seedStores();
    const { p0, systemLog } = await loadModules('A');

    systemLog.recordSystemEvent('probe_ok', {}, { category: 'app' });
    await vi.advanceTimersByTimeAsync(2000);

    const spans = diagnosticSpans(p0);
    expect(spans.length).toBeGreaterThan(0);
    expect(p0.P0_OUTCOMES[spans.at(-1).outcome]).toBe('success');
  });

  it('leaves pre-existing diagnostic data untouched on the failure path', async () => {
    seedStores();
    const before = snapshotStores();
    const { p0, systemLog } = await loadModules('A');
    storageSpies.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    systemLog.recordSystemEvent('probe_quota_no_damage', {}, { category: 'app' });
    await vi.advanceTimersByTimeAsync(2000);

    // A failed write must not have corrupted or truncated what was there.
    expect(snapshotStores()).toEqual(before);
    expect(p0.P0_OUTCOMES[diagnosticSpans(p0).at(-1).outcome]).toBe('error');
  });
});
