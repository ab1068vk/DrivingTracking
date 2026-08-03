import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJson, removeJson, setJson } from '@/lib/mobileStorage';
import { isNativePlatform } from '@/lib/nativePlatform';
import { logSystemFailure } from '@/lib/systemLog';

const privacyState = vi.hoisted(() => ({
  zones: [],
  error: null,
}));
const cryptoState = vi.hoisted(() => ({
  decryptSensitiveValue: vi.fn(),
  encryptSensitiveValue: vi.fn(),
  getEncryptedJson: vi.fn(),
  removeEncryptedJson: vi.fn(),
  setEncryptedJson: vi.fn(),
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(),
  removeJson: vi.fn(),
  setJson: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: vi.fn(() => 'web'),
  isAndroid: vi.fn(() => false),
  isNativePlatform: vi.fn(),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  decryptSensitiveValue: (...args) => cryptoState.decryptSensitiveValue(...args),
  encryptSensitiveValue: (...args) => cryptoState.encryptSensitiveValue(...args),
  getEncryptedJson: (...args) => cryptoState.getEncryptedJson(...args),
  isEncryptedPayload: (value) => value?.encrypted === true && value?.version === 1,
  removeEncryptedJson: (...args) => cryptoState.removeEncryptedJson(...args),
  setEncryptedJson: (...args) => cryptoState.setEncryptedJson(...args),
}));

vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

vi.mock('@/lib/privacyZones', () => ({
  getHydratedPrivacyZones: vi.fn(async () => {
    if (privacyState.error) throw privacyState.error;
    return privacyState.zones;
  }),
}));

vi.mock('@/lib/speedKnowledgePrivacy', () => ({
  purgeSpeedKnowledgeDataForPrivacyZones: (value, zones) => {
    const blocked = new Set((zones || []).flatMap((zone) => zone?.blockedGeohashes || []));
    return {
      data: {
        ...value,
        cells: Object.fromEntries(Object.entries(value?.cells || {})
          .filter(([geohash]) => !blocked.has(geohash))),
      },
    };
  },
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
    privacyState.zones = [];
    privacyState.error = null;
    cryptoState.encryptSensitiveValue.mockImplementation(async (value, context) => ({
      encrypted: true,
      version: 1,
      key_version: 1,
      algorithm: 'AES-256-GCM',
      context,
      payload: structuredClone(value),
    }));
    cryptoState.decryptSensitiveValue.mockImplementation(async (value) => structuredClone(value.payload));
    cryptoState.setEncryptedJson.mockImplementation(async (key, value) => {
      const encrypted = await cryptoState.encryptSensitiveValue(value, `storage:${key}`);
      await setJson(key, encrypted);
    });
    cryptoState.getEncryptedJson.mockImplementation(async (key, fallback) => {
      const stored = await getJson(key, null);
      if (stored == null) return fallback;
      if (stored?.encrypted === true && stored?.version === 1) {
        return cryptoState.decryptSensitiveValue(stored, `storage:${key}`);
      }
      await cryptoState.setEncryptedJson(key, stored);
      return stored;
    });
    cryptoState.removeEncryptedJson.mockImplementation(async (key) => removeJson(key));
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps saved speed rules readable by Android native auto tracking after IndexedDB migration', async () => {
    isNativePlatform.mockReturnValue(true);
    getJson.mockResolvedValue({
      cells: {
        dpz83b: { limitKmh: 50, source: 'user_confirmed_posted_sign' },
        dpz83c: { limitKmh: 250, source: 'user_confirmed_posted_sign' },
      },
      corrections: [
        {
          id: 'rule-50',
          geohash: 'dpz83b',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          qualifierStatus: 'regulatory_text_no_qualifiers',
          valid_from: '2026-06-22T12:00:00.000Z',
          appliedAt: '2026-06-23T12:00:00.000Z',
          note: 'not needed by native',
          sectionPoints: [
            { lat: 43.6530, lng: -79.3840, label: 'start' },
            { lat: 43.6538, lng: -79.3830, label: 'end' },
          ],
        },
        {
          id: 'implausible-rule',
          geohash: 'dpz83b',
          limitKmh: 250,
          source: 'user_confirmed_posted_sign',
        },
      ],
      roadMemory: {
        candidates: [
          ...Array.from({ length: 8 }, (_, index) => ({
            id: `reviewed-candidate-${index}`,
            limitKmh: 50,
            confidence: 0.72,
            agreement: 1,
            tripCount: 4,
            tripIds: [
              `reviewed-${index}-1`,
              `reviewed-${index}-2`,
              `reviewed-${index}-3`,
              `reviewed-${index}-4`,
            ],
            lastObservedAt: '2026-07-28T12:00:00.000Z',
            reviewState: 'confirmed',
            limitAtReviewKmh: 50,
            reviewedLimitKmh: 50,
            feedbackOutcome: 'exact',
            // Native use of a time-pattern candidate now requires parked
            // validation in that same context; all-times feedback must not
            // authorize it by global extrapolation.
            timeProfiles: [{
              bucket: 'weekday_morning',
              limitKmh: 40,
              tripCount: 3,
              agreement: 1,
              eligible: true,
            }],
          })),
          {
          id: 'candidate-50',
          geohash: 'dpz83b',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          confidence: 0.68,
          agreement: 1,
          tripCount: 4,
          tripIds: ['active-1', 'active-2', 'active-3', 'active-4'],
          active: true,
          lastObservedAt: '2026-07-28T12:00:00.000Z',
          directionMode: 'forward',
          directionBearing: 90,
          timeProfiles: [{
            bucket: 'weekday_morning',
            limitKmh: 40,
            tripCount: 3,
            agreement: 1,
            eligible: true,
          }],
          sectionPoints: [
            { lat: 43.6530, lng: -79.3840 },
            { lat: 43.6538, lng: -79.3830 },
          ],
          },
        ],
      },
    });

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      expect.objectContaining({
        encrypted: true,
        payload: expect.objectContaining({
        cells: {
          dpz83b: expect.objectContaining({
            limitKmh: 50,
            source: 'user_confirmed_posted_sign',
            confidence: 0.92,
            conflict: false,
          }),
        },
        corrections: [expect.objectContaining({
          id: 'rule-50',
          geohash: 'dpz83b',
          lat: 43.6532,
          lng: -79.3832,
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          qualifierStatus: 'regulatory_text_no_qualifiers',
          validFrom: '2026-06-22T12:00:00.000Z',
          appliedAt: '2026-06-23T12:00:00.000Z',
          sectionPoints: [
            { lat: 43.6530, lng: -79.3840 },
            { lat: 43.6538, lng: -79.3830 },
          ],
        })],
        roadMemory: {
          version: 3,
          candidates: [expect.objectContaining({
            id: 'candidate-50',
            source: 'local_road_memory',
            limitKmh: 50,
            confidence: 0.7,
            tripCount: 4,
            stage: 'operational',
            intelligenceValidated: true,
            timeProfilesAcceptedAt: null,
            timeProfiles: [],
          })],
        },
        }),
      })
    );
  });

  it('recreates the native mirror while leaving legacy no-geometry rules review-only', async () => {
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
                  sectionPoints: [
                    { lat: 43.6532, lng: -79.3842 },
                    { lat: 43.6532, lng: -79.3822 },
                  ],
                }, {
                  id: 'legacy-no-geometry-rule',
                  geohash: 'dpz83c',
                  limitKmh: 80,
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
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    const encryptedCanonical = indexedDb.databases
      .get('drivesense_speed_knowledge')
      .stores.get('knowledge')
      .records.get(SPEED_KNOWLEDGE_STORAGE_KEY).value;
    expect(encryptedCanonical).toMatchObject({
      encrypted: true,
      version: 1,
      context: `indexeddb:drivesense_speed_knowledge/knowledge:${SPEED_KNOWLEDGE_STORAGE_KEY}`,
      payload: expect.objectContaining({
        corrections: expect.arrayContaining([
          expect.objectContaining({ id: 'already-migrated-rule' }),
        ]),
      }),
    });

    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      expect.objectContaining({
        encrypted: true,
        payload: expect.objectContaining({
        cells: {},
        corrections: [expect.objectContaining({
          id: 'already-migrated-rule',
          geohash: 'dpz83c',
          limitKmh: 50,
          source: 'user_confirmed_posted_sign',
          sectionPoints: [
            { lat: 43.6532, lng: -79.3842 },
            { lat: 43.6532, lng: -79.3822 },
          ],
        })],
        }),
      })
    );
  });

  it('mirrors only trusted score-eligible cells outside exclusions and privacy zones', async () => {
    isNativePlatform.mockReturnValue(true);
    privacyState.zones = [{ blockedGeohashes: ['dpz83j'] }];
    getJson.mockResolvedValue({
      cells: {
        dpz83d: {
          limitKmh: 40,
          source: 'trip_consensus',
          confidence: 0.55,
          tripCount: 3,
          evidenceCount: 3,
          tripEvidenceIds: ['trip-1', 'trip-2', 'trip-3'],
          lastUpdatedAt: '2099-01-01T00:00:00.000Z',
        },
        dpz83m: {
          limitKmh: 45,
          source: 'trip_consensus',
          confidence: 0.68,
          tripCount: 1,
          evidenceCount: 1,
          tripEvidenceIds: ['trip-only'],
          lastUpdatedAt: '2099-01-01T00:00:00.000Z',
        },
        dpz83e: { limitKmh: 50, source: 'trip_consensus', confidence: 0.54 },
        dpz83f: { limitKmh: 60, source: 'trip_consensus', confidence: 0.68, conflict: true },
        dpz83g: { limitKmh: 70, source: 'inferred', confidence: 0.80 },
        dpz83h: { limitKmh: 80, source: 'user_confirmed_posted_sign', confidence: 0.92 },
        dpz83j: { limitKmh: 90, source: 'user_confirmed_posted_sign', confidence: 0.92 },
        dpz83k: { limitKmh: 250, source: 'user_confirmed_posted_sign', confidence: 0.92 },
      },
      excludedSections: [{ id: 'excluded-cell', geohash: 'dpz83h' }],
      corrections: [],
    });

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      expect.objectContaining({
        encrypted: true,
        payload: expect.objectContaining({
        cells: {
          dpz83d: expect.objectContaining({
            limitKmh: 40,
            source: 'trip_consensus',
            confidence: 0.55,
            tripEvidenceIds: ['trip-1', 'trip-2', 'trip-3'],
          }),
        },
        }),
      })
    );
  });

  it('clears every native location record when privacy filtering cannot be trusted', async () => {
    isNativePlatform.mockReturnValue(true);
    privacyState.error = new Error('secure privacy storage unavailable');
    getJson.mockResolvedValue({
      cells: { dpz83d: { limitKmh: 40, source: 'trip_consensus', confidence: 0.68 } },
      excludedSections: [{ id: 'private-exclusion', geohash: 'dpz83d' }],
      corrections: [{ id: 'private-rule', geohash: 'dpz83d', limitKmh: 40 }],
      roadMemory: { candidates: [{ id: 'private-candidate', geohash: 'dpz83d', limitKmh: 40 }] },
    });

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      getNativeSpeedKnowledgeMirrorStatus,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await migrateSpeedKnowledgeToIndexedDb();

    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      expect.objectContaining({
        encrypted: true,
        payload: expect.objectContaining({
        cells: {},
        excludedSections: [],
        corrections: [],
        roadMemory: { version: 3, candidates: [] },
        }),
      })
    );
    expect(getNativeSpeedKnowledgeMirrorStatus()).toMatchObject({
      state: 'privacy_blocked',
      error: 'secure privacy storage unavailable',
    });
  });

  it('removes the prior native mirror before a replacement write can fail', async () => {
    isNativePlatform.mockReturnValue(true);
    getJson.mockResolvedValue({
      cells: {},
      corrections: [{
        id: 'replacement-rule',
        geohash: 'dpz83d',
        limitKmh: 40,
        sectionPoints: [
          { lat: 43.6530, lng: -79.3834 },
          { lat: 43.6534, lng: -79.3830 },
        ],
      }],
    });
    cryptoState.setEncryptedJson.mockRejectedValueOnce(new Error('Preferences write failed'));

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await expect(migrateSpeedKnowledgeToIndexedDb()).resolves.toBe(true);

    expect(setJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
    const markerCallIndex = setJson.mock.calls.findIndex(([key]) => (
      key === SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY
    ));
    expect(setJson.mock.invocationCallOrder[markerCallIndex]).toBeLessThan(
      cryptoState.removeEncryptedJson.mock.invocationCallOrder[0]
    );
    expect(cryptoState.removeEncryptedJson.mock.invocationCallOrder[0]).toBeLessThan(
      cryptoState.setEncryptedJson.mock.invocationCallOrder[0]
    );
    expect(removeJson).not.toHaveBeenCalledWith('speed_knowledge_v1');
  });

  it('keeps existing native and legacy data intact when the migration marker cannot be written', async () => {
    isNativePlatform.mockReturnValue(true);
    getJson.mockResolvedValue({ cells: {}, corrections: [] });
    setJson.mockImplementation(async (key) => {
      if (key === 'speed_knowledge_native_mirror_initialized_v1') {
        throw new Error('Preferences marker write failed');
      }
    });

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      getNativeSpeedKnowledgeMirrorStatus,
      migrateSpeedKnowledgeToIndexedDb,
    } = await import('@/lib/speedKnowledgeRepository');

    await expect(migrateSpeedKnowledgeToIndexedDb()).resolves.toBe(true);

    expect(setJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
    expect(removeJson).not.toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
    expect(removeJson).not.toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(getNativeSpeedKnowledgeMirrorStatus()).toMatchObject({
      state: 'error',
      error: 'Preferences marker write failed',
    });
    expect(logSystemFailure).toHaveBeenCalledWith(
      'speed_knowledge_native_mirror_marker',
      expect.objectContaining({ message: 'Preferences marker write failed' }),
      { key: SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY }
    );
  });

  it('reads valid canonical IndexedDB data when the native migration marker write fails', async () => {
    isNativePlatform.mockReturnValue(true);
    getJson.mockResolvedValue(null);
    setJson.mockImplementation(async (key) => {
      if (key === 'speed_knowledge_native_mirror_initialized_v1') {
        throw new Error('Preferences marker unavailable');
      }
    });
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
                schemaVersion: 2,
                knowledgeRevision: 7,
                knowledgeUpdatedAt: '2026-08-02T05:00:00.000Z',
                cells: {
                  dpz83b: { limitKmh: 50, source: 'user_confirmed_posted_sign' },
                },
                corrections: [{
                  id: 'canonical-rule',
                  geohash: 'dpz83b',
                  limitKmh: 50,
                  sectionPoints: [
                    { lat: 43.6530, lng: -79.3840 },
                    { lat: 43.6538, lng: -79.3830 },
                  ],
                }],
              },
            },
          ]]),
        },
      ]]),
    });
    vi.stubGlobal('indexedDB', indexedDb);

    const {
      SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      getNativeSpeedKnowledgeMirrorStatus,
      speedKnowledgeStore,
    } = await import('@/lib/speedKnowledgeRepository');

    await expect(speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY)).resolves.toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 7,
      cells: {
        dpz83b: { limitKmh: 50, source: 'user_confirmed_posted_sign' },
      },
      corrections: [expect.objectContaining({ id: 'canonical-rule', limitKmh: 50 })],
    });

    expect(setJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
    expect(removeJson).not.toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(getNativeSpeedKnowledgeMirrorStatus()).toMatchObject({
      state: 'error',
      error: 'Preferences marker unavailable',
    });
    expect(logSystemFailure).toHaveBeenCalledWith(
      'speed_knowledge_native_mirror_migration',
      expect.objectContaining({ message: 'Preferences marker unavailable' }),
      expect.objectContaining({ phase: 'existing_indexeddb' })
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

  it('encrypts fallback and write paths when IndexedDB is unavailable', async () => {
    isNativePlatform.mockReturnValue(false);
    vi.stubGlobal('indexedDB', undefined);
    const values = new Map();
    getJson.mockImplementation(async (key) => values.get(key) ?? null);
    setJson.mockImplementation(async (key, value) => values.set(key, structuredClone(value)));
    removeJson.mockImplementation(async (key) => values.delete(key));

    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      speedKnowledgeStore,
    } = await import('@/lib/speedKnowledgeRepository');
    await speedKnowledgeStore.set(SPEED_KNOWLEDGE_STORAGE_KEY, {
      cells: {},
      corrections: [{
        id: 'fallback-traced-rule',
        lat: 43.65,
        lng: -79.38,
        limitKmh: 50,
        sectionPoints: [
          { lat: 43.65, lng: -79.381 },
          { lat: 43.65, lng: -79.379 },
        ],
      }],
    });

    expect(values.get(SPEED_KNOWLEDGE_STORAGE_KEY)).toMatchObject({
      encrypted: true,
      version: 1,
      context: `storage:${SPEED_KNOWLEDGE_STORAGE_KEY}`,
    });
    await expect(speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY)).resolves.toMatchObject({
      corrections: [expect.objectContaining({ id: 'fallback-traced-rule' })],
    });
  });

  it('serializes concurrent updates without dropping either change and increments revisions', async () => {
    isNativePlatform.mockReturnValue(false);
    getJson.mockResolvedValue(null);

    const {
      SPEED_KNOWLEDGE_STORAGE_KEY,
      speedKnowledgeStore,
    } = await import('@/lib/speedKnowledgeRepository');

    await Promise.all([
      speedKnowledgeStore.update(SPEED_KNOWLEDGE_STORAGE_KEY, (current) => ({
        ...current,
        cells: {
          ...(current.cells || {}),
          first: { limitKmh: 40 },
        },
      })),
      speedKnowledgeStore.update(SPEED_KNOWLEDGE_STORAGE_KEY, (current) => ({
        ...current,
        cells: {
          ...(current.cells || {}),
          second: { limitKmh: 60 },
        },
      })),
    ]);

    await expect(speedKnowledgeStore.get(SPEED_KNOWLEDGE_STORAGE_KEY)).resolves.toMatchObject({
      schemaVersion: 2,
      knowledgeRevision: 2,
      knowledgeUpdatedAt: expect.any(String),
      cells: {
        first: { limitKmh: 40 },
        second: { limitKmh: 60 },
      },
    });
  });

  it('deletes indexed speed knowledge and its native mirror during data-rights erasure', async () => {
    const lockRequest = vi.fn(async (_name, _options, operation) => operation());
    vi.stubGlobal('navigator', { locks: { request: lockRequest } });
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
      SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY,
      SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      SPEED_KNOWLEDGE_STORAGE_KEY,
      eraseSpeedKnowledgeForDataRights,
    } = await import('@/lib/speedKnowledgeRepository');

    const result = await eraseSpeedKnowledgeForDataRights();

    expect(result).toMatchObject({
      indexedDbDeleted: true,
      fallbackKey: SPEED_KNOWLEDGE_STORAGE_KEY,
      fallbackRemoved: true,
      nativeMirrorKey: SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY,
      nativeMirrorRemoved: true,
    });
    expect(indexedDb.databases.has(SPEED_KNOWLEDGE_DB_NAME)).toBe(false);
    expect(setJson).toHaveBeenCalledWith(
      SPEED_KNOWLEDGE_STORAGE_KEY,
      expect.objectContaining({
        encrypted: true,
        payload: expect.objectContaining({ _secure_delete_tombstone: true }),
      })
    );
    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_STORAGE_KEY);
    expect(removeJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY);
    expect(setJson).toHaveBeenCalledWith(SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY, true);
    const markerCallIndex = setJson.mock.calls.findIndex(([key]) => (
      key === SPEED_KNOWLEDGE_NATIVE_MIRROR_INITIALIZED_KEY
    ));
    const nativeMirrorRemovalCallIndex = cryptoState.removeEncryptedJson.mock.calls.findIndex(([key]) => (
      key === SPEED_KNOWLEDGE_NATIVE_MIRROR_KEY
    ));
    expect(setJson.mock.invocationCallOrder[markerCallIndex]).toBeLessThan(
      cryptoState.removeEncryptedJson.mock.invocationCallOrder[nativeMirrorRemovalCallIndex]
    );
    expect(lockRequest).toHaveBeenCalledWith(
      'drivesense:speed_knowledge_v1',
      { mode: 'exclusive' },
      expect.any(Function)
    );
  });
});
