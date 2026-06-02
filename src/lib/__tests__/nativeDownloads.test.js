import { beforeEach, describe, expect, it, vi } from 'vitest';
import DriveSenseNative from '@/lib/driveSenseNativePlugin';
import { isEncryptedRoadSageDownload, saveExportToDownloads } from '@/lib/nativeDownloads';

vi.mock('@/lib/driveSenseNativePlugin', () => ({
  default: {
    saveExportToDownloads: vi.fn(async ({ filename }) => ({ uri: `content://downloads/${filename}` })),
    openExportLocation: vi.fn(),
  },
}));

const encryptedPayload = () => {
  const bytes = new Uint8Array(1 + 32 + 12 + 17);
  bytes[0] = 1;
  return btoa(String.fromCharCode(...bytes));
};

describe('native download export guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows encrypted Road Sage export and backup payloads', async () => {
    const payload = {
      filename: 'trip-report.rsexport',
      data: encryptedPayload(),
      mimeType: 'application/octet-stream',
    };

    expect(isEncryptedRoadSageDownload(payload)).toBe(true);
    await expect(saveExportToDownloads(payload)).resolves.toMatchObject({
      uri: 'content://downloads/trip-report.rsexport',
    });
    expect(DriveSenseNative.saveExportToDownloads).toHaveBeenCalledWith({
      ...payload,
      base64: undefined,
    });
  });

  it('rejects plaintext or unwrapped exports before calling the native bridge', async () => {
    await expect(saveExportToDownloads({
      filename: 'trip-report.csv',
      data: 'score,route',
      mimeType: 'text/csv',
    })).rejects.toThrow('Only encrypted Road Sage export files can be saved to Downloads.');

    await expect(saveExportToDownloads({
      filename: 'trip-report.rsexport',
      data: btoa('score,route'),
      mimeType: 'application/octet-stream',
    })).rejects.toThrow('Only encrypted Road Sage export files can be saved to Downloads.');

    expect(DriveSenseNative.saveExportToDownloads).not.toHaveBeenCalled();
  });
});
