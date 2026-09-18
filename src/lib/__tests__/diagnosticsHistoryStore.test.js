import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_DB_NAME,
  DIAGNOSTICS_EVENTS_STORE,
  createDiagnosticsStorage,
} from '@/lib/diagnosticsStorage';
import {
  createDiagnosticsHistoryStore,
  DIAGNOSTICS_FALLBACK_MAX_BYTES,
  DIAGNOSTICS_FALLBACK_MAX_RECORDS,
  eraseDiagnosticsHistoryForDataRights,
  resetDiagnosticsHistoryStoresForTests,
  trimDiagnosticsFallback,
} from '@/lib/diagnosticsHistoryStore';
import { FakeIndexedDb } from '@/lib/__tests__/helpers/fakeIndexedDb';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 15, 12);

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
};

const makeFoundation = (fake = new FakeIndexedDb()) => ({
  fake,
  storage: createDiagnosticsStorage({
    indexedDbFactory: fake,
    keyRangeFactory: fake.keyRange,
    now: () => NOW,
    uidFactory: (() => { let value = 0; return () => `uid-${++value}`; })(),
  }),
});

const configFor = (kind = 'performance', overrides = {}) => ({
  kind,
  legacyKey: `legacy_${kind}`,
  capacity: kind === 'app_experience' ? 4000 : 2500,
  pendingCap: kind === 'performance' ? 128 : 250,
  flushDelayMs: 100,
  jobName: kind === 'performance' ? 'performance_triage_persist' : 'experience_events_flush',
  orderIndex: kind === 'app_experience' ? 'by_kind_ingest_seq' : 'by_kind_payload_time',
  orderWidth: kind === 'app_experience' ? 2 : 3,
  direction: kind === 'app_experience' ? 'prev' : 'next',
  mapLegacy: (rows, nowMs) => rows
    .filter((row) => row.timestampMs >= nowMs - 90 * DAY)
    .map((row) => ({
      payload: row,
      options: {
        payloadTimestampMs: row.timestampMs,
        expiresAtMs: row.timestampMs + 90 * DAY,
      },
    })),
  finalizeRead: (records, nowMs) => records
    .filter((record) => record.payloadTimestampMs >= nowMs - 90 * DAY)
    .sort((left, right) => (
      kind === 'app_experience'
        ? right.ingestSeq - left.ingestSeq
        : left.payloadTimestampMs - right.payloadTimestampMs
    )),
  ...overrides,
});

const makeRepository = ({
  kind = 'performance',
  local,
  fake,
  storage,
  afterMigrationState,
  suppressPersistence = () => false,
  bufferSuppressed = vi.fn(),
  config = {},
} = {}) => {
  const foundation = storage ? { storage, fake } : makeFoundation(fake);
  return {
    ...foundation,
    repository: createDiagnosticsHistoryStore(configFor(kind, config), {
      storage: foundation.storage,
      localStorage: local,
      now: () => NOW,
      crypto: globalThis.crypto,
      retryDelayMs: 0,
      afterMigrationState,
      suppressPersistence,
      bufferSuppressed,
    }),
    bufferSuppressed,
  };
};

afterEach(() => {
  resetDiagnosticsHistoryStoresForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('diagnostics history migration and crash consistency', () => {
  it('copies in bounded batches, verifies, cuts over, and only then removes legacy', async () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({ id: `row-${index}`, timestampMs: NOW - index }));
    const local = memoryStorage({ legacy_performance: JSON.stringify(rows) });
    const states = [];
    const { repository, storage, fake } = makeRepository({
      local,
      afterMigrationState: (state) => states.push({ state, legacyPresent: local.values.has('legacy_performance') }),
    });

    await repository.ensureMigration();

    expect(states.map(({ state }) => state)).toEqual(expect.arrayContaining([
      'copying', 'verifying', 'cutover_committed', 'legacy_delete_pending', 'complete',
    ]));
    expect(states.find(({ state }) => state === 'cutover_committed').legacyPresent).toBe(true);
    expect(states.find(({ state }) => state === 'legacy_delete_pending').legacyPresent).toBe(true);
    expect(local.values.has('legacy_performance')).toBe(false);
    expect((await storage.getMeta('migration:performance')).state).toBe('complete');
    const stored = fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE);
    expect(stored.records).toHaveLength(70);
    expect(stored.putCount).toBe(70);
  });

  it.each(['copying', 'verifying', 'cutover_committed', 'legacy_delete_pending'])(
    'restarts idempotently after interruption at %s without loss or duplication',
    async (boundary) => {
      const rows = Array.from({ length: 66 }, (_, index) => ({ id: `same`, timestampMs: NOW - index }));
      const local = memoryStorage({ legacy_performance: JSON.stringify(rows) });
      const foundation = makeFoundation();
      let interrupted = false;
      const first = makeRepository({
        local,
        ...foundation,
        afterMigrationState: (state) => {
          if (!interrupted && state === boundary) {
            interrupted = true;
            throw new Error(`interrupt:${boundary}`);
          }
        },
      }).repository;
      await expect(first.ensureMigration()).rejects.toThrow(`interrupt:${boundary}`);

      const restarted = makeRepository({ local, ...foundation }).repository;
      await restarted.ensureMigration();
      const records = foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE).records;
      expect(records).toHaveLength(66);
      expect(new Set([...records.keys()]).size).toBe(66);
      expect((await foundation.storage.getMeta('migration:performance')).state).toBe('complete');
    },
  );

  it('leaves legacy untouched when ordered checksum verification fails', async () => {
    const local = memoryStorage({
      legacy_performance: JSON.stringify([{ id: 'one', timestampMs: NOW }]),
    });
    const foundation = makeFoundation();
    const first = makeRepository({
      local,
      ...foundation,
      afterMigrationState: (state) => {
        if (state === 'verifying') throw new Error('pause-before-verify');
      },
    }).repository;
    await expect(first.ensureMigration()).rejects.toThrow('pause-before-verify');
    const records = foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE).records;
    records.values().next().value.payload.id = 'tampered';

    const restarted = makeRepository({ local, ...foundation }).repository;
    await expect(restarted.ensureMigration()).rejects.toThrow('verification failed');
    expect(local.values.has('legacy_performance')).toBe(true);
    expect((await foundation.storage.getMeta('migration:performance')).state).toBe('verifying');
  });

  it('fails safely instead of looping when the frozen legacy source changes during copy', async () => {
    const local = memoryStorage({
      legacy_performance: JSON.stringify([
        { id: 'one', timestampMs: NOW },
        { id: 'two', timestampMs: NOW - 1 },
      ]),
    });
    const foundation = makeFoundation();
    const first = makeRepository({
      local,
      ...foundation,
      afterMigrationState: (state) => {
        if (state === 'copying') throw new Error('pause-before-copy');
      },
    }).repository;
    await expect(first.ensureMigration()).rejects.toThrow('pause-before-copy');
    local.values.set('legacy_performance', JSON.stringify([{ id: 'one', timestampMs: NOW }]));

    const restarted = makeRepository({ local, ...foundation }).repository;
    await expect(restarted.ensureMigration()).rejects.toThrow('source changed during copy');
    expect(local.values.has('legacy_performance')).toBe(true);
    expect(foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE).records.size).toBe(0);
  });

  it('preserves corrupt legacy bytes and never automatically deletes them', async () => {
    const raw = '{not-json\r\nprivate-history';
    const local = memoryStorage({ legacy_performance: raw });
    const { repository, storage } = makeRepository({ local });

    await repository.ensureMigration();

    expect(local.values.get('legacy_performance')).toBe(raw);
    expect(await storage.getMeta('migration:performance')).toMatchObject({
      state: 'legacy_corrupt_preserved',
      rawLength: raw.length,
    });
  });

  it('writes a clear tombstone before removing legacy and prevents restart resurrection', async () => {
    const order = [];
    const local = memoryStorage({
      legacy_performance: JSON.stringify([{ id: 'old', timestampMs: NOW }]),
    });
    local.setItem.mockImplementation((key, value) => {
      order.push(`set:${key}`);
      local.values.set(key, String(value));
    });
    local.removeItem.mockImplementation((key) => {
      order.push(`remove:${key}`);
      local.values.delete(key);
    });
    const foundation = makeFoundation();
    const repository = makeRepository({ local, ...foundation }).repository;

    expect(repository.clear()).toBe(true);
    expect(order[0]).toBe('set:roadsage_diagnostics_clear_epoch_performance');
    expect(order).toContain('remove:legacy_performance');

    const restarted = makeRepository({ local, ...foundation }).repository;
    await expect(restarted.read()).resolves.toEqual([]);
  });

  it('removes old epochs in bounded passes without deleting rows written after the clear tombstone', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const foundation = makeFoundation();
    const { repository } = makeRepository({ local, ...foundation });
    const oldCount = 300;
    for (let start = 0; start < oldCount; start += 64) {
      const batch = Array.from({ length: Math.min(64, oldCount - start) }, (_, offset) => {
        const index = start + offset;
        return foundation.storage.prepareEvent('performance', { id: `old-${index}` }, {
          eventUid: `performance:old-${index}`,
          payloadTimestampMs: NOW + index,
          expiresAtMs: NOW + 90 * DAY,
          clearEpoch: 0,
        });
      });
      await foundation.storage.appendPreparedEvents(batch);
    }

    expect(repository.clear()).toBe(true);
    const immediateIds = ['new-immediate-1', 'new-immediate-2'];
    immediateIds.forEach((id, index) => repository.enqueue({ id }, {
      eventUid: `performance:${id}`,
      payloadTimestampMs: NOW + oldCount + index,
      expiresAtMs: NOW + 90 * DAY,
    }));
    await repository.flush();

    // Let one scheduled cleanup pass complete while old rows still remain,
    // then persist another record in the new epoch between deletion turns.
    await vi.advanceTimersToNextTimerAsync();
    const betweenId = 'new-between-passes';
    repository.enqueue({ id: betweenId }, {
      eventUid: `performance:${betweenId}`,
      payloadTimestampMs: NOW + oldCount + immediateIds.length,
      expiresAtMs: NOW + 90 * DAY,
    });
    await repository.flush();
    for (let turn = 0; turn < 8; turn += 1) {
      await vi.runAllTimersAsync();
      await foundation.storage.getMeta(`clear-drain-probe:${turn}`);
    }

    const physical = [...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()];
    expect(physical.filter(({ clearEpoch }) => clearEpoch === 0)).toEqual([]);
    expect(physical.map(({ payload }) => payload.id).sort()).toEqual(
      [...immediateIds, betweenId].sort(),
    );
    expect((await repository.read()).map(({ payload }) => payload.id).sort()).toEqual(
      [...immediateIds, betweenId].sort(),
    );
  });

  it('restarts an interrupted clear scan from the new epoch on repeated clear', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const foundation = makeFoundation();
    const { repository } = makeRepository({ local, ...foundation });
    for (let start = 0; start < 300; start += 64) {
      const batch = Array.from({ length: Math.min(64, 300 - start) }, (_, offset) => {
        const index = start + offset;
        return foundation.storage.prepareEvent('performance', { id: `epoch-zero-${index}` }, {
          eventUid: `performance:epoch-zero-${index}`,
          payloadTimestampMs: NOW + index,
          expiresAtMs: NOW + 90 * DAY,
          clearEpoch: 0,
        });
      });
      await foundation.storage.appendPreparedEvents(batch);
    }

    expect(repository.clear()).toBe(true);
    await vi.advanceTimersToNextTimerAsync();
    repository.enqueue({ id: 'epoch-one' }, {
      eventUid: 'performance:epoch-one',
      payloadTimestampMs: NOW + 301,
      expiresAtMs: NOW + 90 * DAY,
    });
    await repository.flush();
    expect(repository.clear()).toBe(true);
    repository.enqueue({ id: 'epoch-two' }, {
      eventUid: 'performance:epoch-two',
      payloadTimestampMs: NOW + 302,
      expiresAtMs: NOW + 90 * DAY,
    });
    await repository.flush();
    for (let turn = 0; turn < 8; turn += 1) {
      await vi.runAllTimersAsync();
      await foundation.storage.getMeta(`repeat-clear-drain-probe:${turn}`);
    }

    const physical = [...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()];
    expect(physical.map(({ payload }) => payload.id)).toEqual(['epoch-two']);
    expect(physical[0].clearEpoch).toBe(2);
  });

  it('does not requeue a failed old-epoch flush over new rows after clear', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const foundation = makeFoundation();
    const { repository } = makeRepository({ local, ...foundation });
    foundation.fake.failNextRequest({
      storeName: DIAGNOSTICS_EVENTS_STORE,
      operation: 'get',
      error: new Error('old epoch append failed'),
    });
    repository.enqueue({ id: 'old-in-flight' }, {
      eventUid: 'performance:old-in-flight',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    });
    const oldFlush = repository.flush();

    expect(repository.clear()).toBe(true);
    repository.enqueue({ id: 'new-after-failed-flush' }, {
      eventUid: 'performance:new-after-failed-flush',
      payloadTimestampMs: NOW + 1,
      expiresAtMs: NOW + 90 * DAY,
    });
    await vi.runAllTimersAsync();
    await oldFlush;
    await vi.runAllTimersAsync();

    const physical = [...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()];
    expect(physical.map(({ payload }) => payload.id)).toEqual(['new-after-failed-flush']);
    expect(physical[0].clearEpoch).toBe(1);
  });

  it('performs explicit old-epoch cleanup while automatic persistence is suppressed', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const foundation = makeFoundation();
    const old = foundation.storage.prepareEvent('performance', { id: 'suppressed-clear-old' }, {
      eventUid: 'performance:suppressed-clear-old',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
      clearEpoch: 0,
    });
    await foundation.storage.appendPreparedEvents([old]);
    const { repository } = makeRepository({
      local,
      ...foundation,
      suppressPersistence: () => true,
    });

    expect(repository.clear()).toBe(true);
    await vi.runAllTimersAsync();

    expect(foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.size).toBe(0);
  });

  it('lets a clear supersede an active migration without promoting old rows into the new epoch', async () => {
    const local = memoryStorage({
      legacy_performance: JSON.stringify([{ id: 'old-active-copy', timestampMs: NOW }]),
    });
    const foundation = makeFoundation();
    let repository;
    repository = makeRepository({
      local,
      ...foundation,
      afterMigrationState: (state) => {
        if (state === 'copying') repository.clear();
      },
    }).repository;

    await expect(repository.ensureMigration()).rejects.toThrow('superseded by clear');

    const restarted = makeRepository({ local, ...foundation }).repository;
    expect(await restarted.read()).toEqual([]);
    const rows = [...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()];
    expect(rows.filter((record) => record.clearEpoch >= 1)).toEqual([]);
  });

  it('does not claim or perform clear when the tombstone write fails', () => {
    const local = memoryStorage({ legacy_performance: '[{"id":"old"}]' });
    local.setItem.mockImplementation(() => { throw new Error('quota'); });
    const { repository } = makeRepository({ local });

    expect(repository.clear()).toBe(false);
    expect(local.values.has('legacy_performance')).toBe(true);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('keeps a failed legacy-key removal logically cleared across restart', async () => {
    const foundation = makeFoundation();
    const staleFallback = foundation.storage.prepareEvent('performance', { id: 'pre-clear-fallback' }, {
      eventUid: 'performance:pre-clear-fallback',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
      clearEpoch: 0,
    });
    const local = memoryStorage({
      legacy_performance: JSON.stringify([{ id: 'pre-clear', timestampMs: NOW }]),
      roadsage_diagnostics_fallback_performance: JSON.stringify({
        version: 1,
        records: [staleFallback],
      }),
    });
    local.removeItem.mockImplementation(() => { throw new Error('storage removal denied'); });
    const first = makeRepository({ local, ...foundation }).repository;

    expect(first.clear()).toBe(true);
    expect(local.values.has('legacy_performance')).toBe(true);

    const restarted = makeRepository({ local, ...foundation }).repository;
    expect(await restarted.read()).toEqual([]);
    expect([...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()].map(({ payload }) => payload.id)).not.toContain('pre-clear');
    expect([...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()].map(({ payload }) => payload.id)).not.toContain('pre-clear-fallback');
  });

  it('excludes live writes from the frozen migration checksum', async () => {
    const local = memoryStorage({
      legacy_performance: JSON.stringify([{ id: 'legacy', timestampMs: NOW }]),
    });
    const foundation = makeFoundation();
    let paused = false;
    const first = makeRepository({
      local,
      ...foundation,
      afterMigrationState: (state) => {
        if (!paused && state === 'copying') {
          paused = true;
          throw new Error('pause-copy');
        }
      },
    }).repository;
    await expect(first.ensureMigration()).rejects.toThrow('pause-copy');
    first.enqueue({ id: 'live' }, {
      eventUid: 'performance:live',
      payloadTimestampMs: NOW + 1,
      expiresAtMs: NOW + 90 * DAY,
    });
    await first.flush();

    const restarted = makeRepository({ local, ...foundation }).repository;
    await restarted.ensureMigration();
    const records = [...foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE).records.values()];
    expect(records.map(({ payload }) => payload.id).sort()).toEqual(['legacy', 'live']);
  });

  it('sets the global completion marker only after all three kinds are complete', async () => {
    const local = memoryStorage();
    const foundation = makeFoundation();
    const performance = makeRepository({ local, ...foundation }).repository;
    await performance.ensureMigration();
    expect(await foundation.storage.getMeta('diagnostics_storage_v1_complete')).toBeUndefined();

    const system = makeRepository({
      kind: 'system_log',
      local,
      ...foundation,
      config: {
        pendingCap: 500,
        jobName: 'system_log_flush',
        mapLegacy: () => [],
        finalizeRead: (records) => records,
      },
    }).repository;
    const experience = makeRepository({ kind: 'app_experience', local, ...foundation }).repository;
    await system.ensureMigration();
    await experience.ensureMigration();
    expect(await foundation.storage.getMeta('diagnostics_storage_v1_complete')).toMatchObject({ version: 1 });
  });

  it('deletes the diagnostics database during app-wide data-rights erasure', async () => {
    const local = memoryStorage();
    const foundation = makeFoundation();
    vi.stubGlobal('indexedDB', foundation.fake);
    const repository = makeRepository({ local, ...foundation }).repository;
    repository.enqueue({ id: 'erase-me' }, {
      eventUid: 'performance:erase-me',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    });
    await repository.flush();
    expect(foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE).records.size).toBe(1);

    await expect(eraseDiagnosticsHistoryForDataRights()).resolves.toMatchObject({ deleted: true });

    expect(foundation.fake.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE)).toBeNull();
    expect(local.values.get('roadsage_diagnostics_clear_epoch_performance')).toBe('1');
  });
});

describe('bounded append, expiry, fallback, and suppression', () => {
  it('trims an oversized fallback ring with logarithmically bounded whole-ring serialization', () => {
    const records = Array.from({ length: DIAGNOSTICS_FALLBACK_MAX_RECORDS }, (_, index) => ({
      eventUid: `performance:fallback-cost-${index}`,
      payload: { id: index, details: 'x'.repeat(5000) },
    }));
    const stringify = vi.spyOn(JSON, 'stringify');

    const bounded = trimDiagnosticsFallback(records);
    const serializationCount = stringify.mock.calls.length;
    stringify.mockRestore();

    expect(serializationCount).toBeLessThanOrEqual(9);
    expect(bounded.records.length).toBeLessThanOrEqual(DIAGNOSTICS_FALLBACK_MAX_RECORDS);
    expect(new TextEncoder().encode(bounded.serialized).byteLength)
      .toBeLessThanOrEqual(DIAGNOSTICS_FALLBACK_MAX_BYTES);
    expect(bounded.records).toEqual(records.slice(-bounded.records.length));
  });

  it('uses the same append transaction count at empty and saturated history', async () => {
    const empty = makeFoundation();
    const saturated = makeFoundation();
    for (let index = 0; index < 2500; index += 64) {
      const batch = Array.from({ length: Math.min(64, 2500 - index) }, (_, offset) => (
        saturated.storage.prepareEvent('performance', { id: index + offset }, {
          eventUid: `performance:saturated-${index + offset}`,
          payloadTimestampMs: NOW + index + offset,
          expiresAtMs: NOW + 90 * DAY,
        })
      ));
      await saturated.storage.appendPreparedEvents(batch);
    }
    empty.fake.transactionCount = 0;
    saturated.fake.transactionCount = 0;

    await empty.storage.appendPreparedEvents([empty.storage.prepareEvent('performance', { id: 'one' }, {
      eventUid: 'performance:empty-one',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    })]);
    await saturated.storage.appendPreparedEvents([saturated.storage.prepareEvent('performance', { id: 'one' }, {
      eventUid: 'performance:saturated-one',
      payloadTimestampMs: NOW + 2501,
      expiresAtMs: NOW + 90 * DAY,
    })]);

    expect(empty.fake.transactionCount).toBe(1);
    expect(saturated.fake.transactionCount).toBe(1);
  });

  it('keeps pending bounded and persists fixed-retention rows into the expiry index', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const { repository, fake } = makeRepository({ local });
    for (let index = 0; index < 200; index += 1) {
      repository.enqueue({ id: index }, {
        payloadTimestampMs: NOW + index,
        expiresAtMs: NOW + 90 * DAY + index,
      });
    }
    expect(repository.pendingCount).toBe(128);
    await vi.advanceTimersByTimeAsync(100);
    const expiry = fake.getIndexEntries(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE, 'by_kind_expiry');
    expect(expiry).toHaveLength(64);
    expect(expiry.every(({ key }) => key[0] === 'performance')).toBe(true);
  });

  it('falls back to one count- and byte-bounded ring when IndexedDB is unavailable', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const unavailable = createDiagnosticsStorage({ indexedDbFactory: null, now: () => NOW });
    const { repository } = makeRepository({ local, storage: unavailable });
    for (let index = 0; index < 180; index += 1) {
      repository.enqueue({ id: index, details: 'x'.repeat(5000) }, {
        payloadTimestampMs: NOW + index,
        expiresAtMs: NOW + 90 * DAY,
      });
    }
    await vi.advanceTimersByTimeAsync(200);
    const raw = local.values.get('roadsage_diagnostics_fallback_performance');
    const parsed = JSON.parse(raw);
    expect(parsed.records.length).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(DIAGNOSTICS_FALLBACK_MAX_BYTES);
    expect([...local.values.keys()].filter((key) => key.includes('fallback_'))).toEqual([
      'roadsage_diagnostics_fallback_performance',
    ]);
  });

  it('preserves the previous valid fallback value when a quota write fails', async () => {
    vi.useFakeTimers();
    const previous = JSON.stringify({ version: 1, records: [{ eventUid: 'live:performance:old' }] });
    const local = memoryStorage({ roadsage_diagnostics_fallback_performance: previous });
    local.setItem.mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const unavailable = createDiagnosticsStorage({ indexedDbFactory: null, now: () => NOW });
    const { repository } = makeRepository({ local, storage: unavailable });
    repository.enqueue({ id: 'new' }, { payloadTimestampMs: NOW, expiresAtMs: NOW + 90 * DAY });
    await vi.advanceTimersByTimeAsync(200);
    expect(local.values.get('roadsage_diagnostics_fallback_performance')).toBe(previous);
  });

  it('copies and verifies fallback UIDs before removing the one bounded ring', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const unavailable = createDiagnosticsStorage({ indexedDbFactory: null, now: () => NOW });
    const failed = makeRepository({ local, storage: unavailable }).repository;
    failed.enqueue({ id: 'fallback-row' }, {
      eventUid: 'performance:fallback-row',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(local.values.has('roadsage_diagnostics_fallback_performance')).toBe(true);

    const healthyFoundation = makeFoundation();
    local.getItem.mockClear();
    const recovered = makeRepository({ local, ...healthyFoundation }).repository;
    const rows = await recovered.read();
    expect(rows.map(({ payload }) => payload.id)).toContain('fallback-row');
    expect(local.values.has('roadsage_diagnostics_fallback_performance')).toBe(false);
    const fallbackReads = local.getItem.mock.calls
      .filter(([key]) => key === 'roadsage_diagnostics_fallback_performance');
    expect(fallbackReads).toHaveLength(1);
  });

  it('verifies fallback recovery with only the recovered UIDs instead of a capacity-scale read', async () => {
    const foundation = makeFoundation();
    const fallbackRecords = Array.from({ length: DIAGNOSTICS_FALLBACK_MAX_RECORDS }, (_, index) => (
      foundation.storage.prepareEvent('performance', { id: `recovery-${index}` }, {
        eventUid: `performance:recovery-${index}`,
        payloadTimestampMs: NOW + index,
        expiresAtMs: NOW + 90 * DAY,
      })
    ));
    const local = memoryStorage({
      roadsage_diagnostics_fallback_performance: JSON.stringify({
        version: 1,
        records: fallbackRecords,
      }),
    });
    const readEventsByUids = vi.fn(foundation.storage.readEventsByUids);
    const readEventsByIndex = vi.fn(foundation.storage.readEventsByIndex);
    const storage = {
      ...foundation.storage,
      readEventsByIndex,
      readEventsByUids,
    };
    const { repository } = makeRepository({ local, storage });
    await repository.ensureMigration();
    readEventsByIndex.mockClear();

    const rows = await repository.read();

    expect(readEventsByUids).toHaveBeenCalledTimes(1);
    expect(readEventsByUids.mock.calls[0][0]).toEqual(
      fallbackRecords.map(({ eventUid }) => eventUid),
    );
    expect(readEventsByIndex).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(DIAGNOSTICS_FALLBACK_MAX_RECORDS);
    expect(local.values.has('roadsage_diagnostics_fallback_performance')).toBe(false);
  });

  it('recovers a newly-created fallback in the same session after IndexedDB becomes healthy', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const foundation = makeFoundation();
    const { repository } = makeRepository({ local, ...foundation });
    expect(await repository.read()).toEqual([]);
    foundation.fake.failNextRequest({ storeName: 'events', operation: 'get', error: new Error('primary down') });
    foundation.fake.failNextRequest({ storeName: 'events', operation: 'get', error: new Error('retry down') });
    repository.enqueue({ id: 'fallback-first' }, {
      eventUid: 'performance:fallback-first',
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(local.values.has('roadsage_diagnostics_fallback_performance')).toBe(true);

    repository.enqueue({ id: 'healthy-second' }, {
      eventUid: 'performance:healthy-second',
      payloadTimestampMs: NOW + 1,
      expiresAtMs: NOW + 90 * DAY,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await repository.read();

    expect(local.values.has('roadsage_diagnostics_fallback_performance')).toBe(false);
    const ids = [...foundation.fake.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.values()].map(({ payload }) => payload.id).sort();
    expect(ids).toEqual(['fallback-first', 'healthy-second']);
  });

  it('performs zero automatic primary, fallback, migration, or prune persistence when suppressed', async () => {
    vi.useFakeTimers();
    const local = memoryStorage({ legacy_performance: JSON.stringify([{ id: 'old', timestampMs: NOW }]) });
    const bufferSuppressed = vi.fn();
    const { repository, fake } = makeRepository({
      local,
      suppressPersistence: () => true,
      bufferSuppressed,
    });
    local.getItem.mockClear();
    local.setItem.mockClear();
    repository.enqueue({ id: 'new' }, { payloadTimestampMs: NOW, expiresAtMs: NOW + 90 * DAY });
    await vi.advanceTimersByTimeAsync(200);
    await repository.scheduleMaintenance();

    expect(fake.transactionCount).toBe(0);
    expect(local.getItem).not.toHaveBeenCalledWith('legacy_performance');
    expect(local.setItem).not.toHaveBeenCalled();
    expect(bufferSuppressed).toHaveBeenCalledWith('performance_triage_persist', [{ id: 'new' }]);
  });

  it('orders app-experience by ingestion even when the later payload timestamp is older', async () => {
    vi.useFakeTimers();
    const local = memoryStorage();
    const { repository } = makeRepository({ kind: 'app_experience', local });
    repository.enqueue({ id: 'first-newer-time' }, {
      payloadTimestampMs: NOW,
      expiresAtMs: NOW + 90 * DAY,
    });
    repository.enqueue({ id: 'later-older-time' }, {
      payloadTimestampMs: NOW - DAY,
      expiresAtMs: NOW + 89 * DAY,
    });
    await repository.flush();
    const rows = await repository.read();
    expect(rows.map(({ payload }) => payload.id)).toEqual(['later-older-time', 'first-newer-time']);
  });
});
