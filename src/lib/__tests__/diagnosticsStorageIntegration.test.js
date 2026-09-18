import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

const SYSTEM_KEY = 'drivesense_system_logs_v1';
const SETTINGS_KEY = 'drivesense_settings';
const DB_NAME = 'roadsage_diagnostics';
const EVENTS_STORE = 'events';
const NOW = Date.UTC(2026, 7, 15, 12);
const DAY = 24 * 60 * 60 * 1000;

const makeStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
};

const loadSystemLog = async (local = makeStorage()) => {
  const fake = new FakeIndexedDb();
  vi.stubGlobal('indexedDB', fake);
  vi.stubGlobal('IDBKeyRange', fake.keyRange);
  vi.stubGlobal('localStorage', local);
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    dispatchEvent,
    location: { pathname: '/system-logs' },
  });
  vi.stubGlobal('CustomEvent', class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  });
  const module = await import('@/lib/systemLog');
  return { fake, local, module, dispatchEvent };
};

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'false');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('system diagnostics storage integration', () => {
  it('preserves the legacy object graph, property order, and JSON/CSV exporter output through migration', async () => {
    const legacy = [{
      id: 'legacy-1',
      timestamp: new Date(NOW - 1000).toISOString(),
      severity: 'warn',
      category: 'app',
      source: 'web',
      operation: 'legacy_shape',
      title: 'Legacy',
      message: 'kept verbatim',
      page: '/legacy',
      details: { z: 'last-first', tokenLikeButPreviouslyStored: 'unchanged' },
      unknown_outer_field: { b: 2, a: 1 },
    }];
    const local = makeStorage({
      [SYSTEM_KEY]: JSON.stringify(legacy),
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { module } = await loadSystemLog(local);
    const beforeJson = await module.exportSystemLogsJson(legacy);
    const beforeCsv = await module.exportSystemLogsCsv(legacy);

    const migrated = await module.getSystemLogs();
    const afterJson = await module.exportSystemLogsJson(migrated);
    const afterCsv = await module.exportSystemLogsCsv(migrated);

    expect(migrated).toEqual(legacy);
    expect(Object.keys(migrated[0])).toEqual(Object.keys(legacy[0]));
    expect(Object.keys(migrated[0].unknown_outer_field)).toEqual(['b', 'a']);
    expect(afterJson).toBe(beforeJson);
    expect(afterCsv).toBe(beforeCsv);
    expect(local.values.has(SYSTEM_KEY)).toBe(false);
  });

  it('indexes fixed standard expiry while sensitive rows stay sparse in that index', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { fake, module, dispatchEvent } = await loadSystemLog(local);
    module.recordSystemEvent('ordinary_event', {}, { category: 'app' });
    module.recordSystemEvent('privacy_zone_saved', { hidden_point_count: 1 }, { category: 'privacy' });
    await vi.advanceTimersByTimeAsync(1000);

    const expiry = fake.getIndexEntries(DB_NAME, EVENTS_STORE, 'by_kind_expiry')
      .filter(({ key }) => key[0] === 'system_log');
    const privacy = fake.getIndexEntries(DB_NAME, EVENTS_STORE, 'by_kind_privacy_time');
    expect(expiry).toHaveLength(1);
    expect(expiry[0].key[0]).toBe('system_log');
    expect(privacy.map(({ key }) => key[1]).sort()).toEqual(['sensitive', 'standard']);
    const updateEvents = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === module.SYSTEM_LOG_EVENT);
    expect(updateEvents.at(-1)?.detail?.count).toBe(2);
  });

  it('hides and physically deletes sensitive rows when retention drops to zero and never resurrects them', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { fake, module } = await loadSystemLog(local);
    module.recordSystemEvent('privacy_zone_saved', { hidden_point_count: 1 }, { category: 'privacy' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await module.getSystemLogs()).toHaveLength(1);

    local.values.set(SETTINGS_KEY, JSON.stringify({ privacy_log_retention_hours: 0 }));
    expect(await module.getSystemLogs()).toEqual([]);
    await module.reconcileSystemLogPrivacyRetention();
    expect(fake.getIndexEntries(DB_NAME, EVENTS_STORE, 'by_kind_privacy_time')).toEqual([]);

    local.values.set(SETTINGS_KEY, JSON.stringify({ privacy_log_retention_hours: 168 }));
    expect(await module.getSystemLogs()).toEqual([]);
  });

  it('reclassifies stale cached privacy metadata without rewriting the public payload', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { fake, module } = await loadSystemLog(local);
    const payload = {
      id: 'stale-class',
      timestamp: new Date(NOW).toISOString(),
      category: 'privacy',
      operation: 'privacy_route_masked',
      details: { hidden_point_count: 2 },
      unknown: { exact: true },
    };
    const foundation = await import('@/lib/diagnosticsStorage');
    const storage = foundation.createDiagnosticsStorage({
      indexedDbFactory: fake,
      keyRangeFactory: fake.keyRange,
      now: () => NOW,
      uidFactory: () => 'stale',
    });
    await storage.appendPreparedEvents([storage.prepareEvent('system_log', payload, {
      eventUid: 'system_log:stale-class',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + module.SYSTEM_LOG_RETENTION_MS,
      privacyClass: 'standard',
      privacyRulesVersion: 0,
    })]);

    await module.reconcileSystemLogPrivacyRetention();
    const stored = fake.getStoreState(DB_NAME, EVENTS_STORE).records.get('system_log:stale-class');
    expect(stored.privacyClass).toBe('sensitive');
    expect(stored).not.toHaveProperty('expiresAtMs');
    expect(stored.payload).toEqual(payload);
    expect(Object.keys(stored.payload)).toEqual(Object.keys(payload));
  });

  it('finishes privacy-rules reclassification in bounded 128-row passes', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { fake, module } = await loadSystemLog(local);
    const foundation = await import('@/lib/diagnosticsStorage');
    const storage = foundation.createDiagnosticsStorage({
      indexedDbFactory: fake,
      keyRangeFactory: fake.keyRange,
      now: () => NOW,
      uidFactory: () => 'unused',
    });
    for (let start = 0; start < 129; start += 64) {
      const batch = Array.from({ length: Math.min(64, 129 - start) }, (_, offset) => {
        const index = start + offset;
        const payload = {
          id: `privacy-${index}`,
          timestamp: new Date(NOW - index).toISOString(),
          category: 'privacy',
          operation: 'privacy_route_masked',
          details: { public_count: index },
        };
        return storage.prepareEvent('system_log', payload, {
          eventUid: `system_log:privacy-${index}`,
          payloadTimestampMs: NOW - index,
          expiresAtMs: NOW + module.SYSTEM_LOG_RETENTION_MS,
          privacyClass: 'standard',
          privacyRulesVersion: 0,
        });
      });
      await storage.appendPreparedEvents(batch);
    }

    expect(await module.reconcileSystemLogPrivacyRetention()).toBe(true);
    expect(await module.reconcileSystemLogPrivacyRetention()).toBe(true);
    expect(await module.reconcileSystemLogPrivacyRetention()).toBe(false);

    const records = [...fake.getStoreState(DB_NAME, EVENTS_STORE).records.values()];
    expect(records).toHaveLength(129);
    expect(records.every((record) => (
      record.privacyClass === 'sensitive'
      && record.privacyRulesVersion === module.SYSTEM_LOG_PRIVACY_RULES_VERSION
      && !Object.prototype.hasOwnProperty.call(record, 'expiresAtMs')
    ))).toBe(true);
    expect(await storage.getMeta('system_log_privacy_rules_version'))
      .toBe(module.SYSTEM_LOG_PRIVACY_RULES_VERSION);
  });

  it('keeps a sensitive row exactly on the privacy-retention boundary', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 24 }),
    });
    const { fake, module } = await loadSystemLog(local);
    const foundation = await import('@/lib/diagnosticsStorage');
    const storage = foundation.createDiagnosticsStorage({
      indexedDbFactory: fake,
      keyRangeFactory: fake.keyRange,
      now: () => NOW,
      uidFactory: () => 'unused',
    });
    await storage.setMeta('system_log_privacy_rules_version', module.SYSTEM_LOG_PRIVACY_RULES_VERSION);
    const records = [
      ['boundary', NOW - DAY],
      ['expired', NOW - DAY - 1],
    ].map(([id, timestamp]) => storage.prepareEvent('system_log', {
      id,
      timestamp: new Date(timestamp).toISOString(),
      category: 'privacy',
      operation: 'privacy_route_masked',
    }, {
      eventUid: `system_log:${id}`,
      payloadTimestampMs: timestamp,
      privacyClass: 'sensitive',
      privacyRulesVersion: module.SYSTEM_LOG_PRIVACY_RULES_VERSION,
    }));
    await storage.appendPreparedEvents(records);

    await module.reconcileSystemLogPrivacyRetention();

    const retainedIds = [...fake.getStoreState(DB_NAME, EVENTS_STORE).records.values()]
      .map(({ payload }) => payload.id);
    expect(retainedIds).toEqual(['boundary']);
  });

  it('keeps zero-hour new sensitive events out of every queue and mirror', async () => {
    const local = makeStorage({
      [SETTINGS_KEY]: JSON.stringify({ privacy_log_retention_hours: 0 }),
    });
    const { fake, module } = await loadSystemLog(local);
    expect(module.recordSystemEvent('privacy_zone_saved', { label: 'Home' }, { category: 'privacy' })).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.getStoreState(DB_NAME, EVENTS_STORE)?.records.size ?? 0).toBe(0);
    expect(local.values.has('roadsage_diagnostics_fallback_system_log')).toBe(false);
    expect(local.values.has('roadsage_diagnostics_fallback_app_experience')).toBe(false);
  });

  it('dispatches exactly one count-zero clear event and stores the clear marker before the new clear event', async () => {
    const local = makeStorage({ [SETTINGS_KEY]: '{}' });
    const { fake, module, dispatchEvent } = await loadSystemLog(local);
    module.recordSystemEvent('before_clear', {}, { category: 'app' });

    expect(module.clearSystemLogs()).toBe(true);
    const countZero = dispatchEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === module.SYSTEM_LOG_EVENT && event.detail?.count === 0);
    expect(countZero).toHaveLength(1);
    expect(local.setItem.mock.invocationCallOrder[0]).toBeLessThan(local.removeItem.mock.invocationCallOrder[0]);
    await vi.advanceTimersByTimeAsync(1000);
    const payloads = [...fake.getStoreState(DB_NAME, EVENTS_STORE).records.values()]
      .filter(({ kind }) => kind === 'system_log')
      .map(({ payload }) => payload);
    expect(payloads.some(({ operation }) => operation === 'before_clear')).toBe(false);
    expect(payloads.some(({ operation }) => operation === 'system_logs_cleared')).toBe(true);
  });

  it('keeps the new-epoch system_logs_cleared audit row through multi-pass old-epoch cleanup', async () => {
    const local = makeStorage({ [SETTINGS_KEY]: '{}' });
    const { fake, module } = await loadSystemLog(local);
    const foundation = await import('@/lib/diagnosticsStorage');
    const storage = foundation.createDiagnosticsStorage({
      indexedDbFactory: fake,
      keyRangeFactory: fake.keyRange,
      now: () => NOW,
      uidFactory: () => 'unused',
    });
    const oldCount = 300;
    for (let start = 0; start < oldCount; start += 64) {
      const batch = Array.from({ length: Math.min(64, oldCount - start) }, (_, offset) => {
        const index = start + offset;
        const timestamp = NOW - index;
        return storage.prepareEvent('system_log', {
          id: `old-system-${index}`,
          timestamp: new Date(timestamp).toISOString(),
          category: 'app',
          operation: `old_system_${index}`,
          details: {},
        }, {
          eventUid: `system_log:old-${index}`,
          payloadTimestampMs: timestamp,
          expiresAtMs: timestamp + module.SYSTEM_LOG_RETENTION_MS,
          privacyClass: 'standard',
          privacyRulesVersion: module.SYSTEM_LOG_PRIVACY_RULES_VERSION,
          clearEpoch: 0,
        });
      });
      await storage.appendPreparedEvents(batch);
    }

    // Keep the first old-epoch scan open long enough for the normal 750 ms
    // audit flush to queue ahead of the remaining cleanup passes.
    fake.delayNextRequest({
      storeName: EVENTS_STORE,
      operation: 'index.getAll',
      skip: 1,
      delayMs: 1000,
    });
    expect(module.clearSystemLogs()).toBe(true);
    await vi.advanceTimersByTimeAsync(750);
    await vi.advanceTimersByTimeAsync(250);
    for (let turn = 0; turn < 8; turn += 1) {
      await vi.runAllTimersAsync();
      await storage.getMeta(`system-clear-drain-probe:${turn}`);
    }

    const physical = [...fake.getStoreState(DB_NAME, EVENTS_STORE).records.values()]
      .filter(({ kind }) => kind === 'system_log');
    expect(physical.filter(({ clearEpoch }) => clearEpoch === 0)).toEqual([]);
    expect(physical.filter(({ payload }) => payload.operation === 'system_logs_cleared')).toHaveLength(1);
    expect((await module.getSystemLogs()).filter(
      ({ operation }) => operation === 'system_logs_cleared',
    )).toHaveLength(1);
  });
});

describe('performance and app-experience storage integration', () => {
  it('keeps cold module evaluation free of full diagnostic-history reads', async () => {
    const local = makeStorage({
      roadsage_performance_context_v1: '{"trip_count":12}',
      roadsage_performance_history_v1: '[]',
      roadsage_app_experience_events_v1: '[]',
      [SYSTEM_KEY]: '[]',
    });
    const fake = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    vi.stubGlobal('IDBKeyRange', fake.keyRange);
    vi.stubGlobal('localStorage', local);

    await import('@/lib/performanceTriage');
    await import('@/lib/appExperienceDiagnostics');
    await import('@/lib/systemLog');

    const keys = local.getItem.mock.calls.map(([key]) => key);
    expect(keys).toContain('roadsage_performance_context_v1');
    expect(keys).not.toContain('roadsage_performance_history_v1');
    expect(keys).not.toContain('roadsage_app_experience_events_v1');
    expect(keys).not.toContain(SYSTEM_KEY);
  });

  it('bounds performance pending work, indexes expiry, merges at most 2,750 rows, and clears session cache', async () => {
    const legacy = Array.from({ length: 2500 }, (_, index) => ({
      id: `legacy-${index}`,
      sessionId: 'legacy',
      name: 'legacy.measure',
      durationMs: index,
      at: new Date(NOW - (2500 - index) * 1000).toISOString(),
      pathname: '/diagnostics',
      outcome: 'success',
      context: {},
    }));
    const local = makeStorage({ roadsage_performance_history_v1: JSON.stringify(legacy) });
    const fake = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    vi.stubGlobal('IDBKeyRange', fake.keyRange);
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('window', {
      __PERF_TRIAGE__: [],
      dispatchEvent: vi.fn(),
      location: { pathname: '/diagnostics' },
    });
    vi.stubGlobal('CustomEvent', class { constructor(type, init) { this.type = type; this.detail = init?.detail; } });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const triage = await import('@/lib/performanceTriage');
    for (let index = 0; index < 300; index += 1) {
      triage.beginMeasure(`measure.${index}`)({ outcome: 'success' });
    }
    expect(window.__PERF_TRIAGE__).toHaveLength(250);
    await vi.advanceTimersByTimeAsync(400);

    const entries = await triage.getPerformanceTriageEntries();
    expect(entries.length).toBeLessThanOrEqual(2750);
    const expiry = fake.getIndexEntries(DB_NAME, EVENTS_STORE, 'by_kind_expiry')
      .filter(({ key }) => key[0] === 'performance');
    expect(expiry.length).toBeGreaterThan(0);
    expect(expiry.every(({ key }) => Number.isFinite(key[1]))).toBe(true);

    triage.clearPerformanceTriageHistory();
    expect(window.__PERF_TRIAGE__).toEqual([]);
  });

  it('keeps app-experience seven-field payloads in ingestion order and excludes user actions', async () => {
    const local = makeStorage();
    const fake = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', fake);
    vi.stubGlobal('IDBKeyRange', fake.keyRange);
    vi.stubGlobal('localStorage', local);
    const experience = await import('@/lib/appExperienceDiagnostics');
    experience.recordHistoricalAppExperienceEvent({
      id: 'first',
      timestamp: new Date(NOW).toISOString(),
      severity: 'info',
      category: 'app',
      source: 'native',
      operation: 'first',
      page: '/one',
      details: { count: 1 },
    });
    experience.recordHistoricalAppExperienceEvent({
      id: 'second',
      timestamp: new Date(NOW - DAY).toISOString(),
      severity: 'warn',
      category: 'app',
      source: 'native',
      operation: 'second',
      page: '/two',
      details: { count: 2 },
    });
    expect(experience.recordHistoricalAppExperienceEvent({
      timestamp: new Date(NOW).toISOString(),
      category: 'user_action',
      operation: 'user_click',
    })).toBeNull();
    await vi.advanceTimersByTimeAsync(1100);

    const rows = await experience.getHistoricalAppExperienceEvents();
    expect(rows.map(({ operation }) => operation)).toEqual(['second', 'first']);
    expect(rows[0].timestamp).toBe(new Date(NOW - DAY).toISOString());
    expect(Object.keys(rows[0])).toEqual([
      'timestamp', 'severity', 'category', 'source', 'operation', 'page', 'details',
    ]);
    const expiry = fake.getIndexEntries(DB_NAME, EVENTS_STORE, 'by_kind_expiry')
      .filter(({ key }) => key[0] === 'app_experience');
    expect(expiry).toHaveLength(2);
  });
});
