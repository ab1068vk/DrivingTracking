import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  values: new Map(),
  native: {
    beginLegacySpeedMigration: vi.fn(),
    appendLegacySpeedCiphertext: vi.fn(),
    executeLegacySpeedMigration: vi.fn(),
    legacySpeedMigrationStatus: vi.fn(),
  },
  decrypt: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => true,
  isAndroid: () => true,
  getNativePlatform: () => 'android',
}));

vi.mock('@/lib/mobileStorage', () => ({
  getJson: vi.fn(async (key, fallback = null) => state.values.get(key) ?? fallback),
  setJson: vi.fn(async (key, value) => { state.values.set(key, structuredClone(value)); }),
  removeJson: vi.fn(async (key) => state.values.delete(key)),
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }) => ({
      value: state.values.has(key) ? JSON.stringify(state.values.get(key)) : null,
    })),
  },
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  isEncryptedPayload: (value) => value?.encrypted === true && value?.version === 1 && typeof value?.ciphertext === 'string',
  decryptSensitiveValue: (...args) => state.decrypt(...args),
  encryptSensitiveValue: vi.fn(),
  getEncryptedJson: vi.fn(async () => null),
  removeEncryptedJson: vi.fn(),
  setEncryptedJson: vi.fn(),
}));

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: state.native,
  encodeBase64Bytes: vi.fn(),
  readNativeSpeedBucket: vi.fn(),
  sha256Hex: vi.fn(),
}));

vi.mock('@/lib/systemLog', () => ({ logSystemFailure: vi.fn(), recordSystemEvent: vi.fn() }));

describe('P3.5 explicit PRDE-1 bridge contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_P35_NATIVE_AUTHORITY', 'true');
    state.values.clear();
    state.decrypt.mockReset();
    Object.values(state.native).forEach((mock) => mock.mockReset());
  });

  it('selects the write-ahead source first and sends only bounded ciphertext slices', async () => {
    const bytes = Uint8Array.from({ length: 400_000 }, (_, index) => index % 251);
    const ciphertext = Buffer.from(bytes).toString('base64');
    const wrapper = { encrypted: true, version: 1, key_version: 7, ciphertext };
    state.values.set('speed_knowledge_v1_write_ahead', wrapper);
    state.native.beginLegacySpeedMigration.mockResolvedValue({
      state: 'STAGING', operationId: 'op-1', nextChunkIndex: 0,
    });
    state.native.appendLegacySpeedCiphertext.mockResolvedValue({ state: 'STAGING' });
    state.native.executeLegacySpeedMigration.mockResolvedValue({
      state: 'VERIFIED', operationId: 'op-1', authorityFlipEligible: true,
    });

    const { migrateLegacySpeedKnowledgeExplicitly } = await import('@/lib/speedKnowledgeRepository');
    const result = await migrateLegacySpeedKnowledgeExplicitly();

    expect(result).toMatchObject({
      state: 'VERIFIED',
      sourceStillReadable: true,
      sourceCiphertextByteIdentical: true,
      authorityFlipEligible: true,
    });
    expect(state.decrypt).not.toHaveBeenCalled();
    expect(state.native.beginLegacySpeedMigration).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'preferences_write_ahead',
      keyVersion: 7,
      expectedCiphertextBytes: bytes.length,
    }));
    expect(state.native.appendLegacySpeedCiphertext.mock.calls.length).toBeGreaterThan(1);
    for (const [request] of state.native.appendLegacySpeedCiphertext.mock.calls) {
      expect(request.chunkBase64.length).toBeLessThanOrEqual(256 * 1024);
    }
    bytes.fill(0);
  });

  it('preserves explicit blocked-resource state without staging or false authority', async () => {
    state.values.set('speed_knowledge_v1_write_ahead', {
      encrypted: true,
      version: 1,
      key_version: 3,
      ciphertext: Buffer.from(new Uint8Array(64)).toString('base64'),
    });
    state.native.beginLegacySpeedMigration.mockResolvedValue({
      state: 'LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE',
      legacyAuthorityPreserved: true,
      retryable: true,
    });

    const { migrateLegacySpeedKnowledgeExplicitly } = await import('@/lib/speedKnowledgeRepository');
    const result = await migrateLegacySpeedKnowledgeExplicitly();

    expect(result).toMatchObject({
      state: 'LEGACY_SPEED_MIGRATION_BLOCKED_RESOURCE',
      legacyAuthorityPreserved: true,
    });
    expect(state.native.appendLegacySpeedCiphertext).not.toHaveBeenCalled();
    expect(state.native.executeLegacySpeedMigration).not.toHaveBeenCalled();
    expect(state.decrypt).not.toHaveBeenCalled();
  });
});
