import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SECURE_METHODS } from '@/lib/p0Schema';

const bridgePlugin = vi.hoisted(() => ({
  initSession: vi.fn(),
  setPreference: vi.fn(async () => ({ stored: true })),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => bridgePlugin),
}));

/** @type {Map<string, string>} */
let storage;

const loadBridge = async () => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  vi.stubEnv('DEV', 'true');
  storage.set('roadsage_p0_arm', 'A');
  const p0 = await import('@/lib/p0Probe');
  p0.initializeP0Probe({ buildHash: 'test' });
  const bridge = await import('@/lib/secureBridge');
  return { bridge, p0 };
};

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  });
  vi.stubGlobal('PerformanceObserver', undefined);
  bridgePlugin.initSession.mockImplementation(async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const nativePublicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
    return {
      version: 1,
      sessionId: 'queue-session',
      nativePublicKey: btoa(String.fromCharCode(...new Uint8Array(nativePublicKey))),
    };
  });
  bridgePlugin.setPreference.mockImplementation(async () => ({ stored: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * Queue depths of the `secureCall` spans only.
 *
 * The ECDH handshake now carries its own instrumented span (so native has a
 * real inbound call id to gate on, rather than emitting an orphan block), and
 * that span does not go through the secure-call queue.
 */
const spanDepths = (trace) => trace.spans
  .filter((row) => SECURE_METHODS[row.method] !== 'initSession')
  .map((row) => row.queue_depth_at_enqueue);

const queuedSpans = (trace) => trace.spans
  .filter((row) => SECURE_METHODS[row.method] !== 'initSession');

describe('secure call queue contract', () => {
  it('returns to depth zero after an immediately settling call', async () => {
    const { bridge, p0 } = await loadBridge();
    expect(bridge.__pendingSecureCallsForTests()).toBe(0);

    await bridge.secureCall('SecureBridge', 'setPreference', { a: 1 });
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    expect(spanDepths(p0.exportP0Trace())).toEqual([0]);
  });

  it('returns to depth zero after a rejected call', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference.mockRejectedValueOnce(new Error('native failed'));

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 })).rejects.toThrow('native failed');
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    const trace = p0.exportP0Trace();
    // The failed call is still recorded, with its depth snapshot intact.
    expect(spanDepths(trace)).toEqual([0]);
    expect(queuedSpans(trace)[0].outcome).toBe(1);
  });

  it('snapshots the depth already pending, excluding the new call', async () => {
    const { bridge, p0 } = await loadBridge();
    let releaseFirst = () => {};
    bridgePlugin.setPreference
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ stored: true, order: 1 });
      }))
      .mockResolvedValueOnce({ stored: true, order: 2 })
      .mockResolvedValueOnce({ stored: true, order: 3 });

    const first = bridge.secureCall('SecureBridge', 'setPreference', { n: 1 });
    const second = bridge.secureCall('SecureBridge', 'setPreference', { n: 2 });
    const third = bridge.secureCall('SecureBridge', 'setPreference', { n: 3 });

    expect(bridge.__pendingSecureCallsForTests()).toBe(3);
    // The queue is serial and session setup is async, so wait until the first
    // call is genuinely in flight before releasing it.
    await vi.waitFor(() => expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(1));
    releaseFirst();
    await Promise.all([first, second, third]);
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    // Depth excludes the enqueuing call itself: 0, 1, 2 rather than 1, 2, 3.
    expect(spanDepths(p0.exportP0Trace())).toEqual([0, 1, 2]);
  });

  it('preserves FIFO order and never decrements twice', async () => {
    const { bridge } = await loadBridge();
    const order = [];
    bridgePlugin.setPreference.mockImplementation(async (envelope) => {
      // Decrypting is unnecessary; the call sequence is what matters here.
      order.push(envelope.nonce);
      return { stored: true };
    });

    const calls = [1, 2, 3, 4, 5].map((n) => bridge.secureCall('SecureBridge', 'setPreference', { n }));
    await Promise.all(calls);
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
    // A double decrement would drive the counter negative.
    expect(bridge.__pendingSecureCallsForTests()).toBe(0);
  });

  it('keeps the counter correct when a rejection sits between two successes', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference
      .mockResolvedValueOnce({ stored: true })
      .mockRejectedValueOnce(new Error('middle failed'))
      .mockResolvedValueOnce({ stored: true });

    const first = bridge.secureCall('SecureBridge', 'setPreference', { n: 1 });
    const second = bridge.secureCall('SecureBridge', 'setPreference', { n: 2 });
    const third = bridge.secureCall('SecureBridge', 'setPreference', { n: 3 });

    await expect(first).resolves.toEqual({ stored: true });
    await expect(second).rejects.toThrow('middle failed');
    await expect(third).resolves.toEqual({ stored: true });
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    const trace = p0.exportP0Trace();
    expect(queuedSpans(trace)).toHaveLength(3);
    expect(queuedSpans(trace).map((row) => row.outcome)).toEqual([0, 1, 0]);
  });

  it('releases the slot before a caller continuation can enqueue the next call', async () => {
    const { bridge, p0 } = await loadBridge();

    // The defect this covers: decrementing on a detached second-stage `.finally`
    // lets a caller continuation run first and see an already-settled
    // predecessor still counted in the depth.
    await bridge.secureCall('SecureBridge', 'setPreference', { n: 1 });
    const second = bridge.secureCall('SecureBridge', 'setPreference', { n: 2 });
    // Snapshot taken synchronously in the continuation of the first call.
    expect(bridge.__pendingSecureCallsForTests()).toBe(1);
    await second;
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    // The finished predecessor must not appear in the successor's depth.
    expect(spanDepths(p0.exportP0Trace())).toEqual([0, 0]);
  });

  it('leaves the queue counter untouched when the probe is off', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'false');
    vi.stubEnv('DEV', '');
    const bridge = await import('@/lib/secureBridge');

    let release = () => {};
    bridgePlugin.setPreference.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ stored: true });
    }));

    const call = bridge.secureCall('SecureBridge', 'setPreference', { n: 1 });
    await vi.waitFor(() => expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(1));
    // Arm D must not pay for the probe's bookkeeping: no metadata object, no
    // counter, no extra promise link. The A/D CDP comparison exists to measure
    // that cost and cannot if the "off" arm carries part of it.
    expect(bridge.__pendingSecureCallsForTests()).toBe(0);
    release();
    await expect(call).resolves.toEqual({ stored: true });
    expect(bridge.__pendingSecureCallsForTests()).toBe(0);
  });

  it('keeps completed and failed intervals when the native call rejects', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference.mockRejectedValueOnce(new Error('native failed'));

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 })).rejects.toThrow('native failed');

    const trace = p0.exportP0Trace();
    const { PHASE_IDS } = await import('@/lib/p0Schema');
    const names = trace.phases.map((row) => PHASE_IDS[row.phase]);

    // Everything that completed before the rejection survives...
    ['req_json', 'req_encode', 'wc_encrypt_invoke', 'wc_encrypt_await',
      'req_b64_iv', 'req_b64_data', 'native_invoke'].forEach((phase) => {
      expect(names, `${phase} was lost on the error path`).toContain(phase);
    });
    // ...and so does the interval spent waiting on the call that failed.
    expect(names).toContain('native_await');
    expect(queuedSpans(trace)[0].req_plaintext_bytes).toBeGreaterThan(0);
    expect(queuedSpans(trace)[0].outcome).toBe(1);
  });

  it('records queue wait as latency that never claims CPU ownership', async () => {
    const { bridge, p0 } = await loadBridge();
    let releaseFirst = () => {};
    bridgePlugin.setPreference
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ stored: true });
      }))
      .mockResolvedValueOnce({ stored: true });

    const first = bridge.secureCall('SecureBridge', 'setPreference', { n: 1 });
    const second = bridge.secureCall('SecureBridge', 'setPreference', { n: 2 });
    await vi.waitFor(() => expect(bridgePlugin.setPreference).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(bridge.__pendingSecureCallsForTests()).toBe(0));

    const trace = p0.exportP0Trace();
    const { PHASE_IDS } = await import('@/lib/p0Schema');
    const queueWaits = trace.phases.filter((row) => PHASE_IDS[row.phase] === 'queue_wait');

    expect(queueWaits).toHaveLength(2);
    expect(queueWaits.every((row) => row.sync === 0)).toBe(true);
    // The second call genuinely waited behind the first.
    expect(queueWaits[1].dur_us).toBeGreaterThan(queueWaits[0].dur_us);
  });
});
