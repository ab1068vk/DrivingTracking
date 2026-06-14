import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  encryptSensitiveValue: vi.fn(),
  decryptSensitiveValue: vi.fn(),
  maskRoutePointsForPrivacy: vi.fn(),
  maskRoutePointsForPrivacyExport: vi.fn(),
  zeroCount: 0,
  native: false,
  noisyStat: vi.fn(),
  commitZoneForExport: vi.fn(),
  signExport: vi.fn(),
  verifyExport: vi.fn(),
  sanitizeCrashPayload: vi.fn(),
  loadPrivacyAuditChain: vi.fn(),
  appendPrivacyEvent: vi.fn(),
  verifyChain: vi.fn(),
}));

vi.mock('@/lib/securePayloadCrypto', () => ({
  encryptSensitiveValue: mocks.encryptSensitiveValue,
  decryptSensitiveValue: mocks.decryptSensitiveValue,
}));
vi.mock('@/lib/encryptedStore', () => ({ secureDelete: vi.fn() }));
vi.mock('@/lib/privacyZones', () => ({
  maskRoutePointsForPrivacy: mocks.maskRoutePointsForPrivacy,
  maskRoutePointsForPrivacyExport: mocks.maskRoutePointsForPrivacyExport,
}));
vi.mock('@/lib/SecureGpsBuffer', () => ({
  getSecureGpsBufferZeroCallCount: () => mocks.zeroCount,
}));
vi.mock('@/lib/pinnedFetch', () => ({ PINNED_GPS_HOSTS: ['api.open-meteo.com'] }));
vi.mock('@/lib/secureBridge', () => ({ secureCall: vi.fn() }));
vi.mock('@/lib/nativePlatform', () => ({ isNativePlatform: () => mocks.native }));
vi.mock('@/lib/requestObfuscator', () => ({
  getObfuscatorQueueStatus: () => ({ enabled: true, initialized: false }),
}));
vi.mock('@/lib/differentialPrivacy', () => ({ noisyStat: mocks.noisyStat }));
vi.mock('@/lib/exportCommitment', () => ({ commitZoneForExport: mocks.commitZoneForExport }));
vi.mock('@/lib/exportIntegrity', () => ({
  signExport: mocks.signExport,
  verifyExport: mocks.verifyExport,
}));
vi.mock('@/lib/crashSanitizer', () => ({ sanitizeCrashPayload: mocks.sanitizeCrashPayload }));
vi.mock('@/lib/hashChainLog', () => ({
  appendPrivacyEvent: mocks.appendPrivacyEvent,
  loadPrivacyAuditChain: mocks.loadPrivacyAuditChain,
  verifyChain: mocks.verifyChain,
}));

import {
  invalidateSelfTestCache,
  selfTestCertPinning,
  selfTestDifferentialPrivacy,
  selfTestExportSigning,
  selfTestStorageEncryption,
  selfTestTimestampFuzzing,
} from '@/lib/controlSelfTests';

describe('privacy control self-tests', () => {
  beforeEach(() => {
    invalidateSelfTestCache();
    vi.clearAllMocks();
    mocks.native = false;
  });

  it('rejects plaintext-shaped storage output and caches the result', async () => {
    mocks.encryptSensitiveValue.mockResolvedValue({ encrypted: false });
    expect((await selfTestStorageEncryption()).status).toBe('error');
    expect((await selfTestStorageEncryption()).status).toBe('error');
    expect(mocks.encryptSensitiveValue).toHaveBeenCalledTimes(1);
  });

  it('marks native-only certificate pinning not applicable on web', async () => {
    expect(await selfTestCertPinning()).toMatchObject({ status: 'not_applicable' });
  });

  it('fails when differential privacy returns an unchanged value', async () => {
    mocks.noisyStat.mockReturnValue(10);
    expect(await selfTestDifferentialPrivacy()).toMatchObject({ status: 'error' });
  });

  it('fails when an exported boundary timestamp is unchanged', async () => {
    const timestamp = new Date().toISOString();
    mocks.maskRoutePointsForPrivacy.mockReturnValue([{ privacy_boundary: true, timestamp }]);
    mocks.maskRoutePointsForPrivacyExport.mockReturnValue([{
      privacy_export_placeholder: true,
      timestamp,
    }]);
    expect(await selfTestTimestampFuzzing()).toMatchObject({ status: 'error' });
  });

  it('fails if a tampered export passes verification', async () => {
    mocks.signExport.mockResolvedValue({ payload: { value: 123 }, signature: 'x' });
    mocks.verifyExport.mockResolvedValueOnce({ valid: true }).mockResolvedValueOnce({ valid: true });
    expect(await selfTestExportSigning()).toMatchObject({ status: 'error' });
  });
});
