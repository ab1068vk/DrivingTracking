import { describe, expect, it, vi } from 'vitest';

const { checkIntegrity } = vi.hoisted(() => ({ checkIntegrity: vi.fn() }));

vi.mock('@/lib/rasp', () => ({ checkIntegrity }));
vi.mock('@/lib/controlSelfTests', () => ({
  selfTestAuditLog: vi.fn(),
  selfTestBridgeEncryption: vi.fn(),
  selfTestCertPinning: vi.fn(),
  selfTestCommitmentScheme: vi.fn(),
  selfTestCrashScrubbing: vi.fn(),
  selfTestDifferentialPrivacy: vi.fn(),
  selfTestExportSigning: vi.fn(),
  selfTestKinematicNulling: vi.fn(),
  selfTestMemoryZeroing: vi.fn(),
  selfTestRequestObfuscation: vi.fn(),
  selfTestSecureDeletion: vi.fn(),
  selfTestStorageEncryption: vi.fn(),
  selfTestTimestampFuzzing: vi.fn(),
}));

import { checkDeviceIntegrity } from '@/lib/deviceStatus';

describe('device integrity evidence', () => {
  it('returns unknown instead of passing when the native check throws', async () => {
    checkIntegrity.mockRejectedValueOnce(new Error('plugin unavailable'));
    await expect(checkDeviceIntegrity()).resolves.toMatchObject({
      status: 'unknown',
      threats: [],
      evidence: 'Device integrity check unavailable: plugin unavailable',
    });
  });

  it('returns error when threats are confirmed', async () => {
    checkIntegrity.mockResolvedValueOnce({ secure: false, threats: ['root'] });
    await expect(checkDeviceIntegrity()).resolves.toMatchObject({
      status: 'error',
      threats: ['root'],
    });
  });
});
