import { expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ secureCall: vi.fn() }));

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
  yieldSecureBulkTurn: vi.fn(async () => {}),
}));

vi.mock('@/lib/p0Probe', () => ({
  openP0Span: () => null,
  closeP0Span: vi.fn(),
  recordP0Phase: vi.fn(),
  tagP0PayloadKind: vi.fn(),
}));

const {
  MAX_SECURE_BATCH_METHOD_JSON_BYTES,
  encryptSensitiveValues,
} = await import('@/lib/securePayloadCrypto');

const utf8 = (value) => new TextEncoder().encode(value).byteLength;

const exactEnvelope = (index, targetBytes = 24_576) => {
  const envelope = {
    record_type: 'trip_projection',
    projection_version: 1,
    id: `probe-${index}`,
    start_time: '2026-08-16T00:00:00.000Z',
    status: 'completed',
    source_revision: `revision-${index}`,
    padding: '',
  };
  const remaining = targetBytes - utf8(JSON.stringify(envelope));
  // Backslashes cost two bytes in the compact envelope and three after that
  // compact JSON string is nested in P2's method JSON. This is more adversarial
  // than an ASCII-only projection of the same envelope size.
  envelope.padding = '\\'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  expect(utf8(JSON.stringify(envelope))).toBe(targetBytes);
  return envelope;
};

it('planning probe: packs eight exact-24KiB compact JSON envelopes at max context', async () => {
  harness.secureCall.mockImplementation(async (_plugin, _method, request) => ({
    batchVersion: 1,
    results: request.items.map((item) => ({
      ordinal: item.ordinal,
      ok: true,
      ciphertext: 'A'.repeat(32_808),
      keyVersion: item.keyVersion,
    })),
  }));

  const entries = Array.from({ length: 8 }, (_, index) => {
    const prefix = `trip-summary:projection:${index}:`;
    return {
      value: exactEnvelope(index),
      context: prefix + 'c'.repeat(512 - utf8(prefix)),
    };
  });

  await encryptSensitiveValues(entries, { keyVersion: 1 });

  expect(harness.secureCall).toHaveBeenCalledTimes(1);
  const request = harness.secureCall.mock.calls[0][2];
  const requestBytes = utf8(JSON.stringify(request));
  const responseBytes = utf8(JSON.stringify({
    batchVersion: 1,
    results: request.items.map((item) => ({
      ordinal: item.ordinal,
      ok: true,
      ciphertext: 'A'.repeat(4 * Math.ceil((24_576 + 29) / 3)),
      keyVersion: item.keyVersion,
    })),
  }));
  expect(request.items).toHaveLength(8);
  expect(request.items.reduce((sum, item) => sum + utf8(item.plaintext), 0)).toBe(196_608);
  expect(requestBytes).toBeLessThanOrEqual(MAX_SECURE_BATCH_METHOD_JSON_BYTES);
  expect(responseBytes).toBeLessThanOrEqual(MAX_SECURE_BATCH_METHOD_JSON_BYTES);
  console.info(JSON.stringify({ requestBytes, responseBytes }));
});
