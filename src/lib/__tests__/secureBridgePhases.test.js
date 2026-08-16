import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgePlugin = vi.hoisted(() => ({
  initSession: vi.fn(),
  setPreference: vi.fn(async () => ({ stored: true })),
  decryptSensitivePayload: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => bridgePlugin),
}));

/** @type {Map<string, string>} */
let storage;

const installSession = () => {
  bridgePlugin.initSession.mockImplementation(async () => {
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
};

/**
 * Load the bridge with the probe either on (debug build, arm A) or off
 * (release build). Both share one module graph reset so the comparison is clean.
 */
const loadBridge = async ({ probe = true } = {}) => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', probe ? 'true' : 'false');
  vi.stubEnv('DEV', probe ? 'true' : '');
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
  installSession();
  bridgePlugin.setPreference.mockImplementation(async () => ({ stored: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  // `clearAllMocks` does not undo `spyOn`, so a WebCrypto spy from one test
  // would otherwise still be installed for the next one.
  vi.restoreAllMocks();
});

const PAYLOAD_FIXTURES = [
  ['empty object', {}],
  ['small', { key: 'a', value: '1' }],
  ['nested', { a: { b: { c: { d: [1, 2, 3, { e: 'f' }] } } } }],
  ['multibyte CJK', { value: '東京都渋谷区'.repeat(50) }],
  ['emoji', { value: '🚗💨🛣️'.repeat(50) }],
  ['lone surrogate', { value: `broken\uD800tail` }],
  ['1 MB', { value: 'x'.repeat(1024 * 1024) }],
];

describe('secure bridge transport equivalence with the probe on and off', () => {
  /**
   * Each module load derives a fresh ephemeral ECDH session key, so ciphertexts
   * are not comparable across loads by construction. What must be proven is that
   * instrumentation did not change *what gets encrypted*: the exact plaintext
   * bytes, the exact AAD, the IV, and the nonce. Given identical inputs and key
   * material the ciphertext follows.
   */
  const captureEncryptInputs = async ({ probe, payload }) => {
    const fixedIv = new Uint8Array(12).fill(7);
    const realGetRandomValues = crypto.getRandomValues.bind(crypto);
    const randomSpy = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      if (array instanceof Uint8Array && array.length === 12) {
        array.set(fixedIv);
        return array;
      }
      return realGetRandomValues(array);
    });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const captured = [];
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const encryptSpy = vi.spyOn(crypto.subtle, 'encrypt')
      .mockImplementation(async (algorithm, key, data) => {
        captured.push({
          iv: new Uint8Array(algorithm.iv),
          aad: new Uint8Array(algorithm.additionalData),
          plaintext: new Uint8Array(data),
        });
        return realEncrypt(algorithm, key, data);
      });

    const { bridge } = await loadBridge({ probe });
    await bridge.secureCall('SecureBridge', 'setPreference', payload);
    const envelope = bridgePlugin.setPreference.mock.calls.at(-1)[0];

    randomSpy.mockRestore();
    nowSpy.mockRestore();
    encryptSpy.mockRestore();
    return { inputs: captured.at(-1), envelope };
  };

  const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

  it.each(PAYLOAD_FIXTURES)('encrypts byte-identical input with the probe on and off for %s', async (_label, payload) => {
    const withProbe = await captureEncryptInputs({ probe: true, payload });
    const withoutProbe = await captureEncryptInputs({ probe: false, payload });

    // Compare with a boolean so a 1 MB mismatch cannot dump a megabyte diff.
    expect(sameBytes(withProbe.inputs.plaintext, withoutProbe.inputs.plaintext)).toBe(true);
    expect(sameBytes(withProbe.inputs.aad, withoutProbe.inputs.aad)).toBe(true);
    expect(sameBytes(withProbe.inputs.iv, withoutProbe.inputs.iv)).toBe(true);
    expect(withProbe.inputs.plaintext.byteLength).toBe(withoutProbe.inputs.plaintext.byteLength);

    // Non-crypto envelope fields are unchanged too.
    expect(withProbe.envelope.encrypted).toBe(withoutProbe.envelope.encrypted);
    expect(withProbe.envelope.version).toBe(withoutProbe.envelope.version);
    expect(withProbe.envelope.iv).toBe(withoutProbe.envelope.iv);
    expect(withProbe.envelope.nonce).toBe(withoutProbe.envelope.nonce);

    // The only difference is the outer diagnostic block, which exists solely
    // when the probe is on and carries nothing but a call id and send time.
    expect(withoutProbe.envelope._p0).toBeUndefined();
    expect(Object.keys(withProbe.envelope._p0)).toEqual(['call_id', 'send_wall_ms']);
  });

  it('round-trips a real encrypted response through the split decrypt path', async () => {
    // A genuine ECDH peer: it derives the same session key the bridge does, so
    // this exercises the decrypt path's AAD, nonce and base64 handling for real
    // rather than through a mock.
    const BRIDGE_CONTEXT = 'drivesense-secure-bridge-v1';
    const b64ToBytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));
    let peerKey = null;
    let peerSessionId = '';

    bridgePlugin.initSession.mockImplementation(async ({ clientPublicKey }) => {
      peerSessionId = 'echo-session';
      const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const clientKey = await crypto.subtle.importKey(
        'spki',
        b64ToBytes(clientPublicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      const shared = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'ECDH', public: clientKey },
        keyPair.privateKey,
        256
      ));
      const context = new TextEncoder().encode(`${BRIDGE_CONTEXT}:${peerSessionId}`);
      const combined = new Uint8Array(shared.length + context.length);
      combined.set(shared, 0);
      combined.set(context, shared.length);
      const digest = await crypto.subtle.digest('SHA-256', combined);
      peerKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
      const nativePublicKey = await crypto.subtle.exportKey('spki', keyPair.publicKey);
      return { version: 1, sessionId: peerSessionId, nativePublicKey: bytesToB64(new Uint8Array(nativePublicKey)) };
    });

    const secret = { trip_id: 'trip_abc123', total: 42 };
    bridgePlugin.setPreference.mockImplementation(async (envelope) => {
      // Verify the request decrypts under the shared key with the expected AAD.
      const requestAad = new TextEncoder().encode(
        `${BRIDGE_CONTEXT}|${envelope.sessionId}|SecureBridge|setPreference|${envelope.nonce}`
      );
      const requestPlain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: b64ToBytes(envelope.iv), additionalData: requestAad },
        peerKey,
        b64ToBytes(envelope.data)
      );
      expect(JSON.parse(new TextDecoder().decode(requestPlain))).toEqual({ ping: true });

      const responseNonce = Date.now() + 1;
      const responseIv = crypto.getRandomValues(new Uint8Array(12));
      const responseAad = new TextEncoder().encode(
        `${BRIDGE_CONTEXT}|${envelope.sessionId}|SecureBridge|setPreference:result|${responseNonce}`
      );
      const responseCipher = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: responseIv, additionalData: responseAad },
        peerKey,
        new TextEncoder().encode(JSON.stringify(secret))
      );
      return {
        encrypted: true,
        version: 1,
        sessionId: envelope.sessionId,
        iv: bytesToB64(responseIv),
        data: bytesToB64(new Uint8Array(responseCipher)),
        nonce: responseNonce,
        _p0: { native_entry_wall_ms: 1, response_ready_wall_ms: 2, native_total_internal_us: 900 },
      };
    });

    const { bridge, p0 } = await loadBridge({ probe: true });
    const result = await bridge.secureCall('SecureBridge', 'setPreference', { ping: true });

    expect(result).toEqual(secret);
    const trace = p0.exportP0Trace();
    const span = trace.spans.at(-1);
    expect(span.res_plaintext_bytes).toBe(new TextEncoder().encode(JSON.stringify(secret)).byteLength);
    expect(span.res_ciphertext_bytes).toBe(span.res_plaintext_bytes + 16);
    // The decrypted payload contained a trip id; none of it may reach the trace.
    expect(JSON.stringify(trace)).not.toContain('trip_abc123');
    expect(trace.native_blocks.at(-1).native_total_internal_us).toBe(900);
  });
});

describe('secure bridge phase recording', () => {
  it('records ordered, non-overlapping phases with invoke separated from await', async () => {
    const { bridge, p0 } = await loadBridge({ probe: true });
    await bridge.secureCall('SecureBridge', 'setPreference', { key: 'a', value: 'b' });

    const trace = p0.exportP0Trace();
    const { PHASE_IDS } = await import('@/lib/p0Schema');
    const phases = trace.phases.map((row) => ({
      id: PHASE_IDS[row.phase],
      start: row.rel_start_us,
      end: row.rel_start_us + row.dur_us,
      sync: row.sync,
    }));

    const byId = Object.fromEntries(phases.map((phase) => [phase.id, phase]));

    // Invoke and await are separate intervals, and only invoke owns CPU.
    expect(byId.wc_encrypt_invoke).toBeDefined();
    expect(byId.wc_encrypt_await).toBeDefined();
    expect(byId.native_invoke).toBeDefined();
    expect(byId.native_await).toBeDefined();
    expect(byId.wc_encrypt_invoke.sync).toBe(1);
    expect(byId.wc_encrypt_await.sync).toBe(0);
    expect(byId.native_invoke.sync).toBe(1);
    expect(byId.native_await.sync).toBe(0);
    expect(byId.queue_wait.sync).toBe(0);

    // Request phases run in source order and no interval runs backwards.
    expect(byId.req_json.end).toBeLessThanOrEqual(byId.req_encode.start + 1e-6);
    expect(byId.req_encode.end).toBeLessThanOrEqual(byId.wc_encrypt_invoke.start + 1e-6);
    phases.forEach((phase) => {
      expect(phase.end, `${phase.id} ran backwards`).toBeGreaterThanOrEqual(phase.start);
    });
  });

  it('records byte-correct transport counts distinct from character counts', async () => {
    const { bridge, p0 } = await loadBridge({ probe: true });
    // Multibyte content: UTF-8 byte length must exceed JS string length.
    const payload = { value: '東'.repeat(100) };
    await bridge.secureCall('SecureBridge', 'setPreference', payload);

    const span = p0.exportP0Trace().spans.at(-1);
    const json = JSON.stringify(payload);
    const utf8Bytes = new TextEncoder().encode(json).byteLength;

    expect(span.req_plaintext_bytes).toBe(utf8Bytes);
    expect(span.req_plaintext_bytes).toBeGreaterThan(json.length);
    // Ciphertext carries the 16-byte GCM tag on top of the plaintext.
    expect(span.req_ciphertext_bytes).toBe(utf8Bytes + 16);
    // Base64 character count is tracked separately from any byte count.
    expect(span.req_b64_chars).toBeGreaterThan(span.req_ciphertext_bytes);
  });

  it('keeps a partial span when the call rejects mid-phase', async () => {
    const { bridge, p0 } = await loadBridge({ probe: true });
    bridgePlugin.setPreference.mockRejectedValueOnce(new Error('native exploded'));

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 })).rejects.toThrow('native exploded');
    await vi.waitFor(() => {
      expect(p0.__p0RingStateForTests().spans.count).toBeGreaterThan(0);
    });

    const span = p0.exportP0Trace().spans.at(-1);
    expect(span.outcome).toBe(1); // error
    // Phases recorded before the failure are retained.
    expect(span.req_plaintext_bytes).toBeGreaterThan(0);
  });
});

describe('outer diagnostic block handling', () => {
  it('strips _p0 from a caller-visible plaintext result', async () => {
    const { bridge } = await loadBridge({ probe: true });
    bridgePlugin.setPreference.mockResolvedValueOnce({
      stored: true,
      _p0: { native_entry_wall_ms: 1, response_ready_wall_ms: 2 },
    });

    const result = await bridge.secureCall('SecureBridge', 'setPreference', { a: 1 });
    expect(result).toEqual({ stored: true });
    expect('_p0' in result).toBe(false);
  });

  it('strips _p0 even when the probe is off', async () => {
    const { bridge } = await loadBridge({ probe: false });
    bridgePlugin.setPreference.mockResolvedValueOnce({ stored: true, _p0: { x: 1 } });

    const result = await bridge.secureCall('SecureBridge', 'setPreference', { a: 1 });
    expect('_p0' in result).toBe(false);
  });

  it('cannot be broken by hostile or non-numeric native diagnostics', async () => {
    const { bridge, p0 } = await loadBridge({ probe: true });
    bridgePlugin.setPreference.mockResolvedValueOnce({
      stored: true,
      _p0: {
        native_entry_wall_ms: { valueOf() { throw new Error('hostile'); } },
        method_work_us: '<script>alert(1)</script>',
        attacker_field: 'trip_abc123',
      },
    });

    const result = await bridge.secureCall('SecureBridge', 'setPreference', { a: 1 });
    expect(result).toEqual({ stored: true });

    const serialized = JSON.stringify(p0.exportP0Trace());
    expect(serialized).not.toContain('trip_abc123');
    expect(serialized).not.toContain('<script>');
  });

  it('survives a non-configurable _p0 without leaking it', async () => {
    const { bridge } = await loadBridge({ probe: true });
    const hostile = { stored: true };
    Object.defineProperty(hostile, '_p0', { value: { x: 1 }, configurable: false, enumerable: true });
    bridgePlugin.setPreference.mockResolvedValueOnce(hostile);

    const result = await bridge.secureCall('SecureBridge', 'setPreference', { a: 1 });
    expect('_p0' in result).toBe(false);
    expect(result).toEqual({ stored: true });
  });
});

/**
 * Codex's remaining C3 finding: phase rows were committed only after a later
 * operation returned, so a *synchronous* throw erased both the intervals that
 * had already completed and the failed partial interval. A rejected promise was
 * already covered; a synchronous throw was not.
 */
describe('synchronous throws preserve completed and partial intervals', () => {
  const phaseNames = async (p0) => {
    const { PHASE_IDS, SECURE_METHODS } = await import('@/lib/p0Schema');
    const trace = p0.exportP0Trace();
    const queued = trace.spans.filter((row) => SECURE_METHODS[row.method] !== 'initSession');
    const callIds = new Set(queued.map((row) => row.call_id));
    return trace.phases
      .filter((row) => callIds.has(row.call_id))
      .map((row) => PHASE_IDS[row.phase]);
  };

  it('keeps req_json when JSON.stringify throws', async () => {
    const { bridge, p0 } = await loadBridge();
    const cyclic = {};
    cyclic.self = cyclic;

    await expect(bridge.secureCall('SecureBridge', 'setPreference', cyclic)).rejects.toThrow();

    // The failed stringify is the whole measurement here; losing it would make
    // an expensive failure look free.
    expect(await phaseNames(p0)).toContain('req_json');
  });

  it('keeps earlier intervals when subtle.encrypt throws synchronously', async () => {
    const { bridge, p0 } = await loadBridge();
    // The ECDH handshake uses generateKey/exportKey/importKey/deriveBits/digest,
    // never `encrypt`, so failing `encrypt` targets the request precisely.
    vi.spyOn(globalThis.crypto.subtle, 'encrypt').mockImplementation(() => {
      throw new TypeError('synchronous encrypt failure');
    });

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 }))
      .rejects.toThrow('synchronous encrypt failure');

    const names = await phaseNames(p0);
    expect(names).toContain('req_json');
    expect(names).toContain('req_encode');
    // ...and the invocation's own partial interval.
    expect(names).toContain('wc_encrypt_invoke');
  });

  it('keeps request intervals when the native invocation throws synchronously', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference.mockImplementation(() => {
      throw new TypeError('synchronous native failure');
    });

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 }))
      .rejects.toThrow('synchronous native failure');

    const names = await phaseNames(p0);
    expect(names).toEqual(expect.arrayContaining([
      'req_json', 'req_encode', 'wc_encrypt_invoke', 'wc_encrypt_await', 'req_b64_iv', 'req_b64_data',
    ]));
    // A plugin method can throw before returning a promise; the serialization
    // it did first is still real work.
    expect(names).toContain('native_invoke');
  });

  it('keeps intervals when a response base64 conversion throws synchronously', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference.mockImplementation(async () => ({
      encrypted: true,
      version: 1,
      sessionId: 'test-session',
      // `atob` throws on invalid base64 — the response IV decode fails.
      iv: '!!!not base64!!!',
      data: 'AAAA',
      nonce: Date.now(),
    }));

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 })).rejects.toThrow();

    const names = await phaseNames(p0);
    // Everything up to and including the failing conversion's partial interval.
    expect(names).toContain('native_await');
    expect(names).toContain('res_b64_iv');
  });

  it('keeps response intervals when subtle.decrypt throws synchronously', async () => {
    const { bridge, p0 } = await loadBridge();
    bridgePlugin.setPreference.mockImplementation(async () => ({
      encrypted: true,
      version: 1,
      sessionId: 'test-session',
      iv: 'AAAAAAAAAAAAAAAA',
      data: 'AAAAAAAA',
      nonce: Date.now(),
    }));
    vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockImplementation(() => {
      throw new TypeError('synchronous decrypt failure');
    });

    await expect(bridge.secureCall('SecureBridge', 'setPreference', { a: 1 }))
      .rejects.toThrow('synchronous decrypt failure');

    const names = await phaseNames(p0);
    expect(names).toContain('res_b64_iv');
    expect(names).toContain('res_b64_data');
    expect(names).toContain('wc_decrypt_invoke');
  });
});
