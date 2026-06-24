import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(),
  removeJson: vi.fn(),
  setJson: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: vi.fn(),
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

const makeDomStringList = (items) => ({
  contains: (item) => items.has(item),
});

const makeIdbRequest = (run) => {
  const request = {
    error: null,
    result: undefined,
    onerror: null,
    onsuccess: null,
  };

  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
    }
  });

  return request;
};

class FakeObjectStore {
  constructor(state, transaction) {
    this.state = state;
    this.transaction = transaction;
  }

  get(key) {
    return makeIdbRequest(() => this.state.records.get(key));
  }

  put(value) {
    return makeIdbRequest(() => {
      this.state.records.set(value.key, value);
      queueMicrotask(() => this.transaction.oncomplete?.());
      return value.key;
    });
  }
}

class FakeTransaction {
  constructor(databaseState) {
    this.databaseState = databaseState;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore(name) {
    const store = this.databaseState.stores.get(name);
    if (!store) throw new Error(`Missing object store: ${name}`);
    return new FakeObjectStore(store, this);
  }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
  }

  get objectStoreNames() {
    return makeDomStringList(new Set(this.state.stores.keys()));
  }

  createObjectStore(name) {
    if (!this.state.stores.has(name)) {
      this.state.stores.set(name, { records: new Map() });
    }
  }

  transaction(name) {
    const names = Array.isArray(name) ? name : [name];
    names.forEach((storeName) => {
      if (!this.state.stores.has(storeName)) throw new Error(`Missing object store: ${storeName}`);
    });
    return new FakeTransaction(this.state);
  }

  close() {}
}

class FakeIndexedDb {
  constructor() {
    this.databases = new Map();
  }

  open(name, version) {
    const request = {
      error: null,
      result: undefined,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
    };

    queueMicrotask(() => {
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;
      if (!state) {
        state = { version, stores: new Map() };
        this.databases.set(name, state);
      }

      request.result = new FakeDatabase(state);
      if (oldVersion < version) {
        state.version = version;
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
      }
      request.onsuccess?.({ target: request });
    });

    return request;
  }

  deleteDatabase(name) {
    const request = {
      error: null,
      result: undefined,
      onerror: null,
      onsuccess: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      this.databases.delete(name);
      request.onsuccess?.({ target: request });
    });

    return request;
  }
}

describe('speedKnowledgeRepository native mirror', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
  });

  it('keeps saved speed rules readable by Android native auto tracking after IndexedDB migration', async () => {
    isNativePlatform.mockReturnValue(true);
    getJson.mockResolvedValue({
      cells: {
        dpz83b: { limitKmh: 50, source: 'user_confirmed_posted_sign' },
      },
      corrections: [{
        id: 'rule-50',
        geohash: 'dpz83b',
        lat: 43.6532,
        lng: -79.3832,
        limitKmh: 50,
        source: 'user_confirmed_posted_sign',
        appliedAt: '2026-06-23T12:00:00.000Z',
        note: 'not needed by native',
        sectionPoints: [
          { lat: 43.6530, lng: -79.3840, label: 'start' },
          { lat: 43.6538, lng: -79.3830, label: 'end' },
        ],
      }],
    });

    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(removeJson).not.toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_STORAGE_KEY,
      {
        cells: {},
        corrections: [expect.objectContaining({
          id: 'rule-50',
          geohash: 'dpz83b',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          appliedAt: '2026-06-23T12:00:00.000Z',
          sectionPoints: [
            { lat: 43.6530, lng: -79.3840 },
            { lat: 43.6538, lng: -79.3830 },
          ],
        })],
      }
    );
  });

  it('recreates the native mirror when speed knowledge was already migrated to IndexedDB', async () => {
    isNativePlatform.mockReturnValue(true);
    const indexedDb = new FakeIndexedDb();
    indexedDb.databases.set('drivesense_speed_knowledge', {
      version: 1,
      stores: new Map([[
        'knowledge',
        {
          records: new Map([[
            'speed_knowledge_v1',
            {
              key: 'speed_knowledge_v1',
              value: {
                cells: {},
                corrections: [{
                  id: 'already-migrated-rule',
                  geohash: 'dpz83c',
                  limitKmh: 50,
                  source: 'user_confirmed_posted_sign',
                }],
              },
            },
          ]]),
        },
      ]]),
    });
    vi.stubGlobal('indexedDB', indexedDb);

    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(getJson).not.toHaveBeenCalled();
    expect(removeJson).not.toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_STORAGE_KEY,
      {
        cells: {},
        corrections: [expect.objectContaining({
          id: 'already-migrated-rule',
          geohash: 'dpz83c',
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
        })],
      }
    );
  });

  it('removes the legacy mirror on web after IndexedDB migration', async () => {
    isNativePlatform.mockReturnValue(false);
    getJson.mockResolvedValue({ cells: {}, corrections: [] });

    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(setJson).not.toHaveBeenCalled();
  });

  it('deletes indexed speed knowledge and its native mirror during data-rights erasure', async () => {
    const indexedDb = new FakeIndexedDb();
    indexedDb.databases.set('drivesense_speed_knowledge', {
      version: 1,
      stores: new Map([[
        'knowledge',
        {
          records: new Map([[
            'speed_knowledge_v1',
            {
              key: 'speed_knowledge_v1',
              value: { cells: {}, corrections: [{ id: 'stored-rule', lat: 43.65, lng: -79.38 }] },
            },
          ]]),
        },
      ]]),
    });
    vi.stubGlobal('indexedDB', indexedDb);

    const {
      SPEED_KNOWLEDGE_DB_NAME,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      eraseSpeedKnowledgeForDataRights,
    } = await import('@/lib/speedKnowledgeRepository');

    const result = await eraseSpeedKnowledgeForDataRights();

    expect(result).toMatchObject({
      indexedDbDeleted: true,
      fallbackKey: SPEED_KNOWLEDGE_STORAGE_KEY,
      fallbackRemoved: true,
    });
    expect(indexedDb.databases.has(SPEED_KNOWLEDGE_DB_NAME)).toBe(false);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_STORAGE_KEY,
      expect.objectContaining({ _secure_delete_tombstone: true })
    );
    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
  });
});
