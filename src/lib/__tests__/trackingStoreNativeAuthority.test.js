import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativePreferences = vi.hoisted(() => ({
  values: new Map(),
  get: vi.fn(async ({ key }) => ({
    value: nativePreferences.values.get(key) ?? null,
  })),
  set: vi.fn(async ({ key, value }) => {
    nativePreferences.values.set(key, String(value));
  }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'android'),
  },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: nativePreferences.get,
    set: nativePreferences.set,
  },
}));

const makeStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    removeItem: vi.fn((key) => values.delete(key)),
  };
};

describe('native settings authority', () => {
  beforeEach(() => {
    nativePreferences.values.clear();
    nativePreferences.get.mockClear();
    nativePreferences.set.mockReset();
    nativePreferences.set.mockImplementation(async ({ key, value }) => {
      nativePreferences.values.set(key, String(value));
    });
    vi.stubGlobal('window', {
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('CustomEvent', class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('does not overwrite a Quick Settings off choice with stale WebView settings on app open', async () => {
    const key = 'drivesense_settings';
    const staleWebViewSettings = {
      settings_defaults_version: 19,
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: false,
    };
    const quickTileSettings = {
      ...staleWebViewSettings,
      tracking_paused: true,
    };
    const storage = makeStorage({
      [key]: JSON.stringify(staleWebViewSettings),
    });
    nativePreferences.values.set(key, JSON.stringify(quickTileSettings));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify({
      ...localSettings.get(),
      tracking_paused: true,
    }));

    expect(localSettings.get()).toMatchObject({
      tracking_mode: 'background_auto',
      tracking_paused: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nativePreferences.set).not.toHaveBeenCalled();
    expect(JSON.parse(nativePreferences.values.get(key))).toMatchObject({
      tracking_mode: 'background_auto',
      tracking_paused: true,
    });

    const hydrated = await localSettings.hydrateFromNative();

    expect(hydrated).toMatchObject({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: true,
    });
    expect(JSON.parse(storage.values.get(key))).toMatchObject({
      tracking_mode: 'background_auto',
      tracking_paused: true,
    });
  });

  it('still sends explicit in-app setting changes to Android preferences', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 19,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();
    nativePreferences.set.mockClear();

    localSettings.update({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));

    expect(JSON.parse(nativePreferences.set.mock.calls[0][0].value)).toMatchObject({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: false,
    });
  });

  it('restores Quick Tile authority after the latest in-app write is confirmed', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();

    localSettings.update({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    nativePreferences.set.mockClear();
    nativePreferences.values.set(key, JSON.stringify({
      ...localSettings.get(),
      tracking_paused: true,
    }));

    const hydrated = await localSettings.hydrateFromNative();

    expect(hydrated).toMatchObject({
      tracking_mode: 'background_auto',
      tracking_paused: true,
    });
    expect(nativePreferences.set).not.toHaveBeenCalled();
  });

  it('does not let a resume hydrate roll back a newer in-app setting while its native mirror is pending', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();
    nativePreferences.set.mockClear();

    let released = false;
    let releaseWrite;
    nativePreferences.set.mockImplementationOnce(({ key: writeKey, value }) => new Promise((resolve) => {
      releaseWrite = () => {
        if (released) return;
        released = true;
        nativePreferences.values.set(writeKey, String(value));
        resolve();
      };
    }));

    try {
      localSettings.update({
        tracking_mode: 'background_auto',
        auto_tracking_enabled: true,
        background_tracking_enabled: true,
      });
      await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));

      const hydratedDuringPendingWrite = await localSettings.hydrateFromNative();
      expect(hydratedDuringPendingWrite).toMatchObject({
        tracking_mode: 'background_auto',
        auto_tracking_enabled: true,
        background_tracking_enabled: true,
      });
    } finally {
      releaseWrite?.();
    }
  });

  it('coalesces concurrent hydrations and rejects their stale read after a local write', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    const staleNativeValue = JSON.stringify(localSettings.get());
    nativePreferences.values.set(key, staleNativeValue);

    let releaseRead;
    nativePreferences.get.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRead = () => resolve({ value: staleNativeValue });
    }));

    const firstHydrate = localSettings.hydrateFromNative();
    const secondHydrate = localSettings.hydrateFromNative();
    await vi.waitFor(() => expect(nativePreferences.get).toHaveBeenCalledTimes(1));

    localSettings.update({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    releaseRead();

    const [first, second] = await Promise.all([firstHydrate, secondHydrate]);
    expect(first).toMatchObject({ tracking_mode: 'background_auto' });
    expect(second).toMatchObject({ tracking_mode: 'background_auto' });
    expect(nativePreferences.get).toHaveBeenCalledTimes(1);
  });

  it('serializes rapid in-app writes so an older native write cannot land last', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();
    nativePreferences.set.mockClear();

    let released = false;
    let releaseFirstWrite;
    nativePreferences.set.mockImplementationOnce(({ key: writeKey, value }) => new Promise((resolve) => {
      releaseFirstWrite = () => {
        if (released) return;
        released = true;
        nativePreferences.values.set(writeKey, String(value));
        resolve();
      };
    }));

    try {
      localSettings.update({
        tracking_mode: 'background_auto',
        auto_tracking_enabled: true,
        background_tracking_enabled: true,
      });
      await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));

      localSettings.update({ tracking_paused: true });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(nativePreferences.set).toHaveBeenCalledTimes(1);
      releaseFirstWrite();
      await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(2));
      expect(JSON.parse(nativePreferences.values.get(key))).toMatchObject({
        tracking_mode: 'background_auto',
        tracking_paused: true,
      });
    } finally {
      releaseFirstWrite?.();
    }
  });

  it('does not dedupe a retry after the previous native write failed', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();
    nativePreferences.set.mockClear();
    nativePreferences.set.mockRejectedValueOnce(new Error('native write failed'));

    localSettings.update({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    nativePreferences.set.mockClear();
    localSettings.set(localSettings.get());

    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    expect(JSON.parse(nativePreferences.values.get(key))).toMatchObject({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
  });

  it('keeps a failed newer local write authoritative over stale native hydration and retries it', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'manual',
      auto_tracking_enabled: false,
      background_tracking_enabled: false,
      tracking_paused: false,
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    nativePreferences.values.set(key, JSON.stringify(initial));
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();
    nativePreferences.set.mockClear();
    nativePreferences.set.mockRejectedValueOnce(new Error('native write failed'));

    localSettings.update({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    nativePreferences.set.mockClear();

    const hydrated = await localSettings.hydrateFromNative();

    expect(hydrated).toMatchObject({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    expect(JSON.parse(nativePreferences.values.get(key))).toMatchObject({
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
    });
  });

  it('lets native authority win after a structurally identical local update needs no write', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: false,
      privacy_zones: [],
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();

    localSettings.update({ tracking_paused: true });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    nativePreferences.set.mockClear();

    localSettings.update({ privacy_zones: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativePreferences.set).not.toHaveBeenCalled();

    nativePreferences.values.set(key, JSON.stringify({
      ...JSON.parse(storage.values.get(key)),
      tracking_paused: false,
    }));

    const hydrated = await localSettings.hydrateFromNative();
    expect(hydrated.tracking_paused).toBe(false);
  });

  it('lets native authority win after a failed B write converges back to confirmed A', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: false,
      privacy_zones: [],
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();

    localSettings.update({ tracking_paused: true });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const confirmedA = nativePreferences.values.get(key);
    nativePreferences.set.mockClear();

    let releaseFailure;
    nativePreferences.set.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      releaseFailure = () => reject(new Error('native write failed'));
    }));

    localSettings.update({ tracking_paused: false });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    localSettings.update({ tracking_paused: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseFailure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativePreferences.values.get(key)).toBe(confirmedA);

    nativePreferences.values.set(key, JSON.stringify({
      ...JSON.parse(confirmedA),
      tracking_paused: false,
    }));

    const hydrated = await localSettings.hydrateFromNative();
    expect(hydrated.tracking_paused).toBe(false);
  });

  it('does not invalidate an in-flight native read for a structurally identical local update', async () => {
    const key = 'drivesense_settings';
    const initial = {
      settings_defaults_version: 24,
      tracking_mode: 'background_auto',
      auto_tracking_enabled: true,
      background_tracking_enabled: true,
      tracking_paused: false,
      privacy_zones: [],
    };
    const storage = makeStorage({ [key]: JSON.stringify(initial) });
    vi.stubGlobal('localStorage', storage);

    const { localSettings } = await import('@/lib/trackingStore');
    nativePreferences.values.set(key, JSON.stringify(localSettings.get()));
    await localSettings.hydrateFromNative();

    localSettings.update({ tracking_paused: true });
    await vi.waitFor(() => expect(nativePreferences.set).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    nativePreferences.set.mockClear();

    const nativeValue = JSON.stringify({
      ...JSON.parse(storage.values.get(key)),
      tracking_paused: false,
    });
    let releaseRead;
    nativePreferences.get.mockClear();
    nativePreferences.get.mockImplementationOnce(() => new Promise((resolve) => {
      releaseRead = () => resolve({ value: nativeValue });
    }));

    const hydration = localSettings.hydrateFromNative();
    await vi.waitFor(() => expect(releaseRead).toEqual(expect.any(Function)));
    localSettings.update({ privacy_zones: [] });
    releaseRead();

    expect((await hydration).tracking_paused).toBe(false);
  });
});
