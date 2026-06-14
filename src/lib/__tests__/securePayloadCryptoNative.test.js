import { afterEach, describe, expect, it, vi } from 'vitest';

describe('securePayloadCrypto native platform gate', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/nativePlatform');
    vi.doUnmock('@/lib/secureBridge');
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

  it('routes Android payload encryption and decryption through the secure bridge', async () => {
    const secureCall = vi.fn(async (pluginName, method, data) => {
      expect(pluginName).toBe('SecureBridge');
      if (method === 'encryptSensitivePayload') {
        expect(data).toMatchObject({ context: 'trip:android', keyVersion: 1 });
        return { ciphertext: 'android-keystore-ciphertext' };
      }
      expect(method).toBe('decryptSensitivePayload');
      expect(data).toEqual({
        ciphertext: 'android-keystore-ciphertext',
        context: 'trip:android',
        keyVersion: 1,
      });
      return { plaintext: JSON.stringify({ lat: 43.65, lng: -79.38 }) };
    });

    vi.doMock('@/lib/nativePlatform', () => ({
      getNativePlatform: () => 'android',
      isAndroid: () => true,
      isNativePlatform: () => true,
    }));
    vi.doMock('@/lib/secureBridge', () => ({ secureCall }));

    const {
      decryptSensitiveValue,
      encryptSensitiveValue,
    } = await import('@/lib/securePayloadCrypto');

    const encrypted = await encryptSensitiveValue({ lat: 43.65, lng: -79.38 }, 'trip:android');

    expect(encrypted).toMatchObject({
      encrypted: true,
      key_version: 1,
      key_provider: 'android-keystore',
      ciphertext: 'android-keystore-ciphertext',
    });
    await expect(decryptSensitiveValue(encrypted, 'trip:android')).resolves.toEqual({
      lat: 43.65,
      lng: -79.38,
    });
    expect(secureCall).toHaveBeenCalledTimes(2);
  });
});
