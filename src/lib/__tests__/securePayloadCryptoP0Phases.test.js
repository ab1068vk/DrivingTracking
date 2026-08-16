import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** @type {Map<string, string>} */
let storage;

const loadWithProbe = async ({ android = true, secureCall } = {}) => {
  vi.resetModules();
  vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'true');
  vi.stubEnv('DEV', 'true');
  storage.set('roadsage_p0_arm', 'A');

  vi.doMock('@/lib/nativePlatform', () => ({
    getNativePlatform: () => (android ? 'android' : 'web'),
    isAndroid: () => android,
    isNativePlatform: () => android,
  }));
  if (secureCall) vi.doMock('@/lib/secureBridge', () => ({ secureCall }));

  const p0 = await import('@/lib/p0Probe');
  p0.initializeP0Probe({ buildHash: 'test' });
  const crypto = await import('@/lib/securePayloadCrypto');
  const schema = await import('@/lib/p0Schema');
  return { p0, crypto, schema };
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
});

afterEach(() => {
  vi.doUnmock('@/lib/nativePlatform');
  vi.doUnmock('@/lib/secureBridge');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const phaseNames = (trace, schema) => trace.phases.map((row) => schema.PHASE_IDS[row.phase]);

describe('logical payload phase timing', () => {
  it('records logical stringify and parse on the Android bridge path', async () => {
    const secureCall = vi.fn(async (_plugin, method) => {
      if (method === 'encryptSensitivePayload') return { ciphertext: 'AAAA'.repeat(10) };
      return { plaintext: JSON.stringify({ lat: 43.65, lng: -79.38 }) };
    });
    const { p0, crypto, schema } = await loadWithProbe({ android: true, secureCall });

    const encrypted = await crypto.encryptSensitiveValue({ lat: 43.65, lng: -79.38 }, 'trip:abc123');
    await crypto.decryptSensitiveValue(encrypted, 'trip:abc123');

    const trace = p0.exportP0Trace();
    const names = phaseNames(trace, schema);
    expect(names).toContain('logical_stringify');
    expect(names).toContain('logical_parse');

    // Both are synchronous renderer work and must be eligible for coverage.
    trace.phases
      .filter((row) => ['logical_stringify', 'logical_parse'].includes(schema.PHASE_IDS[row.phase]))
      .forEach((row) => expect(row.sync).toBe(1));
  });

  it('passes explicit parent metadata to secureCall and never the raw context', async () => {
    const secureCall = vi.fn(async (_plugin, method) => (
      method === 'encryptSensitivePayload'
        ? { ciphertext: 'ZZZZ' }
        : { plaintext: '{"ok":true}' }
    ));
    const { crypto } = await loadWithProbe({ android: true, secureCall });

    await crypto.encryptSensitiveValue({ ok: true }, 'trip-summary:trip_abc123');

    expect(secureCall).toHaveBeenCalledTimes(1);
    const [, , data, p0Meta] = secureCall.mock.calls[0];
    // The payload itself still carries the real context — that is the existing
    // crypto contract and must not change.
    expect(data.context).toBe('trip-summary:trip_abc123');
    // The P0 metadata carries only the derived enum and the parent id.
    expect(Object.keys(p0Meta).sort()).toEqual(['parentOpId', 'payloadKind']);
    expect(p0Meta.payloadKind).toBe('trip_summary');
    expect(typeof p0Meta.parentOpId).toBe('number');
    expect(JSON.stringify(p0Meta)).not.toContain('trip_abc123');
  });

  it('joins the logical span to its transport span via parent_op_id', async () => {
    let captured = null;
    const secureCall = vi.fn(async (_plugin, method, _data, p0Meta) => {
      captured = p0Meta;
      return method === 'encryptSensitivePayload' ? { ciphertext: 'Q' } : { plaintext: '{}' };
    });
    const { p0, crypto } = await loadWithProbe({ android: true, secureCall });

    await crypto.encryptSensitiveValue({ a: 1 }, 'trip:xyz');

    const trace = p0.exportP0Trace();
    const logicalSpan = trace.spans.at(-1);
    expect(captured.parentOpId).toBe(logicalSpan.call_id);
  });

  it('maps every payload kind without exporting the context', async () => {
    const secureCall = vi.fn(async () => ({ ciphertext: 'Q' }));
    const { p0, crypto, schema } = await loadWithProbe({ android: true, secureCall });

    const contexts = [
      ['trip-summary:t1', 'trip_summary'],
      ['trip:t1', 'trip_detail'],
      ['storage:drivesense_active_trip', 'active_trip'],
      ['storage:drivesense_speed_geometry_index_v1', 'speed_geometry'],
      ['storage:speed_knowledge_v1', 'speed_knowledge'],
      ['native:privacy_zones_v1', 'privacy'],
      ['storage:something_else', 'other'],
    ];
    for (const [context] of contexts) {
      await crypto.encryptSensitiveValue({ a: 1 }, context);
    }

    const trace = p0.exportP0Trace();
    const kinds = trace.spans.map((row) => schema.PAYLOAD_KINDS[row.payload_kind]);
    expect(kinds).toEqual(contexts.map(([, expected]) => expected));

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('drivesense_active_trip');
    expect(serialized).not.toContain('trip-summary');
    expect(serialized).not.toContain('privacy_zones_v1');
  });

  it('handles multibyte logical payloads without adding an encode', async () => {
    const encoderSpy = vi.spyOn(globalThis, 'TextEncoder');
    const secureCall = vi.fn(async () => ({ ciphertext: 'Q' }));
    const { p0, crypto } = await loadWithProbe({ android: true, secureCall });

    await crypto.encryptSensitiveValue({ note: '東京'.repeat(500) }, 'trip:multibyte');

    const span = p0.exportP0Trace().spans.at(-1);
    // On the Android path no JS-side encode happens, so the at-rest byte sizes
    // are unavailable and must export as `null` rather than a manufactured
    // count from an added traversal — or a `-1` that reads as a real number.
    expect(span.at_rest_plaintext_bytes).toBeNull();
    expect(span.at_rest_ciphertext_bytes).toBeNull();
    expect(span.at_rest_ciphertext_b64_chars).toBe(1);
    expect(encoderSpy).not.toHaveBeenCalled();
    encoderSpy.mockRestore();
  });

  it('records at-rest byte sizes on the web path where they are already free', async () => {
    const { p0, crypto } = await loadWithProbe({ android: false });

    const value = { note: 'hello world' };
    const encrypted = await crypto.encryptSensitiveValue(value, 'storage:drivesense_active_trip');
    await crypto.decryptSensitiveValue(encrypted, 'storage:drivesense_active_trip');

    const spans = p0.exportP0Trace().spans;
    const encryptSpan = spans[0];
    const expectedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    expect(encryptSpan.at_rest_plaintext_bytes).toBe(expectedBytes);
    expect(encryptSpan.at_rest_ciphertext_b64_chars).toBeGreaterThan(0);
    // The ciphertext ArrayBuffer is already in hand on this path, so its byte
    // length costs nothing extra and must be exported rather than left null.
    expect(encryptSpan.at_rest_ciphertext_bytes).toBe(expectedBytes + 16);
  });

  it('returns the IV encoded before the ciphertext, as the original did', async () => {
    const { crypto } = await loadWithProbe({ android: false });

    // Instrumentation may split expressions but never reorder observable work.
    // Both helpers are pure today; the order rule does not depend on that.
    const order = [];
    const realBtoa = globalThis.btoa;
    vi.stubGlobal('btoa', (input) => {
      order.push(input.length);
      return realBtoa(input);
    });

    await crypto.encryptSensitiveValue({ note: 'order' }, 'trip:order');

    // The 12-byte IV is encoded first; the longer ciphertext second.
    expect(order[0]).toBe(12);
    expect(order[1]).toBeGreaterThan(12);
  });

  it('closes the logical span as error when the underlying call fails', async () => {
    const secureCall = vi.fn(async () => { throw new Error('bridge unavailable'); });
    const { p0, crypto } = await loadWithProbe({ android: true, secureCall });

    await expect(crypto.encryptSensitiveValue({ a: 1 }, 'trip:fails')).rejects.toThrow('bridge unavailable');

    const trace = p0.exportP0Trace();
    const span = trace.spans.at(-1);
    // `success` here would have hidden the error path in exactly the
    // measurements meant to explain slow and failing paths.
    expect(p0.P0_OUTCOMES[span.outcome]).toBe('error');
  });

  it('keeps the stringify interval when stringify itself throws', async () => {
    const { p0, crypto, schema } = await loadWithProbe({ android: true, secureCall: vi.fn() });

    const cyclic = {};
    cyclic.self = cyclic;
    await expect(crypto.encryptSensitiveValue(cyclic, 'trip:cyclic')).rejects.toThrow();

    const trace = p0.exportP0Trace();
    // The failed stringify consumed real synchronous time; dropping the row
    // would make the error path measure as free.
    expect(phaseNames(trace, schema)).toContain('logical_stringify');
    expect(p0.P0_OUTCOMES[trace.spans.at(-1).outcome]).toBe('error');
  });

  it('keeps the parse interval when parse throws on the bridge path', async () => {
    const secureCall = vi.fn(async () => ({ plaintext: '{not valid json' }));
    const { p0, crypto, schema } = await loadWithProbe({ android: true, secureCall });

    const payload = { encrypted: true, version: 1, ciphertext: 'QQ==', key_version: 1 };
    await expect(crypto.decryptSensitiveValue(payload, 'trip:badjson')).rejects.toThrow();

    const trace = p0.exportP0Trace();
    expect(phaseNames(trace, schema)).toContain('logical_parse');
    expect(p0.P0_OUTCOMES[trace.spans.at(-1).outcome]).toBe('error');
  });

  it('still returns the correct value when the probe is off', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_SHOW_DEBUG_ROUTES', 'false');
    vi.stubEnv('DEV', '');
    vi.doMock('@/lib/nativePlatform', () => ({
      getNativePlatform: () => 'web',
      isAndroid: () => false,
      isNativePlatform: () => false,
    }));
    const crypto = await import('@/lib/securePayloadCrypto');

    const value = { lat: 43.65, lng: -79.38, note: '東京' };
    const encrypted = await crypto.encryptSensitiveValue(value, 'trip:probe-off');
    await expect(crypto.decryptSensitiveValue(encrypted, 'trip:probe-off')).resolves.toEqual(value);
  });
});
