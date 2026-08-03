import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNative: true,
  platform: 'android',
  openAppLocationSettings: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.isNative,
    getPlatform: () => mocks.platform,
  },
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: {
    openAppLocationSettings: mocks.openAppLocationSettings,
  },
}));

describe('openNativeSettings', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isNative = true;
    mocks.platform = 'android';
    mocks.openAppLocationSettings.mockClear();
  });

  it('opens this app Android settings through the implemented native bridge', async () => {
    const { openNativeSettings } = await import('@/lib/nativePlatform');

    await expect(openNativeSettings()).resolves.toBe(true);
    expect(mocks.openAppLocationSettings).toHaveBeenCalledOnce();
  });

  it('does nothing outside Android', async () => {
    mocks.isNative = false;
    mocks.platform = 'web';
    const { openNativeSettings } = await import('@/lib/nativePlatform');

    await expect(openNativeSettings()).resolves.toBe(false);
    expect(mocks.openAppLocationSettings).not.toHaveBeenCalled();
  });
});
