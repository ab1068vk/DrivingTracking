import { afterEach, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('does not let an injected IndexedDB wait appear inside any synchronous diag phase', async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  const localValues = new Map([['roadsage_p0_arm', 'A']]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => localValues.get(key) ?? null),
    setItem: vi.fn((key, value) => localValues.set(key, String(value))),
    removeItem: vi.fn((key) => localValues.delete(key)),
  });
  const fake = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fake);
  vi.stubGlobal('IDBKeyRange', fake.keyRange);

  const p0 = await import('@/lib/p0Probe');
  p0.initializeP0Probe({ buildHash: 'p1-delay-test' });
  const { createDiagnosticsStorage } = await import('@/lib/diagnosticsStorage');
  const { createDiagnosticsHistoryStore } = await import('@/lib/diagnosticsHistoryStore');
  const storage = createDiagnosticsStorage({
    indexedDbFactory: fake,
    keyRangeFactory: fake.keyRange,
    now: () => Date.now(),
    uidFactory: () => 'delayed',
  });
  const repository = createDiagnosticsHistoryStore({
    kind: 'performance',
    legacyKey: 'legacy_performance',
    capacity: 2500,
    pendingCap: 128,
    flushDelayMs: 100,
    jobName: 'performance_triage_persist',
    orderIndex: 'by_kind_payload_time',
    orderWidth: 3,
    direction: 'next',
    mapLegacy: () => [],
    finalizeRead: (records) => records,
  }, {
    storage,
    localStorage,
    now: () => Date.now(),
    crypto: globalThis.crypto,
    retryDelayMs: 0,
  });
  repository.enqueue({ id: 'delayed' }, {
    payloadTimestampMs: Date.now(),
    expiresAtMs: Date.now() + 1000,
  });
  fake.delayNextRequest({ storeName: 'events', operation: 'get', delayMs: 500 });

  const flush = repository.flush();
  await vi.advanceTimersByTimeAsync(500);
  await flush;

  const trace = p0.exportP0Trace();
  const { DIAGNOSTICS_JOBS } = await import('@/lib/p0Schema');
  const span = trace.spans.find((row) => (
    DIAGNOSTICS_JOBS[row.diagnostics_job] === 'performance_triage_persist'
  ));
  const phases = trace.phases.filter((row) => row.call_id === span.call_id);
  expect(span.perf_end - span.perf_start).toBeGreaterThanOrEqual(500);
  expect(phases.length).toBeGreaterThan(0);
  expect(phases.every((phase) => phase.sync === 1)).toBe(true);
  expect(Math.max(...phases.map((phase) => phase.dur_us))).toBeLessThan(50_000);
});

it('does not read the P0 clock for storage scheduling when Arm D is probe-off', async () => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  const localValues = new Map([['roadsage_p0_arm', 'D']]);
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key) => localValues.get(key) ?? null),
    setItem: vi.fn((key, value) => localValues.set(key, String(value))),
    removeItem: vi.fn((key) => localValues.delete(key)),
  });
  const p0Clock = vi.fn(() => 10);
  vi.stubGlobal('performance', { now: p0Clock });
  const fake = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fake);
  vi.stubGlobal('IDBKeyRange', fake.keyRange);
  const p0 = await import('@/lib/p0Probe');
  p0.initializeP0Probe({ buildHash: 'p1-probe-off-test' });
  const { createDiagnosticsStorage } = await import('@/lib/diagnosticsStorage');
  const { createDiagnosticsHistoryStore } = await import('@/lib/diagnosticsHistoryStore');
  const storage = createDiagnosticsStorage({
    indexedDbFactory: fake,
    keyRangeFactory: fake.keyRange,
    now: () => 1,
    uidFactory: () => 'probe-off',
  });
  const repository = createDiagnosticsHistoryStore({
    kind: 'performance',
    legacyKey: 'legacy_performance',
    capacity: 2500,
    pendingCap: 128,
    flushDelayMs: 100,
    jobName: 'performance_triage_persist',
    orderIndex: 'by_kind_payload_time',
    orderWidth: 3,
    direction: 'next',
    mapLegacy: () => [],
    finalizeRead: (records) => records,
  }, {
    storage,
    localStorage,
    now: () => 1,
    crypto: globalThis.crypto,
  });
  p0Clock.mockClear();
  repository.enqueue({ id: 'probe-off' }, { payloadTimestampMs: 1, expiresAtMs: 2 });

  await repository.flush();

  expect(p0Clock).not.toHaveBeenCalled();
  expect(p0.exportP0Trace()).toBeNull();
});
