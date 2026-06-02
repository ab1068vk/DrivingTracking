import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPlayIntegrityForSensitiveAction } from '@/lib/nativePlayIntegrity';

const requestAttestation = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    requestAttestation,
  }),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => true,
}));

describe('native Play Integrity helper', () => {
  beforeEach(() => {
    requestAttestation.mockReset();
  });

  it('allows local encrypted exports to proceed after receiving an attestation token', async () => {
    requestAttestation.mockResolvedValue({
      token: 'play-integrity-token',
      requiresServerVerification: true,
    });

    await expect(assertPlayIntegrityForSensitiveAction('export:csv', {
      requireServerVerification: false,
    })).resolves.toMatchObject({
      token: 'play-integrity-token',
    });
  });

  it('keeps backend verification mandatory for strict sensitive actions', async () => {
    requestAttestation.mockResolvedValue({
      token: 'play-integrity-token',
      requiresServerVerification: true,
    });

    await expect(assertPlayIntegrityForSensitiveAction('calibration-upload')).rejects.toThrow(
      'Play Integrity attestation must be verified by a trusted backend'
    );
  });
});
