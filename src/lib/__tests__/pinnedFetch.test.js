import { afterEach, describe, expect, it, vi } from 'vitest';

describe('pinnedFetch', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@capacitor/core');
    vi.unstubAllGlobals();
  });

  it('refuses GPS-bearing requests over cleartext HTTP', async () => {
    const { assertPinnedGpsEndpoint } = await import('@/lib/pinnedFetch');

    expect(() => assertPinnedGpsEndpoint('http://api.open-meteo.com/v1/forecast'))
      .toThrow('Refusing GPS-bearing request over http:');
  });

  it('blocks unpinned GPS hosts on native platforms', async () => {
    vi.doMock('@capacitor/core', () => ({
      Capacitor: { isNativePlatform: () => true },
    }));
    const { assertPinnedGpsEndpoint } = await import('@/lib/pinnedFetch');

    expect(() => assertPinnedGpsEndpoint('https://example.test/match/v1/driving/1,2;3,4'))
      .toThrow('No Android certificate pins configured for example.test');
  });

  it('allows pinned GPS hosts on native platforms', async () => {
    vi.doMock('@capacitor/core', () => ({
      Capacitor: { isNativePlatform: () => true },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    const { pinnedFetch } = await import('@/lib/pinnedFetch');

    await expect(pinnedFetch('https://api.open-meteo.com/v1/forecast')).resolves.toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith('https://api.open-meteo.com/v1/forecast', {});
  });
});
