import { describe, expect, it, vi } from 'vitest';

const bridgePlugin = vi.hoisted(() => ({
  initSession: vi.fn(),
  setPreference: vi.fn(async () => ({ stored: true })),
  ensureSensitivePayloadKey: vi.fn(async () => ({ ensured: true })),
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

  it('serializes concurrent native calls so monotonic nonces cannot arrive out of order', async () => {
    const baselineCalls = bridgePlugin.setPreference.mock.calls.length;
    let releaseFirst = () => {};
    bridgePlugin.setPreference
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ stored: true, order: 1 });
      }))
      .mockResolvedValueOnce({ stored: true, order: 2 });

    const { secureSetPreference } = await import('@/lib/secureBridge');
    const first = secureSetPreference({ key: 'first', value: '1', context: 'test' });
    const second = secureSetPreference({ key: 'second', value: '2', context: 'test' });

    await vi.waitFor(() => expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(baselineCalls + 1));
    // Only the first call in this test may be in flight.
    expect(bridgePlugin.setPreference.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({ nonce: expect.any(Number) }));
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { stored: true, order: 1 },
      { stored: true, order: 2 },
    ]);
    expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(baselineCalls + 2);
  });

  it('admits bulk producers FIFO and lets an already-queued single run before the next batch', async () => {
    let releaseFirst = () => {};
    const baselineBulk = bridgePlugin.setPreference.mock.calls.length;
    const baselineSingle = bridgePlugin.ensureSensitivePayloadKey.mock.calls.length;
    bridgePlugin.setPreference
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ stored: true, batch: 1 });
      }))
      .mockResolvedValueOnce({ stored: true, batch: 2 })
      .mockResolvedValueOnce({ stored: true, batch: 3 });

    const { secureCall, withSecureBulkAdmission, __secureBulkStateForTests } = await import('@/lib/secureBridge');
    const first = withSecureBulkAdmission(() => secureCall('SecureBridge', 'setPreference', { batch: 1 }));
    await vi.waitFor(() => expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(baselineBulk + 1));
    const second = withSecureBulkAdmission(() => secureCall('SecureBridge', 'setPreference', { batch: 2 }));
    const third = withSecureBulkAdmission(() => secureCall('SecureBridge', 'setPreference', { batch: 3 }));
    const single = secureCall('SecureBridge', 'ensureSensitivePayloadKey', { keyVersion: 1 });

    expect(__secureBulkStateForTests()).toEqual({ active: 1, prepared: 1 });
    expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(baselineBulk + 1);
    releaseFirst();
    await expect(Promise.all([first, second, third, single])).resolves.toEqual([
      { stored: true, batch: 1 },
      { stored: true, batch: 2 },
      { stored: true, batch: 3 },
      { ensured: true },
    ]);
    expect(bridgePlugin.ensureSensitivePayloadKey).toHaveBeenCalledTimes(baselineSingle + 1);
    expect(bridgePlugin.setPreference.mock.invocationCallOrder.at(-1))
      .toBeGreaterThan(bridgePlugin.ensureSensitivePayloadKey.mock.invocationCallOrder.at(-1));
    const bulkOrders = bridgePlugin.setPreference.mock.invocationCallOrder.slice(-3);
    expect(bulkOrders[0]).toBeLessThan(bulkOrders[1]);
    expect(bulkOrders[1]).toBeLessThan(bulkOrders[2]);
    expect(__secureBulkStateForTests()).toEqual({ active: 0, prepared: 0 });
  });

  it('round-trips every byte, padding variants, and a cap-sized buffer through the base64 codec', async () => {
    const { __secureBridgeCodecForTests } = await import('@/lib/secureBridge');
    const samples = [
      Uint8Array.of(0),
      Uint8Array.of(0, 255),
      Uint8Array.of(0, 127, 255),
      Uint8Array.from({ length: 256 }, (_, index) => index),
      Uint8Array.from({ length: 524_304 }, (_, index) => index % 256),
    ];

    samples.forEach((sample) => {
      const encoded = __secureBridgeCodecForTests.bytesToBase64(sample);
      expect(__secureBridgeCodecForTests.base64ToBytes(encoded)).toEqual(sample);
    });
  });
});

