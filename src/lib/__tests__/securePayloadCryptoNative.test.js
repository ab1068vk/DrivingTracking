import { afterEach, describe, expect, it, vi } from 'vitest';

describe('securePayloadCrypto native platform gate', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/nativePlatform');
    vi.resetModules();
  });

  it('fails closed on native platforms without a platform secure crypto bridge', async () => {
    vi.doMock('@/lib/nativePlatform', () => ({
      getNativePlatform: () => 'ios',
      isAndroid: () => false,
      isNativePlatform: () => true,
    }));

    const {
      decryptSensitiveValue,
      encryptSensitiveValue,
    } = await import('@/lib/securePayloadCrypto');

    await expect(encryptSensitiveValue({ lat: 43.65, lng: -79.38 }, 'trip:ios')).rejects.toThrow(
      'Native secure payload encryption is not implemented for ios'
    );
    await expect(decryptSensitiveValue({
      encrypted: true,
      version: 1,
      ciphertext: 'not-used',
    }, 'trip:ios')).rejects.toThrow(
      'Native secure payload encryption is not implemented for ios'
    );
  });
});
