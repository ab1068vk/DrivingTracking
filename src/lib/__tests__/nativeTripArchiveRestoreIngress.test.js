import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  pickStreamBackupRestoreFile: vi.fn(),
  beginStreamBackupRestoreFromUri: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({ registerPlugin: () => bridge }));

describe('HPR-B2 native archive restore ingress wrapper', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the reviewed document picker without accepting a browser File', async () => {
    bridge.pickStreamBackupRestoreFile.mockResolvedValue({
      uri: 'content://provider/document/backup.rsb2',
      name: 'backup.rsb2',
    });
    const { nativeTripArchive } = await import('@/lib/nativeTripArchive');

    await expect(nativeTripArchive.pickStreamBackupRestoreFile()).resolves.toEqual({
      uri: 'content://provider/document/backup.rsb2',
      name: 'backup.rsb2',
    });
    expect(bridge.pickStreamBackupRestoreFile).toHaveBeenCalledWith({});
  });
});
