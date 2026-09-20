import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeIndexedDb } from './helpers/fakeIndexedDb';

/**
 * DPD-011 — saved-speed and road-learning authority must follow the **authority**,
 * not the platform.
 *
 * P3.5 native authority is unreleased, so a shipping Android install keeps its
 * trips *and* its saved speeds in IndexedDB. The browser v1/v2 model is
 * therefore the correct owner there, and E4 is the correct migration.
 *
 * Four call sites gated that on `isNativePlatform()` / `isAndroid()` instead, so
 * on Android the browser v2 authority was unreachable by construction: E4 could
 * never run, the v2 authority row could never exist, and D4 road learning stayed
 * pinned at `CONVERSION_REQUIRED` forever. Measured on an A54 at the cc9b3c75
 * 128-trip checkpoint: E2 ran 8m38s and produced 128 CONVERSION_REQUIRED
 * subjects, **0** road windows and **0** learned speeds.
 *
 * These tests drive the real repository through the whole matrix and assert
 * observable outcomes — which authority is in force, whether E4 actually
 * converts, and whether road learning actually produces windows — rather than
 * mocking one boolean and asserting another.
 */

const state = vi.hoisted(() => ({ preferences: new Map(), secure: new Map(), platform: { native: false, android: false } }));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({ value: state.preferences.get(key) ?? null })),
    set: vi.fn(async ({ key, value }) => state.preferences.set(key, value)),
    remove: vi.fn(async ({ key }) => state.preferences.delete(key)),
  },
}));
// One mutable platform, so a single module graph can be re-imported per case.
vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: () => (state.platform.android ? 'android' : 'web'),
  isAndroid: () => state.platform.android,
  isNativePlatform: () => state.platform.native,
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

/** A v1 predecessor model, i.e. something for E4 to actually convert. */
const legacyModel = () => ({
  schemaVersion: 1, knowledgeRevision: 3, cells: {},
  corrections: [{ id: 'legacy-a', geohash: 'dpz800', limitKmh: 40, source: 'manual' }],
  excludedSections: [], roadMemory: { candidates: [] },
});

/**
 * Load the repository under a chosen platform + release-gate combination.
 * `P35_NATIVE_AUTHORITY_ENABLED` is captured at module scope, so the env has to
 * be stubbed before the module graph is rebuilt.
 */
const loadRepository = async ({ android, nativeAuthority }) => {
  state.platform.native = android;
  state.platform.android = android;
  vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', nativeAuthority ? 'true' : 'false');
  vi.resetModules();
  return import('@/lib/speedKnowledgeRepository');
};

const runMigrationToCompletion = async (repository) => {
  for (let turn = 0; turn < 64; turn += 1) {
    const step = await repository.stepP6BrowserSpeedMigration();
    if (step.done) return step;
  }
  throw new Error('E4 did not converge');
};

describe('DPD-011 saved-speed authority routes by authority, not platform', () => {
  beforeEach(() => {
    state.preferences.clear();
    state.secure.clear();
    state.platform.native = false;
    state.platform.android = false;
    vi.stubGlobal('indexedDB', new FakeIndexedDb());
    vi.stubGlobal('IDBKeyRange', keyRange);
    vi.stubGlobal('navigator', {
      storage: { estimate: vi.fn(async () => ({ quota: 2 * 1024 ** 3, usage: 0 })) },
      locks: { request: vi.fn(async (_name, _options, operation) => operation()) },
    });
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  /** Seed a v1 predecessor the way each platform actually stores it. */
  const seedPredecessor = (repository, { android }) => {
    const value = wrapper(legacyModel(), 'legacy-ciphertext');
    if (android) state.preferences.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, JSON.stringify(value));
    else state.secure.set(repository.SPEED_KNOWLEDGE_STORAGE_KEY, value);
  };

  it('web + browser authority: E4 converts and v2 takes the authority', async () => {
    const repository = await loadRepository({ android: false, nativeAuthority: false });
    seedPredecessor(repository, { android: false });

    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    await expect(repository.beginP6BrowserSpeedMigration())
      .resolves.toMatchObject({ state: 'CONVERSION_IN_PROGRESS' });
    await runMigrationToCompletion(repository);

    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 2, state: 'ACTIVE' });
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(true);
  });

  it('Android + shipping browser authority: E4 runs and v2 takes the authority', async () => {
    // The DPD-011 case. Before the fix `beginP6BrowserSpeedMigration` threw
    // E4_BROWSER_ONLY here and the authority could never leave v1.
    const repository = await loadRepository({ android: true, nativeAuthority: false });
    seedPredecessor(repository, { android: true });

    expect(await repository.isNativeSpeedAuthoritySelected()).toBe(false);
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);

    await expect(repository.beginP6BrowserSpeedMigration()).resolves.toMatchObject({
      state: 'CONVERSION_IN_PROGRESS',
    });
    await runMigrationToCompletion(repository);

    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 2, state: 'ACTIVE' });
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(true);
  });

  it('Android + native authority: browser stays v1, E4 is refused, release gate intact', async () => {
    const repository = await loadRepository({ android: true, nativeAuthority: true });
    seedPredecessor(repository, { android: true });

    expect(repository.isNativeSpeedAuthoritySelected()).toBe(true);
    // Native owns saved speeds, so the browser model is the predecessor and
    // must not convert itself underneath it.
    expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 1 });
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
    await expect(repository.beginP6BrowserSpeedMigration()).rejects.toThrow('E4_BROWSER_ONLY');
  });

  it('the native release gate alone decides, on identical platform input', async () => {
    // Same Android runtime, only the unreleased-authority flag differs, so the
    // difference cannot be attributed to anything but the authority.
    const shipping = await loadRepository({ android: true, nativeAuthority: false });
    expect(shipping.isNativeSpeedAuthoritySelected()).toBe(false);

    const withNative = await loadRepository({ android: true, nativeAuthority: true });
    expect(withNative.isNativeSpeedAuthoritySelected()).toBe(true);
  });

  it('web is never treated as native, whatever the gate says', async () => {
    const withNative = await loadRepository({ android: false, nativeAuthority: true });
    expect(withNative.isNativeSpeedAuthoritySelected()).toBe(false);
  });

  it('keeps v1 authority when there is no predecessor to convert', async () => {
    const repository = await loadRepository({ android: true, nativeAuthority: false });
    await expect(repository.beginP6BrowserSpeedMigration()).resolves.toMatchObject({
      state: 'NO_LEGACY_SOURCE', legacyAuthorityPreserved: true,
    });
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(false);
  });

  it('v1 remains the authority for every turn until the cutover commits', async () => {
    const repository = await loadRepository({ android: true, nativeAuthority: false });
    seedPredecessor(repository, { android: true });
    await repository.beginP6BrowserSpeedMigration();

    for (let turn = 0; turn < 64; turn += 1) {
      const step = await repository.stepP6BrowserSpeedMigration();
      if (step.done) break;
      // No half-converted state may present itself as v2.
      expect(await repository.readP6BrowserSpeedAuthority()).toMatchObject({ version: 1 });
    }
    expect(await repository.isP6BrowserSpeedV2Authority()).toBe(true);
  });
});
