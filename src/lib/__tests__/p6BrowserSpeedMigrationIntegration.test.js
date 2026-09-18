import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const state = vi.hoisted(() => ({ preferences: new Map(), secure: new Map() }));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({ value: state.preferences.get(key) ?? null })),
    set: vi.fn(async ({ key, value }) => state.preferences.set(key, value)),
    remove: vi.fn(async ({ key }) => state.preferences.delete(key)),
  },
}));

vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: () => 'web', isAndroid: () => false, isNativePlatform: () => false,
}));
vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback) => state.secure.get(key) ?? fallback),
  setJson: vi.fn(async (key, value) => state.secure.set(key, structuredClone(value))),
  removeJson: vi.fn(async (key) => state.secure.delete(key)),
}));
vi.mock('@/lib/securePayloadCrypto', () => ({
  encryptSensitiveValue: vi.fn(async (value, context) => ({
    encrypted: true, key_version: 1, context, payload: structuredClone(value),
  })),
  decryptSensitiveValue: vi.fn(async (value) => structuredClone(value.payload)),
  getEncryptedJson: vi.fn(async (key, fallback) => state.secure.get(key) ?? fallback),
  setEncryptedJson: vi.fn(async (key, value) => state.secure.set(key, structuredClone(value))),
  removeEncryptedJson: vi.fn(async (key) => state.secure.delete(key)),
  isEncryptedPayload: (value) => value?.encrypted === true,
}));
vi.mock('@/lib/nativeSpeedKnowledgeStore', () => ({
  readNativeSpeedBuckets: vi.fn(), readNativeSpeedKnowledgeSample: vi.fn(), writeNativeSpeedBuckets: vi.fn(),
}));
vi.mock('@/lib/nativeTripArchive', () => ({ nativeTripArchive: {}, readNativeSpeedBucket: vi.fn() }));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));
vi.mock('@/lib/p6DerivedStorage', () => ({
  registerP6BrowserDerivedReclaimer: vi.fn(), requireBrowserP6DerivedStorage: vi.fn(async () => ({ admitted: true })),
}));

const keyRange = {
  only: (only) => ({ only }),
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }),
  lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen }),
};
const wrapper = (payload, ciphertext) => ({ encrypted: true, key_version: 1, ciphertext, payload });
const model = (id, limit = 40) => ({
  schemaVersion: 1, knowledgeRevision: 7, cells: {},
  corrections: [{ id, geohash: 'dpz800', limitKmh: limit, source: 'manual' }],
  excludedSections: [], roadMemory: { candidates: [] },
});
const modelAt = (id, geohash, limit = 40) => ({
  schemaVersion: 1, knowledgeRevision: 9, cells: {},
  corrections: [{ id, geohash, limitKmh: limit, source: 'manual' }],
  excludedSections: [], roadMemory: { candidates: [] },
});

const finishMigration = async (repository) => {
  for (let turn = 0; turn < 20; turn += 1) {
    const outcome = await repository.stepP6BrowserSpeedMigration();
    if (outcome.done) return outcome;
  }
  throw new Error('migration did not converge');
};

describe('P6 browser saved-speed E4 authority', () => {
  beforeEach(() => {
    state.preferences.clear();state.secure.clear();
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('selects WAL before IDB before Preferences and preserves v1 until the atomic v2 cutover', async () => {
    let repository=await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    const indexed=indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,'knowledge');
    indexed.records.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, {
      key: repository.SPEED_KNOWLEDGE_STORAGE_KEY,
      value: wrapper(model('idb'), 'idb-ciphertext'), updatedAt: '2026-09-08T00:00:00Z',
    });
    // The browser write path is `setJson`, i.e. the mocked mobileStorage, not
    // the Capacitor Preferences backend: seeding anywhere else would model a
    // platform this test explicitly is not.
    state.secure.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY,
      wrapper(model('preferences'), 'preferences-ciphertext'));
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(model('wal',55), 'wal-ciphertext'));

    const began=await repository.beginP6BrowserSpeedMigration();
    expect(began).toMatchObject({ state: 'CONVERSION_IN_PROGRESS', sourceId: 'preferences_write_ahead' });
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 1, state: 'ACTIVE' });
    await expect(repository.readP6BrowserSpeedBuckets(['dpz8'])).resolves.toBeNull();
    const first=await repository.stepP6BrowserSpeedMigration();
    expect(first).toMatchObject({ state: 'CONVERSION_IN_PROGRESS', done: false });
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 1 });
    await expect(repository.queryP6BrowserSpeedEditorItems({ kind: 'correction', filter: 'wal' }))
      .resolves.toBeNull();

    // A fresh module has no decoded-source cache; the durable fence and exact
    // predecessor reread are sufficient to resume and switch authority.
    vi.resetModules();repository=await import('@/lib/speedKnowledgeRepository');
    const completed=await repository.stepP6BrowserSpeedMigration();
    expect(completed).toMatchObject({ state: 'COMPLETE', done: true });
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 2, state: 'ACTIVE' });
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8'])).resolves.toMatchObject({
      corrections: [{ id: 'wal', limitKmh: 55 }],
    });
    await expect(repository.speedKnowledgeStore.get()).rejects.toMatchObject({
      code: repository.P6_SPEED_SCOPED_READ_REQUIRED,
    });
    expect(state.secure.get(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY).ciphertext)
      .toBe('wal-ciphertext');
    expect(indexed.records.get(repository.SPEED_KNOWLEDGE_STORAGE_KEY).value.ciphertext).toBe('idb-ciphertext');
  });

  it('uses IDB when WAL is absent, then Preferences when both newer sources are absent', async () => {
    const repository=await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    const indexed=indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,'knowledge');
    indexed.records.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, {
      key: repository.SPEED_KNOWLEDGE_STORAGE_KEY,value: wrapper(model('idb'), 'idb-only'),
    });
    state.secure.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY,
      wrapper(model('preferences'), 'preferences-only'));
    await expect(repository.beginP6BrowserSpeedMigration()).resolves.toMatchObject({ sourceId: 'indexeddb' });
    let phase={ phase: 'PARTITIONS' };
    for(let turn=0;turn<10;turn++){
      const cancelled=await repository.cancelP6BrowserSpeedMigrationTurn(phase);
      if(cancelled.done)break;phase=cancelled.cursor;
    }

    vi.stubGlobal('indexedDB',new FakeIndexedDb());
    await repository.readP6BrowserSpeedAuthority();
    await expect(repository.beginP6BrowserSpeedMigration()).resolves.toMatchObject({ sourceId: 'preferences_legacy' });
  });

  it('rejects a changed predecessor before cutover and bounded cancellation removes every stage row', async () => {
    const repository=await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(model('original'), 'original'));
    const began=await repository.beginP6BrowserSpeedMigration();
    await repository.stepP6BrowserSpeedMigration();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(model('changed'), 'changed'));
    await expect(repository.stepP6BrowserSpeedMigration()).resolves.toMatchObject({
      state: 'E4_PREDECESSOR_CHANGED', done: false,
    });
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 1 });
    const partitions=indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.PARTITIONS);
    expect([...partitions.records.values()].some((row) => row.stageId === began.stageId)).toBe(true);
    let phase={ phase: 'PARTITIONS' },cancelled;
    for(let turn=0;turn<10;turn++){
      cancelled=await repository.cancelP6BrowserSpeedMigrationTurn(phase);
      if(cancelled.done)break;phase=cancelled.cursor;
    }
    expect(cancelled).toMatchObject({ state: 'CANCELLED', done: true });
    expect([...partitions.records.values()].filter((row) => row.stageId === began.stageId)).toEqual([]);
    const editor=indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.EDITOR_INDEX);
    expect([...editor.records.values()].filter((row) => row.stageId === began.stageId)).toEqual([]);
  });

  it('classifies every former whole-model caller after browser-v2 cutover', async () => {
    const repository=await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(model('v2-caller-law', 65), 'caller-law'));
    await repository.beginP6BrowserSpeedMigration();
    let migration;
    for(let turn=0;turn<10;turn+=1){
      migration=await repository.stepP6BrowserSpeedMigration();
      if(migration.done)break;
    }
    expect(migration).toMatchObject({ state: 'COMPLETE', done: true });

    const {
      LocalSpeedKnowledge,
      P6_SPEED_CALLER_REFUSALS,
    }=await import('@/lib/localSpeedKnowledge');
    const knowledge=new LocalSpeedKnowledge(repository.speedKnowledgeStore);
    const wholeModelGet=vi.spyOn(repository.speedKnowledgeStore, 'get');

    // exportData is classified as an explicit full-model operation and uses
    // the repository's paged bucket stream rather than the forbidden get().
    await expect(knowledge.exportData()).resolves.toMatchObject({
      corrections: [{ id: 'v2-caller-law', limitKmh: 65 }],
    });
    expect(wholeModelGet).not.toHaveBeenCalled();

    // Coordinates select only the required prefix-4 buckets. An empty or
    // unusable scope is an intentional typed refusal under partitioned v2.
    await expect(knowledge.exportDataForPoints([{ lat: 43.6532, lng: -79.3832 }]))
      .resolves.toMatchObject({ corrections: [{ id: 'v2-caller-law' }] });
    await expect(knowledge.exportDataForPoints([])).rejects.toMatchObject({
      code: P6_SPEED_CALLER_REFUSALS.POINT_SCOPE_REQUIRED,
    });

    // The resolver fallback is legacy-only, and the superseded full-history
    // learner cannot be accidentally reactivated after E4.
    await expect(knowledge._resolverSnapshot()).rejects.toMatchObject({
      code: P6_SPEED_CALLER_REFUSALS.SCOPED_RESOLVER_REQUIRED,
    });
    await expect(knowledge.learnRoadMemoryFromTrips([])).rejects.toMatchObject({
      code: P6_SPEED_CALLER_REFUSALS.LEGACY_LEARNER_RETIRED,
    });
    expect(wholeModelGet).not.toHaveBeenCalled();
  });

  it('uses one atomic generation switch for E4 and whole-model restore', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(modelAt('e4-old', 'dpz800'), 'e4-old'));
    await repository.beginP6BrowserSpeedMigration();
    await finishMigration(repository);
    await repository.speedKnowledgeStore.setForGeohashes(modelAt('scoped-old', 'dpz800', 55), ['dpz8']);
    const manifests = indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.MANIFESTS);
    expect(manifests.records.get('dpz8')).toMatchObject({ state: 'COMMITTED' });

    await repository.replaceSpeedKnowledgeData(modelAt('restored-only', 'f2m200', 70));
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8', 'f2m2']))
      .resolves.toMatchObject({ corrections: [{ id: 'restored-only', geohash: 'f2m200' }] });
    await expect(repository.readSpeedKnowledgeData({ explicitFullModel: true }))
      .resolves.toMatchObject({ corrections: [{ id: 'restored-only', geohash: 'f2m200' }] });
    expect(manifests.records.has('dpz8')).toBe(false);

    for (let turn = 0; turn < 80; turn += 1) {
      const outcome = await repository.reclaimP6BrowserSpeedDerivedTurn();
      if (outcome.state === 'NO_RECLAIMABLE_DERIVED_DATA') break;
    }
    await expect(repository.speedKnowledgeStore.getForGeohashes(['f2m2']))
      .resolves.toMatchObject({ corrections: [{ id: 'restored-only', geohash: 'f2m200' }] });
    expect(state.secure.get(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toMatchObject({
      version: 2, state: 'ACTIVE',
    });
  });

  it('keeps the complete old generation when the shared authority transaction aborts', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(modelAt('atomic-old', 'dpz800'), 'atomic-old'));
    await repository.beginP6BrowserSpeedMigration();
    await finishMigration(repository);
    await repository.speedKnowledgeStore.setForGeohashes(modelAt('scoped-old', 'dpz800', 55), ['dpz8']);

    const before = await repository.readP6BrowserSpeedAuthority();
    const manifests = indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.MANIFESTS);
    const oldManifest = structuredClone(manifests.records.get('dpz8'));
    indexedDB.failNextRequest({
      storeName: repository.P6_SPEED_STORES.CONTROL,
      operation: 'put',
      error: new Error('KILL_DURING_GENERATION_SWITCH'),
    });

    await expect(repository.replaceSpeedKnowledgeData(modelAt('atomic-new', 'f2m200', 70)))
      .rejects.toThrow('KILL_DURING_GENERATION_SWITCH');
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({
      version: 2, stageId: before.stageId, publicationVersion: before.publicationVersion,
    });
    expect(manifests.records.get('dpz8')).toEqual(oldManifest);
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8', 'f2m2']))
      .resolves.toMatchObject({ corrections: [expect.objectContaining({ id: 'scoped-old' })] });

    // The same operation can resume with a new stage. The guard advances with
    // the successful authority commit and the new generation is complete.
    await repository.replaceSpeedKnowledgeData(modelAt('atomic-new', 'f2m200', 70));
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8', 'f2m2']))
      .resolves.toMatchObject({ corrections: [{ id: 'atomic-new', geohash: 'f2m200', limitKmh: 70 }] });
  });

  it('fails closed across the former cutover-marker gap and retires the guard only on erasure', async () => {
    const repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
    state.secure.set(repository.SPEED_KNOWLEDGE_WRITE_AHEAD_KEY,
      wrapper(modelAt('guarded', 'dpz800'), 'guarded'));
    await repository.beginP6BrowserSpeedMigration();
    await finishMigration(repository);
    const authorityStore = indexedDB.getStoreState(repository.SPEED_KNOWLEDGE_DB_NAME,
      repository.P6_SPEED_STORES.CONTROL);
    const authority = authorityStore.records.get(repository.P6_SPEED_AUTHORITY_KEY);
    const browserDb = globalThis.indexedDB;

    // PREPARED is the durable state at the old authority-commit/marker gap.
    state.secure.set(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY, {
      version: 2, state: 'PREPARED', stageId: authority.stageId,
      publicationVersion: authority.publicationVersion,
    });
    vi.stubGlobal('indexedDB', undefined);
    await expect(repository.readP6BrowserSpeedAuthority()).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    vi.stubGlobal('indexedDB', browserDb);

    authorityStore.records.delete(repository.P6_SPEED_AUTHORITY_KEY);
    await expect(repository.readP6BrowserSpeedAuthority()).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    expect(state.secure.has(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toBe(true);

    authorityStore.records.set(repository.P6_SPEED_AUTHORITY_KEY, {
      ...authority, publicationVersion: Number(authority.publicationVersion) + 1,
    });
    await expect(repository.readP6BrowserSpeedAuthority()).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    expect(state.secure.has(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toBe(true);

    await repository.eraseSpeedKnowledgeForDataRights();
    expect(state.secure.has(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toBe(false);
    await expect(repository.readP6BrowserSpeedAuthority()).resolves.toMatchObject({ version: 1, state: 'ACTIVE' });
  });
});
