/**
 * AUD-004 round 3 — the erasure fence must survive overlapping owners.
 *
 * Round 2 raised a single boolean before the first destructive step. Two overlapping
 * erasures both raised it, and whichever finished first lowered it — while the other was
 * still inside its own removal-to-proof window. A settings writer could then walk straight
 * into a live erasure and republish what was being removed.
 *
 * A boolean cannot express "two owners". The fence stays raised until the LAST owner
 * leaves, and mispaired exits must be visible rather than silently releasing someone
 * else's ownership.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ android: true }));
const nativePreferences = vi.hoisted(() => ({
  values: new Map(),
  get: vi.fn(async ({ key }) => ({ value: nativePreferences.values.get(key) ?? null })),
  set: vi.fn(async ({ key, value }) => { nativePreferences.values.set(key, String(value)); }),
  remove: vi.fn(async ({ key }) => { nativePreferences.values.delete(key); }),
  keys: vi.fn(async () => ({ keys: [...nativePreferences.values.keys()] })),
}));

vi.mock('@/lib/nativePlatform', async (importActual) => ({
  ...(await importActual()),
  isAndroid: () => runtime.android,
  isNativePlatform: () => runtime.android,
  getNativePlatform: () => 'android',
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
  registerPlugin: vi.fn(() => ({})),
}));
vi.mock('@capacitor/preferences', () => ({ Preferences: nativePreferences }));

const storageDouble = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() { return values.size; },
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AUD-004 round 3 — overlapping erasure ownership', () => {
  beforeEach(() => {
    runtime.android = true;
    nativePreferences.values.clear();
    nativePreferences.set.mockReset();
    nativePreferences.set.mockImplementation(async ({ key, value }) => {
      nativePreferences.values.set(key, String(value));
    });
    vi.stubGlobal('localStorage', storageDouble({
      drivesense_settings: JSON.stringify({ tracking_paused: false }),
    }));
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('stays raised until the last of two overlapping owners exits', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();

    expect(store.endSettingsErasureFence(a)).toBe(true);
    expect(store.isSettingsErasureFenceRaised()).toBe(true);

    expect(store.endSettingsErasureFence(b)).toBe(true);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('keeps the fence raised when the FIRST owner throws and the second continues', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();

    try {
      throw new Error('erasure A failed');
    } catch {
      store.endSettingsErasureFence(a);
    }

    expect(store.isSettingsErasureFenceRaised()).toBe(true);
    store.endSettingsErasureFence(b);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('keeps the fence raised when the SECOND owner throws and the first continues', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();

    store.endSettingsErasureFence(b);
    expect(store.isSettingsErasureFenceRaised()).toBe(true);
    store.endSettingsErasureFence(a);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('ignores a double end of the same token', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();

    expect(store.endSettingsErasureFence(a)).toBe(true);
    // The second release of A must not consume B's ownership.
    expect(store.endSettingsErasureFence(a)).toBe(false);
    expect(store.isSettingsErasureFenceRaised()).toBe(true);

    store.endSettingsErasureFence(b);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('ignores a stale token from a previous erasure', async () => {
    const store = await import('@/lib/trackingStore');
    const stale = store.beginSettingsErasureFence();
    store.endSettingsErasureFence(stale);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);

    const current = store.beginSettingsErasureFence();
    expect(store.endSettingsErasureFence(stale)).toBe(false);
    expect(store.isSettingsErasureFenceRaised()).toBe(true);

    store.endSettingsErasureFence(current);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('is a no-op when no owner is outstanding', async () => {
    const store = await import('@/lib/trackingStore');
    expect(store.endSettingsErasureFence()).toBe(false);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);

    const token = store.beginSettingsErasureFence();
    store.endSettingsErasureFence(token);
    expect(store.endSettingsErasureFence()).toBe(false);
    expect(store.isSettingsErasureFenceRaised()).toBe(false);
  });

  it('blocks a native settings write while any owner still holds the fence', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();
    store.endSettingsErasureFence(a);

    nativePreferences.values.clear();
    store.localSettings.update({ tracking_paused: true });
    await flush();
    await flush();

    // B is still erasing: nothing may be published natively.
    expect(nativePreferences.values.has('drivesense_settings')).toBe(false);

    store.endSettingsErasureFence(b);
  });

  it('lets settings writes through once the last owner exits', async () => {
    const store = await import('@/lib/trackingStore');
    const a = store.beginSettingsErasureFence();
    const b = store.beginSettingsErasureFence();
    store.endSettingsErasureFence(a);
    store.endSettingsErasureFence(b);

    store.localSettings.update({ tracking_paused: true });
    await flush();
    await flush();

    expect(nativePreferences.values.has('drivesense_settings')).toBe(true);
  });

  it('still self-removes an old native mirror write after erasure', async () => {
    const store = await import('@/lib/trackingStore');
    const settingsKey = 'drivesense_settings';
    nativePreferences.values.set(settingsKey, '{}');

    let releaseWrite = () => {};
    let signalEntered = () => {};
    const entered = new Promise((resolve) => { signalEntered = resolve; });
    nativePreferences.set.mockImplementationOnce(({ key, value }) => new Promise((resolve) => {
      signalEntered();
      releaseWrite = () => { nativePreferences.values.set(key, String(value)); resolve(); };
    }));

    store.localSettings.update({ tracking_paused: true });
    await entered;

    nativePreferences.values.delete(settingsKey);
    globalThis.localStorage.removeItem(settingsKey);
    releaseWrite();
    await flush();
    await flush();

    expect(nativePreferences.values.has(settingsKey)).toBe(false);
  });
});
