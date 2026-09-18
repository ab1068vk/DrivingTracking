import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  nextSpan: 1,
  spans: [],
  secureCall: vi.fn(),
  yieldTurn: vi.fn(async () => {}),
  recordPhase: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  getNativePlatform: () => 'android',
  isAndroid: () => true,
  isNativePlatform: () => true,
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async () => null),
  removeJson: vi.fn(async () => {}),
  setJson: vi.fn(async () => {}),
}));

vi.mock('@/lib/secureBridge', () => ({
  secureCall: harness.secureCall,
  withSecureBulkAdmission: (task) => task(),
  yieldSecureBulkTurn: harness.yieldTurn,
}));

vi.mock('@/lib/p0Probe', () => ({
  openP0Span: (kind) => {
    const span = { kind, call_id: harness.nextSpan++ };
    harness.spans.push(span);
    return span;
  },
  closeP0Span: (span, outcome) => { span.outcome = outcome; },
  recordP0Phase: harness.recordPhase,
  tagP0PayloadKind: (span, payloadKind) => { span.payload_kind = payloadKind; },
}));

const {
  MAX_SECURE_BATCH_BRIDGE_BASE64_CHARS,
  MAX_SECURE_BATCH_BRIDGE_CIPHERTEXT_BYTES,
  MAX_SECURE_BATCH_LOGICAL_BYTES,
  MAX_SECURE_BATCH_METHOD_JSON_BYTES,
  MAX_SECURE_BATCH_STRUCTURAL_BYTES,
  decryptSensitiveValues,
  encryptSensitiveValues,
  secureDecryptBatchPrefixLength,
} = await import('@/lib/securePayloadCrypto');

const utf8Bytes = (value) => new TextEncoder().encode(value).byteLength;

const encryptedPayload = (plaintext, keyVersion = 1) => {
  const byteLength = utf8Bytes(plaintext) + 29;
  const bytes = new Uint8Array(byteLength);
  return {
    encrypted: true,
    version: 1,
    key_version: keyVersion,
    key_provider: 'android-keystore',
    ciphertext: btoa(String.fromCharCode(...bytes)),
  };
};

beforeEach(() => {
  harness.nextSpan = 1;
  harness.spans.length = 0;
  harness.secureCall.mockReset();
  harness.yieldTurn.mockClear();
  harness.recordPhase.mockClear();
  harness.secureCall.mockImplementation(async (_plugin, method, request) => {
    if (method === 'encryptSensitivePayload') {
      if (!request.items) return { ciphertext: 'AA==', keyVersion: request.keyVersion };
      return {
        batchVersion: 1,
        results: request.items.map((item) => ({
          ordinal: item.ordinal,
          ok: true,
          ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          keyVersion: item.keyVersion,
        })),
      };
    }
    throw new Error('Unexpected secure method.');
  });
});

describe('bounded secure payload batches', () => {
  it('pins the conjunctive transport and explicitly-held structural budget', () => {
    expect(MAX_SECURE_BATCH_BRIDGE_CIPHERTEXT_BYTES).toBe(MAX_SECURE_BATCH_METHOD_JSON_BYTES + 16);
    expect(MAX_SECURE_BATCH_BRIDGE_BASE64_CHARS).toBe(699_072);
    const conservativeExplicitBuffers =
      (2 * MAX_SECURE_BATCH_METHOD_JSON_BYTES) +
      MAX_SECURE_BATCH_METHOD_JSON_BYTES +
      MAX_SECURE_BATCH_BRIDGE_CIPHERTEXT_BYTES +
      MAX_SECURE_BATCH_BRIDGE_BASE64_CHARS +
      (2 * MAX_SECURE_BATCH_METHOD_JSON_BYTES) +
      MAX_SECURE_BATCH_BRIDGE_CIPHERTEXT_BYTES +
      MAX_SECURE_BATCH_BRIDGE_BASE64_CHARS +
      MAX_SECURE_BATCH_LOGICAL_BYTES;
    expect(conservativeExplicitBuffers).toBeLessThanOrEqual(MAX_SECURE_BATCH_STRUCTURAL_BYTES);
  });

  it.each([
    [50, 7],
    [128, 16],
    [500, 63],
    [2_000, 250],
    [5_000, 625],
  ])('uses ceil(N / 8) crossings for %i uniform records', async (count, crossings) => {
    const entries = Array.from({ length: count }, (_, index) => ({
      value: { id: index },
      context: `trip-summary:${index}`,
    }));

    const encrypted = await encryptSensitiveValues(entries, { keyVersion: 1 });

    expect(encrypted).toHaveLength(count);
    expect(harness.secureCall).toHaveBeenCalledTimes(crossings);
    expect(harness.secureCall.mock.calls.every((call) => call[2].items.length <= 8)).toBe(true);
    expect(harness.spans).toHaveLength(crossings);
    expect(harness.spans.every((span) => span.payload_kind === 'trip_summary')).toBe(true);
    harness.secureCall.mock.calls.forEach((call, index) => {
      expect(call[3]).toEqual({
        parentOpId: harness.spans[index].call_id,
        payloadKind: 'trip_summary',
      });
    });
  });

  it('uses the actual byte charge for the illustrative five-record 5,000-item case', async () => {
    let crossings = 0;
    harness.secureCall.mockImplementation(async (_plugin, _method, request) => {
      crossings += 1;
      const response = {
        batchVersion: 1,
        results: request.items.map((item) => ({
          ordinal: item.ordinal,
          ok: true,
          ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          keyVersion: item.keyVersion,
        })),
      };
      // Do not let the spy retain ~220 MiB of bounded request fixtures.
      harness.secureCall.mockClear();
      return response;
    });
    const sharedValue = { blob: 'x'.repeat(44_000) };
    const entries = Array.from({ length: 5_000 }, (_, index) => ({
      value: sharedValue,
      context: `trip-summary:${index}`,
    }));

    await expect(encryptSensitiveValues(entries, { keyVersion: 1 })).resolves.toHaveLength(5_000);
    expect(crossings).toBe(1_000);
  }, 30_000);

  it('closes batches at payload-kind transitions without reordering inputs', async () => {
    await encryptSensitiveValues([
      { value: { id: 'trip-1' }, context: 'trip:1' },
      { value: { id: 'trip-2' }, context: 'trip:2' },
      { value: { id: 'summary-1' }, context: 'trip-summary:1' },
      { value: { id: 'trip-3' }, context: 'trip:3' },
    ], { keyVersion: 1 });

    expect(harness.secureCall).toHaveBeenCalledTimes(3);
    expect(harness.secureCall.mock.calls.map((call) => call[3].payloadKind)).toEqual([
      'trip_detail',
      'trip_summary',
      'trip_detail',
    ]);
    expect(harness.secureCall.mock.calls.map((call) => call[2].items.map((item) => JSON.parse(item.plaintext).id))).toEqual([
      ['trip-1', 'trip-2'],
      ['summary-1'],
      ['trip-3'],
    ]);
  });

  it('preserves an explicitly empty AAD context and rejects non-string contexts', async () => {
    await encryptSensitiveValues([{ value: { id: 1 }, context: '' }], { keyVersion: 1 });
    expect(harness.secureCall.mock.calls[0][2].items[0].context).toBe('');
    await expect(encryptSensitiveValues([
      { value: { id: 2 }, context: null },
    ], { keyVersion: 1 })).rejects.toThrow('Secure batch context is invalid.');
  });

  it.each([
    ['quotes', '"'.repeat(40_000)],
    ['backslashes', '\\'.repeat(40_000)],
    ['CJK', '東京都'.repeat(20_000)],
    ['emoji', '🚗'.repeat(20_000)],
    ['controls', '\u0000\n\r\t'.repeat(20_000)],
  ])('accounts compact JSON and wrapper bytes for %s-saturated values', async (_label, value) => {
    await encryptSensitiveValues([
      { value: { value }, context: 'trip:1' },
      { value: { value: 'tail' }, context: 'trip:2' },
    ], { keyVersion: 1 });

    harness.secureCall.mock.calls.forEach(([, , request]) => {
      if (request.items) {
        expect(utf8Bytes(JSON.stringify(request))).toBeLessThanOrEqual(MAX_SECURE_BATCH_METHOD_JSON_BYTES);
        expect(request.items.reduce((sum, item) => sum + utf8Bytes(item.plaintext), 0))
          .toBeLessThanOrEqual(MAX_SECURE_BATCH_LOGICAL_BYTES);
      }
    });
  });

  it('isolates an oversized compatible value and overlong context on single-record calls', async () => {
    await encryptSensitiveValues([
      { value: { value: 'x'.repeat(MAX_SECURE_BATCH_LOGICAL_BYTES + 1) }, context: 'trip:oversized' },
      { value: { id: 'context' }, context: `trip:${'x'.repeat(600)}` },
      { value: { id: 'normal' }, context: 'trip:normal' },
    ], { keyVersion: 1 });

    expect(harness.secureCall).toHaveBeenCalledTimes(3);
    expect(harness.secureCall.mock.calls[0][2].items).toBeUndefined();
    expect(harness.secureCall.mock.calls[1][2].items).toBeUndefined();
    expect(harness.secureCall.mock.calls[2][2].items).toHaveLength(1);
  });

  it('rejects malformed batch ordinals and exposes no successful subset', async () => {
    harness.secureCall.mockResolvedValueOnce({
      batchVersion: 1,
      results: [
        { ordinal: 1, ok: true, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyVersion: 1 },
        { ordinal: 0, ok: true, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyVersion: 1 },
      ],
    });
    await expect(encryptSensitiveValues([
      { value: { id: 1 }, context: 'trip:1' },
      { value: { id: 2 }, context: 'trip:2' },
    ], { keyVersion: 1 })).rejects.toThrow('Secure batch response is invalid.');
  });

  it.each([
    [{ ordinal: 0, ok: true, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyVersion: 2 }],
    [{ ordinal: 0, ok: true, ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', keyVersion: 1, plaintext: '{}' }],
    [{ ordinal: 0, ok: false, errorCode: 'NATIVE_SECRET_DETAIL' }],
    [{ ordinal: 0, ok: false, errorCode: 'CRYPTO_FAILED', plaintext: 'secret' }],
  ])('rejects operation-inappropriate or unallowlisted result shapes', async (results) => {
    harness.secureCall.mockResolvedValueOnce({ batchVersion: 1, results });
    await expect(encryptSensitiveValues([
      { value: { id: 1 }, context: 'trip:1' },
    ], { keyVersion: 1 })).rejects.toThrow('Secure batch response is invalid.');
  });

  it('fails the complete logical array when any decrypt item fails', async () => {
    const plaintexts = [JSON.stringify({ id: 1 }), JSON.stringify({ id: 2 })];
    const entries = plaintexts.map((plaintext, index) => ({
      payload: encryptedPayload(plaintext),
      context: `trip:${index}`,
    }));
    harness.secureCall.mockResolvedValueOnce({
      batchVersion: 1,
      results: [
        { ordinal: 0, ok: true, plaintext: plaintexts[0] },
        { ordinal: 1, ok: false, errorCode: 'AUTHENTICATION_FAILED' },
      ],
    });

    await expect(decryptSensitiveValues(entries)).rejects.toMatchObject({
      name: 'SecureBatchItemError',
      message: 'One or more secure batch items failed.',
      failures: [{ ordinal: 1, errorCode: 'AUTHENTICATION_FAILED' }],
    });
  });

  it('selects a single physical decrypt prefix for rotation plaintext residency', () => {
    const small = encryptedPayload(JSON.stringify({ value: 'x'.repeat(80_000) }));
    const entries = Array.from({ length: 8 }, (_, index) => ({
      payload: small,
      context: `trip:${index}`,
    }));
    const count = secureDecryptBatchPrefixLength(entries);
    expect(count).toBe(3);
    expect(count * (utf8Bytes(JSON.stringify({ value: 'x'.repeat(80_000) })))).toBeLessThanOrEqual(
      MAX_SECURE_BATCH_LOGICAL_BYTES
    );
  });

  it('does not submit after cancellation before the first batch', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(encryptSensitiveValues([
      { value: { id: 1 }, context: 'trip:1' },
    ], { keyVersion: 1, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.secureCall).not.toHaveBeenCalled();
  });

  it('does not pre-enqueue a second physical batch while the first native call is pending', async () => {
    let release = () => {};
    harness.secureCall
      .mockImplementationOnce((_plugin, _method, request) => new Promise((resolve) => {
        release = () => resolve({
          batchVersion: 1,
          results: request.items.map((item) => ({
            ordinal: item.ordinal,
            ok: true,
            ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            keyVersion: 1,
          })),
        });
      }));
    const work = encryptSensitiveValues(Array.from({ length: 16 }, (_, index) => ({
      value: { id: index },
      context: `trip:${index}`,
    })), { keyVersion: 1 });

    await vi.waitFor(() => expect(harness.secureCall).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(harness.secureCall).toHaveBeenCalledTimes(1);
    release();
    await expect(work).resolves.toHaveLength(16);
    expect(harness.secureCall).toHaveBeenCalledTimes(2);
  });

  it('closes synchronous logical preparation before the native await begins', async () => {
    let release = () => {};
    harness.secureCall.mockImplementationOnce((_plugin, _method, request) => new Promise((resolve) => {
      release = () => resolve({
        batchVersion: 1,
        results: request.items.map((item) => ({
          ordinal: item.ordinal,
          ok: true,
          ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          keyVersion: 1,
        })),
      });
    }));
    const work = encryptSensitiveValues([
      { value: { id: 1 }, context: 'trip:1' },
      { value: { id: 2 }, context: 'trip:2' },
    ], { keyVersion: 1 });
    await vi.waitFor(() => expect(harness.secureCall).toHaveBeenCalledTimes(1));
    const callsAtAwait = harness.recordPhase.mock.calls.length;
    expect(harness.recordPhase.mock.calls.some((call) => call[1] === 'logical_stringify')).toBe(true);
    await Promise.resolve();
    expect(harness.recordPhase).toHaveBeenCalledTimes(callsAtAwait);
    release();
    await work;
  });

  it('discards an in-flight batch result after cancellation and submits no later batch', async () => {
    const controller = new AbortController();
    let release = () => {};
    harness.secureCall.mockImplementationOnce((_plugin, _method, request) => new Promise((resolve) => {
      release = () => resolve({
        batchVersion: 1,
        results: request.items.map((item) => ({
          ordinal: item.ordinal,
          ok: true,
          ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          keyVersion: 1,
        })),
      });
    }));
    const work = encryptSensitiveValues(Array.from({ length: 2 }, (_, index) => ({
      value: { id: index },
      context: `trip:${index}`,
    })), { keyVersion: 1, signal: controller.signal });
    await vi.waitFor(() => expect(harness.secureCall).toHaveBeenCalledTimes(1));
    controller.abort();
    release();

    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.secureCall).toHaveBeenCalledTimes(1);
  });

  it('observes cancellation between batches before re-admission', async () => {
    const controller = new AbortController();
    const work = encryptSensitiveValues(Array.from({ length: 16 }, (_, index) => ({
      value: { id: index },
      context: `trip:${index}`,
    })), {
      keyVersion: 1,
      signal: controller.signal,
      onProgress: ({ completed }) => {
        if (completed === 8) controller.abort();
      },
    });

    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(harness.secureCall).toHaveBeenCalledTimes(1);
  });
});
