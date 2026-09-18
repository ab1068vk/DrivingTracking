import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: () => 'web', isAndroid: () => false, isNativePlatform: () => false,
}));
const storage = new Map();
vi.mock('@/lib/mobileStorage', () => ({
  getJson: async (key, fallback = null) => (storage.has(key) ? structuredClone(storage.get(key)) : fallback),
  setJson: async (key, value) => { storage.set(key, structuredClone(value)); },
  removeJson: async (key) => { storage.delete(key); },
}));
vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));

import { FakeIndexedDb } from './helpers/fakeIndexedDb';

const model = (id, limitKmh) => ({
  schemaVersion: 1, knowledgeRevision: 4, cells: {},
  corrections: [{ id, geohash: 'dpz800', limitKmh, source: 'manual' }],
  excludedSections: [], roadMemory: { candidates: [] },
});

/**
 * P6-V12 browser half: the speed generation lives in one durable control
 * record. Erasing or replacing it must revoke D4 coverage atomically - no
 * reader may be served content published under a generation the control no
 * longer names.
 */
describe('P6-V12 browser speed generation control', () => {
  let indexedDb;
  let repository;

  beforeEach(async () => {
    storage.clear();
    indexedDb = new FakeIndexedDb();
    vi.stubGlobal('indexedDB', indexedDb);
    vi.stubGlobal('IDBKeyRange', indexedDb.keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }) },
      locks: { request: async (name, _options, operation) => operation({ name }) },
    });
    repository = await import('@/lib/speedKnowledgeRepository');
    await repository.readP6BrowserSpeedAuthority();
  });

  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  const control = () => indexedDb.getStoreState(
    repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.CONTROL,
  );
  const partitions = () => indexedDb.getStoreState(
    repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.PARTITIONS,
  );

  const activate = (publicationVersion, stageId) => control().records.set(
    repository.P6_SPEED_AUTHORITY_KEY,
    {
      key: repository.P6_SPEED_AUTHORITY_KEY, version: 2, state: 'ACTIVE',
      stageId, publicationVersion,
    },
  );

  const guard = (publicationVersion, stageId) => storage.set(
    repository.P6_SPEED_V2_CUTOVER_MARKER_KEY,
    { version: 2, state: 'ACTIVE', stageId, publicationVersion },
  );

  it('refuses D4 reads when the active control record is lost', async () => {
    activate(1, 'generation-one');
    guard(1, 'generation-one');
    await repository.speedKnowledgeStore.setForGeohashes(model('under-generation-one', 40), ['dpz8']);
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8'])).resolves.toMatchObject({
      corrections: [expect.objectContaining({ id: 'under-generation-one' })],
    });
    const published = [...partitions().records.values()];
    expect(published.length).toBeGreaterThan(0);

    // The control record is erased: a wiped profile, a partial restore, a
    // storage eviction. The published partitions are still on disk.
    control().records.delete(repository.P6_SPEED_AUTHORITY_KEY);

    await expect(repository.readP6BrowserSpeedAuthority()).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    await expect(repository.isP6BrowserSpeedV2Authority()).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    // No reader is served the orphaned v2 content or allowed to resurrect v1.
    await expect(repository.readP6BrowserSpeedBuckets(['dpz8'])).rejects.toMatchObject({
      code: repository.P6_SPEED_AUTHORITY_UNREADABLE,
    });
    await expect(repository.queryP6BrowserSpeedEditorItems({
      kind: 'correction', filter: 'under-generation-one',
    })).rejects.toMatchObject({ code: repository.P6_SPEED_AUTHORITY_UNREADABLE });
    expect(storage.has(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toBe(true);
    // The rows are still there; what changed is that nothing names them.
    expect([...partitions().records.values()].length).toBe(published.length);
  }, 120_000);

  it('serves only the new generation after legal erasure and E4 re-runs', async () => {
    activate(1, 'generation-one');
    guard(1, 'generation-one');
    await repository.speedKnowledgeStore.setForGeohashes(model('old-generation', 40), ['dpz8']);
    const oldManifest = indexedDb.getStoreState(
      repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.MANIFESTS,
    ).records.get('dpz8');
    expect(oldManifest.state).toBe('COMMITTED');
    const oldStageId = oldManifest.stageId;

    // A real data-rights erasure is positive evidence of a legal return to v1.
    await repository.eraseSpeedKnowledgeForDataRights();
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    expect(storage.has(repository.P6_SPEED_V2_CUTOVER_MARKER_KEY)).toBe(false);
    await repository.speedKnowledgeStore.set(
      repository.SPEED_KNOWLEDGE_STORAGE_KEY, model('new-generation', 70),
    );

    // E4 runs again and mints a new generation.
    expect(await repository.beginP6BrowserSpeedMigration())
      .toMatchObject({ state: 'CONVERSION_IN_PROGRESS' });
    let migration = null;
    for (let turn = 0; turn < 20; turn += 1) {
      migration = await repository.stepP6BrowserSpeedMigration();
      if (migration.done) break;
    }
    expect(migration).toMatchObject({ state: 'COMPLETE', done: true });

    const authority = await repository.readP6BrowserSpeedAuthority();
    expect(authority.version).toBe(2);
    expect(authority.stageId).not.toBe(oldStageId);

    // Only the new generation is reachable, through every scoped surface.
    await expect(repository.speedKnowledgeStore.getForGeohashes(['dpz8'])).resolves.toMatchObject({
      corrections: [expect.objectContaining({ id: 'new-generation', limitKmh: 70 })],
    });
    const editor = await repository.queryP6BrowserSpeedEditorItems({
      kind: 'correction', filter: 'old-generation',
    });
    expect(editor).toMatchObject({ items: [], itemCount: 0 });
    // The previous generation's bucket binding went with the cutover, so the
    // authority record is the only thing that can name a visible bucket.
    const remaining = [...indexedDb.getStoreState(
      repository.SPEED_KNOWLEDGE_DB_NAME, repository.P6_SPEED_STORES.MANIFESTS,
    ).records.values()];
    expect(remaining.some((row) => row.stageId === oldStageId)).toBe(false);
  }, 120_000);
});
