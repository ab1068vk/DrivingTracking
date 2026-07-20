import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativePlugin = vi.hoisted(() => ({
  beginExportToDownloads: vi.fn(async () => ({ exportId: 'export-1' })),
  appendExportToDownloads: vi.fn(async () => ({ bytesWritten: 1 })),
  finishExportToDownloads: vi.fn(async () => ({ uri: 'content://downloads/export-1' })),
  cancelExportToDownloads: vi.fn(async () => ({ cancelled: true })),
  saveExportToDownloads: vi.fn(async () => ({ uri: 'content://downloads/small' })),
}));

vi.mock('@/lib/driveSenseNativePlugin', () => ({ default: nativePlugin }));
vi.mock('@/lib/systemLog', () => ({
  logSystemFailure: vi.fn(),
  recordSystemEvent: vi.fn(),
}));

import { saveExportToDownloads } from '@/lib/nativeDownloads';

describe('native download streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativePlugin.beginExportToDownloads.mockResolvedValue({ exportId: 'export-1' });
    nativePlugin.appendExportToDownloads.mockResolvedValue({ bytesWritten: 1 });
    nativePlugin.finishExportToDownloads.mockResolvedValue({ uri: 'content://downloads/export-1' });
    nativePlugin.cancelExportToDownloads.mockResolvedValue({ cancelled: true });
  });

  it('streams large exports in unicode-safe chunks', async () => {
    const chunkChars = 192 * 1024;
    const data = `${'a'.repeat(chunkChars - 1)}😀${'b'.repeat(1024 * 1024)}`;
    const progress = [];

    const result = await saveExportToDownloads({
      filename: 'backup.drivesensebackup',
      data,
      mimeType: 'application/octet-stream',
      onProgress: (entry) => progress.push(entry),
    });

    const streamed = nativePlugin.appendExportToDownloads.mock.calls
      .map(([entry]) => entry.data)
      .join('');
    expect(streamed).toBe(data);
    expect(nativePlugin.appendExportToDownloads.mock.calls.length).toBeGreaterThan(1);
    expect(nativePlugin.finishExportToDownloads).toHaveBeenCalledWith({ exportId: 'export-1' });
    expect(nativePlugin.saveExportToDownloads).not.toHaveBeenCalled();
    expect(progress.at(-1)).toEqual({ completed: data.length, total: data.length });
    expect(result.uri).toBe('content://downloads/export-1');
  });

  it('removes a partial native file when cancellation is requested', async () => {
    const controller = new AbortController();
    nativePlugin.appendExportToDownloads.mockImplementationOnce(async () => {
      controller.abort();
      return { bytesWritten: 1 };
    });

    await expect(saveExportToDownloads({
      filename: 'backup.drivesensebackup',
      data: 'x'.repeat(2 * 1024 * 1024),
      mimeType: 'application/octet-stream',
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(nativePlugin.finishExportToDownloads).not.toHaveBeenCalled();
    expect(nativePlugin.cancelExportToDownloads).toHaveBeenCalledWith({ exportId: 'export-1' });
  });
});
