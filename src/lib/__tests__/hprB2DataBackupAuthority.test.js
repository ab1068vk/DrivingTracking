import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authority: 'browser',
  begin: vi.fn(),
  status: vi.fn(),
  publish: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('@/lib/nativePlatform', () => ({
  isAndroid: () => true,
  isNativePlatform: () => false,
  getNativePlatform: () => 'android',
}));

vi.mock('@/lib/backupCapabilities', () => ({
  BACKUP_AUTHORITY: { BROWSER: 'browser', NATIVE: 'native' },
  P35_NATIVE_BACKUP_AUTHORITY_ENABLED: false,
  resolveBackupCapabilities: () => state.authority === 'native'
    ? {
      authority: 'native',
      browserJsonExportAvailable: false,
      nativeStreamExportAvailable: true,
    }
    : {
      authority: 'browser',
      browserJsonExportAvailable: true,
      nativeStreamExportAvailable: false,
    },
}));

vi.mock('@/lib/nativeTripArchive', () => ({
  nativeTripArchive: {
    beginStreamBackup: state.begin,
    streamBackupStatus: state.status,
    publishStreamBackup: state.publish,
    cancelStreamBackup: state.cancel,
  },
}));

vi.mock('@/lib/privacyZones', async (importOriginal) => ({
  ...(await importOriginal()),
  getHydratedPrivacyZones: vi.fn(async () => []),
}));

vi.mock('@/lib/speedKnowledgeRepository', async (importOriginal) => ({
  ...(await importOriginal()),
  readSpeedKnowledgeData: vi.fn(async () => ({})),
}));

vi.mock('@/lib/exportIntegrity', () => ({
  isSignedExportEnvelope: vi.fn(() => false),
  signExport: vi.fn(async (payload) => ({
    format: 'roadsage-signed-export',
    version: 1,
    payload,
    signature: 'test-signature',
  })),
  verifyAndUnwrapExport: vi.fn(async (value) => ({ payload: value?.payload, verified: true })),
}));

vi.mock('@/lib/backupEnvelopeEncryption', async (importOriginal) => ({
  ...(await importOriginal()),
  encryptBackupText: vi.fn(async () => JSON.stringify({ format: 'encrypted-test-backup' })),
}));

const installBrowserDownloadSurface = () => {
  const anchor = { href: '', download: '', style: {}, click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => anchor),
    body: { appendChild: vi.fn() },
  });
  const RealURL = globalThis.URL;
  vi.stubGlobal('URL', class TestURL extends RealURL {
    static createObjectURL = vi.fn(() => 'blob:hpr-b2-backup');
    static revokeObjectURL = vi.fn();
  });
  return anchor;
};

describe('HPR-B2 export entry-point authority routing', () => {
  beforeEach(() => {
    state.authority = 'browser';
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports readable browser-authoritative JSON on Android without native password rejection', async () => {
    const anchor = installBrowserDownloadSurface();
    const { exportDriveSenseBackup } = await import('@/lib/dataBackup');

    const result = await exportDriveSenseBackup({
      trips: [],
      vehicles: [],
      settings: { privacy_zones: [] },
      filename: 'road-sage-readable.json',
      passphrase: null,
    });

    expect(result).toMatchObject({ native: false, encrypted: false });
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(state.begin).not.toHaveBeenCalled();
  });

  it('exports encrypted browser-authoritative JSON on Android from supplied canonical rows', async () => {
    installBrowserDownloadSurface();
    const { exportDriveSenseBackup } = await import('@/lib/dataBackup');

    const result = await exportDriveSenseBackup({
      trips: [{ id: 'browser-canonical-trip', status: 'completed' }],
      vehicles: [{ id: 'browser-canonical-vehicle' }],
      settings: { privacy_zones: [] },
      filename: 'road-sage-encrypted.json',
      passphrase: 'Correct!Password',
    });

    expect(result).toMatchObject({ native: false, encrypted: true });
    expect(result.signedBackup.payload.trips).toEqual([
      expect.objectContaining({ id: 'browser-canonical-trip' }),
    ]);
    expect(result.signedBackup.payload.vehicles).toEqual([
      expect.objectContaining({ id: 'browser-canonical-vehicle' }),
    ]);
    expect(state.begin).not.toHaveBeenCalled();
  });

  it('uses the bounded .rsb2 exporter only under guarded native authority', async () => {
    state.authority = 'native';
    state.begin.mockResolvedValue({ operationId: 'backup-1', done: false });
    state.status.mockResolvedValue({ operationId: 'backup-1', phase: 'COMPLETE', done: true, verified: true });
    state.publish.mockResolvedValue({ filename: 'road-sage.rsb2', uri: 'content://published/road-sage.rsb2' });
    const { exportDriveSenseBackup } = await import('@/lib/dataBackup');

    await expect(exportDriveSenseBackup({
      passphrase: 'Correct!Password',
      filename: 'road-sage.rsb2',
    })).resolves.toMatchObject({
      native: true,
      encrypted: true,
      filename: 'road-sage.rsb2',
    });

    expect(state.begin).toHaveBeenCalledOnce();
    expect(state.publish).toHaveBeenCalledWith('backup-1');
  });
});
