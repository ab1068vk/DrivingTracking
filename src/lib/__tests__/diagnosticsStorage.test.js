import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_DB_NAME,
  DIAGNOSTICS_DB_VERSION,
  DIAGNOSTICS_EVENT_INDEXES,
  DIAGNOSTICS_EVENT_KINDS,
  DIAGNOSTICS_EVENTS_STORE,
  DIAGNOSTICS_META_STORE,
  DIAGNOSTICS_PRIVACY_CLASSES,
  MAX_FLUSH_BATCH,
  MAX_PRUNE_DELETES_PER_TX,
  createDeterministicLegacyEventUid,
  createDiagnosticsStorage,
} from '@/lib/diagnosticsStorage';
import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const makeStorage = (overrides = {}) => {
  const indexedDbFactory = overrides.indexedDbFactory ?? new FakeIndexedDb();
  let uidOrdinal = 0;
  return {
    indexedDbFactory,
    storage: createDiagnosticsStorage({
      indexedDbFactory,
      now: () => 1_700_000_000_000,
      uidFactory: ({ kind }) => `${kind}-uid-${++uidOrdinal}`,
      ...overrides,
    }),
  };
};

describe('diagnosticsStorage foundation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('freezes the approved database, store, kind, and bounded-work constants', () => {
    expect(DIAGNOSTICS_DB_NAME).toBe('roadsage_diagnostics');
    expect(DIAGNOSTICS_DB_VERSION).toBe(1);
    expect(DIAGNOSTICS_EVENTS_STORE).toBe('events');
    expect(DIAGNOSTICS_META_STORE).toBe('meta');
    expect(DIAGNOSTICS_EVENT_KINDS).toEqual(['performance', 'system_log', 'app_experience']);
    expect(DIAGNOSTICS_PRIVACY_CLASSES).toEqual(['sensitive', 'standard']);
    expect(MAX_FLUSH_BATCH).toBe(64);
    expect(MAX_PRUNE_DELETES_PER_TX).toBe(128);
  });

  it('creates events and meta with every approved compound index', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { indexedDbFactory, storage } = makeStorage();

    const db = await storage.open();

    expect(db.objectStoreNames.contains(DIAGNOSTICS_EVENTS_STORE)).toBe(true);
    expect(db.objectStoreNames.contains(DIAGNOSTICS_META_STORE)).toBe(true);
    expect(indexedDbFactory.openCalls).toEqual([{
      name: DIAGNOSTICS_DB_NAME,
      version: DIAGNOSTICS_DB_VERSION,
    }]);
    const events = indexedDbFactory.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE);
    const meta = indexedDbFactory.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_META_STORE);
    expect(events.keyPath).toBe('eventUid');
    expect(meta.keyPath).toBe('key');
    expect([...events.indexes.values()]).toEqual(DIAGNOSTICS_EVENT_INDEXES);
  });

  it('uses deterministic clock and UID hooks without touching diagnostic domain modules', () => {
    const { storage } = makeStorage();
    const payload = { timestamp: '2026-08-15T12:00:00.000Z', detail: 'kept verbatim' };

    const record = storage.prepareEvent('system_log', payload, {
      clearEpoch: 7,
      privacyClass: 'sensitive',
      privacyRulesVersion: 3,
    });

    expect(record).toEqual({
      kind: 'system_log',
      eventUid: 'live:system_log:system_log-uid-1',
      payloadTimestampMs: 1_700_000_000_000,
      clearEpoch: 7,
      privacyClass: 'sensitive',
      privacyRulesVersion: 3,
      payload,
    });
    expect(record.payload).toBe(payload);
    expect(record).not.toHaveProperty('ingestSeq');
  });

  it('builds collision-free deterministic migration UIDs from kind, generation, and ordinal', () => {
    expect(createDeterministicLegacyEventUid('performance', 'generation/a', 0))
      .toBe('migration:performance:generation%2Fa:0');
    expect(createDeterministicLegacyEventUid('performance', 'generation/a', 1))
      .not.toBe(createDeterministicLegacyEventUid('performance', 'generation/a', 0));
    expect(createDeterministicLegacyEventUid('system_log', 'generation/a', 0))
      .not.toBe(createDeterministicLegacyEventUid('performance', 'generation/a', 0));

    const { storage } = makeStorage();
    expect(storage.prepareMigratedEvent('app_experience', { category: 'native' }, {
      migrationGeneration: 'legacy-v1',
      migrationOrdinal: 42,
      migrationSource: 'roadsage_app_experience_history_v1',
      payloadTimestampMs: 123,
    })).toMatchObject({
      eventUid: 'migration:app_experience:legacy-v1:42',
      migrationGeneration: 'legacy-v1',
      migrationOrdinal: 42,
      migrationSource: 'roadsage_app_experience_history_v1',
    });
    expect(() => storage.prepareEvent('performance', { id: 'live' }, {
      eventUid: 'migration:performance:legacy-v1:42',
    })).toThrow(/reserved/);
  });

  it('rejects invalid supplied and generated UIDs without silently minting an identity', () => {
    const uidFactory = vi.fn(() => 'generated');
    const { storage } = makeStorage({ uidFactory });

    [null, '', '   ', ' padded ', 0, false, Number.NaN, {}, []].forEach((eventUid) => {
      expect(() => storage.prepareEvent('performance', { id: 'invalid-uid' }, { eventUid }))
        .toThrow(/eventUid/);
    });
    expect(uidFactory).not.toHaveBeenCalled();

    const { storage: invalidFactoryStorage } = makeStorage({ uidFactory: () => undefined });
    expect(() => invalidFactoryStorage.prepareEvent('performance', { id: 'missing-uid' }))
      .toThrow(/UID factory/);
  });

  it('requires the finite privacy-class domain for every system-log record', () => {
    const { storage } = makeStorage();

    [undefined, null, Number.NaN, {}, '', 'private', true].forEach((privacyClass) => {
      expect(() => storage.prepareEvent('system_log', { message: 'invalid class' }, { privacyClass }))
        .toThrow(/privacyClass/);
    });
    expect(() => storage.prepareEvent('system_log', { message: 'missing class' }))
      .toThrow(/privacyClass/);
    expect(storage.prepareEvent('system_log', { message: 'sensitive' }, {
      privacyClass: 'sensitive',
    }).privacyClass).toBe('sensitive');
    expect(storage.prepareEvent('system_log', { message: 'standard' }, {
      privacyClass: 'standard',
    }).privacyClass).toBe('standard');
  });

  it('models compound-index membership and omission for invalid key components', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const valid = storage.prepareEvent('system_log', { message: 'indexed' }, {
      payloadTimestampMs: 123,
      privacyClass: 'sensitive',
    });
    await storage.appendPreparedEvents([valid]);
    await storage.runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readwrite', ({ objectStore }) => {
      [null, Number.NaN, { invalid: true }].forEach((privacyClass, index) => {
        objectStore(DIAGNOSTICS_EVENTS_STORE).put({
          kind: 'system_log',
          eventUid: `raw-invalid-index-key-${index}`,
          payloadTimestampMs: 124 + index,
          ingestSeq: 99 + index,
          clearEpoch: 0,
          privacyClass,
          payload: { message: 'must be absent from the index' },
        });
      });
    });

    expect(indexedDbFactory.getIndexEntries(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
      'by_kind_privacy_time',
    )).toEqual([{
      key: ['system_log', 'sensitive', 123, 1],
      primaryKey: valid.eventUid,
    }]);
  });

  it('allocates monotonic ingest sequences transactionally and makes same-UID retries idempotent', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const firstBatch = [
      storage.prepareEvent('performance', { id: 'one' }, { payloadTimestampMs: 10 }),
      storage.prepareEvent('performance', { id: 'two' }, { payloadTimestampMs: 20 }),
    ];

    const inserted = await storage.appendPreparedEvents(firstBatch);
    const retried = await storage.appendPreparedEvents(firstBatch);
    const later = await storage.appendPreparedEvents([
      storage.prepareEvent('app_experience', { id: 'three' }, { payloadTimestampMs: 5 }),
    ]);

    expect(inserted.map((row) => row.ingestSeq)).toEqual([1, 2]);
    expect(retried).toEqual(inserted);
    expect(later[0].ingestSeq).toBe(3);
    const events = indexedDbFactory.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE);
    expect(events.records.size).toBe(3);
    expect(events.putCount).toBe(3);
  });

  it('rejects a conflicting payload that reuses an existing stable UID', async () => {
    const { storage } = makeStorage();
    const original = storage.prepareEvent('system_log', { message: 'first' }, {
      privacyClass: 'standard',
    });
    await storage.appendPreparedEvents([original]);

    await expect(storage.appendPreparedEvents([{
      ...original,
      payload: { message: 'different' },
    }])).rejects.toThrow(/eventUid collision/);
  });

  it('does not collapse an undefined-valued property into a same-UID retry', async () => {
    const { storage } = makeStorage();
    const original = storage.prepareEvent('performance', { a: 1, b: undefined }, {
      eventUid: 'live:performance:logical-shape',
    });
    await storage.appendPreparedEvents([original]);

    await expect(storage.appendPreparedEvents([{
      ...original,
      payload: { a: 1 },
    }])).rejects.toThrow(/eventUid collision/);
  });

  it('serializes concurrent read-write appends over events and meta', async () => {
    const { storage } = makeStorage();
    const first = storage.prepareEvent('performance', { id: 'concurrent-one' });
    const second = storage.prepareEvent('performance', { id: 'concurrent-two' });

    const [firstResult, secondResult] = await Promise.all([
      storage.appendPreparedEvents([first]),
      storage.appendPreparedEvents([second]),
    ]);

    expect([firstResult[0].ingestSeq, secondResult[0].ingestSeq]).toEqual([1, 2]);
  });

  it('rolls back a partial batch, propagates the request error, and reuses the sequence on retry', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const first = storage.prepareEvent('performance', { id: 'rollback-one' });
    const second = storage.prepareEvent('performance', { id: 'rollback-two' });
    const writeError = new Error('injected second event put failure');
    indexedDbFactory.failNextRequest({
      storeName: DIAGNOSTICS_EVENTS_STORE,
      operation: 'put',
      skip: 1,
      error: writeError,
    });

    await expect(storage.appendPreparedEvents([first, second])).rejects.toBe(writeError);
    const eventsAfterAbort = indexedDbFactory.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    );
    expect(eventsAfterAbort.records.size).toBe(0);
    await expect(storage.getMeta('ingest_sequence')).resolves.toBeUndefined();

    const retried = await storage.appendPreparedEvents([first, second]);
    expect(retried.map((row) => row.ingestSeq)).toEqual([1, 2]);
    expect(eventsAfterAbort.records.size).toBe(2);
  });

  it('propagates a point-read failure without persisting any row', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const readError = new Error('injected event get failure');
    indexedDbFactory.failNextRequest({
      storeName: DIAGNOSTICS_EVENTS_STORE,
      operation: 'get',
      error: readError,
    });

    await expect(storage.appendPreparedEvents([
      storage.prepareEvent('performance', { id: 'read-failure' }),
    ])).rejects.toBe(readError);
    expect(indexedDbFactory.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.size).toBe(0);
  });

  it('propagates a high-water read failure without persisting any row', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const readError = new Error('injected ingest-sequence get failure');
    indexedDbFactory.failNextRequest({
      storeName: DIAGNOSTICS_META_STORE,
      operation: 'get',
      error: readError,
    });

    await expect(storage.appendPreparedEvents([
      storage.prepareEvent('performance', { id: 'meta-read-failure' }),
    ])).rejects.toBe(readError);
    expect(indexedDbFactory.getStoreState(
      DIAGNOSTICS_DB_NAME,
      DIAGNOSTICS_EVENTS_STORE,
    ).records.size).toBe(0);
  });

  it('rejects oversized or malformed batches before opening a transaction', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const row = storage.prepareEvent('performance', { id: 'bounded' });

    await expect(storage.appendPreparedEvents(Array.from({ length: MAX_FLUSH_BATCH + 1 }, () => row)))
      .rejects.toThrow(/64/);
    await expect(storage.appendPreparedEvents([{ ...row, kind: 'unknown' }]))
      .rejects.toThrow(/Unsupported diagnostics event kind/);
    expect(indexedDbFactory.transactionCount).toBe(0);
  });

  it('provides bounded metadata and synchronous-request transaction wrappers', async () => {
    const { storage } = makeStorage();

    await storage.setMeta('migration:performance', { state: 'copying', ordinal: 64 });
    await expect(storage.getMeta('migration:performance'))
      .resolves.toEqual({ state: 'copying', ordinal: 64 });
    await expect(storage.runTransaction(
      DIAGNOSTICS_META_STORE,
      'readonly',
      async () => null,
    )).rejects.toThrow(/must be synchronous/);
  });

  it('performs bounded exact-UID point reads for fallback verification', async () => {
    const { indexedDbFactory, storage } = makeStorage();
    const records = ['one', 'two', 'three'].map((id) => storage.prepareEvent(
      'performance',
      { id },
      { eventUid: `performance:point-${id}` },
    ));
    await storage.appendPreparedEvents(records);

    await expect(storage.readEventsByUids([
      'performance:point-three',
      'performance:missing',
      'performance:point-one',
    ])).resolves.toEqual([
      expect.objectContaining({ eventUid: 'performance:point-three' }),
      expect.objectContaining({ eventUid: 'performance:point-one' }),
    ]);
    expect(() => storage.readEventsByUids(Array.from(
      { length: MAX_PRUNE_DELETES_PER_TX + 1 },
      (_, index) => `performance:too-many-${index}`,
    ))).toThrow(/point-read batch exceeds/);

    const readError = new Error('injected verification point-read failure');
    indexedDbFactory.failNextRequest({
      storeName: DIAGNOSTICS_EVENTS_STORE,
      operation: 'get',
      error: readError,
    });
    await expect(storage.readEventsByUids(['performance:point-one'])).rejects.toBe(readError);
  });

  it('rolls back queued writes when a transaction is explicitly aborted', async () => {
    const { storage } = makeStorage();

    await expect(storage.runTransaction(
      DIAGNOSTICS_META_STORE,
      'readwrite',
      ({ objectStore, transaction }) => {
        objectStore(DIAGNOSTICS_META_STORE).put({ key: 'must-not-commit', value: true });
        transaction.abort();
      },
    )).rejects.toThrow(/AbortError/);
    await expect(storage.getMeta('must-not-commit')).resolves.toBeUndefined();
  });

  it('fails explicitly when IndexedDB is unavailable and permits a later retry', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const storage = createDiagnosticsStorage({ indexedDbFactory: null });

    await expect(storage.open()).rejects.toThrow(/IndexedDB unavailable/);
    await expect(storage.open()).rejects.toThrow(/IndexedDB unavailable/);
  });

  it('fails a blocked or errored open safely and permits a later retry', async () => {
    const blockedFactory = new FakeIndexedDb();
    blockedFactory.blockNextOpen();
    const blockedStorage = createDiagnosticsStorage({ indexedDbFactory: blockedFactory });
    await expect(blockedStorage.open()).rejects.toThrow(/open blocked/);
    await expect(blockedStorage.open()).resolves.toBeTruthy();

    const openError = new Error('injected open failure');
    const errorFactory = new FakeIndexedDb();
    errorFactory.failNextOpen(openError);
    const errorStorage = createDiagnosticsStorage({ indexedDbFactory: errorFactory });
    await expect(errorStorage.open()).rejects.toBe(openError);
    await expect(errorStorage.open()).resolves.toBeTruthy();
  });

  it('rolls back a failed schema upgrade and opens cleanly on retry', async () => {
    const indexedDbFactory = new FakeIndexedDb();
    const upgradeError = new Error('injected meta-store creation failure');
    indexedDbFactory.failNextSchemaOperation({
      operation: 'createObjectStore',
      storeName: DIAGNOSTICS_META_STORE,
      error: upgradeError,
    });
    const storage = createDiagnosticsStorage({ indexedDbFactory });

    await expect(storage.open()).rejects.toBe(upgradeError);
    await expect(storage.open()).resolves.toBeTruthy();
    expect(indexedDbFactory.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_EVENTS_STORE)).toBeTruthy();
    expect(indexedDbFactory.getStoreState(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_META_STORE)).toBeTruthy();
  });
});
