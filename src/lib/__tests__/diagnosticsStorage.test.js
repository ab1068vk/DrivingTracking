import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTICS_DB_NAME,
  DIAGNOSTICS_DB_VERSION,
  DIAGNOSTICS_EVENT_INDEXES,
  DIAGNOSTICS_EVENT_KINDS,
  DIAGNOSTICS_EVENTS_STORE,
  DIAGNOSTICS_META_STORE,
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
  });

  it('rejects an invalid injected UID instead of persisting a misleading string value', () => {
    const { storage } = makeStorage({ uidFactory: () => undefined });

    expect(() => storage.prepareEvent('performance', { id: 'missing-uid' }))
      .toThrow(/UID factory/);
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
    const original = storage.prepareEvent('system_log', { message: 'first' });
    await storage.appendPreparedEvents([original]);

    await expect(storage.appendPreparedEvents([{
      ...original,
      payload: { message: 'different' },
    }])).rejects.toThrow(/eventUid collision/);
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

  it('fails explicitly when IndexedDB is unavailable and permits a later retry', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const storage = createDiagnosticsStorage({ indexedDbFactory: null });

    await expect(storage.open()).rejects.toThrow(/IndexedDB unavailable/);
    await expect(storage.open()).rejects.toThrow(/IndexedDB unavailable/);
  });
});
