import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPlayIntegrityForSensitiveAction } from '@/lib/nativePlayIntegrity';

const requestAttestation = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    requestAttestation,
  }),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isNativePlatform: () => true,
}));

vi.mock('@/api/client', () => ({
  API_BASE_URL: 'https://api.example.test',
  apiClient: {
    post: apiPost,
  },
}));

describe('native Play Integrity helper', () => {
  beforeEach(() => {
    requestAttestation.mockReset();
    apiPost.mockReset();
  });

  it('allows encrypted exports only after trusted backend verification', async () => {
    requestAttestation.mockResolvedValue({
      token: 'play-integrity-token',
      nonce: 'nonce',
      runtimeStatus: 'ok',
      requiresServerVerification: true,
    });
    apiPost.mockResolvedValue({
      playIntegrityVerified: true,
    });

    await expect(assertPlayIntegrityForSensitiveAction('export:csv')).resolves.toMatchObject({
      token: 'play-integrity-token',
    });
    expect(apiPost).toHaveBeenCalledWith('/play-integrity/verify', {
      action: 'export:csv',
      nonce: 'nonce',
      token: 'play-integrity-token',
      runtimeStatus: 'ok',
    });
  });

  it('rejects sensitive actions when the backend does not verify the attestation', async () => {
    requestAttestation.mockResolvedValue({
      token: 'play-integrity-token',
      requiresServerVerification: true,
    });
    apiPost.mockResolvedValue({
      playIntegrityVerified: false,
    });

    await expect(assertPlayIntegrityForSensitiveAction('calibration-upload')).rejects.toThrow(
      'Server did not verify Play Integrity'
    );
  });
});
