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
    nativePreferences.set.mockClear();
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
});
