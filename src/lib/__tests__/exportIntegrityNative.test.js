import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('export integrity native key protection', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/nativePlatform');
    vi.doUnmock('@/lib/secureBridge');
    vi.resetModules();
  });

  it('routes Android export signing key encryption through the secure bridge', async () => {
    const secureCall = vi.fn(async (pluginName, method, data) => {
      expect(pluginName).toBe('SecureBridge');
      expect(method).toBe('encryptSensitivePayload');
      expect(data).toMatchObject({ context: 'backup-export-signing-key:v1' });
      expect(typeof data.plaintext).toBe('string');
      return { ciphertext: 'secure-bridge-encrypted-signing-key' };
    });

    vi.doMock('@/lib/nativePlatform', () => ({
      isAndroid: () => true,
      isNativePlatform: () => false,
    }));
    vi.doMock('@/lib/secureBridge', () => ({ secureCall }));

    const {
      SIGNING_KEY_ALIAS,
      signExport,
    } = await import('@/lib/exportIntegrity');
    const { getJson } = await import('@/lib/mobileStorage');

    await expect(signExport({ app: 'Road Sage', version: 1 })).resolves.toMatchObject({
      signature: expect.any(String),
    });
    await expect(getJson(SIGNING_KEY_ALIAS, null)).resolves.toMatchObject({
      encrypted_key: 'secure-bridge-encrypted-signing-key',
      key_provider: 'android-keystore',
    });
    expect(secureCall).toHaveBeenCalledTimes(1);
  });

  it('does not expose plaintext payload crypto methods on the activity plugin', () => {
    const source = readFileSync(
      new URL('../../../android/app/src/main/java/com/drivesense/app/DriveSenseActivityRecognitionPlugin.java', import.meta.url),
      'utf8'
    );

    expect(source).not.toContain('public void encryptSensitivePayload(PluginCall call)');
    expect(source).not.toContain('public void decryptSensitivePayload(PluginCall call)');
  });
});
