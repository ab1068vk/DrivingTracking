import { describe, expect, it, vi } from 'vitest';

const bridgePlugin = vi.hoisted(() => ({
  initSession: vi.fn(),
  setPreference: vi.fn(async () => ({ stored: true })),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => bridgePlugin),
}));

describe('secureBridge', () => {
  it('encrypts sensitive preference writes before invoking the native plugin', async () => {
    bridgePlugin.initSession.mockImplementationOnce(async () => {
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
      );
      const nativePublicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      return {
        version: 1,
        sessionId: 'test-session',
        nativePublicKey: btoa(String.fromCharCode(...new Uint8Array(nativePublicKey))),
      };
    });

    const { secureSetPreference } = await import('@/lib/secureBridge');
    const result = await secureSetPreference({
      key: 'privacy_zones_v1',
      value: '[{"label":"Home","privacy_cell_hashes":["pzc_secret"]}]',
      context: 'native:privacy_zones_v1',
      encryptAtRest: true,
    });

    expect(result).toEqual({ stored: true });
    expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(1);

    const payload = bridgePlugin.setPreference.mock.calls[0][0];
    expect(payload).toMatchObject({
      encrypted: true,
      version: 1,
      sessionId: 'test-session',
    });
    expect(Number.isFinite(payload.nonce)).toBe(true);
    expect(payload.iv).toEqual(expect.any(String));
    expect(payload.data).toEqual(expect.any(String));

    const serializedPayload = JSON.stringify(payload);
    expect(serializedPayload).not.toContain('Home');
    expect(serializedPayload).not.toContain('pzc_secret');
    expect(serializedPayload).not.toContain('privacy_zones_v1');
    expect(serializedPayload).not.toContain('native:privacy_zones_v1');
  });
});

